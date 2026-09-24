const test = require('node:test');
const assert = require('node:assert');
const { validar, resumo, DIAS } = require('../src/lib/horario-semanal');

// Horário de funcionamento do ponto, por dia da semana (migration 066,
// 22/09/2026, pedido do dono).

test('validar() aceita null (campo não informado)', () => {
  assert.strictEqual(validar(null), null);
  assert.strictEqual(validar(undefined), null);
});

test('validar() aceita um dia fechado (null) e um dia com horário', () => {
  const horario = {
    seg: { abre: '09:00', fecha: '18:00' },
    ter: null,
    qua: null,
    qui: null,
    sex: null,
    sab: null,
    dom: null,
  };
  const validado = validar(horario);
  assert.deepStrictEqual(validado.seg, { abre: '09:00', fecha: '18:00' });
  assert.strictEqual(validado.ter, null);
});

test('validar() recusa formato que não é objeto', () => {
  assert.throws(() => validar('segunda a sexta'), /formato inválido/);
  assert.throws(() => validar(['seg']), /formato inválido/);
});

test('validar() recusa hora fora do padrão HH:MM', () => {
  const base = Object.fromEntries(DIAS.map((d) => [d, null]));
  assert.throws(() => validar({ ...base, seg: { abre: '9h', fecha: '18:00' } }), /segunda inválido/);
  assert.throws(() => validar({ ...base, sab: { abre: '09:00', fecha: '25:00' } }), /sábado inválido/);
});

test('validar() aceita abre > fecha (vira madrugada — bar/balada 18:00-02:00)', () => {
  const base = Object.fromEntries(DIAS.map((d) => [d, null]));
  const validado = validar({ ...base, sex: { abre: '18:00', fecha: '02:00' } });
  assert.deepStrictEqual(validado.sex, { abre: '18:00', fecha: '02:00' });
});

test('validar() recusa abre === fecha (ambíguo)', () => {
  const base = Object.fromEntries(DIAS.map((d) => [d, null]));
  assert.throws(() => validar({ ...base, dom: { abre: '09:00', fecha: '09:00' } }), /não pode ser igual/);
});

test('resumo() agrupa segunda a sexta quando os 5 dias são iguais', () => {
  const mesmo = { abre: '09:00', fecha: '18:00' };
  const horario = {
    seg: mesmo,
    ter: mesmo,
    qua: mesmo,
    qui: mesmo,
    sex: mesmo,
    sab: { abre: '09:00', fecha: '15:00' },
    dom: null,
  };
  assert.strictEqual(resumo(horario), 'Seg-sex 09:00-18:00 · Sáb 09:00-15:00 · Dom fechado');
});

test('resumo() cai pra dia a dia quando a semana diverge', () => {
  const horario = {
    seg: { abre: '09:00', fecha: '18:00' },
    ter: { abre: '09:00', fecha: '18:00' },
    qua: null,
    qui: { abre: '09:00', fecha: '18:00' },
    sex: { abre: '09:00', fecha: '18:00' },
    sab: null,
    dom: null,
  };
  assert.strictEqual(
    resumo(horario),
    'segunda 09:00-18:00 · terça 09:00-18:00 · quarta fechado · quinta 09:00-18:00 · sexta 09:00-18:00 · Sáb fechado · Dom fechado',
  );
});

test('resumo() de null é null (ponto sem horário informado)', () => {
  assert.strictEqual(resumo(null), null);
});

// "Deveria estar operando agora?" saiu daqui (Player V2, 24/09/2026): a regra
// única é src/lib/operacao-tela.js, espelho do Player — testada em
// tests/operacao-tela.test.js (fuso, madrugada, feriado).
