const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const { operadorDaRequisicao } = require('../lib/operador');
const { limiteTentativas } = require('../lib/limite-tentativas');
const repo = require('./repository');

// Marketplace de Lojas. Quatro portas:
//   /admin/lojas/*            Admin (já atrás do requireAdminSession de server.js)
//   /conta/loja/*             a conta dona da loja (sessão da Mostraí)
//   /marketplace/api/*        vitrine pública (só leitura + contato)
//   páginas                   /marketplace, /loja/<slug>, /anunciante/minha-loja
//
// DESLIGADO POR PADRÃO: sem MARKETPLACE_ATIVO=1 o router se retira inteiro
// (`next('router')`) e quem responde é o 404 do site — página para quem pediu
// página, JSON para a API —, como se nada disto existisse. O deploy não liga
// nada sozinho. A única exceção é GET /admin/marketplace/estado, que diz ao
// Admin se mostra o item "Lojas" no menu.

const router = express.Router();
const ativo = () => process.env.MARKETPLACE_ATIVO === '1';
const PREFIXOS = ['/admin/lojas', '/conta/loja', '/marketplace', '/loja', '/anunciante/minha-loja'];
const coberto = (p) => PREFIXOS.some((x) => p === x || p.startsWith(`${x}/`));

router.get('/admin/marketplace/estado', (_req, res) => res.json({ ativo: ativo() }));

router.use((req, _res, next) => {
  if (ativo() || !coberto(req.path)) return next();
  return next('router');
});

const id = (valor) => {
  const n = Number(valor);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw new repo.ErroLoja('id inválido', 404);
  return n;
};
const autor = (req) => operadorDaRequisicao(req);

// Imagem (logo da loja, foto do espaço): até 5 MB, em memória — o tipo real
// é conferido pelos bytes em repo.gravarImagem.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const receberImagem = (req, res, next) =>
  upload.single('arquivo')(req, res, (err) => {
    if (err?.code === 'LIMIT_FILE_SIZE')
      return res.status(413).json({ erro: 'imagem grande demais — o máximo é 5 MB' });
    if (err) return next(err);
    if (!req.file) return res.status(400).json({ erro: 'envie uma imagem (JPG, PNG ou WebP)' });
    next();
  });

// ------------------------------------------------------------------ Admin
router.get('/admin/lojas/planos', async (_req, res) => res.json(await repo.listarPlanos()));
router.post('/admin/lojas/planos', async (req, res) => res.status(201).json(await repo.criarPlano(req.body || {})));
router.patch('/admin/lojas/planos/:id', async (req, res) =>
  res.json(await repo.atualizarPlano(String(req.params.id), req.body || {})),
);
router.get('/admin/lojas/contas', async (req, res) => res.json(await repo.buscarContas(req.query.busca)));
router.get('/admin/lojas/espacos', async (_req, res) => res.json(await repo.espacosParaModeracao()));

router.get('/admin/lojas', async (_req, res) => res.json(await repo.listarLojas()));
router.post('/admin/lojas', async (req, res) => res.status(201).json(await repo.criarLoja(req.body || {}, autor(req))));
router.get('/admin/lojas/:id', async (req, res) => {
  const f = await repo.ficha(id(req.params.id));
  if (!f) return res.status(404).json({ erro: 'loja não encontrada' });
  res.json({ ...f, historico: await repo.historico(f.id) });
});
router.patch('/admin/lojas/:id', async (req, res) =>
  res.json(await repo.atualizarLoja(id(req.params.id), req.body || {}, autor(req))),
);
router.post('/admin/lojas/:id/status', async (req, res) =>
  res.json(await repo.mudarStatus(id(req.params.id), req.body?.status, req.body?.motivo, autor(req))),
);
router.post('/admin/lojas/:id/logo', receberImagem, async (req, res) =>
  res.json(await repo.gravarImagem('logo', { lojaId: id(req.params.id) }, req.file.buffer)),
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
// Moderação: bloquear tira da vitrine e trava a republicação pela dona;
// liberar destrava (o espaço segue pausado até ela publicar).
router.post('/admin/lojas/:id/espacos/:espaco/moderacao', async (req, res) =>
  res.json(
    await repo.moderarEspaco(
      id(req.params.id),
      id(req.params.espaco),
      { acao: req.body?.acao, motivo: req.body?.motivo },
      autor(req),
    ),
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
router.post('/conta/loja/logo', exigirDonaDaLoja, receberImagem, async (req, res) =>
  res.json(await repo.gravarImagem('logo', { lojaId: req.lojaId }, req.file.buffer)),
);
router.post('/conta/loja/espacos', exigirDonaDaLoja, async (req, res) =>
  res.status(201).json(await repo.criarEspaco(req.lojaId, req.body || {}, autorDaConta(req))),
);
router.patch('/conta/loja/espacos/:espaco', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.atualizarEspaco(req.lojaId, id(req.params.espaco), req.body || {}, autorDaConta(req))),
);
router.post('/conta/loja/espacos/:espaco/foto', exigirDonaDaLoja, receberImagem, async (req, res) =>
  res.json(await repo.gravarImagem('espaco', { lojaId: req.lojaId, espacoId: id(req.params.espaco) }, req.file.buffer)),
);
router.get('/conta/loja/contatos', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.contatosDaLoja(req.lojaId)),
);
router.post('/conta/loja/contatos/:contato/lido', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.marcarContatoLido(req.lojaId, id(req.params.contato))),
);
router.post('/conta/loja/contatos/:contato/respondido', exigirDonaDaLoja, async (req, res) =>
  res.json(await repo.marcarContatoRespondido(req.lojaId, id(req.params.contato))),
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

// ------------------------------------------------------------------ páginas
// HTML sem build, como o resto do site: o texto vem por JS das rotas acima.
// /loja/<slug> só existe enquanto a loja está na vitrine (senão, o 404 do
// site), e o título e a descrição já saem no HTML (busca e prévia de link).
const PAGINAS = path.join(__dirname, 'paginas');
const lerPagina = (nome) => fs.readFileSync(path.join(PAGINAS, `${nome}.html`), 'utf8');
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
const enviarHtml = (res, html) => res.set('Cache-Control', 'no-store').type('html').send(html);

router.get('/marketplace', (_req, res) => enviarHtml(res, lerPagina('marketplace')));
router.get('/anunciante/minha-loja', (_req, res) => enviarHtml(res, lerPagina('minha-loja')));
router.get('/loja/:slug', async (req, res, next) => {
  const loja = await repo.lojaPublica(req.params.slug);
  if (!loja) return next();
  const titulo = `${loja.nome}${loja.cidade ? ` — ${loja.cidade}${loja.uf ? `/${loja.uf}` : ''}` : ''}`;
  const descricao =
    (loja.descricao || '').slice(0, 160) || `Espaços de publicidade de ${loja.nome} no Marketplace da Mostraí.`;
  const html = lerPagina('loja')
    .replaceAll('{{TITULO}}', escHtml(titulo))
    .replaceAll('{{DESCRICAO}}', escHtml(descricao))
    .replaceAll('{{SLUG}}', escHtml(loja.slug));
  enviarHtml(res, html);
});

// Erros de regra viram resposta com status; o resto segue para o tratador
// geral do servidor.
router.use((err, _req, res, next) => {
  if (err instanceof repo.ErroLoja) return res.status(err.status).json({ erro: err.message });
  return next(err);
});

module.exports = router;
