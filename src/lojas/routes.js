const express = require('express');
const { operadorDaRequisicao } = require('../lib/operador');
const { limiteTentativas } = require('../lib/limite-tentativas');
const repo = require('./repository');

// Marketplace de Lojas — Etapa 3. Três portas:
//   /admin/lojas/*          Admin (já atrás do requireAdminSession de server.js)
//   /conta/loja/*           a conta dona da loja (sessão da Mostraí)
//   /marketplace/api/*      vitrine pública (só leitura + contato)
//
// DESLIGADO POR PADRÃO: sem MARKETPLACE_ATIVO=1 toda rota daqui responde 404,
// como se não existisse — o deploy não liga nada sozinho. Ligar é decisão do
// dono, no ambiente.

const router = express.Router();
const ativo = () => process.env.MARKETPLACE_ATIVO === '1';
const PREFIXOS = ['/admin/lojas', '/conta/loja', '/marketplace'];

router.use((req, res, next) => {
  if (ativo() || !PREFIXOS.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
  return res.status(404).json({ erro: 'não encontrado' });
});

const id = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new repo.ErroLoja('id inválido', 404);
  return n;
};
const autor = (req) => operadorDaRequisicao(req);

// ------------------------------------------------------------------ Admin
router.get('/admin/lojas/planos', async (_req, res) => res.json(await repo.listarPlanos()));
router.post('/admin/lojas/planos', async (req, res) => res.status(201).json(await repo.criarPlano(req.body || {})));
router.patch('/admin/lojas/planos/:id', async (req, res) =>
  res.json(await repo.atualizarPlano(String(req.params.id), req.body || {})),
);

router.get('/admin/lojas', async (_req, res) => res.json(await repo.listarLojas()));
router.post('/admin/lojas', async (req, res) => res.status(201).json(await repo.criarLoja(req.body || {}, autor(req))));
router.get('/admin/lojas/:id', async (req, res) => {
  const f = await repo.ficha(id(req.params.id));
  if (!f) return res.status(404).json({ erro: 'loja não encontrada' });
  res.json(f);
});
router.patch('/admin/lojas/:id', async (req, res) =>
  res.json(await repo.atualizarLoja(id(req.params.id), req.body || {}, autor(req))),
);
router.post('/admin/lojas/:id/status', async (req, res) =>
  res.json(await repo.mudarStatus(id(req.params.id), req.body?.status, req.body?.motivo, autor(req))),
);
router.post('/admin/lojas/:id/assinaturas', async (req, res) =>
  res.status(201).json(await repo.criarAssinatura(id(req.params.id), req.body || {}, autor(req))),
);
router.post('/admin/lojas/assinaturas/:id/pagamentos', async (req, res) =>
  res.status(201).json(await repo.registrarPagamento(id(req.params.id), req.body || {}, autor(req))),
);
router.post('/admin/lojas/assinaturas/:id/cancelar', async (req, res) =>
  res.json(await repo.cancelarAssinatura(id(req.params.id), req.body?.motivo, autor(req))),
);
router.get('/admin/lojas/:id/contatos', async (req, res) => res.json(await repo.contatosDaLoja(id(req.params.id))));
// Moderação: o Admin pausa ou arquiva um espaço de qualquer loja.
router.post('/admin/lojas/:id/espacos/:espaco/status', async (req, res) =>
  res.json(
    await repo.atualizarEspaco(id(req.params.id), id(req.params.espaco), { status: req.body?.status }, autor(req)),
  ),
);

// ------------------------------------------------------------------ dona da loja
// A conta logada só alcança a PRÓPRIA loja (uma por conta): nenhum id de
// loja vem da requisição.
async function exigirDonaDaLoja(req, res, next) {
  if (!req.session?.anuncianteId) return res.status(401).json({ erro: 'não autenticado' });
  const lojaId = await repo.lojaDaConta(req.session.anuncianteId);
  if (!lojaId) return res.status(404).json({ erro: 'esta conta não tem loja' });
  req.lojaId = lojaId;
  next();
}
const autorDaConta = (req) => ({ operador: `conta:${req.session.anuncianteId}`, operadorAccess: null });

router.get('/conta/loja', exigirDonaDaLoja, async (req, res) => res.json(await repo.ficha(req.lojaId)));
router.patch('/conta/loja', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.atualizarLoja(req.lojaId, req.body || {}, autorDaConta(req), { soVitrine: true })),
);
router.post('/conta/loja/espacos', exigirDonaDaLoja, async (req, res) =>
  res.status(201).json(await repo.criarEspaco(req.lojaId, req.body || {}, autorDaConta(req))),
);
router.patch('/conta/loja/espacos/:espaco', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.atualizarEspaco(req.lojaId, id(req.params.espaco), req.body || {}, autorDaConta(req))),
);
router.get('/conta/loja/contatos', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.contatosDaLoja(req.lojaId)),
);
router.post('/conta/loja/contatos/:contato/lido', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.marcarContatoLido(req.lojaId, id(req.params.contato))),
);

// ------------------------------------------------------------------ vitrine pública
router.get('/marketplace/api/espacos', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await repo.vitrine({ cidade: req.query.cidade || null, tipo: req.query.tipo || null }));
});
router.get('/marketplace/api/lojas/:slug', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const loja = await repo.lojaPublica(req.params.slug);
  if (!loja) return res.status(404).json({ erro: 'loja não encontrada' });
  res.json(loja);
});
router.post('/marketplace/api/lojas/:slug/contato', limiteTentativas, async (req, res) => {
  const c = await repo.registrarContato(req.params.slug, req.body || {});
  res.status(201).json({ ok: true, id: c.id });
});

// Erros de regra viram resposta com status; o resto segue para o tratador
// geral do servidor.
router.use((err, _req, res, next) => {
  if (err instanceof repo.ErroLoja) return res.status(err.status).json({ erro: err.message });
  return next(err);
});

module.exports = router;
