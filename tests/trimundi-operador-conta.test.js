const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const operadores = require('../src/trimundi/operadores');
const { consultar } = require('../src/trimundi/db/conexao');

// Operador na conta TICK (pedido do dono, 11/11/2026): o código (ou o link
// do convite, que só preenche o código) liga o operador à conta TICK de quem
// o usa — mesmo e-mail, mesma senha, mesma sessão, os ingressos preservados.
// A validação é só do servidor; as regras do código (uso único, 72 h, 5
// tentativas, revogação) continuam as mesmas.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

// Uma pessoa com conta TICK e um convite de operador para o mesmo e-mail.
async function pessoaConvidada(edicoes = 'todas') {
  const p = apoio.pessoa('Operadora');
  const conta = await apoio.contaDe(p);
  const { operador, codigo } = await operadores.criar(
    { nome: `Operadora ${apoio.sufixo()}`, email: p.email, edicoes },
    apoio.AUTOR,
  );
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  return { p, conta, operador, codigo, c };
}
const vincular = (c, codigo) => c.post('/ticket/api/operador/vincular', { codigo });

test('código na conta: a mesma conta vira operadora — um login, ingressos preservados, sem segundo cadastro', async () => {
  const pronta = await apoio.edicaoPronta();
  const { p, conta, operador, codigo, c } = await pessoaConvidada([pronta.edicao.id]);
  // Já tinha um ingresso comprado antes.
  const antes = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: p,
    participantes: [{ conta: true }],
  });
  await apoio.pagar(antes.pedido_id);
  assert.equal((await c.get('/ticket/api/operador')).status, 401, 'antes da ativação, não é operador');
  assert.equal((await c.get('/ticket/api/conta')).json.operador, null);

  const r = await vincular(c, codigo.toLowerCase());
  assert.equal(r.status, 200, r.texto);
  assert.deepEqual([r.json.ok, r.json.ja_ativo, r.json.portaria], [true, false, '/ticket/checkin']);

  // A MESMA sessão abre a portaria (sem /ticket/entrar).
  const eu = await c.get('/ticket/api/operador');
  assert.equal(eu.status, 200);
  assert.equal(eu.json.nome, operador.nome);
  assert.deepEqual(
    eu.json.edicoes.map((e) => Number(e.id)),
    [Number(pronta.edicao.id)],
  );
  const pagina = await c.get('/ticket/checkin');
  assert.equal(pagina.status, 200, 'a portaria abre com a conta');
  // E a conta segue a de sempre: ingressos e área do operador.
  const d = (await c.get('/ticket/api/conta')).json;
  assert.equal(d.edicoes.flatMap((g) => g.pedidos).flatMap((x) => x.ingressos).length, 1, 'ingresso preservado');
  assert.equal(d.operador.ativo, true);
  assert.equal(d.operador.portaria, '/ticket/checkin');
  assert.deepEqual(
    d.operador.eventos.map((e) => Number(e.edicao_id)),
    [Number(pronta.edicao.id)],
  );
  // Compra nova pela mesma conta, normalmente.
  const depois = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: p,
    participantes: [{ conta: true }],
  });
  await apoio.pagar(depois.pedido_id);
  assert.equal(
    (await c.get('/ticket/api/conta')).json.edicoes.flatMap((g) => g.pedidos).flatMap((x) => x.ingressos).length,
    2,
  );
  // No banco: ligado à conta, sem senha só da portaria, uma conta só com o e-mail.
  const { rows } = await consultar(
    'SELECT cliente_id, status, senha_hash, codigo_hash, vinculado_em FROM operadores WHERE id = $1',
    [operador.id],
  );
  assert.equal(Number(rows[0].cliente_id), Number(conta.id));
  assert.equal(rows[0].status, 'ativo');
  assert.equal(rows[0].senha_hash, null, 'nenhuma senha nova');
  assert.equal(rows[0].codigo_hash, null, 'código usado uma vez só');
  assert.ok(rows[0].vinculado_em);
  const { rows: contas } = await consultar('SELECT count(*)::int AS n FROM clientes WHERE email = $1', [
    p.email.toLowerCase(),
  ]);
  assert.equal(contas[0].n, 1);
  // De novo: sem duplicar, sem erro.
  const outra = await vincular(c, codigo);
  assert.equal(outra.status, 200);
  assert.equal(outra.json.ja_ativo, true);
});

test('link de ativação: sem conta logada nada acontece (401) e o código continua valendo depois do login', async () => {
  const { p, codigo } = await pessoaConvidada();
  const pagina = await apoio.cliente(srv).get('/ticket/ativar');
  assert.equal(pagina.status, 200);
  assert.match(pagina.texto, /ativar\.page\.js/);
  const anonimo = await vincular(apoio.cliente(srv), codigo);
  assert.equal(anonimo.status, 401, 'o parâmetro do link sozinho não dá permissão');
  assert.equal(anonimo.json.codigo, 'conta');
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  assert.equal((await vincular(c, codigo)).status, 200);
});

test('regras do código preservadas: inválido, 5 tentativas, vencido', async () => {
  const { codigo, c, operador } = await pessoaConvidada();
  for (let i = 0; i < 5; i++) {
    const r = await vincular(c, 'ZZZZ-ZZZZ');
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'codigo_invalido');
  }
  assert.equal((await vincular(c, codigo)).status, 400, 'travado depois de 5 erros');
  // Código novo do Admin: zera e vale de novo; vencido → 410.
  const novo = await operadores.novoCodigo(operador.id, apoio.AUTOR);
  await consultar("UPDATE operadores SET codigo_expira_em = now() - interval '1 minute' WHERE id = $1", [operador.id]);
  const vencido = await vincular(c, novo.codigo);
  assert.equal(vencido.status, 410);
  const outroNovo = await operadores.novoCodigo(operador.id, apoio.AUTOR);
  assert.equal((await vincular(c, novo.codigo)).status, 400, 'o código antigo foi revogado');
  assert.equal((await vincular(c, outroNovo.codigo)).status, 200);
});

test('conflitos: convite de outro e-mail, convite já ligado a outra conta, conta já ligada a outro operador', async () => {
  // Convite para o e-mail da Ana, usado na conta da Bia → 409, nada ligado.
  const ana = await pessoaConvidada();
  const bia = apoio.pessoa('Bia');
  await apoio.contaDe(bia);
  const cBia = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, bia) });
  const r = await vincular(cBia, ana.codigo);
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'outro_email');
  const { rows } = await consultar('SELECT cliente_id, status FROM operadores WHERE id = $1', [ana.operador.id]);
  assert.deepEqual([rows[0].cliente_id, rows[0].status], [null, 'aguardando_ativacao']);
  assert.equal((await vincular(ana.c, ana.codigo)).status, 200, 'a Ana, com o próprio e-mail, ativa');

  // Convite já ligado a outra conta: não transfere.
  const caio = await pessoaConvidada();
  const outraConta = await apoio.contaDe(apoio.pessoa('Outra'));
  await consultar('UPDATE operadores SET cliente_id = $2, vinculado_em = now() WHERE id = $1', [
    caio.operador.id,
    outraConta.id,
  ]);
  const c2 = await vincular(caio.c, caio.codigo);
  assert.equal(c2.status, 409);
  assert.equal(c2.json.codigo, 'outra_conta');

  // A Ana já é operadora; o cadastro dela muda de e-mail no Admin e chega um
  // convite NOVO para o e-mail da conta dela: 409, sem trocar de operador.
  await consultar('UPDATE operadores SET email = $2, email_normalizado = $2 WHERE id = $1', [
    ana.operador.id,
    `antigo.${apoio.sufixo()}@exemplo.com`,
  ]);
  const segundo = await operadores.criar({ nome: 'Segundo', email: ana.p.email, edicoes: 'todas' }, apoio.AUTOR);
  const c3 = await vincular(ana.c, segundo.codigo);
  assert.equal(c3.status, 409);
  assert.equal(c3.json.codigo, 'ja_operador');
  const { rows: depois } = await consultar('SELECT id FROM operadores WHERE cliente_id = $1', [ana.conta.id]);
  assert.deepEqual(
    depois.map((x) => Number(x.id)),
    [Number(ana.operador.id)],
    'continua ligada ao mesmo operador',
  );
});

test('desativado: a portaria fecha na hora, a conta continua; reativado com código novo, volta na mesma conta', async () => {
  const { codigo, c, operador } = await pessoaConvidada();
  await vincular(c, codigo);
  await operadores.desativar(operador.id, apoio.AUTOR);
  assert.equal((await c.get('/ticket/api/operador')).status, 401);
  const d = (await c.get('/ticket/api/conta')).json;
  assert.equal(d.operador.ativo, false);
  assert.equal(d.operador.portaria, null);
  assert.equal((await c.get('/ticket/api/conta')).status, 200, 'a conta segue normal');
  await operadores.reativar(operador.id, apoio.AUTOR);
  assert.equal((await c.get('/ticket/api/operador')).status, 200);
});

test('vários eventos: a conta mostra cada evento com o desempenho de indicação separado', async () => {
  const a = await apoio.edicaoPronta();
  const b = await apoio.edicaoPronta();
  const { codigo, c } = await pessoaConvidada([a.edicao.id, b.edicao.id]);
  await vincular(c, codigo);
  const meuCodigo = (await c.get('/ticket/api/operador')).json.indicacao.codigo;
  const ped = await apoio.novoPedido(a, apoio.itensDe(a.tipo, 2), {
    comprador: apoio.pessoa('Ind'),
    indicacao: meuCodigo,
  });
  await apoio.pagar(ped.pedido_id);
  const eventos = (await c.get('/ticket/api/conta')).json.operador.eventos;
  const de = (pronta) => eventos.find((e) => Number(e.edicao_id) === Number(pronta.edicao.id));
  assert.deepEqual([de(a).pessoas, de(a).ingressos], [1, 2]);
  assert.deepEqual([de(b).pessoas, de(b).ingressos], [0, 0]);
  assert.match(de(a).link_indicacao, new RegExp(`\\?ind=${meuCodigo}$`));
});

test('operador na conta não se indica pela própria conta; sair da portaria encerra a sessão da conta', async () => {
  const pronta = await apoio.edicaoPronta();
  const { p, codigo, c } = await pessoaConvidada([pronta.edicao.id]);
  await vincular(c, codigo);
  const meuCodigo = (await c.get('/ticket/api/operador')).json.indicacao.codigo;
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), { comprador: p, indicacao: meuCodigo });
  const { rows } = await consultar('SELECT indicador_id FROM pedidos WHERE id = $1', [ped.pedido_id]);
  assert.equal(rows[0].indicador_id, null);
  await c.post('/ticket/api/sair', {});
  assert.equal((await c.get('/ticket/api/conta')).status, 401, 'um login só: sair é sair');
});
