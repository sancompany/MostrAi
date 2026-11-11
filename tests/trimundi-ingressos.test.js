const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const catalogo = require('../src/trimundi/catalogo');
const eventos = require('../src/trimundi/eventos');
const indicacao = require('../src/trimundi/indicacao');
const { consultar } = require('../src/trimundi/db/conexao');

// Seleção de ingressos, titular e QR por unidade (pedido do dono, 10/11/2026):
// a página não mostra próximo lote nem vencimento, avisa "últimos N" só com
// 10 ou menos no lote atual; a compra pela conta põe todos os ingressos no
// nome do titular, sem formulário de acompanhante — cada um com número fixo,
// QR e situação próprios; o benefício do titular aparece só no ingresso
// principal e o de cada tipo só na unidade dele.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

// Edição com 3 tipos, limite de 4 por CPF: Pagonejo (lote 1 com `restam`),
// Funk (copão no lote 1) e VIP (Open Bar no tipo).
async function edicao({ restam = 7 } = {}) {
  const s = apoio.sufixo();
  const ed = await eventos.criarEdicao(
    {
      evento: { nome: `Treemundo ${s}`, slug: `tree-${s}` },
      edicao: {
        nome: 'Edição 01',
        slug: 'ED01',
        classificacao_etaria: 'livre',
        limite_por_cpf: 4,
        textos: { regras_entrada: 'Documento com foto.', termos_compra: 'Termos de teste.' },
      },
    },
    apoio.AUTOR,
  );
  const openbar = await catalogo.criarBeneficio(ed.id, { nome: 'Open Bar' }, apoio.AUTOR);
  const copao = await catalogo.criarBeneficio(ed.id, { nome: 'Copão', quantidade: 30 }, apoio.AUTOR);
  const pagonejo = await catalogo.criarTipo(
    ed.id,
    {
      nome: 'Pagonejo (Pulseira Marrom)',
      lotes: [
        { preco_centavos: 6000, quantidade: restam },
        { preco_centavos: 8000, quantidade: 50 },
      ],
    },
    apoio.AUTOR,
  );
  const funk = await catalogo.criarTipo(
    ed.id,
    { nome: 'Funk Pista (Pulseira Roxa)', lotes: [{ preco_centavos: 5000, quantidade: 100, beneficio_id: copao.id }] },
    apoio.AUTOR,
  );
  const vip = await catalogo.criarTipo(
    ed.id,
    {
      nome: 'Funk VIP Open Bar (Pulseira Vermelha)',
      beneficios: [openbar.id],
      lotes: [{ preco_centavos: 15000, quantidade: 40 }],
    },
    apoio.AUTOR,
  );
  await eventos.mudarStatus(ed.id, 'publicado', apoio.AUTOR);
  return {
    edicao: await eventos.obterEdicao(ed.id),
    slugEvento: `tree-${s}`,
    slugEdicao: 'ED01',
    tipos: { pagonejo, funk, vip },
  };
}

const itens = (...pares) => ({ tipos: pares.map(([tipo, quantidade]) => ({ categoria_id: tipo.id, quantidade })) });
const vitrine = async (e) => (await apoio.cliente(srv).get(`/ticket/api/edicoes/${e.slugEvento}/${e.slugEdicao}`)).json;
const tipoNa = (v, tipo) => v.tipos.find((t) => Number(t.id) === Number(tipo.id));

// Compra pelo caminho da página: conta logada, cotação, pedido SEM participantes.
async function comprar(e, p, carrinho, extra = {}) {
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  const cot = await c.post('/ticket/api/cotacao', { evento: e.slugEvento, edicao: e.slugEdicao, itens: carrinho });
  assert.equal(cot.status, 200, cot.texto);
  const r = await c.post('/ticket/api/pedidos', {
    evento: e.slugEvento,
    edicao: e.slugEdicao,
    itens: carrinho,
    aceite: { aceito: true, termos: cot.json.termos.map((t) => t.id) },
    chave: apoio.chave(),
    ...extra,
  });
  return { c, r, cot: cot.json };
}

const ingressosDo = async (pedidoId) =>
  (
    await consultar(
      `SELECT i.id, i.codigo, i.status, c.nome AS categoria, pa.nome, pa.cpf, pa.id AS participante_id,
              COALESCE((SELECT json_agg(ib.nome ORDER BY ib.nome) FROM ingresso_beneficios ib WHERE ib.ingresso_id = i.id), '[]') AS beneficios
         FROM ingressos i JOIN categorias c ON c.id = i.categoria_id JOIN participantes pa ON pa.id = i.participante_id
         JOIN reservas r ON r.id = i.reserva_id JOIN pedido_itens pi ON pi.id = r.pedido_item_id
        WHERE i.pedido_id = $1 ORDER BY pi.ordem, r.posicao`,
      [pedidoId],
    )
  ).rows;

// ------------------------------------------------------------- seleção
test('vitrine: sem próximo lote nem vencimento; "últimos N" só com 10 ou menos NO LOTE ATUAL', async () => {
  const e = await edicao({ restam: 12 });
  let v = await vitrine(e);
  for (const t of v.tipos) {
    assert.equal('proximo_lote' in t, false, 'sem preço do próximo lote');
    assert.equal('vendas_ate' in t, false, 'sem vencimento do lote');
    assert.equal('disponibilidade' in t, false, 'sem texto de disponibilidade');
  }
  assert.equal(tipoNa(v, e.tipos.pagonejo).restantes_no_lote, null, '12 no lote: não mostra');
  assert.equal(tipoNa(v, e.tipos.funk).restantes_no_lote, null, '100 no lote: não mostra');

  // 2 pagos: restam 10 → aparece. Conta o lote atual, não a soma com o 2º (50).
  const pago = await apoio.novoPedido(e, itens([e.tipos.pagonejo, 2]));
  await apoio.pagar(pago.pedido_id);
  v = await vitrine(e);
  assert.equal(tipoNa(v, e.tipos.pagonejo).restantes_no_lote, 10);
  assert.equal(tipoNa(v, e.tipos.pagonejo).lote, '1º lote');

  // Reserva viva conta; reserva vencida não.
  const aberto = await apoio.novoPedido(e, itens([e.tipos.pagonejo, 3]));
  assert.equal(tipoNa(await vitrine(e), e.tipos.pagonejo).restantes_no_lote, 7);
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [
    aberto.pedido_id,
  ]);
  assert.equal(tipoNa(await vitrine(e), e.tipos.pagonejo).restantes_no_lote, 10, 'reserva vencida devolve');

  // Esgota o 1º lote por pagos: vira o 2º lote, com o preço dele e sem aviso (50).
  for (let i = 0; i < 3; i++) {
    const p = await apoio.novoPedido(e, itens([e.tipos.pagonejo, i < 2 ? 4 : 2]));
    await apoio.pagar(p.pedido_id);
  }
  v = await vitrine(e);
  const t = tipoNa(v, e.tipos.pagonejo);
  assert.deepEqual([t.lote, t.preco_centavos, t.restantes_no_lote], ['2º lote', 8000, null]);
  assert.equal(t.situacao, 'a_venda');
});

// ----------------------------------------------------------- compra e titular
test('compra sem formulário: 1, 2 iguais, tipos diferentes e 4 ingressos — todos no nome do titular, um a um', async () => {
  const e = await edicao({ restam: 30 });
  const casos = [
    [[e.tipos.pagonejo, 1]],
    [[e.tipos.funk, 2]],
    [
      [e.tipos.pagonejo, 1],
      [e.tipos.vip, 1],
    ],
    [
      [e.tipos.pagonejo, 2],
      [e.tipos.funk, 1],
      [e.tipos.vip, 1],
    ],
  ];
  for (const carrinho of casos) {
    const ana = apoio.pessoa('Ana');
    const conta = await apoio.contaDe(ana);
    const { r } = await comprar(e, ana, itens(...carrinho));
    assert.equal(r.status, 201, r.texto);
    await apoio.pagar(r.json.pedido_id);
    const ings = await ingressosDo(r.json.pedido_id);
    const total = carrinho.reduce((s, [, n]) => s + n, 0);
    assert.equal(ings.length, total, 'um ingresso por unidade');
    assert.ok(
      ings.every((i) => i.nome === conta.nome && i.cpf === conta.cpf),
      'todos no nome e CPF do titular',
    );
    assert.equal(new Set(ings.map((i) => i.codigo)).size, total, 'cada um com o próprio código (QR)');
    assert.equal(new Set(ings.map((i) => i.participante_id)).size, total, 'uma linha de titular por ingresso');
  }
});

test('o limite de 4 por CPF na edição continua valendo sem os participantes', async () => {
  const e = await edicao({ restam: 30 });
  const ana = apoio.pessoa('Ana');
  const { r } = await comprar(e, ana, itens([e.tipos.funk, 3]));
  await apoio.pagar(r.json.pedido_id);
  const mais = await comprar(e, ana, itens([e.tipos.funk, 2]));
  assert.equal(mais.r.status, 409);
  assert.equal(mais.r.json.codigo, 'limite_cpf');
  assert.equal(mais.r.json.disponivel, 1);
  assert.equal((await comprar(e, ana, itens([e.tipos.vip, 1]))).r.status, 201);
});

test('pedido com a lista de participantes (forma antiga) segue aceito e com os nomes enviados', async () => {
  const e = await edicao({ restam: 30 });
  const ana = apoio.pessoa('Ana');
  const bia = apoio.pessoa('Bia');
  const { r } = await comprar(e, ana, itens([e.tipos.funk, 2]), { participantes: [{ conta: true }, bia] });
  assert.equal(r.status, 201, r.texto);
  await apoio.pagar(r.json.pedido_id);
  const ings = await ingressosDo(r.json.pedido_id);
  assert.deepEqual(
    ings.map((i) => i.nome),
    [ana.nome, bia.nome],
  );
  const curta = await comprar(e, apoio.pessoa('Caio'), itens([e.tipos.funk, 2]), { participantes: [{ conta: true }] });
  assert.equal(curta.r.status, 400, 'lista incompleta continua recusada');
});

// ------------------------------------------------- conta: número, QR e benefícios
test('Minha conta: número fixo, nome do titular, tipo e QR próprio por ingresso; benefício do tipo só na unidade', async () => {
  const e = await edicao({ restam: 30 });
  const ana = apoio.pessoa('Ana');
  const conta = await apoio.contaDe(ana);
  const { c, r } = await comprar(e, ana, itens([e.tipos.pagonejo, 2], [e.tipos.funk, 1], [e.tipos.vip, 1]));
  await apoio.pagar(r.json.pedido_id);
  const painel = async () => (await c.get('/ticket/api/conta')).json;
  const doPedido = (d) => d.edicoes.flatMap((g) => g.pedidos).find((p) => p.id === r.json.pedido_id);
  let ings = doPedido(await painel()).ingressos;
  assert.deepEqual(
    ings.map((i) => [i.numero, i.numero_de, i.categoria]),
    [
      [1, 4, 'Pagonejo (Pulseira Marrom)'],
      [2, 4, 'Pagonejo (Pulseira Marrom)'],
      [3, 4, 'Funk Pista (Pulseira Roxa)'],
      [4, 4, 'Funk VIP Open Bar (Pulseira Vermelha)'],
    ],
  );
  assert.ok(ings.every((i) => i.participante === conta.nome));
  assert.equal(new Set(ings.map((i) => i.qr)).size, 4, 'quatro QR diferentes');
  assert.ok(ings.every((i) => /^data:image\/png;base64,/.test(i.qr)));
  assert.deepEqual(
    ings.map((i) => i.beneficios.map((b) => b.nome)),
    [[], [], ['Copão'], ['Open Bar']],
    'benefício só na unidade do tipo (ou do lote) que dá direito',
  );
  assert.deepEqual(
    ings.map((i) => i.principal),
    [true, false, false, false],
  );
  assert.ok(
    ings.every((i) => i.beneficios_do_titular.length === 0),
    'sem indicação, nada de benefício fictício',
  );

  // O número não depende da lista: cancelado o 1º, os outros seguem 2, 3, 4,
  // e o principal passa para o próximo válido.
  await consultar("UPDATE ingressos SET status = 'cancelado' WHERE id = (SELECT id FROM ingressos WHERE codigo = $1)", [
    (await ingressosDo(r.json.pedido_id))[0].codigo,
  ]);
  ings = doPedido(await painel()).ingressos;
  assert.deepEqual(
    ings.map((i) => [i.numero, i.status, i.principal, Boolean(i.qr)]),
    [
      [1, 'cancelado', false, false],
      [2, 'valido', true, true],
      [3, 'valido', false, true],
      [4, 'valido', false, true],
    ],
  );
});

test('benefício do titular (recompensa de indicação) só no ingresso principal, nunca nos outros', async () => {
  const e = await edicao({ restam: 30 });
  await indicacao.criarCampanha(
    e.edicao.id,
    { nome: 'Indique e ganhe', recompensa: 'Copo personalizado', quantidade: 10, indicacoes_por_recompensa: 1 },
    apoio.AUTOR,
  );
  const ana = apoio.pessoa('Ana');
  const { c, r } = await comprar(e, ana, itens([e.tipos.funk, 2], [e.tipos.vip, 1]));
  await apoio.pagar(r.json.pedido_id);
  const codigo = (await c.get('/ticket/api/conta')).json.indicacao.codigo;
  // Bia compra pelo link da Ana e paga: a Ana ganha 1 recompensa.
  const bia = await comprar(e, apoio.pessoa('Bia'), itens([e.tipos.funk, 1]), { indicacao: codigo });
  await apoio.pagar(bia.r.json.pedido_id);
  // Um segundo pedido da Ana na mesma edição também não repete o benefício.
  const outro = await comprar(e, ana, itens([e.tipos.pagonejo, 1]));
  await apoio.pagar(outro.r.json.pedido_id);

  const d = (await c.get('/ticket/api/conta')).json;
  const todos = d.edicoes.find((g) => g.evento === e.edicao.evento.nome).pedidos.flatMap((p) => p.ingressos);
  assert.equal(todos.length, 4);
  const comTitular = todos.filter((i) => i.beneficios_do_titular.length);
  assert.equal(comTitular.length, 1, 'uma vez só, em um ingresso');
  assert.equal(comTitular[0].principal, true);
  assert.equal(comTitular[0].numero, 1);
  assert.deepEqual(comTitular[0].beneficios_do_titular, [
    { nome: 'Copo personalizado', origem: 'indicacao', a_retirar: 1, entregues: 0 },
  ]);
  const vip = todos.find((i) => i.categoria.startsWith('Funk VIP'));
  assert.deepEqual(
    vip.beneficios.map((b) => b.nome),
    ['Open Bar'],
  );
  assert.deepEqual(vip.beneficios_do_titular, [], 'o do titular não vai para o VIP');
  // A recompensa não foi entregue sozinha: continua concedida, para o Admin entregar.
  const { rows } = await consultar(
    `SELECT r.status FROM recompensas_indicacao r JOIN indicadores i ON i.id = r.indicador_id WHERE i.codigo = $1`,
    [codigo],
  );
  assert.deepEqual(
    rows.map((x) => x.status),
    ['concedida'],
  );
});

// ---------------------------------------------------------------- check-in
test('check-in: cada QR vale por si — usar o 1º não mexe nos outros; o usado não entra de novo', async () => {
  const e = await edicao({ restam: 30 });
  const ana = apoio.pessoa('Ana');
  const conta = await apoio.contaDe(ana);
  const { r } = await comprar(e, ana, itens([e.tipos.pagonejo, 2], [e.tipos.vip, 2]));
  await apoio.pagar(r.json.pedido_id);
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, e.codigo_publico FROM ingressos i JOIN edicoes e ON e.id = i.edicao_id
       JOIN reservas r ON r.id = i.reserva_id JOIN pedido_itens pi ON pi.id = r.pedido_item_id
      WHERE i.pedido_id = $1 ORDER BY pi.ordem, r.posicao`,
    [r.json.pedido_id],
  );
  const { conteudoDoQr } = require('../src/trimundi/lib/qr');
  const op = await apoio.operadorLogado(srv, [e.edicao.id]);
  const portaria = apoio.cliente(srv, { cookie: op.cookie });
  const ler = (row) =>
    portaria.post('/ticket/api/checkin/consultar', {
      edicao_id: e.edicao.id,
      entrada: conteudoDoQr(row.codigo_publico, row.codigo),
    });
  const leituras = [];
  for (const row of rows) leituras.push((await ler(row)).json);
  assert.deepEqual(
    leituras.map((x) => [x.resultado, x.ingresso.numero, x.ingresso.numero_de, x.ingresso.participante]),
    [
      ['valido', 1, 4, conta.nome],
      ['valido', 2, 4, conta.nome],
      ['valido', 3, 4, conta.nome],
      ['valido', 4, 4, conta.nome],
    ],
  );
  assert.equal(leituras[2].ingresso.categoria, 'Funk VIP Open Bar (Pulseira Vermelha)');
  assert.deepEqual(
    leituras[2].ingresso.beneficios.map((b) => b.nome),
    ['Open Bar'],
  );
  assert.deepEqual(leituras[0].ingresso.beneficios, [], 'Pagonejo sem benefício: nada inventado');

  const entrar = (row) =>
    portaria.post('/ticket/api/checkin/confirmar', { edicao_id: e.edicao.id, ingresso_id: row.id });
  assert.equal((await entrar(rows[0])).json.resultado, 'entrada_registrada');
  assert.deepEqual(
    (await Promise.all(rows.slice(1).map(ler))).map((x) => x.json.resultado),
    ['valido', 'valido', 'valido'],
    'os outros três continuam válidos',
  );
  assert.equal((await entrar(rows[0])).json.resultado, 'ja_utilizado', 'o mesmo QR não entra de novo');
  assert.equal((await ler(rows[0])).json.resultado, 'ja_utilizado');
  assert.equal((await entrar(rows[3])).json.resultado, 'entrada_registrada');

  // Pacote do check-in sem internet: número e total, sem dado pessoal a mais.
  const pacote = (await portaria.get(`/ticket/api/checkin/pacote?edicao=${e.edicao.id}`)).json;
  const doPedido = pacote.ingressos.filter((x) => rows.some((row) => Number(row.id) === x.i));
  assert.deepEqual(
    doPedido.map((x) => [x.o, x.q, x.u]).sort((a, b) => a[0] - b[0]),
    [
      [1, 4, true],
      [2, 4, false],
      [3, 4, false],
      [4, 4, true],
    ],
  );
  assert.ok(doPedido.every((x) => !JSON.stringify(x).includes(conta.cpf)));
});

test('pedido antigo (com participantes de cada um) e QR já emitido continuam valendo, agora com número', async () => {
  const e = await edicao({ restam: 30 });
  // Pelo caminho antigo de testes: participantes com nome, CPF e e-mail.
  const antigo = await apoio.novoPedido(e, itens([e.tipos.funk, 2]));
  await apoio.pagar(antigo.pedido_id);
  const rows = await ingressosDo(antigo.pedido_id);
  assert.deepEqual(
    rows.map((x) => x.nome),
    antigo.corpo.participantes.map((p) => p.nome),
  );
  const { rows: qr } = await consultar(
    'SELECT i.codigo, e.codigo_publico FROM ingressos i JOIN edicoes e ON e.id = i.edicao_id WHERE i.id = $1',
    [rows[1].id],
  );
  const op = await apoio.operadorLogado(srv, [e.edicao.id]);
  const lido = await apoio.cliente(srv, { cookie: op.cookie }).post('/ticket/api/checkin/consultar', {
    edicao_id: e.edicao.id,
    entrada: require('../src/trimundi/lib/qr').conteudoDoQr(qr[0].codigo_publico, qr[0].codigo),
  });
  assert.equal(lido.json.resultado, 'valido');
  assert.deepEqual([lido.json.ingresso.numero, lido.json.ingresso.numero_de], [2, 2]);
  assert.equal(lido.json.ingresso.participante, antigo.corpo.participantes[1].nome);
});
