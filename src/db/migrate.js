require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

// Runner de migração mínimo: aplica os .sql de migrations/ em ordem, uma vez
// cada, registrando o que já rodou em schema_migrations. Sem framework —
// é o que um `for` com SQL cru já resolve.
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const dir = path.join(__dirname, 'migrations');
  const arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  for (const arquivo of arquivos) {
    const { rows } = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE filename = $1',
      [arquivo]
    );
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

  await pool.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
