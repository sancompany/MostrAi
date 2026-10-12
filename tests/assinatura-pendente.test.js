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
const cicloContratado = require('../src/financeiro/ciclo-contratado');
const { conciliarAssinaturas } = require('../src/financeiro/conciliacao');

// Rotas do financeiro montadas direto (a proteção do /admin é do server.js,
// não do router) — só pra bater no botão "Aplicar este ciclo".
async function subirAdmin() {
  const express = require('express');
  require('express-async-errors');
  const app = express();
  app.use(express.json());
  app.use((req, _res, proximo) => {
    req.session = { adminUsuario: 'teste' };
    proximo();
  });
  app.use(require('../src/financeiro/routes').router);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho) => {
    const r = await fetch(`${base}${caminho}`, { method: metodo, headers: { 'Content-Type': 'application/json' } });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

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
      await conciliarAssinaturas({ apenasContas: [c.id] });
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

test('intenções antigas morrem ao emitir link novo: só um link pagável por conta', async () => {
  const c = await conta();
  try {
    const velha = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m' });
    assert.ok(await sc.montarRespostaPlano(velha.id), 'antes: o Checkout ainda servia o link antigo');
    const canceladas = await assinaturasRepo.cancelarPendentesDePagamento(c.id);
    assert.deepEqual(canceladas, [velha.id]);
    assert.equal((await assinaturasRepo.buscarPorId(velha.id)).status, 'cancelada');
    assert.equal(await sc.montarRespostaPlano(velha.id), null, 'depois: o link antigo não é mais pagável');
    // Só o que está pendente de pagamento: uma assinatura ativa não é tocada.
    const ativa = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO, status: 'ativa' });
    assert.deepEqual(await assinaturasRepo.cancelarPendentesDePagamento(c.id), []);
    assert.equal((await assinaturasRepo.buscarPorId(ativa.id)).status, 'ativa');
  } finally {
    await apagar(c.id);
  }
});

test('pagamento de intenção já cancelada (link antigo) vira pendência, não credita ciclo', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const velha = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m' });
    await assinaturasRepo.cancelarPendentesDePagamento(c.id);
    const mock = comCheckoutRespondendo({ 'consultar-assinatura': { ultimaCobranca: { status: 'confirmado' } } });
    try {
      await sc.processarWebhookAssinatura({
        versao: 1,
        tipo: 'assinatura',
        planoId: velha.id,
        documento: c.cpf_cnpj,
        evento: 'criada',
        chargeId: `pay_${rodada}`,
      });
    } finally {
      mock.restaurar();
    }
    assert.equal((await assinaturasRepo.buscarPorId(velha.id)).status, 'cancelada', 'continua cancelada');
    const { rows: pend } = await pool.query(
      "SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [velha.id],
    );
    assert.equal(pend.length, 1);
    assert.match(pend[0].motivo, /intenção de compra já cancelada/);
    const { rows: cob } = await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    assert.equal(cob.length, 0, 'nenhuma cobrança registrada');
    const contaDepois = (await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [c.id])).rows[0];
    assert.equal(contaDepois.plano_id, null, 'nenhuma cobertura concedida');

    // O botão do admin também recusa (chave diferente — a dedupe não seguraria).
    const admin = await subirAdmin();
    try {
      const {
        rows: [pendencia],
      } = await pool.query(
        "SELECT id FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
        [velha.id],
      );
      const lista = await admin.chamar('GET', '/admin/eventos-pendentes');
      assert.equal(lista.status, 200);
      assert.equal(lista.corpo.find((e) => e.id === pendencia.id)?.aplicavel, false, 'lista marca como não aplicável');
      const aplicar = await admin.chamar('POST', `/admin/eventos-pendentes/${pendencia.id}/aplicar`);
      assert.equal(aplicar.status, 409);
      assert.match(aplicar.corpo.erro, /intenção de compra já cancelada/);
      assert.equal(
        (await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id])).rows.length,
        0,
      );
    } finally {
      await admin.fechar();
    }
    await pool.query("DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1", [velha.id]);
  } finally {
    await apagar(c.id, rodada);
  }
});

// Revisão do PR #55 (25/09/2026): link pago com o webhook `criada` perdido,
// e o cliente pediu outro link antes da conciliação — o antigo virou
// 'cancelada' e a conciliação só olhava 'ativa'/'pendente_pagamento'. O
// pagamento sumia: nem ciclo, nem pendência. Agora ela vê a intenção
// cancelada recente e registra a MESMA pendência do webhook, uma vez só.
test('conciliação: pagamento de link já cancelado (webhook perdido) vira pendência, uma vez, sem creditar', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const velha = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m' });
    await assinaturasRepo.cancelarPendentesDePagamento(c.id);
    await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    const mock = comCheckoutRespondendo(
      {
        'consultar-assinatura': {
          status: 'ativa',
          ultimaCobranca: { status: 'confirmado', chargeId: `pay_${rodada}`, criadoEm: new Date().toISOString() },
        },
      },
      velha.id,
    );
    let primeira;
    let segunda;
    try {
      primeira = await conciliarAssinaturas({ apenasContas: [c.id] });
      segunda = await conciliarAssinaturas({ apenasContas: [c.id] });
    } finally {
      mock.restaurar();
    }
    assert.equal(primeira.intencoesCanceladasPagas, 1, 'a 1ª varredura acha o pagamento');
    assert.equal(segunda.intencoesCanceladasPagas, 0, 'a 2ª não duplica');
    assert.equal(primeira.aplicadas + segunda.aplicadas, 0, 'nenhum ciclo creditado');
    const { rows: pend } = await pool.query(
      "SELECT motivo, payload FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [velha.id],
    );
    assert.equal(pend.length, 1);
    assert.match(pend[0].motivo, /intenção de compra já cancelada/);
    assert.equal(pend[0].payload.chargeId, `pay_${rodada}`);
    assert.equal((await assinaturasRepo.buscarPorId(velha.id)).status, 'cancelada', 'continua cancelada');
    const { rows: cob } = await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    assert.equal(cob.length, 0, 'nenhuma cobrança registrada');
    await pool.query("DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1", [velha.id]);
  } finally {
    await apagar(c.id, rodada);
  }
});

// Revisão dos PRs #56/#57 (25/09/2026): quem chama `aplicarCicloPago` leu a
// assinatura ANTES (a conciliação carrega a lista inteira e consulta o
// Checkout uma por uma). Se um link novo cancelou esta no meio, o status em
// memória está velho — o crédito tem de olhar a linha travada, não a cópia.
test('aplicarCicloPago relê a assinatura travada: cancelada no meio do caminho vira pendência, não ciclo', async () => {
  const c = await conta();
  try {
    const lida = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m' });
    assert.equal(lida.status, 'pendente_pagamento');
    await assinaturasRepo.cancelarPendentesDePagamento(c.id); // o link novo chegou antes do crédito
    await sc.aplicarCicloPago(lida, [`pay_corrida_${lida.id}|confirmado`]);
    const { rows: cob } = await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    assert.equal(cob.length, 0, 'nenhum ciclo creditado pela cópia velha');
    assert.equal((await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [c.id])).rows[0].plano_id, null);
    const { rows: pend } = await pool.query(
      "SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [lida.id],
    );
    assert.equal(pend.length, 1);
    assert.match(pend[0].motivo, /intenção de compra já cancelada/);
    assert.equal((await assinaturasRepo.buscarPorId(lida.id)).status, 'cancelada');
    await pool.query("DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1", [lida.id]);
  } finally {
    await apagar(c.id);
  }
});

test('assinatura paga antes da migration 087 (ciclo sem assinatura_id) e cancelada depois NÃO é intenção sem pagamento', async () => {
  const c = await conta();
  try {
    const a = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO, status: 'ativa' });
    const {
      rows: [cobranca],
    } = await pool.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status) VALUES ($1, $2, 10, 'pendente') RETURNING id`,
      [c.id, PLANO],
    );
    // Linha como o backfill da 087 gravou: ligada só à cobrança.
    await pool.query(
      `INSERT INTO ciclos_contratados (anunciante_id, plano_id, cobranca_confirmada_id, origem, ciclo_meses, valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
       VALUES ($1, $2, $3, 'compra', 1, 10, 0, 0)`,
      [c.id, PLANO, cobranca.id],
    );
    await assinaturasRepo.marcarCancelada(a.id);
    const cancelada = await assinaturasRepo.buscarPorId(a.id);
    assert.equal(await cicloContratado.jaTeveCicloPago(cancelada), true, 'o ciclo legado conta como pago');
    assert.equal(await sc.intencaoCanceladaSemPagamento(cancelada), false, 'renovação em trânsito continua creditando');
    // E uma intenção nova, cancelada sem pagar, continua sendo recusada.
    const nova = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m' });
    await assinaturasRepo.cancelarPendentesDePagamento(c.id);
    assert.equal(await sc.intencaoCanceladaSemPagamento(await assinaturasRepo.buscarPorId(nova.id)), true);
  } finally {
    await apagar(c.id);
  }
});

test('ciclo legado só conta pra assinatura em cuja janela foi cobrado (intenção abandonada antes da 087 continua sem pagamento)', async () => {
  const c = await conta();
  try {
    // A: intenção abandonada há 3 dias; B: assinatura do MESMO plano, criada
    // ontem e paga hoje (ciclo do backfill, sem assinatura_id).
    const a = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await pool.query(
      "UPDATE assinaturas SET status = 'cancelada', created_at = now() - interval '3 days' WHERE id = $1",
      [a.id],
    );
    const b = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO, status: 'ativa' });
    await pool.query("UPDATE assinaturas SET created_at = now() - interval '1 day' WHERE id = $1", [b.id]);
    const {
      rows: [cobranca],
    } = await pool.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status) VALUES ($1, $2, 10, 'pendente') RETURNING id`,
      [c.id, PLANO],
    );
    await pool.query(
      `INSERT INTO ciclos_contratados (anunciante_id, plano_id, cobranca_confirmada_id, origem, ciclo_meses, valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
       VALUES ($1, $2, $3, 'compra', 1, 10, 0, 0)`,
      [c.id, PLANO, cobranca.id],
    );
    assert.equal(await cicloContratado.jaTeveCicloPago(await assinaturasRepo.buscarPorId(b.id)), true, 'B pagou');
    assert.equal(
      await cicloContratado.jaTeveCicloPago(await assinaturasRepo.buscarPorId(a.id)),
      false,
      'a cobrança é de B, não de A',
    );
    assert.equal(
      await sc.intencaoCanceladaSemPagamento(await assinaturasRepo.buscarPorId(a.id)),
      true,
      'pagamento tardio de A é recusado',
    );
  } finally {
    await apagar(c.id);
  }
});

// Primeiro ciclo pago (`criada`) no contrato v2 do Checkout, com ids
// previsíveis por rodada.
const primeiroCicloV2 = (assinatura, documento, rodada) =>
  sc.processarWebhookAssinatura({
    versao: 2,
    tipo: 'assinatura',
    eventoId: `evt_aud006_${rodada}`,
    ocorridoEm: new Date().toISOString(),
    evento: 'criada',
    planoId: assinatura.id,
    documento,
    chargeId: `pay_aud006_${rodada}`,
    statusFinanceiro: 'confirmado',
    valor: 99.9,
  });
const limparChaves = (rodada) =>
  pool.query('DELETE FROM webhooks_processados WHERE id IN ($1, $2)', [
    `evt_aud006_${rodada}`,
    `pay_aud006_${rodada}|confirmado`,
  ]);

// AUD-005, 2ª rodada: com a reserva movida pra dentro da transação do ciclo,
// as decisões que NÃO creditam (intenção cancelada, conta excluída) deixaram
// de gravar chave — cada reentrega abria outra pendência "devolva o valor"
// pro mesmo pagamento. Agora a chave da notificação entra junto com a
// pendência.
const pendenciasDe = async (assinaturaId) =>
  (
    await pool.query(
      "SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [assinaturaId],
    )
  ).rows;

test('AUD-005: `criada` de intenção já cancelada entregue duas vezes gera UMA pendência', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const velha = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m' });
    await assinaturasRepo.cancelarPendentesDePagamento(c.id);
    await primeiroCicloV2(velha, c.cpf_cnpj, rodada);
    await primeiroCicloV2(velha, c.cpf_cnpj, rodada); // reentrega do Checkout
    const pend = await pendenciasDe(velha.id);
    assert.equal(pend.length, 1, 'uma pendência "devolva o valor", não duas');
    assert.match(pend[0].motivo, /intenção de compra já cancelada/);
  } finally {
    await limparChaves(rodada);
    await apagar(c.id, rodada);
  }
});

test('AUD-005: ciclo de conta excluída entregue duas vezes gera UMA pendência', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [c.id]);
    await primeiroCicloV2(assinatura, c.cpf_cnpj, rodada);
    await primeiroCicloV2(assinatura, c.cpf_cnpj, rodada);
    const pend = await pendenciasDe(assinatura.id);
    assert.equal(pend.length, 1);
    assert.match(pend[0].motivo, /conta já excluída/);
    const { rows: cob } = await pool.query('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    assert.equal(cob.length, 0, 'nada creditado');
  } finally {
    await limparChaves(rodada);
    await apagar(c.id, rodada);
  }
});

test('AUD-005: intenção cancelada relida no FOR UPDATE — a 2ª tentativa (ou a varredura de amanhã) não abre outra pendência', async () => {
  const c = await conta();
  const chave = `pay_relida_${randomUUID().slice(0, 8)}|confirmado`;
  try {
    const lida = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: 'destaque-1m' });
    await assinaturasRepo.cancelarPendentesDePagamento(c.id); // cancelada entre a leitura e o crédito
    await sc.aplicarCicloPago(lida, [chave]);
    const segunda = await sc.aplicarCicloPago(lida, [chave]);
    assert.deepEqual(segunda, { pendenciaJaRegistrada: chave }, 'a decisão já estava na fila (não é ciclo creditado)');
    assert.equal((await pendenciasDe(lida.id)).length, 1);
    const { rows: guardada } = await pool.query('SELECT 1 FROM webhooks_processados WHERE id = $1', [chave]);
    assert.equal(guardada.length, 1, 'a chave ficou junto com a pendência');
  } finally {
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [chave]);
    await apagar(c.id);
  }
});

// Evento v2 do Checkout com ids previsíveis por rodada (3ª rodada da
// auditoria): `cancelada` vem sem cobrança.
const eventoV2 = (assinatura, { id, evento = 'criada', documento }) =>
  sc.processarWebhookAssinatura({
    versao: 2,
    tipo: 'assinatura',
    eventoId: `evt_r3_${id}`,
    ocorridoEm: new Date().toISOString(),
    evento,
    planoId: assinatura.id,
    documento,
    chargeId: evento === 'cancelada' ? null : `pay_r3_${id}`,
    statusFinanceiro: evento === 'cancelada' ? 'cancelado' : 'confirmado',
    valor: evento === 'cancelada' ? null : 99.9,
  });
const limparR3 = (ids) =>
  pool.query('DELETE FROM webhooks_processados WHERE id = ANY($1)', [
    ids.flatMap((id) => [`evt_r3_${id}`, `pay_r3_${id}|confirmado`]),
  ]);

// AUD-005, 3ª rodada: a decisão que não credita devolvia `{ jaAplicada }`, o
// mesmo marcador de "ciclo creditado". Numa `cobranca_confirmada` reentregue,
// aplicarEventoAssinatura abria por cima a pendência "descartado pela
// deduplicação" — aplicável, de um ciclo que nunca entrou.
test('AUD-005: `cobranca_confirmada` de conta excluída entregue duas vezes gera UMA pendência, sem "descartado pela deduplicação"', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO, status: 'ativa' });
    await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [c.id]);
    await eventoV2(assinatura, { id: rodada, evento: 'cobranca_confirmada', documento: c.cpf_cnpj });
    await eventoV2(assinatura, { id: rodada, evento: 'cobranca_confirmada', documento: c.cpf_cnpj });
    const pend = await pendenciasDe(assinatura.id);
    assert.equal(pend.length, 1, JSON.stringify(pend.map((p) => p.motivo)));
    assert.match(pend[0].motivo, /conta já excluída/);
  } finally {
    await limparR3([rodada]);
    await apagar(c.id, rodada);
  }
});

test.after(() => pool.end());
