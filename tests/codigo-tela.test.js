const test = require('node:test');
const assert = require('node:assert');
const {
  formatarCodigoTela,
  normalizarCodigoTela,
  ALFABETO_INSTALACAO,
  gerarCodigoInstalacao,
  normalizarCodigoInstalacao,
  formatarCodigoInstalacao,
} = require('../src/lib/codigo-tela');

// ID humano da tela e código de instalação (docs/player-mvp-contract.md §2–3).

test('código da tela: M- + no mínimo 4 dígitos, nunca trunca', () => {
  assert.equal(formatarCodigoTela(1), 'M-0001');
  assert.equal(formatarCodigoTela(35), 'M-0035');
  assert.equal(formatarCodigoTela(235), 'M-0235');
  assert.equal(formatarCodigoTela(9999), 'M-9999');
  assert.equal(formatarCodigoTela(12345), 'M-12345');
});

test('código da tela: entrada tolerante normaliza para o id; lixo é null', () => {
  for (const entrada of ['M-0235', 'm-0235', 'M0235', '0235', '235', ' M 0235 ', 235]) {
    assert.equal(normalizarCodigoTela(entrada), 235, `entrada ${JSON.stringify(entrada)}`);
  }
  assert.equal(normalizarCodigoTela('M-0001'), 1);
  assert.equal(normalizarCodigoTela('M0001'), 1);
  assert.equal(normalizarCodigoTela('0001'), 1);
  for (const lixo of ['', 'M-', 'X-0235', 'M-02a5', '0', 'M-0000', '99999999999', null, undefined, {}, 1.5]) {
    assert.equal(normalizarCodigoTela(lixo), null, `lixo ${JSON.stringify(lixo)}`);
  }
});

test('código de instalação: 8 caracteres do alfabeto sem 0 O 1 I L', () => {
  assert.equal(ALFABETO_INSTALACAO.length, 31);
  for (const proibido of '0O1IL') assert.ok(!ALFABETO_INSTALACAO.includes(proibido), proibido);
  const vistos = new Set();
  for (let i = 0; i < 200; i++) {
    const c = gerarCodigoInstalacao();
    assert.match(c, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/);
    vistos.add(c);
  }
  assert.ok(vistos.size > 195, 'sorteio não repete na prática');
});

test('código de instalação: maiúsculas, sem espaço nem hífen; formato XXXX-XXXX', () => {
  assert.equal(normalizarCodigoInstalacao('7K4M-9Q2W'), '7K4M9Q2W');
  assert.equal(normalizarCodigoInstalacao('7k4m9q2w'), '7K4M9Q2W');
  assert.equal(normalizarCodigoInstalacao(' 7k4m 9q2w '), '7K4M9Q2W');
  assert.equal(formatarCodigoInstalacao('7K4M9Q2W'), '7K4M-9Q2W');
  for (const lixo of ['7K4M9Q2', '7K4M9Q2WX', '7K4M9Q20', '7K4M9Q2O', 'IK4M9Q2W', '', null, 12345678]) {
    assert.equal(normalizarCodigoInstalacao(lixo), null, `lixo ${JSON.stringify(lixo)}`);
  }
});
