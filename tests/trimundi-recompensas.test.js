const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const catalogo = require('../src/trimundi/catalogo');
const indicacao = require('../src/trimundi/indicacao');
const { consultar } = require('../src/trimundi/db/conexao');

// Admin → Eventos → Recompensas (§9): recompensas de indicação uma a uma
// (a retirar, entregue — quando e por quem —, revogada) e benefícios dos
// ingressos por tipo (total, retirados, a retirar). Só o Admin vê.

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

test('recompensas da edição: a retirar, entregue pela portaria (com nome), revogada; benefícios por tipo', async () => {
  const pronta = await apoio.edicaoPronta();
  const copao = await catalogo.criarBeneficio(pronta.edicao.id, { nome: 'Copão' }, apoio.AUTOR);
  await catalogo.atualizarTipo(pronta.tipo.id, { beneficios: [copao.id] }, apoio.AUTOR);
  await indicacao.criarCampanha(
    pronta.edicao.id,
    { nome: 'Indique', recompensa: 'Pulseira VIP', quantidade: 10, indicacoes_por_recompensa: 1 },
    apoio.AUTOR,
  );
  const rota = `/admin/trimundi/edicoes/${pronta.edicao.id}/recompensas`;
  assert.equal((await apoio.cliente(srv).get(rota)).status, 401, 'só o Admin');

  // Ana indica Bia e Caio (as duas pagas); a compra do Caio é reembolsada.
  const ana = apoio.pessoa('Ana');
  const conta = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const { codigo } = (await conta.get('/ticket/api/conta')).json.indicacao;
  const dela = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: ana,
    participantes: [{ conta: true }],
  });
  await apoio.pagar(dela.pedido_id);
  for (const nome of ['Bia', 'Caio']) {
    const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
      comprador: apoio.pessoa(nome),
      indicacao: codigo,
    });
    await apoio.pagar(p.pedido_id);
    if (nome === 'Caio') await apoio.aplicarAviso(await apoio.aviso(p.pedido_id, 'estornado'));
  }

  let d = (await admin.get(rota)).json;
  assert.deepEqual(d.indicacao.totais, { a_retirar: 1, entregues: 0, revogadas: 1, expiradas: 0 });
  assert.equal(d.indicacao.itens_cortados, false);
  // Lista cortada: os totais continuam contando todas (revisão do Codex no #152).
  const cortada = await require('../src/trimundi/recompensas').daEdicao(pronta.edicao.id, { limite: 1 });
  assert.equal(cortada.indicacao.itens.length, 1);
  assert.equal(cortada.indicacao.itens[0].status, 'concedida', 'a retirar vem antes');
  assert.deepEqual(cortada.indicacao.totais, { a_retirar: 1, entregues: 0, revogadas: 1, expiradas: 0 });
  assert.equal(cortada.indicacao.itens_cortados, true);
  assert.equal(d.indicacao.itens[0].status, 'concedida', 'a retirar primeiro');
  assert.equal(d.indicacao.itens[0].indicador, ana.nome);
  assert.equal(d.indicacao.itens[0].recompensa, 'Pulseira VIP');
  // Copão: Ana e Bia têm (o do Caio foi cancelado no reembolso).
  assert.deepEqual(
    d.beneficios.map((b) => [b.nome, b.total, b.entregues, b.pendentes]),
    [['Copão', 2, 0, 2]],
  );

  // A portaria entrega a recompensa e o copão da Ana.
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const portaria = apoio.cliente(srv, { cookie: op.cookie });
  const { rows } = await consultar('SELECT codigo_curto FROM ingressos WHERE pedido_id = $1', [dela.pedido_id]);
  const lido = (
    await portaria.post('/ticket/api/checkin/consultar', { edicao_id: pronta.edicao.id, entrada: rows[0].codigo_curto })
  ).json.ingresso;
  await portaria.post('/ticket/api/checkin/recompensa', {
    edicao_id: pronta.edicao.id,
    ingresso_id: lido.id,
    recompensa_id: lido.recompensas_indicacao[0].id,
  });
  await portaria.post('/ticket/api/checkin/beneficio', {
    edicao_id: pronta.edicao.id,
    ingresso_id: lido.id,
    beneficio_id: lido.beneficios[0].id,
  });
  d = (await admin.get(rota)).json;
  assert.deepEqual(d.indicacao.totais, { a_retirar: 0, entregues: 1, revogadas: 1, expiradas: 0 });
  const entregue = d.indicacao.itens.find((r) => r.status === 'entregue');
  assert.equal(entregue.entregue_por, op.nome, 'quem entregou, pelo nome');
  assert.ok(entregue.entregue_em);
  assert.deepEqual(
    d.beneficios.map((b) => [b.total, b.entregues, b.pendentes]),
    [[2, 1, 1]],
  );
  assert.equal(JSON.stringify(d).includes(ana.cpf), false, 'sem CPF');
});

test('recompensa de operador indicador: só pelo Admin — a portaria não mostra nem entrega', async () => {
  const pronta = await apoio.edicaoPronta();
  await indicacao.criarCampanha(
    pronta.edicao.id,
    { nome: 'Indique', recompensa: 'Copão', quantidade: 10, indicacoes_por_recompensa: 1 },
    apoio.AUTOR,
  );
  // Operador ligado à própria conta TICK, com um ingresso PAGO dele também.
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const portaria = apoio.cliente(srv, { cookie: op.cookie });
  const { codigo } = (await portaria.get('/ticket/api/operador')).json.indicacao;
  const amigo = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: apoio.pessoa('Amigo'),
    indicacao: codigo,
  });
  await apoio.pagar(amigo.pedido_id);
  const d = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/recompensas`)).json;
  const [r] = d.indicacao.itens;
  assert.deepEqual([r.tipo, r.status, r.entrega], ['operador', 'concedida', 'so_admin']);

  // Nenhum ingresso da edição mostra essa recompensa na portaria, e a rota da
  // portaria não a entrega.
  const { rows } = await consultar('SELECT id, codigo_curto FROM ingressos WHERE edicao_id = $1', [pronta.edicao.id]);
  for (const i of rows) {
    const lido = (
      await portaria.post('/ticket/api/checkin/consultar', { edicao_id: pronta.edicao.id, entrada: i.codigo_curto })
    ).json.ingresso;
    assert.deepEqual(lido.recompensas_indicacao, []);
    const tentou = await portaria.post('/ticket/api/checkin/recompensa', {
      edicao_id: pronta.edicao.id,
      ingresso_id: i.id,
      recompensa_id: r.id,
    });
    assert.ok([404, 409].includes(tentou.status), `portaria não entrega (${tentou.status})`);
  }
  // O Admin entrega, com auditoria.
  assert.equal((await admin.post(`/admin/trimundi/recompensas/${r.id}/entregar`, {})).status, 200);
  const depois = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/recompensas`)).json.indicacao.itens[0];
  assert.equal(depois.status, 'entregue');
  assert.equal(depois.entregue_por, 'Admin');
});
