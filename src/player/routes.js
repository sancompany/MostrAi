const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const { limiteTentativas, zerarTentativas } = require('../lib/limite-tentativas');
const gerador = require('../playlist/gerador');
const execucoesRepo = require('../playlist/execucoes-repository');
const dispositivosRepo = require('../dispositivos/repository');
const credencial = require('./credencial');
const sinal = require('./sinal');
const { montarConfig, margensDaTela } = require('./config');
const pinSaida = require('./pin-saida');
const releases = require('./releases');
const cofre = require('../lib/cofre');
const eventos = require('../lib/eventos');
const sse = require('../lib/sse');
const { sincronizarStatusPonto } = require('../pontos/repository');
const { normalizarCodigoTela, normalizarCodigoInstalacao } = require('../lib/codigo-tela');

// API do Player — contrato oficial em docs/player-mvp-contract.md.
//
// Códigos (o Player decide o que fazer por eles — contrato §4.4, §9.2):
// - 400 só para corpo estruturalmente inválido. Um evento de proof-of-play
//   em 400 vai para quarentena permanente no aparelho; conteúdo ruim de um
//   evento responde 200 com status individual.
// - erro do servidor (banco fora, exceção) sai 500 pelo tratador global —
//   nunca 400: o Player retenta 5xx.

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const corpoObjeto = (req, res, next) =>
  ehObjeto(req.body) ? next() : res.status(400).json({ erro: 'corpo precisa ser um objeto JSON' });

// Avisa quem está olhando que a tela mudou de ESTADO (transição de saúde,
// primeiro sinal) — o navegador refaz o GET, nunca recebe o dado pelo canal.
// Heartbeat sem transição não avisa ninguém: cada tela bate a cada 5 min, e
// avisar o admin em todos eles fazia a Rede inteira recarregar sem nada ter
// mudado (consolidação final, 24/09/2026).
function avisarMudanca(tela, { transicao }) {
  if (!transicao) return;
  sse.emitirParaAdmin('screen.updated', { id: tela.id, pontoId: tela.ponto_id });
  sse.emitirParaAdmin('point.updated', { id: tela.ponto_id });
  if (tela.dono_conta_id) {
    sse.emitirParaConta(tela.dono_conta_id, 'screen.updated', { pontoId: tela.ponto_id });
    sse.emitirParaConta(tela.dono_conta_id, 'point.updated', { id: tela.ponto_id });
  }
}

// ---------------------------------------------------------------------------
// POST /player/provisionar — ID da tela + código de instalação → credencial
// (docs/player-mvp-contract.md §3)
// ---------------------------------------------------------------------------
const INSTALACAO_INVALIDA = { erro: 'ID da tela ou código de instalação inválido, expirado ou já usado' };

router.post('/player/provisionar', limiteTentativas, corpoObjeto, async (req, res) => {
  const telaId = normalizarCodigoTela(req.body.codigoTela);
  if (!telaId) return res.status(400).json({ erro: 'codigoTela inválido — use o ID da tela, ex.: M-0235' });
  const codigo = normalizarCodigoInstalacao(req.body.codigoInstalacao);
  if (!codigo) {
    return res.status(400).json({ erro: 'codigoInstalacao inválido — são 8 letras e números, ex.: 7K4M-9Q2W' });
  }
  const r = await dispositivosRepo.trocarCodigoPorCredencial(telaId, codigo);
  // Tela inexistente, código errado, expirado, cancelado ou usado: 401 igual
  // para todos (quem tenta adivinhar não aprende qual foi).
  if (!r) return res.status(401).json(INSTALACAO_INVALIDA);
  await zerarTentativas(req);
  if (r.novo) {
    // Instalação é contato: o status do ponto passa a considerar a tela.
    await sincronizarStatusPonto(r.pontoId);
    const tela = await dispositivosRepo.buscarLinha(r.telaId);
    if (tela) avisarMudanca(tela, { transicao: true });
  }
  res.json({ dispositivoId: r.dispositivoId, chaveAparelho: r.chaveAparelho });
});

// ---------------------------------------------------------------------------
// POST /player/:dispositivoId/hello — dados técnicos que não mudam (§3)
// ---------------------------------------------------------------------------
router.post('/player/:dispositivoId/hello', exigirAparelho({ operacao: false }), corpoObjeto, async (req, res) => {
  const r = await sinal.registrarHello(req.dispositivo.id, req.body, req.player);
  avisarMudanca(req.dispositivo, { transicao: r.eventos.length > 0 });
  // Poupa um ciclo: com a versão aqui, o Player já busca a config (§3).
  res.json({ configVersion: req.dispositivo.config_versao_desejada });
});

// ---------------------------------------------------------------------------
// POST /player/:dispositivoId/heartbeat — snapshot do estado (§4)
// ---------------------------------------------------------------------------
router.post('/player/:dispositivoId/heartbeat', exigirAparelho({ operacao: false }), async (req, res) => {
  // Corpo vazio é o heartbeat do Android V1 — válido (checklist §1).
  const corpo = req.body === undefined || req.body === null ? {} : req.body;
  if (!ehObjeto(corpo)) return res.status(400).json({ erro: 'corpo precisa ser um objeto JSON' });
  const tela = req.dispositivo;
  const r = await sinal.registrarHeartbeat(tela.id, corpo, req.player);
  avisarMudanca(tela, { transicao: r.eventos.length > 0 });

  const resposta = {
    ok: true,
    servidorAgora: new Date().toISOString(),
    // compat-v1 (migration 069): o player web e o Android sem /config tiram
    // as margens daqui; o V2 aplica a de /config quando ela vem (§4.3).
    margens: margensDaTela(tela),
  };
  if (!r.v2) return res.json(resposta);

  resposta.configVersion = tela.config_versao_desejada;

  if (await sinal.sinalizarPlaylist(tela.id)) resposta.playlist = { atualizar: true };

  // Rotação: a candidata vai até o Player usá-la. Chegou pela própria
  // candidata? Então é promovida nesta resposta (src/lib/aparelho.js) — nada
  // a mandar. Chegou pela ANTERIOR? A resposta que promoveu a atual se perdeu
  // e o aparelho ficou com a velha: a atual volta como chave nova, antes que
  // a sobreposição de 24h acabe e o tranque.
  if (req.chaveUsada === 'anterior' && tela.chave_atual_cifrada) {
    const atual = cofre.abrir(tela.chave_atual_cifrada);
    if (atual) resposta.novaChave = atual;
  } else if (tela.chave_nova_cifrada && req.chaveUsada !== 'nova') {
    const nova = cofre.abrir(tela.chave_nova_cifrada);
    if (nova) resposta.novaChave = nova;
    else await credencial.cancelarRotacao(tela.id, 'candidata ilegível (segredo do servidor trocado)');
  }

  const manifesto = releases.manifesto(await releases.aplicavelA(req.player.build ?? tela.player_build));
  if (manifesto) resposta.update = manifesto;

  res.json(resposta);
});

// ---------------------------------------------------------------------------
// GET /player/:dispositivoId/config — config versionada (contrato §6)
// ---------------------------------------------------------------------------
router.get('/player/:dispositivoId/config', exigirAparelho({ operacao: false }), async (req, res) => {
  // Leva o PIN de saída: nada de cache no caminho.
  res.set('Cache-Control', 'no-store');
  res.json(montarConfig(req.dispositivo, await pinSaida.obter()));
});

// ---------------------------------------------------------------------------
// POST /player/:dispositivoId/played — proof-of-play (§9)
// ---------------------------------------------------------------------------
const TETO_LOTE = 500;

router.post('/player/:dispositivoId/played', exigirAparelho(), corpoObjeto, async (req, res) => {
  if ('eventos' in req.body) {
    if (!Array.isArray(req.body.eventos) || req.body.eventos.length > TETO_LOTE) {
      return res.status(400).json({ erro: `eventos precisa ser uma lista de até ${TETO_LOTE} itens` });
    }
    return res.json(await confirmarLote(req.dispositivo, req.body.eventos));
  }

  // compat-v1: um evento por requisição, `{anuncianteId}` (player web).
  const { anuncianteId } = req.body;
  const id = Number(anuncianteId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) {
    return res.status(400).json({ erro: 'anuncianteId obrigatório' });
  }
  const r = await gerador.confirmarExibicao(req.dispositivo.id, id, new Date());
  if (r.ok) return res.json({ ok: true, janela: r.janela });
  // `ja_completo` NÃO é erro: é a TV reenviando o que já contou.
  if (r.motivo === 'ja_completo') return res.json({ ok: true, contou: false, motivo: 'ja_completo' });
  return res.status(400).json({ erro: 'anunciante não está programado nesta tela nesta hora' });
});

// Um por um (o lote nunca passa de 50 no app). Evento sem `execucaoId` não
// tem como ser respondido — fica sem resultado e o Player reenvia depois;
// evento com `execucaoId` mas sem o resto é `item_invalido` (definitivo).
async function confirmarLote(dispositivo, eventosRecebidos) {
  const agora = new Date();
  const resultados = [];
  for (const evento of eventosRecebidos) {
    const execucaoId = ehObjeto(evento) && typeof evento.execucaoId === 'string' ? evento.execucaoId.trim() : '';
    if (!execucaoId) continue;
    // Id longo demais pra coluna: responde `item_invalido` (definitivo) em
    // vez de silêncio — sem resposta o Player reenviaria o evento por 7 dias.
    if (
      execucaoId.length > 100 ||
      typeof evento.itemProgramacaoId !== 'string' ||
      typeof evento.janelaId !== 'string'
    ) {
      resultados.push({ execucaoId, status: 'item_invalido' });
      continue;
    }
    resultados.push(await execucoesRepo.confirmarComDedup(dispositivo.id, { ...evento, execucaoId }, agora));
  }

  const porStatus = {};
  for (const r of resultados) porStatus[r.status] = (porStatus[r.status] || 0) + 1;
  eventos.registrar('playlist:proofofplay_lote', {
    dispositivo_id: dispositivo.id,
    tamanho: eventosRecebidos.length,
    ...porStatus,
  });
  return { resultados };
}

module.exports = router;
