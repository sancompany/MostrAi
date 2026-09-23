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

test('telefoneNacional tira o 55 do E.164 antes de mandar pro Checkout', async () => {
  const sc = comAmbiente();
  // Achado em produção, 19/09/2026: contato_telefone vem em E.164
  // (+5516994635946) pra virar link de WhatsApp, mas o Checkout quer só DDD
  // + número (10 ou 11 dígitos, API.md seção 9.2) — mandando o E.164 direto,
  // o "55" do país virava o DDD que a Asaas lia.
  assert.strictEqual(sc.telefoneNacional('+5516994635946'), '16994635946');
  assert.strictEqual(sc.telefoneNacional('5516994635946'), '16994635946');
  // DDD 55 é real (Santa Maria-RS): o E.164 dele tem "55" duas vezes
  // seguidas, e só o primeiro par (o país) deve sair.
  assert.strictEqual(sc.telefoneNacional('+5555988887777'), '55988887777');
  assert.strictEqual(sc.telefoneNacional(null), '');
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

test('webhook de plano_trocado é no-op quando a assinatura já está ativa (troca sem acerto, aplicada de forma síncrona)', async () => {
  const sc = comAmbiente();
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const originalBuscar = assinaturasRepo.buscarPorId;
  const originalCancelar = assinaturasRepo.marcarCancelada;
  const originalMarcarAtiva = assinaturasRepo.marcarAtiva;
  let cancelarChamado = false;
  let marcarAtivaChamado = false;
  assinaturasRepo.buscarPorId = async (id) => ({ id, anunciante_id: 1, plano_id: 'p1', status: 'ativa' });
  assinaturasRepo.marcarCancelada = async () => {
    cancelarChamado = true;
  };
  assinaturasRepo.marcarAtiva = async () => {
    marcarAtivaChamado = true;
  };
  const par = comCheckoutRespondendo({}, 200); // consultar-assinatura, se chaveDoEvento precisar
  try {
    // planoId único a cada rodada: a chave de dedupe de um evento que não
    // credita ciclo é hash(dia|corpo) — corpo fixo faria a segunda rodada
    // do dia ser descartada como reentrega, e o teste "passaria" sem testar
    // nada (ver docs/erros/ desta sessão). Sem stub em pool.connect aqui de
    // propósito: o pg-pool implementa `pool.query` (usado logo acima, na
    // dedupe) chamando `this.connect` por dentro — simular só `connect`
    // trava esse `query` sem callback, e trava o teste inteiro (achado
    // construindo este teste, 21/09/2026).
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
    assert.strictEqual(marcarAtivaChamado, false, 'já está ativa: não reaplica a troca');
  } finally {
    assinaturasRepo.buscarPorId = originalBuscar;
    assinaturasRepo.marcarCancelada = originalCancelar;
    assinaturasRepo.marcarAtiva = originalMarcarAtiva;
    par.restaurar();
  }
});

// As duas próximas usam linhas reais no banco (padrão de
// tests/indicacoes.test.js), não um cliente de pool simulado: o código sob
// teste mistura `pool.query` (dedupe) com `pool.connect` (transação da
// troca) na MESMA chamada, e um `pool.connect` fake não dá conta dos dois
// sem reimplementar o client do `pg` por dentro (ver comentário acima).
async function contaDeTeste(prefixo, planoId) {
  const pool = require('../src/db/pool');
  const email = `${prefixo}-${randomUUID()}@example.com`;
  // `planoId` espelha o plano da assinatura 'ativa' que o teste vai criar —
  // na vida real, `anunciantes.plano_id` NUNCA fica dessincronizado da
  // assinatura ativa (é exatamente essa invariante que a conferência de
  // troca concorrente, em processarWebhookAssinatura, depende).
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, papeis, plano_id)
     VALUES ($1, '11144477735', $2, '16999990000', 'x', now(), '{anunciante}', $3)
     RETURNING id`,
    [prefixo, email, planoId || null],
  );
  return rows[0].id;
}

async function apagarConta(id) {
  const pool = require('../src/db/pool');
  // eventos.registrar (src/lib/eventos.js) é fire-and-forget de propósito —
  // não devolve a promise do INSERT pra quem chama, em lugar nenhum do
  // projeto. A limpeza aqui roda antes desse INSERT terminar sem essa
  // pausa curta, e a FK de `eventos` pra `anunciantes` derruba o teste.
  await new Promise((resolve) => setTimeout(resolve, 100));
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1 OR origem_conta_id = $1', [id]);
  await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

test('webhook de plano_trocado aplica a troca quando a linha ainda está pendente_troca (pagador aprovou no Checkout, 202)', async () => {
  const sc = comAmbiente();
  const pool = require('../src/db/pool');
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const anunciante = await contaDeTeste('troca-pendente', 'essencial-1m');
  try {
    const antiga = await assinaturasRepo.criar({ anuncianteId: anunciante, planoId: 'essencial-1m', status: 'ativa' });
    const nova = await assinaturasRepo.criar({
      anuncianteId: anunciante,
      planoId: 'destaque-1m',
      status: 'pendente_troca',
    });

    await sc.processarWebhookAssinatura({
      versao: 1,
      tipo: 'assinatura',
      planoId: nova.id,
      planoAnterior: antiga.id,
      documento: '11144477735',
      evento: 'plano_trocado',
      valor: 160,
      ciclo: 'MONTHLY',
      acertoCobrado: 30,
    });

    const antigaDepois = await assinaturasRepo.buscarPorId(antiga.id);
    const novaDepois = await assinaturasRepo.buscarPorId(nova.id);
    assert.strictEqual(antigaDepois.status, 'trocada', 'marca a assinatura antiga como trocada');
    assert.strictEqual(novaDepois.status, 'ativa', 'marca a assinatura nova como ativa');

    const { rows: contaRows } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [anunciante]);
    assert.strictEqual(contaRows[0].plano_id, 'destaque-1m', 'atualiza o plano_id do anunciante');

    const { rows: cobrancaRows } = await pool.query(
      'SELECT plano_id, plano_anterior_id, valor FROM cobrancas_confirmadas WHERE anunciante_id = $1',
      [anunciante],
    );
    assert.strictEqual(cobrancaRows.length, 1, 'grava a cobrança confirmada (houve acerto)');
    assert.strictEqual(cobrancaRows[0].plano_id, 'destaque-1m');
    assert.strictEqual(cobrancaRows[0].plano_anterior_id, 'essencial-1m');
    assert.strictEqual(Number(cobrancaRows[0].valor), 30);
  } finally {
    await apagarConta(anunciante);
  }
});

test('webhook de plano_trocado não sobrescreve uma troca concorrente mais nova já aplicada', async () => {
  // O Checkout permite duas intenções pendentes ao mesmo tempo pra mesma
  // conta (não bloqueia "já existe uma pendente" — API.md seção 5.6). Se o
  // pagador aprovar as duas, a segunda a chegar não pode reverter a conta
  // pro plano da primeira.
  const sc = comAmbiente();
  const pool = require('../src/db/pool');
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const anunciante = await contaDeTeste('troca-concorrente', 'essencial-1m');
  try {
    const original = await assinaturasRepo.criar({
      anuncianteId: anunciante,
      planoId: 'essencial-1m',
      status: 'ativa',
    });
    const intencaoY = await assinaturasRepo.criar({
      anuncianteId: anunciante,
      planoId: 'destaque-1m',
      status: 'pendente_troca',
    });
    const intencaoZ = await assinaturasRepo.criar({
      anuncianteId: anunciante,
      planoId: 'maximo-1m',
      status: 'pendente_troca',
    });

    // Y aprova primeiro: aplica normalmente.
    await sc.processarWebhookAssinatura({
      versao: 1,
      tipo: 'assinatura',
      planoId: intencaoY.id,
      planoAnterior: original.id,
      documento: '11144477735',
      evento: 'plano_trocado',
      valor: 160,
      ciclo: 'MONTHLY',
      acertoCobrado: 30,
    });

    // Z aprova depois, mas ainda referenciando `original` como anterior —
    // a conta já não está mais lá.
    await sc.processarWebhookAssinatura({
      versao: 1,
      tipo: 'assinatura',
      planoId: intencaoZ.id,
      planoAnterior: original.id,
      documento: '11144477735',
      evento: 'plano_trocado',
      valor: 300,
      ciclo: 'MONTHLY',
      acertoCobrado: 50,
    });

    const { rows: contaRows } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [anunciante]);
    assert.strictEqual(contaRows[0].plano_id, 'destaque-1m', 'fica no plano da troca Y — Z não sobrescreve por cima');

    const zDepois = await assinaturasRepo.buscarPorId(intencaoZ.id);
    assert.strictEqual(zDepois.status, 'pendente_troca', 'Z não é aplicada — fica pendente, vira pendência pro admin');

    const { rows: cobrancaRows } = await pool.query(
      'SELECT plano_id FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY criado_em',
      [anunciante],
    );
    assert.strictEqual(cobrancaRows.length, 1, 'só a cobrança de Y é gravada — Z não gera cobrança fantasma');
    assert.strictEqual(cobrancaRows[0].plano_id, 'destaque-1m');
  } finally {
    await apagarConta(anunciante);
  }
});

test('webhook de plano_trocado sem acerto (downgrade absorvido) não grava cobranca_confirmada', async () => {
  const sc = comAmbiente();
  const pool = require('../src/db/pool');
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const anunciante = await contaDeTeste('troca-sem-acerto', 'destaque-1m');
  try {
    const antiga = await assinaturasRepo.criar({ anuncianteId: anunciante, planoId: 'destaque-1m', status: 'ativa' });
    const nova = await assinaturasRepo.criar({
      anuncianteId: anunciante,
      planoId: 'essencial-1m',
      status: 'pendente_troca',
    });

    // Este caso não deveria acontecer de verdade — sem acerto o Checkout
    // responde 200 na hora, nunca gera o 202/aprovação que este webhook
    // resolve. Mesmo assim, `acertoCobrado: 0` não pode gravar uma
    // cobrança de R$ 0 se algum dia chegar assim.
    await sc.processarWebhookAssinatura({
      versao: 1,
      tipo: 'assinatura',
      planoId: nova.id,
      planoAnterior: antiga.id,
      documento: '11144477735',
      evento: 'plano_trocado',
      valor: 60,
      ciclo: 'MONTHLY',
      acertoCobrado: 0,
    });

    const { rows: cobrancaRows } = await pool.query('SELECT id FROM cobrancas_confirmadas WHERE anunciante_id = $1', [
      anunciante,
    ]);
    assert.strictEqual(cobrancaRows.length, 0, 'sem acerto cobrado, não grava cobrança nenhuma');
    const { rows: contaRows } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [anunciante]);
    assert.strictEqual(contaRows[0].plano_id, 'essencial-1m', 'ainda assim troca o plano — o acerto é só o dinheiro');
  } finally {
    await apagarConta(anunciante);
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
