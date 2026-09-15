const express = require('express');
const router = express.Router();
const repo = require('./repository');
const candidaturasRepo = require('../candidaturas/repository');

function linkDoConvite(token) {
  const base = process.env.SITE_URL || process.env.CORS_ORIGIN || '';
  return `${base}/convite.html?t=${token}`;
}

// Público: a página de cadastro por convite pergunta o que o link permite.
// Nunca devolve o token de volta nem lista nada — só o que este link é.
router.get('/convites/:token', async (req, res) => {
  const convite = await repo.buscarValido(req.params.token);
  if (!convite) return res.status(404).json({ erro: 'convite inválido, usado ou expirado — fale com quem te enviou' });
  res.json({
    papeis: convite.papeis,
    nome_sugerido: convite.nome_sugerido,
    email_sugerido: convite.email_sugerido,
    expira_em: convite.expira_em,
  });
});

// Admin
router.get('/admin/convites', async (_req, res) => {
  const lista = await repo.listar();
  res.json(lista.map((c) => ({ ...c, link: c.situacao === 'aberto' ? linkDoConvite(c.token) : null })));
});

router.post('/admin/convites', async (req, res) => {
  try {
    const convite = await repo.criar({
      papeis: req.body.papeis,
      nomeSugerido: req.body.nome_sugerido,
      emailSugerido: req.body.email_sugerido,
      candidaturaId: req.body.candidatura_id,
      validadeDias: req.body.validade_dias,
    });
    if (req.body.candidatura_id) {
      await candidaturasRepo.atualizar(req.body.candidatura_id, { status: 'aprovada', convite_id: convite.id });
    }
    res.status(201).json({ ...convite, link: linkDoConvite(convite.token) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
});

router.post('/admin/convites/:id/revogar', async (req, res) => {
  const convite = await repo.revogar(req.params.id);
  if (!convite) return res.status(404).json({ erro: 'convite não encontrado ou já usado' });
  res.json({ ok: true });
});

module.exports = router;
