const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');

// Contrato v2 do San Checkout (24/09/2026): todo evento traz `eventoId`,
// `chargeId`, `statusFinanceiro`, `valor`, `ciclo`. O que este arquivo prova:
//   · `criada` v2 ativa e credita UMA vez, com o `valor` do próprio evento;
//   · a conciliação diária, chaveada por `chargeId|status`, reconhece a
//     cobrança que o webhook (chaveado por `eventoId`) já creditou — sem
//     isto o v2 creditava o ciclo duas vezes;
//   · reentrega do mesmo `eventoId` não faz nada; ciclo novo credita;
//   · `troca_revertida` vira pendência (e chargeback suspende);
//   · `cobranca_estornada` parcial diz que é parcial na pendência.
process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-teste';
process.env.SAN_CHECKOUT_API_URL = process.env.SAN_CHECKOUT_API_URL || 'https://checkout.exemplo';
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const { conciliarAssinaturas } = require('../src/financeiro/conciliacao');

const PLANO = 'essencial-1m';

function semCheckout() {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url) => {
    chamadas.push(String(url));
    throw new Error(`v2 não deveria consultar o checkout: ${url}`);
  };
  return { chamadas, restaurar: () => (globalThis.fetch = original) };
}

function comConciliacaoRespondendo(ultima, soPara) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opcoes) => {
    const corpoPedido = opcoes?.body ? JSON.parse(opcoes.body) : {};
    if (corpoPedido.planoId !== soPara) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ status: 'ativa', ultimaCobranca: ultima }) };
  };
  return () => (globalThis.fetch = original);
}

async function conta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, email_confirmado)
     VALUES ('V2 Ltda', '52998224725', $1, '16999990000', 'x', now(), true) RETURNING *`,
    [`v2-${randomUUID().slice(0, 8)}@teste.com`],
  );
  return rows[0];
}

async function apagar(id, rodada) {
  await pool.query('DELETE FROM webhooks_processados WHERE id LIKE $1 OR id LIKE $2', [
    `%${rodada}%`,
    `evt_%${rodada}%`,
  ]);
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
  await pool.query(
    "DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' IN (SELECT id FROM assinaturas WHERE anunciante_id = $1)",
    [id],
  );
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

const v2 = (assinatura, c, rodada, extras) => ({
  versao: 2,
  tipo: 'assinatura',
  eventoId: `evt_${randomUUID()}_${rodada}`,
  ocorridoEm: new Date().toISOString(),
  planoId: assinatura.id,
  documento: c.cpf_cnpj,
  assinaturaId: `sub_${rodada}`,
  statusFinanceiro: 'confirmado',
  ciclo: 'MONTHLY',
  cicloCanonico: 'mensal',
  metodoPagamento: 'assinatura',
  valorEstornado: null,
  estornoParcial: false,
  ...extras,
});

test("v2: 'criada' credita uma vez com o valor do evento; conciliação reconhece; reentrega não duplica; ciclo novo credita", async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    const criada = v2(assinatura, c, rodada, { evento: 'criada', chargeId: `pay_c_${rodada}`, valor: 123.45 });

    let mock = semCheckout();
    try {
      await sc.processarWebhookAssinatura(criada);
    } finally {
      mock.restaurar();
    }
    assert.deepEqual(mock.chamadas, [], 'v2 não consulta a rota 5.3: o payload já traz chargeId e valor');
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa');
    let { rows: cobs } = await pool.query('SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    assert.equal(cobs.length, 1);
    assert.equal(Number(cobs[0].valor), 123.45, 'o valor gravado é o do evento (o que a Asaas cobrou)');
    const { rows: chaves } = await pool.query('SELECT id FROM webhooks_processados WHERE id = $1 OR id = $2', [
      criada.eventoId,
      `pay_c_${rodada}|confirmado`,
    ]);
    assert.equal(chaves.length, 2, 'eventoId E chargeId|status ficam registrados — é o segundo que a conciliação lê');

    // Reentrega do MESMO eventoId: nada.
    mock = semCheckout();
    try {
      await sc.processarWebhookAssinatura({ ...criada });
    } finally {
      mock.restaurar();
    }
    ({ rows: cobs } = await pool.query('SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]));
    assert.equal(cobs.length, 1, 'reentrega do mesmo eventoId não credita de novo');

    // Conciliação do dia seguinte com a MESMA cobrança: não credita de novo.
    let restaurar = comConciliacaoRespondendo(
      { chargeId: `pay_c_${rodada}`, status: 'confirmado', valorCobrado: 123.45, criadoEm: new Date().toISOString() },
      assinatura.id,
    );
    try {
      await conciliarAssinaturas();
    } finally {
      restaurar();
    }
    ({ rows: cobs } = await pool.query('SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]));
    assert.equal(cobs.length, 1, 'a conciliação reconhece a cobrança que o webhook v2 já creditou');

    // Ciclo novo (chargeId novo, eventoId novo): credita com o valor dele.
    const ciclo2 = v2(assinatura, c, rodada, {
      evento: 'cobranca_confirmada',
      chargeId: `pay_2_${rodada}`,
      valor: 99.9,
    });
    mock = semCheckout();
    try {
      await sc.processarWebhookAssinatura(ciclo2);
    } finally {
      mock.restaurar();
    }
    ({ rows: cobs } = await pool.query('SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY id', [
      c.id,
    ]));
    assert.equal(cobs.length, 2);
    assert.equal(Number(cobs[1].valor), 99.9);

    // E a conciliação seguinte, vendo o ciclo 2, também não duplica.
    restaurar = comConciliacaoRespondendo(
      { chargeId: `pay_2_${rodada}`, status: 'confirmado', valorCobrado: 99.9, criadoEm: new Date().toISOString() },
      assinatura.id,
    );
    try {
      await conciliarAssinaturas();
    } finally {
      restaurar();
    }
    ({ rows: cobs } = await pool.query('SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]));
    assert.equal(cobs.length, 2, 'ciclo 2 não é creditado duas vezes');

    const { rows: pend } = await pool.query(
      "SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [assinatura.id],
    );
    assert.deepEqual(pend, [], 'nada vira pendência no caminho feliz');
  } finally {
    await apagar(c.id, rodada);
  }
});

test('v2: troca_revertida vira pendência com o plano anterior; chargeback suspende; estorno parcial é dito parcial', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await assinaturasRepo.marcarAtiva(assinatura.id);

    const mock = semCheckout();
    try {
      await sc.processarWebhookAssinatura(
        v2(assinatura, c, rodada, {
          evento: 'troca_revertida',
          chargeId: `pay_acerto_${rodada}`,
          statusFinanceiro: 'estornado',
          valor: 30,
          valorEstornado: 30,
          planoAnterior: 'plano-velho',
          acertoCobrado: 30,
        }),
      );
      await sc.processarWebhookAssinatura(
        v2(assinatura, c, rodada, {
          evento: 'cobranca_estornada',
          chargeId: `pay_parcial_${rodada}`,
          statusFinanceiro: 'estornado_parcialmente',
          valor: 100,
          valorEstornado: 40,
          estornoParcial: true,
        }),
      );
      await sc.processarWebhookAssinatura(
        v2(assinatura, c, rodada, {
          evento: 'troca_revertida',
          chargeId: `pay_acerto2_${rodada}`,
          statusFinanceiro: 'chargeback',
          valor: 30,
          planoAnterior: 'plano-velho',
          acertoCobrado: 30,
        }),
      );
    } finally {
      mock.restaurar();
    }
    const { rows: pend } = await pool.query(
      "SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido ORDER BY id",
      [assinatura.id],
    );
    assert.equal(pend.length, 3);
    assert.match(pend[0].motivo, /revertido \(estornado, R\$ 30\).*plano-velho/);
    assert.match(pend[1].motivo, /PARCIAL de R\$ 40 sobre R\$ 100/);
    assert.match(pend[2].motivo, /chargeback/);
    const conta2 = (await pool.query('SELECT suspenso FROM anunciantes WHERE id = $1', [c.id])).rows[0];
    assert.equal(conta2.suspenso, true, 'chargeback do acerto suspende a conta, como cobranca_contestada');
    assert.equal(
      (await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id])).rowCount,
      0,
      'nada disso credita ciclo',
    );
  } finally {
    await apagar(c.id, rodada);
  }
});

test.after(() => pool.end());
