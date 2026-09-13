const { Pool } = require('pg');

// Conexão com o Postgres (Supabase em produção, qualquer Postgres local em dev).
// Sem ORM — SQL cru nos repositories, ver SPEC.md seção 4.
// Supabase (e a maioria dos Postgres gerenciados) exige conexão SSL — sem isso
// a conexão cai no meio do handshake (ECONNRESET). Postgres local (dev na
// máquina) normalmente não fala SSL, então só liga quando não for localhost.
const ehLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
module.exports = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: ehLocal ? false : { rejectUnauthorized: false },
});
