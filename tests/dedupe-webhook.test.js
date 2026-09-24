const test = require('node:test');
const assert = require('node:assert');

const { chaveDoEvento } = require('../src/financeiro/san-checkout');

// O payload de assinatura do San Checkout tem CINCO campos e nenhum id
// (API.md dele, 4.3.4). O corpo de uma renovação é byte a byte idêntico ao da
// anterior — por isso a dedupe não pode sair do corpo.
const PAGAMENTO = {
  versao: 1,
  tipo: 'assinatura',
  planoId: 'assinatura-abc',
  documento: '11144477735',
  evento: 'cobranca_confirmada',
};

function comCheckoutRespondendo(corpo, status = 200) {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  });
  return () => {
    globalThis.fetch = original;
  };
}

test('cobrança confirmada deduplica pelo chargeId, não pelo corpo', async () => {
  const restaurar = comCheckoutRespondendo({
    ultimaCobranca: { chargeId: 'pay_8392017465', status: 'confirmado' },
  });
  try {
    assert.strictEqual((await chaveDoEvento(PAGAMENTO)).chave, 'pay_8392017465|confirmado');
  } finally {
    restaurar();
  }
});

// A falha original: a chave era hash(dia|corpo). A retentativa do checkout
// (1, 5 e 15 min) que cruzasse a meia-noite mudava de dia, passava pela
// dedupe e creditava um ciclo inteiro que ninguém pagou.
test('duas entregas do mesmo pagamento dão a mesma chave, mesmo virando o dia', async () => {
  const resposta = { ultimaCobranca: { chargeId: 'pay_1', status: 'confirmado' } };
  let restaurar = comCheckoutRespondendo(resposta);
  let antes;
  try {
    antes = (await chaveDoEvento(PAGAMENTO)).chave;
  } finally {
    restaurar();
  }

  restaurar = comCheckoutRespondendo(resposta);
  let depois;
  try {
    depois = (await chaveDoEvento({ ...PAGAMENTO })).chave;
  } finally {
    restaurar();
  }

  assert.strictEqual(antes, depois, 'reentrega do mesmo pagamento não pode gerar chave nova');
});

// E o inverso: duas cobranças REAIS diferentes não podem colapsar numa só.
test('cobranças diferentes dão chaves diferentes', async () => {
  let restaurar = comCheckoutRespondendo({ ultimaCobranca: { chargeId: 'pay_1', status: 'confirmado' } });
  let primeira;
  try {
    primeira = (await chaveDoEvento(PAGAMENTO)).chave;
  } finally {
    restaurar();
  }

  restaurar = comCheckoutRespondendo({ ultimaCobranca: { chargeId: 'pay_2', status: 'confirmado' } });
  let segunda;
  try {
    segunda = (await chaveDoEvento(PAGAMENTO)).chave;
  } finally {
    restaurar();
  }

  assert.notStrictEqual(primeira, segunda);
});

// Sem chargeId não dá pra garantir idempotência, e creditar sem garantia é
// dar cobertura que talvez já tenha sido dada. Tem que estourar, pra virar
// pendência e esperar a conciliação.
test('sem chargeId, a chave estoura em vez de inventar uma (depois de 3 tentativas)', async () => {
  let chamadas = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    chamadas += 1;
    return { ok: true, status: 200, json: async () => ({ ultimaCobranca: null }) };
  };
  const restaurar = () => {
    globalThis.fetch = original;
  };
  try {
    await assert.rejects(() => chaveDoEvento(PAGAMENTO), /chargeId/);
    assert.strictEqual(chamadas, 3, 'reconsulta antes de desistir: a Asaas revela o id com atraso');
  } finally {
    restaurar();
  }
});

// 'criada' (primeira cobrança) chega ANTES de a Asaas revelar o chargeId: a
// chave é a própria assinatura, e a consulta é só pra pegar o valor cobrado
// quando já existe — sem ela, o evento segue mesmo assim.
test("'criada' deduplica pela assinatura e não depende do chargeId", async () => {
  let restaurar = comCheckoutRespondendo({ ultimaCobranca: null });
  try {
    const r = await chaveDoEvento({ ...PAGAMENTO, evento: 'criada' });
    assert.strictEqual(r.chave, 'criada|assinatura-abc');
    assert.strictEqual(r.ultima, null);
  } finally {
    restaurar();
  }
  restaurar = comCheckoutRespondendo({}, 503);
  try {
    assert.strictEqual((await chaveDoEvento({ ...PAGAMENTO, evento: 'criada' })).chave, 'criada|assinatura-abc');
  } finally {
    restaurar();
  }
  restaurar = comCheckoutRespondendo({
    ultimaCobranca: { chargeId: 'pay_9', status: 'confirmado', valorCobrado: 149.9 },
  });
  try {
    const r = await chaveDoEvento({ ...PAGAMENTO, evento: 'criada' });
    assert.strictEqual(r.chave, 'criada|assinatura-abc');
    assert.strictEqual(r.ultima.valorCobrado, 149.9);
  } finally {
    restaurar();
  }
});

test('checkout fora do ar estoura em vez de creditar', async () => {
  const restaurar = comCheckoutRespondendo({}, 503);
  try {
    await assert.rejects(() => chaveDoEvento(PAGAMENTO), /503/);
  } finally {
    restaurar();
  }
});

// Eventos que não mexem em saldo não gastam uma chamada ao checkout.
test('evento sem dinheiro não consulta o checkout', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('não deveria ter chamado o checkout');
  };
  try {
    const { chave } = await chaveDoEvento({ ...PAGAMENTO, evento: 'cobranca_falhou' });
    assert.match(chave, /^[0-9a-f]{64}$/);
  } finally {
    globalThis.fetch = original;
  }
});

// Contrato v2 do Checkout (24/09/2026): `eventoId` é a chave, sem consulta.
test('id próprio do checkout, se vier, é a chave', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('não deveria ter chamado o checkout');
  };
  try {
    assert.strictEqual((await chaveDoEvento({ ...PAGAMENTO, eventoId: 'evt_9' })).chave, 'evt_9');
  } finally {
    globalThis.fetch = original;
  }
});

// O payload v2 traz chargeId, statusFinanceiro e valor: `ultima` sai DELE,
// para o valor gravado ser o cobrado e o `chargeId|status` entrar em
// webhooks_processados (é por ele que a conciliação diária reconhece a
// cobrança). Sem isto, o v2 creditava o ciclo duas vezes: uma pelo webhook
// (chave eventoId) e outra pela conciliação (chave chargeId|status).
const PAGAMENTO_V2 = {
  ...PAGAMENTO,
  versao: 2,
  eventoId: '3f2b1c9e-7d4a-4e0b-9c1d-5a6b7c8d9e0f',
  ocorridoEm: '2026-10-24T13:00:02.000Z',
  assinaturaId: 'sub_000123456789',
  chargeId: 'pay_5566778899',
  statusFinanceiro: 'confirmado',
  valor: 267.3,
  ciclo: 'QUARTERLY',
  cicloCanonico: 'trimestral',
};

test('v2: eventoId é a chave e `ultima` vem do próprio payload (chargeId, status, valor)', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('v2 não consulta o checkout de volta');
  };
  try {
    const r = await chaveDoEvento(PAGAMENTO_V2);
    assert.strictEqual(r.chave, PAGAMENTO_V2.eventoId);
    assert.deepStrictEqual(r.ultima, { chargeId: 'pay_5566778899', status: 'confirmado', valorCobrado: 267.3 });
    // `criada` v2 também: chargeId já vem no evento de pagamento
    const c = await chaveDoEvento({ ...PAGAMENTO_V2, evento: 'criada', eventoId: 'evt_criada' });
    assert.strictEqual(c.chave, 'evt_criada');
    assert.strictEqual(c.ultima.chargeId, 'pay_5566778899');
    // sem chargeId (cancelada pedida pelo contratante): ultima é null, chave continua o eventoId
    const s = await chaveDoEvento({ ...PAGAMENTO_V2, evento: 'cancelada', chargeId: null, eventoId: 'evt_canc' });
    assert.strictEqual(s.chave, 'evt_canc');
    assert.strictEqual(s.ultima, null);
  } finally {
    globalThis.fetch = original;
  }
});

test('v2: a mesma notificação reentregue (mesmo eventoId) dá a mesma chave; dois ciclos, chaves diferentes', async () => {
  const a = await chaveDoEvento(PAGAMENTO_V2);
  const b = await chaveDoEvento({ ...PAGAMENTO_V2 });
  assert.strictEqual(a.chave, b.chave);
  const outroCiclo = await chaveDoEvento({ ...PAGAMENTO_V2, eventoId: 'evt_outro', chargeId: 'pay_outro' });
  assert.notStrictEqual(a.chave, outroCiclo.chave);
});
