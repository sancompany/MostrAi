const test = require('node:test');
const assert = require('node:assert');

const { conferirSenha } = require('../src/lib/senha');
const { limiteTentativas } = require('../src/lib/limite-tentativas');
const { webhookAutorizado } = require('../src/financeiro/san-checkout');

test('regra de senha é a mesma em todo lugar', () => {
  assert.ok(conferirSenha('1'), 'senha de 1 caractere tem que ser recusada');
  assert.ok(conferirSenha('senha123'), 'sem maiúscula e sem símbolo tem que ser recusada');
  assert.ok(conferirSenha('Senha123'), 'sem símbolo tem que ser recusada');
  assert.strictEqual(conferirSenha('Senha12@'), null);
});

// A falha original: sem SAN_CHECKOUT_WEBHOOK_SECRET configurado, o webhook
// aceitava qualquer POST e dava pra ativar uma conta sem pagar.
test('webhook falha fechado quando o segredo não está configurado', () => {
  delete process.env.SAN_CHECKOUT_WEBHOOK_SECRET;
  assert.strictEqual(webhookAutorizado({ headers: {} }), false);
  assert.strictEqual(webhookAutorizado({ headers: { 'x-webhook-secret': 'chute' } }), false);
});

test('webhook só aceita o segredo exato', () => {
  process.env.SAN_CHECKOUT_WEBHOOK_SECRET = 'segredo-de-verdade';
  assert.strictEqual(webhookAutorizado({ headers: {} }), false);
  assert.strictEqual(webhookAutorizado({ headers: { 'x-webhook-secret': 'segredo-de-verdad' } }), false);
  assert.strictEqual(webhookAutorizado({ headers: { 'x-webhook-secret': 'segredo-de-verdade' } }), true);
  delete process.env.SAN_CHECKOUT_WEBHOOK_SECRET;
});

test('limite de tentativas bloqueia depois de 10 na mesma janela', () => {
  let passou = 0; let bloqueado = 0;
  for (let i = 0; i < 13; i += 1) {
    const res = { setHeader() {}, status() { return this; }, json() { bloqueado += 1; } };
    limiteTentativas({ ip: '9.9.9.9', path: '/teste-limite' }, res, () => { passou += 1; });
  }
  assert.strictEqual(passou, 10);
  assert.strictEqual(bloqueado, 3);
});
