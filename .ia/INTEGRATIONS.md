# INTEGRATIONS.md — Serviços externos do Mostraí

Nenhum valor real de credencial está neste arquivo (nem em nenhum outro do
repositório) — só nomes de variável, propósito e onde cada coisa aparece no
código. Fonte: `.env.example`, `RUNBOOK.md`, código.

## GitHub

- **Finalidade**: hospeda o código-fonte (`sancompany/MostrAi`, público) e
  roda o CI/CD via GitHub Actions.
- **Onde aparece**: `.github/workflows/ci.yml` (testes a cada push/PR na
  `main`), `.github/workflows/seguranca-semanal.yml` (`npm audit` semanal).
- **Variáveis de ambiente**: nenhuma — o CI usa segredos do próprio
  ambiente do workflow (`DATABASE_URL`/`ADMIN_*` fixos de teste, não
  produção).
- **Como verificar status**: aba Actions do repositório; branch protegida é
  a `main` (push nela dispara o deploy via Northflank).
- **Estado atual**: CI verde é pré-condição de deploy (o Northflank observa
  a `main`, não o resultado do CI diretamente — checar os dois).

## Supabase

- **Finalidade**: Postgres 17 (banco principal da aplicação) + Storage
  (bucket dos criativos de vídeo/imagem).
- **Onde aparece**: `src/db/pool.js` (conexão via `pg`), `src/lib/supabase.js`
  (cliente `@supabase/supabase-js` só para Storage), `src/db/migrations/`
  (schema).
- **Variáveis de ambiente**: `DATABASE_URL` (Postgres, *Session pooler*
  porta 5432 — não o host direto, que é IPv6 e nem toda rede alcança),
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET`
  (hoje `criativos`).
- **Dois projetos Supabase existem na organização**: um para o Mostraí e
  um para o San Checkout (estrutura separada da San & Co.), ambos região
  `sa-east-1`. Confirmado via ferramenta MCP do Supabase em 20/09/2026 —
  **não documentado antes disso**, então valide de novo se este arquivo já
  estiver desatualizado. O ref/host de cada projeto é identificador de
  infraestrutura (este repositório é público — `RUNBOOK.md`) e por isso
  **não é registrado aqui**; descubra pelo `list_projects` da ferramenta
  MCP ou pelo painel do Supabase quando precisar, e nomeie o projeto certo
  pelo nome (`MostrAi`, não `San_Checkout`) ao chamar `execute_sql` etc.
- **Como verificar status**: dashboard supabase.com/dashboard, ou a
  ferramenta MCP `Supabase` quando disponível no ambiente do agente
  (`list_projects`, `execute_sql`, `get_advisors`, etc.) — **pode exigir
  aprovação humana explícita por chamada**; se a chamada retornar "requires
  approval" sem que o usuário tenha respondido, não assuma negação nem
  repita a chamada sem necessidade — avise o usuário e prossiga por outro
  caminho (ex.: pedir pra ele conferir pelo `/admin` da aplicação).
- **Estado atual**: **Plano Free** — sem backup automático do lado do
  Supabase (é por isso que existe o job próprio `Backup`, exceção
  registrada da Lei 6 em `CONSTRAINTS.md`).

## Cloudflare

- **Finalidade**: DNS de `sancocore.com.br` e Cloudflare Access na frente de
  `/admin` (segunda camada de autenticação, além do login usuário/senha da
  aplicação).
- **Onde aparece**: não há código no repositório que fale com a API da
  Cloudflare — a proteção acontece na borda, fora da aplicação. `/admin` no
  código só tem o login usuário/senha (`src/server.js`,
  `requireAdminSession`).
- **Variáveis de ambiente**: nenhuma no `.env.example` — configuração vive
  só no painel da Cloudflare.
- **Como verificar status**: dash.cloudflare.com; confirmar que o Access
  está ativo tentando abrir `/admin` fora da rede/identidade autorizada (deve
  bloquear antes mesmo do login da aplicação aparecer).
- **Estado atual**: ativo desde 15/09/2026, confirmado em produção.

## Northflank

- **Finalidade**: hospedagem do serviço web `mostrai` (a aplicação Node) e
  dos jobs agendados (`Conciliacao`, `Backup`, `ApuracaoBancoHoras` — este
  último com status incerto, ver abaixo).
- **Onde aparece**: `Dockerfile` (a imagem que o Northflank constrói e
  roda), `scripts/backup.sh`/`conciliar.js`/`apurar-banco-horas.js` (o que
  cada job executa).
- **Variáveis de ambiente**: todas as de `.env.example` são configuradas no
  painel do serviço Northflank, nunca em arquivo — não há arquivo de config
  do Northflank versionado neste repositório (confirmar se isso muda;
  existe uma branch separada `claude/mostrai-estacao-1-pipeline-y2vgr5`
  com um commit "Adiciona Dockerfile de producao para o Northflank" que
  **não foi investigada nesta sessão** — não presuma o conteúdo dela).
- **Como verificar status**: app.northflank.com, projeto `MostrAi`, time
  `san-co`, região South America East; ou a skill/plugin `northflank`
  quando disponível no ambiente do agente (API/CLI/JS client).
- **Estado atual**: deploy automático ativo (push na `main` → build →
  migrations no arranque do container → troca do container). Uma instância
  só hoje (ver `.ia/RISKS.md` — janela de 503 na troca de deploy, medida e
  aceita como custo, não bug).
- **Job `ApuracaoBancoHoras`**: `RUNBOOK.md` registra que ele "falhou (ou
  não existe ainda)" como um dos sinais de alerta — **não confirmado nesta
  sessão se o job já foi criado no Northflank**. Ver `docs/PENDENCIAS.md`,
  item A.14, e `.ia/RISKS.md`.

## San Checkout

- **Finalidade**: motor de pagamento/cobrança de toda a estrutura San & Co.
  — o Mostraí nunca processa cartão diretamente (veto explícito a cobrança
  própria em `CONSTRAINTS.md`). O Mostraí é o "contratante" `mostrai` dentro
  do Checkout.
- **Onde aparece**: `src/financeiro/san-checkout.js` (chamadas de saída:
  criar cobrança, trocar plano, telefone/documento formatados),
  `src/financeiro/routes.js` (webhook de entrada — `criada`,
  `plano_trocado`, `cobranca_contestada`), `src/financeiro/conciliacao.js`
  (conciliação diária).
- **Variáveis de ambiente**: `SAN_CHECKOUT_BASE_URL` (tela que o comprador
  abre), `SAN_CHECKOUT_API_URL` (o que o servidor chama — os dois **não são
  intercambiáveis**), `SAN_CHECKOUT_CONTRATANTE_ID`, `SAN_CHECKOUT_KEY`
  (também é o segredo que assina os webhooks via HMAC-SHA256 — não existe
  segredo de webhook separado).
- **Como verificar status**: painel admin do próprio Checkout; localmente,
  o repositório `sancompany/san_checkout` pode ser clonado à parte para ler
  o contrato de API real em vez de supor (ver
  `docs/erros/2026-09-14-contrato-do-checkout-suposto-em-vez-de-lido.md` —
  erro registrado exatamente por não fazer isso antes).
- **Estado atual**: webhook fail-closed, idempotente (`webhooks_processados`)
  e transacional — regra dura, não afrouxar (`CONSTRAINTS.md`). Um caso de
  troca de plano falhando ("não foi possível calcular o acerto proporcional
  desta troca") foi investigado nesta sessão e apontado como problema do
  lado do Checkout para essa assinatura específica, não do Mostraí — ver
  `.ia/RISKS.md` e `.ia/TODO.md` (seção BUGS) para o detalhe e o que falta
  pra fechar.

## Google Workspace

- **Finalidade**: e-mail transacional (SMTP, confirmação de conta,
  redefinição de senha, avisos de criativo aprovado/reprovado) e backup de
  nota fiscal no Google Drive.
- **Onde aparece**: `src/financeiro/email.js` (SMTP via `nodemailer`),
  `src/financeiro/drive.js` (`googleapis`, conta de serviço).
- **Variáveis de ambiente**: `MOSTRAI_EMAIL_FROM`, `MOSTRAI_EMAIL_CONTATO`,
  `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `GOOGLE_DRIVE_FOLDER_ID`, `GOOGLE_SERVICE_ACCOUNT_KEY` (produção — JSON
  inteiro na variável, nunca arquivo) / `GOOGLE_SERVICE_ACCOUNT_KEY_PATH`
  (só para rodar local).
- **Como verificar status**: caixa de entrada de `admin@sancocore.com.br`
  (o "De" efetivo — ver decisão sobre alias em `.ia/DECISIONS.md`); Google
  Cloud IAM para a conta de serviço do Drive.
- **Estado atual**: ativo. Resposta de e-mail sai com o endereço real
  (`admin@`), não o alias (`mostrai@`) — decisão aceita do dono, cosmético,
  não é bug (ver `.ia/DECISIONS.md`).

## Ferramentas MCP eventualmente disponíveis ao agente

Dependendo do ambiente de execução, o agente pode ter acesso direto (via
MCP) a: `Supabase` (`list_projects`, `execute_sql`, `get_advisors`, etc.),
`northflank` (skill dedicada), `github` (API completa). **Sempre prefira
essas ferramentas a perguntar ao usuário** informações que dá pra descobrir
sozinho — mas chamadas que retornam "requires approval" podem estar
bloqueadas pela política do ambiente daquela sessão, não necessariamente
negadas pelo usuário; não insista em loop, e não interprete a ausência de
resposta como autorização nem como negação.
