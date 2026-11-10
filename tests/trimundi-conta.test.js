const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');

// Conta do cliente (pedido do dono, 09/11/2026): cadastro com nome, CPF,
// e-mail e senha; e-mail confirmado antes de comprar; a conta mostra os
// ingressos com QR. Respostas de recuperação não revelam quem tem conta.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const SENHA = 'Minha12@senha';

async function linkDoEmail(email, tipo) {
  const { rows } = await consultar('SELECT texto FROM emails WHERE para = $1 AND tipo = $2 ORDER BY id DESC LIMIT 1', [
    email,
    tipo,
  ]);
  assert.ok(rows[0], `e-mail ${tipo} não foi para a fila`);
  const m = rows[0].texto.match(/#t=([A-Za-z0-9_-]+)/);
  assert.ok(m, 'o token vai no fragmento do link');
  return m[1];
}

test('cadastro → confirmação por e-mail → login; antes de confirmar não entra', async () => {
  const p = apoio.pessoa('Cliente');
  const c = apoio.cliente(srv);
  const cad = await c.post('/ticket/api/conta/cadastro', { ...p, senha: SENHA, maioridade: true, aceite_termos: true });
  assert.equal(cad.status, 201);
  assert.match(cad.json.mensagem, /link de confirmação/);
  const { rows } = await consultar('SELECT senha_hash, email_confirmado_em, cpf FROM clientes WHERE email = $1', [
    p.email,
  ]);
  assert.match(rows[0].senha_hash, /^scrypt\$/, 'senha só como hash');
  assert.equal(rows[0].email_confirmado_em, null);
  assert.equal(rows[0].cpf, p.cpf);

  const antes = await c.post('/ticket/api/conta/entrar', { email: p.email, senha: SENHA });
  assert.equal(antes.status, 403);
  assert.equal(antes.json.codigo, 'nao_confirmado');

  const tk = await linkDoEmail(p.email, 'confirmar_email');
  const conf = await c.post('/ticket/api/conta/confirmar', { token: tk });
  assert.equal(conf.status, 200);
  const logado = apoio.cliente(srv, { cookie: conf.cookies });
  const painel = await logado.get('/ticket/api/conta');
  assert.equal(painel.status, 200);
  assert.equal(painel.json.conta.email, p.email);
  assert.match(painel.json.conta.cpf, /^\*\*\*\.\d{3}\.\*\*\*-\d{2}$/, 'CPF mascarado na tela');
  assert.deepEqual(painel.json.ingressos, []);

  assert.equal((await c.post('/ticket/api/conta/confirmar', { token: tk })).status, 400, 'link é de uso único');
  const entrar = await c.post('/ticket/api/conta/entrar', { email: p.email.toUpperCase(), senha: SENHA });
  assert.equal(entrar.status, 200);
  assert.equal((await apoio.cliente(srv).get('/ticket/api/conta')).status, 401, 'sem sessão, sem conta');
});

test('cadastro repetido não muda a conta; CPF de outra conta é recusado; senha fraca e CPF inválido também', async () => {
  const p = apoio.pessoa('Cliente');
  const c = apoio.cliente(srv);
  await apoio.contaDe(p);
  const repetido = await c.post('/ticket/api/conta/cadastro', {
    ...p,
    senha: 'Outra12@senha',
    maioridade: true,
    aceite_termos: true,
  });
  assert.equal(repetido.status, 201, 'mesma resposta: não diz que o e-mail já tem conta');
  assert.equal((await c.post('/ticket/api/conta/entrar', { email: p.email, senha: 'Outra12@senha' })).status, 401);
  assert.equal((await c.post('/ticket/api/conta/entrar', { email: p.email, senha: apoio.SENHA_CONTA })).status, 200);
  const { rows } = await consultar(
    "SELECT count(*)::int AS n FROM emails WHERE para = $1 AND tipo = 'conta_existente'",
    [p.email],
  );
  assert.equal(rows[0].n, 1, 'o dono da conta é avisado');

  const outroEmail = await c.post('/ticket/api/conta/cadastro', {
    ...apoio.pessoa('X'),
    cpf: p.cpf,
    senha: SENHA,
    maioridade: true,
    aceite_termos: true,
  });
  assert.equal(outroEmail.status, 409);
  assert.equal(outroEmail.json.codigo, 'cpf_em_uso');

  const fraca = await c.post('/ticket/api/conta/cadastro', {
    ...apoio.pessoa('Y'),
    senha: '123',
    maioridade: true,
    aceite_termos: true,
  });
  assert.equal(fraca.status, 400);
  const cpfRuim = await c.post('/ticket/api/conta/cadastro', {
    ...apoio.pessoa('Z'),
    cpf: '11111111111',
    senha: SENHA,
    maioridade: true,
    aceite_termos: true,
  });
  assert.equal(cpfRuim.status, 400);
});

test('login: senha errada e e-mail sem conta dão a mesma resposta', async () => {
  const p = apoio.pessoa('Cliente');
  await apoio.contaDe(p);
  const c = apoio.cliente(srv);
  const errada = await c.post('/ticket/api/conta/entrar', { email: p.email, senha: 'Errada12@x' });
  const semConta = await c.post('/ticket/api/conta/entrar', {
    email: `ninguem.${apoio.sufixo()}@exemplo.com`,
    senha: SENHA,
  });
  assert.equal(errada.status, 401);
  assert.equal(semConta.status, 401);
  assert.equal(errada.json.erro, semConta.json.erro);
});

test('esqueci a senha: resposta igual com ou sem conta; senha nova derruba a sessão antiga', async () => {
  const p = apoio.pessoa('Cliente');
  await apoio.contaDe(p);
  const velha = await apoio.entrarCliente(srv, p);
  const c = apoio.cliente(srv);
  const comConta = await c.post('/ticket/api/conta/esqueci', { email: p.email });
  const semConta = await c.post('/ticket/api/conta/esqueci', { email: `ninguem.${apoio.sufixo()}@exemplo.com` });
  assert.equal(comConta.status, 200);
  assert.equal(comConta.json.mensagem, semConta.json.mensagem);

  const tk = await linkDoEmail(p.email, 'redefinir_senha');
  assert.equal((await c.post('/ticket/api/conta/redefinir', { token: tk, senha: '123' })).status, 400);
  const nova = await c.post('/ticket/api/conta/redefinir', { token: tk, senha: 'Nova12@senha' });
  assert.equal(nova.status, 200);
  assert.equal((await apoio.cliente(srv, { cookie: velha }).get('/ticket/api/conta')).status, 401, 'sessão antiga cai');
  assert.equal((await c.post('/ticket/api/conta/entrar', { email: p.email, senha: 'Nova12@senha' })).status, 200);
  assert.equal((await c.post('/ticket/api/conta/redefinir', { token: tk, senha: 'Outra12@senha' })).status, 400);
});

test('link vencido não confirma', async () => {
  const p = apoio.pessoa('Cliente');
  const c = apoio.cliente(srv);
  await c.post('/ticket/api/conta/cadastro', { ...p, senha: SENHA, maioridade: true, aceite_termos: true });
  const tk = await linkDoEmail(p.email, 'confirmar_email');
  await consultar(
    "UPDATE cliente_tokens SET expira_em = now() - interval '1 minute' WHERE cliente_id = (SELECT id FROM clientes WHERE email = $1)",
    [p.email],
  );
  assert.equal((await c.post('/ticket/api/conta/confirmar', { token: tk })).status, 400);
});

test('compra pela conta: o pedido é da conta, o ingresso "é meu" usa os dados dela e aparece com QR', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = apoio.pessoa('Compradora');
  const conta = await apoio.contaDe(p);
  const cookie = await apoio.entrarCliente(srv, p);
  const c = apoio.cliente(srv, { cookie });
  const cot = await c.post('/ticket/api/cotacao', {
    evento: pronta.slugEvento,
    edicao: pronta.slugEdicao,
    itens: apoio.itensDe(pronta.tipo, 2),
  });
  const amigo = apoio.pessoa('Amigo');
  const r = await c.post('/ticket/api/pedidos', {
    evento: pronta.slugEvento,
    edicao: pronta.slugEdicao,
    itens: apoio.itensDe(pronta.tipo, 2),
    comprador: apoio.pessoa('Ignorado'),
    participantes: [{ conta: true }, amigo],
    aceite: { aceito: true, termos: cot.json.termos.map((t) => t.id), idade: true },
    chave: apoio.chave(),
  });
  assert.equal(r.status, 201);
  const { rows } = await consultar(
    'SELECT p.cliente_id, c.nome, c.cpf, c.email, c.telefone FROM pedidos p JOIN compradores c ON c.id = p.comprador_id WHERE p.id = $1',
    [r.json.pedido_id],
  );
  assert.equal(Number(rows[0].cliente_id), Number(conta.id));
  assert.deepEqual(
    { nome: rows[0].nome, cpf: rows[0].cpf, email: rows[0].email, telefone: rows[0].telefone },
    { nome: p.nome, cpf: p.cpf, email: p.email, telefone: null },
    'quem compra é a conta, não o corpo',
  );

  const antes = await c.get('/ticket/api/conta');
  assert.deepEqual(antes.json.ingressos, [], 'sem pagamento, sem ingresso');
  await apoio.pagar(r.json.pedido_id);
  const depois = await c.get('/ticket/api/conta');
  assert.equal(depois.json.ingressos.length, 2);
  assert.deepEqual(depois.json.ingressos.map((i) => i.participante).sort(), [amigo.nome, p.nome].sort());
  assert.ok(depois.json.ingressos.every((i) => i.qr?.startsWith('data:image/png;base64,')));

  // Outra conta não vê nada disso, nem reaproveita a chave do pedido.
  const outra = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, apoio.pessoa('Outra')) });
  assert.deepEqual((await outra.get('/ticket/api/conta')).json.ingressos, []);
});

test('a chave de um pedido não devolve o pedido para outra conta', async () => {
  const pronta = await apoio.edicaoPronta();
  const a = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  const outra = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, apoio.pessoa('Outra')) });
  const r = await outra.post('/ticket/api/pedidos', { ...a.corpo, comprador: undefined });
  assert.equal(r.status, 409);
  assert.equal(r.json.token, undefined);
});

test('as páginas da conta abrem e não citam a Mostraí', async () => {
  for (const caminho of [
    '/ticket/conta',
    '/ticket/conta/confirmar',
    '/ticket/conta/esqueci',
    '/ticket/conta/redefinir',
  ]) {
    const r = await fetch(`${srv.base}${caminho}`);
    assert.equal(r.status, 200, caminho);
    const html = await r.text();
    assert.match(html, /conta\.page\.js/);
    assert.doesNotMatch(html, /mostra[ií]/i);
  }
});

test('um pedido aguardando pagamento por conta e edição: o segundo volta com o link do primeiro', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = apoio.pessoa('Compradora');
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  const corpo = async () => {
    const cot = await c.post('/ticket/api/cotacao', {
      evento: pronta.slugEvento,
      edicao: pronta.slugEdicao,
      itens: apoio.itensDe(pronta.tipo, 1),
    });
    return {
      evento: pronta.slugEvento,
      edicao: pronta.slugEdicao,
      itens: apoio.itensDe(pronta.tipo, 1),
      participantes: [{ conta: true }],
      aceite: { aceito: true, termos: cot.json.termos.map((t) => t.id), idade: true },
      chave: apoio.chave(),
    };
  };
  const primeiro = await c.post('/ticket/api/pedidos', await corpo());
  assert.equal(primeiro.status, 201);
  const segundo = await c.post('/ticket/api/pedidos', await corpo());
  assert.equal(segundo.status, 409);
  assert.equal(segundo.json.codigo, 'pedido_pendente');
  assert.match(segundo.json.url, new RegExp(`^/ticket/pedido/${primeiro.json.pedido_id}\\?t=`));
  const t = new URL(segundo.json.url, srv.base).searchParams.get('t');
  assert.equal((await c.get(`/ticket/api/pedidos/${primeiro.json.pedido_id}?t=${encodeURIComponent(t)}`)).status, 200);
  // Pago o primeiro, a conta pode comprar de novo.
  await apoio.pagar(primeiro.json.pedido_id);
  assert.equal((await c.post('/ticket/api/pedidos', await corpo())).status, 201);
});
