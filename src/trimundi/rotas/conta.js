const express = require('express');
const { limiteTentativas, limiteTentativasPorAlvo, descontarAcerto } = require('../../lib/limite-tentativas');
const { tratarErros, erro } = require('../lib/erros');
const paginas = require('../paginas');
const clientes = require('../clientes');
const legal = require('../legal');

const ipDo = (req) => req.get('cf-connecting-ip') || req.ip;

// Conta do cliente — /ticket/conta e /ticket/api/conta/*. Toda rota que
// recebe e-mail ou senha passa pelo limitador da Mostraí (por IP e, quando
// há, pelo e-mail): erro conta, acerto desconta. Login e confirmação abrem
// sessão nova (regenerate) — nada da sessão anterior passa adiante.

const router = express.Router();

const acertou = (req, res) => descontarAcerto(req, res).catch(() => {});
const emailDoCorpo = (req) =>
  String(req.body?.email ?? '')
    .trim()
    .toLowerCase();

function abrirSessao(req, c) {
  return new Promise((resolve, reject) =>
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.trimundiClienteId = c.id;
      req.session.trimundiClienteVersao = c.versao;
      resolve();
    }),
  );
}

// Exige conta logada (e confirmada) — para a compra e para "minha conta".
async function exigirCliente(req, _res, next) {
  try {
    req.clienteTrimundi = await clientes.daSessao(req);
    if (!req.clienteTrimundi) throw erro(401, 'Entre na sua conta para continuar.', { codigo: 'conta' });
    next();
  } catch (err) {
    next(err);
  }
}

router.post('/ticket/api/conta/cadastro', limiteTentativasPorAlvo(emailDoCorpo), async (req, res) => {
  const r = await clientes.cadastrar(req.body, { ip: ipDo(req), userAgent: req.get('user-agent') });
  await acertou(req, res);
  res.status(201).json({
    ok: true,
    mensagem: `Enviamos um link de confirmação para ${r.email}. Abra o e-mail e confirme para ativar sua conta.`,
  });
});

router.post('/ticket/api/conta/confirmar', limiteTentativas, async (req, res) => {
  const c = await clientes.confirmarEmail(req.body?.token);
  await abrirSessao(req, c);
  await acertou(req, res);
  res.json({ ok: true });
});

router.post('/ticket/api/conta/reenviar', limiteTentativasPorAlvo(emailDoCorpo), async (req, res) => {
  await clientes.reenviarConfirmacao(req.body?.email);
  res.json({ ok: true, mensagem: 'Se este e-mail tiver conta ainda não confirmada, o link chega em alguns minutos.' });
});

router.post('/ticket/api/conta/entrar', limiteTentativasPorAlvo(emailDoCorpo), async (req, res) => {
  const r = await clientes.entrar(req.body?.email, req.body?.senha);
  if (!r) throw erro(401, 'E-mail ou senha incorretos.');
  if (r.naoConfirmado) {
    throw erro(403, 'Confirme seu e-mail para entrar — procure o link na sua caixa de entrada.', {
      codigo: 'nao_confirmado',
    });
  }
  await acertou(req, res);
  await abrirSessao(req, r);
  res.json({ ok: true });
});

router.post('/ticket/api/conta/sair', (req, res) => {
  delete req.session.trimundiClienteId;
  delete req.session.trimundiClienteVersao;
  res.json({ ok: true });
});

router.post('/ticket/api/conta/esqueci', limiteTentativasPorAlvo(emailDoCorpo), async (req, res) => {
  await clientes.esqueciSenha(req.body?.email);
  res.json({
    ok: true,
    mensagem: 'Se este e-mail tiver conta, o link para criar uma senha nova chega em alguns minutos.',
  });
});

router.post('/ticket/api/conta/redefinir', limiteTentativas, async (req, res) => {
  const c = await clientes.redefinirSenha(req.body?.token, req.body?.senha);
  await abrirSessao(req, c);
  await acertou(req, res);
  res.json({ ok: true });
});

// Quem está logado (para a página do evento saber se pede login).
router.get('/ticket/api/conta/sessao', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const c = await clientes.daSessao(req);
  res.json(c ? { logado: true, nome: c.nome, email: c.email } : { logado: false });
});

router.post('/ticket/api/conta/aceite', exigirCliente, async (req, res) => {
  res.json(await clientes.aceitar(req.clienteTrimundi, req.body, { ip: ipDo(req), userAgent: req.get('user-agent') }));
});

router.get('/ticket/api/conta', exigirCliente, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await clientes.painel(req.clienteTrimundi));
});

// Termos de Uso e Política de Privacidade (com a versão e o canal do titular).
for (const nome of ['termos', 'privacidade']) {
  router.get(`/ticket/${nome}`, (_req, res) =>
    paginas.enviar(res, nome, { versao: legal.VERSAO, vigencia: legal.VIGENCIA, contato: legal.contato() || '—' }),
  );
}

// Uma página só para entrar, cadastrar, confirmar, recuperar e "minha conta".
for (const caminho of [
  '/ticket/conta',
  '/ticket/conta/confirmar',
  '/ticket/conta/esqueci',
  '/ticket/conta/redefinir',
]) {
  router.get(caminho, (_req, res) => paginas.enviar(res, 'conta', {}, { cache: 'no-store' }));
}

router.use('/ticket', tratarErros);

module.exports = { router, exigirCliente };
