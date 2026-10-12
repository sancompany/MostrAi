# Pool sem ouvinte de 'error': conexão caindo derrubava o processo

**Sintoma** (AUD-019, auditoria V1, ciclo 1; reproduzido em banco local).
Com o servidor no ar, encerrar no Postgres os backends do app (o que um
restart, failover ou oscilação do pooler do Supabase faz) matava o
processo, código 1, `/health` sem resposta. Duas formas: conexão OCIOSA
(`Emitted 'error' event on BoundPool`) e conexão EMPRESTADA por
`pool.connect()` — em `BEGIN` ou no meio de uma query (`Emitted 'error'
event on Client instance`). As 2 instâncias quase sempre têm uma das duas
(heartbeat a cada 15 s em transação, jobs a cada 30 s), então cairiam
juntas.

**Causa raiz.** `src/db/pool.js` exportava o `Pool` sem ouvinte de
`'error'` — nem no Pool, nem nos clientes. Ocioso: o pg-pool descarta o
cliente e emite `'error'` no Pool. Emprestado: o pg-pool TIRA o seu
ouvinte do cliente no empréstimo (`pg-pool/index.js`, `_acquireClient`), e
o pg, quando a conexão cai, rejeita a query em curso e ainda emite
`'error'` no Client (`pg/lib/client.js`, `_handleErrorEvent`). Nos dois
casos, `EventEmitter` sem ouvinte lança — exceção não capturada. A 1ª
rodada da correção pôs só o ouvinte do Pool e tratou o emprestado como
"sair é o certo"; a revisão mostrou que o pg já deixa o cliente morto
inofensivo, e que sair derrubava as instâncias pelo mesmo caminho.

**Correção.** `pool.on('error')` que só loga (a próxima consulta abre
conexão nova) e `pool.on('connect', c => c.on('error', …))`, ouvinte
próprio em cada cliente, que também só loga: a query em curso recebe o
erro, a seguinte (o `ROLLBACK` de quem chamou) falha com "not
queryable", e o `release()` do `finally` tira o cliente morto do pool. Em
`src/server.js`, `uncaughtException` loga com etiqueta e sai com 1 (só no
processo principal) — última rede para o que não for queda de conexão.
(`keepAlive: true` entrou e saiu na revisão: sem
`keepAliveInitialDelayMillis` vale o padrão do SO, 2 h, e o pool fecha o
cliente ocioso em 10 s — nunca sondava nada.)

**Guarda.** `tests/db-pool-resiliencia.test.js`: `pg_terminate_backend` no
backend ocioso do pool e no de um cliente emprestado em `BEGIN`; antes o
arquivo reprovava por `uncaughtException`, agora o processo segue, o
cliente morto sai do pool e a consulta seguinte vem de outro backend.

**Como evitar na origem.** Todo `Pool` nasce com ouvinte de `'error'` no
Pool E nos clientes (`'connect'`), e todo `Client` de vida longa (como o do
LISTEN em `src/lib/sse.js`, que já tinha) também. O README do pg-pool diz
isso: queda de conexão é comum.

**Ecossistema:** sim — qualquer serviço Node com `pg` contra Postgres
gerenciado.
