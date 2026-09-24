const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');

// Consolidação (24/09/2026) — integração com o San Checkout:
//   · a assinatura nasce 'pendente_pagamento' e só vira 'ativa' com o
//     primeiro ciclo pago (webhook `criada`), nunca pelo navegador;
//   · `criada` deduplica pela assinatura (chega antes de a Asaas revelar o
//     chargeId) e a conciliação diária não credita o mesmo ciclo de novo;
//   · o valor gravado é o que a Asaas cobrou (`valorCobrado`), não o
//     recalculado pelo catálogo do dia;
//   · cancelar no Checkout com 404 (nada a cancelar) não é erro.
process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-teste';
process.env.SAN_CHECKOUT_API_URL = process.env.SAN_CHECKOUT_API_URL || 'https://checkout.exemplo';
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const { conciliarAssinaturas } = require('../src/financeiro/conciliacao');

const PLANO = 'essencial-1m';

// `soPara`: planoId (id da assinatura) que a resposta vale — qualquer outro
// recebe 404, porque a conciliação varre TODAS as assinaturas do banco (as de
// outros arquivos de teste, em paralelo, inclusive).
function comCheckoutRespondendo(respostas, soPara = null) {
  const original = globalThis.fetch;
  const chamadas = [];
  globalThis.fetch = async (url, opcoes) => {
    const rota = String(url).split('/api/checkout/')[1];
    chamadas.push(rota);
    const corpoPedido = opcoes?.body ? JSON.parse(opcoes.body) : {};
    if (soPara && corpoPedido.planoId && corpoPedido.planoId !== soPara) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const r = typeof respostas[rota] === 'function' ? respostas[rota]() : respostas[rota];
    // {status: <http>, corpo} para erro HTTP; qualquer outro objeto é o corpo 200.
    const http = r && r.corpo !== undefined ? r.status : 200;
    const corpo = r && r.corpo !== undefined ? r.corpo : (r ?? {});
    return { ok: http >= 200 && http < 300, status: http, json: async () => corpo };
  };
  return { chamadas, restaurar: () => (globalThis.fetch = original) };
}

async function conta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, email_confirmado)
     VALUES ('Pendente Ltda', '11144477735', $1, '16999990000', 'x', now(), true) RETURNING *`,
    [`pendente-${randomUUID().slice(0, 8)}@teste.com`],
  );
  return rows[0];
}

async function apagar(id, sufixo = '') {
  await pool.query('DELETE FROM webhooks_processados WHERE id LIKE $1 OR id LIKE $2', ['criada|%', `%${sufixo}|%`]);
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

test("assinatura nasce pendente; 'criada' sem chargeId ativa na hora com o valor cobrado; conciliação não duplica", async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    assert.equal(assinatura.status, 'pendente_pagamento');
    assert.equal(await assinaturasRepo.buscarAtivaDoAnunciante(c.id), null, 'link gerado não é assinatura ativa');
    assert.ok(
      await sc.montarRespostaPlano(assinatura.id),
      'GET /plano serve a pendente (o Checkout lê antes de cobrar)',
    );

    // O Checkout manda `criada` ~300 ms antes de a Asaas revelar o chargeId.
    let mock = comCheckoutRespondendo({ 'consultar-assinatura': { ultimaCobranca: { status: 'confirmado' } } });
    try {
      await sc.processarWebhookAssinatura({
        versao: 1,
        tipo: 'assinatura',
        planoId: assinatura.id,
        documento: c.cpf_cnpj,
        evento: 'criada',
      });
    } finally {
      mock.restaurar();
    }
    const depois = await assinaturasRepo.buscarPorId(assinatura.id);
    assert.equal(depois.status, 'ativa', 'primeiro ciclo pago ativa a assinatura');
    const { rows: pend } = await pool.query(
      "SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [assinatura.id],
    );
    assert.deepEqual(pend, [], 'nada vira pendência');
    const { rows: cob } = await pool.query('SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    assert.equal(cob.length, 1);
    const contaDepois = (await pool.query('SELECT plano_id, data_expiracao FROM anunciantes WHERE id = $1', [c.id]))
      .rows[0];
    assert.equal(contaDepois.plano_id, PLANO);
    assert.ok(contaDepois.data_expiracao);

    // Reentrega do mesmo `criada`: nada muda.
    mock = comCheckoutRespondendo({ 'consultar-assinatura': { ultimaCobranca: { status: 'confirmado' } } });
    try {
      await sc.processarWebhookAssinatura({
        versao: 1,
        tipo: 'assinatura',
        planoId: assinatura.id,
        documento: c.cpf_cnpj,
        evento: 'criada',
      });
    } finally {
      mock.restaurar();
    }
    assert.equal(
      (await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id])).rowCount,
      1,
    );

    // Conciliação do dia seguinte: a Asaas já revelou o chargeId da MESMA
    // cobrança — não pode creditar o ciclo de novo.
    mock = comCheckoutRespondendo(
      {
        'consultar-assinatura': {
          status: 'ativa',
          ultimaCobranca: {
            chargeId: `pay_criada_${rodada}`,
            status: 'confirmado',
            valorCobrado: 99.9,
            criadoEm: new Date().toISOString(),
          },
        },
      },
      assinatura.id,
    );
    try {
      await conciliarAssinaturas();
    } finally {
      mock.restaurar();
    }
    assert.equal(
      (await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id])).rowCount,
      1,
      'conciliação reconhece a cobrança já registrada pelo `criada`',
    );

    // Renovação de verdade (chargeId novo): entra com o valor que a Asaas cobrou.
    mock = comCheckoutRespondendo(
      {
        'consultar-assinatura': {
          status: 'ativa',
          ultimaCobranca: {
            chargeId: `pay_renov_${rodada}`,
            status: 'confirmado',
            valorCobrado: 77.77,
            criadoEm: new Date().toISOString(),
          },
        },
      },
      assinatura.id,
    );
    try {
      await sc.processarWebhookAssinatura({
        versao: 1,
        tipo: 'assinatura',
        planoId: assinatura.id,
        documento: c.cpf_cnpj,
        evento: 'cobranca_confirmada',
      });
    } finally {
      mock.restaurar();
    }
    const { rows: cobs } = await pool.query(
      'SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY id',
      [c.id],
    );
    assert.equal(cobs.length, 2);
    assert.equal(Number(cobs[1].valor), 77.77, 'o valor gravado é o que a Asaas cobrou');
    const { rows: ciclos } = await pool.query(
      'SELECT valor_ciclo FROM ciclos_contratados WHERE anunciante_id = $1 ORDER BY id',
      [c.id],
    );
    assert.equal(Number(ciclos[1].valor_ciclo), 77.77, 'snapshot do ciclo com o valor cobrado');
  } finally {
    await apagar(c.id, rodada);
  }
});

test('cancelar no Checkout: 404 é "nada a cancelar" (não é erro); 409 e 5xx continuam estourando', async () => {
  let mock = comCheckoutRespondendo({ 'cancelar-assinatura': { status: 404, corpo: { erro: 'nenhuma' } } });
  try {
    const r = await sc.cancelarAssinatura('assin-x', '111.444.777-35');
    assert.deepEqual(r, { cancelada: false, inexistente: true });
  } finally {
    mock.restaurar();
  }
  for (const status of [409, 502]) {
    mock = comCheckoutRespondendo({ 'cancelar-assinatura': { status, corpo: {} } });
    try {
      await assert.rejects(() => sc.cancelarAssinatura('assin-x', '11144477735'));
    } finally {
      mock.restaurar();
    }
  }
});

test('link pendente é reaproveitado por 24 h para o mesmo plano', async () => {
  const c = await conta();
  try {
    const a = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    const reaproveitada = await assinaturasRepo.buscarPendenteDePagamento(c.id, PLANO);
    assert.equal(reaproveitada.id, a.id);
    assert.equal(await assinaturasRepo.buscarPendenteDePagamento(c.id, 'destaque-1m'), null);
    await pool.query("UPDATE assinaturas SET created_at = now() - interval '2 days' WHERE id = $1", [a.id]);
    assert.equal(await assinaturasRepo.buscarPendenteDePagamento(c.id, PLANO), null, 'depois de 24 h é outra compra');
  } finally {
    await apagar(c.id);
  }
});

test.after(() => pool.end());
