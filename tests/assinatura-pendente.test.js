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
const eventos = require('../src/lib/eventos');

// Rotas do financeiro montadas direto (a proteção do /admin é do server.js,
// não do router) — pra bater no botão "Aplicar este ciclo" e, com
// `{ anuncianteId }`, nas rotas da própria conta.
async function subirAdmin(sessao = { adminUsuario: 'teste' }) {
  const express = require('express');
  require('express-async-errors');
  const app = express();
  app.use(express.json());
  app.use((req, _res, proximo) => {
    req.session = { ...sessao };
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
// Chamada que não é pro Checkout (o app de teste local) passa direto;
// `corpos` guarda o que foi mandado ao Checkout, rota a rota.
function comCheckoutRespondendo(respostas, soPara = null) {
  const original = globalThis.fetch;
  const chamadas = [];
  const corpos = [];
  globalThis.fetch = async (url, opcoes) => {
    if (!String(url).includes('/api/checkout/')) return original(url, opcoes);
    const rota = String(url).split('/api/checkout/')[1];
    chamadas.push(rota);
    const corpoPedido = opcoes?.body ? JSON.parse(opcoes.body) : {};
    corpos.push({ rota, ...corpoPedido });
    if (soPara && corpoPedido.planoId && corpoPedido.planoId !== soPara) {
      return { ok: false, status: 404, json: async () => ({}) };
    }
    const r = typeof respostas[rota] === 'function' ? respostas[rota]() : respostas[rota];
    // {status: <http>, corpo} para erro HTTP; qualquer outro objeto é o corpo 200.
    const http = r && r.corpo !== undefined ? r.status : 200;
    const corpo = r && r.corpo !== undefined ? r.corpo : (r ?? {});
    return { ok: http >= 200 && http < 300, status: http, json: async () => corpo };
  };
  return { chamadas, corpos, restaurar: () => (globalThis.fetch = original) };
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
const eventoV2 = (assinatura, { id, evento = 'criada', documento, ocorridoEm = new Date().toISOString() }) =>
  sc.processarWebhookAssinatura({
    versao: 2,
    tipo: 'assinatura',
    eventoId: `evt_r3_${id}`,
    ocorridoEm,
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

// AUD-006 (auditoria técnica, 11/10/2026): o Checkout acha a assinatura pelo
// par planoId + documento, e o documento é o que o PAGADOR confirmou na tela
// dele (pode diferir do cadastro). A Mostraí mandava o cpf_cnpj da conta:
// 404, e o 404 virava "cancelada com sucesso" com a Asaas seguindo a cobrar.
const pendenciasCompletas = async (assinaturaId) =>
  (
    await pool.query(
      "SELECT id, motivo, payload FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [assinaturaId],
    )
  ).rows;
const cobrancasDe = async (contaId) =>
  (await pool.query('SELECT count(*)::int AS n FROM cobrancas_confirmadas WHERE anunciante_id = $1', [contaId])).rows[0]
    .n;

test('AUD-006: documento do pagador diferente do cadastro é gravado no `criada`, vira pendência e é o que o cancelamento manda', async () => {
  const c = await conta(); // cpf_cnpj da conta: 11144477735
  const rodada = randomUUID().slice(0, 8);
  const documentoDoPagador = '52998224725';
  let mock;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await primeiroCicloV2(assinatura, documentoDoPagador, rodada);
    const depois = await assinaturasRepo.buscarPorId(assinatura.id);
    assert.equal(depois.status, 'ativa', 'o ciclo pago entra normalmente');
    assert.equal(depois.documento_pagador, documentoDoPagador, 'o documento do pagador fica na assinatura');
    const { rows: pend } = await pool.query(
      "SELECT motivo, payload FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido",
      [assinatura.id],
    );
    assert.equal(pend.length, 1, 'uma pendência pro admin conferir o cadastro');
    assert.match(pend[0].motivo, /documento do pagador no Checkout diverge do CPF\/CNPJ cadastrado/);
    assert.doesNotMatch(pend[0].motivo, /\d{11}/, 'o número não vai no texto');

    mock = comCheckoutRespondendo({ 'cancelar-assinatura': { assinaturaId: 'sub_x', status: 'cancelada' } });
    const app = await subirAdmin({ anuncianteId: c.id });
    try {
      const r = await app.chamar('POST', '/anunciantes/me/cancelar-assinatura');
      assert.equal(r.status, 200);
    } finally {
      await app.fechar();
    }
    const pedido = mock.corpos.find((x) => x.rota === 'cancelar-assinatura');
    assert.equal(pedido.documento, documentoDoPagador, 'cancela com o documento que a Asaas conhece');
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'cancelada');
  } finally {
    mock?.restaurar();
    await limparChaves(rodada);
    await apagar(c.id, rodada);
  }
});

test('AUD-006: 404 ao cancelar assinatura com ciclo pago não marca cancelada — pendência e erro claro; já encerrada no Checkout fecha', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  let mock;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await primeiroCicloV2(assinatura, c.cpf_cnpj, rodada);
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa');

    // O Checkout não acha nada com esse par (nem ativa, nem encerrada).
    mock = comCheckoutRespondendo({
      'cancelar-assinatura': { status: 404, corpo: { erro: 'nenhuma' } },
      'consultar-assinatura': { status: 404, corpo: {} },
    });
    const app = await subirAdmin({ anuncianteId: c.id });
    try {
      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        const r = await app.chamar('POST', '/anunciantes/me/cancelar-assinatura');
        assert.equal(r.status, 502, `tentativa ${tentativa}: não é sucesso`);
        assert.match(r.corpo.erro, /não encontramos sua assinatura no Checkout/);
      }
      mock.restaurar();
      assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa', 'continua ativa aqui');
      const { rows: pend } = await pool.query(
        "SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND NOT resolvido AND payload->>'evento' = 'cancelamento_nao_encontrado'",
        [assinatura.id],
      );
      assert.equal(pend.length, 1, 'uma pendência, mesmo com duas tentativas');
      assert.match(pend[0].motivo, /assinatura não encontrada no Checkout/);
      const { rows: emails } = await pool.query(
        "SELECT 1 FROM email_outbox WHERE anunciante_id = $1 AND tipo = 'assinatura_cancelada'",
        [c.id],
      );
      assert.equal(emails.length, 0, 'nenhum e-mail de "assinatura cancelada"');
      const admin = await subirAdmin();
      try {
        const lista = await admin.chamar('GET', '/admin/eventos-pendentes');
        const item = lista.corpo.find(
          (e) => e.payload?.evento === 'cancelamento_nao_encontrado' && e.payload.planoId === assinatura.id,
        );
        assert.equal(item?.aplicavel, false, 'não oferece "Aplicar este ciclo"');
      } finally {
        await admin.fechar();
      }

      // Já encerrada do lado de lá (cancelada na Asaas, ou resposta perdida):
      // o 404 é "nada a cancelar" de verdade, e a consulta prova.
      mock = comCheckoutRespondendo({
        'cancelar-assinatura': { status: 404, corpo: { erro: 'nenhuma' } },
        'consultar-assinatura': { status: 'cancelada', ultimaCobranca: null },
      });
      const r = await app.chamar('POST', '/anunciantes/me/cancelar-assinatura');
      assert.equal(r.status, 200);
      assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'cancelada');
    } finally {
      await app.fechar();
    }
  } finally {
    mock?.restaurar();
    await limparChaves(rodada);
    await apagar(c.id, rodada);
  }
});

// Revisão da 2ª rodada: a pendência de documento divergente nascia com o
// payload do `criada` — `aplicavel: true` e o botão "Aplicar este ciclo". Num
// `criada` que entrou sem chargeId (v1, chave `criada|<id>`), a consulta 5.3
// depois devolve o id, a chave `chargeId|confirmado` não existe, e o clique
// creditava um SEGUNDO ciclo pelo mesmo pagamento.
test('AUD-006: pendência de documento divergente não é "aplicável" — o botão recusa sem creditar', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  let mock;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await primeiroCicloV2(assinatura, '52998224725', rodada);
    const contarCobrancas = async () =>
      (await pool.query('SELECT count(*)::int AS n FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]))
        .rows[0].n;
    assert.equal(await contarCobrancas(), 1);

    // O Checkout passa a mostrar a cobrança com um chargeId que esta base não
    // registrou (o caso do `criada` que entrou antes de a Asaas revelar o id).
    mock = comCheckoutRespondendo(
      {
        'consultar-assinatura': {
          status: 'ativa',
          ultimaCobranca: { chargeId: `pay_revelado_${rodada}`, status: 'confirmado', valorCobrado: 99.9 },
        },
      },
      assinatura.id,
    );
    const admin = await subirAdmin();
    try {
      const lista = await admin.chamar('GET', '/admin/eventos-pendentes');
      const item = lista.corpo.find(
        (e) => e.payload?.planoId === assinatura.id && /documento do pagador/.test(e.motivo),
      );
      assert.ok(item, 'a pendência de documento divergente está na fila');
      assert.equal(item.payload.evento, 'documento_pagador_divergente');
      assert.equal(item.aplicavel, false, 'sem "Aplicar este ciclo"');
      const r = await admin.chamar('POST', `/admin/eventos-pendentes/${item.id}/aplicar`);
      assert.equal(r.status, 409, JSON.stringify(r.corpo));
    } finally {
      await admin.fechar();
    }
    assert.equal(await contarCobrancas(), 1, 'nenhum ciclo a mais');
  } finally {
    mock?.restaurar();
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [`pay_revelado_${rodada}|confirmado`]);
    await limparChaves(rodada);
    await apagar(c.id, rodada);
  }
});

// Revisão da 2ª rodada: o documento do pagador valia numa porta só. A
// conciliação apelidava o documento de `cpf_cnpj` e mandava pro aviso de
// renovação a linha sem `documento_pagador` (token assinado com o da conta),
// e o GET /plano — que a pop-up de renovação lê — pré-preenchia o da conta:
// token e pop-up com documentos diferentes = o Checkout cria outra
// assinatura sem cancelar a antiga.
test('AUD-006: link de renovação da conciliação e GET /plano usam o documento do pagador', async () => {
  const c = await conta(); // cpf_cnpj da conta: 11144477735
  const rodada = randomUUID().slice(0, 8);
  const documentoDoPagador = '52998224725';
  const crypto = require('node:crypto');
  const outbox = require('../src/email/outbox');
  const enfileirarReal = outbox.enfileirar;
  const enfileirados = [];
  let mock;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await primeiroCicloV2(assinatura, documentoDoPagador, rodada);
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador, documentoDoPagador);

    // GET /plano: o que a pop-up de renovação pré-preenche.
    assert.equal((await sc.montarRespostaPlano(assinatura.id)).pagador.documento, documentoDoPagador);

    // Conciliação: a renovação foi recusada e o webhook `cobranca_falhou` se perdeu.
    outbox.enfileirar = async (msg) => {
      enfileirados.push(msg);
      return { novo: true };
    };
    mock = comCheckoutRespondendo(
      {
        'consultar-assinatura': {
          status: 'ativa',
          ultimaCobranca: { chargeId: `pay_recusado_${rodada}`, status: 'recusado' },
        },
      },
      assinatura.id,
    );
    await conciliarAssinaturas({ apenasContas: [c.id] });
    const consulta = mock.corpos.find((x) => x.rota === 'consultar-assinatura' && x.planoId === assinatura.id);
    assert.equal(consulta?.documento, documentoDoPagador, 'a conciliação consulta com o documento do pagador');
    const aviso = enfileirados.find((m) => m.tipo === 'cobranca_falhou');
    assert.ok(aviso?.segredo?.link, 'o aviso de renovação sai com link');
    const [ts, assinado] = aviso.segredo.link.match(/[?&]renovar=([^&]+)/)[1].split('.');
    const hmac = (documento) =>
      crypto
        .createHmac('sha256', process.env.SAN_CHECKOUT_KEY)
        .update(`${ts}.${process.env.SAN_CHECKOUT_CONTRATANTE_ID}.${assinatura.id}.${documento}`)
        .digest('hex');
    assert.equal(assinado, hmac(documentoDoPagador), 'o token do link é o do documento do pagador');
    assert.notEqual(assinado, hmac(c.cpf_cnpj));
  } finally {
    outbox.enfileirar = enfileirarReal;
    mock?.restaurar();
    await limparChaves(rodada);
    await apagar(c.id, rodada);
  }
});

// AUD-006, 3ª rodada: o pagador que digita OUTRO CPF/CNPJ na pop-up de
// renovação ganha uma 2ª recorrência do mesmo plano no Checkout (o token não
// confere e vira assinatura nova, API.md 7.3) — a 1ª segue viva. O documento
// era gravado uma vez só: o webhook creditava a 2ª calado, e o cancelamento
// matava a 1ª enquanto a 2ª seguia cobrando.
test('AUD-006: pagamento com outro documento na mesma assinatura — pendência "documento_pagador_mudou", vale o mais recente, o cancelamento usa ele e o `cancelada` da recorrência antiga não fecha a daqui', async () => {
  const c = await conta(); // cpf_cnpj da conta: 11144477735
  const rodada = randomUUID().slice(0, 8);
  const ids = [`${rodada}a`, `${rodada}b`, `${rodada}c`];
  const outro = '52998224725';
  let mock;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await eventoV2(assinatura, { id: ids[0], documento: c.cpf_cnpj }); // 1ª recorrência
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador, c.cpf_cnpj);

    await eventoV2(assinatura, { id: ids[1], documento: outro }); // 2ª recorrência, outro CPF/CNPJ
    await eventoV2(assinatura, { id: ids[1], documento: outro }); // reentrega da mesma notificação
    assert.equal(
      (await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador,
      outro,
      'vale o documento da recorrência que acabou de cobrar',
    );
    assert.equal(await cobrancasDe(c.id), 2, 'o dinheiro das duas entrou');
    const mudou = (await pendenciasCompletas(assinatura.id)).filter(
      (p) => p.payload.evento === 'documento_pagador_mudou',
    );
    assert.equal(mudou.length, 1, 'uma pendência, mesmo com a reentrega');
    assert.equal(mudou[0].payload.documentoAnterior, c.cpf_cnpj, 'o Admin sabe qual recorrência procurar');
    assert.match(mudou[0].motivo, /DUAS recorrências/);
    assert.doesNotMatch(mudou[0].motivo, /\d{11}/, 'o número não vai no texto');
    const admin = await subirAdmin();
    try {
      const lista = await admin.chamar('GET', '/admin/eventos-pendentes');
      assert.equal(lista.corpo.find((e) => e.id === mudou[0].id)?.aplicavel, false, 'sem "Aplicar este ciclo"');
    } finally {
      await admin.fechar();
    }

    // O Admin cancela a recorrência antiga no Checkout: o `cancelada` dela
    // (documento anterior) não fecha a assinatura daqui — a nova segue ativa.
    await eventoV2(assinatura, { id: ids[2], evento: 'cancelada', documento: c.cpf_cnpj });
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa');

    // O cliente cancela: vai pro documento vigente, o da recorrência que cobra.
    mock = comCheckoutRespondendo({ 'cancelar-assinatura': { assinaturaId: 'sub_r3', status: 'cancelada' } });
    const app = await subirAdmin({ anuncianteId: c.id });
    try {
      assert.equal((await app.chamar('POST', '/anunciantes/me/cancelar-assinatura')).status, 200);
    } finally {
      await app.fechar();
    }
    assert.equal(mock.corpos.find((x) => x.rota === 'cancelar-assinatura')?.documento, outro);
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'cancelada');
  } finally {
    mock?.restaurar();
    await eventos.aguardarGravacoes();
    await limparR3(ids);
    await apagar(c.id, rodada);
  }
});

// 5ª revisão Codex do PR #136: a inbox reenvia com espera e a conciliação
// aplica ciclo atrasado — um pagamento ANTIGO com o documento A pode entrar
// DEPOIS do novo com B. `cicloNovo` só diz que o ciclo não tinha entrado
// aqui; quem está cobrando é o pagamento mais novo, e o vigente fica.
test('AUD-006: pagamento antigo com outro documento que entra depois do novo não devolve o vigente', async () => {
  const c = await conta(); // cpf_cnpj da conta: 11144477735
  const rodada = randomUUID().slice(0, 8);
  const ids = [`${rodada}n`, `${rodada}v`];
  const outro = '52998224725';
  const DIA = 24 * 3600 * 1000;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    const agora = Date.now();
    // O novo (2ª recorrência, outro CPF/CNPJ) entra primeiro...
    await eventoV2(assinatura, { id: ids[0], documento: outro, ocorridoEm: new Date(agora).toISOString() });
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador, outro);
    // ...e o antigo (1ª recorrência, pago 30 dias antes) chega atrasado.
    await eventoV2(assinatura, {
      id: ids[1],
      documento: c.cpf_cnpj,
      ocorridoEm: new Date(agora - 30 * DIA).toISOString(),
    });
    assert.equal(
      (await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador,
      outro,
      'o vigente é o do pagamento mais novo, não o do processado por último',
    );
    assert.equal(await cobrancasDe(c.id), 2, 'o dinheiro dos dois entrou');
    const mudou = (await pendenciasCompletas(assinatura.id)).filter(
      (p) => p.payload.evento === 'documento_pagador_mudou',
    );
    assert.equal(mudou.length, 1, 'o Admin fica sabendo das duas recorrências');
    assert.equal(mudou[0].payload.documentoAtrasado, c.cpf_cnpj);
    assert.equal(mudou[0].payload.documentoMantido, outro);
    assert.match(mudou[0].motivo, /ATRASADO/);
    assert.doesNotMatch(mudou[0].motivo, /\d{11}/, 'o número não vai no texto');
  } finally {
    await eventos.aguardarGravacoes();
    await limparR3(ids);
    await apagar(c.id, rodada);
  }
});

// Guarda do RUNBOOK §6 (assinatura legada, sem documento gravado): cancelada
// pelo Checkout com o documento do pagador, o `cancelada` dela fecha o
// registro daqui — sem trocar o CPF/CNPJ da conta.
test('AUD-006: assinatura sem documento do pagador (legada) — o `cancelada` com o documento do pagador fecha o registro', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO, status: 'ativa' });
    assert.equal(assinatura.documento_pagador, null);
    await eventoV2(assinatura, { id: rodada, evento: 'cancelada', documento: '52998224725' });
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'cancelada');
  } finally {
    await limparR3([rodada]);
    await apagar(c.id, rodada);
  }
});

test('AUD-006: documento que chega num ciclo já creditado por outro caminho (conciliação/admin) é gravado, com o aviso de cadastro divergente', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    // A conciliação credita a cobrança antes do webhook — ela não traz documento.
    await sc.aplicarCicloPago(assinatura, [`pay_r3_${rodada}|confirmado`], null, { chargeId: `pay_r3_${rodada}` });
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador, null);
    // O `criada` atrasado cai na dedupe da cobrança, mas o documento dele fica.
    await eventoV2(assinatura, { id: rodada, documento: '52998224725' });
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador, '52998224725');
    const divergente = (await pendenciasCompletas(assinatura.id)).filter(
      (p) => p.payload.evento === 'documento_pagador_divergente',
    );
    assert.equal(divergente.length, 1, 'o aviso de cadastro divergente sai');
    assert.equal(await cobrancasDe(c.id), 1, 'nenhum ciclo a mais');
  } finally {
    await eventos.aguardarGravacoes();
    await limparR3([rodada]);
    await apagar(c.id, rodada);
  }
});

// O processo morre logo depois do COMMIT do ciclo: o que ainda ia rodar em
// autocommit (pendência gravada pelo `pool`) nunca acontece. O client da
// transação do ciclo marca o COMMIT; depois dele, INSERT de pendência pelo
// pool falha como num processo morto.
function morrerLogoDepoisDoCommitDoCiclo() {
  const connectOriginal = pool.connect;
  const queryOriginal = pool.query;
  const morte = { morreu: false };
  pool.connect = function (...args) {
    if (args.length) return connectOriginal.apply(this, args);
    return connectOriginal.call(this).then((cliente) => {
      const q = cliente.query.bind(cliente);
      let dentroDoCiclo = false;
      cliente.query = (sql, ...resto) => {
        if (typeof sql === 'string' && sql.includes('FROM anunciantes WHERE id = $1 FOR UPDATE')) dentroDoCiclo = true;
        const r = q(sql, ...resto);
        if (!dentroDoCiclo || sql !== 'COMMIT') return r;
        return r.then((x) => {
          morte.morreu = true;
          return x;
        });
      };
      return cliente;
    });
  };
  pool.query = function (sql, ...resto) {
    if (morte.morreu && typeof sql === 'string' && sql.includes('INSERT INTO eventos_assinatura_pendentes')) {
      return Promise.reject(new Error('processo morto depois do COMMIT (simulado)'));
    }
    return queryOriginal.call(this, sql, ...resto);
  };
  morte.restaurar = () => {
    pool.connect = connectOriginal;
    pool.query = queryOriginal;
  };
  return morte;
}

test('AUD-006: o aviso de documento divergente entra no COMMIT do ciclo — processo morto logo depois não o perde', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    const morte = morrerLogoDepoisDoCommitDoCiclo();
    try {
      await eventoV2(assinatura, { id: rodada, documento: '52998224725' });
    } finally {
      morte.restaurar();
    }
    assert.equal(morte.morreu, true, 'o ciclo foi gravado');
    // A retomada da inbox entrega de novo: cai na dedupe (o ciclo já entrou).
    await eventoV2(assinatura, { id: rodada, documento: '52998224725' });
    const divergente = (await pendenciasCompletas(assinatura.id)).filter(
      (p) => p.payload.evento === 'documento_pagador_divergente',
    );
    assert.equal(divergente.length, 1, 'o aviso entrou junto com o ciclo');
    assert.equal(await cobrancasDe(c.id), 1);
  } finally {
    await limparR3([rodada]);
    await apagar(c.id, rodada);
  }
});

// Guarda da troca do documento vigente (3ª rodada): o botão "Aplicar este
// ciclo" credita a cobrança que a CONSULTA achou, com o documento vigente — o
// payload guardado na pendência pode ser de uma recorrência anterior e não
// pode trocar o documento.
test('AUD-006: "Aplicar este ciclo" usa o documento da consulta, não o do payload antigo da pendência', async () => {
  const c = await conta();
  const rodada = randomUUID().slice(0, 8);
  let mock;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO });
    await eventoV2(assinatura, { id: rodada, documento: c.cpf_cnpj });
    const {
      rows: [pendencia],
    } = await pool.query(
      `INSERT INTO eventos_assinatura_pendentes (payload, motivo) VALUES ($1, 'falha ao aplicar o ciclo pago: teste') RETURNING id`,
      [JSON.stringify({ tipo: 'assinatura', evento: 'criada', planoId: assinatura.id, documento: '52998224725' })],
    );
    mock = comCheckoutRespondendo(
      {
        'consultar-assinatura': {
          status: 'ativa',
          ultimaCobranca: { chargeId: `pay_r3_${rodada}x`, status: 'confirmado', valorCobrado: 99.9 },
        },
      },
      assinatura.id,
    );
    const admin = await subirAdmin();
    try {
      const r = await admin.chamar('POST', `/admin/eventos-pendentes/${pendencia.id}/aplicar`);
      assert.equal(r.status, 200, JSON.stringify(r.corpo));
    } finally {
      await admin.fechar();
    }
    assert.equal(mock.corpos.find((x) => x.rota === 'consultar-assinatura')?.documento, c.cpf_cnpj);
    assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).documento_pagador, c.cpf_cnpj);
    const mudou = (await pendenciasCompletas(assinatura.id)).filter(
      (p) => p.payload.evento === 'documento_pagador_mudou',
    );
    assert.equal(mudou.length, 0);
    assert.equal(await cobrancasDe(c.id), 2);
  } finally {
    mock?.restaurar();
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [`pay_r3_${rodada}x|confirmado`]);
    await limparR3([rodada]);
    await apagar(c.id, rodada);
  }
});

test.after(() => pool.end());
