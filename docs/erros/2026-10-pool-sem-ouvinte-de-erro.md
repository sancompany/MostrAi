# Pool sem ouvinte de 'error': conexão ociosa caindo derrubava o processo

**Sintoma** (AUD-019, auditoria V1, ciclo 1; reproduzido em banco local).
Com o servidor no ar, encerrar no Postgres os backends OCIOSOS do app (o que
um restart, failover ou oscilação do pooler do Supabase faz) matava o
processo: `Unhandled 'error' event … Emitted 'error' event on BoundPool`,
código 1, `/health` sem resposta. As 2 instâncias têm cliente ocioso quase
sempre (jobs a cada 30 s, heartbeat a cada 15 s), então cairiam juntas.

**Causa raiz.** `src/db/pool.js` exportava o `Pool` sem `pool.on('error')`.
O pg-pool, quando um cliente ocioso perde a conexão, descarta o cliente e
emite `'error'` no Pool; `EventEmitter` sem ouvinte de `'error'` lança, e
`process.on('unhandledRejection')` (o único em `src/server.js`) não cobre
isso.

**Correção.** `pool.on('error')` que só loga (a próxima consulta abre
conexão nova) e `keepAlive: true` no Pool. Em `src/server.js`,
`uncaughtException` loga com etiqueta e sai com 1 (só no processo
principal) — cobre o caso que o ouvinte do pool não alcança: cliente
EMPRESTADO (`pool.connect()`) cuja conexão cai entre duas queries; aí sair
é o certo, e o Postgres desfaz a transação.

**Guarda.** `tests/db-pool-resiliencia.test.js`: `pg_terminate_backend` no
backend ocioso do pool; antes o processo de teste morria
(`uncaughtException`), agora ele segue e a consulta seguinte vem de outro
backend.

**Como evitar na origem.** Todo `Pool` (e todo `Client` de vida longa, como
o do LISTEN em `src/lib/sse.js`, que já tinha) nasce com ouvinte de
`'error'`. O README do pg-pool diz isso: queda de conexão ociosa é comum.

**Ecossistema:** sim — qualquer serviço Node com `pg` contra Postgres
gerenciado.
