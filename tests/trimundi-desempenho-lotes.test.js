const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const catalogo = require('../src/trimundi/catalogo');
const promocoes = require('../src/trimundi/promocoes');
const emissao = require('../src/trimundi/emissao');
const lotes = require('../src/trimundi/desempenho-lotes');

// "DESEMPENHO DE VENDAS — LOTES DO EVENTO" (§7; decisões do dono de
// 14/11/2026, itens D e E): só pago conta como vendido, combo não duplica,
// cortesia fora das barras, capacidade = soma dos lotes dos tipos ativos,
// sobra de lote encerrado não migra, cores e alertas configuráveis.

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

async function vender(pronta, quantidade, { pagar = true } = {}) {
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, quantidade));
  if (pagar) await apoio.pagar(p.pedido_id);
  return p;
}
const painel = async (pronta) => (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/desempenho-lotes`)).json;

test('só pago conta: pendente vira reserva ativa; combo não duplica; cortesia fica fora das barras', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 20 }] });
  // 12 avulsos pagos, 2 pendentes.
  for (const q of [5, 5, 2]) await vender(pronta, q);
  await vender(pronta, 2, { pagar: false });
  // 1 combo de 2 pago: 2 ingressos, não 3 (nem 4).
  const combo = await promocoes.criarPromocao(
    pronta.edicao.id,
    {
      nome: 'Dupla',
      preco_total_centavos: 9000,
      quantidade: 5,
      itens: [{ categoria_id: pronta.tipo.id, quantidade: 2 }],
    },
    apoio.AUTOR,
  );
  const comCombo = await apoio.novoPedido(pronta, { combos: [{ promocao_id: combo.id, quantidade: 1 }] });
  await apoio.pagar(comCombo.pedido_id);
  await emissao.emitirCortesia(
    pronta.edicao.id,
    { ...apoio.pessoa('Convidado'), categoria_id: pronta.tipo.id, classificacao: 'convidado', chave: apoio.chave() },
    apoio.AUTOR,
  );

  const d = await painel(pronta);
  const [l] = d.lotes;
  assert.deepEqual([l.quantidade, l.vendidos, l.reservados, l.disponiveis], [20, 14, 2, 4]);
  assert.equal(l.percentual, 70);
  assert.equal(l.cor, 'amarelo', '70% é amarelo');
  assert.equal(l.esgotado, false);
  assert.equal(l.alerta, null, 'nenhum alerta abaixo de 80%');
  assert.deepEqual(
    [d.resumo.capacidade, d.resumo.vendidos, d.resumo.cortesias, d.resumo.reservas_ativas, d.resumo.disponiveis],
    [20, 14, 1, 2, 4],
  );
  assert.equal(d.resumo.percentual, 70);
  assert.deepEqual(d.alertas, []);
});

test('cores e alertas padrão: 80 / 90 / 95 / 100 e "LOTE ESGOTADO" só com tudo pago', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 20 }] });
  const passos = [
    [16, 80, 'amarelo', 80],
    [2, 90, 'laranja', 90],
    [1, 95, 'laranja', 95],
  ];
  for (const [q, p, cor, alerta] of passos) {
    await vender(pronta, q);
    const [l] = (await painel(pronta)).lotes;
    assert.deepEqual([l.percentual, l.cor, l.alerta, l.esgotado], [p, cor, alerta, false], `${p}%`);
  }
  // O último ingresso pendente: ainda não é 100%.
  const ultimo = await vender(pronta, 1, { pagar: false });
  let d = await painel(pronta);
  assert.deepEqual([d.lotes[0].percentual, d.lotes[0].esgotado], [95, false], 'pendente não fecha o lote');
  await apoio.pagar(ultimo.pedido_id);
  d = await painel(pronta);
  assert.deepEqual(
    [d.lotes[0].percentual, d.lotes[0].cor, d.lotes[0].alerta, d.lotes[0].esgotado],
    [100, 'vermelho', 100, true],
  );
  assert.equal(d.alertas.length, 1);
  assert.equal(d.alertas[0].esgotado, true);
  assert.equal(d.resumo.disponiveis, 0);
});

test('capacidade = soma dos lotes dos tipos ativos; sobra de lote encerrado não migra; cancelamento e reembolso', async () => {
  const pronta = await apoio.edicaoPronta({
    lotes: [
      { preco_centavos: 5000, quantidade: 10 },
      { preco_centavos: 6000, quantidade: 10 },
    ],
  });
  await vender(pronta, 4);
  // Encerra o 1º lote com 6 sobrando: não passam para o 2º.
  const [primeiro] = (await catalogo.listarTipos(pronta.edicao.id))[0].lotes;
  await catalogo.encerrarLote(primeiro.id, apoio.AUTOR);
  const doSegundo = await vender(pronta, 3);
  // Um tipo inativo não entra na capacidade.
  await catalogo.criarTipo(
    pronta.edicao.id,
    { nome: 'Camarote', ativo: false, lotes: [{ preco_centavos: 9000, quantidade: 50 }] },
    apoio.AUTOR,
  );
  let d = await painel(pronta);
  const pista = d.lotes.filter((l) => l.tipo === 'Pista');
  assert.deepEqual(
    pista.map((l) => [l.numero, l.vendidos, l.disponiveis, l.sobra, l.situacao]),
    [
      [1, 4, 0, 6, 'encerrado'],
      [2, 3, 7, 0, 'a_venda'],
    ],
  );
  assert.equal(d.resumo.capacidade, 20, 'só os lotes dos tipos ativos');
  assert.equal(d.resumo.sobra_em_lotes_encerrados, 6);
  assert.equal(d.resumo.disponiveis, 7);
  assert.equal(d.resumo.percentual, 35);
  assert.equal(d.lotes.find((l) => l.tipo === 'Camarote').tipo_ativo, false);

  // Reembolso do pedido do 2º lote: sai do vendido e conta como reembolso.
  const r = await admin.post(`/admin/trimundi/pedidos/${doSegundo.pedido_id}/reembolsos`, {
    motivo: 'Pedido do comprador',
    chave: apoio.chave(),
  });
  assert.ok([200, 201].includes(r.status), r.texto);
  const { rows } = await consultar('SELECT status FROM reembolsos WHERE pedido_id = $1', [doSegundo.pedido_id]);
  if (rows[0]?.status !== 'confirmado') {
    await apoio.aplicarAviso(await apoio.aviso(doSegundo.pedido_id, 'estornado'));
  }
  d = await painel(pronta);
  const segundo = d.lotes.find((l) => l.tipo === 'Pista' && l.numero === 2);
  assert.equal(segundo.vendidos, 0, 'reembolsado não é vendido');
  assert.equal(d.resumo.cancelamentos, 3, 'os 3 ingressos reembolsados ficam cancelados');
  assert.equal(d.resumo.reembolsos, 1);
});

test('configuração por edição: valida, salva com auditoria e volta ao padrão; só o Admin', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 10 }] });
  await vender(pronta, 6);
  const rota = `/admin/trimundi/edicoes/${pronta.edicao.id}/desempenho-lotes`;
  assert.equal((await apoio.cliente(srv).get(rota)).status, 401, 'sem sessão do Admin');
  let d = await painel(pronta);
  assert.deepEqual(d.config, {
    ...lotes.PADRAO,
    cores: { ...lotes.PADRAO.cores },
    alertas: [...lotes.PADRAO.alertas],
    padrao: true,
  });
  assert.equal(d.lotes[0].cor, 'verde', '60% é verde no padrão');

  for (const ruim of [
    { cores: { amarelo: 90, laranja: 70 }, alertas: [50] },
    { cores: { amarelo: 50, laranja: 100 }, alertas: [50] },
    { cores: { amarelo: 50, laranja: 80 }, alertas: [10, 20, 30, 40, 50, 60, 70] },
    { cores: { amarelo: 50, laranja: 80 }, alertas: [0] },
  ]) {
    assert.equal((await admin.post(`${rota}/config`, ruim)).status, 400, JSON.stringify(ruim));
  }
  const ok = await admin.post(`${rota}/config`, { cores: { amarelo: 50, laranja: 80 }, alertas: [60, 50, 60] });
  assert.equal(ok.status, 200, ok.texto);
  assert.deepEqual(ok.json.alertas, [50, 60], 'sem repetição, em ordem');
  d = await painel(pronta);
  assert.deepEqual([d.lotes[0].cor, d.lotes[0].alerta, d.config.padrao], ['amarelo', 60, false]);
  assert.equal(d.alertas.length, 1);

  await admin.post(`${rota}/config`, { padrao: true });
  d = await painel(pronta);
  assert.equal(d.config.padrao, true);
  assert.equal(d.lotes[0].cor, 'verde');
  const { rows } = await consultar(
    `SELECT count(*)::int AS n FROM auditoria WHERE acao = 'monitor_lotes_alterado' AND entidade_id = $1`,
    [String(pronta.edicao.id)],
  );
  assert.equal(rows[0].n, 2);
});
