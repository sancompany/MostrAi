const test = require('node:test');
const assert = require('node:assert');
const { calcularPlaylist, contarPorAnunciante, LIMITE_SLOTS_PROGRAMADOS } = require('../src/lib/pacing');

test('aplica a frequência base sem déficit', () => {
  const itens = calcularPlaylist([{ id: 1, frequenciaBase: 3, deficit: 0 }]);
  assert.strictEqual(itens.length, 3);
  assert.strictEqual(contarPorAnunciante(itens)[1], 3);
});

test('compensa quem ficou devendo na hora anterior', () => {
  const itens = calcularPlaylist([{ id: 1, frequenciaBase: 3, deficit: 2 }]);
  assert.strictEqual(contarPorAnunciante(itens)[1], 5);
});

test('trava de segurança nunca deixa passar do limite de slots', () => {
  const anunciantes = Array.from({ length: 50 }, (_, i) => ({ id: i, frequenciaBase: 12, deficit: 0 }));
  const itens = calcularPlaylist(anunciantes);
  assert.ok(itens.length <= LIMITE_SLOTS_PROGRAMADOS);
});

const { dividirCota } = require('../src/lib/pacing');

test('cota de autoanúncio do ponto é dividida entre as telas', () => {
  assert.strictEqual(dividirCota(6, 2), 3);
  assert.strictEqual(dividirCota(6, 4), 2, 'arredonda pra cima');
  assert.strictEqual(dividirCota(6, 1), 6);
  assert.strictEqual(dividirCota(0, 3), 0, 'cota zero continua zero');
  assert.strictEqual(dividirCota(5, 0), 5, 'sem tela ativa conta como uma');
});

test('dono do ponto entra na playlist como item próprio sem virar anunciante', () => {
  const itens = calcularPlaylist([{ id: 1, frequenciaBase: 2, deficit: 0 }, { id: 'dono', frequenciaBase: 3, deficit: 0 }]);
  const contagem = contarPorAnunciante(itens);
  assert.strictEqual(contagem[1], 2);
  assert.strictEqual(contagem.dono, 3);
});
