const express = require('express');
const movel = require('./movel');
const sse = require('../lib/sse');

// Ponto móvel no Admin (migration 112) — tudo em /admin, então a guarda de
// sessão do admin (src/server.js) vale para todas: a conta da base, o
// anunciante e o organizador do evento não mexem em nada daqui.
//   GET  /admin/pontos/:id/movel                         ficha (base, local atual, eventos, bases anteriores)
//   POST /admin/pontos/:id/tornar-movel                  fixo → móvel (a dona vira a base)
//   POST /admin/pontos/:id/tornar-fixo                   móvel → fixo (a base vira a dona)
//   PUT  /admin/pontos/:id/base                          definir/alterar a base
//   POST /admin/pontos/:id/eventos                       cadastrar evento
//   POST /admin/pontos/:id/eventos/:eventoId/iniciar     o ponto chegou ao evento
//   POST /admin/pontos/:id/eventos/:eventoId/encerrar    encerrar e voltar para a base
//   POST /admin/pontos/:id/eventos/:eventoId/cancelar    evento que não vai acontecer
const router = express.Router();

const idDaRota = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const adminDe = (req) => req.session?.adminUsuario || 'admin';

// Cada escrita avisa sem F5: o Admin (Rede), a conta da base ("Meus
// pontos") e quem escolheu o ponto (lista de pontos do painel).
async function avisar(pontoId, extras = []) {
  sse.emitirParaAdmin('point.updated', { id: pontoId });
  for (const conta of await movel.contasInteressadas(pontoId, extras)) {
    sse.emitirParaConta(conta, 'point.updated', { id: pontoId });
  }
}

function rota(fn) {
  return async (req, res) => {
    const id = idDaRota(req.params.id);
    if (!id) return res.status(404).json({ erro: 'ponto não encontrado' });
    try {
      await fn(req, res, id);
    } catch (err) {
      if (err.status)
        return res.status(err.status).json({ erro: err.message, ...(err.campo ? { campo: err.campo } : {}) });
      throw err;
    }
  };
}

router.get(
  '/admin/pontos/:id/movel',
  rota(async (_req, res, id) => {
    const ficha = await movel.fichaDoMovel(id);
    if (!ficha) return res.status(404).json({ erro: 'ponto não encontrado' });
    res.json(ficha);
  }),
);

router.post(
  '/admin/pontos/:id/tornar-movel',
  rota(async (_req, res, id) => {
    const { exDono } = await movel.tornarMovel(id);
    await avisar(id, [exDono]);
    res.json({ ok: true });
  }),
);

router.post(
  '/admin/pontos/:id/tornar-fixo',
  rota(async (req, res, id) => {
    const { novoDono } = await movel.tornarFixo(id, adminDe(req));
    await avisar(id, [novoDono]);
    res.json({ ok: true });
  }),
);

router.put(
  '/admin/pontos/:id/base',
  rota(async (req, res, id) => {
    const r = await movel.alterarBase(id, req.body, adminDe(req));
    await avisar(id, [r.contaBaseAnterior]);
    res.json({ ok: true, baseNova: r.baseNova, enderecoMudou: r.enderecoMudou });
  }),
);

router.post(
  '/admin/pontos/:id/eventos',
  rota(async (req, res, id) => {
    const eventoId = await movel.criarEvento(id, req.body, adminDe(req));
    await avisar(id);
    res.status(201).json({ id: eventoId });
  }),
);

const ACOES_DO_EVENTO = {
  iniciar: movel.iniciarEvento,
  encerrar: movel.encerrarEvento,
  cancelar: movel.cancelarEvento,
};
router.post(
  '/admin/pontos/:id/eventos/:eventoId/:acao',
  rota(async (req, res, id) => {
    if (!Object.hasOwn(ACOES_DO_EVENTO, req.params.acao)) return res.status(404).json({ erro: 'ação desconhecida' });
    await ACOES_DO_EVENTO[req.params.acao](id, req.params.eventoId);
    await avisar(id);
    res.json({ ok: true });
  }),
);

module.exports = router;
