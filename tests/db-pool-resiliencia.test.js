const test = require('node:test');
const assert = require('node:assert');
const { Client } = require('pg');
const pool = require('../src/db/pool');
const config = require('../src/db/connection-config');

// AUD-019 (auditoria V1, ciclo 1): o Pool não tinha ouvinte de 'error'. Quando
// o Postgres (ou o pooler do Supabase) derruba uma conexão OCIOSA do pool —
// restart, failover, rede —, o pg-pool emite 'error' no Pool; sem ouvinte, o
// Node trata como exceção não capturada e o processo morre (as 2 instâncias
// juntas, que sempre têm cliente ocioso). Antes da correção, este arquivo
// inteiro morria com "Unhandled 'error' event" no pg_terminate_backend.
test('conexão ociosa derrubada pelo Postgres não derruba o processo, e o pool volta a responder', async () => {
  const {
    rows: [{ pid }],
  } = await pool.query('SELECT pg_backend_pid() AS pid');
  assert.equal(pool.idleCount, 1, 'a conexão da consulta voltou ociosa para o pool');

  // Outra conexão, fora do pool, encerra o backend da ociosa — o que um
  // restart ou failover do banco faz.
  const outro = new Client(config);
  await outro.connect();
  try {
    const { rows } = await outro.query('SELECT pg_terminate_backend($1) AS ok', [pid]);
    assert.equal(rows[0].ok, true);
  } finally {
    await outro.end();
  }
  await new Promise((r) => setTimeout(r, 500));

  assert.ok(pool.listenerCount('error') >= 1, 'o pool tem ouvinte de erro');
  const {
    rows: [novo],
  } = await pool.query('SELECT pg_backend_pid() AS pid, 1 AS um');
  assert.equal(novo.um, 1);
  assert.notEqual(novo.pid, pid, 'consulta seguinte em conexão nova');
});

// O outro lado do AUD-019 (achado da revisão): o pg-pool tira o ouvinte de
// 'error' do cliente quando o EMPRESTA (pool.connect()). Se a conexão cai
// nesse intervalo — heartbeat (src/player/sinal.js) e jobs de 30 s vivem em
// BEGIN … COMMIT —, o pg emite 'error' num Client sem ouvinte: exceção não
// capturada e, no servidor, process.exit(1). Agora o cliente tem ouvinte
// próprio: a consulta seguinte dele falha, o release() o descarta e o pool
// segue respondendo com outra conexão.
test('conexão EMPRESTADA derrubada no meio da transação não derruba o processo; o release a descarta', async () => {
  const cliente = await pool.connect();
  let devolvido = false;
  try {
    await cliente.query('BEGIN');
    const {
      rows: [{ pid }],
    } = await cliente.query('SELECT pg_backend_pid() AS pid');

    const outro = new Client(config);
    await outro.connect();
    try {
      const { rows } = await outro.query('SELECT pg_terminate_backend($1) AS ok', [pid]);
      assert.equal(rows[0].ok, true);
    } finally {
      await outro.end();
    }
    await new Promise((r) => setTimeout(r, 500));

    await assert.rejects(cliente.query('SELECT 1'), /not queryable|terminat/i, 'o cliente morto não consulta mais');
    // Sem ouvinte, o 'error' acima já teria virado exceção não capturada (o
    // node:test a pega e reprova o arquivo; no servidor, process.exit(1)).
    assert.ok(cliente.listenerCount('error') >= 1, 'o cliente emprestado tem ouvinte de erro');
    const antes = pool.totalCount;
    cliente.release();
    devolvido = true;
    assert.equal(pool.totalCount, antes - 1, 'o release tira o cliente morto do pool');

    const {
      rows: [novo],
    } = await pool.query('SELECT pg_backend_pid() AS pid, 1 AS um');
    assert.equal(novo.um, 1);
    assert.notEqual(novo.pid, pid, 'consulta seguinte em conexão nova');
  } finally {
    if (!devolvido) cliente.release();
  }
});

test.after(() => pool.end());
