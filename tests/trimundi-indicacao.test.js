const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const indicacao = require('../src/trimundi/indicacao');
const operadores = require('../src/trimundi/operadores');

// Indicação (pedido do dono, 09/11/2026): link individual, quem indicou,
// conversões válidas (pedido pago, uma por pessoa) e recompensa enquanto
// houver. Sem níveis nem pontos.

let srv;
let admin;
test.before(async () => {
  srv = await apoio.iniciarApp();
  admin = apoio.cliente(srv, { cookie: await apoio.entrarAdmin(srv) });
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

async function campanha(pronta, extra = {}) {
  const r = await admin.post(`/admin/trimundi/edicoes/${pronta.edicao.id}/campanhas`, {
    nome: 'Indique e ganhe',
    recompensa: 'Copo personalizado',
    quantidade: 50,
    indicacoes_por_recompensa: 2,
    ...extra,
  });
  assert.equal(r.status, 201, r.texto);
  return r.json;
}

// Código de indicação de um cliente (criado ao abrir "minha conta"). A
// conta lista as campanhas ativas de TODAS as edições: `daEdicao` acha a
// deste teste.
async function codigoDe(p) {
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  const painel = await c.get('/ticket/api/conta');
  return { codigo: painel.json.indicacao.codigo, painel: painel.json, c };
}
const daEdicao = (lista, pronta) => lista.filter((x) => x.evento.startsWith(pronta.edicao.evento.nome));

// Compra paga de `p` chegando pelo `codigo`.
async function comprarPelo(pronta, p, codigo, { pagar = true } = {}) {
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), { comprador: p, indicacao: codigo });
  if (pagar) await apoio.pagar(ped.pedido_id);
  return ped;
}

test('fluxo: link na conta → amigos compram pelo link → a cada 2 pagos, 1 copo; o Admin entrega uma vez', async () => {
  const pronta = await apoio.edicaoPronta();
  const camp = await campanha(pronta);
  const ana = apoio.pessoa('Ana');
  const { codigo, painel } = await codigoDe(ana);
  assert.match(codigo, /^[A-Z2-9]{8}$/);
  assert.equal(daEdicao(painel.indicacao.campanhas, pronta).length, 1);
  assert.match(daEdicao(painel.indicacao.campanhas, pronta)[0].link, new RegExp(`\\?ind=${codigo}$`));
  assert.equal(daEdicao(painel.indicacao.campanhas, pronta)[0].faltam_para_proxima, 2);

  await comprarPelo(pronta, apoio.pessoa('Bia'), codigo);
  let ag = daEdicao((await codigoDe(ana)).painel.indicacao.campanhas, pronta)[0];
  assert.deepEqual([ag.conversoes, ag.recompensas_a_retirar, ag.faltam_para_proxima], [1, 0, 1]);

  // Pedido sem pagamento não conta.
  await comprarPelo(pronta, apoio.pessoa('Caio'), codigo, { pagar: false });
  await comprarPelo(pronta, apoio.pessoa('Duda'), codigo);
  ag = daEdicao((await codigoDe(ana)).painel.indicacao.campanhas, pronta)[0];
  assert.deepEqual([ag.conversoes, ag.recompensas_a_retirar], [2, 1]);

  const quem = await admin.get(`/admin/trimundi/campanhas/${camp.id}/indicadores`);
  assert.equal(quem.json.length, 1);
  assert.equal(quem.json[0].nome, ana.nome);
  assert.equal(quem.json[0].conversoes, 2);
  assert.equal(JSON.stringify(quem.json).includes(ana.cpf), false, 'sem CPF na lista do Admin');
  const rid = quem.json[0].recompensas[0].id;
  assert.equal((await admin.post(`/admin/trimundi/recompensas/${rid}/entregar`, {})).status, 200);
  assert.equal((await admin.post(`/admin/trimundi/recompensas/${rid}/entregar`, {})).status, 409, 'uma vez só');
  ag = daEdicao((await codigoDe(ana)).painel.indicacao.campanhas, pronta)[0];
  assert.deepEqual([ag.recompensas_a_retirar, ag.recompensas_entregues], [0, 1]);
});

test('não vale: indicar a si mesmo, a mesma pessoa duas vezes, código inexistente', async () => {
  const pronta = await apoio.edicaoPronta();
  const camp = await campanha(pronta, { indicacoes_por_recompensa: 1 });
  const ana = apoio.pessoa('Ana');
  const { codigo } = await codigoDe(ana);
  await comprarPelo(pronta, ana, codigo);
  const bia = apoio.pessoa('Bia');
  await comprarPelo(pronta, bia, codigo);
  await comprarPelo(pronta, bia, codigo);
  const semCodigo = await comprarPelo(pronta, apoio.pessoa('Caio'), 'ZZZZZZZZ');
  const { rows } = await consultar('SELECT indicador_id FROM pedidos WHERE id = $1', [semCodigo.pedido_id]);
  assert.equal(rows[0].indicador_id, null, 'código que não existe é ignorado, a compra segue');
  const [c] = await indicacao.listarCampanhas(pronta.edicao.id);
  assert.equal(c.id, camp.id);
  assert.equal(c.conversoes, 1, 'só a Bia, uma vez');
  assert.equal(c.concedidas, 1);
});

test('reembolso tira a indicação e a recompensa não entregue volta', async () => {
  const pronta = await apoio.edicaoPronta();
  await campanha(pronta, { indicacoes_por_recompensa: 1 });
  const ana = apoio.pessoa('Ana');
  const { codigo } = await codigoDe(ana);
  const ped = await comprarPelo(pronta, apoio.pessoa('Bia'), codigo);
  let [c] = await indicacao.listarCampanhas(pronta.edicao.id);
  assert.deepEqual([c.conversoes, c.concedidas], [1, 1]);
  await apoio.aplicarAviso(await apoio.aviso(ped.pedido_id, 'estornado'));
  [c] = await indicacao.listarCampanhas(pronta.edicao.id);
  assert.deepEqual([c.conversoes, c.concedidas], [0, 0]);
});

test('estoque da campanha e limite por pessoa: nunca passa do que existe', async () => {
  const pronta = await apoio.edicaoPronta();
  await campanha(pronta, { indicacoes_por_recompensa: 1, quantidade: 3, limite_por_indicador: 2 });
  const ana = apoio.pessoa('Ana');
  const leo = apoio.pessoa('Leo');
  const { codigo: ca } = await codigoDe(ana);
  const { codigo: cl } = await codigoDe(leo);
  for (const _ of [1, 2, 3]) await comprarPelo(pronta, apoio.pessoa('Amigo'), ca);
  for (const _ of [1, 2]) await comprarPelo(pronta, apoio.pessoa('Amigo'), cl);
  const [c] = await indicacao.listarCampanhas(pronta.edicao.id);
  assert.equal(c.conversoes, 5);
  assert.equal(c.concedidas, 3, 'só existem 3');
  const ag = daEdicao((await codigoDe(ana)).painel.indicacao.campanhas, pronta)[0];
  assert.equal(ag.recompensas_a_retirar, 2, 'limite de 2 por pessoa');
  assert.equal(ag.faltam_para_proxima, null, 'no limite, não há próxima');
  assert.equal(ag.restam_na_campanha, 0);
});

test('Admin: uma campanha ativa por edição; quantidade não fica abaixo do concedido', async () => {
  const pronta = await apoio.edicaoPronta();
  const a = await campanha(pronta, { indicacoes_por_recompensa: 1 });
  const outra = await admin.post(`/admin/trimundi/edicoes/${pronta.edicao.id}/campanhas`, {
    nome: 'Outra',
    recompensa: 'Boné',
    quantidade: 5,
  });
  assert.equal(outra.status, 409);
  const { codigo } = await codigoDe(apoio.pessoa('Ana'));
  await comprarPelo(pronta, apoio.pessoa('Bia'), codigo);
  await comprarPelo(pronta, apoio.pessoa('Caio'), codigo);
  assert.equal((await admin.patch(`/admin/trimundi/campanhas/${a.id}`, { quantidade: 1 })).status, 409);
  assert.equal((await admin.patch(`/admin/trimundi/campanhas/${a.id}`, { ativo: false })).status, 200);
  assert.equal(daEdicao((await codigoDe(apoio.pessoa('Ana'))).painel.indicacao.campanhas, pronta).length, 0);
});

test('operador: link próprio só quando o Admin habilita', async () => {
  const pronta = await apoio.edicaoPronta();
  await campanha(pronta, { indicacoes_por_recompensa: 1 });
  const op = await apoio.operadorLogado(srv);
  const c = apoio.cliente(srv, { cookie: op.cookie });
  assert.equal((await c.get('/ticket/api/operador')).json.indicacao, null);
  await operadores.atualizar(op.id, { indicacao_habilitada: true }, apoio.AUTOR);
  const ind = (await c.get('/ticket/api/operador')).json.indicacao;
  assert.equal(daEdicao(ind.campanhas, pronta).length, 1);
  await comprarPelo(pronta, apoio.pessoa('Bia'), ind.codigo);
  const depois = (await c.get('/ticket/api/operador')).json.indicacao;
  assert.equal(daEdicao(depois.campanhas, pronta)[0].conversoes, 1);

  // Desabilitado, o código do operador deixa de valer para pedidos novos.
  await operadores.atualizar(op.id, { indicacao_habilitada: false }, apoio.AUTOR);
  const ped = await comprarPelo(pronta, apoio.pessoa('Caio'), ind.codigo);
  const { rows } = await consultar('SELECT indicador_id FROM pedidos WHERE id = $1', [ped.pedido_id]);
  assert.equal(rows[0].indicador_id, null);
});
