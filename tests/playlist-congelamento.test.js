const test = require('node:test');
const assert = require('node:assert');
const pool = require('../src/db/pool');
const congelamentoRepo = require('../src/playlist/congelamento-repository');

function clienteEmMemoria(estado, chamadas) {
  return {
    async query(sql, parametros = []) {
      chamadas.push(sql.replace(/\s+/g, ' ').trim());
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT base, extras')) return { rows: estado.linha ? [structuredClone(estado.linha)] : [] };
      if (sql.includes('INSERT INTO playlist_hora_congelada')) {
        estado.linha = { base: JSON.parse(parametros[2]), extras: [] };
        return { rows: [structuredClone(estado.linha)] };
      }
      if (sql.includes('UPDATE playlist_hora_congelada')) {
        estado.linha.extras.push(...JSON.parse(parametros[2]));
        return { rows: [structuredClone(estado.linha)] };
      }
      throw new Error(`SQL não simulado: ${sql}`);
    },
    release() {
      chamadas.push('RELEASE');
    },
  };
}

test('primeira requisição congela a base dentro do lock e não cria extras', async (t) => {
  const originalConnect = pool.connect;
  const estado = { linha: null };
  const chamadas = [];
  pool.connect = async () => clienteEmMemoria(estado, chamadas);
  t.after(() => {
    pool.connect = originalConnect;
  });

  const base = [{ id: 1, frequenciaBase: 3 }];
  const resultado = await congelamentoRepo.resolver(7, new Date('2026-09-20T18:00:00Z'), base, () => []);

  // `criadaAgora`: só a primeira geração da hora drena o banco de horas
  // (consolidação final, 24/09/2026).
  assert.deepStrictEqual(resultado, { base, extras: [], criadaAgora: true });
  assert.ok(chamadas.some((sql) => sql.includes('pg_advisory_xact_lock')));
  assert.ok(chamadas.some((sql) => sql.includes('INSERT INTO playlist_hora_congelada')));
  assert.ok(chamadas.indexOf('COMMIT') < chamadas.indexOf('RELEASE'));
});

test('requisição seguinte usa a base vencedora e anexa uma única leva calculada', async (t) => {
  const originalConnect = pool.connect;
  const estado = { linha: { base: [{ id: 1, frequenciaBase: 3 }], extras: [2, 2] } };
  const chamadas = [];
  pool.connect = async () => clienteEmMemoria(estado, chamadas);
  t.after(() => {
    pool.connect = originalConnect;
  });

  let estadoVisto;
  const resultado = await congelamentoRepo.resolver(
    7,
    new Date('2026-09-20T18:00:00Z'),
    [{ id: 99, frequenciaBase: 12 }],
    (base, extras) => {
      estadoVisto = { base, extras };
      return [3, 3, 3];
    },
  );

  assert.deepStrictEqual(estadoVisto, { base: [{ id: 1, frequenciaBase: 3 }], extras: [2, 2] });
  assert.deepStrictEqual(resultado.extras, [2, 2, 3, 3, 3]);
  assert.strictEqual(chamadas.filter((sql) => sql.includes('UPDATE playlist_hora_congelada')).length, 1);
});

test('falha durante a resolução desfaz a transação e libera o cliente', async (t) => {
  const originalConnect = pool.connect;
  const estado = { linha: { base: [{ id: 1 }], extras: [] } };
  const chamadas = [];
  pool.connect = async () => clienteEmMemoria(estado, chamadas);
  t.after(() => {
    pool.connect = originalConnect;
  });

  await assert.rejects(
    congelamentoRepo.resolver(7, new Date('2026-09-20T18:00:00Z'), [], () => {
      throw new Error('falha simulada');
    }),
    /falha simulada/,
  );
  assert.ok(chamadas.includes('ROLLBACK'));
  assert.strictEqual(chamadas.at(-1), 'RELEASE');
});
