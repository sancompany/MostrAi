# Pool sem `max` explícito estourava o limite de sessão do Supavisor com 2 instâncias

**Sintoma.** `error: (EMAXCONNSESSION) max clients reached in session mode -
max clients are limited to pool_size: 15`, `severity: 'FATAL'`, numa query
dentro de um `Promise.all` de `src/admin/routes.js`. Visto nos logs de
produção às 17:24 de 23/09/2026, pouco depois de um deploy.

**Causa raiz.** `src/db/pool.js` criava o `Pool` sem `max` — o padrão do
driver `pg` é 10 conexões por instância do `Pool`. O serviço no Northflank
roda com `instances: 2` (item 4 de `docs/PENDENCIAS.md`, concluído em rodada
anterior) — dois `Pool` default já somam até 20 conexões possíveis, contra
o teto de 15 configurado no Supavisor (pooler de sessão) do projeto Supabase
de produção. Sob carga simultânea nas duas instâncias, era questão de tempo
até estourar.

**Como foi achado.** Auditoria de log de produção depois de outra mudança
(Fase 3, SSE — `src/lib/sse.js` ganhou uma conexão dedicada de
LISTEN/NOTIFY, permanente, por instância) — ao conferir se o deploy tinha
subido limpo, o erro apareceu num log ANTERIOR ao deploy sendo conferido,
mostrando que o problema já existia antes, e que a conexão nova do LISTEN
(2 a mais, nunca devolvidas) ia piorar a folga que já era curta.

**Correção.** `new Pool({ ...config, max: 5 })` — 2 instâncias × 5 = 10,
deixando margem pras 2 conexões do LISTEN (1 por instância) e pra conexão
avulsa de `scripts/conciliar.js` (job separado do Northflank, fora das
2 instâncias do serviço principal).

**Guarda.** Nenhum teste automatizado cobre limite de conexão (precisaria
de carga real contra o Supavisor de produção, fora do que os testes de
unidade alcançam). Verificado que `max: 5` não deixou a suíde mais lenta
(mesma duração antes/depois, 249/249 passando).

**Como evitar na origem.** Todo `Pool` conectado a um serviço gerenciado com
teto de conexão explícito (Supabase, RDS Proxy, PgBouncer) precisa de `max`
dimensionado contra `número de instâncias × max do Pool ≤ teto do provedor`,
não o padrão do driver — o padrão existe pra um Postgres sem pooler na
frente, não pra um com teto fixo e compartilhado entre réplicas.

**Ecossistema:** sim — qualquer projeto da San & Co. que rode mais de uma
instância contra um Postgres gerenciado com teto de sessão (Supabase,
principalmente) tem o mesmo risco se o `Pool` não tiver `max` explícito.
