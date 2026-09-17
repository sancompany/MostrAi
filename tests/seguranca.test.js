const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const { conferirSenha } = require('../src/lib/senha');
const { decidir, MAX, JANELA_MS } = require('../src/lib/limite-tentativas');
const { webhookAutorizado } = require('../src/financeiro/san-checkout');
const { segredoConfere } = require('../src/lib/segredo');

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
  assert.strictEqual(
    webhookAutorizado({
      ...assinar(CORPO),
      headers: { 'x-checkout-signature': 'sha256=00', 'x-checkout-timestamp': String(Math.floor(Date.now() / 1000)) },
    }),
    false,
  );
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

// A contagem passou pro banco em 17/09/2026 (migration 051), pra o serviço
// rodar em duas instâncias sem o teto virar 2x10 em silêncio. A REGRA ficou
// pura (`decidir`), então ela continua testável sem Postgres — que é o que
// mantém a suíte inteira sem banco.
test('limite de tentativas: passa até o teto e bloqueia a partir dele', () => {
  const desde = Date.now();
  for (let q = 1; q <= MAX; q += 1) {
    assert.strictEqual(decidir({ quantidade: q, desde }).bloquear, false, `tentativa ${q} devia passar`);
  }
  assert.strictEqual(decidir({ quantidade: MAX + 1, desde }).bloquear, true);
  assert.strictEqual(decidir({ quantidade: MAX + 50, desde }).bloquear, true);
});

test('limite de tentativas: diz quantos minutos faltam, nunca zero', () => {
  const agora = Date.now();
  // Recém-bloqueado: a janela inteira pela frente.
  assert.strictEqual(decidir({ quantidade: MAX + 1, desde: agora, agora }).faltamMinutos, 15);
  // No fim da janela o arredondamento daria 0, e "espere 0 minutos" é uma
  // instrução que não dá pra seguir.
  const quaseFim = agora - (JANELA_MS - 1000);
  assert.strictEqual(decidir({ quantidade: MAX + 1, desde: quaseFim, agora }).faltamMinutos, 1);
});

// O login do admin comparava com `===`, que devolve mais rápido quanto mais
// cedo os bytes divergem — entrega usuário e senha prefixo a prefixo pra quem
// mede o tempo. A regra já valia pro webhook do Checkout; o admin ficou de fora
// até 14/09/2026.
test('segredo do admin confere em tempo constante e nunca passa vazio', () => {
  assert.strictEqual(segredoConfere('Admin12@', 'Admin12@'), true);
  assert.strictEqual(segredoConfere('Admin12@', 'Admin12#'), false, 'byte diferente no fim');
  assert.strictEqual(segredoConfere('Admin12', 'Admin12@'), false, 'tamanho diferente não estoura');
  assert.strictEqual(segredoConfere('', 'Admin12@'), false);
  assert.strictEqual(segredoConfere('qualquer', undefined), false, 'variável ausente nunca abre a porta');
  assert.strictEqual(segredoConfere(undefined, undefined), false);
});
