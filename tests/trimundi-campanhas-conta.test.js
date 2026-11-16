process.env.TRIMUNDI_POOL_MAX = '8';

const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar, emTransacao } = require('../src/trimundi/db/conexao');
const pagamentos = require('../src/trimundi/pagamentos');
const campanhas = require('../src/trimundi/campanhas');
const indicacao = require('../src/trimundi/indicacao');

// Campanhas — PR 3 (portaria e Minha Conta): o brinde de primeiros N aparece
// na leitura do PRÓPRIO ingresso e sai uma vez só pela rota única de prêmio
// (com operador, data e hora; várias portarias ao mesmo tempo); a recompensa
// de indicação continua só no ingresso principal; a de operador, só pelo
// Admin. Minha Conta mostra níveis, progresso, posições e histórico — só da
// própria conta.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const aplicar = (payload) => emTransacao((c) => pagamentos.aplicar(c, { evento_id: payload.eventoId, payload }));
const pagar = async (pedidoId) => aplicar(await apoio.aviso(pedidoId, 'confirmado'));
async function edicao() {
  return apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 200 }] });
}
async function ativa(pronta, dados) {
  const c = await campanhas.criar(pronta.edicao.id, { regras: 'Regulamento de teste.', ...dados }, apoio.AUTOR);
  await campanhas.marcarRegrasRevisadas(c.id, { revisor: 'Jurídico de teste' }, apoio.AUTOR);
  return campanhas.mudarStatus(c.id, 'ativar', apoio.AUTOR);
}
const primeiros = (pronta, extra = {}) =>
  ativa(pronta, {
    modalidade: 'ordem_compra',
    nome: `Primeiros ${apoio.sufixo()}`,
    faixas: [{ de: 1, ate: 10, premio: 'Copão', custo_unitario_centavos: 1500 }],
    ...extra,
  });
async function ingressosDo(pedidoId) {
  const { rows } = await consultar('SELECT id, codigo_curto FROM ingressos WHERE pedido_id = $1 ORDER BY id', [
    pedidoId,
  ]);
  return rows;
}
async function portaria(pronta) {
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const c = apoio.cliente(srv, { cookie: op.cookie });
  const ed = pronta.edicao.id;
  return {
    op,
    ler: async (codigo) => (await c.post('/ticket/api/checkin/consultar', { edicao_id: ed, entrada: codigo })).json,
    entregar: (ingressoId, premioId) =>
      c.post('/ticket/api/checkin/premio', { edicao_id: ed, ingresso_id: ingressoId, premio_id: premioId }),
    validar: (id) => c.post('/ticket/api/checkin/confirmar', { edicao_id: ed, ingresso_id: id }),
  };
}

test('portaria: o brinde de primeiros N aparece no próprio ingresso e sai uma vez só, com operador, data e hora', async () => {
  const pronta = await edicao();
  const camp = await primeiros(pronta);
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2));
  await pagar(ped.pedido_id);
  const [um, dois] = await ingressosDo(ped.pedido_id);
  const p = await portaria(pronta);
  const lido = await p.ler(um.codigo_curto);
  assert.equal(lido.ingresso.premios_campanha.length, 1);
  const [pr] = lido.ingresso.premios_campanha;
  assert.deepEqual([pr.nome, pr.campanha, pr.posicao, pr.status], ['Copão', camp.nome, 1, 'concedido']);
  // O prêmio do ingresso 1 não sai pela leitura do ingresso 2.
  const errado = await p.entregar(dois.id, pr.id);
  assert.equal(errado.status, 404);
  // Entrega antes da entrada: vale (independente).
  const ok = await p.entregar(um.id, pr.id);
  assert.equal(ok.status, 200, ok.texto);
  assert.deepEqual([ok.json.resultado, ok.json.entregue_por], ['entregue', p.op.nome]);
  assert.equal((await p.entregar(um.id, pr.id)).json.resultado, 'ja_entregue');
  const depois = (await p.ler(um.codigo_curto)).ingresso;
  assert.equal(depois.premios_campanha[0].status, 'entregue');
  assert.equal(depois.premios_campanha[0].entregue_por, p.op.nome);
  assert.equal(depois.utilizado_em, null, 'entregar não registra entrada');
  const ev = (
    await consultar('SELECT acao, autor FROM campanha_premio_eventos WHERE premio_id = $1 ORDER BY id', [pr.id])
  ).rows;
  assert.deepEqual(
    ev.map((e) => [e.acao, e.autor]),
    [
      ['concedido', 'pagamento'],
      ['entregue', `operador:${p.op.id}`],
    ],
  );
});

test('portaria: três portarias entregando o mesmo brinde ao mesmo tempo → uma entrega, um evento', async () => {
  const pronta = await edicao();
  await primeiros(pronta);
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await pagar(ped.pedido_id);
  const [ing] = await ingressosDo(ped.pedido_id);
  const portarias = [await portaria(pronta), await portaria(pronta), await portaria(pronta)];
  const [pr] = (await portarias[0].ler(ing.codigo_curto)).ingresso.premios_campanha;
  const r = await Promise.all(portarias.map((x) => x.entregar(ing.id, pr.id)));
  assert.deepEqual(
    r.map((x) => x.status),
    [200, 200, 200],
  );
  assert.equal(r.filter((x) => x.json.resultado === 'entregue').length, 1);
  const { rows } = await consultar(
    "SELECT count(*)::int AS n FROM campanha_premio_eventos WHERE premio_id = $1 AND acao = 'entregue'",
    [pr.id],
  );
  assert.equal(rows[0].n, 1);
});

test('portaria: ingresso bloqueado não entrega; prazo vencido aparece EXPIRADO e não entrega', async () => {
  const pronta = await edicao();
  await primeiros(pronta, { prazo_retirada: new Date(Date.now() + 1500).toISOString() });
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2));
  await pagar(ped.pedido_id);
  const [um, dois] = await ingressosDo(ped.pedido_id);
  const p = await portaria(pronta);
  const [pr1] = (await p.ler(um.codigo_curto)).ingresso.premios_campanha;
  await consultar("UPDATE ingressos SET status = 'bloqueado', motivo_status = 'teste' WHERE id = $1", [um.id]);
  assert.equal((await p.entregar(um.id, pr1.id)).status, 409);
  const [pr2] = (await p.ler(dois.codigo_curto)).ingresso.premios_campanha;
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal((await p.entregar(dois.id, pr2.id)).status, 409);
  await campanhas.expirarVencidos();
  assert.equal((await p.ler(dois.codigo_curto)).ingresso.premios_campanha[0].status, 'expirado');
});

test('portaria: indicação pela rota única só no ingresso principal; recompensa de operador nunca (só Admin)', async () => {
  const pronta = await edicao();
  await ativa(pronta, { modalidade: 'indicacao', nome: 'Indique', faixas: [{ de: 1, premio: 'Pulseira' }] });
  const ana = apoio.pessoa('Ana');
  const conta = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const { codigo } = (await conta.get('/ticket/api/conta')).json.indicacao;
  const dela = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2), {
    comprador: ana,
    participantes: [{ conta: true }, apoio.pessoa('Amigo')],
  });
  await pagar(dela.pedido_id);
  const bia = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: apoio.pessoa('Bia'),
    indicacao: codigo,
  });
  await pagar(bia.pedido_id);
  const [principal, outro] = await ingressosDo(dela.pedido_id);
  const p = await portaria(pronta);
  const [rec] = (await p.ler(principal.codigo_curto)).ingresso.recompensas_indicacao;
  assert.equal((await p.entregar(outro.id, rec.id)).status, 409, 'só no principal');
  const ok = await p.entregar(principal.id, rec.id);
  assert.equal(ok.json.resultado, 'entregue');
  // Operador indicador: o prêmio dele é só pelo Admin, mesmo se alguém tentar
  // pela rota da portaria com o id.
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const cOp = apoio.cliente(srv, { cookie: op.cookie });
  const codigoOp = (await cOp.get('/ticket/api/operador')).json.indicacao.codigo;
  const amigo = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: apoio.pessoa('Amigo'),
    indicacao: codigoOp,
  });
  await pagar(amigo.pedido_id);
  const { rows } = await consultar(
    'SELECT pr.id FROM campanha_premios pr JOIN indicadores i ON i.id = pr.indicador_id WHERE i.operador_id = $1',
    [op.id],
  );
  const r = await p.entregar(principal.id, rows[0].id);
  assert.equal(r.status, 409);
  assert.match(r.json.erro, /só pelo Admin/);
  assert.ok(indicacao);
});

test('Minha Conta: níveis, progresso, posições, prêmios por ingresso e histórico — só da própria conta', async () => {
  const pronta = await edicao();
  await primeiros(pronta, { faixas: [{ de: 1, ate: 2, premio: 'Copão' }] });
  await ativa(pronta, {
    modalidade: 'indicacao',
    nome: 'Indique e ganhe',
    acumula: true,
    faixas: [
      { de: 2, premio: 'Copão' },
      { de: 4, premio: 'Camiseta' },
    ],
  });
  const ana = apoio.pessoa('Ana');
  const conta = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const { codigo } = (await conta.get('/ticket/api/conta')).json.indicacao;
  const dela = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 3), {
    comprador: ana,
    participantes: [{ conta: true }, apoio.pessoa('Amigo'), apoio.pessoa('Amiga')],
  });
  await pagar(dela.pedido_id);
  // 3 indicados pagos: nível 2 (Copão) atingido; faltam 1 para a Camiseta.
  for (const n of ['Bia', 'Caio', 'Duda']) {
    const x = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
      comprador: apoio.pessoa(n),
      indicacao: codigo,
    });
    await pagar(x.pedido_id);
  }
  // A portaria entrega o Copão do 1º ingresso da Ana.
  const [i1] = await ingressosDo(dela.pedido_id);
  const p = await portaria(pronta);
  const [pr] = (await p.ler(i1.codigo_curto)).ingresso.premios_campanha;
  await p.entregar(i1.id, pr.id);

  const d = (await conta.get('/ticket/api/conta')).json;
  const promo = d.promocoes;
  assert.deepEqual(
    promo.posicoes.map((x) => [x.posicao, x.resultado, x.premio?.status || null]),
    [
      [1, 'premiado', 'entregue'],
      [2, 'premiado', 'concedido'],
      [3, 'sem_faixa', null],
    ],
  );
  const ind = promo.indicacao.find(
    (c) => c.campanha === 'Indique e ganhe' && c.evento.startsWith(pronta.edicao.evento.nome),
  );
  assert.equal(ind.indicacoes, 3);
  assert.deepEqual(ind.proximo, { de: 4, premio: 'Camiseta', faltam: 1 });
  assert.deepEqual(
    ind.niveis.map((n) => [n.de, n.atingido, n.premios.map((x) => x.status)]),
    [
      [2, true, ['concedido']],
      [4, false, []],
    ],
  );
  assert.ok(promo.historico.some((h) => h.acao === 'retirado' && h.quem === 'portaria' && h.premio === 'Copão'));
  assert.ok(promo.historico.some((h) => h.acao === 'liberado'));
  // No cartão do ingresso: o brinde de campanha dele.
  const todos = d.edicoes.flatMap((g) => g.pedidos).flatMap((x) => x.ingressos);
  const comBrinde = todos.filter((i) => i.premios_campanha.length);
  assert.equal(comBrinde.length, 2);
  // Nada dos indicados (outras contas) nem CPF na resposta.
  const json = JSON.stringify(promo);
  assert.equal(json.includes('Bia') || json.includes('Caio'), false);
  // Outra conta não vê nada disso.
  const caio = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, apoio.pessoa('Outra')) });
  const delaNao = (await caio.get('/ticket/api/conta')).json.promocoes;
  assert.deepEqual(delaNao.posicoes, []);
  assert.deepEqual(delaNao.historico, []);
});
