const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { obterPool, encerrar } = require('./conexao');

// Aplicador de migrations da Trimundi: os .sql de ./migrations em ordem,
// uma vez cada, registrados em schema_migrations DO BANCO DA TRIMUNDI.
// Duas travas antes de qualquer SQL: nunca no banco da Mostraí e nunca em
// produção sem pedido explícito (docs/trimundi/CONSTRAINTS.md).
const TRAVA = 872027;

async function migrar({ silencioso = false } = {}) {
  if (config.mesmoBancoDaMostrai()) {
    throw new Error('TRIMUNDI_DATABASE_URL aponta para o banco da Mostraí — a Trimundi tem banco próprio');
  }
  const pool = obterPool();
  const trava = await pool.connect();
  try {
    await trava.query('SELECT pg_advisory_lock($1)', [TRAVA]);
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = path.join(__dirname, 'migrations');
    const arquivos = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const arquivo of arquivos) {
      const { rows } = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [arquivo]);
      if (rows.length) continue;
      const sql = fs.readFileSync(path.join(dir, arquivo), 'utf8');
      const cliente = await pool.connect();
      try {
        await cliente.query('BEGIN');
        await cliente.query(sql);
        await cliente.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [arquivo]);
        await cliente.query('COMMIT');
        if (!silencioso) console.log(`trimundi: aplicada ${arquivo}`);
      } catch (err) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw new Error(`trimundi: migration ${arquivo} falhou: ${err.message}`);
      } finally {
        cliente.release();
      }
    }
  } finally {
    await trava.query('SELECT pg_advisory_unlock($1)', [TRAVA]).catch(() => {});
    trava.release();
  }
}

if (require.main === module) {
  require('dotenv').config();
  if (config.producao() && !process.argv.includes('--producao-autorizada')) {
    console.error('trimundi: migration em produção exige autorização do dono (--producao-autorizada)');
    process.exit(2);
  }
  migrar()
    .then(() => encerrar())
    .catch(async (err) => {
      console.error(err.message);
      await encerrar().catch(() => {});
      process.exit(1);
    });
}

module.exports = { migrar };
