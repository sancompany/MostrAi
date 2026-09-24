const test = require('node:test');
const assert = require('node:assert');
const v = require('../src/lib/vigencia');

// Régua única de vigência (consolidação final, 24/09/2026): o último dia da
// cobertura é inclusivo no relógio de Matão. 2026-09-30T02:30Z é 29/09 às
// 23:30 em Matão; 2026-09-30T03:00Z já é 30/09 00:00.
const NOITE_DO_29 = new Date('2026-09-30T02:30:00Z');
const MEIA_NOITE_DO_30 = new Date('2026-09-30T03:00:00Z');

test('hojeComercial: o dia é o de Matão, não o de UTC', () => {
  assert.equal(v.hojeComercial(NOITE_DO_29), '2026-09-29');
  assert.equal(v.hojeComercial(MEIA_NOITE_DO_30), '2026-09-30');
});

test('cobertura até 29/09 vale a noite inteira do 29 e cai à meia-noite de Matão', () => {
  assert.equal(v.coberturaVigente('2026-09-29', NOITE_DO_29), true);
  assert.equal(v.coberturaVigente('2026-09-29', MEIA_NOITE_DO_30), false);
  assert.equal(v.coberturaVencida('2026-09-29', MEIA_NOITE_DO_30), true);
  // A régua antiga (`new Date(date) >= agora`) dizia vencida às 21:00 do
  // dia 28 — 27 horas antes do combinado.
  assert.equal(new Date('2026-09-29') >= NOITE_DO_29, false, 'a régua antiga errava (prova do motivo)');
});

test('sem data: vigente, nunca vencida; Date é lido como o dia UTC do pg', () => {
  assert.equal(v.coberturaVigente(null), true);
  assert.equal(v.coberturaVencida(null), false);
  assert.equal(v.coberturaVigente(new Date('2026-09-29T00:00:00Z'), NOITE_DO_29), true);
  assert.equal(v.diaTexto('2026-09-29T00:00:00.000Z'), '2026-09-29');
});

test('diasAteVencer e somarDias contam por dia de Matão', () => {
  assert.equal(v.diasAteVencer('2026-09-29', NOITE_DO_29), 0);
  assert.equal(v.diasAteVencer('2026-09-29', MEIA_NOITE_DO_30), -1);
  assert.equal(v.diasAteVencer('2026-10-09', MEIA_NOITE_DO_30), 9);
  assert.equal(v.somarDias('2026-09-29', 2), '2026-10-01');
  assert.equal(v.vigenteSql('a.data_expiracao'), `(a.data_expiracao IS NULL OR a.data_expiracao >= ${v.HOJE_SQL})`);
});
