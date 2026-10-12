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

test.after(() => pool.end());
