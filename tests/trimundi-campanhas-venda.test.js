// Concorrência DE VERDADE: várias conexões ao mesmo tempo. Antes de qualquer conexão.
process.env.TRIMUNDI_POOL_MAX = '8';

const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar, emTransacao } = require('../src/trimundi/db/conexao');
const campanhas = require('../src/trimundi/campanhas');
const pagamentos = require('../src/trimundi/pagamentos');
const promocoes = require('../src/trimundi/promocoes');

// Campanhas — PR 4: promoção de preço em ingresso individual aplicada no
// pedido (migration 018) e as campanhas na página de venda. O preço sai do
// servidor, sob a trava da edição; a quantidade promocional nunca passa do
// limite, nem com compras simultâneas; o reprocessamento do pagamento não
// gasta de novo; reembolso segue P1; pagamento atrasado segue P5; dois
// descontos nunca se somam e o não acumulável vence o brinde (P2).

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const AUTOR = apoio.AUTOR;
const aplicar = (payload) => emTransacao((c) => pagamentos.aplicar(c, { evento_id: payload.eventoId, payload }));
const pagar = async (pedidoId, extra = {}) => aplicar(await apoio.aviso(pedidoId, 'confirmado', extra));
const estornar = async (pedidoId) => aplicar(await apoio.aviso(pedidoId, 'estornado'));

async function edicao(lotes = [{ preco_centavos: 10000, quantidade: 100 }]) {
  return apoio.edicaoPronta({ lotes });
}
async function desconto(pronta, dados = {}, { ativar = true } = {}) {
  const c = await campanhas.criar(
    pronta.edicao.id,
    {
      modalidade: 'desconto',
      nome: dados.nome || `Promo ${apoio.sufixo()}`,
      regras: 'Regulamento de teste da promoção de preço.',
      desconto_tipo: 'percentual',
      desconto_valor: 30,
      quantidade_promocional: 10,
      alvos: [{ categoria_id: pronta.tipo.id }],
      ...dados,
    },
    AUTOR,
  );
  if (!ativar) return c;
  await campanhas.marcarRegrasRevisadas(c.id, { revisor: 'Jurídico de teste' }, AUTOR);
  return campanhas.mudarStatus(c.id, 'ativar', AUTOR);
}
async function pedido(pronta, quantidade = 1, extra = {}) {
  return apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, quantidade), extra);
}
const itensDo = async (pedidoId) =>
  (
    await consultar(
      'SELECT quantidade, preco_unitario_centavos, preco_original_centavos, campanha_id FROM pedido_itens WHERE pedido_id = $1 ORDER BY ordem',
      [pedidoId],
    )
  ).rows.map((i) => ({
    q: i.quantidade,
    preco: Number(i.preco_unitario_centavos),
    original: i.preco_original_centavos === null ? null : Number(i.preco_original_centavos),
    campanha: i.campanha_id === null ? null : Number(i.campanha_id),
  }));
const usados = (c) => campanhas.usosDoDesconto({ query: (s, p) => consultar(s, p) }, c.id);
const vencer = (pedidoId) =>
  consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [pedidoId]);

test('cálculo no servidor: percentual (meio centavo para cima), valor fixo e preço promocional; o que foi pago fica no ingresso', async () => {
  // 3330 × 85% = 2830,5 → 2831 (P4).
  const pronta = await edicao([{ preco_centavos: 3330, quantidade: 50 }]);
  const pct = await desconto(pronta, { desconto_valor: 15 });
  const r = await pedido(pronta, 2);
  assert.deepEqual(await itensDo(r.pedido_id), [{ q: 2, preco: 2831, original: 3330, campanha: Number(pct.id) }]);
  assert.equal(r.total_centavos, 5662);
  assert.equal(r.cot.total_centavos, 5662, 'a prévia mostra o mesmo preço');
  assert.equal(r.cot.itens[0].preco_original_centavos, 3330);
  assert.equal(r.cot.itens[0].promocao_de_preco, pct.nome);
  const { rows: res } = await consultar('SELECT campanha_id, valor_centavos FROM reservas WHERE pedido_id = $1', [
    r.pedido_id,
  ]);
  assert.ok(res.every((x) => Number(x.campanha_id) === Number(pct.id) && Number(x.valor_centavos) === 2831));
  assert.equal(await pagar(r.pedido_id), 'aplicado');
  const { rows: ing } = await consultar('SELECT valor_centavos FROM ingressos WHERE pedido_id = $1', [r.pedido_id]);
  assert.deepEqual(
    ing.map((i) => Number(i.valor_centavos)),
    [2831, 2831],
    'o ingresso guarda o preço efetivamente pago',
  );

  for (const [tipo, valor, esperado] of [
    ['valor', 1000, 9000],
    ['preco', 7990, 7990],
  ]) {
    const p2 = await edicao();
    const c = await desconto(p2, { desconto_tipo: tipo, desconto_valor: valor });
    const r2 = await pedido(p2, 1);
    assert.deepEqual(await itensDo(r2.pedido_id), [{ q: 1, preco: esperado, original: 10000, campanha: Number(c.id) }]);
  }
});

test('o preço do navegador é ignorado: o pedido pela rota pública vale o que o servidor calcula', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { desconto_tipo: 'preco', desconto_valor: 6000 });
  const p = apoio.pessoa('Comprador');
  const conta = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  const base = { evento: pronta.slugEvento, edicao: pronta.slugEdicao };
  const cot = await conta.post('/ticket/api/cotacao', {
    ...base,
    itens: { tipos: [{ categoria_id: pronta.tipo.id, quantidade: 2, preco_unitario_centavos: 1 }] },
  });
  assert.equal(cot.status, 200, cot.texto);
  assert.equal(cot.json.total_centavos, 12000);
  const r = await conta.post('/ticket/api/pedidos', {
    ...base,
    itens: { tipos: [{ categoria_id: pronta.tipo.id, quantidade: 2, preco_unitario_centavos: 1 }] },
    total_centavos: 2,
    preco_centavos: 1,
    campanha_id: 999999,
    aceite: { aceito: true, termos: cot.json.termos.map((t) => t.id), idade: true },
    chave: apoio.chave(),
  });
  assert.equal(r.status, 201, r.texto);
  const { rows } = await consultar('SELECT total_centavos FROM pedidos WHERE id = $1', [r.json.pedido_id]);
  assert.equal(Number(rows[0].total_centavos), 12000);
  assert.deepEqual(await itensDo(r.json.pedido_id), [{ q: 2, preco: 6000, original: 10000, campanha: Number(c.id) }]);
  // O Checkout recebe o preço unitário com desconto e o total do pedido.
  const ck = await require('../src/trimundi/checkout/contrato').respostaDoPedido(r.json.pedido_id);
  assert.equal(ck.valorComDesconto, 120);
  assert.equal(ck.itens[0].valorUnitario, 60);
});

test('quantidade promocional: o que passa dela sai pelo preço do lote, na mesma compra; depois ninguém mais leva o desconto', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { quantidade_promocional: 3 });
  const r = await pedido(pronta, 5);
  assert.deepEqual(await itensDo(r.pedido_id), [
    { q: 3, preco: 7000, original: 10000, campanha: Number(c.id) },
    { q: 2, preco: 10000, original: null, campanha: null },
  ]);
  assert.equal(r.total_centavos, 3 * 7000 + 2 * 10000);
  assert.equal(await usados(c), 3);
  const outro = await pedido(pronta, 1);
  assert.deepEqual(await itensDo(outro.pedido_id), [{ q: 1, preco: 10000, original: null, campanha: null }]);
  // A vitrine diz esgotada e não promete preço.
  const ed = (await apoio.cliente(srv).get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`)).json;
  assert.equal(ed.tipos[0].promocao.situacao, 'esgotada');
  assert.equal(ed.tipos[0].promocao.preco_centavos, null);
  assert.equal(ed.tipos[0].promocao.restam, 0);
});

test('concorrência: 12 compras ao mesmo tempo, quantidade promocional 5 → exatamente 5 ingressos com desconto', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { quantidade_promocional: 5 });
  const rs = await Promise.all(Array.from({ length: 12 }, () => pedido(pronta, 1)));
  const todos = (await Promise.all(rs.map((r) => itensDo(r.pedido_id)))).flat();
  assert.equal(todos.filter((i) => i.campanha).length, 5);
  assert.equal(todos.filter((i) => !i.campanha).length, 7);
  assert.equal(await usados(c), 5);
  // Pagamentos simultâneos também não mudam a conta.
  await Promise.all(rs.map((r) => pagar(r.pedido_id)));
  assert.equal(await usados(c), 5);
  const { rows } = await consultar(
    `SELECT count(*)::int AS n FROM ingressos i JOIN reservas r ON r.id = i.reserva_id
      WHERE r.campanha_id = $1 AND i.valor_centavos = 7000`,
    [c.id],
  );
  assert.equal(rows[0].n, 5);
});

test('reprocessamento: o mesmo aviso 3 vezes (2 ao mesmo tempo) não gasta quantidade promocional de novo', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { quantidade_promocional: 4 });
  const r = await pedido(pronta, 2);
  const aviso = await apoio.aviso(r.pedido_id, 'confirmado');
  await Promise.all([aplicar(aviso), aplicar(aviso)]);
  await aplicar(aviso);
  await aplicar({ ...(await apoio.aviso(r.pedido_id, 'confirmado')) });
  assert.equal(await usados(c), 2);
  const { rows } = await consultar('SELECT count(*)::int AS n FROM ingressos WHERE pedido_id = $1', [r.pedido_id]);
  assert.equal(rows[0].n, 2);
});

test('reserva vencida devolve a unidade promocional; reembolso não devolve (P1) — e a conta volta a poder comprar (P7)', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { quantidade_promocional: 3, limite_por_pessoa: 1 });
  const a = await pedido(pronta, 1);
  assert.equal(await usados(c), 1);
  await vencer(a.pedido_id);
  assert.equal(await usados(c), 0, 'reserva vencida sem pagamento nunca foi vendida');

  const p = apoio.pessoa('Comprador');
  const b = await pedido(pronta, 2, { comprador: p });
  assert.deepEqual(await itensDo(b.pedido_id), [
    { q: 1, preco: 7000, original: 10000, campanha: Number(c.id) },
    { q: 1, preco: 10000, original: null, campanha: null },
  ]);
  await pagar(b.pedido_id);
  assert.equal(await usados(c), 1);
  await estornar(b.pedido_id);
  assert.equal(await usados(c), 1, 'P1: a unidade de ingresso reembolsado não volta');
  // A mesma conta (limite 1 por pessoa, só o que está de pé) volta a levar.
  const b2 = await pedido(pronta, 1, { comprador: p });
  assert.deepEqual(await itensDo(b2.pedido_id), [{ q: 1, preco: 7000, original: 10000, campanha: Number(c.id) }]);
  assert.equal(await usados(c), 2);
});

test('limite por pessoa pela conta compradora (C3): passa do limite, o resto sai pelo preço do lote', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { quantidade_promocional: 50, limite_por_pessoa: 2 });
  const p = apoio.pessoa('Comprador');
  const r = await pedido(pronta, 3, { comprador: p });
  assert.deepEqual(await itensDo(r.pedido_id), [
    { q: 2, preco: 7000, original: 10000, campanha: Number(c.id) },
    { q: 1, preco: 10000, original: null, campanha: null },
  ]);
  await pagar(r.pedido_id);
  const r2 = await pedido(pronta, 1, { comprador: p });
  assert.deepEqual(await itensDo(r2.pedido_id), [{ q: 1, preco: 10000, original: null, campanha: null }]);
});

test('pagamento depois da reserva vencer (P5): só com quantidade promocional e a promoção aberta; senão "pago sem vaga"', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { quantidade_promocional: 1 });
  const a = await pedido(pronta, 1);
  await vencer(a.pedido_id);
  const b = await pedido(pronta, 1);
  assert.equal((await itensDo(b.pedido_id))[0].campanha, Number(c.id), 'a unidade voltou e foi para o B');
  await pagar(b.pedido_id);
  assert.equal(await pagar(a.pedido_id), 'sem_vaga');
  const { rows } = await consultar('SELECT status FROM pedidos WHERE id = $1', [a.pedido_id]);
  assert.equal(rows[0].status, 'pago_sem_vaga');
  assert.equal(await usados(c), 1);

  // Com quantidade, mas a promoção encerrada: também não vale.
  const p2 = await edicao();
  const c2 = await desconto(p2, { quantidade_promocional: 5 });
  const d = await pedido(p2, 1);
  await vencer(d.pedido_id);
  await campanhas.mudarStatus(c2.id, 'encerrar', AUTOR);
  assert.equal(await pagar(d.pedido_id), 'sem_vaga');

  // Com quantidade e aberta: vale.
  const p3 = await edicao();
  const c3 = await desconto(p3, { quantidade_promocional: 5 });
  const e = await pedido(p3, 1);
  await vencer(e.pedido_id);
  assert.equal(await pagar(e.pedido_id), 'aplicado');
  assert.equal(await usados(c3), 1);
});

test('pausada, encerrada, fora da janela ou sem revisão: não dá desconto; a reserva viva mantém o preço combinado', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta);
  const viva = await pedido(pronta, 1);
  await campanhas.mudarStatus(c.id, 'pausar', AUTOR);
  const r = await pedido(pronta, 1);
  assert.equal((await itensDo(r.pedido_id))[0].campanha, null, 'pausada não dá desconto');
  assert.equal(await pagar(viva.pedido_id), 'aplicado', 'a reserva feita antes da pausa vale');
  const { rows } = await consultar('SELECT valor_centavos FROM ingressos WHERE pedido_id = $1', [viva.pedido_id]);
  assert.equal(Number(rows[0].valor_centavos), 7000);
  const ed = (await apoio.cliente(srv).get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`)).json;
  assert.equal(ed.tipos[0].promocao, null, 'pausada não aparece na vitrine');

  const p2 = await edicao();
  await desconto(p2, { inicio: new Date(Date.now() + 3600000).toISOString() });
  assert.equal((await itensDo((await pedido(p2, 1)).pedido_id))[0].campanha, null, 'antes do início');
  const v2 = (await apoio.cliente(srv).get(`/ticket/api/edicoes/${p2.slugEvento}/${p2.slugEdicao}`)).json;
  assert.equal(v2.tipos[0].promocao.situacao, 'em_breve');

  const p3 = await edicao();
  await desconto(p3, {}, { ativar: false });
  assert.equal((await itensDo((await pedido(p3, 1)).pedido_id))[0].campanha, null, 'rascunho');
  const v3 = (await apoio.cliente(srv).get(`/ticket/api/edicoes/${p3.slugEvento}/${p3.slugEdicao}`)).json;
  assert.equal(v3.tipos[0].promocao, null, 'sem revisão jurídica (C7) não aparece');

  const p4 = await edicao();
  const c4 = await desconto(p4, { relampago: true, fim: new Date(Date.now() + 3600000).toISOString() });
  await campanhas.mudarStatus(c4.id, 'encerrar', AUTOR);
  assert.equal((await itensDo((await pedido(p4, 1)).pedido_id))[0].campanha, null, 'encerrada');
  const v4 = (await apoio.cliente(srv).get(`/ticket/api/edicoes/${p4.slugEvento}/${p4.slugEdicao}`)).json;
  assert.equal(v4.tipos[0].promocao.situacao, 'encerrada');
  assert.equal(v4.tipos[0].promocao.preco_centavos, null, 'encerrada não promete preço');
});

test('campanhas simultâneas (P2): dois descontos não se somam — vale o menor preço; esgotado o melhor, entra o outro', async () => {
  const pronta = await edicao();
  const melhor = await desconto(pronta, { desconto_valor: 40, quantidade_promocional: 2 });
  const outra = await desconto(pronta, { desconto_valor: 20, quantidade_promocional: 10 });
  const r = await pedido(pronta, 3);
  assert.deepEqual(await itensDo(r.pedido_id), [
    { q: 2, preco: 6000, original: 10000, campanha: Number(melhor.id) },
    { q: 1, preco: 8000, original: 10000, campanha: Number(outra.id) },
  ]);
  const ed = (await apoio.cliente(srv).get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`)).json;
  assert.equal(ed.tipos[0].promocao.id, outra.id, 'a vitrine mostra a que ainda vale');
  assert.equal(ed.tipos[0].promocao.percentual, 20);
});

test('P2 com brindes: desconto não acumulável vence o brinde não acumulável (a posição fica); acumulável leva os dois', async () => {
  for (const acumula of [false, true]) {
    const pronta = await edicao();
    const d = await desconto(pronta, { acumula, quantidade_promocional: 1 });
    const brinde = await campanhas.criar(
      pronta.edicao.id,
      {
        modalidade: 'ordem_compra',
        nome: `Primeiros ${apoio.sufixo()}`,
        regras: 'Regulamento de teste.',
        faixas: [{ de: 1, ate: 10, premio: 'Copão', custo_unitario_centavos: 1500 }],
      },
      AUTOR,
    );
    await campanhas.marcarRegrasRevisadas(brinde.id, { revisor: 'Jurídico de teste' }, AUTOR);
    await campanhas.mudarStatus(brinde.id, 'ativar', AUTOR);
    const r = await pedido(pronta, 2);
    await pagar(r.pedido_id);
    const { rows: pos } = await consultar(
      `SELECT po.posicao, po.resultado, po.vencedora_id, rs.campanha_id AS desconto
         FROM campanha_posicoes po JOIN ingressos i ON i.id = po.ingresso_id JOIN reservas rs ON rs.id = i.reserva_id
        WHERE po.campanha_id = $1 ORDER BY po.posicao`,
      [brinde.id],
    );
    assert.equal(pos.length, 2, 'os dois ingressos ocupam posição (C1)');
    const comDesconto = pos.find((x) => x.desconto);
    const semDesconto = pos.find((x) => !x.desconto);
    assert.equal(semDesconto.resultado, 'premiado');
    if (acumula) assert.equal(comDesconto.resultado, 'premiado', 'acumulável: desconto + brinde');
    else {
      assert.equal(comDesconto.resultado, 'nao_acumulavel');
      assert.equal(Number(comDesconto.vencedora_id), Number(d.id));
    }
  }
});

test('combo nunca recebe a promoção de preço (2 a 20 ingressos seguem como estão)', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta);
  const combo = await promocoes.criarPromocao(
    pronta.edicao.id,
    {
      nome: 'Dupla',
      preco_total_centavos: 18000,
      quantidade: 5,
      itens: [{ categoria_id: pronta.tipo.id, quantidade: 2 }],
    },
    AUTOR,
  );
  const r = await apoio.novoPedido(pronta, {
    combos: [{ promocao_id: combo.id, quantidade: 1 }],
    tipos: [{ categoria_id: pronta.tipo.id, quantidade: 1 }],
  });
  const itens = await itensDo(r.pedido_id);
  assert.deepEqual(
    itens.map((i) => i.campanha),
    [Number(c.id), null],
  );
  assert.equal(r.total_centavos, 7000 + 18000);
  const { rows } = await consultar(
    'SELECT count(*)::int AS n FROM reservas WHERE pedido_id = $1 AND promocao_item_id IS NOT NULL AND campanha_id IS NOT NULL',
    [r.pedido_id],
  );
  assert.equal(rows[0].n, 0);
});

test('Admin: com reserva, a promoção fica "em uso" (desconto e alvos travam; quantidade só sobe); acima do estoque não ativa', async () => {
  const pronta = await edicao([{ preco_centavos: 10000, quantidade: 5 }]);
  const grande = await campanhas.criar(
    pronta.edicao.id,
    {
      modalidade: 'desconto',
      nome: 'Grande',
      regras: 'Regulamento.',
      desconto_tipo: 'percentual',
      desconto_valor: 10,
      quantidade_promocional: 6,
      alvos: [{ categoria_id: pronta.tipo.id }],
    },
    AUTOR,
  );
  await campanhas.marcarRegrasRevisadas(grande.id, { revisor: 'Jurídico de teste' }, AUTOR);
  await assert.rejects(
    campanhas.mudarStatus(grande.id, 'ativar', AUTOR),
    (e) => e.extra?.codigo === 'promocao_acima_do_estoque',
  );
  const c = await desconto(pronta, { quantidade_promocional: 3 });
  await pedido(pronta, 1);
  await assert.rejects(
    campanhas.atualizar(c.id, { desconto_valor: 50 }, AUTOR),
    (e) => e.extra?.codigo === 'campanha_em_uso',
  );
  await assert.rejects(
    campanhas.atualizar(c.id, { alvos: [{ categoria_id: pronta.tipo.id }] }, AUTOR),
    (e) => e.extra?.codigo === 'campanha_em_uso',
  );
  await assert.rejects(campanhas.atualizar(c.id, { quantidade_promocional: 2 }, AUTOR), /só pode aumentar/);
  const subiu = await campanhas.atualizar(c.id, { quantidade_promocional: 4 }, AUTOR);
  assert.equal(subiu.quantidade_promocional, 4);
  const lista = await campanhas.listar(pronta.edicao.id);
  assert.equal(lista.find((x) => Number(x.id) === Number(c.id)).usados, 1);
});

test('lote que mudou de preço depois da ativação: desconto que não baixaria o preço (ou passaria do piso) não vale', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { desconto_tipo: 'preco', desconto_valor: 8000 });
  const [lote] = pronta.tipo.lotes;
  await consultar('UPDATE lotes SET preco_centavos = 7500 WHERE id = $1', [lote.id]);
  const r = await pedido(pronta, 1);
  assert.deepEqual(await itensDo(r.pedido_id), [{ q: 1, preco: 7500, original: null, campanha: null }]);
  const ed = (await apoio.cliente(srv).get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`)).json;
  assert.equal(ed.tipos[0].promocao, null);
  assert.equal(await usados(c), 0);
});

test('vitrine: relâmpago com preço cheio, promocional, %, quanto resta e prazo; brinde de primeiros N com "restam"', async () => {
  const pronta = await edicao();
  const fim = new Date(Date.now() + 2 * 3600000).toISOString();
  await desconto(pronta, {
    nome: 'Relâmpago Pista',
    relampago: true,
    fim,
    desconto_valor: 25,
    quantidade_promocional: 8,
  });
  const brinde = await campanhas.criar(
    pronta.edicao.id,
    {
      modalidade: 'ordem_compra',
      nome: 'Primeiros 5',
      regras: 'Os 5 primeiros ingressos pagos ganham um copão.',
      faixas: [{ de: 1, ate: 5, premio: 'Copão', custo_unitario_centavos: 1500 }],
    },
    AUTOR,
  );
  const publica = async () =>
    (await apoio.cliente(srv).get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`)).json;
  assert.equal((await publica()).campanhas.length, 0, 'rascunho sem revisão não aparece');
  await campanhas.marcarRegrasRevisadas(brinde.id, { revisor: 'Jurídico de teste' }, AUTOR);
  await campanhas.mudarStatus(brinde.id, 'ativar', AUTOR);
  const r = await pedido(pronta, 2);
  await pagar(r.pedido_id);
  const ed = await publica();
  const pr = ed.tipos[0].promocao;
  assert.equal(pr.relampago, true);
  assert.equal(pr.nome, 'Relâmpago Pista');
  assert.equal(pr.preco_original_centavos, 10000);
  assert.equal(pr.preco_centavos, 7500);
  assert.equal(pr.percentual, 25);
  assert.equal(pr.restam, 6);
  assert.equal(new Date(pr.fim).toISOString(), fim);
  assert.equal(pr.regras, 'Regulamento de teste da promoção de preço.');
  assert.equal(ed.campanhas.length, 1);
  assert.equal(ed.campanhas[0].nome, 'Primeiros 5');
  assert.equal(ed.campanhas[0].restam, 3);
  assert.deepEqual(ed.campanhas[0].premios, [{ de: 1, ate: 5, premio: 'Copão', quantidade: 1 }]);
  // Nada administrativo vaza: sem quantidade promocional, usados, custo ou revisor.
  const texto = JSON.stringify(ed);
  for (const k of ['quantidade_promocional', 'custo_unitario_centavos', 'regras_revisadas_por', 'proxima_posicao']) {
    assert.ok(!texto.includes(k), k);
  }
  // Esgota o brinde: a vitrine diz esgotada.
  const r2 = await pedido(pronta, 3);
  await pagar(r2.pedido_id);
  assert.equal((await publica()).campanhas[0].situacao, 'esgotada');
  // Venda pausada: nada é oferecido.
  await require('../src/trimundi/eventos').mudarStatus(pronta.edicao.id, 'pausado', AUTOR);
  const pausada = await publica();
  assert.equal(pausada.campanhas.length, 0);
  assert.equal(pausada.tipos[0].promocao, null);
});

test('integridade pelo banco: item com desconto exige preço cheio maior e lote; combo não leva campanha', async () => {
  const pronta = await edicao();
  await desconto(pronta);
  const r = await pedido(pronta, 1);
  const { rows } = await consultar('SELECT id FROM pedido_itens WHERE pedido_id = $1', [r.pedido_id]);
  await assert.rejects(
    consultar('UPDATE pedido_itens SET preco_original_centavos = preco_unitario_centavos WHERE id = $1', [rows[0].id]),
    /pedido_itens_desconto_coerente/,
  );
  await assert.rejects(
    consultar('UPDATE pedido_itens SET preco_original_centavos = NULL WHERE id = $1', [rows[0].id]),
    /pedido_itens_desconto_coerente/,
  );
});

test('pedido sem promoção nenhuma segue igual ao de antes (campanha e preço cheio vazios)', async () => {
  const pronta = await edicao();
  const r = await pedido(pronta, 2);
  assert.deepEqual(await itensDo(r.pedido_id), [{ q: 2, preco: 10000, original: null, campanha: null }]);
  assert.equal(r.cot.itens[0].preco_original_centavos, null);
  assert.equal(r.cot.itens[0].promocao_de_preco, null);
});

test('compra que atravessa dois lotes: a mesma quantidade promocional vale para os dois, sem passar do limite', async () => {
  const pronta = await edicao([
    { preco_centavos: 10000, quantidade: 2 },
    { preco_centavos: 12000, quantidade: 50 },
  ]);
  const c = await desconto(pronta, { quantidade_promocional: 3 });
  const r = await pedido(pronta, 4);
  assert.deepEqual(await itensDo(r.pedido_id), [
    { q: 2, preco: 7000, original: 10000, campanha: Number(c.id) },
    { q: 1, preco: 8400, original: 12000, campanha: Number(c.id) },
    { q: 1, preco: 12000, original: null, campanha: null },
  ]);
  assert.equal(await usados(c), 3);
});

// ------------------------------------------------------------------ P2 e P5
// Decisões do dono de 16/11/2026: P2 com histórico de quem venceu e quem
// deixou de conceder; P5 com fila de exceções no Admin (pedido, comprador,
// valor, campanha, motivo, conciliação e histórico), sem emitir ingresso nem
// consumir estoque.

test('P2 — histórico das disputas: a promoção que valeu e a que deixou de conceder ficam gravadas (e não se apagam)', async () => {
  const pronta = await edicao();
  const melhor = await desconto(pronta, { nome: 'Melhor', desconto_valor: 40, quantidade_promocional: 5 });
  const pior = await desconto(pronta, { nome: 'Pior', desconto_valor: 20, quantidade_promocional: 5 });
  const r = await pedido(pronta, 2);
  await pagar(r.pedido_id);
  const { rows } = await consultar(
    `SELECT d.* FROM campanha_disputas d JOIN pedido_itens pi ON pi.id = d.pedido_item_id WHERE pi.pedido_id = $1`,
    [r.pedido_id],
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].vencedora_id), Number(melhor.id));
  assert.equal(Number(rows[0].preterida_id), Number(pior.id));
  assert.deepEqual([Number(rows[0].preco_vencedora_centavos), Number(rows[0].preco_preterida_centavos)], [6000, 8000]);
  await assert.rejects(consultar('DELETE FROM campanha_disputas WHERE id = $1', [rows[0].id]));
  await assert.rejects(
    consultar('UPDATE campanha_disputas SET preterida_id = vencedora_id WHERE id = $1', [rows[0].id]),
  );
  const dm = await campanhas.detalhe(melhor.id);
  assert.deepEqual(dm.disputas, [{ lado: 'venceu', outra: 'Pior', unidades: 2 }]);
  assert.equal(dm.vendas.length, 2);
  assert.ok(dm.vendas.every((v) => v.situacao === 'vendido' && Number(v.valor_centavos) === 6000));
  const dp = await campanhas.detalhe(pior.id);
  assert.deepEqual(dp.disputas, [{ lado: 'perdeu', outra: 'Melhor', unidades: 2 }]);
  // Promoção esgotada não "perde disputa": não tinha quantidade.
  const p2 = await edicao();
  await desconto(p2, { desconto_valor: 40, quantidade_promocional: 1 });
  const so = await desconto(p2, { desconto_valor: 20, quantidade_promocional: 5 });
  await pagar((await pedido(p2, 1)).pedido_id);
  const r2 = await pedido(p2, 1);
  assert.equal((await itensDo(r2.pedido_id))[0].campanha, Number(so.id));
  const { rows: d2 } = await consultar(
    'SELECT 1 FROM campanha_disputas d JOIN pedido_itens pi ON pi.id = d.pedido_item_id WHERE pi.pedido_id = $1',
    [r2.pedido_id],
  );
  assert.equal(d2.length, 0);
});

test('P2 — desconto × brinde: o detalhe do desconto mostra o brinde que deixou de sair; o do brinde, a campanha que valeu', async () => {
  const pronta = await edicao();
  const d = await desconto(pronta, { nome: 'Promo não acumulável', quantidade_promocional: 1 });
  const brinde = await campanhas.criar(
    pronta.edicao.id,
    {
      modalidade: 'ordem_compra',
      nome: 'Primeiros 10',
      regras: 'Regulamento de teste.',
      faixas: [{ de: 1, ate: 10, premio: 'Copão' }],
    },
    AUTOR,
  );
  await campanhas.marcarRegrasRevisadas(brinde.id, { revisor: 'Jurídico de teste' }, AUTOR);
  await campanhas.mudarStatus(brinde.id, 'ativar', AUTOR);
  await pagar((await pedido(pronta, 1)).pedido_id);
  const dd = await campanhas.detalhe(d.id);
  assert.deepEqual(dd.disputas, [{ lado: 'venceu_brinde', outra: 'Primeiros 10', unidades: 1 }]);
  const db = await campanhas.detalhe(brinde.id);
  assert.equal(db.posicoes[0].resultado, 'nao_acumulavel');
  assert.equal(db.posicoes[0].vencedora, 'Promo não acumulável');
});

test('P5 — fila de pagos sem vaga: motivo, campanha, valor, conciliação e histórico; nada emitido nem consumido', async () => {
  const admin = apoio.cliente(srv, { cookie: await apoio.entrarAdmin(srv) });
  const pronta = await edicao();
  const c = await desconto(pronta, { nome: 'Só uma', quantidade_promocional: 1 });
  const a = await pedido(pronta, 1);
  await vencer(a.pedido_id);
  await pagar((await pedido(pronta, 1)).pedido_id);
  assert.equal(await pagar(a.pedido_id), 'sem_vaga');
  // Reprocessar o mesmo pagamento não duplica nada.
  await pagar(a.pedido_id);
  const { rows: ing } = await consultar('SELECT count(*)::int AS n FROM ingressos WHERE pedido_id = $1', [a.pedido_id]);
  assert.equal(ing[0].n, 0, 'nenhum ingresso emitido');
  assert.equal(await usados(c), 1, 'nada consumido da quantidade promocional');

  let fila = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/sem-vaga`)).json;
  assert.equal(fila.abertos, 1);
  const item = fila.itens[0];
  assert.equal(item.pedido_id, a.pedido_id);
  assert.equal(item.motivo, 'promocao_sem_quantidade');
  assert.equal(item.campanha.nome, 'Só uma');
  assert.equal(item.total_centavos, 7000, 'o preço do pedido (com o desconto)');
  assert.ok(item.valor_recebido_centavos >= 7000, 'o que o comprador pagou, com as taxas do meio de pagamento');
  assert.equal(item.situacao, 'a_devolver');
  assert.ok(item.comprador);
  assert.ok(!JSON.stringify(fila).match(/\d{11}/), 'sem CPF');

  // Anotação do Admin entra no histórico.
  const nota = await admin.post(`/admin/trimundi/pedidos/${a.pedido_id}/sem-vaga/anotar`, {
    nota: 'Comprador avisado por e-mail.',
  });
  assert.equal(nota.status, 200, nota.texto);
  // Devolução pedida: a situação muda; confirmada pelo Checkout: devolvido.
  require('../src/trimundi/checkout/cliente').substituir({
    estornar: async () => ({ status: 202, ok: true, corpo: { status: 'processando' } }),
  });
  try {
    await require('../src/trimundi/reembolsos').solicitar(a.pedido_id, { motivo: 'pago sem vaga' }, AUTOR);
  } finally {
    require('../src/trimundi/checkout/cliente').substituir(null);
  }
  fila = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/sem-vaga`)).json;
  assert.equal(fila.itens[0].situacao, 'devolucao_solicitada');
  const acoes = fila.itens[0].historico.map((h) => h.acao);
  assert.deepEqual(acoes, ['Pagamento recebido sem vaga', 'Anotação', 'Devolução pedida']);
  assert.equal(fila.itens[0].historico[1].nota, 'Comprador avisado por e-mail.');
  assert.equal(fila.itens[0].historico[2].nota, 'pago sem vaga');
  await estornar(a.pedido_id);
  fila = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/sem-vaga`)).json;
  assert.equal(fila.itens[0].situacao, 'devolvido');
  assert.equal(fila.abertos, 0);
  assert.equal(await usados(c), 1);

  // Os outros motivos: lote e promoção encerrada.
  const p2 = await edicao([{ preco_centavos: 10000, quantidade: 1 }]);
  const b = await pedido(p2, 1);
  await vencer(b.pedido_id);
  await pagar((await pedido(p2, 1)).pedido_id);
  assert.equal(await pagar(b.pedido_id), 'sem_vaga');
  const f2 = (await admin.get(`/admin/trimundi/edicoes/${p2.edicao.id}/sem-vaga`)).json;
  assert.equal(f2.itens[0].motivo, 'lote');
  assert.equal(f2.itens[0].campanha, null);
  const p3 = await edicao();
  const c3 = await desconto(p3);
  const e = await pedido(p3, 1);
  await vencer(e.pedido_id);
  await campanhas.mudarStatus(c3.id, 'pausar', AUTOR);
  assert.equal(await pagar(e.pedido_id), 'sem_vaga');
  const f3 = (await admin.get(`/admin/trimundi/edicoes/${p3.edicao.id}/sem-vaga`)).json;
  assert.equal(f3.itens[0].motivo, 'promocao_encerrada');
  // O motivo gravado não muda (imutável) e a anotação só vale para a fila.
  await assert.rejects(consultar("UPDATE pedidos_sem_vaga SET motivo = 'lote' WHERE pedido_id = $1", [e.pedido_id]));
  const fora = await pedido(p3, 1);
  assert.equal(
    (await admin.post(`/admin/trimundi/pedidos/${fora.pedido_id}/sem-vaga/anotar`, { nota: 'teste' })).status,
    404,
  );
});

test('reembolso de UM ingresso com desconto devolve o preço pago (não o cheio); a unidade promocional não volta (P1)', async () => {
  const pronta = await edicao();
  const c = await desconto(pronta, { quantidade_promocional: 3 });
  const r = await pedido(pronta, 2);
  await pagar(r.pedido_id);
  const { rows: ings } = await consultar('SELECT id FROM ingressos WHERE pedido_id = $1 ORDER BY id', [r.pedido_id]);
  const chamadas = [];
  require('../src/trimundi/checkout/cliente').substituir({
    estornar: async (dados) => {
      chamadas.push(dados);
      return { status: 202, ok: true, corpo: { status: 'processando' } };
    },
  });
  try {
    await require('../src/trimundi/reembolsos').solicitar(
      r.pedido_id,
      { motivo: 'desistência', ingresso_id: ings[0].id },
      AUTOR,
    );
  } finally {
    require('../src/trimundi/checkout/cliente').substituir(null);
  }
  assert.equal(chamadas[0].valor, 70, 'R$ 70,00 — o preço com desconto');
  await aplicar(await apoio.aviso(r.pedido_id, 'estornado_parcialmente', { valorEstornado: 70 }));
  assert.equal(await usados(c), 2);
  const { rows } = await consultar('SELECT status FROM ingressos WHERE id = $1', [ings[0].id]);
  assert.equal(rows[0].status, 'cancelado');
});

test('P5 com espera na trava: o prazo que vence enquanto o pagamento espera vale (horário depois da trava)', async () => {
  const pronta = await edicao();
  const fim = new Date(Date.now() + 4000).toISOString();
  await desconto(pronta, { relampago: true, fim, quantidade_promocional: 5 });
  const r = await pedido(pronta, 1);
  await vencer(r.pedido_id);
  const { obterPool } = require('../src/trimundi/db/conexao');
  const segura = await obterPool().connect();
  try {
    await segura.query('BEGIN');
    await segura.query('SELECT 1 FROM edicoes WHERE id = $1 FOR UPDATE', [pronta.edicao.id]);
    // O pagamento começa ANTES do fim e fica esperando a trava da edição.
    const pagando = pagar(r.pedido_id);
    await new Promise((ok) => setTimeout(ok, Math.max(0, new Date(fim) - Date.now()) + 800));
    await segura.query('COMMIT');
    assert.equal(await pagando, 'sem_vaga', 'a promoção já tinha acabado quando a trava saiu');
  } finally {
    segura.release();
  }
  const { rows } = await consultar('SELECT motivo FROM pedidos_sem_vaga WHERE pedido_id = $1', [r.pedido_id]);
  assert.equal(rows[0].motivo, 'promocao_encerrada');
});
