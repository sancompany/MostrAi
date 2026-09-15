const test = require('node:test');
const assert = require('node:assert');

const { arredondar, multiplicar, percentual } = require('../src/lib/dinheiro');

// A falha original: 89.10 * 3 em JavaScript dá 267.29999999999995 — e esse é
// o valor que ia gravado em cobrancas_confirmadas e enviado ao San Checkout
// como o `valor` a cobrar na Asaas.
test('multiplicar não acumula erro de ponto flutuante', () => {
  assert.strictEqual(multiplicar(89.1, 3), 267.3);
  assert.strictEqual(multiplicar(349.9, 12), 4198.8);
  assert.strictEqual(multiplicar(0.1, 3), 0.3); // o clássico 0.1+0.1+0.1 !== 0.3
});

test('percentual arredonda em centavos, não em float', () => {
  assert.strictEqual(percentual(267.3, 10), 26.73);
  assert.strictEqual(percentual(1000, 10), 100);
});

test('arredondar corta pra 2 casas', () => {
  assert.strictEqual(arredondar(267.299999999999), 267.3);
});
