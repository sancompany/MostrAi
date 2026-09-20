# OPERATIONS.md — Comandos confirmados

Todos os comandos abaixo existem em `package.json`, `RUNBOOK.md` ou foram
executados de verdade nesta sessão. Nenhum é inventado.

## Instalação e ambiente

```bash
npm install
cp .env.example .env          # preencha DATABASE_URL, SESSION_SECRET, ADMIN_*
```

Requer Node 22+ (`.nvmrc`), um Postgres (local ou o projeto Supabase do
Mostraí), e `ffmpeg`/`ffprobe` no PATH (normalização de criativo).

Antes de rodar `npm run check` ou os testes, exporte as variáveis do `.env`
no shell (cada sessão de shell nova precisa disso de novo):

```bash
set -a && source .env && set +a
```

E garanta que o Postgres local está de pé:

```bash
service postgresql status | grep -q "5432): online" || service postgresql start
```

## Banco / migrations

```bash
npm run migrate     # aplica src/db/migrations em ordem, idempotente (tabela schema_migrations)
```

Migrations são SQL puro, numeradas sequencialmente
(`NNN_descricao.sql`), aplicadas por `src/db/migrate.js`. Nunca editar uma
migration já aplicada — corrigir com uma migration nova.

## Desenvolvimento

```bash
npm run dev          # nodemon src/server.js — http://localhost:<PORT>
npm start             # node src/server.js, sem reload
```

## Qualidade (o que o CI roda)

```bash
npm run sintaxe       # node --check em todo .js de src/, public/, tests/
npm run lint          # biome lint .
npm run lint:corrigir # biome lint --write .
npm run formato        # biome format .
npm run formato:corrigir
npm test               # node --test tests/*.test.js (unitários)
npm run check          # sintaxe + lint + formato + test — RODAR ANTES DE COMMITAR
```

`npm run check` é o mesmo comando do CI (`.github/workflows/ci.yml`) —
divergir dele localmente é como deixar passar algo que só quebra lá.

## Testes de ponta a ponta

Em `tests/e2e/` — roteiro completo em `tests/e2e/README.md`. Dois formatos:

```bash
# scripts bash (API pura, curl) — precisam do servidor rodando na 3999 e banco limpo
bash tests/e2e/01-fluxo-api.sh
bash tests/e2e/02-assinatura-webhook-comissao.sh
bash tests/e2e/04-modos-e-bonus.sh

# scripts Playwright (navegador de verdade) — precisam do Chromium do ambiente
PW_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node tests/e2e/03-navegador.mjs
PW_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node tests/e2e/05-navegador-modos.mjs
PW_CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node tests/e2e/06-painel-bloqueio-plano.mjs
```

Padrão usado nesta sessão pra escrever um teste manual novo: subir o
servidor local (`node src/server.js`, com as env vars exportadas, em
background), rodar o script Playwright/curl a partir de um arquivo
temporário dentro de `tests/e2e/` (fora daí o `import 'playwright'` não
resolve — o pacote só existe em `node_modules` na raiz do projeto), conferir,
**apagar o script temporário depois** — não deixar script de teste
descartável commitado.

`tests/e2e/reset-db.sh` limpa o banco de teste; `tests/e2e/restart.sh`
reinicia o servidor local.

## Jobs agendados (rodam via Northflank em produção, mas o comando é local)

```bash
npm run conciliar             # conciliação diária das assinaturas
npm run apurar-banco-horas    # apuração mensal do déficit de banco de horas
npm run backup                 # scripts/backup.sh — pg_dump gzipado
```

## Deploy

Não há comando de deploy manual — **push na `main` publica**. O Northflank
observa a branch, constrói a imagem do `Dockerfile` e substitui o
container; as migrations rodam no próprio `CMD` do container, antes do
servidor subir. Se a migration falhar, o container antigo continua no ar.

Conferir depois de um deploy:

```bash
curl https://mostrai.sancocore.com.br/health   # espera {"ok":true}
```

Fluxo usado nesta sessão pra confirmar deploy sem ficar rodando `curl` em
loop manualmente: um `for` com `sleep` rodado em background pela ferramenta
de shell do agente, procurando uma string nova e distinta no arquivo
estático publicado (ex.: um trecho de texto só existente depois da mudança),
com um número máximo de tentativas.

## Reverter

```bash
git revert <sha>        # NUNCA reescrever histórico da main
git push origin main
```

Ou, mais rápido: Northflank → serviço `mostrai` → Deployments → escolher um
build verde anterior → Deploy. Migration não se reverte por redeploy — elas
são aditivas por regra (`CONSTRAINTS.md`); reverter o schema exige restaurar
backup.

## Logs e troubleshooting

- `/health` não responde → Northflank → Observe → logs (erro no boot costuma
  ser variável de ambiente faltando).
- Job de conciliação/backup/apuração falhou → ler o log do job específico,
  cada um nomeia o que deu errado e sai com código 1.
- Webhook do San Checkout voltando 401 → `SAN_CHECKOUT_KEY` divergiu entre
  os dois lados — comparar com o painel do Checkout.
- Fila `eventos_assinatura_pendentes` crescendo → aba correspondente no
  `/admin` mostra o motivo de cada evento não aplicado.
- Ver tabela completa "Alerta → o que significa → primeira ação" em
  `RUNBOOK.md`, seção 6 — não duplicada aqui porque `RUNBOOK.md` é a fonte
  de verdade operacional e pode mudar sem que este arquivo acompanhe.

## Supabase / Cloudflare / Northflank — como trabalhar quando o ambiente dá acesso

- **Supabase**: se o ambiente do agente tiver a ferramenta MCP correspondente,
  use `execute_sql`/`get_advisors`/`list_migrations` etc. direto no projeto
  certo (`MostrAi`, não `San_Checkout` — são dois projetos Supabase
  distintos na mesma organização). Chamada que volta "requires approval"
  pode estar bloqueada pela política da sessão, não necessariamente negada
  — não repita a mesma chamada em loop.
- **Cloudflare**: não há integração programática no código nem ferramenta
  usada nesta sessão — mudança de DNS/Access é feita a mão no painel.
- **Northflank**: se disponível, a skill/plugin `northflank` cobre API, CLI
  e client JS para gerenciar o serviço, os jobs e os segredos.
- **GitHub**: ferramentas MCP `github` cobrem PR, issues, Actions — preferir
  a elas em vez de pedir ao usuário status que dá pra consultar direto.
