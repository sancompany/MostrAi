require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const pool = require('./pool');

// Runner de migração mínimo: aplica os .sql de migrations/ em ordem, uma vez
// cada, registrando o que já rodou em schema_migrations. Sem framework —
// é o que um `for` com SQL cru já resolve.
// Trava de aplicação no próprio Postgres. O runner passou a rodar no arranque
// do contêiner (ver Dockerfile), e se um dia houver mais de uma instância as
// duas sobem juntas: sem trava, as duas leem "não aplicada", as duas tentam
// aplicar, e a segunda estoura no meio de um CREATE TABLE. `pg_advisory_lock`
// é do servidor, não do processo — a segunda instância espera e depois não
// encontra nada pra fazer. O número é arbitrário e só precisa ser estável.
const TRAVA = 872026;

async function migrate() {
  const trava = await pool.connect();
  await trava.query('SELECT pg_advisory_lock($1)', [TRAVA]);
  try {
    await aplicar();
  } finally {
    await trava.query('SELECT pg_advisory_unlock($1)', [TRAVA]);
    trava.release();
  }
  await pool.end();
}

async function aplicar() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const arquivos = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const arquivo of arquivos) {
    const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [arquivo]);
    if (rows.length) continue;

    const sql = fs.readFileSync(path.join(dir, arquivo), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [arquivo]);
      await client.query('COMMIT');
      console.log(`aplicada: ${arquivo}`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
