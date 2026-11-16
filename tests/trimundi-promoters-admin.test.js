const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const promoters = require('../src/trimundi/promoters');

// Promoters — PR 2: Admin (rotas) e relatórios 1 e 15. Os números dos
// relatórios são conferidos contra o livro de comissões no banco.

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

async function candidato() {
  const p = apoio.pessoa('Promo');
  const conta = await apoio.contaDe(p);
  const c = await promoters.candidatar(conta.id);
  return { id: c.id, pessoa: p, conta };
}
const codigoDe = async (id) =>
  (
    await consultar(
      'SELECT ind.codigo FROM promoters pr JOIN indicadores ind ON ind.id = pr.indicador_id WHERE pr.id = $1',
      [id],
    )
  ).rows[0].codigo;
async function comprar(pronta, codigo, n) {
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, n), {
    comprador: apoio.pessoa('Comprador'),
    indicacao: codigo,
  });
  await apoio.pagar(ped.pedido_id);
  return ped;
}

test('rotas do Admin: só com sessão; aprovar, recusar com motivo, ação inválida, ficha, pagamento desligado', async () => {
  const anonimo = apoio.cliente(srv);
  assert.strictEqual((await anonimo.get('/admin/trimundi/promoters')).status, 401);
  const a = await candidato();
  const b = await candidato();
  let r = await admin.get('/admin/trimundi/promoters?situacao=candidato');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.some((p) => p.id === a.id && p.situacao === 'candidato'));
  assert.strictEqual((await admin.get('/admin/trimundi/promoters?situacao=xyz')).status, 400);

  r = await admin.post(`/admin/trimundi/promoters/${a.id}/aprovar`, {});
  assert.strictEqual(r.status, 200, r.texto);
  assert.strictEqual(r.json.situacao, 'ativo');
  assert.strictEqual(
    (await admin.post(`/admin/trimundi/promoters/${b.id}/recusar`, {})).status,
    400,
    'motivo obrigatório',
  );
  assert.strictEqual((await admin.post(`/admin/trimundi/promoters/${b.id}/recusar`, { motivo: 'perfil' })).status, 200);
  assert.strictEqual((await admin.post(`/admin/trimundi/promoters/${b.id}/aprovar`, {})).status, 409);
  assert.strictEqual((await admin.post(`/admin/trimundi/promoters/${a.id}/apagar`, {})).status, 404);

  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 3000, quantidade: 50 }] });
  await comprar(pronta, await codigoDe(a.id), 2);
  r = await admin.get(`/admin/trimundi/promoters/${a.id}?edicao=${pronta.edicao.id}`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.edicao.resumo.vendas, 2);
  assert.strictEqual(r.json.edicao.linhas.length, 2);
  assert.strictEqual(r.json.pagamentos_ligados, false);
  assert.deepStrictEqual(
    r.json.eventos.map((e) => e.acao),
    ['candidatura', 'aprovado'],
  );
  r = await admin.post(`/admin/trimundi/promoters/${a.id}/pagamentos`, {
    edicao_id: pronta.edicao.id,
    comissoes: r.json.edicao.linhas.map((l) => l.id),
    pago_em: '2026-11-20',
    meio: 'Pix',
  });
  assert.strictEqual(r.status, 409);
  assert.match(r.json.erro, /desligado/);
  // A lista com edição traz os números dela.
  r = await admin.get(`/admin/trimundi/promoters?edicao=${pronta.edicao.id}`);
  assert.strictEqual(r.json.find((p) => p.id === a.id).edicao.vendas, 2);
});

test('relatórios 1 e 15: números = livro de comissões; estorno e provisória; CSV com taxa "—"', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 2000, quantidade: 100 }] });
  const a = await candidato();
  const b = await candidato();
  await promoters.decidir(a.id, 'aprovar', {}, apoio.AUTOR);
  await promoters.decidir(b.id, 'aprovar', {}, apoio.AUTOR);
  const ca = await codigoDe(a.id);
  for (const n of [5, 5]) await comprar(pronta, ca, n); // A: 10 → oficial
  const devolver = await comprar(pronta, ca, 1); // A: 11ª
  await apoio.aplicarAviso(await apoio.aviso(devolver.pedido_id, 'estornado')); // volta a 10
  await comprar(pronta, await codigoDe(b.id), 3); // B: provisório

  const ed = pronta.edicao.id;
  const r1 = (await admin.get(`/admin/trimundi/edicoes/${ed}/relatorios/vendas-promoter`)).json;
  assert.strictEqual(r1.numero, 1);
  const la = r1.linhas.find((l) => l.promoter === a.pessoa.nome);
  const lb = r1.linhas.find((l) => l.promoter === b.pessoa.nome);
  assert.deepStrictEqual(
    [la.vendas, la.receita_centavos, la.situacao, la.percentual_atual],
    [10, 20000, 'oficial', '10%'],
  );
  assert.strictEqual(la.confirmada_centavos, 10 * 200);
  assert.strictEqual(la.estornada_centavos, 200);
  assert.deepStrictEqual([lb.vendas, lb.situacao, lb.provisoria_centavos], [3, 'provisório', 600]);
  // Conferência independente no banco.
  const { rows } = await consultar(
    `SELECT count(*)::int AS vendas, COALESCE(sum(c.base_centavos), 0)::bigint AS receita
       FROM promoter_comissoes c WHERE c.edicao_id = $1 AND c.tipo = 'venda'
        AND NOT EXISTS (SELECT 1 FROM promoter_comissoes e WHERE e.origem_id = c.id)`,
    [ed],
  );
  assert.strictEqual(r1.totais.vendas, rows[0].vendas);
  assert.strictEqual(r1.totais.receita_centavos, Number(rows[0].receita));

  const r15 = (await admin.get(`/admin/trimundi/edicoes/${ed}/relatorios/comissoes-promoter`)).json;
  assert.strictEqual(r15.numero, 15);
  assert.strictEqual(r15.linhas.length, 14, 'uma linha por venda do livro (11 + 3)');
  assert.strictEqual(r15.linhas.filter((l) => l.situacao === 'estornada').length, 1);
  assert.strictEqual(r15.linhas.filter((l) => l.situacao === 'provisória').length, 3);
  assert.ok(r15.linhas.every((l) => l.taxas === '—'));
  assert.strictEqual(r15.totais.confirmada_centavos, 2000);
  assert.strictEqual(r15.totais.provisoria_centavos, 600);
  assert.strictEqual(r15.totais.estornada_centavos, 200);

  const csv = await admin.get(`/admin/trimundi/edicoes/${ed}/relatorios/comissoes-promoter.csv`);
  assert.strictEqual(csv.status, 200);
  const linhas = csv.texto.trim().split(/\r?\n/);
  assert.strictEqual(linhas.length, 1 + 14);
  assert.match(linhas[0], /Promoter;Pedido;Ingresso/);
  assert.ok(
    linhas.slice(1).every((l) => l.includes(';—;')),
    'taxa não informada sai "—"',
  );
  // Catálogo: 14 relatórios (o 4 continua em Indicações).
  const cat = (await admin.get('/admin/trimundi/relatorios')).json;
  assert.ok(cat.some((c) => c.id === 'vendas-promoter' && c.numero === 1));
  assert.ok(cat.some((c) => c.id === 'comissoes-promoter' && c.numero === 15));
});

test('crédito de recrutamento: o Admin marca a cortesia emitida pela rota, com nota obrigatória', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 1000, quantidade: 100 }] });
  const rec = await candidato();
  await promoters.decidir(rec.id, 'aprovar', {}, apoio.AUTOR);
  const p = apoio.pessoa('Recrutado');
  const conta = await apoio.contaDe(p);
  const cand = await promoters.candidatar(conta.id, { recrutador: await codigoDe(rec.id) });
  await promoters.decidir(cand.id, 'aprovar', {}, apoio.AUTOR);
  await comprar(pronta, await codigoDe(cand.id), 10);
  const f = (await admin.get(`/admin/trimundi/promoters/${rec.id}`)).json;
  assert.strictEqual(f.creditos.length, 1);
  assert.strictEqual(f.creditos[0].situacao, 'pendente');
  assert.strictEqual(f.recrutados.length, 1);
  const cid = f.creditos[0].id;
  assert.strictEqual((await admin.post(`/admin/trimundi/promoter-creditos/${cid}/emitido`, {})).status, 400);
  const r = await admin.post(`/admin/trimundi/promoter-creditos/${cid}/emitido`, { nota: 'cortesia ABCD-2345' });
  assert.strictEqual(r.status, 200, r.texto);
  assert.strictEqual((await admin.post(`/admin/trimundi/promoter-creditos/${cid}/emitido`, { nota: 'x' })).status, 409);
});
