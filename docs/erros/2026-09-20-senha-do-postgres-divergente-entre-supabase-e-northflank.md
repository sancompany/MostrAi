# Senha do Postgres trocada no Supabase sem atualizar Northflank — app e jobs derrubados

**Sintoma.** `/admin`, login e qualquer rota que toca o banco devolviam 500
em produção. `/health` respondia normal (não depende do banco).

**Causa raiz.** A senha do Postgres foi resetada no Supabase (Settings →
Database → Reset database password) sem atualizar `DATABASE_URL` nos
lugares que a usam no Northflank. Logs do serviço confirmaram
`password authentication failed for user "postgres"` (código `28P01`),
repetindo a cada poll de qualquer rota que abre conexão.

**Descoberta que quase foi esquecida.** `DATABASE_URL` não é uma variável
só — está guardada **separadamente em cada recurso do Northflank**: o
serviço `mostrai` e os jobs `Conciliacao`/`Backup` cada um tem a própria
cópia (não existe secret group compartilhado no projeto). Atualizar só o
serviço deixou os dois jobs presos na senha antiga — eles voltaram a
falhar na rodada seguinte (confirmado rodando os dois manualmente antes de
fechar o incidente).

**Correção.**
1. Senha resetada no Supabase (fora do meu alcance — só pelo painel).
2. `DATABASE_URL` atualizada no serviço `mostrai` (Northflank).
3. `DATABASE_URL` atualizada em **cada job** (`Conciliacao`, `Backup`) via
   `POST /jobs/{jobId}/runtime-environment` — não existe "atualizar uma vez
   só" no Northflank pra isso.
4. Serviço reiniciado (pegou a env nova sozinho, sem precisar de rebuild).
5. Os dois jobs disparados manualmente pra confirmar (não esperar a próxima
   rodada agendada) — `conciliacao` e `backup` voltaram a `SUCCESS`.

**Achado lateral, registrado de passagem.** O job `ApuracaoBancoHoras`, que
`RUNBOOK.md` já citava como "existe? não existe?", **foi confirmado que não
existe** no Northflank — só há `Conciliacao` e `Backup`. Isso não é deste
incidente, é uma lacuna operacional separada, sem correção aqui — só
confirmação do que já era suspeita (`docs/PENDENCIAS.md`, item A.14).

**Guarda pra não repetir.** Ao trocar a senha do Postgres (ou qualquer
segredo compartilhado), atualizar em TODOS os lugares do Northflank que o
usam antes de considerar a troca concluída: serviço `mostrai` **e** cada
job (`Conciliacao`, `Backup`, e qualquer um criado depois). Testar
disparando o job manualmente em vez de confiar que "a próxima rodada
resolve sozinha" — foi exatamente essa suposição que quase deixou os jobs
quebrados sem ninguém perceber até a próxima falha agendada.

**Ecossistema:** sim — qualquer projeto San & Co. no Northflank com mais de
um serviço/job lendo o mesmo segredo tem o mesmo risco (nenhum secret group
compartilhado hoje nesse projeto).
