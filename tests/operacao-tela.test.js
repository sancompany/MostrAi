const test = require('node:test');
const assert = require('node:assert');
const { operacaoDoPonto, deveriaOperar } = require('../src/lib/operacao-tela');

// Mesma regra que o contrato pede ao Player (docs/player-mvp-contract.md §6):
// o backend precisa dizer "fora do horário" exatamente quando o Player apaga.
// 2026-09-25 é sexta; 2026-12-25 (Natal) é sexta.
const SP = (iso) => new Date(`${iso}-03:00`);
const op = (porDiaDaSemana, feriados = {}, timezone = 'America/Sao_Paulo') => ({
  timezone,
  porDiaDaSemana,
  feriados,
});

test('sem faixa nenhuma ou sem operação: sempre dentro (na dúvida, acende)', () => {
  const agora = SP('2026-09-25T03:00:00');
  assert.equal(deveriaOperar(op({}), agora), true);
  assert.equal(deveriaOperar(null, agora), true);
});

test('início inclusivo, fim exclusivo; dia sem faixa = fechado', () => {
  const o = op({ sex: [{ inicio: '09:00', fim: '18:00' }], sab: [] });
  assert.equal(deveriaOperar(o, SP('2026-09-25T09:00:00')), true);
  assert.equal(deveriaOperar(o, SP('2026-09-25T17:59:00')), true);
  assert.equal(deveriaOperar(o, SP('2026-09-25T18:00:00')), false);
  assert.equal(deveriaOperar(o, SP('2026-09-26T12:00:00')), false, 'sábado: lista vazia');
  assert.equal(deveriaOperar(o, SP('2026-09-27T12:00:00')), false, 'domingo ausente do mapa: fechado');
});

test('faixa que cruza a meia-noite pertence ao dia em que começa (BUG-026 do Player)', () => {
  const o = op({ sex: [{ inicio: '22:00', fim: '02:00' }], sab: [], qui: [] });
  assert.equal(deveriaOperar(o, SP('2026-09-25T23:00:00')), true, 'sexta 23h');
  assert.equal(deveriaOperar(o, SP('2026-09-26T01:30:00')), true, 'madrugada de sábado');
  assert.equal(deveriaOperar(o, SP('2026-09-26T02:00:00')), false);
  assert.equal(deveriaOperar(o, SP('2026-09-25T01:00:00')), false, 'madrugada de sexta é da quinta (fechada)');
});

test('feriado sobrepõe o dia inteiro, inclusive a madrugada da véspera; lista vazia fecha', () => {
  const o = op(
    { qui: [{ inicio: '22:00', fim: '02:00' }], sex: [{ inicio: '00:00', fim: '24:00' }] },
    { '2026-12-25': [] },
  );
  assert.equal(
    deveriaOperar(o, SP('2026-12-25T01:00:00')),
    false,
    'madrugada do Natal: feriado vence a faixa de quinta',
  );
  assert.equal(deveriaOperar(o, SP('2026-12-25T12:00:00')), false);
  assert.equal(deveriaOperar(o, SP('2026-12-18T12:00:00')), true, 'sexta comum: 00:00–24:00');
});

test('faixas presentes mas ilegíveis = dia aceso; HH:MM:SS aceito; início = fim é faixa vazia', () => {
  assert.equal(deveriaOperar(op({ sex: [{ inicio: 'x', fim: 'y' }] }), SP('2026-09-25T03:00:00')), true);
  assert.equal(deveriaOperar(op({ sex: [{ inicio: '09:00:00', fim: '10:00:30' }] }), SP('2026-09-25T09:30:00')), true);
  assert.equal(deveriaOperar(op({ sex: [{ inicio: '09:00', fim: '09:00' }] }), SP('2026-09-25T09:00:00')), false);
});

test('o fuso do bloco vale: 09:00 em Manaus é 10:00 em São Paulo', () => {
  const o = op({ sex: [{ inicio: '09:00', fim: '10:00' }] }, {}, 'America/Manaus');
  assert.equal(deveriaOperar(o, SP('2026-09-25T10:30:00')), true);
  assert.equal(deveriaOperar(o, SP('2026-09-25T09:30:00')), false);
});

test('operacaoDoPonto: horário do ponto vira o bloco do contrato, 7 dias + feriados', () => {
  const horario = {
    seg: { abre: '09:00', fecha: '18:00' },
    ter: null,
    sex: { abre: '20:00', fecha: '02:00' },
    feriados: null,
  };
  const agora = SP('2026-09-25T12:00:00');
  const p = operacaoDoPonto(horario, agora);
  assert.deepEqual(Object.keys(p).sort(), ['feriados', 'porDiaDaSemana', 'timezone'], 'sem regime');
  assert.equal(p.timezone, 'America/Sao_Paulo');
  assert.deepEqual(Object.keys(p.porDiaDaSemana), ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom']);
  assert.deepEqual(p.porDiaDaSemana.seg, [{ inicio: '09:00', fim: '18:00' }]);
  assert.deepEqual(p.porDiaDaSemana.ter, [], 'null = fechado, lista vazia explícita');
  assert.deepEqual(p.porDiaDaSemana.qua, [{ inicio: '00:00', fim: '24:00' }], 'dia não informado não apaga a tela');
  assert.deepEqual(p.porDiaDaSemana.sex, [{ inicio: '20:00', fim: '02:00' }]);
  assert.deepEqual(p.feriados['2026-12-25'], [], 'feriados nacionais materializados');
  assert.ok(p.feriados['2028-01-01'], 'dois anos à frente');
  const semFeriado = operacaoDoPonto({ sex: { abre: '20:00', fecha: '02:00' } }, agora);
  assert.deepEqual(semFeriado.feriados, {}, 'sem "feriados" no horário, nenhum dia é sobreposto');
});

test('ponto sem horário cadastrado = aberto 24 h, todos os dias', () => {
  const p = operacaoDoPonto(null, SP('2026-09-25T12:00:00'));
  for (const dia of ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom']) {
    assert.deepEqual(p.porDiaDaSemana[dia], [{ inicio: '00:00', fim: '24:00' }]);
  }
  assert.deepEqual(p.feriados, {});
  assert.equal(deveriaOperar(p, SP('2026-09-27T03:00:00')), true, 'domingo de madrugada');
});

test('ponto 24 h (00:00–24:00) opera o dia inteiro, inclusive 23:59 e 00:00', () => {
  const vinte4 = { abre: '00:00', fecha: '24:00' };
  const horario = Object.fromEntries(['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((d) => [d, vinte4]));
  const p = operacaoDoPonto(horario, SP('2026-09-25T12:00:00'));
  assert.equal(deveriaOperar(p, SP('2026-09-25T00:00:00')), true);
  assert.equal(deveriaOperar(p, SP('2026-09-25T23:59:00')), true);
  assert.equal(deveriaOperar(p, SP('2026-09-26T00:00:00')), true);
});

test('fechar à meia-noite (18:00 → 00:00) opera até 23:59 e fecha à 00:00', () => {
  const p = operacaoDoPonto({ sex: { abre: '18:00', fecha: '00:00' }, sab: null }, SP('2026-09-25T12:00:00'));
  assert.equal(deveriaOperar(p, SP('2026-09-25T17:59:00')), false);
  assert.equal(deveriaOperar(p, SP('2026-09-25T23:59:00')), true);
  assert.equal(deveriaOperar(p, SP('2026-09-26T00:00:00')), false);
});
