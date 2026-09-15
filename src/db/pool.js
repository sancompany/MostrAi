const { Pool, types } = require('pg');

// Coluna `date` volta como TEXTO, não como Date.
//
// O driver converte `date` num objeto Date à meia-noite do fuso do processo.
// Em produção o processo roda em UTC, então `JSON.stringify` manda
// "2026-09-01T00:00:00.000Z" pro navegador, que exibe em America/Sao_Paulo e
// mostra 31/08. A competência 09/2026 do extrato do dono do ponto aparecia
// como 08/2026 — mês errado num papel de dinheiro — e a data de expiração do
// plano aparecia um dia mais cedo.
//
// `date` não tem hora nem fuso: é dia de calendário. Devolver a string do
// banco ('2026-09-01') preserva exatamente isso, e é o que os formatadores
// dos dois lados (src/br/formato.js e window.dataBR) esperam receber.
// 1082 é o OID de `date` no Postgres.
types.setTypeParser(1082, (valor) => valor);

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
