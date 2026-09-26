const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const express = require('express');
const pool = require('../src/db/pool');

// Inbox durável do webhook do San Checkout (migration 096). O que este
// arquivo prova, sobre a rota REAL e o banco:
//   · HMAC inválida não entra; evento válido é gravado ANTES do 200;
//   · falha ao gravar devolve 503 (o Checkout tenta de novo);
//   · reentrega = uma linha e um efeito;
//   · falha no processamento não perde o evento: nova tentativa com espera
//     crescente, estado "morto" depois do limite (vira pendência no admin);
//   · instância que morre no meio é retomada por outra;
//   · duas instâncias nunca processam o mesmo evento;
//   · chargeback, estorno e troca revertida — os que a conciliação diária
//     não recupera — sobrevivem a falha e aplicam o efeito UMA vez.
process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-teste';
process.env.SAN_CHECKOUT_API_URL = process.env.SAN_CHECKOUT_API_URL || 'https://checkout.exemplo';
const inbox = require('../src/financeiro/webhook-inbox');
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const anunciantesRepo = require('../src/anunciantes/repository');

const PLANO = 'essencial-1m';
const processadoresOriginais = { ...inbox.processadores };
const contas = [];

// Nenhum teste aqui pode falar com o Checkout de verdade (v2 não consulta).
const fetchOriginal = globalThis.fetch;
let servidor;
let base;

test.before(async () => {
  globalThis.fetch = async (url, ...resto) => {
    if (String(url).startsWith(base)) return fetchOriginal(url, ...resto);
    throw new Error(`teste não deveria consultar ${url}`);
  };
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));
  app.use(require('../src/financeiro/routes').router);
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  await pool.query('DELETE FROM webhooks_recebidos');
});

test.afterEach(() => Object.assign(inbox.processadores, processadoresOriginais));

test.after(async () => {
  globalThis.fetch = fetchOriginal;
  await new Promise((r) => servidor.close(r));
  for (const id of contas) {
    await pool.query(
      "DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' IN (SELECT id FROM assinaturas WHERE anunciante_id = $1)",
      [id],
    );
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.query('DELETE FROM webhooks_recebidos');
  await pool.end();
});

async function contaComAssinatura() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, email_confirmado)
     VALUES ('Inbox Ltda', '52998224725', $1, '16999990000', 'x', now(), true) RETURNING *`,
    [`inbox-${crypto.randomUUID().slice(0, 8)}@teste.com`],
  );
  contas.push(rows[0].id);
  const assinatura = await assinaturasRepo.criar({ anuncianteId: rows[0].id, planoId: PLANO });
  return { conta: rows[0], assinatura };
}

const evento = (assinatura, conta, extras) => ({
  versao: 2,
  tipo: 'assinatura',
  eventoId: `evt_inbox_${crypto.randomUUID()}`,
  ocorridoEm: new Date().toISOString(),
  planoId: assinatura.id,
  documento: conta.cpf_cnpj,
  statusFinanceiro: 'confirmado',
  ...extras,
});

// Entrega assinada como o Checkout faz (API.md 4.3.1): HMAC de `ts.` + corpo cru.
async function entregar(payload, { assinatura = true } = {}) {
  const corpo = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = `sha256=${crypto.createHmac('sha256', process.env.SAN_CHECKOUT_KEY).update(`${ts}.${corpo}`).digest('hex')}`;
  const r = await fetch(`${base}/webhook/san-checkout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Checkout-Timestamp': ts,
      'X-Checkout-Signature': assinatura ? sig : 'sha256=deadbeef',
    },
    body: corpo,
  });
  return r.status;
}

const linha = async (eventoId) =>
  (await pool.query('SELECT * FROM webhooks_recebidos WHERE chave = $1', [`evento:${eventoId}`])).rows[0];

// Deixa o processador (disparado pela rota logo depois do 200) terminar.
const esperarProcessador = async () => {
  await inbox.aguardarRodadas();
  await inbox.processarPendentes();
};

// "O tempo passou": a próxima tentativa agendada vence agora.
const vencerEspera = (eventoId) =>
  pool.query(
    "UPDATE webhooks_recebidos SET proxima_tentativa_em = now() WHERE chave = $1 AND status = 'tentando_de_novo'",
    [`evento:${eventoId}`],
  );

const pendencias = async (assinatura, trecho) =>
  (
    await pool.query(
      "SELECT count(*)::int n FROM eventos_assinatura_pendentes WHERE payload->>'planoId' = $1 AND motivo LIKE $2",
      [assinatura.id, `%${trecho}%`],
    )
  ).rows[0].n;

const suspensoesRegistradas = async (conta) => {
  await new Promise((r) => setTimeout(r, 150)); // eventos.registrar é fire-and-forget
  return (
    await pool.query(
      "SELECT count(*)::int n FROM eventos WHERE anunciante_id = $1 AND nome = 'pagamento:chargeback_suspende'",
      [conta.id],
    )
  ).rows[0].n;
};

// Falha na PRIMEIRA chamada de uma função de repositório usada DEPOIS da
// reserva de deduplicação — é o cenário que antes perdia o evento.
function falharUmaVez(modulo, nome) {
  const original = modulo[nome];
  let falhou = false;
  modulo[nome] = async (...args) => {
    if (!falhou) {
      falhou = true;
      throw new Error('banco caiu no meio (simulado)');
    }
    return original.apply(modulo, args);
  };
  return () => (modulo[nome] = original);
}

test('1. HMAC inválida: 401 e nada gravado', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, { evento: 'cobranca_estornada' });
  assert.equal(await entregar(ev, { assinatura: false }), 401);
  assert.equal(await linha(ev.eventoId), undefined);
});

test('2. evento válido é gravado ANTES do 200', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  let liberar;
  // Processador segurado: se o 200 viesse antes da gravação, a linha não existiria aqui.
  inbox.processadores.assinatura = () => new Promise((r) => (liberar = r));
  const ev = evento(assinatura, conta, { evento: 'cobranca_estornada' });
  assert.equal(await entregar(ev), 200);
  const gravada = await linha(ev.eventoId);
  assert.ok(gravada, 'a linha existe no momento em que o 200 chega');
  assert.ok(['recebido', 'processando'].includes(gravada.status));
  assert.equal(gravada.evento, 'cobranca_estornada');
  await new Promise((r) => setTimeout(r, 50));
  liberar?.();
  await esperarProcessador();
});

test('3. falha ao gravar devolve 503 (o Checkout tenta de novo)', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const receberOriginal = inbox.receber;
  inbox.receber = async () => {
    throw new Error('connection terminated');
  };
  try {
    const ev = evento(assinatura, conta, { evento: 'cobranca_estornada' });
    assert.equal(await entregar(ev), 503);
    assert.equal(await linha(ev.eventoId), undefined);
  } finally {
    inbox.receber = receberOriginal;
  }
});

test('4 e 13. reentrega do mesmo evento: 200 nas duas, uma linha, uma suspensão', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, { evento: 'cobranca_contestada', statusFinanceiro: 'chargeback' });
  assert.equal(await entregar(ev), 200);
  assert.equal(await entregar({ ...ev }), 200);
  await esperarProcessador();
  const { rows } = await pool.query('SELECT count(*)::int n FROM webhooks_recebidos WHERE chave = $1', [
    `evento:${ev.eventoId}`,
  ]);
  assert.equal(rows[0].n, 1);
  assert.equal((await linha(ev.eventoId)).status, 'processado');
  assert.equal((await anunciantesRepo.buscarPorId(conta.id)).suspenso, true);
  assert.equal(await suspensoesRegistradas(conta), 1);
  assert.equal(await pendencias(assinatura, 'chargeback'), 1);
});

test('5 e 6. evento gravado e instância reiniciada antes de processar: o processador retoma', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, {
    evento: 'cobranca_estornada',
    estornoParcial: true,
    valor: 100,
    valorEstornado: 40,
  });
  // Gravado, e a instância "morreu" antes de processar (nenhum processador rodou).
  await inbox.receber(ev, Buffer.from(JSON.stringify(ev)));
  // Outra, "morta" no MEIO: ficou processando e ninguém terminou.
  const ev2 = evento(assinatura, conta, { evento: 'cobranca_estornada' });
  await inbox.receber(ev2, Buffer.from(JSON.stringify(ev2)));
  await pool.query(
    "UPDATE webhooks_recebidos SET status = 'processando', tentativas = 1, processando_desde = now() - interval '10 minutes' WHERE chave = $1",
    [`evento:${ev2.eventoId}`],
  );
  // "Depois do restart": o processador sobe e acha as duas.
  await inbox.processarPendentes();
  assert.equal((await linha(ev.eventoId)).status, 'processado');
  assert.equal((await linha(ev2.eventoId)).status, 'processado');
  assert.equal(await pendencias(assinatura, 'estorno PARCIAL'), 1);
  assert.equal(await pendencias(assinatura, 'estorno total'), 1);
});

test('7 e 8. falha transitória: nova tentativa com espera crescente; depois processa', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, { evento: 'cobranca_estornada' });
  let falhas = 3;
  inbox.processadores.assinatura = async (payload) => {
    if (falhas-- > 0) throw new Error('ECONNRESET (simulado)');
    return processadoresOriginais.assinatura(payload);
  };
  await inbox.receber(ev, Buffer.from(JSON.stringify(ev)));
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    await inbox.processarPendentes();
    const l = await linha(ev.eventoId);
    assert.equal(l.status, 'tentando_de_novo');
    assert.equal(l.tentativas, tentativa);
    assert.match(l.ultimo_erro, /ECONNRESET/);
    const esperaS = (new Date(l.proxima_tentativa_em) - new Date(l.atualizado_em)) / 1000;
    assert.ok(Math.abs(esperaS - inbox.ESPERAS_S[tentativa - 1]) < 2, `espera da tentativa ${tentativa}: ${esperaS}s`);
    // Antes da espera vencer, nada acontece.
    await inbox.processarPendentes();
    assert.equal((await linha(ev.eventoId)).tentativas, tentativa, 'não tenta antes da hora');
    await vencerEspera(ev.eventoId);
  }
  await inbox.processarPendentes();
  const final = await linha(ev.eventoId);
  assert.equal(final.status, 'processado');
  assert.equal(final.tentativas, 4);
  assert.equal(final.ultimo_erro, null);
  assert.equal(await pendencias(assinatura, 'estorno total'), 1);
});

test('9. depois do limite o evento vai para "morto" e vira pendência no admin', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, { evento: 'troca_revertida', statusFinanceiro: 'estornado' });
  inbox.processadores.assinatura = async () => {
    throw new Error('erro permanente (simulado)');
  };
  await inbox.receber(ev, Buffer.from(JSON.stringify(ev)));
  for (let i = 0; i < inbox.MAX_TENTATIVAS; i++) {
    await inbox.processarPendentes();
    await vencerEspera(ev.eventoId);
  }
  const morto = await linha(ev.eventoId);
  assert.equal(morto.status, 'morto');
  assert.equal(morto.tentativas, inbox.MAX_TENTATIVAS);
  await inbox.processarPendentes();
  assert.equal((await linha(ev.eventoId)).tentativas, inbox.MAX_TENTATIVAS, 'morto não é tentado de novo');
  assert.equal(await pendencias(assinatura, 'webhook não processado depois de 6 tentativas'), 1);
});

test('10. duas instâncias ao mesmo tempo: o evento é processado uma vez só', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, { evento: 'cobranca_estornada' });
  let chamadas = 0;
  inbox.processadores.assinatura = async () => {
    chamadas++;
    await new Promise((r) => setTimeout(r, 200));
  };
  await inbox.receber(ev, Buffer.from(JSON.stringify(ev)));
  // processarUm direto (sem a trava da instância): cada um usa a própria conexão.
  const resultados = await Promise.all([inbox.processarUm(), inbox.processarUm(), inbox.processarUm()]);
  assert.equal(chamadas, 1, 'só uma "instância" pegou o evento');
  assert.equal(resultados.filter(Boolean).length, 1);
  assert.equal((await linha(ev.eventoId)).status, 'processado');
});

test('11. cobranca_confirmada pela inbox, entregue duas vezes: credita um ciclo', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const rodada = crypto.randomUUID().slice(0, 8);
  const ev = evento(assinatura, conta, { evento: 'criada', chargeId: `pay_inbox_${rodada}`, valor: 111.11 });
  assert.equal(await entregar(ev), 200);
  assert.equal(await entregar({ ...ev }), 200);
  // Mesmo evento com OUTRA entrega (novo eventoId, mesma cobrança): a dedupe da cobrança segura.
  const outraEntrega = { ...ev, eventoId: `evt_inbox_${crypto.randomUUID()}`, evento: 'cobranca_confirmada' };
  assert.equal(await entregar(outraEntrega), 200);
  await esperarProcessador();
  const { rows } = await pool.query('SELECT count(*)::int n FROM cobrancas_confirmadas WHERE anunciante_id = $1', [
    conta.id,
  ]);
  assert.equal(rows[0].n, 1, 'um ciclo, não dois nem três');
  await pool.query('DELETE FROM webhooks_processados WHERE id IN ($1, $2, $3)', [
    ev.eventoId,
    outraEntrega.eventoId,
    `pay_inbox_${rodada}|confirmado`,
  ]);
});

test('11b. cobranca_confirmada que falha no meio: nova tentativa credita (a reserva foi liberada)', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const rodada = crypto.randomUUID().slice(0, 8);
  const ev = evento(assinatura, conta, { evento: 'criada', chargeId: `pay_falha_${rodada}`, valor: 50 });
  const restaurar = falharUmaVez(assinaturasRepo, 'buscarPorId');
  try {
    assert.equal(await entregar(ev), 200);
    await esperarProcessador();
    assert.equal((await linha(ev.eventoId)).status, 'tentando_de_novo');
  } finally {
    restaurar();
  }
  await vencerEspera(ev.eventoId);
  await inbox.processarPendentes();
  assert.equal((await linha(ev.eventoId)).status, 'processado');
  const { rows } = await pool.query('SELECT count(*)::int n FROM cobrancas_confirmadas WHERE anunciante_id = $1', [
    conta.id,
  ]);
  assert.equal(rows[0].n, 1);
  await pool.query('DELETE FROM webhooks_processados WHERE id IN ($1, $2)', [
    ev.eventoId,
    `pay_falha_${rodada}|confirmado`,
  ]);
});

test('12. cobranca_falhou entregue duas vezes: uma pendência', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, { evento: 'cobranca_falhou', statusFinanceiro: 'recusado' });
  assert.equal(await entregar(ev), 200);
  assert.equal(await entregar({ ...ev }), 200);
  await esperarProcessador();
  assert.equal(await pendencias(assinatura, 'cobrança falhou'), 1);
});

test('13 e 21. chargeback: falha no meio NÃO perde o evento (antes perdia) e suspende uma vez', async () => {
  // ANTES (o fluxo de até hoje, em memória): falha depois da reserva e o
  // evento some — a reentrega cai na dedupe, e não há linha pra retomar.
  {
    const { conta, assinatura } = await contaComAssinatura();
    const ev = evento(assinatura, conta, { evento: 'cobranca_contestada', statusFinanceiro: 'chargeback' });
    const restaurar = falharUmaVez(anunciantesRepo, 'atualizar');
    try {
      await assert.rejects(sc.processarWebhookAssinatura(ev), /banco caiu/);
    } finally {
      restaurar();
    }
    assert.equal((await anunciantesRepo.buscarPorId(conta.id)).suspenso, false, 'conta segue ativa');
    assert.equal(await linha(ev.eventoId), undefined, 'antes: nenhuma linha para retomar — o evento some');
    await pool.query('DELETE FROM webhooks_processados WHERE id = $1', [ev.eventoId]);
  }
  // DEPOIS: 200 só com a linha gravada; a falha deixa a linha esperando e a
  // nova tentativa suspende — uma vez.
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, { evento: 'cobranca_contestada', statusFinanceiro: 'chargeback' });
  const restaurar = falharUmaVez(anunciantesRepo, 'atualizar');
  try {
    assert.equal(await entregar(ev), 200);
    await esperarProcessador();
  } finally {
    restaurar();
  }
  const aposFalha = await linha(ev.eventoId);
  assert.equal(aposFalha.status, 'tentando_de_novo', 'a linha continua na inbox');
  assert.equal((await anunciantesRepo.buscarPorId(conta.id)).suspenso, false);
  const { rows: reserva } = await pool.query('SELECT 1 FROM webhooks_processados WHERE id = $1', [ev.eventoId]);
  assert.equal(reserva.length, 0, 'a reserva de dedupe foi liberada pra nova tentativa');
  // "Reinício": outra rodada do processador, depois da espera.
  await vencerEspera(ev.eventoId);
  await inbox.processarPendentes();
  assert.equal((await linha(ev.eventoId)).status, 'processado');
  assert.equal((await anunciantesRepo.buscarPorId(conta.id)).suspenso, true);
  assert.equal(await suspensoesRegistradas(conta), 1, 'suspensa exatamente uma vez');
  assert.equal(await pendencias(assinatura, 'chargeback'), 1);
  // Reprocessar o mesmo evento (entrega atrasada) não muda nada.
  assert.equal(await entregar({ ...ev }), 200);
  await esperarProcessador();
  assert.equal(await suspensoesRegistradas(conta), 1);
});

test('14. cobranca_estornada: falha no meio e a nova tentativa registra uma vez', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, {
    evento: 'cobranca_estornada',
    estornoParcial: true,
    valor: 80,
    valorEstornado: 20,
  });
  const restaurar = falharUmaVez(assinaturasRepo, 'buscarPorId');
  try {
    assert.equal(await entregar(ev), 200);
    await esperarProcessador();
  } finally {
    restaurar();
  }
  assert.equal((await linha(ev.eventoId)).status, 'tentando_de_novo');
  assert.equal(await pendencias(assinatura, 'estorno PARCIAL'), 0);
  await vencerEspera(ev.eventoId);
  await inbox.processarPendentes();
  assert.equal((await linha(ev.eventoId)).status, 'processado');
  assert.equal(await pendencias(assinatura, 'estorno PARCIAL de R$ 20 sobre R$ 80'), 1);
});

test('15. troca_revertida por chargeback: falha no meio e a nova tentativa suspende uma vez', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const ev = evento(assinatura, conta, {
    evento: 'troca_revertida',
    statusFinanceiro: 'chargeback',
    planoAnterior: 'sub_anterior',
    valorEstornado: 30,
  });
  const restaurar = falharUmaVez(anunciantesRepo, 'atualizar');
  try {
    assert.equal(await entregar(ev), 200);
    await esperarProcessador();
  } finally {
    restaurar();
  }
  assert.equal((await linha(ev.eventoId)).status, 'tentando_de_novo');
  await vencerEspera(ev.eventoId);
  await inbox.processarPendentes();
  assert.equal((await linha(ev.eventoId)).status, 'processado');
  assert.equal((await anunciantesRepo.buscarPorId(conta.id)).suspenso, true);
  assert.equal(await suspensoesRegistradas(conta), 1);
  assert.equal(await pendencias(assinatura, 'acerto da troca de plano revertido'), 1);
});

test('corpo sem eventoId (contrato v1): chave pelo hash do corpo; reentrega idêntica = uma linha', async () => {
  const corpo = { tipo: 'pedido', pedidoId: `ped_${crypto.randomUUID()}`, status: 'em_analise', chargeId: 'x' };
  inbox.processadores.pedido = async () => {};
  assert.equal(await entregar(corpo), 200);
  assert.equal(await entregar(corpo), 200);
  const chave = inbox.chaveDoEvento(corpo, Buffer.from(JSON.stringify(corpo)));
  assert.match(chave, /^corpo:[0-9a-f]{64}$/);
  const { rows } = await pool.query(
    'SELECT tipo, count(*)::int n FROM webhooks_recebidos WHERE chave = $1 GROUP BY tipo',
    [chave],
  );
  assert.deepEqual(rows, [{ tipo: 'pedido', n: 1 }]);
  await esperarProcessador();
});

test('erro gravado na inbox é sanitizado (sem e-mail nem documento)', () => {
  assert.equal(
    inbox.sanitizar(new Error('conta fulano@exemplo.com cpf 52998224725 falhou\nstack...')),
    'conta <email> cpf <documento> falhou',
  );
});

test('expurgo: processado > 30 dias e morto > 90 dias saem; o resto fica', async () => {
  const chaves = ['velho-p', 'novo-p', 'velho-m', 'novo-m'].map((s) => `teste-expurgo:${s}:${crypto.randomUUID()}`);
  await pool.query(
    `INSERT INTO webhooks_recebidos (chave, tipo, payload, status, processado_em, atualizado_em) VALUES
      ($1,'assinatura','{}','processado', now() - interval '31 days', now() - interval '31 days'),
      ($2,'assinatura','{}','processado', now() - interval '29 days', now() - interval '29 days'),
      ($3,'assinatura','{}','morto', NULL, now() - interval '91 days'),
      ($4,'assinatura','{}','morto', NULL, now() - interval '89 days')`,
    chaves,
  );
  await inbox.expurgar();
  const { rows } = await pool.query('SELECT chave FROM webhooks_recebidos WHERE chave = ANY($1) ORDER BY chave', [
    chaves,
  ]);
  assert.deepEqual(rows.map((r) => r.chave.split(':')[1]).sort(), ['novo-m', 'novo-p']);
});

test('evento lento não segura o próximo (sem fila atrás de um só)', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const lento = evento(assinatura, conta, { evento: 'cobranca_estornada' });
  const rapido = evento(assinatura, conta, {
    evento: 'cobranca_estornada',
    estornoParcial: true,
    valor: 9,
    valorEstornado: 1,
  });
  inbox.processadores.assinatura = async (payload) => {
    if (payload.eventoId === lento.eventoId) await new Promise((r) => setTimeout(r, 1500));
    return processadoresOriginais.assinatura(payload);
  };
  assert.equal(await entregar(lento), 200);
  assert.equal(await entregar(rapido), 200);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await linha(rapido.eventoId)).status, 'processado', 'o rápido não esperou o lento');
  assert.equal((await linha(lento.eventoId)).status, 'processando');
  await esperarProcessador();
  assert.equal((await linha(lento.eventoId)).status, 'processado');
});
