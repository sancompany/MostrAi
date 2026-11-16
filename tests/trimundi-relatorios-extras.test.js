const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const participantesSrv = require('../src/trimundi/participantes');
const lotes = require('../src/trimundi/desempenho-lotes');

// Relatórios complementares 16 a 20 (C8): participantes, reembolsos,
// financeiro, conciliação e desempenho por edição. Cada total é conferido
// contra a outra tela que mostra o mesmo número (consistência entre telas).

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

const rel = async (ed, nome) => {
  const r = await admin.get(`/admin/trimundi/edicoes/${ed}/relatorios/${nome}`);
  assert.strictEqual(r.status, 200, `${nome}: ${r.texto}`);
  return r.json;
};

test('16 a 20 batem com o resumo de Participantes e com o painel de lotes; CSV de todos', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 4000, quantidade: 30 }] });
  const ed = pronta.edicao.id;
  const a = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2));
  await apoio.pagar(a.pedido_id, { metodoPagamento: 'pix' });
  const b = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(b.pedido_id, { metodoPagamento: 'cartao' });
  await apoio.aplicarAviso(await apoio.aviso(b.pedido_id, 'estornado'));
  await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1)); // aguardando: fora de tudo
  await require('../src/trimundi/emissao').emitirCortesia(
    ed,
    { ...apoio.pessoa('Convidado'), categoria_id: pronta.tipo.id, classificacao: 'convidado', chave: apoio.chave() },
    apoio.AUTOR,
  );

  const resumo = await participantesSrv.resumo(ed);
  // 16. Participantes.
  const p16 = await rel(ed, 'participantes');
  assert.strictEqual(p16.numero, 16);
  assert.strictEqual(p16.totais.pagos, resumo.ingressos_pagos);
  assert.strictEqual(p16.totais.cortesias, resumo.cortesias);
  assert.strictEqual(p16.totais.entradas, resumo.entradas);
  assert.ok(!JSON.stringify(p16).match(/@exemplo\.com/), 'sem e-mail');

  // 17. Reembolsos: o estorno de B.
  const p17 = await rel(ed, 'reembolsos');
  assert.strictEqual(p17.totais.confirmado_centavos, resumo.reembolsado_centavos);
  assert.strictEqual(p17.totais.confirmado_centavos, 4000);

  // 18. Financeiro: recebido, reembolsado e líquido = resumo; por meio.
  const p18 = await rel(ed, 'financeiro');
  assert.strictEqual(p18.totais.recebido_centavos, resumo.receita_confirmada_centavos);
  assert.strictEqual(p18.totais.reembolsado_centavos, resumo.reembolsado_centavos);
  assert.strictEqual(p18.totais.liquido_centavos, resumo.receita_liquida_centavos);
  assert.deepStrictEqual(p18.linhas.map((l) => l.meio).sort(), ['cartao', 'pix']);
  const pix = p18.linhas.find((l) => l.meio === 'pix');
  assert.strictEqual(pix.recebido_centavos, 8000);
  assert.strictEqual(pix.taxas, '1,49', 'cobrado − recebido, como o Checkout informou');

  // 19. Conciliação: os dois pedidos que receberam aviso.
  const p19 = await rel(ed, 'conciliacao');
  assert.strictEqual(p19.totais.total, 2);
  const linhaB = p19.linhas.find((l) => l.pedido === b.pedido_id.slice(0, 8).toUpperCase());
  assert.strictEqual(linhaB.pedido_status, 'estornado');
  assert.strictEqual(linhaB.avisos, 2);
  assert.strictEqual(p19.totais.atencao, 0);

  // 20. Desempenho por edição: os números do painel de lotes e da receita do relatório 2.
  const p20 = await rel(ed, 'desempenho-edicoes');
  const nome = `${pronta.edicao.evento.nome} — ${pronta.edicao.nome}`;
  const linha = p20.linhas.find((l) => l.edicao === nome);
  assert.ok(linha, 'a edição aparece');
  const painel = (await lotes.painel(ed)).resumo;
  assert.strictEqual(linha.vendidos, painel.vendidos);
  assert.strictEqual(linha.capacidade, painel.capacidade);
  assert.strictEqual(linha.cortesias, painel.cortesias);
  const p2 = await rel(ed, 'vendas-lote');
  assert.strictEqual(linha.receita_centavos, p2.totais.receita_centavos);
  assert.strictEqual(linha.receita_centavos, 8000);

  for (const n of ['participantes', 'reembolsos', 'financeiro', 'conciliacao', 'desempenho-edicoes']) {
    const csv = await admin.get(`/admin/trimundi/edicoes/${ed}/relatorios/${n}.csv`);
    assert.strictEqual(csv.status, 200, n);
    assert.ok(csv.texto.trim().split(/\r?\n/).length >= 2, `${n}: cabeçalho + linhas`);
  }
  assert.strictEqual((await apoio.cliente(srv).get(`/admin/trimundi/edicoes/${ed}/relatorios/financeiro`)).status, 401);
});
