const test = require('node:test');
const assert = require('node:assert');

const { gerarHash, conferirHash } = require('../src/lib/senha');

// scrypt com N=2^17 leva ~0,3–0,8 s por hash — poucos casos, de propósito.
test('hash scrypt guarda os parâmetros e confere a senha certa', async () => {
  const hash = await gerarHash('Senha12@');
  assert.match(hash, /^scrypt\$131072\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  const certa = await conferirHash('Senha12@', hash);
  assert.deepStrictEqual(certa, { ok: true, precisaMigrar: false });
  const errada = await conferirHash('Senha12#', hash);
  assert.deepStrictEqual(errada, { ok: false, precisaMigrar: false });
});

test('dois hashes da mesma senha são diferentes (salt por senha)', async () => {
  const a = await gerarHash('Senha12@');
  const b = await gerarHash('Senha12@');
  assert.notStrictEqual(a, b);
});

test('hash com parâmetro antigo confere e pede migração', async () => {
  // Hash gerado com N=2^14 (abaixo do piso) — mesmo formato, custo menor.
  const crypto = require('node:crypto');
  const salt = crypto.randomBytes(16);
  const derivada = crypto.scryptSync('Senha12@', salt, 64, { N: 2 ** 14, r: 8, p: 1 });
  const antigo = `scrypt$16384$8$1$${salt.toString('base64')}$${derivada.toString('base64')}`;
  const r = await conferirHash('Senha12@', antigo);
  assert.deepStrictEqual(r, { ok: true, precisaMigrar: true });
});

test('hash vazio ou de formato desconhecido nunca passa', async () => {
  assert.deepStrictEqual(await conferirHash('x', null), { ok: false, precisaMigrar: false });
  assert.deepStrictEqual(await conferirHash('x', 'md5$abc'), { ok: false, precisaMigrar: false });
});

test('bcrypt legado confere e pede migração', async () => {
  let bcrypt;
  try {
    bcrypt = require('bcrypt');
  } catch {
    return;
  } // sem bcrypt instalado, nada a migrar
  const legado = await bcrypt.hash('Senha12@', 4);
  assert.deepStrictEqual(await conferirHash('Senha12@', legado), { ok: true, precisaMigrar: true });
  assert.deepStrictEqual(await conferirHash('outra', legado), { ok: false, precisaMigrar: false });
});
