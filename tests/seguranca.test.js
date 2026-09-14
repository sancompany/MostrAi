const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { conferirSenha } = require('../src/lib/senha');
const { limiteTentativas } = require('../src/lib/limite-tentativas');
const { webhookAutorizado } = require('../src/financeiro/san-checkout');

test('regra de senha é a mesma em todo lugar', () => {
  assert.ok(conferirSenha('1'), 'senha de 1 caractere tem que ser recusada');
  assert.ok(conferirSenha('senha123'), 'sem maiúscula e sem símbolo tem que ser recusada');
  assert.ok(conferirSenha('Senha123'), 'sem símbolo tem que ser recusada');
  assert.strictEqual(conferirSenha('Senha12@'), null);
});

// O webhook do San Checkout é autenticado por assinatura HMAC, não por um
// header de segredo compartilhado (API.md dele, 4.3.1). Estes testes assinam
// do mesmo jeito que o Checkout assina — `sha256=` + HMAC-SHA256 hex sobre
// "{timestamp}.{corpo cru}", com a X-Checkout-Key como segredo — e exercitam
// os quatro passos que o contrato exige na verificação.
const CHAVE = 'chave-do-contratante-mostrai';

function assinar(corpoCru, { chave = CHAVE, timestamp } = {}) {
  const t = timestamp === undefined ? Math.floor(Date.now() / 1000) : timestamp;
  const hex = crypto.createHmac('sha256', chave).update(`${t}.${corpoCru}`).digest('hex');
  return {
    rawBody: Buffer.from(corpoCru, 'utf8'),
    headers: { 'x-checkout-signature': `sha256=${hex}`, 'x-checkout-timestamp': String(t) },
  };
}

const CORPO = JSON.stringify({ versao: 1, tipo: 'assinatura', planoId: 'ass-1', documento: '111', evento: 'criada' });

test('webhook falha fechado quando a chave não está configurada', () => {
  delete process.env.SAN_CHECKOUT_KEY;
  assert.strictEqual(webhookAutorizado({ headers: {} }), false);
  assert.strictEqual(webhookAutorizado(assinar(CORPO)), false, 'sem chave no ambiente nada pode passar');
});

test('webhook aceita a notificação assinada pelo Checkout', () => {
  process.env.SAN_CHECKOUT_KEY = CHAVE;
  assert.strictEqual(webhookAutorizado(assinar(CORPO)), true);
  delete process.env.SAN_CHECKOUT_KEY;
});

test('webhook recusa assinatura feita com outra chave', () => {
  process.env.SAN_CHECKOUT_KEY = CHAVE;
  assert.strictEqual(webhookAutorizado(assinar(CORPO, { chave: 'chave-de-outro-contratante' })), false);
  assert.strictEqual(webhookAutorizado({ ...assinar(CORPO), headers: { 'x-checkout-signature': 'sha256=00', 'x-checkout-timestamp': String(Math.floor(Date.now() / 1000)) } }), false);
  delete process.env.SAN_CHECKOUT_KEY;
});

// Passo 1 do API.md 4.3.1: sem a janela, quem capturar um webhook legítimo
// reenvia depois e credita o mesmo ciclo de novo.
test('webhook recusa timestamp fora da janela de 300s', () => {
  process.env.SAN_CHECKOUT_KEY = CHAVE;
  const agora = Math.floor(Date.now() / 1000);
  assert.strictEqual(webhookAutorizado(assinar(CORPO, { timestamp: agora - 301 })), false, 'antigo demais');
  assert.strictEqual(webhookAutorizado(assinar(CORPO, { timestamp: agora + 301 })), false, 'futuro demais');
  assert.strictEqual(webhookAutorizado(assinar(CORPO, { timestamp: agora - 299 })), true, 'dentro da janela passa');
  delete process.env.SAN_CHECKOUT_KEY;
});

// Passo 2: a assinatura é sobre o corpo CRU. Se o corpo mudar depois de
// assinado — ou se só tivermos o JSON reserializado — não fecha.
test('webhook recusa corpo adulterado e exige o corpo cru', () => {
  process.env.SAN_CHECKOUT_KEY = CHAVE;
  const req = assinar(CORPO);
  const adulterado = { ...req, rawBody: Buffer.from(CORPO.replace('criada', 'cancelada'), 'utf8') };
  assert.strictEqual(webhookAutorizado(adulterado), false);
  assert.strictEqual(webhookAutorizado({ headers: req.headers }), false, 'sem rawBody não dá pra verificar');
  delete process.env.SAN_CHECKOUT_KEY;
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
