const crypto = require('node:crypto');
const pool = require('../db/pool');

// Inbox durável do webhook do San Checkout (migration 096).
//
//   rota: HMAC ok → receber() grava a linha → SÓ ENTÃO 200
//   processador: pega uma linha (FOR UPDATE SKIP LOCKED) → roda a lógica de
//   sempre (processarWebhookAssinatura / processarWebhookPedido) → marca.
//
// A inbox não muda NENHUMA regra financeira — só garante que o evento
// autenticado não se perde entre o 200 e o efeito. A conciliação diária
// continua como segunda camada (ela repara ciclo pago, falha e cancelamento
// mesmo que o webhook nunca chegue).
//
// Estados: recebido → processando → processado
//                          ↘ tentando_de_novo (espera crescente) → … → morto
// "processando" tem prazo (LEASE_MIN): a instância que pegou pode morrer no
// meio (deploy, OOM) — passado o prazo, outra retoma. A lógica de negócio é
// idempotente pra isso (dedupe `webhooks_processados`, liberada em erro).

const MAX_TENTATIVAS = 6;
// Espera antes da tentativa 2, 3, 4, 5 e 6: 30 s, 2 min, 10 min, 30 min, 2 h.
// Cobre queda curta de banco e deploy; mais que isso é problema pra pessoa ver.
const ESPERAS_S = [30, 120, 600, 1800, 7200];
const LEASE_MIN = 5;
const INTERVALO_MS = 30 * 1000;
const RETENCAO_DIAS = { processado: 30, morto: 90 };

// Processadores por tipo — objeto (e não chamada direta) pra que o teste
// consiga simular falha sem mexer na lógica financeira.
const processadores = {
  assinatura: (payload) => require('./san-checkout').processarWebhookAssinatura(payload),
  pedido: (payload) => require('./san-checkout').processarWebhookPedido(payload),
};

// Identidade do EVENTO (não da entrega): `eventoId` do contrato v2; sem ele,
// o hash do corpo cru — a reentrega do mesmo evento traz o mesmo corpo.
function chaveDoEvento(payload, corpoCru) {
  if (payload.eventoId) return `evento:${String(payload.eventoId).slice(0, 200)}`;
  const bytes = Buffer.isBuffer(corpoCru) ? corpoCru : Buffer.from(JSON.stringify(payload), 'utf8');
  return `corpo:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

// Erro pra log/banco: primeira linha, curta, sem e-mail nem número de
// documento (a mensagem pode citar dado do payload).
function sanitizar(err) {
  return String(err?.message || err || 'erro desconhecido')
    .split('\n')[0]
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '<email>')
    .replace(/\b\d{11,14}\b/g, '<documento>')
    .slice(0, 300);
}

const curta = (chave) => (chave.length > 24 ? `${chave.slice(0, 24)}…` : chave);

// Grava o evento autenticado. Devolve { chave, novo }; `novo: false` é a
// reentrega de um evento que já está aqui (a rota responde 200 do mesmo
// jeito). Erro de banco SOBE — a rota responde 5xx e o Checkout tenta de novo.
async function receber(payload, corpoCru) {
  const tipo = payload.tipo === 'assinatura' ? 'assinatura' : 'pedido';
  const evento = String(payload.evento || payload.status || '').slice(0, 60) || null;
  const chave = chaveDoEvento(payload, corpoCru);
  const { rows } = await pool.query(
    `INSERT INTO webhooks_recebidos (chave, tipo, evento, payload) VALUES ($1, $2, $3, $4)
     ON CONFLICT (chave) DO NOTHING RETURNING id`,
    [chave, tipo, evento, payload],
  );
  return { chave, novo: !!rows[0] };
}

// Reserva UMA linha elegível e marca "processando" numa transação curta. O
// SKIP LOCKED faz a outra instância pular a linha que esta já travou, e o
// estado + prazo impedem que ela a pegue depois do COMMIT.
async function pegarProximo() {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `SELECT id FROM webhooks_recebidos
        WHERE (status IN ('recebido', 'tentando_de_novo') AND proxima_tentativa_em <= now())
           OR (status = 'processando' AND processando_desde < now() - make_interval(mins => $1))
        ORDER BY proxima_tentativa_em, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [LEASE_MIN],
    );
    if (!rows[0]) {
      await cliente.query('COMMIT');
      return null;
    }
    const { rows: pego } = await cliente.query(
      `UPDATE webhooks_recebidos
          SET status = 'processando', processando_desde = now(), tentativas = tentativas + 1, atualizado_em = now()
        WHERE id = $1
        RETURNING id, chave, tipo, evento, payload, tentativas`,
      [rows[0].id],
    );
    await cliente.query('COMMIT');
    return pego[0];
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// Processa um evento. Devolve false quando não havia nada a fazer.
async function processarUm() {
  const ev = await pegarProximo();
  if (!ev) return false;
  // `tentativas` na condição: se o prazo venceu e outra instância retomou,
  // o resultado desta (atrasada) não sobrescreve o dela.
  try {
    await processadores[ev.tipo](ev.payload);
    await pool.query(
      `UPDATE webhooks_recebidos
          SET status = 'processado', processado_em = now(), processando_desde = NULL, ultimo_erro = NULL, atualizado_em = now()
        WHERE id = $1 AND tentativas = $2`,
      [ev.id, ev.tentativas],
    );
    console.log(`webhook ${ev.evento || ev.tipo} ${curta(ev.chave)} processado (tentativa ${ev.tentativas})`);
  } catch (err) {
    const erro = sanitizar(err);
    if (ev.tentativas >= MAX_TENTATIVAS) {
      await pool.query(
        `UPDATE webhooks_recebidos
            SET status = 'morto', processando_desde = NULL, ultimo_erro = $3, atualizado_em = now()
          WHERE id = $1 AND tentativas = $2`,
        [ev.id, ev.tentativas, erro],
      );
      console.error(
        `webhook ${ev.evento || ev.tipo} ${curta(ev.chave)} MORTO após ${ev.tentativas} tentativas: ${erro}`,
      );
      // Fila que o operador já olha (admin → eventos pendentes): evento
      // financeiro que não entrou não pode ficar só na tabela técnica.
      await require('./san-checkout')
        .registrarPendencia(
          ev.payload,
          `webhook não processado depois de ${ev.tentativas} tentativas (inbox ${ev.id}): ${erro}`,
        )
        .catch((e) => console.error('falha ao registrar pendência do webhook morto', sanitizar(e)));
    } else {
      const espera = ESPERAS_S[Math.min(ev.tentativas, ESPERAS_S.length) - 1];
      await pool.query(
        `UPDATE webhooks_recebidos
            SET status = 'tentando_de_novo', processando_desde = NULL, ultimo_erro = $3,
                proxima_tentativa_em = now() + make_interval(secs => $4), atualizado_em = now()
          WHERE id = $1 AND tentativas = $2`,
        [ev.id, ev.tentativas, erro, espera],
      );
      console.error(
        `webhook ${ev.evento || ev.tipo} ${curta(ev.chave)} falhou (tentativa ${ev.tentativas}/${MAX_TENTATIVAS}, de novo em ${espera}s): ${erro}`,
      );
    }
  }
  return true;
}

// Esvazia o que estiver pronto, com até RODADAS_SIMULTANEAS rodadas por
// instância. Não é uma rodada só: um evento lento (o formato v1 consulta o
// Checkout, com tentativas) não pode segurar os outros atrás dele — antes da
// inbox cada evento corria sozinho, e a latência tem que continuar a mesma. O
// SKIP LOCKED garante que duas rodadas nunca pegam o mesmo evento.
const RODADAS_SIMULTANEAS = 4;
const rodadas = new Set();
function processarPendentes({ limite = 50 } = {}) {
  if (rodadas.size >= RODADAS_SIMULTANEAS) return Promise.resolve(0);
  const rodada = (async () => {
    let feitos = 0;
    while (feitos < limite && (await processarUm())) feitos++;
    return feitos;
  })().finally(() => rodadas.delete(rodada));
  rodadas.add(rodada);
  return rodada;
}

// Espera as rodadas em andamento nesta instância (usado nos testes).
async function aguardarRodadas() {
  while (rodadas.size) await Promise.allSettled([...rodadas]);
}

async function expurgar() {
  const { rowCount } = await pool.query(
    `DELETE FROM webhooks_recebidos
      WHERE (status = 'processado' AND processado_em < now() - make_interval(days => $1))
         OR (status = 'morto' AND atualizado_em < now() - make_interval(days => $2))`,
    [RETENCAO_DIAS.processado, RETENCAO_DIAS.morto],
  );
  return rowCount;
}

// Sobe junto com o servidor: roda já (retoma o que ficou de antes de um
// restart) e depois a cada 30 s; expurgo uma vez por hora.
let timers = [];
function iniciar() {
  const rodar = () => processarPendentes().catch((err) => console.error('inbox do webhook:', sanitizar(err)));
  rodar();
  timers = [
    setInterval(rodar, INTERVALO_MS),
    setInterval(() => expurgar().catch((err) => console.error('expurgo da inbox:', sanitizar(err))), 60 * 60 * 1000),
  ];
  for (const t of timers) t.unref();
}

module.exports = {
  MAX_TENTATIVAS,
  ESPERAS_S,
  LEASE_MIN,
  RETENCAO_DIAS,
  processadores,
  chaveDoEvento,
  sanitizar,
  receber,
  pegarProximo,
  processarUm,
  processarPendentes,
  aguardarRodadas,
  expurgar,
  iniciar,
};
