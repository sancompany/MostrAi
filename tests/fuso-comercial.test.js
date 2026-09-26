const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const promocoesRepo = require('../src/financeiro/promocoes-repository');
const { instanteComercial, paredeComercial } = require('../src/lib/fuso-comercial');

// D3 (24/09/2026): data/hora comercial digitada no admin é horário de Matão.
// Antes, "31/10 23:59" virava 23:59 UTC e a promoção encerrava 20:59 daqui.

test('instanteComercial: parede sem fuso é lida como São Paulo (UTC−3)', () => {
  assert.strictEqual(instanteComercial('2026-10-31T00:00').toISOString(), '2026-10-31T03:00:00.000Z');
  assert.strictEqual(instanteComercial('2026-09-22T08:30').toISOString(), '2026-09-22T11:30:00.000Z');
  // 23:59 de Matão já é o dia seguinte em UTC.
  assert.strictEqual(instanteComercial('2026-10-31T23:59').toISOString(), '2026-11-01T02:59:00.000Z');
});

test('instanteComercial: fim é inclusivo no minuto (e no dia, se veio só a data)', () => {
  assert.strictEqual(instanteComercial('2026-10-31T23:59', { fim: true }).toISOString(), '2026-11-01T02:59:59.999Z');
  assert.strictEqual(instanteComercial('2026-10-31T00:00', { fim: true }).toISOString(), '2026-10-31T03:00:59.999Z');
  assert.strictEqual(instanteComercial('2026-10-31', { fim: true }).toISOString(), '2026-11-01T02:59:59.999Z');
  assert.strictEqual(instanteComercial('2026-10-31').toISOString(), '2026-10-31T03:00:00.000Z');
  // Segundos explícitos: é o instante pedido, sem estender.
  assert.strictEqual(instanteComercial('2026-10-31T23:59:30', { fim: true }).toISOString(), '2026-11-01T02:59:30.000Z');
});

test('instanteComercial: valor com fuso é instante e passa como veio; vazio vira null; ausente fica ausente', () => {
  assert.strictEqual(instanteComercial('2026-10-31T23:59:00.000Z').toISOString(), '2026-10-31T23:59:00.000Z');
  assert.strictEqual(
    instanteComercial('2026-10-31T23:59-03:00', { fim: true }).toISOString(),
    '2026-11-01T02:59:00.000Z',
  );
  const d = new Date('2026-10-01T12:00:00Z');
  assert.strictEqual(instanteComercial(d), d);
  assert.strictEqual(instanteComercial(''), null);
  assert.strictEqual(instanteComercial(null), null);
  assert.strictEqual(instanteComercial(undefined), undefined);
});

test('instanteComercial: data impossível é 400, não uma data "consertada"', () => {
  for (const ruim of ['2026-02-31T10:00', '2026-10-31T24:00', '31/10/2026', 'amanhã', '2026-13-01']) {
    assert.throws(
      () => instanteComercial(ruim, { campo: 'fim da compra' }),
      (err) => err.status === 400,
      ruim,
    );
  }
});

test('paredeComercial: o inverso, no formato do datetime-local — ida e volta não anda', () => {
  assert.strictEqual(paredeComercial('2026-11-01T02:59:59.999Z'), '2026-10-31T23:59');
  assert.strictEqual(paredeComercial('2026-10-31T03:00:00.000Z'), '2026-10-31T00:00');
  assert.strictEqual(paredeComercial(null), '');
  // Salvar sem mexer (o que fazia a mídia própria andar +3h por edição):
  let valor = instanteComercial('2026-09-23T01:30', { fim: true });
  for (let i = 0; i < 3; i++) valor = instanteComercial(paredeComercial(valor), { fim: true });
  assert.strictEqual(paredeComercial(valor), '2026-09-23T01:30');
});

test('promoção: janela digitada no admin persiste no relógio de Matão e vale até o minuto final', async () => {
  const agora = Date.now();
  const paredeDe = (ms) => paredeComercial(new Date(ms));
  const base = {
    titulo_publico: 'Janela de teste',
    publico_elegivel: 'todos',
    status: 'ativa',
    itens: [{ tier: 'maximo', compromissoMeses: 6, descontoPercentual: 5 }],
  };
  // Fim no minuto corrente: ainda vale (fim inclusivo); com a regra antiga
  // (parede lida como UTC) teria acabado 3h atrás.
  const noMinuto = await promocoesRepo.criar({
    ...base,
    nome_interno: `Teste fuso ${randomUUID()}`,
    compra_inicio: paredeDe(agora - 60 * 60 * 1000),
    compra_fim: paredeDe(agora),
  });
  // Fim um minuto atrás: já encerrou.
  const passou = await promocoesRepo.criar({
    ...base,
    nome_interno: `Teste fuso ${randomUUID()}`,
    compra_fim: paredeDe(agora - 2 * 60 * 1000),
  });
  // Início daqui a 2 minutos: ainda não começou.
  const futura = await promocoesRepo.criar({
    ...base,
    nome_interno: `Teste fuso ${randomUUID()}`,
    compra_inicio: paredeDe(agora + 2 * 60 * 1000),
  });
  try {
    const salva = await promocoesRepo.buscarPorId(noMinuto.id);
    assert.strictEqual(paredeComercial(salva.compra_fim), paredeDe(agora), 'o admin relê o que digitou');
    assert.strictEqual(new Date(salva.compra_fim).getUTCSeconds(), 59);
    assert.strictEqual(new Date(salva.compra_fim).getUTCMilliseconds(), 999);

    const vigentes = (await promocoesRepo.listarVigentes()).map((p) => p.id);
    assert.ok(vigentes.includes(noMinuto.id), 'fim no minuto corrente ainda vale');
    assert.ok(!vigentes.includes(passou.id), 'fim no minuto anterior já encerrou');
    assert.ok(!vigentes.includes(futura.id), 'início no futuro ainda não vale');

    // Editar sem mexer na data não desloca nada.
    await promocoesRepo.atualizar(noMinuto.id, { compra_fim: paredeComercial(salva.compra_fim) });
    const reeditada = await promocoesRepo.buscarPorId(noMinuto.id);
    assert.strictEqual(new Date(reeditada.compra_fim).getTime(), new Date(salva.compra_fim).getTime());

    // 00:00 e 23:59 do mesmo dia: início à meia-noite, fim no último minuto.
    await promocoesRepo.atualizar(futura.id, { compra_inicio: '2026-10-31T00:00', compra_fim: '2026-10-31T23:59' });
    const dia = await promocoesRepo.buscarPorId(futura.id);
    assert.strictEqual(new Date(dia.compra_inicio).toISOString(), '2026-10-31T03:00:00.000Z');
    assert.strictEqual(new Date(dia.compra_fim).toISOString(), '2026-11-01T02:59:59.999Z');

    // Limpar o campo = sem prazo.
    await promocoesRepo.atualizar(futura.id, { compra_inicio: '', compra_fim: null });
    const semPrazo = await promocoesRepo.buscarPorId(futura.id);
    assert.strictEqual(semPrazo.compra_inicio, null);
    assert.strictEqual(semPrazo.compra_fim, null);

    await assert.rejects(
      promocoesRepo.atualizar(futura.id, { compra_fim: '2026-02-30T10:00' }),
      (e) => e.status === 400,
    );
  } finally {
    await pool.query('DELETE FROM promocoes WHERE id = ANY($1)', [[noMinuto.id, passou.id, futura.id]]);
  }
});

// A renderização pública (Home, Planos, prévia e listas do admin) usa
// window.prazoBR de public/config.js. Carregado aqui num contexto mínimo,
// com o processo em UTC — o caso do servidor e de quem erra o fuso.
function carregarConfig() {
  const window = { location: { hostname: 'localhost', origin: 'http://localhost' }, fetch: () => {} };
  const documento = { addEventListener() {}, documentElement: {}, querySelectorAll: () => [] };
  const contexto = vm.createContext({
    window,
    document: documento,
    MutationObserver: class {
      observe() {}
    },
    setTimeout,
    clearTimeout,
    Intl,
    Date,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'config.js'), 'utf8'), contexto);
  return window;
}

test('prazoBR: prazo no relógio de Matão, com hora só quando não é o fim do dia', () => {
  const w = carregarConfig();
  // A pré-venda de produção antes da migration 085: aparecia "30/10".
  assert.strictEqual(w.prazoBR('2026-10-31T03:00:59.999Z'), '31/10/2026 às 00:00');
  assert.strictEqual(w.prazoBR('2026-11-01T02:59:59.999Z'), '31/10/2026');
  assert.strictEqual(w.prazoBR('2026-10-31T21:00:00.000Z'), '31/10/2026 às 18:00');
  // Início: meia-noite some, qualquer outra hora aparece.
  assert.strictEqual(w.prazoBR('2026-09-22T03:00:00.000Z', { inicio: true }), '22/09/2026');
  assert.strictEqual(w.prazoBR('2026-09-22T11:30:00.000Z', { inicio: true }), '22/09/2026 às 08:30');
  // Parede crua do datetime-local (prévia do admin): lida como está.
  assert.strictEqual(w.prazoBR('2026-10-31T23:59'), '31/10/2026');
  assert.strictEqual(w.prazoBR('2026-10-31T00:00'), '31/10/2026 às 00:00');
  assert.strictEqual(w.prazoBR(''), '');
  assert.strictEqual(w.paredeSP('2026-11-01T02:59:59.999Z'), '2026-10-31T23:59');
  assert.strictEqual(w.paredeSP(null), '');
});

test('condicaoDaPromocao: diz em que ciclos a promoção vale e até quando; sem vantagem nenhuma, não há banner (D1)', () => {
  const w = carregarConfig();
  const fim = '2026-10-31T03:00:59.999Z';
  assert.strictEqual(
    w.condicaoDaPromocao({ ciclosComVantagem: [3, 6], compra_fim: fim }),
    'Condição válida nos ciclos Trimestral e Semestral, até 31/10/2026 às 00:00.',
  );
  assert.strictEqual(w.condicaoDaPromocao({ ciclosComVantagem: [12] }), 'Condição válida no ciclo Anual.');
  assert.strictEqual(
    w.condicaoDaPromocao({ ciclosComVantagem: [1, 3, 6] }),
    'Condição válida nos ciclos Mensal, Trimestral e Semestral.',
  );
  assert.strictEqual(w.condicaoDaPromocao({ ciclosComVantagem: [], compra_fim: fim }), null);
  // Resposta sem o campo (versão anterior da API): só o prazo, como antes.
  assert.strictEqual(w.condicaoDaPromocao({ compra_fim: fim }), 'Condição válida até 31/10/2026 às 00:00.');
  assert.strictEqual(w.condicaoDaPromocao({}), '');
});
