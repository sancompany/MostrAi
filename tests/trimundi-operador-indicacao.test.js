const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const apoio = require('./trimundi-apoio');

// Área do operador (pedido do dono, 11/11/2026): o mesmo "Indique e
// acompanhe" do cliente — pessoas com compra confirmada, acessos únicos,
// contas criadas pela indicação, ingressos comprados por indicados — e a
// lista dos indicados. Sem CPF nem e-mail; o cliente continua sem lista.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const visitante = () => crypto.randomUUID().replace(/-/g, '');

test('operador vê os quatro números e a lista de quem indicou, sem CPF nem e-mail', async () => {
  const pronta = await apoio.edicaoPronta();
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const portaria = apoio.cliente(srv, { cookie: op.cookie });
  let ind = (await portaria.get('/ticket/api/operador')).json.indicacao;
  assert.deepEqual(ind.numeros, { acessos: 0, contas_criadas: 0, pessoas: 0, compras: 0, ingressos: 0 });
  assert.deepEqual(ind.indicados, []);
  assert.match(ind.link_geral, new RegExp(`/tic/eventos\\?ind=${ind.codigo}$`));
  assert.equal(ind.links.length, 1, 'o link do evento em que trabalha');

  // Dois navegadores pelo link; a Bia cria a conta depois e volta logada.
  const vBia = visitante();
  await apoio.cliente(srv).post('/ticket/api/indicacao/visita', { codigo: ind.codigo, visitante: vBia });
  await apoio.cliente(srv).post('/ticket/api/indicacao/visita', { codigo: ind.codigo, visitante: visitante() });
  const bia = apoio.pessoa('Bia');
  const biaLogada = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, bia) });
  await biaLogada.post(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}/indicacao`, {
    codigo: ind.codigo,
    visitante: vBia,
  });
  // Bia compra 3 e paga; Caio fica aguardando pagamento.
  const pago = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 3), { comprador: bia, indicacao: ind.codigo });
  await apoio.pagar(pago.pedido_id);
  const caio = apoio.pessoa('Caio');
  await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), { comprador: caio, indicacao: ind.codigo });

  ind = (await portaria.get('/ticket/api/operador')).json.indicacao;
  assert.deepEqual(
    [ind.numeros.pessoas, ind.numeros.acessos, ind.numeros.contas_criadas, ind.numeros.ingressos],
    [1, 2, 1, 3],
  );
  const porNome = Object.fromEntries(ind.indicados.map((i) => [i.nome, i]));
  assert.equal(porNome[bia.nome].confirmada, true);
  assert.equal(porNome[bia.nome].ingressos, 3);
  assert.equal(porNome[bia.nome].situacao, 'compra confirmada');
  assert.equal(porNome[caio.nome].confirmada, false, 'pendente aparece, mas não conta');
  assert.equal(porNome[caio.nome].situacao, 'aguardando pagamento');
  assert.equal(porNome[caio.nome].ingressos, 0);
  assert.equal(ind.indicados[0].nome, bia.nome, 'confirmados primeiro');
  const json = JSON.stringify(ind);
  for (const dado of [bia.cpf, bia.email, caio.cpf, caio.email]) {
    assert.equal(json.includes(dado), false, 'sem CPF nem e-mail dos indicados');
  }
  assert.equal(
    ind.indicados.every((i) => !('cpf' in i) && !('cliente_id' in i)),
    true,
  );
});

test('a conta do cliente continua sem lista de indicados; sem sessão de operador, 401', async () => {
  const ana = apoio.pessoa('Ana');
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const ind = (await c.get('/ticket/api/conta')).json.indicacao;
  assert.ok(ind.numeros);
  assert.equal('indicados' in ind, false);
  assert.equal((await apoio.cliente(srv).get('/ticket/api/operador')).status, 401);
  assert.equal((await c.get('/ticket/api/operador')).status, 401, 'conta de cliente não é operador');
});

test('operador comprando com a própria conta de cliente (mesmo e-mail) não conta como indicação', async () => {
  const pronta = await apoio.edicaoPronta();
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const portaria = apoio.cliente(srv, { cookie: op.cookie });
  const { codigo } = (await portaria.get('/ticket/api/operador')).json.indicacao;
  // A conta de cliente dele: o mesmo e-mail, com outra caixa.
  const ele = { ...apoio.pessoa('Operador'), email: op.email.toUpperCase() };
  const comoCliente = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ele) });
  const pagina = await comoCliente.post(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}/indicacao`, {
    codigo,
    visitante: visitante(),
  });
  assert.equal(pagina.json.indicacao, null, 'sem "Você chegou por indicação de…" para ele mesmo');
  await comoCliente.post('/ticket/api/indicacao/visita', { codigo, visitante: visitante() });
  const dele = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2), { comprador: ele, indicacao: codigo });
  await apoio.pagar(dele.pedido_id);
  const { rows } = await require('../src/trimundi/db/conexao').consultar(
    'SELECT indicador_id FROM pedidos WHERE id = $1',
    [dele.pedido_id],
  );
  assert.equal(rows[0].indicador_id, null, 'a compra dele fica sem indicador');

  // Outra pessoa pelo mesmo link continua contando.
  const bia = apoio.pessoa('Bia');
  const dela = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), { comprador: bia, indicacao: codigo });
  await apoio.pagar(dela.pedido_id);
  const ind = (await portaria.get('/ticket/api/operador')).json.indicacao;
  assert.deepEqual([ind.numeros.pessoas, ind.numeros.ingressos, ind.numeros.acessos], [1, 1, 0]);
  assert.deepEqual(
    ind.indicados.map((i) => i.nome),
    [bia.nome],
  );
});

test('operador logado na portaria pelo próprio link: não conta acesso nem mostra a indicação', async () => {
  const pronta = await apoio.edicaoPronta();
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const portaria = apoio.cliente(srv, { cookie: op.cookie });
  const { codigo } = (await portaria.get('/ticket/api/operador')).json.indicacao;
  const geral = await portaria.post('/ticket/api/indicacao/visita', { codigo, visitante: visitante() });
  assert.equal(geral.json.indicacao, null);
  const daEdicao = await portaria.post(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}/indicacao`, {
    codigo,
    visitante: visitante(),
  });
  assert.equal(daEdicao.json.indicacao, null);
  assert.equal((await portaria.get('/ticket/api/operador')).json.indicacao.numeros.acessos, 0);
  // Outro navegador, sem sessão, conta normalmente.
  await apoio.cliente(srv).post('/ticket/api/indicacao/visita', { codigo, visitante: visitante() });
  assert.equal((await portaria.get('/ticket/api/operador')).json.indicacao.numeros.acessos, 1);
});
