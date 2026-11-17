const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar, emTransacao } = require('../src/trimundi/db/conexao');
const pagamentos = require('../src/trimundi/pagamentos');
const promoters = require('../src/trimundi/promoters');

// Promoters — PR 1 (banco e motor). Só regras aprovadas (regras 3 a 9 e
// decisão B de decisoes-comerciais-2026-11-14.md). Cada número conferido
// contra o banco.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  delete process.env.TRIMUNDI_PROMOTER_PAGAMENTOS;
  await srv.fechar();
  await apoio.encerrar();
});

// Promoter aprovado: conta nova → candidatura → aprovação. Devolve o código do link.
async function promoterAtivo({ recrutador = null } = {}) {
  const p = apoio.pessoa('Promoter');
  const conta = await apoio.contaDe(p);
  const cand = await promoters.candidatar(conta.id, { recrutador });
  await promoters.decidir(cand.id, 'aprovar', {}, apoio.AUTOR);
  const { rows } = await consultar(
    'SELECT pr.id, ind.codigo FROM promoters pr JOIN indicadores ind ON ind.id = pr.indicador_id WHERE pr.id = $1',
    [cand.id],
  );
  return { id: Number(rows[0].id), codigo: rows[0].codigo, pessoa: p, conta };
}

// Compra de `n` ingressos por um comprador novo, pelo link `codigo`.
async function comprar(pronta, codigo, n = 1, { pagar = true } = {}) {
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, n), {
    comprador: apoio.pessoa('Comprador'),
    indicacao: codigo,
  });
  if (pagar) await apoio.pagar(ped.pedido_id);
  return ped;
}

const livro = async (promoterId, edicaoId) =>
  (
    await consultar('SELECT * FROM promoter_comissoes WHERE promoter_id = $1 AND edicao_id = $2 ORDER BY id', [
      promoterId,
      edicaoId,
    ])
  ).rows;

test('tabela aprovada: 10% até a 19ª venda, +1 a cada 10, teto 15%; arredondamento ao centavo, meio para cima', () => {
  const t = { 1: 10, 9: 10, 10: 10, 19: 10, 20: 11, 29: 11, 30: 12, 40: 13, 50: 14, 59: 14, 60: 15, 200: 15 };
  for (const [k, pct] of Object.entries(t))
    assert.strictEqual(promoters.percentualDaVenda(Number(k)), pct, `venda ${k}`);
  assert.throws(() => promoters.percentualDaVenda(0));
  assert.strictEqual(promoters.comissaoDe(2500, 10), 250);
  assert.strictEqual(promoters.comissaoDe(2505, 11), 276); // 275,55 → 276
  assert.strictEqual(promoters.comissaoDe(5, 10), 1); // 0,5 → 1
  assert.strictEqual(promoters.comissaoDe(14, 10), 1); // 1,4 → 1
});

test('venda pelo link do promoter entra no livro uma vez: base = valor pago, sem taxa; reaplicar o aviso não duplica', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 4000, quantidade: 50 }] });
  const pr = await promoterAtivo();
  const ped = await comprar(pronta, pr.codigo, 2);
  let l = await livro(pr.id, pronta.edicao.id);
  assert.strictEqual(l.length, 2);
  assert.deepStrictEqual(
    l.map((x) => [x.tipo, x.venda_numero, Number(x.base_centavos), Number(x.percentual), Number(x.comissao_centavos)]),
    [
      ['venda', 1, 4000, 10, 400],
      ['venda', 2, 4000, 10, 400],
    ],
  );
  assert.strictEqual(l[0].taxas_centavos, null, 'taxa não informada fica "—", nunca inventada');
  assert.strictEqual(Number(l[0].valor_bruto_pedido_centavos), 8000);
  // O mesmo aviso de novo (reentrega do Checkout): nada muda.
  const { rows: ev } = await consultar(
    "SELECT payload FROM pagamento_eventos WHERE pedido_id = $1 AND processamento = 'processado' ORDER BY id LIMIT 1",
    [ped.pedido_id],
  );
  await emTransacao((c) => pagamentos.aplicar(c, { evento_id: 'reentrega', payload: ev[0].payload }));
  await emTransacao((c) => promoters.revisarPedido(c, ped.pedido_id));
  l = await livro(pr.id, pronta.edicao.id);
  assert.strictEqual(l.length, 2);
  // Livro imutável.
  await assert.rejects(
    consultar('UPDATE promoter_comissoes SET percentual = 15 WHERE id = $1', [l[0].id]),
    /histórico/,
  );
  await assert.rejects(consultar('DELETE FROM promoter_comissoes WHERE id = $1', [l[0].id]), /histórico/);
});

test('sem retroativo: venda antes da aprovação não conta; candidato, suspenso e recusado não geram comissão', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 3000, quantidade: 50 }] });
  const p = apoio.pessoa('Candidata');
  const conta = await apoio.contaDe(p);
  // O link de indicação da conta já existe e vende antes de ela ser promoter.
  const ind = await emTransacao((c) => require('../src/trimundi/indicacao').indicadorDoCliente(c, conta.id));
  await comprar(pronta, ind.codigo, 1);
  const cand = await promoters.candidatar(conta.id);
  await comprar(pronta, ind.codigo, 1); // candidato: não conta
  assert.strictEqual((await livro(cand.id, pronta.edicao.id)).length, 0);
  await promoters.decidir(cand.id, 'aprovar', {}, apoio.AUTOR);
  await comprar(pronta, ind.codigo, 1);
  let l = await livro(cand.id, pronta.edicao.id);
  assert.strictEqual(l.length, 1, 'só a venda depois da aprovação');
  assert.strictEqual(l[0].venda_numero, 1);
  await promoters.decidir(cand.id, 'suspender', { motivo: 'teste' }, apoio.AUTOR);
  await comprar(pronta, ind.codigo, 1);
  l = await livro(cand.id, pronta.edicao.id);
  assert.strictEqual(l.length, 1, 'suspenso não ganha venda nova');
  await promoters.decidir(cand.id, 'reativar', {}, apoio.AUTOR);
  await comprar(pronta, ind.codigo, 1);
  assert.strictEqual((await livro(cand.id, pronta.edicao.id)).length, 2);
  // Transições proibidas e motivo obrigatório.
  await assert.rejects(promoters.decidir(cand.id, 'aprovar', {}, apoio.AUTOR), /Não dá para aprovar/);
  await assert.rejects(promoters.decidir(cand.id, 'suspender', {}, apoio.AUTOR), /motivo/);
  await assert.rejects(promoters.decidir(cand.id, 'constructor', {}, apoio.AUTOR), /desconhecida/);
  // Histórico imutável das decisões.
  const { rows: evs } = await consultar('SELECT acao FROM promoter_eventos WHERE promoter_id = $1 ORDER BY id', [
    cand.id,
  ]);
  assert.deepStrictEqual(
    evs.map((e) => e.acao),
    ['candidatura', 'aprovado', 'suspenso', 'reativado'],
  );
});

test('compra pelo próprio link não vira venda (a indicação da própria conta não entra no pedido)', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 3000, quantidade: 50 }] });
  const pr = await promoterAtivo();
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: pr.pessoa,
    indicacao: pr.codigo,
  });
  await apoio.pagar(ped.pedido_id);
  const { rows } = await consultar('SELECT indicador_id FROM pedidos WHERE id = $1', [ped.pedido_id]);
  assert.strictEqual(rows[0].indicador_id, null);
  assert.strictEqual((await livro(pr.id, pronta.edicao.id)).length, 0);
});

test('escada: a venda que atinge a faixa já leva o percentual novo; reembolso desconta e vira estorno no livro', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 1000, quantidade: 100 }] });
  const pr = await promoterAtivo();
  // 19 vendas (4 pedidos de 4 + 1 de 3).
  for (const n of [4, 4, 4, 4, 3]) await comprar(pronta, pr.codigo, n);
  let l = await livro(pr.id, pronta.edicao.id);
  assert.strictEqual(l.length, 19);
  assert.ok(l.every((x) => Number(x.percentual) === 10));
  // Abaixo de 10 era provisória; com 19 de pé, todas confirmadas.
  let r = await promoters.livroDaEdicao(pr.id, pronta.edicao.id);
  assert.strictEqual(r.resumo.vendas, 19);
  assert.ok(r.linhas.every((x) => x.situacao === 'confirmada'));
  assert.deepStrictEqual(r.resumo.selos, [10]);
  assert.deepStrictEqual(r.resumo.proxima_faixa, { venda: 20, percentual: 11 });
  // A 20ª venda: 11%.
  const vigesima = await comprar(pronta, pr.codigo, 1);
  l = await livro(pr.id, pronta.edicao.id);
  assert.strictEqual(l.at(-1).venda_numero, 20);
  assert.strictEqual(Number(l.at(-1).percentual), 11);
  assert.strictEqual(Number(l.at(-1).comissao_centavos), 110);
  // As anteriores não mudam (sem retroativo).
  assert.ok(l.slice(0, 19).every((x) => Number(x.percentual) === 10));
  // Reembolso da 20ª: estorno com o mesmo valor, ligado à venda.
  await apoio.aplicarAviso(await apoio.aviso(vigesima.pedido_id, 'estornado'));
  l = await livro(pr.id, pronta.edicao.id);
  const estorno = l.find((x) => x.tipo === 'estorno');
  assert.ok(estorno);
  assert.strictEqual(estorno.origem_id, l.find((x) => x.venda_numero === 20).id);
  assert.strictEqual(Number(estorno.comissao_centavos), 110);
  r = await promoters.livroDaEdicao(pr.id, pronta.edicao.id);
  assert.strictEqual(r.resumo.vendas, 19, 'reembolso desconta');
  assert.strictEqual(r.linhas.find((x) => x.venda_numero === 20).situacao, 'estornada');
  assert.strictEqual(r.resumo.comissao.estornada_centavos, 110);
  // A próxima venda é a nº 20 de novo (19 de pé): 11%.
  await comprar(pronta, pr.codigo, 1);
  l = await livro(pr.id, pronta.edicao.id);
  assert.strictEqual(l.at(-1).venda_numero, 20);
  // Reaplicar o estorno não duplica.
  await emTransacao((c) => promoters.revisarPedido(c, vigesima.pedido_id));
  assert.strictEqual((await livro(pr.id, pronta.edicao.id)).filter((x) => x.tipo === 'estorno').length, 1);
});

test('provisória abaixo de 10 vendas; contagem por edição (outra edição começa do zero)', async () => {
  const a = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 2000, quantidade: 50 }] });
  const b = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 2000, quantidade: 50 }] });
  const pr = await promoterAtivo();
  await comprar(a, pr.codigo, 9);
  let r = await promoters.livroDaEdicao(pr.id, a.edicao.id);
  assert.strictEqual(r.resumo.oficial, false);
  assert.ok(r.linhas.every((x) => x.situacao === 'provisoria'));
  assert.strictEqual(r.resumo.comissao.provisoria_centavos, 9 * 200);
  await comprar(a, pr.codigo, 1);
  r = await promoters.livroDaEdicao(pr.id, a.edicao.id);
  assert.strictEqual(r.resumo.oficial, true);
  assert.strictEqual(r.resumo.comissao.confirmada_centavos, 10 * 200);
  await comprar(b, pr.codigo, 1);
  const lb = await livro(pr.id, b.edicao.id);
  assert.strictEqual(lb[0].venda_numero, 1, 'cada edição conta do zero');
});

test('confirmações simultâneas: o número da venda nunca repete (trava da edição)', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 1500, quantidade: 50 }] });
  const pr = await promoterAtivo();
  const peds = [];
  for (let i = 0; i < 6; i++) peds.push(await comprar(pronta, pr.codigo, 1, { pagar: false }));
  const avisos = await Promise.all(peds.map((p) => apoio.aviso(p.pedido_id, 'confirmado')));
  await Promise.all(
    avisos.map((a) => emTransacao((c) => pagamentos.aplicar(c, { evento_id: a.eventoId, payload: a }))),
  );
  const l = await livro(pr.id, pronta.edicao.id);
  assert.deepStrictEqual(
    l.map((x) => x.venda_numero).sort((x, y) => x - y),
    [1, 2, 3, 4, 5, 6],
  );
});

test('recrutamento: um recrutador por pessoa; crédito quando o recrutado chega a 10, revogado se cair antes de emitir', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 1000, quantidade: 100 }] });
  const recrutador = await promoterAtivo();
  const recrutado = await promoterAtivo({ recrutador: recrutador.codigo });
  const { rows } = await consultar('SELECT recrutador_id FROM promoters WHERE id = $1', [recrutado.id]);
  assert.strictEqual(Number(rows[0].recrutador_id), recrutador.id);
  // Código de recrutamento da própria conta, ou inválido, não liga.
  const solo = apoio.pessoa('Solo');
  const cSolo = await apoio.contaDe(solo);
  const cand = await promoters.candidatar(cSolo.id, { recrutador: 'ZZZZZZZZ' });
  assert.strictEqual(cand.recrutado, false);
  // Candidatar de novo não cria outra.
  assert.strictEqual((await promoters.candidatar(cSolo.id)).novo, false);

  await comprar(pronta, recrutado.codigo, 9);
  const credito = async () =>
    (await consultar('SELECT * FROM promoter_creditos WHERE recrutado_id = $1', [recrutado.id])).rows[0];
  assert.strictEqual(await credito(), undefined);
  const decima = await comprar(pronta, recrutado.codigo, 1);
  assert.strictEqual((await credito()).situacao, 'pendente');
  assert.strictEqual(Number((await credito()).recrutador_id), recrutador.id);
  // Reembolso da 10ª antes de o Admin emitir: revogado.
  await apoio.aplicarAviso(await apoio.aviso(decima.pedido_id, 'estornado'));
  assert.strictEqual((await credito()).situacao, 'revogado');
  await assert.rejects(promoters.marcarCreditoEmitido((await credito()).id, { nota: 'x' }, apoio.AUTOR), /revogado/);
  // Volta a 10: pendente de novo (a mesma linha — uma vez por recrutado).
  await comprar(pronta, recrutado.codigo, 1);
  assert.strictEqual((await credito()).situacao, 'pendente');
  await assert.rejects(promoters.marcarCreditoEmitido((await credito()).id, {}, apoio.AUTOR), /cortesia/);
  await promoters.marcarCreditoEmitido((await credito()).id, { nota: 'cortesia ABCD-EFGH' }, apoio.AUTOR);
  assert.strictEqual((await credito()).situacao, 'emitido');
  // Emitido não volta atrás, e não há segundo crédito pelo mesmo recrutado.
  await comprar(pronta, recrutado.codigo, 5);
  const { rows: todos } = await consultar('SELECT count(*)::int AS n FROM promoter_creditos WHERE recrutado_id = $1', [
    recrutado.id,
  ]);
  assert.strictEqual(todos[0].n, 1);
  assert.strictEqual((await credito()).situacao, 'emitido');
});

test('pagamento manual: desligado até P-1/P-9; ligado, paga só confirmadas e cada venda uma vez', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 1000, quantidade: 100 }] });
  const pr = await promoterAtivo();
  await comprar(pronta, pr.codigo, 5);
  const ids = (await livro(pr.id, pronta.edicao.id)).map((x) => Number(x.id));
  const dados = {
    edicao_id: pronta.edicao.id,
    comissoes: ids,
    pago_em: '2026-11-20',
    meio: 'Pix',
    referencia: 'teste',
  };
  await assert.rejects(promoters.registrarPagamento(pr.id, dados, apoio.AUTOR), /desligado/);
  process.env.TRIMUNDI_PROMOTER_PAGAMENTOS = '1';
  try {
    await assert.rejects(promoters.registrarPagamento(pr.id, dados, apoio.AUTOR), /Só vendas confirmadas/);
    await comprar(pronta, pr.codigo, 5);
    const todas = (await livro(pr.id, pronta.edicao.id)).map((x) => Number(x.id));
    const pg = await promoters.registrarPagamento(pr.id, { ...dados, comissoes: todas.slice(0, 4) }, apoio.AUTOR);
    assert.strictEqual(pg.valor_centavos, 4 * 100);
    await assert.rejects(
      promoters.registrarPagamento(pr.id, { ...dados, comissoes: todas.slice(3, 5) }, apoio.AUTOR),
      /Só vendas confirmadas/,
    );
    const r = await promoters.livroDaEdicao(pr.id, pronta.edicao.id);
    assert.strictEqual(r.resumo.comissao.paga_centavos, 400);
    assert.strictEqual(r.resumo.comissao.confirmada_centavos, 600);
    // Venda de outro promoter não entra.
    const outro = await promoterAtivo();
    await assert.rejects(
      promoters.registrarPagamento(outro.id, { ...dados, comissoes: todas.slice(5) }, apoio.AUTOR),
      /não é deste/,
    );
  } finally {
    delete process.env.TRIMUNDI_PROMOTER_PAGAMENTOS;
  }
});

test('painel da conta: sem dado de comprador; candidato vê só a situação', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 2500, quantidade: 50 }] });
  const pr = await promoterAtivo();
  await comprar(pronta, pr.codigo, 2);
  const painel = await promoters.painelDaConta(pr.conta.id);
  const ed = painel.promoter.edicoes.find((e) => e.id === Number(pronta.edicao.id));
  assert.ok(ed);
  assert.strictEqual(ed.resumo.vendas, 2);
  assert.strictEqual(ed.vendas.length, 2);
  const texto = JSON.stringify(painel);
  assert.doesNotMatch(texto, /Comprador|@exemplo\.com|\d{11}/, 'nenhum nome, e-mail ou CPF de comprador');
  const cand = apoio.pessoa('SoCandidato');
  const c = await apoio.contaDe(cand);
  await promoters.candidatar(c.id);
  const p2 = await promoters.painelDaConta(c.id);
  assert.deepStrictEqual(Object.keys(p2.promoter).sort(), ['candidatura_em', 'codigo', 'id', 'situacao']);
  assert.strictEqual(p2.promoter.codigo, null);
  assert.deepStrictEqual(await promoters.painelDaConta(-1), { promoter: null });
});

test('aviso reprocessado depois de reativar não credita venda paga durante a suspensão', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 2000, quantidade: 50 }] });
  const pr = await promoterAtivo();
  await promoters.decidir(pr.id, 'suspender', { motivo: 'teste' }, apoio.AUTOR);
  const ped = await comprar(pronta, pr.codigo, 1); // paga durante a suspensão
  assert.strictEqual((await livro(pr.id, pronta.edicao.id)).length, 0);
  await promoters.decidir(pr.id, 'reativar', {}, apoio.AUTOR);
  // Reentrega do aviso de pagamento (ou qualquer reprocessamento do pedido).
  const { rows: ev } = await consultar(
    "SELECT payload FROM pagamento_eventos WHERE pedido_id = $1 AND processamento = 'processado' ORDER BY id LIMIT 1",
    [ped.pedido_id],
  );
  await emTransacao((c) => pagamentos.aplicar(c, { evento_id: 'reentrega-suspensao', payload: ev[0].payload }));
  await emTransacao((c) => promoters.revisarPedido(c, ped.pedido_id));
  assert.strictEqual((await livro(pr.id, pronta.edicao.id)).length, 0, 'a venda da suspensão continua fora');
});

test('reembolso ao mesmo tempo que a emissão do crédito não revoga o crédito emitido', async () => {
  const { Client } = require('pg');
  const config = require('../src/trimundi/config');
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 1000, quantidade: 100 }] });
  const recrutador = await promoterAtivo();
  const recrutado = await promoterAtivo({ recrutador: recrutador.codigo });
  await comprar(pronta, recrutado.codigo, 9);
  const decima = await comprar(pronta, recrutado.codigo, 1);
  const { rows: cr } = await consultar('SELECT id, situacao FROM promoter_creditos WHERE recrutado_id = $1', [
    recrutado.id,
  ]);
  assert.strictEqual(cr[0].situacao, 'pendente');
  // O Admin está emitindo (transação aberta, crédito travado)…
  const admin = new Client({ connectionString: config.urlDoBanco() });
  await admin.connect();
  await admin.query(`SET search_path TO ${config.ESQUEMA}`);
  await admin.query('BEGIN');
  await admin.query("UPDATE promoter_creditos SET situacao = 'emitido', nota = 'cortesia X' WHERE id = $1", [cr[0].id]);
  // …e o reembolso da 10ª venda chega ao mesmo tempo (fica esperando a trava).
  const reembolso = apoio.aplicarAviso(await apoio.aviso(decima.pedido_id, 'estornado'));
  await new Promise((r) => setTimeout(r, 300));
  await admin.query('COMMIT');
  await admin.end();
  await reembolso;
  const { rows: depois } = await consultar('SELECT situacao FROM promoter_creditos WHERE id = $1', [cr[0].id]);
  assert.strictEqual(depois[0].situacao, 'emitido', 'emitido não volta atrás');
});
