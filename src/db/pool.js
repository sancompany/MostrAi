const { Pool, types } = require('pg');
const config = require('./connection-config');

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
// `config` (connectionString + ssl) mora em connection-config.js, dividido
// com o client dedicado do LISTEN/NOTIFY (src/lib/sse.js) — mesma conexão,
// duas formas de usar.
//
// `max` explícito (achado real em produção, 23/09/2026): o padrão do driver
// é 10 por Pool, sem teto nenhum contra o pooler. O Supavisor de sessão do
// Supabase deste projeto está configurado pra 15 conexões — com
// `instances: 2` no Northflank (item 4, concluído), dois Pools default já
// bastam pra estourar isso sozinhos, e foi exatamente o que aconteceu:
// `error: (EMAXCONNSESSION) max clients reached in session mode - max
// clients are limited to pool_size: 15`, num Promise.all de
// src/admin/routes.js, antes desta correção. 5 por instância (2×5=10) deixa
// margem pro client dedicado do LISTEN (src/lib/sse.js, 1 por instância,
// nunca devolvido) e pra conexão avulsa de scripts/conciliar.js (job
// separado, roda fora das 2 instâncias do serviço).
//
// `connectionTimeoutMillis` (AUD-001, auditoria V1): sem ele, quem pede
// conexão a um pool cheio espera PARA SEMPRE — foi assim que cinco resgates
// de crédito simultâneos penduraram a instância inteira (cada transação
// pedia uma 2ª conexão com a linha travada). A causa foi corrigida na rota;
// isto garante que um ciclo igual vire erro em 5 s, não uma instância parada
// que o /health (que não toca o banco) continua chamando de saudável.
//
// `keepAlive` (AUD-019): o SO sonda a conexão TCP parada, e uma que morreu em
// silêncio (rede, NAT) acaba virando o mesmo 'error' tratado abaixo.
const pool = new Pool({ ...config, max: 5, connectionTimeoutMillis: 5000, keepAlive: true });

// Ouvinte de 'error' (AUD-019, auditoria V1): quando o Postgres ou o pooler
// derruba uma conexão OCIOSA do pool (restart, failover, rede), o pg-pool já a
// descartou e emite 'error' no Pool. Sem ouvinte, o Node trata como exceção
// não capturada e o processo morre — nas 2 instâncias juntas, que sempre têm
// cliente ocioso. Aqui só loga: a próxima consulta abre conexão nova.
pool.on('error', (err) => console.error('pool: conexão ociosa caiu, o pool abre outra', err.message));

// Ouvinte no CLIENTE (AUD-019, achado da revisão): o ouvinte de ocioso do
// pg-pool sai do cliente enquanto ele está EMPRESTADO (`pool.connect()` — o
// heartbeat em src/player/sinal.js, os jobs de 30 s, toda transação). Se a
// conexão cai nesse intervalo, mesmo no meio de uma query, o pg emite 'error'
// no Client e, sem ouvinte, o processo morre. Com este: a query em curso já
// recebe o erro, a seguinte (o ROLLBACK de quem chamou) falha com "not
// queryable", e o release() do finally tira o cliente morto do pool. Num
// cliente ocioso, loga junto com o ouvinte de cima.
pool.on('connect', (cliente) => cliente.on('error', (err) => console.error('pool: conexão caiu', err.message)));

module.exports = pool;
