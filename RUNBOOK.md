# RUNBOOK — Mostraí

Como operar, reverter, restaurar e responder a incidente. Versionado ao lado
do código porque quem clona precisa disso — e porque um dia quem opera não vai
ser quem construiu.

**Este repositório é público.** Nada aqui carrega segredo, host, chave ou
identificador de infraestrutura (`CONSTRAINTS.md`). O que este documento diz é
*onde* está cada coisa, nunca *qual é*.

> **Iniciado na Estação 3 (14/09/2026).** As seções marcadas **[Estação 6]**
> pedem medição no ar e ainda não têm evidência. Elas estão aqui com o que
> precisa ser respondido, não com resposta inventada.

---

## Deploy: o que acontece hoje (conferido em 15/09/2026)

Push na `main` → o Northflank constrói e troca o contêiner sozinho. Não há
comando de release: **as migrations rodam no arranque do próprio contêiner**
(`Dockerfile`, `node src/db/migrate.js && node src/server.js`). Se a migration
falhar, o contêiner não sobe e o anterior continua servindo.

O serviço tem **duas instâncias** (`nf-compute-50`, conferido em
25/09/2026) e uma sonda de prontidão em `/health` (readinessProbe, 10s de
espera inicial). A troca é rolante: uma instância nova só recebe tráfego
depois do `/health`. A janela de 503 medida quando havia uma instância só
não se aplica mais.

**Como conferir que um deploy deu certo:** `curl https://mostrai.sancocore.com.br/health`
deve devolver `{"ok":true}`; a aba Visão geral do admin mostra a última
conciliação; e `SELECT count(*) FROM schema_migrations` tem que bater com o
número de arquivos em `src/db/migrations/`.

## 1. Inventário de contas

Uma linha por serviço. Login, segundo fator e cartão são do dono; este
documento só aponta onde.

| Serviço | Para que serve | Onde administrar | Plano |
|---|---|---|---|
| **GitHub** | repositório `sancompany/MostrAi`, público, e o CI | github.com/sancompany | gratuito |
| **Northflank** | serviço web `mostrai` e os três jobs (`Conciliacao`, `Backup`, `ApuracaoBancoHoras`), no projeto `MostrAi` do time `san-co`, região South America East | app.northflank.com | `nf-compute-50`, ~US$12/mês + volume 6 GB (~US$0,90) |
| **Supabase** | Postgres 17 e o Storage (`criativos`), projeto `MostrAi`, região sa-east-1 | supabase.com/dashboard | **Free** — sem backup automático (exceção da Lei 6, `CONSTRAINTS.md`) |
| **Cloudflare** | DNS de `sancocore.com.br` e o Access na frente de `/admin` | dash.cloudflare.com | gratuito |
| **San Checkout** | cobrança (estrutura da San & Co.) — o Mostraí é o contratante `mostrai` | painel admin do Checkout | — |
| **Google Workspace** | e-mail `mostrai@sancocore.com.br` (SMTP) e o Drive das notas | admin.google.com | — |

**[Estação 6]** Falta escrever: data de renovação do domínio, cartão que paga
cada conta, e onde vive o segundo fator de cada login.

---

## 2. Onde estão os segredos, e como rotacionar

Nenhum segredo mora no repositório. Eles vivem em **Northflank → serviço
`mostrai` → Environment**, e nos jobs `Conciliacao`, `Backup` e
`ApuracaoBancoHoras` (criado em 25/09/2026) — este último só leva
`DATABASE_URL` e `NODE_ENV`.

| Segredo | Onde se gera um novo |
|---|---|
| Senha do Postgres | Supabase → Settings → Database → Reset database password |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `SESSION_SECRET` | `openssl rand -base64 48`. Trocar derruba todas as sessões — é o efeito desejado. **Também é a raiz do cofre** (`src/lib/cofre.js`): depois de trocar, redefinir o **PIN de saída do Player** em Rede (o antigo não decifra mais e a config passa a mandar `pinSaida: null`) e gerar de novo os códigos de instalação pendentes. As credenciais das TVs não mudam (são hash, não cifra) |
| `ADMIN_PASSWORD` | escolha do dono. Comparado em tempo constante (`src/lib/segredo.js`) |
| `SAN_CHECKOUT_KEY` | painel do San Checkout, no cadastro do contratante. **É também o segredo que assina os webhooks** — trocar sem avisar o Checkout derruba a cobrança |
| `SMTP_PASS` | Google Account → Segurança → Senhas de app |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | Google Cloud → IAM → Contas de serviço → nova chave |

**A ordem de troca tem duas metades** (lição nº 27): a variável nova existe
**antes** do código que a usa; a antiga só sai **depois** que o código que a
usava saiu do ar.

**Trocar `DATABASE_URL`:** a senha vai **codificada para URL**. Caractere como
`?` ou `/` quebra a string de conexão silenciosamente. Use o *Session pooler*
(porta 5432), não o host direto — ele é IPv6 e nem toda rede alcança.

### 2.1 Incidente de exposição de credenciais — 25/09/2026

Um comando de diagnóstico (`northflank get service ... -o json`) imprimiu o
`runtimeEnvironment` inteiro do serviço `mostrai` em texto puro na saída de
uma ferramenta, dentro de uma sessão de agente — não em log público, não
commitado, mas visto pelo agente. Um incidente anterior, no mesmo dia,
também expôs `DATABASE_URL` na resposta de criação do job
`ApuracaoBancoHoras` (ver seção 14 de `docs/PENDENCIAS.md`).

**Segredos afetados:** `DATABASE_URL` (senha do Postgres), `SUPABASE_SERVICE_ROLE_KEY`,
`ADMIN_PASSWORD`, `SESSION_SECRET`, `SAN_CHECKOUT_KEY`, `SMTP_PASS`,
`GOOGLE_SERVICE_ACCOUNT_KEY`.

**Rotacionados e validados no mesmo dia** (sem indisponibilidade observada):
- `ADMIN_PASSWORD` — nova senha aplicada ao serviço `mostrai`; validado
  comparando o hash SHA-256 do valor aplicado (nunca o valor em si) contra o
  valor gerado, e revendo a lógica de comparação em `src/server.js`.
- `SESSION_SECRET` — idem. Efeito colateral aceito: sessões admin abertas
  antes da troca precisam logar de novo.
- Senha do Postgres (`DATABASE_URL`) — trocada via Management API do
  Supabase; propagada aos 4 consumidores (serviço `mostrai` + jobs
  `conciliacao`/`backup`/`apuracaobancohoras`) e validada com uma consulta
  real (`select 1`) de dentro do container já com o novo valor.
- `SUPABASE_SERVICE_ROLE_KEY` — projeto já estava no sistema novo de chaves
  (`sb_secret_...`), o que permitiu rotação **sem indisponibilidade**: chave
  nova criada, aplicada ao serviço, validada com uma chamada real
  (`storage.listBuckets()`), só então a chave antiga foi revogada.

**Encerrado por decisão do operador (25/09/2026, mesmo dia): `OPERATOR_ACCEPTED_NO_ROTATION`.**
O dono decidiu manter os 4 segredos já rotacionados como estão, não
rotacionar os 3 abaixo por causa deste incidente, e seguir com o resto do
trabalho da sessão. Motivo dos 3, registrado para quem for decidir rotacionar
depois:
- `SMTP_PASS` — é uma senha de app do Google, e a criação exige login
  interativo com 2FA em myaccount.google.com/apppasswords. Não existe API.
- `GOOGLE_SERVICE_ACCOUNT_KEY` — exige acesso ao Google Cloud Console
  (IAM → Contas de serviço) ou `gcloud` autenticado; nenhum dos dois estava
  disponível na sessão do agente.
- `SAN_CHECKOUT_KEY` — é uma credencial **compartilhada** entre Mostraí e o
  San Checkout (a `api_key` do contratante `mostrai`, armazenada no banco do
  San Checkout, não num secret comum). O próprio San Checkout já tem uma
  rota feita sob medida pra isso — `POST
  /api/admin/contratantes/:id/rotacionar-chave` (troca imediata, sem janela
  de duas chaves válidas) — só falta o dono acionar com o login de admin do
  San Checkout, que o agente não tem.

**Contenção:** arquivos de scratchpad de sessão que continham o dump
completo (inclusive de um agente anterior) foram apagados; nenhum segredo
foi encontrado em `git status`/`git diff`/commits deste repositório.

**Atenção operacional:** o novo valor de `ADMIN_PASSWORD` gerado nesta
rotação nunca foi mostrado a ninguém — nem ao dono — de propósito, pra não
repetir o padrão do incidente. Login no `/admin` com usuário/senha está,
portanto, **sem senha conhecida** até o dono definir uma nova ("`ADMIN_PASSWORD` —
escolha do dono", tabela acima) direto no ambiente do serviço `mostrai` no
Northflank. Isso não bloqueou o resto do trabalho: o upload do vídeo
institucional (seção M de `docs/PENDENCIAS.md`) foi feito executando a
mesma lógica da rota direto dentro do container (`northflank exec`), sem
depender de login nenhum.

**Nunca fazer:** editar `contratantes.api_key` direto no banco do San
Checkout — existe rota própria pra isso, e o `README.md` de lá proíbe
edição direta por SQL Editor.

---

## 3. Deploy

**Push na `main` é publicação.** O Northflank tem CI e CD ligados: todo push
constrói a imagem do `Dockerfile` e sobe. A porta é o CI do GitHub, não uma
pessoa.

O que roda em cada deploy, nesta ordem: build da imagem → **release command
`npm run migrate`** → troca do container.

O `migrate` é idempotente: ele consulta a tabela `schema_migrations` e só
aplica o que falta. Migration que falha aborta o deploy e o container antigo
continua no ar — é o comportamento desejado.

**Conferir depois de subir:** `GET /health` responde `{"ok":true}`.

---

## 3.1 San Checkout: virada de sandbox para produção — FEITA

**Histórico.** A virada aconteceu: o Checkout roda com
`ASAAS_AMBIENTE=producao` (conferido no contêiner em 25/09/2026) e Pix e
cartão reais foram homologados pelo dono. A sequência abaixo fica como
referência de como foi feita e de como reverter. Registrado na consolidação
final (24/09/2026):

1. **Antes** — no Mostraí, listar o que é de sandbox: `assinaturas` com
   `status IN ('ativa','pendente_pagamento','pendente_troca')`,
   `cobrancas_confirmadas` e `ciclos_contratados` gerados por cobrança de
   teste, `eventos_assinatura_pendentes` abertos. Nada disso pode ser
   apagado sem o dono dizer o que fica (histórico) e o que sai; assinaturas
   de teste que sobrarem viram pendência na conciliação diária (404 no
   Checkout de produção).
2. **Checkout** — trocar `ASAAS_AMBIENTE` e a chave da Asaas no serviço
   `san-checkout`; conferir que o contratante `mostrai` existe lá com a
   MESMA `SAN_CHECKOUT_KEY` (ela assina o webhook — divergiu, tudo dá 401).
3. **Mostraí** — só mudam variáveis se a URL do Checkout mudar. Deploy
   normal (seção 3). Não há migration.
4. **Prova** — uma assinatura real de valor mínimo, de ponta a ponta:
   `POST /assinar` → link → pagamento → webhook `criada` → conta ativa
   (`assinaturas.status='ativa'`, cobrança, ciclo) → `GET
   /admin/eventos-pendentes` vazio → cancelamento pelo painel → `cancelada`.
   Depois, `npm run conciliar` à mão e conferir que não gerou pendência.
5. **Reverter** — voltar `ASAAS_AMBIENTE=sandbox` no Checkout; o Mostraí
   não precisa de deploy. O que foi cobrado de verdade fica registrado.

## 4. Reverter

Duas formas, da mais rápida para a mais completa.

**a) Redeploy de um build anterior** — Northflank → serviço `mostrai` →
Deployments → escolher um build verde anterior → Deploy. É o caminho quando o
código novo quebrou e o banco não mudou. Leva o tempo de um deploy.

**b) Reverter o commit e deixar o CD subir:**

```bash
git revert <sha>        # nunca reescrever histórico da main
git push origin main
```

**Reverter para antes da migration 083 (Player V2 — histórico; depois da 094 vale o parágrafo seguinte):** o código antigo
autentica as TVs pela chave V1 em texto (`dispositivos.aparelho_id`), que a
083 manteve de propósito. Toda tela cuja credencial mudou depois do deploy
(provisionada, revogada, link novo do player web) teve essa coluna apagada:
depois do revert, gere o link de novo para cada uma pelo admin antigo. Players
V2 não funcionam no código antigo (as rotas V2 dão 404 e o app volta ao modo
V1, sem credencial válida). Depois da migration 084 (que apaga a coluna de
todas), reverter para antes da 083 exige gerar o link de todas as TVs V1.

**Reverter para antes do Player MVP (migrations 092–094, 26/09/2026):** a
094 é destrutiva (apaga `player_releases` e 34 colunas de `dispositivos`: V1,
horário/PIN por tela, rotação, OTA, `/hello`, rotação de credencial). O código
anterior lê essas colunas e não sobe contra o banco novo. Reverter o código
exige restaurar o backup tirado antes do deploy da 094 (seção 5):
`/backups/mostrai-20260926-031630.sql.gz` (volume do job `backup`, 66.279
bytes, sha256 terminando em `d09a`, conferido: gzip íntegro, dump completo,
91 migrations). As TVs instaladas depois dele precisam ser reinstaladas.
Produção tinha 0 telas no deploy (#71 com 092/093 às 03:12 UTC, #72 com a
094 às 03:22 UTC).

**Migration não se reverte por redeploy.** As migrations são aditivas
(`CONSTRAINTS.md`), então voltar o código sem voltar o banco costuma
funcionar: a coluna nova fica lá, sem uso. Se a migration foi destrutiva — o
que só acontece com permissão nominal do dono —, o caminho é restaurar o
backup da seção 5, não reverter.

**[Estação 6]** Falta cronometrar: quanto tempo leva um revert completo, do
`git revert` ao `/health` respondendo pela versão antiga.

---

## 5. Restaurar backup

O job `Backup` roda aos domingos e grava dumps gzipados no volume montado em
`/backups`, guardando os 26 mais recentes (meio ano).

**Listar e baixar um dump:**

```bash
northflank exec job --projectId mostrai --jobId backup -- ls -lt /backups
northflank download job file --projectId mostrai --jobId backup --file /backups/<arquivo>
```

**Restaurar:**

```bash
gunzip -c mostrai-AAAAMMDD-HHMMSS.sql.gz | psql "$DATABASE_URL"
```

**Restaurar num banco limpo antes de restaurar no de verdade.** Restauração
por cima de banco com dado é a operação que transforma um incidente em dois.

**Ensaio de restauração — 25/09/2026 (feito, em banco isolado; produção
não foi tocada).**

| Etapa | Resultado | Tempo |
|---|---|---|
| Listar o volume (execução do job `backup` só com `ls` + `sleep`, sem dump novo) | 2 arquivos: `mostrai-20260920-080036.sql.gz` (**20 bytes, dump vazio** — ver abaixo) e `mostrai-20260920-164029.sql.gz` (47 KB) | ~40 s até o contêiner aceitar `exec` |
| Baixar o dump bom (`northflank download job file`) | íntegro (`gzip -t`) | 8 s |
| Restaurar num banco novo e vazio (Postgres local, `psql`) | esquema `public` inteiro (36 tabelas); contagem de linhas igual à do dump em todas as tabelas conferidas; 4 erros, todos fora do app: `transaction_timeout` (parâmetro só do PG17) e a extensão `supabase_vault` (cofre interno do Supabase) | 0,7 s |
| Migrations novas por cima (`node src/db/migrate.js`) | 25 aplicadas (065 → 090), sem erro | 0,3 s |
| App contra o banco restaurado | `/health` → `ok:true`, `/planos` com os 12 planos, login inválido → 401 | 0,6 s |

- **RTO medido (técnico):** ~1 min do "achar o arquivo" ao app respondendo,
  com o banco de destino já existindo. Numa restauração de verdade, somar o
  tempo de criar o projeto novo no Supabase, trocar a `DATABASE_URL` no
  serviço e nos três jobs (§2) e o deploy — estimativa de 30–60 min.
- **RPO:** o backup é semanal (domingo 08:00 UTC). Perda máxima esperada: 7
  dias. **No dia do ensaio o último backup válido tinha 4 dias e 13 h** (20/09
  16:40 UTC); o de 20/09 08:00 falhou.
- **Achado 1 — backup vazio com cara de backup.** Em 20/09 08:00 o `pg_dump`
  falhou (senha do banco trocada, `docs/erros/2026-09-20-…`), o job saiu com
  erro, mas o `.sql.gz` vazio ficou no volume. Corrigido em
  `scripts/backup.sh`: o dump vai pra um arquivo `.parcial` e só vira backup
  se terminar com o marcador do `pg_dump`. **O arquivo vazio de 20/09 08:00
  continua no volume — não restaurar a partir dele.**
- **Achado 2 — restaurar no Supabase, não num Postgres comum.** O dump traz
  os esquemas internos do Supabase (`auth`, `storage`, `vault`…). Num
  Postgres comum só o `public` volta (é o que o app usa); num projeto
  Supabase novo, volta tudo.
- O dump baixado e o banco de ensaio foram apagados no fim (dado pessoal).

### 5.1 Reset final dos dados de teste — 25/09/2026

**RESET FINAL DE DADOS DE TESTE EXECUTADO**, autorizado pelo dono, pra
deixar o banco no estado de lançamento. Commit da transação:
`2026-09-25T21:00:40Z`. SHA em produção no momento: `aa94fc3`.

**Backup pré-reset** (job `Backup` disparado à mão; é o arquivo a usar se
precisar voltar — NÃO o vazio de 20/09 08:00):
`/backups/mostrai-20260925-205316.sql.gz` — 73.990 bytes, sha256
`805a18b5a23fd657d38fccdf2b589379803c37b374f5771bd393eab74ec81249`,
`gzip -t` ok, termina com o marcador do `pg_dump`, 49 tabelas `public`.

**Como foi feito:** inventário do esquema e das 66 FKs; conferência de que
nenhum dado era de cliente real (5 contas: 4 de teste do dono + a conta
interna do Mostraí; 3 candidaturas, 5 mensagens de contato e 1 repasse
manual, todos de teste; 0 assinatura, 0 cobrança, 0 webhook); uma
transação só, filhos antes dos pais, com guarda que dava `ROLLBACK` se
aparecesse qualquer conta/candidatura/mensagem/dado financeiro fora do
inventário. Sem `TRUNCATE`, sem `CASCADE` às cegas, sem mexer em
constraint. Sequences **não** foram reiniciadas (o próximo id segue o
último; os arquivos do Storage têm o id no nome e os antigos foram
apagados, então não há colisão). Storage limpo pela API do Supabase, não
por SQL.

| Entidade | Antes | Removidos | Depois |
|---|---|---|---|
| contas (`anunciantes`) | 5 | 4 | 1 (conta interna do Mostraí) |
| candidaturas / convites / cupons de ponto | 3 / 2 / 2 | 3 / 2 / 2 | 0 / 0 / 0 |
| pontos / telas (`dispositivos`) / eventos de tela | 5 / 5 / 6 | 5 / 5 / 6 | 0 / 0 / 0 |
| criativos / mídia própria (+ pontos) | 3 / 1 (+1) | 3 / 1 (+1) | 0 / 0 |
| playlist congelada / contadores de exibição | 5 / 2 | 5 / 2 | 0 / 0 |
| vínculo conta↔ponto / repasse manual | 2 / 1 | 2 / 1 | 0 / 0 |
| ledger de créditos / planos administrativos | 4 / 4 | 4 / 4 | 0 / 0 |
| eventos (analytics) / notificações | 29 / 6 | 29 / 6 | 0 / 0 |
| mensagens de contato / conciliações | 5 / 10 | 5 / 10 | 0 / 0 |
| sessões / tentativas de acesso / token de senha | 9 / 22 / 1 | 9 / 22 / 1 | 0 / 0 / 0 |
| assinaturas, cobranças, ciclos, banco de horas, comissões, webhooks | 0 | 0 | 0 |
| **Total** | | **132** | |
| planos / benefícios / planos×benefícios / modalidades de ponto | 18 / 16 / 36 / 2 | 0 | preservados |
| categorias / promoção (+itens) / custos fixos / `configuracoes_site` | 251 / 1 (+9) / 5 / 1 | 0 | preservados |
| `schema_migrations` | 88 | 0 | preservado |

**Storage (bucket `criativos`):** 11 → 2 arquivos. Removidos os 9 de teste
(3 vídeos + 3 thumbnails de criativo, 3 fotos de fachada de candidatura,
~5,8 MB). Ficaram só `institucional.mp4` e `institucional-thumb.jpg`.

**Verificado depois:** 0 linha órfã nas 66 FKs; 0 arquivo órfão no
Storage; `configuracoes_site` aponta pro vídeo institucional, vídeo e
thumbnail respondem `200`; 12 planos ativos (Essencial/Pro/Prime × 4
ciclos) na API pública; `/health` 200; páginas públicas, cadastro, login e
painel 200 (painel sem sessão → 401); `/admin` atrás do Access (302); 3
jobs ativos, `ApuracaoBancoHoras` com `0 6 1 * *`; sem erro nos logs.
Todas as sessões foram derrubadas (efeito esperado).

**Não tocado:** banco do San Checkout, Asaas, Northflank, Cloudflare,
segredos, código, repositório do Player.

---

## 6. Alerta → o que significa → primeira ação

| Sinal | Significa | Primeira ação |
|---|---|---|
| `/health` não responde | container caiu ou não sobe | Northflank → Observe → logs. Erro no boot costuma ser variável faltando |
| Job `Conciliacao` falhou | alguma assinatura não conciliou (sai com código 1) | ler o log: ele nomeia a assinatura e o erro. Cliente pagante pode estar sem cobertura |
| Job `Backup` falhou | sem backup desta semana | conferir se o volume `/backups` está montado e se o `pg_dump` alcança o banco |
| Job `ApuracaoBancoHoras` falhou | o déficit do mês anterior não entrou no banco de horas — essa dívida não volta em exibição até o job rodar | ler o log e o código de saída (1 falhou, 2 argumento, 3 já em execução — `docs/job-apuracao-banco-horas.md`); rodar de novo é seguro (idempotente) |
| Webhook do Checkout dando 401 | assinatura HMAC não fecha | a `SAN_CHECKOUT_KEY` dos dois lados divergiu. Comparar com o painel do Checkout |
| Fila `eventos_assinatura_pendentes` crescendo | eventos chegando e não sendo aplicados | admin → a fila mostra o motivo de cada um |
| Migration abortou o deploy | SQL falhou no banco real | o container antigo segue no ar. Corrigir com migration nova, nunca editando a aplicada |

**[Estação 6]** Faltam: alerta externo de "caiu" que chega ao celular, monitor
que avisa quando o job **não rodou**, e alerta de orçamento em cada conta paga.

---

## 6.1 Telas e Player (MVP)

Tudo pelo admin: **Rede → o ponto → M-0235** (o ID da tela). Contrato do
Player: `docs/player-mvp-contract.md`. Nenhuma chave aparece em tela, JSON ou
log.

| Situação | O que fazer |
|---|---|
| Antes da primeira TV | Rede → **PIN de saída do Player** → **Definir PIN** (4 a 8 dígitos; não aceita repetido nem sequência). É o mesmo PIN em todas as TVs e só serve para sair do modo quiosque na própria TV. Sem PIN o admin não gera código de instalação |
| Instalar uma TV nova | Rede → ponto → **+ Adicionar tela** → na ficha, **Gerar código** → passar ao técnico o **ID da tela** (`M-0235`) e o **código** (`XXXX-XXXX`) — **Copiar** leva os dois. O código vale 30 min e uma vez só; gerar outro cancela o anterior; 5 erros para a tela cancelam o código. A ficha passa sozinha para "Player conectado" e "Operando" |
| Reinstalar (TV trocada, app reinstalado, chave suspeita) | Ficha → **Revogar Player** (a TV antiga para na hora, com 401) → **Gerar código** → instalar de novo. Não existe rotação de chave |
| Tela "Sem sinal" | só é alerta dentro do horário do ponto, e depois de 2 min sem heartbeat (a TV bate a cada 15 s). Suporte mostra o último erro, se houver. Primeira ação no local: energia e rede |
| Config "pendente" há mais de 15 min | a TV não está aplicando a área segura/horário/PIN novos: conferir se está ligada e com rede; o Player aplica no próximo heartbeat |
| Fila de comprovantes alta (≥ 2.000 ou > 48 h) | a TV está tocando sem conseguir enviar `played`: rede instável ou erro no servidor; ver logs de `/player/:id/played`. O servidor aceita comprovante até 7 dias depois da hora |
| Horário do ponto | Ficha do ponto → **Editar horário** (por dia: Horário, 24 horas ou Fechado; "Aberto 24 horas todos os dias"). Vale para todas as telas do ponto; as TVs recebem em até 15 s |
| Excluir tela | Ficha ou linha da tela → **Excluir** → confirmar. Tela que já exibiu anúncio não é excluída (o comprovante é do anunciante): deixe **Inativa** |
| Versão nova do app | instalação manual na TV (não há atualização remota). A ficha mostra a versão que a TV informa |

## 7. Incidente com dado pessoal

O Mostraí guarda nome, CNPJ/CPF, e-mail, telefone e endereço de anunciantes,
donos de ponto e vendedores (`docs/inventario-de-dados.md`).

1. **Quem decide:** o dono. Nenhuma sessão de IA decide sozinha exposição de
   dado pessoal.
2. **Isolar:** revogar o que vazou (seção 2) antes de qualquer outra coisa.
   Segredo que vazou se revoga — apagar do histórico não basta, como 13/09/2026
   provou (`docs/erros/2026-09-13-env-real-em-repositorio-publico.md`).
3. **Contar afetados:** consulta no Postgres sobre a tabela `anunciantes`,
   recortada pelo que foi exposto.
4. **Quem escreve e os prazos da ANPD:** skill `legal` do plugin `san-co`,
   `references/obrigacoes-brasil.md`.
5. **Registrar:** um arquivo em `docs/erros/` no mesmo dia.

---

## 8. Dependências externas, e o que quebra se cada uma cair

| Se cair | O que para | O que continua |
|---|---|---|
| **Supabase (Postgres)** | tudo — login, painel, playlist, admin | nada |
| **Supabase (Storage)** | upload de criativo e a exibição do vídeo nas telas | o resto do sistema |
| **San Checkout** | assinar plano e conciliar | site, painel, playlist e telas seguem no ar |
| **Northflank** | a aplicação inteira | as telas continuam tocando a playlist em cache até o próximo ciclo |
| **Cloudflare** | o domínio, e o Access do `/admin` | — |
| **SMTP (Google)** | e-mail de confirmação e de redefinição de senha | o pagamento é creditado do mesmo jeito |

A playlist **não tem cache em memória do processo** desde 17/09/2026 (cada
poll recalcula, estabilizado por embaralhamento determinístico — ver
`.ia/DECISIONS.md`, ADR-004). Quem faz uma queda curta não interromper a
tela na hora é o **Player**: ele guarda a última playlist recebida e o
arquivo de cada criativo em cache local, e os comprovantes numa fila durável
(o servidor aceita até 7 dias depois da hora — `docs/player-mvp-contract.md`
§8).

---

## 9. Desligar tudo com segurança

Nesta ordem, para não deixar cobrança órfã nem tela mostrando anúncio de quem
parou de pagar:

1. Cancelar as assinaturas ativas pelo admin (chama o Checkout).
2. Pedir a quem administra o Checkout para arquivar o contratante `mostrai`.
3. Rodar `npm run backup` e **guardar o dump fora do Northflank**.
4. Pausar os jobs `Conciliacao`, `Backup` e `ApuracaoBancoHoras`.
5. Pausar o serviço `mostrai`.
6. Só então mexer no Supabase e no DNS.

Desligar o serviço antes do passo 1 deixa assinatura viva cobrando na Asaas
sem nada do outro lado para creditar.

---

## 10. Contatos

- **Dono:** Bruno Sanches — decide tudo que está na lista curta da skill `leis`.
- **[Estação 6] Pessoa número dois:** não existe ainda. É ela quem valida este
  documento: com o runbook e sem falar com quem construiu, faz um deploy
  trivial, reverte, e acha a data de vencimento do domínio. Onde travar, o
  runbook está incompleto.
