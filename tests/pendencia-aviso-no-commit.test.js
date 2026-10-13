// Revisão Codex do PR #136: a pendência gravada DENTRO de uma transação
// (AUD-005/AUD-006 — chave de dedupe, documento do pagador) avisava o admin
// pelo pool antes do COMMIT; o admin recarregava a fila (800 ms de debounce)
// ainda sem a linha, e ninguém avisava de novo. Agora o aviso vai pelo
// client da transação: o Postgres só entrega o NOTIFY no COMMIT e o descarta
// no ROLLBACK (src/lib/sse.js#emitirParaAdminNoCommit).
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const pool = require('../src/db/pool');
const config = require('../src/db/connection-config');
const sse = require('../src/lib/sse');
const sc = require('../src/financeiro/san-checkout');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function esperarAte(cond, ms = 3000) {
  const fim = Date.now() + ms;
  while (!cond() && Date.now() < fim) await esperar(25);
  return cond();
}

let ouvinte;
const recebidos = [];
test.before(async () => {
  // Ouvinte próprio, como a outra instância em produção. O canal é
  // compartilhado com os outros arquivos de teste (rodam em paralelo), por
  // isso cada caso filtra pelo nome de evento que só ele emite.
  ouvinte = new Client(config);
  await ouvinte.connect();
  ouvinte.on('notification', (m) => recebidos.push(JSON.parse(m.payload)));
  await ouvinte.query('LISTEN sse_conta');
});
test.after(async () => {
  await ouvinte.end();
  await pool.end();
});

test('emitirParaAdminNoCommit: nada antes do COMMIT, um aviso depois dele, nenhum depois de ROLLBACK', async () => {
  const evento = `teste.${randomUUID()}`;
  const meus = () => recebidos.filter((r) => r.admin && r.evento === evento);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await sse.emitirParaAdminNoCommit(cliente, evento, { x: 1 });
    await esperar(300);
    assert.equal(meus().length, 0, 'dentro da transação o aviso ainda não saiu');
    await cliente.query('COMMIT');
    assert.ok(await esperarAte(() => meus().length === 1), 'o COMMIT entrega o aviso');
    assert.deepEqual(meus()[0].dado, { x: 1 });

    await cliente.query('BEGIN');
    await sse.emitirParaAdminNoCommit(cliente, evento, { x: 2 });
    await cliente.query('ROLLBACK');
    await esperar(300);
    assert.equal(meus().length, 1, 'o ROLLBACK descarta o aviso');
  } finally {
    cliente.release();
  }
});

test('registrarPendencia: com o client de uma transação avisa pelo caminho do COMMIT; pelo pool, na hora', async () => {
  const original = { agora: sse.emitirParaAdmin, noCommit: sse.emitirParaAdminNoCommit };
  const chamadas = [];
  sse.emitirParaAdmin = (evento, dado) => chamadas.push(['agora', evento, dado]);
  sse.emitirParaAdminNoCommit = async (db, evento, dado) => chamadas.push(['no-commit', db, evento, dado]);
  const marca = `teste-aviso-${randomUUID()}`;
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await sc.registrarPendencia({ evento: marca }, 'teste: aviso só no commit', cliente);
    assert.deepEqual(
      chamadas,
      [['no-commit', cliente, 'payment.updated', {}]],
      'pela transação: só o caminho do COMMIT',
    );
    await cliente.query('ROLLBACK');

    chamadas.length = 0;
    await sc.registrarPendencia({ evento: marca }, 'teste: aviso na hora');
    assert.deepEqual(chamadas, [['agora', 'payment.updated', {}]], 'pelo pool (autocommit): na hora, como sempre');
  } finally {
    cliente.release();
    sse.emitirParaAdmin = original.agora;
    sse.emitirParaAdminNoCommit = original.noCommit;
    await pool.query("DELETE FROM eventos_assinatura_pendentes WHERE payload->>'evento' = $1", [marca]);
  }
});
