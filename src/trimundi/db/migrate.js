const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { obterPool, encerrar } = require('./conexao');

// Aplicador de migrations da Trimundi: os .sql de ./migrations em ordem,
// uma vez cada, registrados em trimundi.schema_migrations. Tudo dentro do
// esquema `trimundi` (o pool já entra nele); o `public` da Mostraí não é
// tocado. Em produção, só com pedido explícito (docs/trimundi/CONSTRAINTS.md).
const TRAVA = 872027;

async function migrar({ silencioso = false } = {}) {
  if (!/^[a-z_]+$/.test(config.ESQUEMA) || config.ESQUEMA === 'public') throw new Error('esquema da Trimundi inválido');
  const pool = obterPool();
  const trava = await pool.connect();
  try {
    await trava.query('SELECT pg_advisory_lock($1)', [TRAVA]);
    await trava.query(`CREATE SCHEMA IF NOT EXISTS ${config.ESQUEMA}`);
    // A API pública do Supabase (anon/authenticated) não enxerga o esquema.
    await trava.query(`DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON SCHEMA ${config.ESQUEMA} FROM anon; END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON SCHEMA ${config.ESQUEMA} FROM authenticated; END IF;
    END $$`);
    // Tudo pela MESMA conexão da trava: o pool da Trimundi pode ter uma só.
    await trava.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const dir = path.join(__dirname, 'migrations');
    const arquivos = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const arquivo of arquivos) {
      const { rows } = await trava.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [arquivo]);
      if (rows.length) continue;
      const sql = fs.readFileSync(path.join(dir, arquivo), 'utf8');
      const cliente = trava;
      try {
        await cliente.query('BEGIN');
        // Segunda conferência, já com o esquema criado: tudo cai nele.
        const { rows: esq } = await cliente.query('SELECT current_schema() AS s');
        if (esq[0].s !== config.ESQUEMA) throw new Error(`fora do esquema ${config.ESQUEMA} (${esq[0].s})`);
        await cliente.query(sql);
        await cliente.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [arquivo]);
        await cliente.query('COMMIT');
        if (!silencioso) console.log(`trimundi: aplicada ${arquivo}`);
      } catch (err) {
        await cliente.query('ROLLBACK').catch(() => {});
        throw new Error(`trimundi: migration ${arquivo} falhou: ${err.message}`);
      }
    }
  } finally {
    await trava.query('SELECT pg_advisory_unlock($1)', [TRAVA]).catch(() => {});
    trava.release();
  }
}

if (require.main === module) {
  require('dotenv').config();
  // Desligada: nada a migrar (o arranque do contêiner chama sempre).
  if (!config.configurada()) {
    console.log('trimundi: desligada — sem migration');
    process.exit(0);
  }
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
