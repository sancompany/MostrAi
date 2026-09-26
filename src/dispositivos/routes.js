const express = require('express');
const router = express.Router();
const repo = require('./repository');
const eventos = require('../lib/eventos');
const pontosRepo = require('../pontos/repository');
const pool = require('../db/pool');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const credencial = require('../player/credencial');
const releases = require('../player/releases');
const sse = require('../lib/sse');
const { formatarCodigoTela } = require('../lib/codigo-tela');
const pinSaida = require('../player/pin-saida');

// URL da API que vai no aparelho (bloco CONEXÃO da ficha e no JSON do
// [Preparar Player]). Fonte canônica: SITE_URL; o host da requisição só
// serve em dev sem .env.
const baseUrlDoPlayer = (req) => (process.env.SITE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');

// Tela mudou: admin (canal próprio) e dono do ponto ("Meus pontos") refazem
// o GET sem F5. `point.updated` junto: o estado do ponto é derivado das
// telas, e o contador de telas do card do ponto também.
async function avisarMudanca(pontoId, telaId = null) {
  sse.emitirParaAdmin('screen.updated', { id: telaId, pontoId: Number(pontoId) });
  sse.emitirParaAdmin('point.updated', { id: Number(pontoId) });
  const { rows } = await pool.query('SELECT anunciante_id FROM pontos WHERE id = $1', [pontoId]);
  const dono = rows[0]?.anunciante_id;
  if (!dono) return;
  sse.emitirParaConta(dono, 'screen.updated', { pontoId: Number(pontoId) });
  sse.emitirParaConta(dono, 'point.updated', { id: Number(pontoId) });
}

const erro400 = (res, msg) => res.status(400).json({ erro: msg });

// Validação dos campos editáveis. Nada de "Nome da tela": o nome é
// derivado (Tela N), e o que é técnico (dispositivoId, chave, token, URL
// da API) o sistema gera.
function validarCampos(corpo) {
  const dados = {};
  for (const campo of repo.CAMPOS_ATUALIZAVEIS) if (campo in corpo) dados[campo] = corpo[campo];
  if ('status' in dados && !repo.STATUS.includes(dados.status)) return { erro: 'estado administrativo inválido' };
  for (const lado of ['margem_superior', 'margem_direita', 'margem_inferior', 'margem_esquerda']) {
    if (lado in dados) {
      const v = Number(dados[lado]);
      if (!Number.isFinite(v) || v < 0 || v > 10) return { erro: 'cada lado da área segura vai de 0 a 10 vmin' };
      dados[lado] = v;
    }
  }
  if ('rotacao_tela' in dados) {
    dados.rotacao_tela = Number(dados.rotacao_tela);
    if (![0, 90, 180, 270].includes(dados.rotacao_tela)) return { erro: 'rotação precisa ser 0, 90, 180 ou 270' };
  }
  if ('update_baixar_auto' in dados && typeof dados.update_baixar_auto !== 'boolean') {
    return { erro: 'baixar automaticamente precisa ser sim ou não' };
  }
  if ('update_horas_entre_tentativas' in dados) {
    const h = Number(dados.update_horas_entre_tentativas);
    if (!Number.isInteger(h) || h < 1 || h > 72) return { erro: 'intervalo entre tentativas vai de 1 a 72 horas' };
    dados.update_horas_entre_tentativas = h;
  }
  return { dados };
}

async function telaOu404(req, res) {
  const tela = await repo.buscarLinha(req.params.id);
  if (!tela) res.status(404).json({ erro: 'tela não encontrada' });
  return tela;
}

// ---------------------------------------------------------------------------
// Admin — telas
// ---------------------------------------------------------------------------
router.get('/admin/dispositivos', async (_req, res) => {
  res.json(await repo.listarTodos());
});

router.get('/admin/pontos/:pontoId/dispositivos', async (req, res) => {
  res.json(await repo.listarPorPonto(req.params.pontoId));
});

router.get('/admin/dispositivos/:id', async (req, res) => {
  const tela = await repo.buscarPorId(req.params.id);
  if (!tela) return res.status(404).json({ erro: 'tela não encontrada' });
  res.json({ ...tela, conexao: { baseUrl: baseUrlDoPlayer(req) } });
});

router.post('/admin/pontos/:pontoId/dispositivos', async (req, res) => {
  const ponto = await pontosRepo.buscarPorId(req.params.pontoId);
  if (!ponto) return res.status(404).json({ erro: 'ponto não encontrado' });
  if (ponto.status === 'arquivado') return erro400(res, 'ponto arquivado não recebe tela nova');
  const { erro, dados } = validarCampos(req.body || {});
  if (erro) return erro400(res, erro);
  const tela = await repo.criar(ponto.id, dados);
  await avisarMudanca(ponto.id, tela.id);
  res.status(201).json(tela);
});

router.patch('/admin/dispositivos/:id', async (req, res) => {
  const antes = await telaOu404(req, res);
  if (!antes) return;
  const { erro, dados } = validarCampos(req.body || {});
  if (erro) return erro400(res, erro);
  const tela = await repo.atualizar(antes.id, dados);
  // Só na transição pra ativo: uma tela que volta do reparo conta como rede
  // crescendo, uma que é salva de novo já ativa não.
  if (tela.status === 'ativo' && antes.status !== 'ativo') {
    eventos.registrar('tela:dispositivo_ativa', { ponto_id: tela.pontoId, custo_aparelho: tela.custoEquipamento });
  }
  await avisarMudanca(tela.pontoId, tela.id);
  res.json(tela);
});

router.delete('/admin/dispositivos/:id', async (req, res) => {
  const existente = await telaOu404(req, res);
  if (!existente) return;
  try {
    if (!(await repo.deletar(existente.id))) return res.status(404).json({ erro: 'tela não encontrada' });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  await avisarMudanca(existente.ponto_id, existente.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin — provisionamento e credencial
// ---------------------------------------------------------------------------
// Código de instalação (docs/player-mvp-contract.md §3): o operador digita
// na TV o ID da tela + este código, que vale 30 min e uma vez só. Gerar de
// novo cancela o anterior. Tela com Player conectado → 409 (revogar antes).
// O código volta em claro só aqui e na ficha, enquanto vale (cópia cifrada).
router.post('/admin/dispositivos/:id/codigo-instalacao', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  let gerado;
  try {
    gerado = await repo.gerarCodigo(tela.id, 'admin');
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  await avisarMudanca(tela.ponto_id, tela.id);
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ codigoTela: formatarCodigoTela(tela.id), ...gerado });
});

router.post('/admin/dispositivos/:id/credencial/rotacionar', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  if (!(await credencial.iniciarRotacao(tela.id))) {
    return erro400(
      res,
      'rotação só existe para Player V2 provisionado — tela no player web: revogue e use Preparar Player',
    );
  }
  await avisarMudanca(tela.ponto_id, tela.id);
  res.json(await repo.buscarPorId(tela.id));
});

router.delete('/admin/dispositivos/:id/credencial/rotacao', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  await credencial.cancelarRotacao(tela.id);
  await avisarMudanca(tela.ponto_id, tela.id);
  res.json(await repo.buscarPorId(tela.id));
});

router.post('/admin/dispositivos/:id/credencial/revogar', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  await credencial.revogar(tela.id);
  await avisarMudanca(tela.ponto_id, tela.id);
  res.json(await repo.buscarPorId(tela.id));
});

// ---------------------------------------------------------------------------
// Admin — PIN de saída do Player (global, docs/player-mvp-contract.md §6)
// ---------------------------------------------------------------------------
// O status nunca traz o número; ver é o POST de revelar, auditado.
router.get('/admin/player/pin-saida', async (_req, res) => {
  res.json(await pinSaida.situacao());
});

router.put('/admin/player/pin-saida', async (req, res) => {
  let r;
  try {
    r = await pinSaida.definir(req.body?.pin);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  // Toda ficha aberta mostra a config "sincronizando" até o próximo
  // heartbeat de cada TV.
  sse.emitirParaAdmin('screen.updated', { id: null, pontoId: null });
  res.json({ definido: r.definido, alteradoEm: r.alteradoEm });
});

router.post('/admin/player/pin-saida/revelar', async (_req, res) => {
  const pin = await pinSaida.revelar();
  if (!pin) return res.status(404).json({ erro: 'nenhum PIN de saída definido — defina um em Rede' });
  res.set('Cache-Control', 'no-store');
  res.json({ pin });
});

// ---------------------------------------------------------------------------
// Admin — releases do Player (OTA fase 1)
// ---------------------------------------------------------------------------
router.get('/admin/player-releases', async (_req, res) => {
  res.json(await releases.listar());
});

router.post('/admin/player-releases', async (req, res) => {
  const d = req.body || {};
  const dados = {
    ...d,
    build: Number(d.build),
    tamanho_bytes: d.tamanho_bytes == null || d.tamanho_bytes === '' ? null : Number(d.tamanho_bytes),
    build_minimo: d.build_minimo == null || d.build_minimo === '' ? null : Number(d.build_minimo),
  };
  const erros = releases.validar(dados);
  if (erros.length) return erro400(res, erros.join('; '));
  try {
    res.status(201).json(await releases.criar(dados, 'admin'));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe uma release com esse build' });
    throw err;
  }
});

router.post('/admin/player-releases/:id/assinatura-conferida', async (req, res) => {
  const r = await releases.conferirAssinatura(req.params.id, 'admin');
  if (!r) return res.status(404).json({ erro: 'release não encontrada' });
  res.json(r);
});

router.patch('/admin/player-releases/:id', async (req, res) => {
  if (typeof req.body?.ativa !== 'boolean') return erro400(res, 'informe ativa: true ou false');
  const r = await releases.definirAtiva(req.params.id, req.body.ativa);
  if (!r) return erro400(res, 'release inexistente, ou assinatura do APK ainda não conferida');
  res.json(r);
});

// ---------------------------------------------------------------------------
// O que rodou numa tela (dono do ponto, em "Meus pontos")
// ---------------------------------------------------------------------------
async function painelDaTela(dispositivoId) {
  const [porAnunciante, porDia] = await Promise.all([
    pool.query(
      `SELECT a.id, a.nome_empresa, SUM(e.vezes_programadas)::int AS programadas, SUM(e.vezes_confirmadas)::int AS confirmadas
       FROM exibicoes_contador e JOIN anunciantes a ON a.id = e.anunciante_id
       WHERE e.dispositivo_id = $1 AND e.janela_hora > now() - interval '30 days'
       GROUP BY a.id ORDER BY confirmadas DESC`,
      [dispositivoId],
    ),
    pool.query(
      // Dia no fuso de Matão, não no do servidor (ver src/anunciantes/routes.js,
      // rota do comprovante em CSV).
      `SELECT date_trunc('day', janela_hora AT TIME ZONE 'America/Sao_Paulo')::date AS dia, SUM(vezes_confirmadas)::int AS confirmadas
       FROM exibicoes_contador WHERE dispositivo_id = $1
       GROUP BY dia ORDER BY dia DESC LIMIT 30`,
      [dispositivoId],
    ),
  ]);
  return { porAnunciante: porAnunciante.rows, porDia: porDia.rows };
}

async function telaDoDono(req, res) {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    res.status(403).json({ erro: 'só pode ver as próprias telas' });
    return null;
  }
  const { rows } = await pool.query(
    `SELECT d.id, d.ponto_id FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
     WHERE d.id = $1 AND p.anunciante_id = $2`,
    [req.params.dispositivoId, req.session.anuncianteId],
  );
  if (!rows[0]) res.status(404).json({ erro: 'tela não encontrada' });
  return rows[0] || null;
}

router.get('/anunciantes/:id/dispositivos/:dispositivoId/painel', exigirAnuncianteLogado, async (req, res) => {
  const tela = await telaDoDono(req, res);
  if (tela) res.json(await painelDaTela(tela.id));
});

module.exports = router;
