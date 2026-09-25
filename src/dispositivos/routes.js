const express = require('express');
const router = express.Router();
const repo = require('./repository');
const eventos = require('../lib/eventos');
const pontosRepo = require('../pontos/repository');
const pool = require('../db/pool');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const { limiteTentativas } = require('../lib/limite-tentativas');
const horarioSemanal = require('../lib/horario-semanal');
const { timezoneValida } = require('../lib/operacao-tela');
const credencial = require('../player/credencial');
const telaEventos = require('../player/tela-eventos');
const releases = require('../player/releases');
const sse = require('../lib/sse');
const { exigirAparelho } = require('../lib/aparelho');

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
  if ('modo_horario' in dados && !['ponto', '24h', 'personalizado'].includes(dados.modo_horario)) {
    return { erro: 'modo de operação inválido' };
  }
  if ('horario_semanal' in dados) {
    try {
      dados.horario_semanal = horarioSemanal.validar(dados.horario_semanal);
    } catch (err) {
      return { erro: err.message };
    }
  }
  if ('timezone' in dados && !timezoneValida(dados.timezone)) return { erro: 'fuso horário inválido' };
  if ('update_baixar_auto' in dados && typeof dados.update_baixar_auto !== 'boolean') {
    return { erro: 'baixar automaticamente precisa ser sim ou não' };
  }
  if ('update_horas_entre_tentativas' in dados) {
    const h = Number(dados.update_horas_entre_tentativas);
    if (!Number.isInteger(h) || h < 1 || h > 72) return { erro: 'intervalo entre tentativas vai de 1 a 72 horas' };
    dados.update_horas_entre_tentativas = h;
  }
  if ('contrato_playlist' in dados && ![1, 2].includes(Number(dados.contrato_playlist))) {
    return { erro: 'contrato de playlist inválido' };
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

router.get('/admin/dispositivos/:id/eventos', async (req, res) => {
  if (!(await telaOu404(req, res))) return;
  res.json(await telaEventos.listar(req.params.id, 100));
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
  const existente = await repo.buscarLinha(req.params.id);
  try {
    await repo.deletar(req.params.id);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  if (existente) await avisarMudanca(existente.ponto_id, existente.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin — provisionamento e credencial
// ---------------------------------------------------------------------------
// [Preparar Player] — o fluxo canônico (consolidação, 24/09/2026): gera
// dispositivoId (5 dígitos) + chaveAparelho e devolve o `mostrai-config.json`
// pronto, UMA vez. A chave não fica guardada (só o hash): fechou sem copiar,
// prepara de novo — a anterior deixa de valer.
router.post('/admin/dispositivos/:id/preparar-player', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  let r;
  try {
    r = await repo.prepararPlayer(tela.id);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
  await avisarMudanca(tela.ponto_id, tela.id);
  res.status(201).json({
    nomeArquivo: 'mostrai-config.json',
    arquivo: {
      dispositivoId: r.dispositivoId,
      chaveAparelho: r.chaveAparelho,
      baseUrl: baseUrlDoPlayer(req),
      rotacaoTela: tela.rotacao_tela,
    },
    geradoEm: new Date().toISOString(),
  });
});

// Provisionamento por token (contrato V2 §2.1) — caminho alternativo que o
// Player continua aceitando; o admin usa o [Preparar Player] acima. Fica
// como capacidade do backend (testada), não como tela.
router.post('/admin/dispositivos/:id/provisionamento', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  const gerado = await repo.gerarTokenProvisionamento(tela.id, 'admin');
  const baseUrl = baseUrlDoPlayer(req);
  await avisarMudanca(tela.ponto_id, tela.id);
  res.status(201).json({
    nomeArquivo: 'mostrai-config.json',
    arquivo: { baseUrl, tokenProvisionamento: gerado.token, rotacaoTela: tela.rotacao_tela },
    geradoEm: gerado.criadoEm,
    expiraEm: gerado.expiraEm,
  });
});

router.delete('/admin/dispositivos/:id/provisionamento', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  await repo.cancelarProvisionamento(tela.id);
  await avisarMudanca(tela.ponto_id, tela.id);
  res.json(await repo.buscarPorId(tela.id));
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

// Fluxo antigo de chave (link do player web com a chave na URL) aposentado
// na consolidação de 24/09/2026: um clique apagava o Player V2 da tela. As
// TVs V1 em campo continuam autenticando com a chave que já têm; instalação
// nova é sempre pelo [Preparar Player] (o player web aceita a mesma
// credencial em ?tela=<dispositivoId>&chave=…).
router.post('/admin/dispositivos/:id/chave-legada', (_req, res) =>
  res.status(410).json({ erro: 'fluxo antigo de chave aposentado — use Preparar Player' }),
);

// PIN em claro pro admin (ficha: •••• + olho). Auditado: cada revelação vira
// PIN_REVEALED no histórico da tela. Tela só com o hash V1 não tem PIN
// legível — 404 com o motivo, e o admin redefine.
router.get('/admin/dispositivos/:id/pin', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  const pin = await repo.revelarPin(tela.id);
  if (!pin) return res.status(404).json({ erro: 'esta tela não tem PIN legível — defina um PIN de 4 dígitos' });
  await telaEventos.registrar(tela.id, 'PIN_REVEALED', { por: 'admin' });
  res.set('Cache-Control', 'no-store');
  res.json({ pin });
});

// PIN de manutenção do Player: exatamente 4 dígitos (contrato §5 descarta
// qualquer outra coisa). null remove — mas não de tela com Player V2: sem
// `pinPainel` na config o aparelho mantém o PIN que já tem
// (ConfigAparelho.kt: campo ausente = não mexe), e o admin mostraria "sem
// PIN" com a TV ainda pedindo o antigo.
function lerPin(corpo, tela) {
  const pin = corpo?.pin == null ? null : String(corpo.pin);
  if (pin !== null && !/^\d{4}$/.test(pin)) return { erro: 'o PIN de manutenção do Player tem exatamente 4 dígitos' };
  if (pin === null && tela.dispositivo_uid) {
    return { erro: 'o Player desta tela não fica sem PIN de manutenção — troque por outro PIN de 4 dígitos' };
  }
  return { pin };
}

router.post('/admin/dispositivos/:id/pin', async (req, res) => {
  const tela = await telaOu404(req, res);
  if (!tela) return;
  const { erro, pin } = lerPin(req.body, tela);
  if (erro) return erro400(res, erro);
  await repo.definirPin(tela.id, pin);
  await avisarMudanca(tela.ponto_id, tela.id);
  res.json(await repo.buscarPorId(tela.id));
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
// O que rodou numa tela (dono do ponto ou admin)
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
    `SELECT d.id, d.ponto_id, d.dispositivo_uid FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
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

// PIN de manutenção pelo próprio dono do ponto (docs/funcional.md: "o dono
// do ponto define o PIN da tela") — mesma regra e mesmo armazenamento da
// rota do admin.
router.post('/anunciantes/:id/dispositivos/:dispositivoId/pin', exigirAnuncianteLogado, async (req, res) => {
  const tela = await telaDoDono(req, res);
  if (!tela) return;
  const { erro, pin } = lerPin(req.body, tela);
  if (erro) return erro400(res, erro);
  await repo.definirPin(tela.id, pin);
  await avisarMudanca(tela.ponto_id, tela.id);
  res.json({ ok: true, tem_pin: pin != null });
});

// compat-v1: painel aberto a partir do player web — chave do aparelho + PIN.
// Não dá acesso a nada além desta tela (CONSTRAINTS.md). O Player V2 tem o
// painel local (PIN na config), sem rota no servidor. A autenticação é a
// mesma das outras rotas do Player (exigirAparelho: ponto arquivado, chave
// vazia, rotação), não uma cópia.
// limiteTentativas: PIN de 4 dígitos sem limite é força bruta em minutos.
router.post(
  '/player/:dispositivoId/painel',
  limiteTentativas,
  exigirAparelho({ operacao: false }),
  async (req, res) => {
    if (!(await repo.conferirPin(req.dispositivo.id, req.body?.pin)))
      return res.status(401).json({ erro: 'PIN incorreto' });
    res.json(await painelDaTela(req.dispositivo.id));
  },
);

module.exports = router;
