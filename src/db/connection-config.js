// Config de conexão do Postgres — compartilhada entre o Pool principal
// (src/db/pool.js) e qualquer client dedicado que precise da MESMA conexão
// fora do pool (ex.: LISTEN/NOTIFY, que exige uma conexão só sua, nunca
// emprestada do pool — ver src/lib/sse.js). Extraído daqui pra não divergir
// entre os dois: SSL local vs. gerenciado é a mesma decisão nos dois lugares.
const ehLocal = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || '');
module.exports = {
  connectionString: process.env.DATABASE_URL,
  ssl: ehLocal ? false : { rejectUnauthorized: false },
};
