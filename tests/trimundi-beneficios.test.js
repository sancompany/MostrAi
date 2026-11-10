const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const catalogo = require('../src/trimundi/catalogo');

// Benefício do ingresso (pedido do dono, 09/11/2026): o Admin diz qual
// benefício um lote dá e quantos existem; o ingresso nasce com ele enquanto
// houver; a entrega é registrada na portaria uma vez só.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

async function edicaoComCopao(quantidade = 2) {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 20 }] });
  const copao = await catalogo.criarBeneficio(
    pronta.edicao.id,
    { nome: 'Copão personalizado', quantidade },
    apoio.AUTOR,
  );
  const [lote] = pronta.tipo.lotes;
  await catalogo.atualizarTipo(
    pronta.tipo.id,
    { lotes: [{ id: lote.id, preco_centavos: 5000, quantidade: 20, beneficio_id: copao.id }] },
    apoio.AUTOR,
  );
  return { pronta, copao };
}

async function comprarUm(pronta) {
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(p.pedido_id);
  const { rows } = await consultar(
    `SELECT i.id, i.status, COALESCE(json_agg(ib.nome) FILTER (WHERE ib.nome IS NOT NULL), '[]') AS beneficios
       FROM ingressos i LEFT JOIN ingresso_beneficios ib ON ib.ingresso_id = i.id
      WHERE i.pedido_id = $1 GROUP BY i.id`,
    [p.pedido_id],
  );
  return rows[0];
}

test('lote com benefício: o ingresso nasce com ele enquanto houver; a página mostra e depois esconde', async () => {
  const { pronta, copao } = await edicaoComCopao(2);
  const vitrine = async () =>
    (await apoio.cliente(srv).get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`)).json.tipos[0];
  assert.deepEqual((await vitrine()).beneficio_do_lote, { nome: 'Copão personalizado', restam: 2 });

  const a = await comprarUm(pronta);
  const b = await comprarUm(pronta);
  const c = await comprarUm(pronta);
  assert.deepEqual(a.beneficios, ['Copão personalizado']);
  assert.deepEqual(b.beneficios, ['Copão personalizado']);
  assert.deepEqual(c.beneficios, [], 'acabou o estoque: o ingresso sai sem o benefício');
  assert.equal((await vitrine()).beneficio_do_lote, null);

  const [lista] = (await catalogo.listarBeneficios(pronta.edicao.id)).filter((x) => x.id === copao.id);
  assert.deepEqual(
    { concedidos: lista.concedidos, restam: lista.restam, resgatados: lista.resgatados },
    { concedidos: 2, restam: 0, resgatados: 0 },
  );

  // Ingresso cancelado (sem entrega) devolve a unidade para o próximo.
  await consultar("UPDATE ingressos SET status = 'cancelado' WHERE id = $1", [a.id]);
  const d = await comprarUm(pronta);
  assert.deepEqual(d.beneficios, ['Copão personalizado']);

  await assert.rejects(
    catalogo.atualizarBeneficio(copao.id, { quantidade: 1 }, apoio.AUTOR),
    (err) => err.status === 409 && /abaixo do que já foi dado/.test(err.message),
  );
});

test('benefício de outra edição não entra no lote', async () => {
  const { pronta } = await edicaoComCopao(5);
  const outra = await edicaoComCopao(5);
  const [lote] = pronta.tipo.lotes;
  await assert.rejects(
    catalogo.atualizarTipo(
      pronta.tipo.id,
      { lotes: [{ id: lote.id, preco_centavos: 5000, quantidade: 20, beneficio_id: outra.copao.id }] },
      apoio.AUTOR,
    ),
    (err) => err.status === 400,
  );
});

test('entrega na portaria: uma vez só, mesmo com dois operadores ao mesmo tempo', async () => {
  const { pronta, copao } = await edicaoComCopao(10);
  const ing = await comprarUm(pronta);
  const op = await apoio.operadorLogado(srv);
  const c1 = apoio.cliente(srv, { cookie: op.cookie });
  const c2 = apoio.cliente(srv, { cookie: op.cookie });
  const corpo = { edicao_id: pronta.edicao.id, ingresso_id: ing.id, beneficio_id: copao.id };

  const consulta = await c1.post('/ticket/api/checkin/consultar', {
    edicao_id: pronta.edicao.id,
    entrada: (await consultar('SELECT codigo_curto FROM ingressos WHERE id = $1', [ing.id])).rows[0].codigo_curto,
  });
  assert.deepEqual(
    consulta.json.ingresso.beneficios.map((b) => [b.id, b.nome, b.resgatado_em]),
    [[copao.id, 'Copão personalizado', null]],
  );

  const [x, y] = await Promise.all([
    c1.post('/ticket/api/checkin/beneficio', corpo),
    c2.post('/ticket/api/checkin/beneficio', corpo),
  ]);
  assert.deepEqual([x.json.resultado, y.json.resultado].sort(), ['ja_resgatado', 'resgatado']);
  const { rows } = await consultar(
    'SELECT resgatado_em, resgatado_por FROM ingresso_beneficios WHERE ingresso_id = $1 AND beneficio_id = $2',
    [ing.id, copao.id],
  );
  assert.ok(rows[0].resgatado_em);
  assert.equal(rows[0].resgatado_por, `operador:${op.id}`);
  const depois = await c1.post('/ticket/api/checkin/consultar', {
    edicao_id: pronta.edicao.id,
    entrada: (await consultar('SELECT codigo_curto FROM ingressos WHERE id = $1', [ing.id])).rows[0].codigo_curto,
  });
  assert.ok(depois.json.ingresso.beneficios[0].resgatado_em);
  assert.equal(depois.json.ingresso.beneficios[0].resgatado_por, op.nome);

  // Na conta do cliente aparece como resgatado.
  const [lista] = (await catalogo.listarBeneficios(pronta.edicao.id)).filter((b) => b.id === copao.id);
  assert.equal(lista.resgatados, 1);
});

test('entrega recusada: ingresso cancelado, ingresso sem o benefício, sem sessão de operador', async () => {
  const { pronta, copao } = await edicaoComCopao(10);
  const ing = await comprarUm(pronta);
  const op = await apoio.operadorLogado(srv);
  const c = apoio.cliente(srv, { cookie: op.cookie });
  const outro = await catalogo.criarBeneficio(pronta.edicao.id, { nome: 'Pulseira' }, apoio.AUTOR);
  const sem = await c.post('/ticket/api/checkin/beneficio', {
    edicao_id: pronta.edicao.id,
    ingresso_id: ing.id,
    beneficio_id: outro.id,
  });
  assert.equal(sem.status, 404);
  assert.equal(
    (
      await apoio.cliente(srv).post('/ticket/api/checkin/beneficio', {
        edicao_id: pronta.edicao.id,
        ingresso_id: ing.id,
        beneficio_id: copao.id,
      })
    ).status,
    401,
  );
  await consultar("UPDATE ingressos SET status = 'cancelado' WHERE id = $1", [ing.id]);
  const cancelado = await c.post('/ticket/api/checkin/beneficio', {
    edicao_id: pronta.edicao.id,
    ingresso_id: ing.id,
    beneficio_id: copao.id,
  });
  assert.equal(cancelado.status, 409);
});
