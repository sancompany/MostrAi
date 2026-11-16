const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const promoters = require('../src/trimundi/promoters');

// Promoters — PR 3: candidatura pela conta (fechada por padrão, P-8) e o
// painel do promoter na Minha Conta, sem dado de quem comprou.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  delete process.env.TRIMUNDI_PROMOTERS_CANDIDATURA;
  await srv.fechar();
  await apoio.encerrar();
});

const logado = async (p) => apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });

test('sem sessão: 401; candidatura fechada por padrão (409) e o painel não oferece', async () => {
  assert.strictEqual((await apoio.cliente(srv).get('/ticket/api/conta/promoter')).status, 401);
  assert.strictEqual((await apoio.cliente(srv).post('/ticket/api/conta/promoter', {})).status, 401);
  const c = await logado(apoio.pessoa('Fechada'));
  const r = await c.get('/ticket/api/conta/promoter');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { promoter: null, candidatura_aberta: false, links: null });
  const post = await c.post('/ticket/api/conta/promoter', {});
  assert.strictEqual(post.status, 409);
  assert.match(post.json.erro, /ainda não estão abertas/);
});

test('candidatura aberta: pede uma vez, com convite liga o recrutador; aprovado vê os links e as vendas', async () => {
  process.env.TRIMUNDI_PROMOTERS_CANDIDATURA = '1';
  try {
    // Recrutador ativo.
    const rp = apoio.pessoa('Recrutador');
    const rc = await apoio.contaDe(rp);
    const rec = await promoters.candidatar(rc.id);
    await promoters.decidir(rec.id, 'aprovar', {}, apoio.AUTOR);
    const crec = await logado(rp);
    const painelRec = (await crec.get('/ticket/api/conta/promoter')).json;
    const codigo = painelRec.promoter.codigo;
    assert.match(painelRec.links.venda, new RegExp(`/tic/eventos\\?ind=${codigo}$`));
    assert.match(painelRec.links.recrutamento, new RegExp(`/ticket/conta\\?promoter=${codigo}$`));

    // Convidado pede pelo link de recrutamento.
    const np = apoio.pessoa('Convidado');
    const c = await logado(np);
    let r = await c.post('/ticket/api/conta/promoter', { recrutador: codigo });
    assert.strictEqual(r.status, 201, r.texto);
    assert.deepStrictEqual(r.json, { situacao: 'candidato', novo: true });
    r = await c.post('/ticket/api/conta/promoter', {});
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.novo, false);
    const p = (await c.get('/ticket/api/conta/promoter')).json;
    assert.strictEqual(p.promoter.situacao, 'candidato');
    assert.strictEqual(p.links, null, 'candidato ainda não tem link');
    const { rows } = await consultar(
      'SELECT pr.recrutador_id FROM promoters pr JOIN clientes cl ON cl.id = pr.cliente_id WHERE cl.cpf = $1',
      [np.cpf.replace(/\D/g, '')],
    );
    assert.strictEqual(Number(rows[0].recrutador_id), rec.id);

    // Vendas do recrutador aparecem no painel dele, sem nada do comprador.
    const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 3000, quantidade: 50 }] });
    const comprador = apoio.pessoa('Comprador');
    const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2), { comprador, indicacao: codigo });
    await apoio.pagar(ped.pedido_id);
    const painel = (await crec.get('/ticket/api/conta/promoter')).json;
    const ed = painel.promoter.edicoes.find((e) => e.id === Number(pronta.edicao.id));
    assert.strictEqual(ed.resumo.vendas, 2);
    assert.strictEqual(ed.vendas[0].comissao_centavos, 300);
    const texto = JSON.stringify(painel);
    assert.ok(!texto.includes(comprador.nome) && !texto.includes(comprador.email), 'sem nome nem e-mail de comprador');
    assert.ok(!texto.includes(comprador.cpf.replace(/\D/g, '')), 'sem CPF de comprador');
    // Recrutado aparece só com o primeiro nome.
    assert.deepStrictEqual(painel.promoter.recrutados, [{ nome: 'Convidado', situacao: 'candidato' }]);
  } finally {
    delete process.env.TRIMUNDI_PROMOTERS_CANDIDATURA;
  }
});
