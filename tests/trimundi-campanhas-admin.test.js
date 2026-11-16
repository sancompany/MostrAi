process.env.TRIMUNDI_POOL_MAX = '8';

const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar, emTransacao } = require('../src/trimundi/db/conexao');
const pagamentos = require('../src/trimundi/pagamentos');
const catalogo = require('../src/trimundi/catalogo');

// Campanhas — PR 2 (Admin → Campanhas), pelas rotas do Admin: cadastro e
// edição das três modalidades (promoção de preço em ingresso individual,
// primeiros N, indicação), validações contra configurações contraditórias,
// C7 (regulamento revisado antes de ativar), travas de justiça com a
// campanha em uso, duplicar/pausar/retomar/encerrar, detalhe e CSV. O
// desconto no pedido tem o próprio arquivo (trimundi-campanhas-venda).

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

const aplicar = (payload) => emTransacao((c) => pagamentos.aplicar(c, { evento_id: payload.eventoId, payload }));
const pagar = async (pedidoId) => aplicar(await apoio.aviso(pedidoId, 'confirmado'));
async function edicao() {
  return apoio.edicaoPronta({
    lotes: [
      { preco_centavos: 10000, quantidade: 50 },
      { preco_centavos: 12000, quantidade: 50 },
    ],
  });
}
const nova = (pronta, corpo) => admin.post(`/admin/trimundi/edicoes/${pronta.edicao.id}/campanhas/nova`, corpo);
const acao = (id, a) => admin.post(`/admin/trimundi/campanhas/${id}/acao/${a}`, {});
const configurar = (id, corpo) => admin.post(`/admin/trimundi/campanhas/${id}/configurar`, corpo);
const revisar = (id) => admin.post(`/admin/trimundi/campanhas/${id}/regras-revisadas`, { revisor: 'Escritório Teste' });
const ordem = (extra = {}) => ({
  modalidade: 'ordem_compra',
  nome: 'Primeiros 20',
  regras: 'Os 20 primeiros ingressos pagos ganham um copão.',
  faixas: [{ de: 1, ate: 20, premio: 'Copão', custo_unitario_centavos: 1500 }],
  ...extra,
});

test('cria as três modalidades pelo Admin; a lista traz cada uma com os números', async () => {
  const pronta = await edicao();
  const [l1] = pronta.tipo.lotes;
  const r1 = await nova(pronta, ordem());
  assert.equal(r1.status, 201, r1.texto);
  const r2 = await nova(pronta, {
    modalidade: 'indicacao',
    nome: 'Indique',
    faixas: [
      { de: 4, premio: 'Copão' },
      { de: 10, premio: 'Camiseta', estoque: 30 },
    ],
  });
  assert.equal(r2.status, 201, r2.texto);
  const r3 = await nova(pronta, {
    modalidade: 'desconto',
    nome: 'VIP 30%',
    desconto_tipo: 'percentual',
    desconto_valor: 30,
    quantidade_promocional: 30,
    alvos: [{ categoria_id: pronta.tipo.id, lote_id: l1.id }],
    relampago: true,
    fim: new Date(Date.now() + 3600000).toISOString(),
  });
  assert.equal(r3.status, 201, r3.texto);
  assert.deepEqual(
    [r3.json.desconto_tipo, Number(r3.json.desconto_valor), r3.json.quantidade_promocional, r3.json.status],
    ['percentual', 30, 30, 'rascunho'],
  );
  const lista = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/campanhas/todas`)).json;
  assert.deepEqual(lista.map((c) => c.modalidade).sort(), ['desconto', 'indicacao', 'ordem_compra']);
  const ind = lista.find((c) => c.modalidade === 'indicacao');
  assert.deepEqual(
    ind.faixas.map((f) => [f.de, f.premio, f.concedidas]),
    [
      [4, 'Copão', 0],
      [10, 'Camiseta', 0],
    ],
  );
  const desc = lista.find((c) => c.modalidade === 'desconto');
  assert.equal(desc.usados, 0);
  assert.deepEqual(
    desc.alvos.map((a) => [Number(a.categoria_id), Number(a.lote_id)]),
    [[Number(pronta.tipo.id), Number(l1.id)]],
    'a lista traz os alvos (a tela precisa deles)',
  );
  // Só o Admin.
  assert.equal(
    (await apoio.cliente(srv).get(`/admin/trimundi/edicoes/${pronta.edicao.id}/campanhas/todas`)).status,
    401,
  );
  assert.equal((await apoio.cliente(srv).post(`/admin/trimundi/campanhas/${r1.json.id}/acao/ativar`, {})).status, 401);
});

test('configurações contraditórias são recusadas (400) — nada é gravado', async () => {
  const pronta = await edicao();
  const outra = await edicao();
  const [l1] = pronta.tipo.lotes;
  const desconto = (extra) => ({
    modalidade: 'desconto',
    nome: 'Promo',
    desconto_tipo: 'percentual',
    desconto_valor: 10,
    quantidade_promocional: 5,
    alvos: [{ categoria_id: pronta.tipo.id, lote_id: l1.id }],
    ...extra,
  });
  const ruins = [
    [
      'faixas sobrepostas',
      ordem({
        faixas: [
          { de: 1, ate: 10, premio: 'A' },
          { de: 5, ate: 20, premio: 'B' },
        ],
      }),
      /sobrepor/,
    ],
    ['estoque maior que a faixa', ordem({ faixas: [{ de: 1, ate: 10, premio: 'A', estoque: 11 }] }), /estoque/],
    ['posição final antes da inicial', ordem({ faixas: [{ de: 10, ate: 5, premio: 'A' }] }), /posição final/],
    ['relâmpago sem fim', ordem({ relampago: true }), /encerramento/],
    [
      'prazo de retirada antes do fim',
      ordem({
        fim: new Date(Date.now() + 7200000).toISOString(),
        prazo_retirada: new Date(Date.now() + 3600000).toISOString(),
      }),
      /prazo de retirada/,
    ],
    [
      'níveis que não crescem',
      {
        modalidade: 'indicacao',
        nome: 'X',
        faixas: [
          { de: 5, premio: 'A' },
          { de: 3, premio: 'B' },
        ],
      },
      /crescer/,
    ],
    [
      'repete com dois níveis',
      {
        modalidade: 'indicacao',
        nome: 'X',
        faixas: [
          { de: 2, premio: 'A', repete: true },
          { de: 5, premio: 'B' },
        ],
      },
      /único/,
    ],
    [
      'relâmpago em indicação',
      {
        modalidade: 'indicacao',
        nome: 'X',
        relampago: true,
        fim: new Date(Date.now() + 3600000).toISOString(),
        faixas: [{ de: 2, premio: 'A' }],
      },
      /Relâmpago/,
    ],
    [
      'indicação com tipos',
      {
        modalidade: 'indicacao',
        nome: 'X',
        alvos: [{ categoria_id: pronta.tipo.id }],
        faixas: [{ de: 2, premio: 'A' }],
      },
      /tipos ou lotes/,
    ],
    ['desconto sem alvo', desconto({ alvos: [] }), /tipo de ingresso/],
    ['desconto acima de 90%', desconto({ desconto_valor: 95 }), /90%/],
    ['desconto com faixas', desconto({ faixas: [{ de: 1, ate: 2, premio: 'A' }] }), /faixas/],
    ['desconto sem quantidade', desconto({ quantidade_promocional: null }), /quantidade promocional/],
    [
      'preço promocional maior que o do lote',
      desconto({ desconto_tipo: 'preco', desconto_valor: 15000 }),
      /menor que o/,
    ],
    ['preço abaixo de R$ 5,00', desconto({ desconto_tipo: 'valor', desconto_valor: 9600 }), /R\$ 5,00/],
    [
      'brinde ordem com dados de desconto',
      ordem({ desconto_tipo: 'percentual', desconto_valor: 10 }),
      /Desconto só existe/,
    ],
    ['alvo de outra edição', desconto({ alvos: [{ categoria_id: outra.tipo.id }] }), /não é desta edição/],
    [
      'prazo em promoção de preço',
      desconto({ prazo_retirada: new Date(Date.now() + 3600000).toISOString() }),
      /prazo de retirada/,
    ],
  ];
  for (const [nome, corpo, re] of ruins) {
    const r = await nova(pronta, corpo);
    assert.equal(r.status, 400, `${nome}: ${r.texto}`);
    assert.match(r.json.erro, re, nome);
  }
  const benef = await catalogo.criarBeneficio(outra.edicao.id, { nome: 'De outra' }, apoio.AUTOR);
  const r = await nova(pronta, ordem({ faixas: [{ de: 1, ate: 5, premio: 'X', beneficio_id: benef.id }] }));
  assert.equal(r.status, 400);
  const { rows } = await consultar('SELECT count(*)::int AS n FROM campanhas WHERE edicao_id = $1', [pronta.edicao.id]);
  assert.equal(rows[0].n, 0, 'nada gravado');
});

test('C7: só ativa com regulamento escrito e revisado; mudar o texto derruba a revisão', async () => {
  const pronta = await edicao();
  const semTexto = (await nova(pronta, ordem({ regras: '' }))).json;
  let r = await acao(semTexto.id, 'ativar');
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'regulamento_sem_revisao');
  assert.equal((await revisar(semTexto.id)).status, 409, 'sem texto não revisa');
  const c = (await nova(pronta, ordem())).json;
  assert.equal((await acao(c.id, 'ativar')).status, 409, 'escrito mas sem revisão');
  r = await revisar(c.id);
  assert.equal(r.status, 200);
  assert.equal(r.json.regras_revisadas_por, 'Escritório Teste');
  assert.equal((await acao(c.id, 'ativar')).status, 200);
  // Ativa: o regulamento não muda (pausa antes).
  r = await configurar(c.id, { regras: 'Texto novo.' });
  assert.equal(r.status, 409);
  assert.equal((await acao(c.id, 'pausar')).status, 200);
  r = await configurar(c.id, { regras: 'Texto novo.' });
  assert.equal(r.status, 200);
  assert.equal(r.json.regras_revisadas_em, null, 'texto novo, revisão nova');
  assert.equal((await acao(c.id, 'retomar')).status, 409);
  await revisar(c.id);
  assert.equal((await acao(c.id, 'retomar')).status, 200);
  const { rows } = await consultar(
    "SELECT acao FROM auditoria WHERE entidade = 'campanha' AND entidade_id = $1 ORDER BY id",
    [String(c.id)],
  );
  assert.ok(rows.some((x) => x.acao === 'campanha_regras_revisadas'));
});

test('promoção de preço: cadastra, revisa e ativa (o desconto vale no checkout desde o PR 4)', async () => {
  const pronta = await edicao();
  const [l1] = pronta.tipo.lotes;
  const c = (
    await nova(pronta, {
      modalidade: 'desconto',
      nome: 'Pista promo',
      regras: 'Pista por R$ 79,90 enquanto houver.',
      desconto_tipo: 'preco',
      desconto_valor: 7990,
      quantidade_promocional: 10,
      alvos: [{ categoria_id: pronta.tipo.id, lote_id: l1.id }],
    })
  ).json;
  assert.equal((await acao(c.id, 'ativar')).status, 409, 'sem revisão jurídica (C7) não ativa');
  await revisar(c.id);
  const r = await acao(c.id, 'ativar');
  assert.equal(r.status, 200, r.texto);
  assert.equal((await consultar('SELECT status FROM campanhas WHERE id = $1', [c.id])).rows[0].status, 'ativa');
});

test('travas de justiça: em uso, faixas/alvos/acumulação não mudam; estoque só sobe; fim só prorroga', async () => {
  const pronta = await edicao();
  const c = (await nova(pronta, ordem({ faixas: [{ de: 1, ate: 20, premio: 'Copão', estoque: 5 }] }))).json;
  // Antes do uso, tudo muda.
  let r = await configurar(c.id, { faixas: [{ de: 1, ate: 30, premio: 'Copão grande', estoque: 5 }], acumula: true });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.faixas[0].ate, 30);
  await revisar(c.id);
  await acao(c.id, 'ativar');
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await pagar(ped.pedido_id);
  for (const corpo of [
    { faixas: [{ de: 1, ate: 10, premio: 'X' }] },
    { alvos: [{ categoria_id: pronta.tipo.id }] },
    { acumula: false },
    { prioridade: 3 },
    { inicio: new Date().toISOString() },
  ]) {
    r = await configurar(c.id, corpo);
    assert.equal(r.status, 409, JSON.stringify(corpo));
    assert.equal(r.json.codigo, 'campanha_em_uso');
  }
  const faixa = (await consultar('SELECT id FROM campanha_faixas WHERE campanha_id = $1', [c.id])).rows[0].id;
  assert.equal((await configurar(c.id, { estoques: { [faixa]: 4 } })).status, 409, 'estoque só sobe');
  r = await configurar(c.id, { estoques: { [faixa]: 8 }, nome: 'Primeiros 30 (novo nome)' });
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.faixas[0].estoque, 8);
  const fim = new Date(Date.now() + 7200000).toISOString();
  assert.equal((await configurar(c.id, { fim })).status, 200);
  assert.equal(
    (await configurar(c.id, { fim: new Date(Date.now() + 3600000).toISOString() })).status,
    409,
    'não antecipa',
  );
  const det = (await admin.get(`/admin/trimundi/campanhas/${c.id}/detalhe`)).json;
  assert.equal(det.em_uso, true);
  assert.deepEqual(
    det.posicoes.map((p) => [p.posicao, p.resultado]),
    [[1, 'premiado']],
  );
  assert.deepEqual(
    det.premios[0].historico.map((h) => h.acao),
    ['concedido'],
  );
});

test('duplicar, pausar, retomar e encerrar (encerrada não reabre nem se edita)', async () => {
  const pronta = await edicao();
  const c = (await nova(pronta, ordem({ alvos: [{ categoria_id: pronta.tipo.id }] }))).json;
  await revisar(c.id);
  assert.equal((await acao(c.id, 'ativar')).status, 200);
  const dup = await admin.post(`/admin/trimundi/campanhas/${c.id}/duplicar`, {});
  assert.equal(dup.status, 201);
  assert.match(dup.json.nome, /^Cópia de /);
  assert.deepEqual(
    [dup.json.status, dup.json.regras_revisadas_em, dup.json.faixas.length, dup.json.alvos.length],
    ['rascunho', null, 1, 1],
    'rascunho sem revisão, mesma configuração',
  );
  assert.equal((await acao(c.id, 'pausar')).status, 200);
  assert.equal((await acao(c.id, 'pausar')).status, 409);
  assert.equal((await acao(c.id, 'retomar')).status, 200);
  assert.equal((await acao(c.id, 'encerrar')).status, 200);
  assert.equal((await acao(c.id, 'retomar')).status, 409);
  assert.equal((await configurar(c.id, { nome: 'X' })).status, 409);
  assert.equal((await acao(c.id, 'desligar')).status, 400);
});

test('CSV das posições (sem CPF) e Admin → Recompensas com os brindes de primeiros N', async () => {
  const pronta = await edicao();
  const c = (await nova(pronta, ordem())).json;
  await revisar(c.id);
  await acao(c.id, 'ativar');
  const comprador = apoio.pessoa('=Fórmula');
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2), {
    comprador,
    participantes: [apoio.pessoa('=SOMA(A1)'), apoio.pessoa('Bia')],
  });
  await pagar(ped.pedido_id);
  const csv = await admin.get(`/admin/trimundi/campanhas/${c.id}/posicoes.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const linhas = csv.texto.trim().split('\r\n');
  assert.equal(linhas.length, 3);
  assert.match(linhas[0], /"posicao";"resultado"/);
  assert.equal(csv.texto.includes(comprador.cpf), false, 'sem CPF');
  assert.match(csv.texto, /"'=SOMA/, 'fórmula neutralizada');
  const rec = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/recompensas`)).json;
  assert.equal(rec.ordem_compra.totais.a_retirar, 2);
  assert.deepEqual(rec.ordem_compra.itens.map((r) => [r.posicao, r.recompensa]).sort(), [
    [1, 'Copão'],
    [2, 'Copão'],
  ]);
  // O Admin entrega pela mesma rota de sempre, com histórico.
  const pid = rec.ordem_compra.itens[0].id;
  assert.equal((await admin.post(`/admin/trimundi/recompensas/${pid}/entregar`, {})).status, 200);
  assert.equal((await admin.post(`/admin/trimundi/recompensas/${pid}/entregar`, {})).status, 409);
  const ev = (await consultar('SELECT acao FROM campanha_premio_eventos WHERE premio_id = $1 ORDER BY id', [pid])).rows;
  assert.deepEqual(
    ev.map((e) => e.acao),
    ['concedido', 'entregue'],
  );
});

test('edição encerrada: não cria nem duplica campanha', async () => {
  const pronta = await edicao();
  const c = (await nova(pronta, ordem())).json;
  await consultar("UPDATE edicoes SET status = 'encerrado', encerrado_em = now() WHERE id = $1", [pronta.edicao.id]);
  assert.equal((await nova(pronta, ordem())).status, 409);
  assert.equal((await admin.post(`/admin/trimundi/campanhas/${c.id}/duplicar`, {})).status, 409);
});
