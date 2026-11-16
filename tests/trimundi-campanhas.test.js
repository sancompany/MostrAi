// Concorrência DE VERDADE: várias conexões ao mesmo tempo (a produção usa 1
// por instância, com 2 instâncias). Tem de vir antes de qualquer conexão.
process.env.TRIMUNDI_POOL_MAX = '8';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const apoio = require('./trimundi-apoio');
const { consultar, emTransacao } = require('../src/trimundi/db/conexao');
const campanhas = require('../src/trimundi/campanhas');
const indicacao = require('../src/trimundi/indicacao');
const pagamentos = require('../src/trimundi/pagamentos');
const promocoes = require('../src/trimundi/promocoes');

// Campanhas — PR 1 (banco e motor). Desenho aprovado em 16/11/2026
// (docs/trimundi/specs/2026-11-15-campanhas-desenho.md, C1–C7, R1–R3).
// Os 8 grupos pedidos pelo dono antes de concluir o PR:
//   1 ativação concorrente de campanhas de indicação (R1)
//   2 webhooks atrasados e reprocessados (R2, idempotência)
//   3 pagamentos durante pausa e encerramento (C6)
//   4 reembolso e nova compra (regra 1, R3)
//   5 progressão e regressão de níveis (C2)
//   6 indicações simultâneas
//   7 esgotamento simultâneo de estoque
//   8 integridade das posições e do histórico
// Mais: C1 (posição em todas, prêmio da vencedora), C3, C4 e a cópia das
// campanhas antigas (migration 016).

test.before(async () => {
  await apoio.prepararBanco();
});
test.after(async () => {
  await apoio.encerrar();
});

const AUTOR = apoio.AUTOR;
const pausa = (ms) => new Promise((r) => setTimeout(r, ms));

// O aviso de pagamento aplicado como a fila aplica (mesma função, mesma
// transação), sem passar pela tabela da fila: dá para disparar vários ao
// mesmo tempo, cada um na sua conexão.
const aplicar = (payload) => emTransacao((c) => pagamentos.aplicar(c, { evento_id: payload.eventoId, payload }));
const pagar = async (pedidoId, extra = {}) => aplicar(await apoio.aviso(pedidoId, 'confirmado', extra));
const estornar = async (pedidoId) => aplicar(await apoio.aviso(pedidoId, 'estornado'));

async function edicao() {
  return apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 500 }] });
}
async function pedido(pronta, quantidade = 1, extra = {}) {
  const r = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, quantidade), extra);
  return r.pedido_id;
}
async function ordemCompra(pronta, dados = {}, { ativar = true } = {}) {
  const c = await campanhas.criar(
    pronta.edicao.id,
    {
      modalidade: 'ordem_compra',
      nome: dados.nome || `Primeiros ${apoio.sufixo()}`,
      regras: 'Regulamento de teste.',
      faixas: dados.faixas || [{ de: 1, ate: 20, premio: 'Copão', custo_unitario_centavos: 1500 }],
      ...dados,
    },
    AUTOR,
  );
  return ativar ? ativarRevisada(c.id) : c;
}
// C7: só ativa com regulamento escrito e marcado como revisado pelo jurídico.
async function ativarRevisada(id) {
  await campanhas.marcarRegrasRevisadas(id, { revisor: 'Jurídico de teste' }, AUTOR);
  return campanhas.mudarStatus(id, 'ativar', AUTOR);
}
async function porIndicacao(pronta, dados = {}, { ativar = true } = {}) {
  const c = await campanhas.criar(
    pronta.edicao.id,
    {
      modalidade: 'indicacao',
      nome: dados.nome || `Indique ${apoio.sufixo()}`,
      regras: 'Regulamento de teste.',
      faixas: dados.faixas || [
        { de: 2, premio: 'Copão', custo_unitario_centavos: 1500 },
        { de: 4, premio: 'Camiseta', custo_unitario_centavos: 4000 },
      ],
      ...dados,
    },
    AUTOR,
  );
  return ativar ? ativarRevisada(c.id) : c;
}
const posicoes = async (campanhaId) =>
  (
    await consultar(
      `SELECT po.*, i.pedido_id AS ped FROM campanha_posicoes po JOIN ingressos i ON i.id = po.ingresso_id
        WHERE po.campanha_id = $1 ORDER BY po.posicao`,
      [campanhaId],
    )
  ).rows;
const premiosDa = async (campanhaId) =>
  (await consultar('SELECT * FROM campanha_premios WHERE campanha_id = $1 ORDER BY id', [campanhaId])).rows;
const eventosDo = async (premioId) =>
  (
    await consultar('SELECT acao, autor, motivo FROM campanha_premio_eventos WHERE premio_id = $1 ORDER BY id', [
      premioId,
    ])
  ).rows;
const ingressosDo = async (pedidoId) =>
  (await consultar('SELECT id FROM ingressos WHERE pedido_id = $1 ORDER BY id', [pedidoId])).rows.map((r) =>
    Number(r.id),
  );

// Indicador (conta) e indicados.
async function indicador() {
  const p = apoio.pessoa('Indicadora');
  const conta = await apoio.contaDe(p);
  const ind = await emTransacao((c) => indicacao.indicadorDoCliente(c, conta.id));
  return { pessoa: p, conta, id: Number(ind.id), codigo: ind.codigo };
}
async function indicado(pronta, codigo, { pagarJa = true } = {}) {
  const pid = await pedido(pronta, 1, { comprador: apoio.pessoa('Indicado'), indicacao: codigo });
  if (pagarJa) await pagar(pid);
  return pid;
}
const premiosDoIndicador = async (campanhaId, indicadorId) =>
  (
    await consultar(
      `SELECT pr.*, f.de FROM campanha_premios pr JOIN campanha_faixas f ON f.id = pr.faixa_id
        WHERE pr.campanha_id = $1 AND pr.indicador_id = $2 ORDER BY f.de, pr.repeticao NULLS FIRST`,
      [campanhaId, indicadorId],
    )
  ).rows;
const estado = (lista) => lista.map((p) => [p.de, p.status]);

// ====================================================================== 1
test('1. R1 — duas ativações simultâneas de campanhas de indicação não acumuláveis: uma passa, a outra é barrada', async () => {
  const pronta = await edicao();
  const a = await porIndicacao(pronta, {}, { ativar: false });
  const b = await porIndicacao(pronta, {}, { ativar: false });
  for (const x of [a, b]) await campanhas.marcarRegrasRevisadas(x.id, { revisor: 'Jurídico de teste' }, AUTOR);
  const r = await Promise.allSettled([
    campanhas.mudarStatus(a.id, 'ativar', AUTOR),
    campanhas.mudarStatus(b.id, 'ativar', AUTOR),
  ]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'uma ativa');
  const barrada = r.find((x) => x.status === 'rejected').reason;
  assert.equal(barrada.status, 409);
  assert.equal(barrada.extra?.codigo, 'indicacao_exclusiva');
  assert.match(barrada.message, /outra campanha de indicação não acumulável ativa/);
  const { rows } = await consultar(
    "SELECT count(*)::int AS n FROM campanhas WHERE edicao_id = $1 AND status = 'ativa' AND modalidade = 'indicacao'",
    [pronta.edicao.id],
  );
  assert.equal(rows[0].n, 1);

  // Acumulável e ordem de compra seguem livres.
  await porIndicacao(pronta, { acumula: true });
  await ordemCompra(pronta);
  // Pausando a ativa, a outra pode ativar; e a primeira não volta junto.
  const ativa = r.find((x) => x.status === 'fulfilled').value;
  const outra = ativa.id === a.id ? b : a;
  await campanhas.mudarStatus(ativa.id, 'pausar', AUTOR);
  assert.equal((await campanhas.mudarStatus(outra.id, 'ativar', AUTOR)).status, 'ativa');
  await assert.rejects(campanhas.mudarStatus(ativa.id, 'retomar', AUTOR), (e) => e.status === 409);
  // O banco também barra direto (sem passar pelo serviço).
  await assert.rejects(
    consultar("UPDATE campanhas SET status = 'ativa' WHERE id = $1", [ativa.id]),
    (e) => e.code === '23505',
  );
});

// ====================================================================== 2
test('2. Webhooks reprocessados: o mesmo aviso 3 vezes (e 2 ao mesmo tempo) não muda nada', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta);
  const ind = await indicador();
  const camp = await porIndicacao(pronta, { faixas: [{ de: 1, premio: 'Copão' }] });
  const pid = await pedido(pronta, 2, { comprador: apoio.pessoa('Bia'), indicacao: ind.codigo });
  const aviso = await apoio.aviso(pid, 'confirmado');
  await aplicar(aviso);
  const foto = async () =>
    JSON.stringify({
      ingressos: await ingressosDo(pid),
      posicoes: (await posicoes(c.id)).map((p) => [p.posicao, p.ingresso_id, p.resultado]),
      premios: (await premiosDa(c.id)).map((p) => [p.chave, p.status]),
      indicacao: (await premiosDa(camp.id)).map((p) => [p.chave, p.status]),
      conversoes: (
        await consultar('SELECT count(*)::int AS n FROM campanha_indicacoes WHERE campanha_id = $1', [camp.id])
      ).rows[0].n,
      eventos: (
        await consultar(
          'SELECT count(*)::int AS n FROM campanha_premio_eventos e JOIN campanha_premios p ON p.id = e.premio_id WHERE p.campanha_id = ANY($1::bigint[])',
          [[c.id, camp.id]],
        )
      ).rows[0].n,
      proxima: (await campanhas.obter(c.id)).proxima_posicao,
    });
  const antes = await foto();
  assert.equal(await aplicar(aviso), 'ja_aplicado');
  await aplicar(aviso);
  await Promise.all([aplicar(aviso), aplicar(aviso)]);
  assert.equal(await foto(), antes, 'nada muda');
  // O mesmo eventoId na fila é recusado na entrada.
  assert.equal(
    (await pagamentos.registrarEvento({ eventoId: aviso.eventoId, provedor: 'teste', payload: aviso })).novo,
    true,
  );
  assert.equal(
    (await pagamentos.registrarEvento({ eventoId: aviso.eventoId, provedor: 'teste', payload: aviso })).novo,
    false,
  );
  await apoio.aguardarEvento(aviso.eventoId);
  assert.equal(await foto(), antes, 'nem pela fila');
});

test('2. Webhook atrasado (R2): vale o instante em que a TICK aplica — a hora do Checkout fica só para auditoria', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta, { inicio: new Date(Date.now() - 60000).toISOString() });
  // Pago "no Checkout" 1 h antes do início da campanha, mas o aviso só chega
  // agora: entra, porque o instante oficial é o da TICK.
  const atrasado = await pedido(pronta);
  const horaCheckout = new Date(Date.now() - 3600000).toISOString();
  await pagar(atrasado, { ocorridoEm: horaCheckout });
  // A posição é dada no instante da aplicação (ordem de aplicação).
  const [p1] = await posicoes(c.id);
  assert.equal(p1.ped, atrasado);
  assert.equal(new Date(p1.confirmado_no_checkout_em).toISOString(), horaCheckout, 'hora do Checkout preservada');
  const { rows } = await consultar('SELECT pago_em FROM pedidos WHERE id = $1', [atrasado]);
  assert.equal(new Date(p1.confirmado_em).getTime(), new Date(rows[0].pago_em).getTime(), 'instante oficial = pago_em');
  assert.ok(new Date(p1.confirmado_em) > new Date(horaCheckout));

  // Campanha que acabou antes da aplicação: não entra, mesmo com a hora do
  // Checkout dentro da janela.
  const curta = await ordemCompra(pronta, { fim: new Date(Date.now() + 1500).toISOString() });
  const tarde = await pedido(pronta);
  const dentroDaJanela = new Date().toISOString();
  await pausa(1700);
  await pagar(tarde, { ocorridoEm: dentroDaJanela });
  assert.deepEqual(
    (await posicoes(curta.id)).map((p) => p.ped),
    [],
    'aplicado depois do fim: fora (R2)',
  );
});

// ====================================================================== 3
test('3. Pausa e encerramento (C6): pausado não ocupa posição; retomada continua do contador; encerrada não reabre', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta);
  const ind = await indicador();
  const camp = await porIndicacao(pronta, { faixas: [{ de: 1, premio: 'Copão' }] });
  const a = await pedido(pronta);
  await pagar(a);
  await campanhas.mudarStatus(c.id, 'pausar', AUTOR);
  await campanhas.mudarStatus(camp.id, 'pausar', AUTOR);
  const naPausa = await pedido(pronta, 1, { comprador: apoio.pessoa('Na pausa'), indicacao: ind.codigo });
  await pagar(naPausa);
  await campanhas.mudarStatus(c.id, 'retomar', AUTOR);
  await campanhas.mudarStatus(camp.id, 'retomar', AUTOR);
  const b = await pedido(pronta);
  await pagar(b);
  assert.deepEqual(
    (await posicoes(c.id)).map((p) => [p.posicao, p.ped]),
    [
      [1, a],
      [2, b],
    ],
    'o pago na pausa ficou sem posição; a retomada continuou da 2',
  );
  assert.equal(
    (await consultar('SELECT count(*)::int AS n FROM campanha_indicacoes WHERE campanha_id = $1', [camp.id])).rows[0].n,
    0,
    'indicação paga na pausa não conta',
  );
  // Pausar no meio de confirmações simultâneas: sem erro, sem buraco.
  const lote = await Promise.all([1, 2, 3, 4].map(() => pedido(pronta)));
  await Promise.all([...lote.map((p) => pagar(p)), campanhas.mudarStatus(c.id, 'pausar', AUTOR)]);
  const depois = (await posicoes(c.id)).map((p) => p.posicao);
  assert.deepEqual(
    depois,
    depois.map((_, i) => i + 1),
    'posições contínuas',
  );
  await campanhas.mudarStatus(c.id, 'encerrar', AUTOR);
  const encerrado = await pedido(pronta);
  await pagar(encerrado);
  assert.equal((await posicoes(c.id)).length, depois.length, 'encerrada não atribui');
  await assert.rejects(campanhas.mudarStatus(c.id, 'retomar', AUTOR), (e) => e.status === 409);
  await assert.rejects(
    consultar("UPDATE campanhas SET status = 'ativa', encerrada_em = NULL WHERE id = $1", [c.id]),
    /não reabre/,
  );
});

// ====================================================================== 4
test('4. Reembolso e nova compra (regra 1, C3, R3): posição fica, prêmio não passa adiante; a mesma conta pode voltar a ganhar', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta, {
    limite_por_pessoa: 1,
    faixas: [{ de: 1, ate: 10, premio: 'Copão', custo_unitario_centavos: 1500 }],
  });
  const ana = apoio.pessoa('Ana');
  const primeiro = await pedido(pronta, 1, { comprador: ana });
  await pagar(primeiro);
  const segundo = await pedido(pronta, 1, { comprador: ana });
  await pagar(segundo);
  // C3: o titular do 2º é outra pessoa, mas quem compra é a mesma conta.
  let pos = await posicoes(c.id);
  assert.deepEqual(
    pos.map((p) => [p.posicao, p.resultado]),
    [
      [1, 'premiado'],
      [2, 'limite_por_pessoa'],
    ],
  );
  await estornar(primeiro);
  const [premio1] = await premiosDa(c.id);
  assert.equal(premio1.status, 'revogado');
  assert.equal(premio1.motivo, 'ingresso reembolsado');
  pos = await posicoes(c.id);
  assert.deepEqual(
    pos.map((p) => [p.posicao, p.resultado]),
    [
      [1, 'premiado'],
      [2, 'limite_por_pessoa'],
    ],
    'a posição 1 fica (imutável) e a 2 não herda nada',
  );
  // R3: a próxima compra da mesma conta volta a ganhar (só prêmio de pé conta).
  const terceiro = await pedido(pronta, 1, { comprador: ana });
  await pagar(terceiro);
  const outraConta = await pedido(pronta, 1, { comprador: apoio.pessoa('Bia') });
  await pagar(outraConta);
  pos = await posicoes(c.id);
  assert.deepEqual(
    pos.map((p) => [p.posicao, p.resultado]),
    [
      [1, 'premiado'],
      [2, 'limite_por_pessoa'],
      [3, 'premiado'],
      [4, 'premiado'],
    ],
  );
  // Histórico do prêmio revogado preservado inteiro.
  assert.deepEqual(
    (await eventosDo(premio1.id)).map((e) => [e.acao, e.motivo]),
    [
      ['concedido', 'posição 1'],
      ['revogado', 'ingresso reembolsado'],
    ],
  );
  // Prêmio já ENTREGUE e depois reembolsado: fica, com alerta (uma vez só).
  const daBia = (await premiosDa(c.id)).find((p) => Number(p.posicao_id) === Number(pos[3].id));
  await emTransacao((cl) => campanhas.entregarPremio(cl, daBia.id, { autor: 'teste', via: 'admin' }));
  await estornar(outraConta);
  await estornar(outraConta);
  const entregue = (await consultar('SELECT status FROM campanha_premios WHERE id = $1', [daBia.id])).rows[0];
  assert.equal(entregue.status, 'entregue', 'entregue nunca é revogado');
  assert.deepEqual(
    (await eventosDo(daBia.id)).map((e) => e.acao),
    ['concedido', 'entregue', 'alerta'],
  );
});

test('4. Estoque da faixa menor que a largura: prêmio revogado não devolve estoque (a posição não passa adiante)', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta, { faixas: [{ de: 1, ate: 10, premio: 'Copão', estoque: 2 }] });
  const um = await pedido(pronta);
  await pagar(um);
  await estornar(um);
  for (const _ of [1, 2]) await pagar(await pedido(pronta));
  assert.deepEqual(
    (await posicoes(c.id)).map((p) => p.resultado),
    ['premiado', 'premiado', 'sem_estoque'],
  );
});

// ====================================================================== 5
test('5. Níveis (C2, maior_nivel): retirou o de baixo → leva o de cima também; não retirou → substituído; regressão restaura a MESMA linha', async () => {
  const pronta = await edicao();
  const camp = await porIndicacao(pronta); // 2: Copão; 4: Camiseta
  // Ana: retira o Copão antes de chegar no 4.
  const ana = await indicador();
  await indicado(pronta, ana.codigo);
  assert.deepEqual(estado(await premiosDoIndicador(camp.id, ana.id)), [], '1 indicação não libera');
  await indicado(pronta, ana.codigo);
  let lista = await premiosDoIndicador(camp.id, ana.id);
  assert.deepEqual(estado(lista), [[2, 'concedido']]);
  await emTransacao((c) => campanhas.entregarPremio(c, lista[0].id, { autor: 'teste', via: 'admin' }));
  const pedidosAna = [await indicado(pronta, ana.codigo), await indicado(pronta, ana.codigo)];
  lista = await premiosDoIndicador(camp.id, ana.id);
  assert.deepEqual(
    estado(lista),
    [
      [2, 'entregue'],
      [4, 'concedido'],
    ],
    'C2: recebe também o nível superior',
  );
  // Regressão: o de cima (não entregue) sai; o entregue fica.
  await estornar(pedidosAna[1]);
  assert.deepEqual(estado(await premiosDoIndicador(camp.id, ana.id)), [
    [2, 'entregue'],
    [4, 'revogado'],
  ]);

  // Caio: chega ao 4 sem retirar o Copão → substituído; regressão restaura.
  const caio = await indicador();
  for (const _ of [1, 2]) await indicado(pronta, caio.codigo);
  const copao = (await premiosDoIndicador(camp.id, caio.id))[0];
  const terceiro = await indicado(pronta, caio.codigo);
  const quarto = await indicado(pronta, caio.codigo);
  lista = await premiosDoIndicador(camp.id, caio.id);
  assert.deepEqual(estado(lista), [
    [2, 'revogado'],
    [4, 'concedido'],
  ]);
  assert.match(lista[0].motivo, /substituído pelo nível de 4/);
  const camiseta = lista[1];
  await estornar(quarto);
  lista = await premiosDoIndicador(camp.id, caio.id);
  assert.deepEqual(estado(lista), [
    [2, 'concedido'],
    [4, 'revogado'],
  ]);
  assert.equal(Number(lista[0].id), Number(copao.id), 'restaurado na mesma linha');
  // Volta a 4 com uma indicação nova: a Camiseta volta, na mesma linha.
  await indicado(pronta, caio.codigo);
  lista = await premiosDoIndicador(camp.id, caio.id);
  assert.deepEqual(estado(lista), [
    [2, 'revogado'],
    [4, 'concedido'],
  ]);
  assert.equal(Number(lista[1].id), Number(camiseta.id));
  assert.equal(lista.length, 2, 'uma linha por nível');
  assert.deepEqual(
    (await eventosDo(camiseta.id)).map((e) => e.acao),
    ['concedido', 'revogado', 'restaurado'],
  );
  assert.ok(terceiro);
});

test('5. Níveis (cumulativa) e nível que se repete (formato de antes)', async () => {
  const pronta = await edicao();
  const cum = await porIndicacao(pronta, { escada: 'cumulativa', acumula: true });
  const rep = await porIndicacao(pronta, {
    acumula: true,
    limite_por_pessoa: 2,
    faixas: [{ de: 2, repete: true, premio: 'Copo', estoque: 50 }],
  });
  const ana = await indicador();
  const pedidos = [];
  for (const _ of [1, 2, 3, 4, 5, 6]) pedidos.push(await indicado(pronta, ana.codigo));
  assert.deepEqual(estado(await premiosDoIndicador(cum.id, ana.id)), [
    [2, 'concedido'],
    [4, 'concedido'],
  ]);
  const reps = await premiosDoIndicador(rep.id, ana.id);
  assert.deepEqual(
    reps.map((p) => [p.repeticao, p.status]),
    [
      [1, 'concedido'],
      [2, 'concedido'],
    ],
    'a cada 2, até o limite de 2',
  );
  for (const p of pedidos.slice(2)) await estornar(p);
  assert.deepEqual(estado(await premiosDoIndicador(cum.id, ana.id)), [
    [2, 'concedido'],
    [4, 'revogado'],
  ]);
  assert.deepEqual(
    (await premiosDoIndicador(rep.id, ana.id)).map((p) => [p.repeticao, p.status]),
    [
      [1, 'concedido'],
      [2, 'revogado'],
    ],
  );
});

// ====================================================================== 6
test('6. Indicações simultâneas: o nível é concedido uma vez só; a mesma pessoa conta uma vez', async () => {
  const pronta = await edicao();
  const camp = await porIndicacao(pronta); // 2 e 4
  const ana = await indicador();
  await indicado(pronta, ana.codigo);
  // 3 indicados pagando ao mesmo tempo: de 1 para 4.
  const juntos = await Promise.all([1, 2, 3].map(() => indicado(pronta, ana.codigo, { pagarJa: false })));
  await Promise.all(juntos.map((p) => pagar(p)));
  const lista = await premiosDoIndicador(camp.id, ana.id);
  assert.deepEqual(estado(lista), [
    [2, 'revogado'],
    [4, 'concedido'],
  ]);
  assert.equal(lista.length, 2);
  // A mesma pessoa, dois pedidos pagos ao mesmo tempo: conta uma vez.
  const bia = await indicador();
  const comprador = apoio.pessoa('Mesma');
  const p1 = await pedido(pronta, 1, { comprador, indicacao: bia.codigo });
  await pagar(p1);
  const p2 = await pedido(pronta, 1, { comprador, indicacao: bia.codigo });
  await Promise.all([pagar(p2), pagar(p2)]);
  const { rows } = await consultar(
    'SELECT count(*)::int AS n FROM campanha_indicacoes WHERE campanha_id = $1 AND indicador_id = $2 AND valida',
    [camp.id, bia.id],
  );
  assert.equal(rows[0].n, 1);
});

// ====================================================================== 7
test('7. Esgotamento simultâneo: 12 pagamentos ao mesmo tempo, estoque 5 → posições 1..12 sem buraco, 5 prêmios', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta, { faixas: [{ de: 1, ate: 50, premio: 'Copão', estoque: 5 }] });
  const pedidos = await Promise.all(Array.from({ length: 12 }, () => pedido(pronta)));
  await Promise.all(pedidos.map((p) => pagar(p)));
  const pos = await posicoes(c.id);
  assert.deepEqual(
    pos.map((p) => p.posicao),
    Array.from({ length: 12 }, (_, i) => i + 1),
  );
  assert.equal(new Set(pos.map((p) => p.ingresso_id)).size, 12, 'um ingresso por posição');
  assert.deepEqual(
    pos.map((p) => p.resultado),
    [...Array(5).fill('premiado'), ...Array(7).fill('sem_estoque')],
  );
  assert.equal((await premiosDa(c.id)).length, 5);
  // A ordem das posições é a ordem do instante oficial (pago_em).
  const instantes = pos.map((p) => new Date(p.confirmado_em).getTime());
  assert.deepEqual(
    instantes,
    [...instantes].sort((a, b) => a - b),
  );
  assert.equal((await campanhas.obter(c.id)).proxima_posicao, 13);
});

test('7. Nível de indicação com estoque 1: dois indicadores chegando juntos → um prêmio', async () => {
  const pronta = await edicao();
  const camp = await porIndicacao(pronta, { faixas: [{ de: 1, premio: 'Único', estoque: 1 }] });
  const [ana, bia] = [await indicador(), await indicador()];
  const pa = await indicado(pronta, ana.codigo, { pagarJa: false });
  const pb = await indicado(pronta, bia.codigo, { pagarJa: false });
  await Promise.all([pagar(pa), pagar(pb)]);
  const todos = await premiosDa(camp.id);
  assert.equal(todos.filter((p) => campanhas.DE_PE.includes(p.status)).length, 1);
});

// ===================================================================== C1
test('C1: posição em todas as campanhas; prêmio só da vencedora; acumulável soma sem repetir o brinde; reembolso não passa prêmio à perdedora', async () => {
  const pronta = await edicao();
  const a = await ordemCompra(pronta, { faixas: [{ de: 1, ate: 2, premio: 'Copão', custo_unitario_centavos: 1500 }] });
  const b = await ordemCompra(pronta, {
    faixas: [{ de: 1, ate: 5, premio: 'Pulseira', custo_unitario_centavos: 500 }],
  });
  const ac = await ordemCompra(pronta, {
    acumula: true,
    faixas: [{ de: 1, ate: 5, premio: 'Adesivo', custo_unitario_centavos: 100 }],
  });
  const repetido = await ordemCompra(pronta, {
    acumula: true,
    faixas: [{ de: 1, ate: 5, premio: 'copão', custo_unitario_centavos: 50 }],
  });
  const pedidos = [];
  for (const _ of [1, 2, 3]) {
    const p = await pedido(pronta);
    await pagar(p);
    pedidos.push(p);
  }
  const posA = await posicoes(a.id);
  const posB = await posicoes(b.id);
  assert.deepEqual(
    posA.map((p) => [p.posicao, p.resultado]),
    [
      [1, 'premiado'],
      [2, 'premiado'],
      [3, 'sem_faixa'],
    ],
  );
  assert.deepEqual(
    posB.map((p) => [p.posicao, p.resultado, p.vencedora_id && Number(p.vencedora_id)]),
    [
      [1, 'nao_acumulavel', Number(a.id)],
      [2, 'nao_acumulavel', Number(a.id)],
      [3, 'premiado', null],
    ],
    'posição em B também; prêmio só de A, que vale mais',
  );
  assert.deepEqual(
    (await posicoes(ac.id)).map((p) => p.resultado),
    ['premiado', 'premiado', 'premiado'],
    'acumulável soma',
  );
  assert.deepEqual(
    (await posicoes(repetido.id)).map((p) => p.resultado),
    ['nao_acumulavel', 'nao_acumulavel', 'premiado'],
    'mesmo brinde (Copão) não se repete no ingresso',
  );
  // Reembolso do 1º: o Copão de A é revogado e B NÃO passa a premiar.
  await estornar(pedidos[0]);
  assert.equal((await premiosDa(a.id))[0].status, 'revogado');
  assert.equal((await premiosDa(b.id)).length, 1, 'B segue com 1 prêmio (o do 3º)');
  assert.deepEqual(
    (await posicoes(b.id)).map((p) => p.resultado),
    ['nao_acumulavel', 'nao_acumulavel', 'premiado'],
  );
  // Desempate por prioridade quando o valor empata.
  const prontaB = await edicao();
  const x = await ordemCompra(prontaB, {
    prioridade: 1,
    faixas: [{ de: 1, ate: 1, premio: 'X', custo_unitario_centavos: 100 }],
  });
  const y = await ordemCompra(prontaB, {
    prioridade: 5,
    faixas: [{ de: 1, ate: 1, premio: 'Y', custo_unitario_centavos: 100 }],
  });
  await pagar(await pedido(prontaB));
  assert.equal((await premiosDa(y.id)).length, 1);
  assert.equal((await premiosDa(x.id)).length, 0);
});

test('C4/inclui_combos/cortesia/teste: só ingresso pago e elegível entra; combo pode ficar de fora', async () => {
  const pronta = await edicao();
  const combo = await promocoes.criarPromocao(
    pronta.edicao.id,
    {
      nome: 'Dupla',
      preco_total_centavos: 9000,
      quantidade: 5,
      itens: [{ categoria_id: pronta.tipo.id, quantidade: 2 }],
    },
    AUTOR,
  );
  const com = await ordemCompra(pronta);
  const sem = await ordemCompra(pronta, { inclui_combos: false });
  const doCombo = (await apoio.novoPedido(pronta, { combos: [{ promocao_id: combo.id, quantidade: 1 }] })).pedido_id;
  await pagar(doCombo);
  const avulso = await pedido(pronta, 2);
  await pagar(avulso);
  const pendente = await pedido(pronta);
  assert.ok(pendente);
  assert.equal((await posicoes(com.id)).length, 4, 'combo (2) + avulso (2): cada ingresso uma posição');
  assert.deepEqual(
    (await posicoes(sem.id)).map((p) => p.ped),
    [avulso, avulso],
    'sem combos',
  );
  // Ingressos do mesmo pedido em posições seguidas, na ordem da numeração.
  const pos = await posicoes(com.id);
  assert.deepEqual(
    pos.slice(2).map((p) => Number(p.ingresso_id)),
    await ingressosDo(avulso),
  );
});

// ====================================================================== 8
test('8. Integridade pelo banco: posição imutável e única, prêmio único/exclusivo, entregue final, histórico só de acréscimo, contador só cresce', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta);
  const p = await pedido(pronta);
  await pagar(p);
  const [pos] = await posicoes(c.id);
  const [pr] = await premiosDa(c.id);
  const recusa = (sql, params, re) => assert.rejects(consultar(sql, params), re);
  await recusa('UPDATE campanha_posicoes SET posicao = 99 WHERE id = $1', [pos.id], /histórico e não muda/);
  await recusa('DELETE FROM campanha_posicoes WHERE id = $1', [pos.id], /histórico e não muda/);
  await recusa(
    `INSERT INTO campanha_posicoes (campanha_id, posicao, ingresso_id, pedido_id, resultado, confirmado_em)
     VALUES ($1, $2, $3, $4, 'sem_faixa', now())`,
    [c.id, pos.posicao, pos.ingresso_id, pos.pedido_id],
    (e) => e.code === '23505',
  );
  await recusa('DELETE FROM campanha_premios WHERE id = $1', [pr.id], /não se apaga/);
  await recusa(
    `INSERT INTO campanha_premios (campanha_id, faixa_id, ingresso_id, premio, brinde, quantidade, valor_centavos, exclusivo, chave)
     VALUES ($1, $2, $3, 'X', 'n:outro', 1, 0, true, $4)`,
    [c.id, pr.faixa_id, pr.ingresso_id, `teste:${apoio.sufixo()}`],
    (e) => e.code === '23505' && /ux_premio_exclusivo/.test(e.constraint),
  );
  await recusa(
    `INSERT INTO campanha_premios (campanha_id, faixa_id, ingresso_id, premio, brinde, quantidade, valor_centavos, exclusivo, chave)
     VALUES ($1, $2, $3, 'X', $4, 1, 0, false, $5)`,
    [c.id, pr.faixa_id, pr.ingresso_id, pr.brinde, `teste:${apoio.sufixo()}`],
    (e) => e.code === '23505' && /ux_premio_brinde/.test(e.constraint),
  );
  await recusa(
    `INSERT INTO campanha_premios (campanha_id, faixa_id, ingresso_id, premio, brinde, quantidade, valor_centavos, exclusivo, chave)
     VALUES ($1, $2, $3, 'X', 'n:y', 1, 0, false, $4)`,
    [c.id, pr.faixa_id, pr.ingresso_id, pr.chave],
    (e) => e.code === '23505',
  );
  await emTransacao((cl) => campanhas.entregarPremio(cl, pr.id, { autor: 'teste', via: 'admin' }));
  await recusa(
    "UPDATE campanha_premios SET status = 'revogado', revogado_em = now() WHERE id = $1",
    [pr.id],
    /entregue é final/,
  );
  await recusa(
    'UPDATE campanha_premios SET chave = $2 WHERE id = $1',
    [pr.id, 'pos:outra'],
    /entregue é final|identidade/,
  );
  const [ev] = (await consultar('SELECT id FROM campanha_premio_eventos WHERE premio_id = $1', [pr.id])).rows;
  await recusa("UPDATE campanha_premio_eventos SET motivo = 'x' WHERE id = $1", [ev.id], /histórico e não muda/);
  await recusa('DELETE FROM campanha_premio_eventos WHERE id = $1', [ev.id], /histórico e não muda/);
  await recusa('UPDATE campanhas SET proxima_posicao = 1 WHERE id = $1', [c.id], /só cresce/);
  await recusa('DELETE FROM campanhas WHERE id = $1', [c.id], /histórico e não muda/);
  // Faixas que se sobrepõem são recusadas.
  await assert.rejects(
    campanhas.criar(
      pronta.edicao.id,
      {
        modalidade: 'ordem_compra',
        nome: 'Sobreposta',
        faixas: [
          { de: 1, ate: 10, premio: 'A' },
          { de: 5, ate: 20, premio: 'B' },
        ],
      },
      AUTOR,
    ),
    /sobrepor/,
  );
  // Entrega dupla: a segunda diz "já entregue"; uma linha de "entregue".
  const r2 = await emTransacao((cl) => campanhas.entregarPremio(cl, pr.id, { autor: 'teste', via: 'admin' }));
  assert.equal(r2.resultado, 'ja_entregue');
  assert.deepEqual(
    (await eventosDo(pr.id)).map((e) => e.acao),
    ['concedido', 'entregue'],
  );
  // Toda mudança de status tem o seu evento (amostra de toda a base de teste).
  const { rows: semEvento } = await consultar(
    `SELECT p.id FROM campanha_premios p
      WHERE (p.status = 'entregue' AND NOT EXISTS (SELECT 1 FROM campanha_premio_eventos e WHERE e.premio_id = p.id AND e.acao = 'entregue'))
         OR (p.status = 'revogado' AND NOT EXISTS (SELECT 1 FROM campanha_premio_eventos e WHERE e.premio_id = p.id AND e.acao = 'revogado'))
         OR NOT EXISTS (SELECT 1 FROM campanha_premio_eventos e WHERE e.premio_id = p.id AND e.acao = 'concedido')
      LIMIT 5`,
  );
  assert.deepEqual(semEvento, []);
});

test('8. Prazo de retirada vencido: o prêmio expira e não é entregue', async () => {
  const pronta = await edicao();
  const c = await ordemCompra(pronta, { prazo_retirada: new Date(Date.now() + 1200).toISOString() });
  await pagar(await pedido(pronta));
  const [pr] = await premiosDa(c.id);
  await pausa(1400);
  await assert.rejects(
    emTransacao((cl) => campanhas.entregarPremio(cl, pr.id, { autor: 'teste', via: 'admin' })),
    (e) => e.status === 409,
  );
  // A recusa desfaz a transação; a varredura marca como expirado.
  await campanhas.expirarVencidos();
  const depois = (await consultar('SELECT status FROM campanha_premios WHERE id = $1', [pr.id])).rows[0];
  assert.equal(depois.status, 'expirado');
  assert.deepEqual(
    (await eventosDo(pr.id)).map((e) => e.acao),
    ['concedido', 'expirado'],
  );
});

// ================================================================ 016
test('Migration 016: campanha antiga copiada com os mesmos ids, as recompensas viram prêmios com histórico; as tabelas antigas ficam intactas', async () => {
  const pronta = await edicao();
  const ana = await indicador();
  const bia = await apoio.contaDe(apoio.pessoa('Bia'));
  const pid = await pedido(pronta, 1, { comprador: apoio.pessoa('Bia2') });
  const sql = fs.readFileSync(
    path.join(__dirname, '../src/trimundi/db/migrations/016_indicacao_nas_campanhas.sql'),
    'utf8',
  );
  // Só a parte de cópia (a tabela nova já existe neste banco).
  const copia = sql.slice(sql.indexOf('-- Campanhas (mesmos ids)'));
  const ID = 900000000 + Math.floor(Math.random() * 90000000);
  const Desfazer = class extends Error {};
  await emTransacao(async (c) => {
    await c.query(
      `INSERT INTO campanhas_indicacao (id, edicao_id, nome, recompensa, quantidade, indicacoes_por_recompensa,
                                        limite_por_indicador, ativo)
       VALUES ($1, $2, 'Antiga', 'Copo personalizado', 10, 2, 3, false)`,
      [ID, pronta.edicao.id],
    );
    await c.query('INSERT INTO indicacoes (campanha_id, indicador_id, pedido_id, cliente_id) VALUES ($1, $2, $3, $4)', [
      ID,
      ana.id,
      pid,
      bia.id,
    ]);
    await c.query(
      `INSERT INTO recompensas_indicacao (campanha_id, indicador_id, status, concedida_em, entregue_em, entregue_por)
       VALUES ($1, $2, 'entregue', now() - interval '2 hours', now() - interval '1 hour', 'admin@teste'),
              ($1, $2, 'concedida', now() - interval '30 minutes', NULL, NULL)`,
      [ID, ana.id],
    );
    const antes = (await c.query('SELECT count(*)::int AS n FROM recompensas_indicacao WHERE campanha_id = $1', [ID]))
      .rows[0].n;
    // As tabelas antigas, filtradas para esta campanha (temporárias têm
    // precedência no search_path), alimentam a cópia da migration.
    for (const t of ['campanhas_indicacao', 'indicacoes', 'recompensas_indicacao']) {
      await c.query(
        `CREATE TEMP TABLE ${t} ON COMMIT DROP AS SELECT * FROM trimundi.${t} WHERE campanha_id = $1`.replace(
          'campanha_id = $1',
          t === 'campanhas_indicacao' ? `id = ${ID}` : `campanha_id = ${ID}`,
        ),
      );
    }
    await c.query(copia);
    const camp = (await c.query('SELECT * FROM campanhas WHERE id = $1', [ID])).rows[0];
    assert.deepEqual(
      [camp.modalidade, camp.status, camp.escada, camp.limite_por_pessoa, camp.acumula],
      ['indicacao', 'pausada', 'cumulativa', 3, false],
    );
    const f = (await c.query('SELECT * FROM campanha_faixas WHERE campanha_id = $1', [ID])).rows;
    assert.deepEqual(
      f.map((x) => [x.de, x.repete, x.premio, x.estoque]),
      [[2, true, 'Copo personalizado', 10]],
    );
    const pr = (await c.query('SELECT * FROM campanha_premios WHERE campanha_id = $1 ORDER BY repeticao', [ID])).rows;
    assert.deepEqual(
      pr.map((x) => [x.repeticao, x.status, x.entregue_por]),
      [
        [1, 'entregue', 'admin@teste'],
        [2, 'concedido', null],
      ],
    );
    const evs = (
      await c.query(
        'SELECT e.acao FROM campanha_premio_eventos e JOIN campanha_premios p ON p.id = e.premio_id WHERE p.campanha_id = $1 ORDER BY e.id',
        [ID],
      )
    ).rows.map((x) => x.acao);
    assert.deepEqual(evs.sort(), ['concedido', 'concedido', 'entregue']);
    assert.equal(
      (await c.query('SELECT count(*)::int AS n FROM campanha_indicacoes WHERE campanha_id = $1', [ID])).rows[0].n,
      1,
    );
    assert.equal(
      (await c.query('SELECT count(*)::int AS n FROM trimundi.recompensas_indicacao WHERE campanha_id = $1', [ID]))
        .rows[0].n,
      antes,
      'tabela antiga intacta',
    );
    throw new Desfazer();
  }).catch((e) => {
    if (!(e instanceof Desfazer)) throw e;
  });
});
