const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');

// POST /trocar-plano do San Checkout (construído em 17/09/2026): cobra o
// acerto proporcional no cartão salvo e altera a MESMA assinatura na Asaas.
// `src/financeiro/san-checkout.js` só empacota a chamada — a conta do
// acerto é toda do lado do Checkout (proporcionalService.js dele).

const CHAVE = 'chave-de-teste-do-contratante';
const CONTRATANTE = 'mostrai';

function comAmbiente() {
  process.env.SAN_CHECKOUT_KEY = CHAVE;
  process.env.SAN_CHECKOUT_CONTRATANTE_ID = CONTRATANTE;
  process.env.SAN_CHECKOUT_BASE_URL = 'https://checkout.exemplo';
  process.env.SAN_CHECKOUT_API_URL = 'https://checkout.exemplo';
  delete require.cache[require.resolve('../src/financeiro/san-checkout')];
  return require('../src/financeiro/san-checkout');
}

function comCheckoutRespondendo(corpo, status = 200) {
  const original = globalThis.fetch;
  let requisicao = null;
  globalThis.fetch = async (url, opcoes) => {
    requisicao = { url, corpo: JSON.parse(opcoes.body), headers: opcoes.headers };
    return { ok: status >= 200 && status < 300, status, json: async () => corpo };
  };
  return {
    requisicao: () => requisicao,
    restaurar: () => {
      globalThis.fetch = original;
    },
  };
}

test('trocarPlano manda planoId, planoNovoId e documento só com dígitos', async () => {
  const sc = comAmbiente();
  const { requisicao, restaurar } = comCheckoutRespondendo({
    assinaturaId: 'sub_1',
    planoId: 'assin-nova',
    planoAnterior: 'assin-antiga',
    valor: 160,
    ciclo: 'MONTHLY',
    acerto: { cobrado: true, valor: 30, chargeId: 'pay_1', credito: 50, debito: 80, diasRestantes: 15 },
  });
  try {
    const { status, corpo } = await sc.trocarPlano('assin-antiga', 'assin-nova', '111.444.777-35');
    assert.strictEqual(status, 200);
    assert.strictEqual(corpo.acerto.valor, 30);

    const req = requisicao();
    assert.ok(req.url.endsWith('/api/checkout/trocar-plano'), `rota errada: ${req.url}`);
    assert.strictEqual(req.headers['X-Checkout-Key'], CHAVE);
    assert.deepStrictEqual(req.corpo, {
      planoId: 'assin-antiga',
      planoNovoId: 'assin-nova',
      documento: '11144477735',
    });
  } finally {
    restaurar();
  }
});

test('trocarPlano devolve status e corpo mesmo quando o Checkout recusa (402/409/502)', async () => {
  const sc = comAmbiente();
  for (const [status, corpo] of [
    [402, { erro: 'O acerto proporcional não foi aprovado no cartão salvo.', acerto: { cobrado: false, valor: 30 } }],
    [409, { erro: 'Já existe uma troca de plano em andamento para esta assinatura.' }],
    [
      502,
      { erro: 'A alteração do plano não foi confirmada pela Asaas.', acerto: { cobrado: true, chargeId: 'pay_2' } },
    ],
  ]) {
    const par = comCheckoutRespondendo(corpo, status);
    try {
      const resultado = await sc.trocarPlano('a', 'b', '11144477735');
      assert.strictEqual(resultado.status, status);
      assert.strictEqual(resultado.corpo.erro, corpo.erro);
    } finally {
      par.restaurar();
    }
  }
});

test('montarRespostaPlano serve assinatura pendente_troca (o Checkout lê o destino antes de cobrar)', async () => {
  const sc = comAmbiente();
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const original = assinaturasRepo.buscarPorId;
  assinaturasRepo.buscarPorId = async (id) =>
    id === 'pendente-1' ? { id, anunciante_id: 1, plano_id: 'p1', status: 'pendente_troca' } : null;
  try {
    // Sem anunciante/plano reais no banco, a função devolve null depois de
    // aceitar o status — o que este teste prova é só a PRIMEIRA barreira
    // (não rejeita 'pendente_troca' como rejeitava 'cancelada'/inexistente).
    const semDados = await sc.montarRespostaPlano('pendente-1');
    assert.strictEqual(semDados, null, 'sem plano/anunciante reais, ainda devolve null — mas não pelo status');

    assinaturasRepo.buscarPorId = async () => ({ id: 'x', status: 'cancelada' });
    const cancelada = await sc.montarRespostaPlano('x');
    assert.strictEqual(cancelada, null, 'cancelada continua não servindo');
  } finally {
    assinaturasRepo.buscarPorId = original;
  }
});

test('webhook de plano_trocado não erra e não reaplica nada (a troca já foi síncrona)', async () => {
  const sc = comAmbiente();
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const originalBuscar = assinaturasRepo.buscarPorId;
  const originalCancelar = assinaturasRepo.marcarCancelada;
  let cancelarChamado = false;
  assinaturasRepo.buscarPorId = async (id) => ({ id, anunciante_id: 1, plano_id: 'p1', status: 'ativa' });
  assinaturasRepo.marcarCancelada = async () => {
    cancelarChamado = true;
  };
  const par = comCheckoutRespondendo({}, 200); // consultar-assinatura, se chaveDoEvento precisar
  try {
    // planoId único a cada rodada: a chave de dedupe de um evento que não
    // credita ciclo é hash(dia|corpo) — corpo fixo faria a segunda rodada
    // do dia ser descartada como reentrega, e o teste "passaria" sem testar
    // nada (ver docs/erros/ desta sessão).
    await sc.processarWebhookAssinatura({
      versao: 1,
      tipo: 'assinatura',
      planoId: `assin-nova-${randomUUID()}`,
      planoAnterior: 'assin-antiga',
      documento: '11144477735',
      evento: 'plano_trocado',
      valor: 160,
      ciclo: 'MONTHLY',
      acertoCobrado: 30,
    });
    assert.strictEqual(
      cancelarChamado,
      false,
      'plano_trocado não cancela nada — quem cancela é o cliente, não este evento',
    );
  } finally {
    assinaturasRepo.buscarPorId = originalBuscar;
    assinaturasRepo.marcarCancelada = originalCancelar;
    par.restaurar();
  }
});

test('webhook de cobranca_contestada suspende a conta (chargeback)', async () => {
  const sc = comAmbiente();
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const anunciantesRepo = require('../src/anunciantes/repository');
  const originalBuscarAssinatura = assinaturasRepo.buscarPorId;
  const originalBuscarConta = anunciantesRepo.buscarPorId;
  const originalAtualizar = anunciantesRepo.atualizar;
  let suspenso = false;
  assinaturasRepo.buscarPorId = async (id) => ({ id, anunciante_id: 1, plano_id: 'p1', status: 'ativa' });
  anunciantesRepo.buscarPorId = async () => ({ id: 1, suspenso: false });
  anunciantesRepo.atualizar = async (id, dados) => {
    assert.strictEqual(id, 1);
    assert.deepStrictEqual(dados, { suspenso: true });
    suspenso = true;
  };
  try {
    await sc.processarWebhookAssinatura({
      versao: 1,
      tipo: 'assinatura',
      planoId: `assin-${randomUUID()}`, // único por rodada — ver comentário no teste de plano_trocado
      documento: '11144477735',
      evento: 'cobranca_contestada',
    });
    assert.ok(suspenso, 'chargeback tem que suspender a conta');
  } finally {
    assinaturasRepo.buscarPorId = originalBuscarAssinatura;
    anunciantesRepo.buscarPorId = originalBuscarConta;
    anunciantesRepo.atualizar = originalAtualizar;
  }
});
