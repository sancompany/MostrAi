# Transação pedia uma 2ª conexão ao pool e pendurava a instância

**Sintoma** (AUD-001, auditoria V1, ciclo 1; reproduzido em banco local).
Seis a dez `POST /anunciantes/me/creditos/resgatar` simultâneos da mesma
conta (duplo clique, várias abas) nunca respondiam, e depois disso nenhuma
rota que toca o banco respondia mais (`GET /planos` incluído). `/health`
seguia 200, porque não toca o banco — o Northflank não reiniciava nada. No
`pg_stat_activity`: 1 conexão `idle in transaction` segurando o `FOR UPDATE`
da conta e 4 `active | Lock` esperando a mesma linha. Saldo 0 bastava.

**Causa raiz.** A transação do resgate (`pool.connect()` + `BEGIN` +
`SELECT … FOR UPDATE`) chamava `historicoDaConta`, `bloqueioPorNivel` e
`creditosDoResgate` sem o cliente — os três iam ao `pool` global. Com o pool
em 5 (`src/db/pool.js`), cinco resgates juntos ocupam as cinco conexões: um
segura a linha e espera uma 6ª conexão que nunca vem; quatro esperam a
linha. O pool não tinha `connectionTimeoutMillis`, então a espera era
infinita. O mesmo desenho existia nos dois aceites de convite de candidatura
— o cadastro por convite (`src/anunciantes/routes.js`) e a conta logada que
aceita (`POST /convites/:token/aceitar`, `src/conta/modos.js`):
`candidaturasRepo.buscarPorId` pelo pool dentro da transação. A 1ª rodada da
correção pegou só o cadastro; a revisão achou o segundo.

**Correção.** Toda leitura entre o `pool.connect()` e o `COMMIT` recebe o
`cliente` da transação (`historicoDaConta(contaId, db)`,
`bloqueioPorNivel(conta, tier, db)`, `substituicaoDoResgate(historico, db)`,
`candidaturasRepo.buscarPorId(id, db)`). Defesa: `connectionTimeoutMillis:
5000` no pool — um ciclo igual vira erro em 5 s, não instância parada.

**Guarda.** `tests/creditos-resgate.test.js` (10 resgates simultâneos + `GET
/planos` em < 5 s; resgate com UMA conexão livre no pool) e
`tests/indicacao-cadastro.test.js` (cadastro por convite e aceite por conta
logada, cada um com uma conexão livre). Os quatro falham no código antigo.

**Como evitar na origem.** Dentro de `pool.connect()`…`COMMIT`, nenhuma
chamada sem o cliente: toda função de repositório que pode rodar numa
transação recebe `db = pool` e quem está na transação passa o cliente. Ler
pelo pool ali dentro, além de ver dado fora da transação, é deadlock de pool
assim que a concorrência alcança o `max`.

**Ecossistema:** sim — qualquer projeto com `pg` Pool de teto baixo (Supabase)
e transações com `FOR UPDATE`.
