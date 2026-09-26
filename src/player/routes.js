const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const { limiteTentativas, zerarTentativas } = require('../lib/limite-tentativas');
const execucoesRepo = require('../playlist/execucoes-repository');
const dispositivosRepo = require('../dispositivos/repository');
const sinal = require('./sinal');
const { montarConfig } = require('./config');
const pinSaida = require('./pin-saida');
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
// Heartbeat sem transição não avisa ninguém: cada tela bate a cada 15 s, e
// avisar o admin em todos eles faria a Rede inteira recarregar sem nada ter
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
// POST /player/:dispositivoId/heartbeat — sinal de vida a cada 15 s (§5)
// ---------------------------------------------------------------------------
// Sem limite de tentativas nem SSE por batida: 4 por minuto por tela é o
// ritmo normal. A resposta diz só se há config nova e playlist nova.
router.post('/player/:dispositivoId/heartbeat', exigirAparelho({ operacao: false }), corpoObjeto, async (req, res) => {
  const tela = req.dispositivo;
  const r = await sinal.registrarHeartbeat(tela.id, req.body, req.player);
  avisarMudanca(tela, { transicao: r.eventos.length > 0 });
  res.json({
    configVersion: tela.config_versao_desejada,
    playlist: { atualizar: await sinal.sinalizarPlaylist(tela.id) },
  });
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
// POST /player/:dispositivoId/played — proof-of-play em lote (§8)
// ---------------------------------------------------------------------------
// 400 só para o LOTE malformado (o Player divide e põe em quarentena). Um
// evento ruim nunca derruba o lote: responde `item_invalido` e o resto
// segue. 5xx fica para falha real do servidor (o Player tenta de novo).
const TETO_LOTE = 500;
// UUID do Player (e qualquer id curto e imprimível). Byte nulo ou texto
// arbitrário chegariam no Postgres e virariam 500 eterno.
const EXECUCAO_ID = /^[A-Za-z0-9._:-]{1,100}$/;

router.post('/player/:dispositivoId/played', exigirAparelho(), corpoObjeto, async (req, res) => {
  const lista = req.body.eventos;
  if (!Array.isArray(lista) || lista.length > TETO_LOTE) {
    return res.status(400).json({ erro: `eventos precisa ser uma lista de até ${TETO_LOTE} itens` });
  }
  res.json(await confirmarLote(req.dispositivo, lista));
});

const textoNaoVazio = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200;

// Um por um, na ordem. Evento sem `execucaoId` string não tem como ser
// respondido (o Player casa a resposta por ele): fica sem resultado.
async function confirmarLote(dispositivo, eventosRecebidos) {
  const agora = new Date();
  const resultados = [];
  for (const evento of eventosRecebidos) {
    const execucaoId = ehObjeto(evento) && typeof evento.execucaoId === 'string' ? evento.execucaoId.trim() : '';
    if (!execucaoId) continue;
    if (!EXECUCAO_ID.test(execucaoId) || !textoNaoVazio(evento.itemProgramacaoId) || !textoNaoVazio(evento.janelaId)) {
      resultados.push({ execucaoId: execucaoId.slice(0, 100), status: 'item_invalido' });
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
