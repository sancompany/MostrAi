const express = require('express');
const router = express.Router();
const { exigirAparelho } = require('../lib/aparelho');
const { limiteTentativas, zerarTentativas } = require('../lib/limite-tentativas');
const gerador = require('../playlist/gerador');
const execucoesRepo = require('../playlist/execucoes-repository');
const dispositivosRepo = require('../dispositivos/repository');
const credencial = require('./credencial');
const sinal = require('./sinal');
const { montarConfig, margensDaTela, TETO_MARGEM_V2 } = require('./config');
const releases = require('./releases');
const cofre = require('../lib/cofre');
const pool = require('../db/pool');
const eventos = require('../lib/eventos');
const sse = require('../lib/sse');
const { sincronizarStatusPonto } = require('../pontos/repository');

// API do Player — contraparte de docs/player-v2-contract.md
// (sancompany/Playlist.MostrAi, main 28bc93d). V1 continua: o player web
// (public/player.html) e o Android legado usam o ID numérico da Tela, o
// heartbeat de corpo vazio/{erro} e o /played de {anuncianteId}.
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

// Avisa quem está olhando (admin sempre; dono do ponto só em transição) que
// a tela mudou — o navegador refaz o GET, nunca recebe o dado pelo canal.
function avisarMudanca(tela, { transicao }) {
  sse.emitirParaAdmin('screen.updated', { id: tela.id, pontoId: tela.ponto_id });
  if (transicao && tela.dono_conta_id) {
    sse.emitirParaConta(tela.dono_conta_id, 'screen.updated', { pontoId: tela.ponto_id });
    sse.emitirParaConta(tela.dono_conta_id, 'point.updated', { id: tela.ponto_id });
  }
  if (transicao) sse.emitirParaAdmin('point.updated', { id: tela.ponto_id });
}

// ---------------------------------------------------------------------------
// POST /player/provisionar — troca o token de uso único por credenciais
// ---------------------------------------------------------------------------
router.post('/player/provisionar', limiteTentativas, corpoObjeto, async (req, res) => {
  const token = req.body.tokenProvisionamento;
  if (typeof token !== 'string' || !token.trim() || token.length > 200) {
    return res.status(400).json({ erro: 'tokenProvisionamento obrigatório' });
  }
  const r = await dispositivosRepo.trocarToken(token, credencial);
  // Inválido, expirado, cancelado ou já usado: 401 (nunca 404, que para o
  // Player significa "backend V1"; nunca fallback para outra credencial).
  if (!r) return res.status(401).json({ erro: 'token de provisionamento inválido, expirado ou já usado' });
  await zerarTentativas(req);
  if (r.novo) {
    // Reprovisionar devolve a credencial a uma tela que pode ter sido
    // revogada: o status do ponto volta a considerá-la.
    const tela = await dispositivosRepo.buscarComPonto(r.telaId);
    if (tela) {
      await sincronizarStatusPonto(tela.ponto_id);
      avisarMudanca(tela, { transicao: true });
    }
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
    margens: r.v2 ? margensDaTela(tela, TETO_MARGEM_V2) : margensDaTela(tela),
  };
  if (!r.v2) return res.json(resposta);

  resposta.configVersion = tela.config_versao_desejada;

  // `playlist.atualizar` UMA vez por mudança (§6.2): marca que já avisou.
  const { rows: sinalizar } = await pool.query(
    `UPDATE dispositivos SET playlist_sinalizada_em = now()
      WHERE id = $1 AND playlist_desatualizada_em IS NOT NULL
        AND (playlist_sinalizada_em IS NULL OR playlist_sinalizada_em < playlist_desatualizada_em)
      RETURNING id`,
    [tela.id],
  );
  if (sinalizar[0]) resposta.playlist = { atualizar: true };

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
// GET /player/:dispositivoId/config — config versionada (§5)
// ---------------------------------------------------------------------------
router.get('/player/:dispositivoId/config', exigirAparelho({ operacao: false }), async (req, res) => {
  res.json(montarConfig(req.dispositivo));
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
    if (!execucaoId || execucaoId.length > 100) continue;
    if (typeof evento.itemProgramacaoId !== 'string' || typeof evento.janelaId !== 'string') {
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
