const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const pedidos = require('../src/trimundi/pedidos');
const eventos = require('../src/trimundi/eventos');
const catalogo = require('../src/trimundi/catalogo');
const promocoes = require('../src/trimundi/promocoes');
const emissao = require('../src/trimundi/emissao');
const pagamentos = require('../src/trimundi/pagamentos');

// Trimundi, Etapas 3 e 4 — vitrine, cotação e pedido: o servidor decide o
// estoque (lotes, combos, capacidade, limite por comprador), a reserva vale
// 30 min, o aceite dos termos é gravado com a versão, e o pedido só se abre
// com o token da URL.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

// Corpo de pedido pronto a partir da cotação (o que a página pública faz).
async function corpoDoPedido(pronta, itens, extra = {}) {
  const cot = await pedidos.cotar({ evento: pronta.slugEvento, edicao: pronta.slugEdicao, itens });
  return {
    cot,
    corpo: {
      evento: pronta.slugEvento,
      edicao: pronta.slugEdicao,
      itens,
      comprador: extra.comprador || apoio.pessoa('Comprador'),
      participantes: extra.participantes || cot.vagas.map(() => apoio.pessoa('Participante')),
      aceite: { aceito: true, termos: cot.termos.map((t) => t.id) },
      chave: extra.chave || apoio.chave(),
    },
  };
}

const tipos = (tipo, quantidade) => ({ tipos: [{ categoria_id: tipo.id, quantidade }] });

// Confirma o pagamento pelo mesmo caminho do webhook (fila + aplicação).
async function pagar(pedidoId) {
  const { rows } = await consultar('SELECT total_centavos FROM pedidos WHERE id = $1', [pedidoId]);
  const eventoId = `teste-${apoio.chave()}`;
  await pagamentos.registrarEvento({
    eventoId,
    provedor: 'teste',
    payload: {
      pedidoId,
      chargeId: `pay_${apoio.sufixo()}`,
      status: 'confirmado',
      valorComDesconto: Number(rows[0].total_centavos) / 100,
      valorCobrado: Number(rows[0].total_centavos) / 100,
      metodoPagamento: 'pix',
    },
  });
  await aguardarEvento(eventoId);
}

// Outro arquivo pode estar processando a fila ao mesmo tempo (banco de teste
// compartilhado): processa e espera o evento sair de verdade.
async function aguardarEvento(eventoId) {
  for (let i = 0; i < 100; i++) {
    await pagamentos.processarFila();
    const { rows } = await consultar('SELECT processamento FROM pagamento_eventos WHERE evento_id = $1', [eventoId]);
    if (rows[0]?.processamento === 'processado') return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`evento ${eventoId} não foi processado`);
}

test('vitrine: rascunho não existe; publicada mostra preço e lote, nunca o estoque', async () => {
  const pronta = await apoio.edicaoPronta({ publicar: false, lotes: [{ preco_centavos: 5000, quantidade: 3 }] });
  const c = apoio.cliente(srv);
  const caminho = `/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`;
  assert.equal((await c.get(caminho)).status, 404);
  assert.equal((await c.get(`/ticket/${pronta.slugEvento}/${pronta.slugEdicao}`, { accept: 'text/html' })).status, 404);

  await eventos.mudarStatus(pronta.edicao.id, 'publicado', apoio.AUTOR);
  const r = await c.get(caminho.toUpperCase().replace('/TICKET/API/EDICOES', '/ticket/api/edicoes'));
  assert.equal(r.status, 200, 'endereço não diferencia maiúscula');
  const t = r.json.tipos[0];
  assert.equal(t.situacao, 'a_venda');
  assert.equal(t.preco_centavos, 5000);
  assert.equal(t.lote, '1º lote');
  assert.equal(t.max_quantidade, 3);
  for (const proibido of ['quantidade', 'pagos', 'reservados', 'disponivel', 'disponivel_agora', 'lotes']) {
    assert.equal(Object.hasOwn(t, proibido), false, `vitrine não mostra ${proibido}`);
  }
  assert.equal(r.json.venda_aberta, true);
  assert.match(r.json.textos.termos_compra.texto, /Termos de teste/);
  assert.equal(r.json.textos.condicoes_especiais, undefined);

  // A página da edição é HTML com o título escapado para compartilhamento.
  const pagina = await c.get(`/ticket/${pronta.slugEvento}/${pronta.slugEdicao}`, { accept: 'text/html' });
  assert.equal(pagina.status, 200);
  assert.match(pagina.texto, /<meta property="og:title" content="Evento [0-9a-f]+ — Edição 01"/);

  await eventos.mudarStatus(pronta.edicao.id, 'pausado', apoio.AUTOR);
  const pausada = await c.get(caminho);
  assert.equal(pausada.json.venda_aberta, false);
  assert.equal(pausada.json.tipos[0].max_quantidade, 0);
  assert.match(pausada.json.mensagem, /pausadas/);
});

test('cotação: o pedido que vira o lote paga o preço de cada lote', async () => {
  const pronta = await apoio.edicaoPronta({
    lotes: [
      { preco_centavos: 5000, quantidade: 2 },
      { preco_centavos: 7000, quantidade: 10 },
    ],
  });
  const r = await apoio.cliente(srv).post('/ticket/api/cotacao', {
    evento: pronta.slugEvento,
    edicao: pronta.slugEdicao,
    itens: tipos(pronta.tipo, 3),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.itens.map((i) => [i.descricao, i.quantidade, i.preco_unitario_centavos]),
    [
      ['Pista — 1º lote', 2, 5000],
      ['Pista — 2º lote', 1, 7000],
    ],
  );
  assert.equal(r.json.total_centavos, 17000);
  assert.equal(r.json.vagas.length, 3);
  assert.deepEqual(
    r.json.termos.map((t) => t.tipo),
    ['regras_entrada', 'termos_compra'],
  );
  // A cotação não reserva nada.
  const { rows } = await consultar(
    'SELECT count(*)::int AS n FROM reservas r JOIN lotes l ON l.id = r.lote_id WHERE l.categoria_id = $1',
    [pronta.tipo.id],
  );
  assert.equal(rows[0].n, 0);
});

test('pedido: reserva por 30 min, grava aceites e só o hash do token; repetido devolve o mesmo', async () => {
  const pronta = await apoio.edicaoPronta();
  const { corpo } = await corpoDoPedido(pronta, tipos(pronta.tipo, 2));
  const c = apoio.cliente(srv);
  const r = await c.post('/ticket/api/pedidos', corpo, { 'user-agent': 'teste-trimundi' });
  assert.equal(r.status, 201, r.texto);
  assert.equal(r.json.total_centavos, 10000);
  assert.equal(r.json.repetido, false);
  assert.match(r.json.url, new RegExp(`^/ticket/pedido/${r.json.pedido_id}\\?t=`));
  // Checkout configurado: o link é o da tela de pagamento, com a volta para o pedido.
  const pagamento = new URL(r.json.pagamento.url);
  assert.equal(pagamento.origin, 'https://checkout.teste.invalid');
  assert.equal(pagamento.searchParams.get('c'), 'trimundi-teste');
  assert.equal(pagamento.searchParams.get('pedido'), r.json.pedido_id);
  assert.match(pagamento.searchParams.get('returnUrl'), /^https:\/\/site\.teste\.invalid\/ticket\/pedido\//);

  const minutos = (new Date(r.json.reserva_expira_em).getTime() - Date.now()) / 60000;
  assert.ok(minutos > 29 && minutos <= 30, `reserva de 30 min (${minutos})`);

  const { rows: info } = await consultar(
    `SELECT (SELECT count(*) FROM reservas WHERE pedido_id = $1)::int AS reservas,
            (SELECT count(*) FROM aceites WHERE pedido_id = $1)::int AS aceites,
            (SELECT count(*) FROM aceites WHERE pedido_id = $1 AND user_agent = 'teste-trimundi')::int AS com_ua,
            (SELECT array_agg(token_hash) FROM pedido_acessos WHERE pedido_id = $1) AS hashes`,
    [r.json.pedido_id],
  );
  assert.equal(info[0].reservas, 2);
  assert.equal(info[0].aceites, 2);
  assert.equal(info[0].com_ua, 2);
  assert.equal(info[0].hashes.includes(r.json.token), false, 'o token não fica no banco');

  const repetido = await c.post('/ticket/api/pedidos', corpo);
  assert.equal(repetido.status, 200);
  assert.equal(repetido.json.repetido, true);
  assert.equal(repetido.json.pedido_id, r.json.pedido_id);
  const { rows: depois } = await consultar('SELECT count(*)::int AS n FROM reservas WHERE pedido_id = $1', [
    r.json.pedido_id,
  ]);
  assert.equal(depois[0].n, 2, 'clique duplo não reserva em dobro');
});

test('pedido: sem aceite, sem participante, CPF inválido e termos mudados são recusados', async () => {
  const pronta = await apoio.edicaoPronta();
  const c = apoio.cliente(srv);
  const { corpo } = await corpoDoPedido(pronta, tipos(pronta.tipo, 2));

  const semAceite = await c.post('/ticket/api/pedidos', { ...corpo, aceite: { aceito: false } });
  assert.equal(semAceite.status, 400);
  assert.match(semAceite.json.erro, /aceitar os termos/);

  const faltando = await c.post('/ticket/api/pedidos', { ...corpo, participantes: corpo.participantes.slice(1) });
  assert.equal(faltando.status, 400);
  assert.equal(faltando.json.codigo, 'participantes');

  const cpfRuim = await c.post('/ticket/api/pedidos', {
    ...corpo,
    participantes: [{ ...corpo.participantes[0], cpf: '11111111111' }, corpo.participantes[1]],
  });
  assert.equal(cpfRuim.status, 400);
  assert.match(cpfRuim.json.erro, /CPF do participante 1 inválido/);

  // Sem conta logada não há compra; o corpo não escolhe quem compra.
  const semConta = await fetch(`${srv.base}/ticket/api/pedidos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': apoio.novoIp() },
    body: JSON.stringify(corpo),
  });
  assert.equal(semConta.status, 401);
  assert.equal((await semConta.json()).codigo, 'conta');

  await eventos.atualizarEdicao(pronta.edicao.id, { textos: { termos_compra: 'Termos novos.' } }, apoio.AUTOR);
  const mudou = await c.post('/ticket/api/pedidos', corpo);
  assert.equal(mudou.status, 409);
  assert.equal(mudou.json.codigo, 'termos');

  const outra = await apoio.edicaoPronta();
  const deOutra = await c.post('/ticket/api/cotacao', {
    evento: pronta.slugEvento,
    edicao: pronta.slugEdicao,
    itens: tipos(outra.tipo, 1),
  });
  assert.equal(deOutra.status, 400, 'tipo de outra edição');
});

test('limite por comprador conta os pedidos anteriores do mesmo CPF', async () => {
  const pronta = await apoio.edicaoPronta({ limite: 2 });
  const c = apoio.cliente(srv);
  const comprador = apoio.pessoa('Comprador');
  const a = await corpoDoPedido(pronta, tipos(pronta.tipo, 2), { comprador });
  assert.equal((await c.post('/ticket/api/pedidos', a.corpo)).status, 201);
  const b = await corpoDoPedido(pronta, tipos(pronta.tipo, 1), {
    comprador: { ...apoio.pessoa('Outro'), cpf: comprador.cpf },
  });
  const r = await c.post('/ticket/api/pedidos', b.corpo);
  assert.equal(r.status, 409);
  assert.equal(r.json.codigo, 'limite');
  const outroCpf = await corpoDoPedido(pronta, tipos(pronta.tipo, 2));
  assert.equal((await c.post('/ticket/api/pedidos', outroCpf.corpo)).status, 201);
});

test('capacidade da edição é teto para pedido e cortesia', async () => {
  const pronta = await apoio.edicaoPronta({ capacidade: 3, lotes: [{ preco_centavos: 5000, quantidade: 10 }] });
  const c = apoio.cliente(srv);
  assert.equal(
    (await c.post('/ticket/api/pedidos', (await corpoDoPedido(pronta, tipos(pronta.tipo, 2))).corpo)).status,
    201,
  );
  const cheio = await c.post('/ticket/api/pedidos', (await corpoDoPedido(pronta, tipos(pronta.tipo, 2))).corpo);
  assert.equal(cheio.status, 409);
  assert.equal(cheio.json.codigo, 'esgotado');
  const cortesia = (chave) => ({
    ...apoio.pessoa('Convidado'),
    categoria_id: pronta.tipo.id,
    classificacao: 'convidado',
    chave,
  });
  await emissao.emitirCortesia(pronta.edicao.id, cortesia(apoio.chave()), apoio.AUTOR);
  await assert.rejects(
    emissao.emitirCortesia(pronta.edicao.id, cortesia(apoio.chave()), apoio.AUTOR),
    (err) => err.status === 409,
  );
});

test('última vaga: cinco pedidos ao mesmo tempo, só um reserva; o lote só ganha a marca quando é PAGO', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 1 }] });
  const corpos = await Promise.all(Array.from({ length: 5 }, () => corpoDoPedido(pronta, tipos(pronta.tipo, 1))));
  const respostas = await Promise.all(corpos.map(({ corpo }) => apoio.cliente(srv).post('/ticket/api/pedidos', corpo)));
  assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
  const marca = async () =>
    (await consultar('SELECT motivo_encerramento FROM lotes WHERE categoria_id = $1', [pronta.tipo.id])).rows[0]
      .motivo_encerramento;
  assert.equal(await marca(), null, 'só reservado: a reserva pode vencer e a vaga volta');
  await apoio.pagar(respostas.find((r) => r.status === 201).json.pedido_id);
  assert.equal(await marca(), 'esgotado');
  const { rows: m } = await consultar(
    "SELECT count(*)::int AS n FROM metricas WHERE nome = 'catalogo:lote_esgota' AND edicao_id = $1",
    [pronta.edicao.id],
  );
  assert.equal(m[0].n, 1);
});

test('reserva vencida devolve a vaga (mesmo no último lote) e o pedido expira', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 1 }] });
  const c = apoio.cliente(srv);
  const a = await c.post('/ticket/api/pedidos', (await corpoDoPedido(pronta, tipos(pronta.tipo, 1))).corpo);
  assert.equal(a.status, 201);
  // Sem vaga enquanto a reserva vale (a cotação já recusa).
  const b = await corpoDoPedido(pronta, tipos(pronta.tipo, 1)).catch((err) => err);
  assert.equal(b.status, 409);

  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [
    a.json.pedido_id,
  ]);
  const depois = await corpoDoPedido(pronta, tipos(pronta.tipo, 1));
  assert.equal((await c.post('/ticket/api/pedidos', depois.corpo)).status, 201, 'a vaga voltou');
  assert.equal(await pedidos.expirarVencidos(a.json.pedido_id), 1);
  const { rows } = await consultar('SELECT status FROM pedidos WHERE id = $1', [a.json.pedido_id]);
  assert.equal(rows[0].status, 'expirado');
});

test('combo consome o estoque real do tipo e respeita a capacidade', async () => {
  const pronta = await apoio.edicaoPronta({ capacidade: 4, lotes: [{ preco_centavos: 5000, quantidade: 3 }] });
  const combo = await promocoes.criarPromocao(
    pronta.edicao.id,
    {
      nome: 'Dupla',
      preco_total_centavos: 9001,
      quantidade: 5,
      itens: [{ categoria_id: pronta.tipo.id, quantidade: 2 }],
    },
    apoio.AUTOR,
  );
  const c = apoio.cliente(srv);
  const umCombo = await corpoDoPedido(pronta, { combos: [{ promocao_id: combo.id, quantidade: 1 }] });
  assert.equal(umCombo.cot.total_centavos, 9001);
  assert.equal(umCombo.cot.vagas.length, 2, 'cada posição do combo é uma vaga com participante');
  const r = await c.post('/ticket/api/pedidos', umCombo.corpo);
  assert.equal(r.status, 201, r.texto);

  // O combo tirou 2 do tipo: sobrou 1.
  const [tipo] = await catalogo.listarTipos(pronta.edicao.id);
  assert.equal(tipo.disponivel_agora, 1);
  const doisAvulsos = await corpoDoPedido(pronta, tipos(pronta.tipo, 2)).catch((err) => err);
  assert.equal(doisAvulsos.status, 409);
  const vitrine = await c.get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`);
  assert.equal(vitrine.json.combos[0].situacao, 'esgotada', 'não há 2 do tipo para outro combo');

  // Preço do combo dividido pelas posições, resto na primeira (soma exata).
  const { rows } = await consultar('SELECT valor_centavos FROM reservas WHERE pedido_id = $1 ORDER BY posicao', [
    r.json.pedido_id,
  ]);
  assert.deepEqual(
    rows.map((x) => Number(x.valor_centavos)),
    [4501, 4500],
  );
});

test('página do pedido: só com o token; QR só depois de pago e sem CPF', async () => {
  const pronta = await apoio.edicaoPronta();
  const c = apoio.cliente(srv);
  const { corpo } = await corpoDoPedido(pronta, tipos(pronta.tipo, 2));
  const r = await c.post('/ticket/api/pedidos', corpo);
  const id = r.json.pedido_id;

  assert.equal((await c.get(`/ticket/api/pedidos/${id}`)).status, 404, 'sem token');
  assert.equal(
    (await c.get(`/ticket/api/pedidos/${id}?t=${apoio.chave()}${apoio.chave()}`)).status,
    404,
    'token errado',
  );
  assert.equal((await c.get(`/ticket/api/pedidos/naoeuuid?t=${r.json.token}`)).status, 404);

  const aguardando = await c.get(`/ticket/api/pedidos/${id}`, { 'x-pedido-token': r.json.token });
  assert.equal(aguardando.status, 200);
  assert.equal(aguardando.json.pedido.status, 'aguardando_pagamento');
  assert.ok(aguardando.json.pagamento.url);
  assert.deepEqual(aguardando.json.ingressos, []);
  assert.equal(aguardando.headers.get('cache-control'), 'no-store');

  await pagar(id);
  const pago = await c.get(`/ticket/api/pedidos/${id}?t=${encodeURIComponent(r.json.token)}`);
  assert.equal(pago.json.pedido.status, 'pago');
  assert.equal(pago.json.pagamento, null);
  assert.equal(pago.json.ingressos.length, 2);
  for (const ing of pago.json.ingressos) {
    assert.match(ing.qr, /^data:image\/png;base64,/);
    assert.match(ing.codigo_curto, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  }
  assert.deepEqual(
    pago.json.ingressos.map((i) => i.participante).sort(),
    corpo.participantes.map((p) => p.nome).sort(),
  );
  for (const p of [corpo.comprador, ...corpo.participantes]) {
    assert.equal(pago.texto.includes(p.cpf), false, 'a página do pedido não mostra CPF');
  }
});

test('pedido de teste pelo Admin vale em rascunho e passa pelo mesmo estoque', async () => {
  const pronta = await apoio.edicaoPronta({ publicar: false, lotes: [{ preco_centavos: 5000, quantidade: 2 }] });
  const r = await pedidos.criarTeste(
    pronta.edicao.id,
    { itens: tipos(pronta.tipo, 1), comprador: apoio.pessoa('Equipe'), participantes: [apoio.pessoa('Equipe')] },
    apoio.AUTOR,
  );
  const { rows } = await consultar('SELECT origem, status FROM pedidos WHERE id = $1', [r.pedido_id]);
  assert.deepEqual(rows[0], { origem: 'teste', status: 'aguardando_pagamento' });
  const [tipo] = await catalogo.listarTipos(pronta.edicao.id);
  assert.equal(tipo.disponivel_agora, 1, 'o teste reserva estoque de verdade');
  // O público continua sem poder comprar em rascunho.
  const publico = await corpoDoPedido(pronta, tipos(pronta.tipo, 1)).catch((err) => err);
  assert.equal(publico.status, 409);
});
