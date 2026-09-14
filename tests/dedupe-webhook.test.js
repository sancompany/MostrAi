const test = require('node:test');
const assert = require('node:assert');

const { chaveDoEvento } = require('../src/financeiro/san-checkout');

// O payload de assinatura do San Checkout tem CINCO campos e nenhum id
// (API.md dele, 4.3.4). O corpo de uma renovação é byte a byte idêntico ao da
// anterior — por isso a dedupe não pode sair do corpo.
const PAGAMENTO = {
  versao: 1, tipo: 'assinatura', planoId: 'assinatura-abc', documento: '11144477735',
  evento: 'cobranca_confirmada',
};

function comCheckoutRespondendo(corpo, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  });
  return () => { globalThis.fetch = original; };
}

test('cobrança confirmada deduplica pelo chargeId, não pelo corpo', async () => {
  const restaurar = comCheckoutRespondendo({
    ultimaCobranca: { chargeId: 'pay_8392017465', status: 'confirmado' },
  });
  try {
    assert.strictEqual(await chaveDoEvento(PAGAMENTO), 'pay_8392017465|confirmado');
  } finally { restaurar(); }
});

// A falha original: a chave era hash(dia|corpo). A retentativa do checkout
// (1, 5 e 15 min) que cruzasse a meia-noite mudava de dia, passava pela
// dedupe e creditava um ciclo inteiro que ninguém pagou.
test('duas entregas do mesmo pagamento dão a mesma chave, mesmo virando o dia', async () => {
  const resposta = { ultimaCobranca: { chargeId: 'pay_1', status: 'confirmado' } };
  let restaurar = comCheckoutRespondendo(resposta);
  let antes;
  try { antes = await chaveDoEvento(PAGAMENTO); } finally { restaurar(); }

  restaurar = comCheckoutRespondendo(resposta);
  let depois;
  try { depois = await chaveDoEvento({ ...PAGAMENTO }); } finally { restaurar(); }

  assert.strictEqual(antes, depois, 'reentrega do mesmo pagamento não pode gerar chave nova');
});

// E o inverso: duas cobranças REAIS diferentes não podem colapsar numa só.
test('cobranças diferentes dão chaves diferentes', async () => {
  let restaurar = comCheckoutRespondendo({ ultimaCobranca: { chargeId: 'pay_1', status: 'confirmado' } });
  let primeira;
  try { primeira = await chaveDoEvento(PAGAMENTO); } finally { restaurar(); }

  restaurar = comCheckoutRespondendo({ ultimaCobranca: { chargeId: 'pay_2', status: 'confirmado' } });
  let segunda;
  try { segunda = await chaveDoEvento(PAGAMENTO); } finally { restaurar(); }

  assert.notStrictEqual(primeira, segunda);
});

// Sem chargeId não dá pra garantir idempotência, e creditar sem garantia é
// dar cobertura que talvez já tenha sido dada. Tem que estourar, pra virar
// pendência e esperar a conciliação.
test('sem chargeId, a chave estoura em vez de inventar uma', async () => {
  const restaurar = comCheckoutRespondendo({ ultimaCobranca: null });
  try {
    await assert.rejects(() => chaveDoEvento(PAGAMENTO), /chargeId/);
  } finally { restaurar(); }
});

test('checkout fora do ar estoura em vez de creditar', async () => {
  const restaurar = comCheckoutRespondendo({}, 503);
  try {
    await assert.rejects(() => chaveDoEvento(PAGAMENTO), /503/);
  } finally { restaurar(); }
});

// Eventos que não mexem em saldo não gastam uma chamada ao checkout.
test('evento sem dinheiro não consulta o checkout', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('não deveria ter chamado o checkout'); };
  try {
    const chave = await chaveDoEvento({ ...PAGAMENTO, evento: 'cobranca_falhou' });
    assert.match(chave, /^[0-9a-f]{64}$/);
  } finally { globalThis.fetch = original; }
});

// Se um dia o checkout passar a mandar id próprio, ele vence sem consulta.
test('id próprio do checkout, se vier, é a chave', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('não deveria ter chamado o checkout'); };
  try {
    assert.strictEqual(await chaveDoEvento({ ...PAGAMENTO, eventoId: 'evt_9' }), 'evt_9');
  } finally { globalThis.fetch = original; }
});
