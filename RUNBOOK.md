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

O serviço tem **uma instância** e uma sonda de prontidão em `/health`
(readinessProbe, 10s de espera inicial). Com uma instância só, a troca ainda
deixa uma janela de poucos segundos em que o domínio responde 503 — foi medido.
Se um dia isso incomodar, a saída é subir para duas instâncias; é decisão de
custo, não de código.

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
| **Northflank** | serviço web `mostrai` e os dois jobs, no projeto `MostrAi` do time `san-co`, região South America East | app.northflank.com | `nf-compute-50`, ~US$12/mês + volume 6 GB (~US$0,90) |
| **Supabase** | Postgres 17 e o Storage (`criativos`), projeto `MostrAi`, região sa-east-1 | supabase.com/dashboard | **Free** — sem backup automático (exceção da Lei 6, `CONSTRAINTS.md`) |
| **Cloudflare** | DNS de `sancocore.com.br` e o Access na frente de `/admin` | dash.cloudflare.com | gratuito |
| **San Checkout** | cobrança (estrutura da San & Co.) — o Mostraí é o contratante `mostrai` | painel admin do Checkout | — |
| **Google Workspace** | e-mail `mostrai@sancocore.com.br` (SMTP) e o Drive das notas | admin.google.com | — |

**[Estação 6]** Falta escrever: data de renovação do domínio, cartão que paga
cada conta, e onde vive o segundo fator de cada login.

---

## 2. Onde estão os segredos, e como rotacionar

Nenhum segredo mora no repositório. Eles vivem em **Northflank → serviço
`mostrai` → Environment**, e nos jobs `Conciliacao` e `Backup`.

| Segredo | Onde se gera um novo |
|---|---|
| Senha do Postgres | Supabase → Settings → Database → Reset database password |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Settings → API |
| `SESSION_SECRET` | `openssl rand -base64 48`. Trocar derruba todas as sessões — é o efeito desejado |
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

**[Estação 6] Este backup nunca foi restaurado.** Backup não restaurado é
backup hipotético (Lei 6). O ensaio, com data e resultado, entra aqui.

---

## 6. Alerta → o que significa → primeira ação

| Sinal | Significa | Primeira ação |
|---|---|---|
| `/health` não responde | container caiu ou não sobe | Northflank → Observe → logs. Erro no boot costuma ser variável faltando |
| Job `Conciliacao` falhou | alguma assinatura não conciliou (sai com código 1) | ler o log: ele nomeia a assinatura e o erro. Cliente pagante pode estar sem cobertura |
| Job `Backup` falhou | sem backup desta semana | conferir se o volume `/backups` está montado e se o `pg_dump` alcança o banco |
| Webhook do Checkout dando 401 | assinatura HMAC não fecha | a `SAN_CHECKOUT_KEY` dos dois lados divergiu. Comparar com o painel do Checkout |
| Fila `eventos_assinatura_pendentes` crescendo | eventos chegando e não sendo aplicados | admin → a fila mostra o motivo de cada um |
| Migration abortou o deploy | SQL falhou no banco real | o container antigo segue no ar. Corrigir com migration nova, nunca editando a aplicada |

**[Estação 6]** Faltam: alerta externo de "caiu" que chega ao celular, monitor
que avisa quando o job **não rodou**, e alerta de orçamento em cada conta paga.

---

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

A playlist tem cache em memória do processo, então uma queda curta não
interrompe as telas na hora.

---

## 9. Desligar tudo com segurança

Nesta ordem, para não deixar cobrança órfã nem tela mostrando anúncio de quem
parou de pagar:

1. Cancelar as assinaturas ativas pelo admin (chama o Checkout).
2. Pedir a quem administra o Checkout para arquivar o contratante `mostrai`.
3. Rodar `npm run backup` e **guardar o dump fora do Northflank**.
4. Pausar os jobs `Conciliacao` e `Backup`.
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
