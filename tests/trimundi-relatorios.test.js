const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar, emTransacao } = require('../src/trimundi/db/conexao');
const catalogo = require('../src/trimundi/catalogo');
const promocoes = require('../src/trimundi/promocoes');
const campanhas = require('../src/trimundi/campanhas');
const pagamentos = require('../src/trimundi/pagamentos');
const { conteudoDoQr } = require('../src/trimundi/lib/qr');

// Relatórios administrativos (§8): cada total é conferido contra uma
// contagem independente no banco — nenhum número estimado. Teste e
// cortesia fora das vendas; reembolso tira da conta; desconto conta o valor
// pago; combo não duplica; portaria pelo fluxo de verdade.

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

const rel = (pronta, nome, q = '') =>
  admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/relatorios/${nome}${q ? `?${q}` : ''}`);
const aplicar = (payload) => emTransacao((c) => pagamentos.aplicar(c, { evento_id: payload.eventoId, payload }));
const pagar = async (id) => aplicar(await apoio.aviso(id, 'confirmado'));

async function cenarioDeVendas() {
  const pronta = await apoio.edicaoPronta({
    lotes: [
      { preco_centavos: 10000, quantidade: 5 },
      { preco_centavos: 12000, quantidade: 50 },
    ],
  });
  const vip = await catalogo.criarTipo(
    pronta.edicao.id,
    { nome: 'VIP', lotes: [{ preco_centavos: 30000, quantidade: 10 }] },
    apoio.AUTOR,
  );
  // 3 Pista pagos (lote 1), 1 Pista reembolsado, 2 VIP pagos, 1 pendente.
  const a = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 3));
  await pagar(a.pedido_id);
  const b = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await pagar(b.pedido_id);
  await aplicar(await apoio.aviso(b.pedido_id, 'estornado'));
  const c = await apoio.novoPedido(pronta, { tipos: [{ categoria_id: vip.id, quantidade: 2 }] });
  await pagar(c.pedido_id);
  await apoio.novoPedido(pronta, { tipos: [{ categoria_id: vip.id, quantidade: 1 }] });
  // Combo de 2 Pista pago (sai do lote 1, que fica com 5 - 3 - 1(reembolsado volta? não: 1 cancelado libera) ...).
  const combo = await promocoes.criarPromocao(
    pronta.edicao.id,
    {
      nome: 'Dupla',
      preco_total_centavos: 18000,
      quantidade: 5,
      itens: [{ categoria_id: pronta.tipo.id, quantidade: 2 }],
    },
    apoio.AUTOR,
  );
  const d = await apoio.novoPedido(pronta, { combos: [{ promocao_id: combo.id, quantidade: 1 }] });
  await pagar(d.pedido_id);
  return { pronta, vip, combo };
}

test('vendas por lote e por tipo batem com a contagem independente; teste, cortesia e reembolso fora', async () => {
  const { pronta, vip } = await cenarioDeVendas();
  const r = await rel(pronta, 'vendas-lote');
  assert.equal(r.status, 200, r.texto);
  const { rows: real } = await consultar(
    `SELECT count(*)::int AS n, COALESCE(sum(i.valor_centavos), 0)::bigint AS receita
       FROM ingressos i JOIN pedidos p ON p.id = i.pedido_id
      WHERE i.edicao_id = $1 AND i.origem = 'pago' AND p.origem = 'venda' AND p.status = 'pago' AND i.status <> 'cancelado'`,
    [pronta.edicao.id],
  );
  assert.equal(r.json.totais.vendidos, real[0].n);
  assert.equal(r.json.totais.receita_centavos, Number(real[0].receita));
  assert.equal(r.json.totais.vendidos, 3 + 2 + 2, '3 Pista + 2 VIP + 2 do combo; o reembolsado não conta');
  // Soma das linhas = total (nada estimado).
  assert.equal(
    r.json.linhas.reduce((s, l) => s + l.vendidos, 0),
    r.json.totais.vendidos,
  );
  // Por tipo: VIP 2 vendidos, R$ 600,00.
  const t = (await rel(pronta, 'vendas-tipo')).json;
  const v = t.linhas.find((l) => l.tipo === 'VIP');
  assert.deepEqual([v.vendidos, v.receita_centavos], [2, 60000]);
  assert.equal(t.totais.vendidos, r.json.totais.vendidos);
  // Filtro por tipo.
  const soVip = (await rel(pronta, 'vendas-lote', `tipo=${vip.id}`)).json;
  assert.equal(soVip.linhas.length, 1);
  assert.equal(soVip.totais.vendidos, 2);
  // Cortesia e pedido de teste não entram.
  await require('../src/trimundi/emissao').emitirCortesia(
    pronta.edicao.id,
    { ...apoio.pessoa('Convidado'), categoria_id: pronta.tipo.id, classificacao: 'convidado', chave: apoio.chave() },
    apoio.AUTOR,
  );
  const pessoa = () => apoio.pessoa('Teste');
  const teste = await require('../src/trimundi/pedidos').criarTeste(
    pronta.edicao.id,
    { itens: apoio.itensDe(pronta.tipo, 1), comprador: pessoa(), participantes: [pessoa()] },
    apoio.AUTOR,
  );
  await pagar(teste.pedido_id);
  assert.equal((await rel(pronta, 'vendas-lote')).json.totais.vendidos, r.json.totais.vendidos);
});

test('disponíveis = estoque real do painel de lotes; combos com vendidos e receita', async () => {
  const { pronta } = await cenarioDeVendas();
  const d = (await rel(pronta, 'disponiveis')).json;
  const painel = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/desempenho-lotes`)).json;
  assert.equal(d.totais.disponiveis, painel.resumo.disponiveis);
  const c = (await rel(pronta, 'combos')).json;
  assert.equal(c.linhas[0].vendidos, 1);
  assert.equal(c.linhas[0].ingressos, 2);
  assert.equal(c.linhas[0].receita_centavos, 18000);
});

test('portaria: utilizados, histórico de validações e tentativas duplicadas — pelo fluxo real', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 20 }] });
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2));
  await pagar(p.pedido_id);
  const { rows: ings } = await consultar(
    `SELECT i.id, i.codigo, ed.codigo_publico FROM ingressos i JOIN edicoes ed ON ed.id = i.edicao_id
      WHERE i.pedido_id = $1 ORDER BY i.id`,
    [p.pedido_id],
  );
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const c = apoio.cliente(srv, { cookie: op.cookie });
  const ed = pronta.edicao.id;
  const qr = (i) => conteudoDoQr(i.codigo_publico, i.codigo);
  await c.post('/ticket/api/checkin/consultar', { edicao_id: ed, entrada: qr(ings[0]) });
  assert.equal((await c.post('/ticket/api/checkin/confirmar', { edicao_id: ed, ingresso_id: ings[0].id })).status, 200);
  // Lê de novo: tentativa recusada ("já utilizado").
  await c.post('/ticket/api/checkin/consultar', { edicao_id: ed, entrada: qr(ings[0]) });

  const u = (await rel(pronta, 'utilizados')).json;
  assert.equal(u.totais.total, 1);
  assert.equal(u.linhas[0].operador, op.nome);
  const v = (await rel(pronta, 'validacoes')).json;
  assert.equal(v.totais.aceitas, 1);
  assert.equal(v.totais.recusadas, 1);
  assert.equal(v.linhas.find((l) => l.resultado === 'recusado').motivo, 'já utilizado');
  const dup = (await rel(pronta, 'duplicadas')).json;
  assert.equal(dup.totais.total, 1);
  assert.equal(dup.linhas[0].primeira_entrada_por, op.nome);
  assert.ok(dup.linhas[0].primeira_entrada_em);
  // Filtros: resultado e operador.
  assert.equal((await rel(pronta, 'validacoes', 'resultado=aceito')).json.totais.total, 1);
  assert.equal((await rel(pronta, 'validacoes', `operador=${op.id}`)).json.totais.total, 2);
  // Conferência independente.
  const { rows } = await consultar('SELECT count(*)::int AS n FROM checkins WHERE edicao_id = $1', [ed]);
  assert.equal(v.totais.total, rows[0].n);

  // Teto só na tela: com o teto em 1, a tela corta; o CSV traz as 2 leituras.
  const relatorios = require('../src/trimundi/relatorios');
  const tela = await relatorios.gerar(ed, 'validacoes', {}, { limite: 1 });
  assert.equal(tela.linhas.length, 1);
  assert.equal(tela.cortado, true);
  const tudo = await relatorios.gerar(ed, 'validacoes', {}, { semLimite: true, limite: 1 });
  assert.equal(tudo.linhas.length, 2);
  assert.equal(tudo.cortado, false);
  for (const nome of ['recompensas-concedidas', 'duplicadas', 'utilizados'])
    assert.equal((await relatorios.gerar(ed, nome, {}, { semLimite: true })).cortado, false, nome);
  const csv = await admin.get(`/admin/trimundi/edicoes/${ed}/relatorios/validacoes.csv`);
  assert.equal(csv.status, 200);
  assert.equal(csv.texto.trim().split(/\r?\n/).length, 1 + 2, 'cabeçalho + 2 leituras');
});

test('recompensas concedidas, entregues e pendentes; campanhas por conversão; indicados', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 50 }] });
  const c = await campanhas.criar(
    pronta.edicao.id,
    {
      modalidade: 'ordem_compra',
      nome: 'Primeiros 2',
      regras: 'Regulamento.',
      faixas: [{ de: 1, ate: 2, premio: 'Copão' }],
    },
    apoio.AUTOR,
  );
  await campanhas.marcarRegrasRevisadas(c.id, { revisor: 'Jurídico de teste' }, apoio.AUTOR);
  await campanhas.mudarStatus(c.id, 'ativar', apoio.AUTOR);
  const ana = apoio.pessoa('Ana');
  const conta = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const { codigo } = (await conta.get('/ticket/api/conta')).json.indicacao;
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 3), { comprador: ana });
  await pagar(p.pedido_id);
  const bia = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: apoio.pessoa('Bia'),
    indicacao: codigo,
  });
  await pagar(bia.pedido_id);
  // Entrega um dos dois brindes pelo Admin.
  const { rows: pr } = await consultar('SELECT id FROM campanha_premios WHERE campanha_id = $1 ORDER BY id', [c.id]);
  await emTransacao((cl) => campanhas.entregarPremio(cl, pr[0].id, { autor: 'admin:teste', via: 'admin' }));

  const todas = (await rel(pronta, 'recompensas-concedidas')).json;
  const entregues = (await rel(pronta, 'recompensas-entregues')).json;
  const pendentes = (await rel(pronta, 'recompensas-pendentes')).json;
  assert.equal(todas.totais.total, 2);
  assert.equal(entregues.totais.total, 1);
  assert.equal(pendentes.totais.total, 1);
  assert.equal(entregues.linhas[0].entregue_por, 'Admin');
  assert.equal(todas.totais.total, entregues.totais.total + pendentes.totais.total);

  const camp = (await rel(pronta, 'campanhas')).json;
  assert.equal(camp.linhas[0].campanha, 'Primeiros 2');
  assert.equal(camp.linhas[0].resultado, 2);

  const ind = (await rel(pronta, 'indicados')).json;
  assert.equal(ind.linhas.length, 1);
  assert.equal(ind.linhas[0].indicador, ana.nome);
  assert.equal(ind.linhas[0].ingressos, 1);
  assert.ok(!JSON.stringify(ind).match(/\d{11}/), 'sem CPF');
});

test('CSV seguro, filtros validados, catálogo, relatório desconhecido e acesso só do Admin', async () => {
  const { pronta } = await cenarioDeVendas();
  const csv = await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/relatorios/vendas-lote.csv`);
  assert.equal(csv.status, 200);
  // O fetch tira o BOM ao decodificar: confere-se direto na geração.
  const gerado = require('../src/trimundi/relatorios').paraCsv({ colunas: [{ id: 'a', rotulo: 'A' }], linhas: [] });
  assert.equal(gerado.charCodeAt(0), 0xfeff, 'BOM');
  const linhas = csv.texto.trim().split('\r\n');
  assert.equal(linhas[0].replace('﻿', ''), 'Tipo;Lote;Preço;Quantidade;Vendidos;Receita;Disponíveis;Situação');
  assert.ok(
    linhas.some((l) => l.includes(';100,00;')),
    'moeda com vírgula',
  );
  assert.equal((await rel(pronta, 'nao-existe')).status, 404);
  // Nome de propriedade herdada não passa pelo catálogo (era 500).
  for (const nome of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.equal((await rel(pronta, nome)).status, 404, nome);
  assert.equal((await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/relatorios/constructor.csv`)).status, 404);
  assert.equal((await rel(pronta, 'vendas-lote', 'tipo=abc')).status, 400);
  assert.equal((await rel(pronta, 'validacoes', 'resultado=talvez')).status, 400);
  assert.equal((await rel(pronta, 'vendas-lote', 'de=2026-12-01T00:00:00Z&ate=2026-11-01T00:00:00Z')).status, 400);
  const cat = (await admin.get('/admin/trimundi/relatorios')).json;
  assert.deepEqual(
    cat.map((c) => c.numero),
    [2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  );
  const anon = apoio.cliente(srv);
  assert.notEqual((await anon.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/relatorios/vendas-lote`)).status, 200);
  // Fórmula neutralizada no nome do tipo.
  await catalogo.criarTipo(
    pronta.edicao.id,
    { nome: '=HYPERLINK("x")', lotes: [{ preco_centavos: 5000, quantidade: 1 }] },
    apoio.AUTOR,
  );
  const csv2 = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/relatorios/vendas-lote.csv`)).texto;
  assert.ok(csv2.includes(`"'=HYPERLINK(""x"")"`));
});
