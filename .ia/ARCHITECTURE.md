# ARCHITECTURE.md — Como o Mostraí é construído

Tudo abaixo foi conferido direto no código em 20/09/2026 (não é memória de
conversa). Onde há incerteza, está marcado.

## Stack

- **Runtime**: Node.js 22 (`"engines": {"node": ">=22 <23"}`, `.nvmrc`).
- **Framework HTTP**: Express 4 (`express-async-errors` pra rota `async` que
  rejeita cair no error handler em vez de derrubar o processo).
- **Banco**: PostgreSQL 17, driver `pg` cru — **sem ORM**. Uma função por
  operação em `*-repository.js`, SQL escrito à mão com parâmetros
  posicionais (`$1, $2, ...`), nunca concatenação de string.
- **Frontend**: HTML + JS puro, **sem build, sem framework, sem bundler**.
  Cada página é `<nome>.html` + `<nome>.page.js` opcional. Componentes
  mínimos compartilhados (`layout.js`, `modos.js`, `perfil.js`, `config.js`,
  `formulario.js`) carregados por `<script src>` direto.
- **Sessão**: `express-session` com store em Postgres (`connect-pg-simple`,
  tabela `session`) — **nunca `MemoryStore`** (ver `docs/erros/2026-09-sessao-em-memoria.md`
  e `DECISIONS.md`).
- **Autenticação**: cookie de sessão httpOnly (`secure` em produção). Não há
  JWT, OAuth ou provedor externo de identidade. Admin é usuário/senha fixos
  em variável de ambiente (`ADMIN_USER`/`ADMIN_PASSWORD`), comparados em
  tempo constante (`src/lib/segredo.js`).
- **Senha de conta**: hash com `scrypt` (`src/lib/senha.js`), com caminho de
  migração de hash antigo (`bcrypt`) se existir.
- **Storage de mídia**: Supabase Storage (bucket `criativos`), via
  `@supabase/supabase-js` (`src/lib/supabase.js`).
- **Processamento de mídia**: `ffmpeg`/`ffprobe` via `child_process`
  (`src/lib/ffmpeg.js`) — normaliza vídeo/imagem, gera thumbnail, mede
  duração.
- **E-mail transacional**: `nodemailer` via SMTP (Google Workspace).
- **Backup de nota fiscal**: `googleapis` (Google Drive da conta de serviço).
- **Lint/formatação**: Biome (`biome.json`) — motivo das regras em
  `docs/lint.md`.
- **Testes**: `node:test` nativo (sem Jest/Mocha), mais scripts de
  ponta-a-ponta em `tests/e2e/` (bash com `curl` e Playwright para os fluxos
  com navegador).

## Estrutura de diretórios

```
src/server.js          Entrada da aplicação: sessão, CORS, CSP, headers, monta as rotas, error handler
src/<domínio>/         routes.js (+ repository.js) por assunto:
  admin/               painel administrativo (rotas /admin/*), métricas
  anunciantes/          conta, criativos, exibições, escolha de pontos
  bancohoras/           saldo de exibição não entregue, apuração mensal, liquidação do confirmado
  candidaturas/         pedidos de virar ponto/vendedor
  categorias/           catálogo de ramos de atividade (bloqueio de concorrente)
  conta/                modos (ativação de papel), rotas de sessão/senha
  convites/             convite com token para ganhar um papel
  db/                   pool de conexão, migrator, migrations/*.sql numeradas
  dispositivos/         telas: chave de aparelho, PIN, status
  financeiro/           San Checkout, cobranças, comissão de vendedor, conciliação, e-mail, Drive
  indicacoes/            cupom de indicação do ponto, regras de limiar, upgrade
  lib/                  bibliotecas internas sem rota própria (ver abaixo)
  player/               endpoints que a TV chama (heartbeat, played)
  playlist/             gerador da playlist da hora + congelamento
  pontos/                comércio/endereço, comodato, planos de ponto
  titular/               direitos do titular de dados (LGPD)

src/lib/
  aparelho.js           exigirAparelho (autentica a TV pela chave)
  dinheiro.js           aritmética monetária seguindo docs/erros/…ponto-flutuante.md
  eventos.js            registro de eventos de métrica
  ffmpeg.js             normalização de criativo (vídeo/imagem → vídeo)
  limite-tentativas.js  rate limit em memória por IP+rota
  limites.js            constantes de teto (criativos por conta, etc.)
  pacing.js             cálculo puro da hora de uma tela (sem banco) — motor da playlist
  segredo.js             comparação em tempo constante
  senha.js              hash/verificação de senha (scrypt + migração de bcrypt)
  supabase.js           cliente do Supabase (Storage)

public/
  <página>.html + <página>.page.js   uma página, um script (quando precisa de JS)
  layout.js             cabeçalho/rodapé/menu, injetado em runtime via data-layout
  modos.js              card de ativação de papel (anunciante/ponto/vendedor)
  perfil.js             popup de dados da conta, comum a todas as páginas de conta
  config.js             API_BASE_URL, esc(), fmtBRL(), linkWhatsApp(), trava de duplo envio
  formulario.js          helpers de formulário (CEP, categorias)
  player.html/.page.js/.css   o player que roda na TV
  admin/                painel administrativo (SPA simples, mesmo padrão sem build)

tests/
  *.test.js             unitários (node:test) — pacing, dinheiro, senha, segurança, banco de horas, etc.
  e2e/                  fluxos ponta-a-ponta (bash + Playwright), tests/e2e/README.md explica o roteiro

scripts/                 backup.sh (pg_dump), conciliar.js, apurar-banco-horas.js, favicon.mjs — rodam como jobs agendados em produção
```

## Autenticação e autorização

Três sessões distintas no mesmo mecanismo (cookie + `express-session`):
conta (`req.session.anuncianteId`), admin (`req.session.isAdmin`), e a tela
não usa sessão — usa a chave de aparelho num header (`X-Aparelho-Id`),
conferida por `exigirAparelho` (`src/lib/aparelho.js`) a cada request.
Autorização por papel é checada rota a rota (`papeis.includes('ponto')`
etc.), não há middleware genérico de RBAC.

## Banco de dados

Postgres puro, sem ORM. Schema evolui por migrations SQL numeradas e
sequenciais em `src/db/migrations/` (63 arquivos até `064_playlist_hora_congelada.sql`
— a numeração pula um índice, confirmado por listagem, não investigado a
fundo), aplicadas por `src/db/migrate.js` no arranque do container
(`node src/db/migrate.js && node src/server.js`, ver `Dockerfile`). O
migrator é idempotente (tabela `schema_migrations`) e usa
`pg_advisory_lock` para não colidir se mais de uma instância subir ao mesmo
tempo (ver `Dockerfile`, comentário do `CMD`).

**Tabelas centrais** (não exaustivo — ver migrations pra schema exato):
`anunciantes` (é a tabela de contas — nome histórico, nunca renomear),
`planos`, `pontos`, `dispositivos`, `criativos`, `exibicoes_contador`,
`playlist_hora_congelada` (nova, 19/09/2026), `banco_horas`, `assinaturas`,
`candidaturas`, `convites`, `comissoes`, `cobrancas_confirmadas`,
`vendedores`, `anunciantes_pontos`, `session`.

**Migrations são aditivas por regra** (`CONSTRAINTS.md`) — reverter código
sem reverter banco deve continuar funcionando. Migration destrutiva só com
autorização nominal do dono.

## Fluxo de dados da playlist (o motor mais crítico do sistema)

1. Player da TV pede `GET /playlist/:dispositivoId` a cada 15 minutos
   (`public/player.page.js`), com a chave de aparelho.
2. `src/playlist/routes.js` chama `gerarPlaylistDaHora(dispositivo, hora)`
   **sem nenhum cache em memória** — recalcula do zero a cada request (o
   cache em memória por processo existiu e foi removido em 17/09/2026, ver
   `DECISIONS.md`; referências a "cache em memória" que ainda aparecem em
   `RUNBOOK.md`/`CONSTRAINTS.md` descrevem esse desenho antigo — drift de
   documentação registrado em `RISKS.md`).
3. `src/playlist/gerador.js` busca: anunciantes elegíveis para aquela tela
   (plano ativo, criativo aprovado, cobertura do ponto, categoria não
   concorrente), déficit da hora anterior, saldo de banco de horas, cota de
   autoanúncio do dono.
4. `src/lib/pacing.js` (`montarHoraDeTv`) é uma função **pura**, sem acesso a
   banco — recebe a lista de participantes e uma semente
   determinística (`dispositivo.id + hora`), devolve a hora orçada em
   segundos com embaralhamento e espalhamento estáveis.
5. **Congelamento (19/09/2026, novo)**: a primeira geração de cada hora grava
   a `entrada` usada em `playlist_hora_congelada`
   (`src/playlist/congelamento-repository.js`). Gerações seguintes da mesma
   hora reprocessam a mesma base pela mesma semente (sempre a mesma
   sequência) e só anexam quem passou a ser elegível depois
   (`sequenciaAdicional`), sempre no fim — isso é o que faz uma escolha de
   ponto nova entrar "no meio da hora" sem reposicionar quem já estava
   rodando. Ver `.ia/DECISIONS.md`.
6. O player toca a lista em sequência linear (índice não reseta ao trocar de
   playlist) e confirma cada exibição (`POST /player/:id/played`), que
   incrementa `vezes_confirmadas` em `exibicoes_contador` até o teto de
   `vezes_programadas`.

## APIs

Mapa completo rota-a-rota em `docs/api.md` (fonte de verdade — não duplicar
aqui). Categorias: público (sem login), conta logada, tela (chave de
aparelho), admin (sessão de admin). Erros seguem `{ erro: "mensagem" }` com
status HTTP apropriado; handler global em `src/server.js` cobre JSON
inválido, corpo grande demais, arquivo recusado pelo `multer`, e qualquer
exceção não tratada.

## CI/CD e deploy

- **CI** (`.github/workflows/ci.yml`): a cada push/PR na `main`, sobe um
  Postgres de serviço, roda `npm run migrate` e depois `npm run check`
  (sintaxe + lint + formatação + testes) — o mesmo comando que roda local.
  Falha também se um `.env` real estiver versionado.
- **Segurança semanal** (`.github/workflows/seguranca-semanal.yml`):
  `npm audit --audit-level=high` toda segunda-feira.
- **Deploy**: push na `main` → Northflank constrói a imagem do `Dockerfile`
  e substitui o container. Não há comando de release separado — as
  migrations rodam no `CMD` do próprio container, antes de subir o
  servidor; se falharem, o container não sobe e o anterior continua
  servindo. Detalhe operacional completo em `RUNBOOK.md` e
  `.ia/OPERATIONS.md`.
- **Dockerfile**: dois estágios (build com `python3 make g++` para compilar
  `bcrypt`; imagem final com `ffmpeg`, `postgresql-client-17` para
  `pg_dump`, roda como usuário `node`, não root).

## Serviços externos

Ver `.ia/INTEGRATIONS.md` para o detalhe de cada um: GitHub (código + CI),
Supabase (Postgres + Storage), Cloudflare (DNS + Access na frente de
`/admin`), Northflank (hospedagem + jobs agendados), San Checkout (cobrança,
estrutura própria da San & Co.), Google Workspace (SMTP + Drive).
