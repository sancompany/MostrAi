# Mostraí — pendências (atualizado 15/09/2026, Estação 5 — Construção)

Projeto em `D:\SanCo\MostrAi`, espelhado em
`github.com/sancompany/MostrAi` (branch `main`), repositório **público** por
decisão do dono.

**Estações 1 a 4 fechadas.** Registro em `docs/specs/2026-09-12-mostrai.md` e
no `CLAUDE.md` ("Estado na esteira"). A esteira está na **Estação 5 —
Construção**, aberta em 14/09/2026, com a versão inicial no ar desde
15/09/2026 (`mostrai.sancocore.com.br`).

**Único bloqueio real agora: a seção F.** A Estação 5 não fecha até o dono
revisar o site em produção e apontar o que precisa de ajuste — é o passo
seguinte, e é o único que só ele faz.

## SÓ O DONO FAZ — fila da corrida de 14/09/2026

Ordenada pelo que desbloqueia mais. Cada item: o que fazer · onde · por quê ·
o que trava · quanto leva. **Itens 1 a 7 estão todos FEITOS** — ficam aqui
como evidência de fechado, não como pendência. O que ainda bloqueia a
esteira é só o item 8.

1. ~~Tornar o bucket `criativos` público.~~ — **FEITO** (dono confirmou em
   15/09/2026). Player já toca vídeo servido por `getPublicUrl`.
2. ~~Health check no serviço.~~ — **FEITO em 15/09/2026**: Northflank →
   `mostrai` → Health checks, tipo Readiness Probe, path `/health`, porta
   3000.
3. ~~Confirmar o build e o primeiro deploy verde.~~ — **FEITO**:
   `mostrai.sancocore.com.br/health` responde `{"ok":true}` desde 15/09/2026
   — é a evidência que fechou "a versão inicial no ar" da Estação 5.
4. ~~Autorizar o Cloudflare: DNS e Access.~~ — **FEITO em 15/09/2026**: Access
   criado no path `/admin*` (e-mail do dono + qualquer `@sancocore.com.br`),
   e a origem fechada (`disableNfDomain` — o domínio `.code.run` de fallback
   do Northflank responde 404).
5. ~~Rotacionar as credenciais (A.0.1).~~ — **FEITO** (dono confirmou em
   15/09/2026: todas as credenciais vazadas foram rotacionadas).
6. ~~Conferir a primeira execução do job `Backup`.~~ — **FEITO**: cron ativo
   (`0 8 * * 0`, domingos) e o de conciliação (`0 9 * * *`) com execução
   SUCCESS. A Visão geral do admin mostra a última conciliação.
7. ~~Decidir as quatro perguntas de produto que sobraram.~~ — **RESPONDIDO em
   15/09/2026.** Vaga seguindo por 7 dias → **15 minutos** (construído).
   Comissão sobre renovação → **mantém**. Precedência entre `preco_travado` e
   desconto de comodato → não precisava decidir: o desconto de comodato é
   campo do PLANO (contrato, como o próprio preço), então já não muda pra
   quem assinou — a trava antiga ficou redundante desde o item 9. Plano
   desativado no site → **some**, como já era. Detalhe em `docs/funcional.md`
   (RN-14, RN-32, RN-33) e na seção B abaixo.

8. **Revisar o site em produção e listar o que precisa de ajuste.**
   · `mostrai.sancocore.com.br` — o site inteiro, como cliente, como
     anunciante, como dono de ponto/vendedor, e o `/admin`.
   · A Estação 5 (Construção) só fecha no que o `docs/funcional.md` descreve
     E no nível que o dono aceita — e isso só o dono julga vendo o produto
     no ar, não lendo código.
   · **Trava:** a Estação 5 inteira. Nada da Estação 6 (Prontidão) abre com a
     5 aberta.
   · Sem prazo. A seção **F** abaixo é onde cada item que vier entra, um por
     um, e sai daqui corrigido e reverificado — é a rodada de depuração
     (skill `depurar`) que fecha a estação.

9. **Gerar uma senha de app nova do Gmail e trocar `SMTP_PASS` no
   Northflank.** *(Achado em 16/09/2026, não durante a navegação do site —
   nos logs de produção, ao investigar por que o e-mail de confirmação de
   pagamento não chegou.)*
   · **Causa raiz confirmada nos logs:** `535-5.7.8 Username and Password
     not accepted` — o Gmail está recusando a senha de app que está em
     `SMTP_PASS` hoje. O dono confirmou que não trocou essa variável; o
     Google é quem invalidou a senha (acontece sozinho — troca de senha da
     conta, reconfiguração de verificação em duas etapas, ou expiração por
     segurança). Não tem como "usar a mesma de novo": uma vez rejeitada, ela
     não volta a funcionar — precisa gerar uma senha de app **nova**.
   · **Onde:** `myaccount.google.com` → Segurança → Senhas de app (exige
     verificação em duas etapas ativada) → gerar nova → colar em `SMTP_PASS`
     no Northflank (projeto `mostrai`, variáveis de ambiente). Não precisa de
     deploy depois.
   · **Trava:** o e-mail de confirmação de pagamento e o de redefinição de
     senha — nenhum dos dois sai enquanto essa senha não for trocada. Não
     trava a cobrança nem a ativação da conta (RUNBOOK.md já documenta isso).
   · **Só o dono faz** — é a conta Google dele, ninguém mais tem acesso.

10. **Decidir se `pontos.horario_abertura`/`horario_fechamento` podem ser
    dropadas.** *(Achado em 16/09/2026, na varredura pedida pelo dono depois
    de várias funcionalidades saírem do sistema — "verifique se sobrou
    alguma coisa delas".)*
    · **Por que ficaram órfãs:** essas duas colunas só tinham UM consumidor —
      `horasAbertoPorDia()`, em `src/playlist/gerador.js`, que convertia a
      frequência "por dia" do plano pro horário real do ponto. Essa função
      foi removida na migration 037 (frequência virou "por hora", direta,
      sem conversão nenhuma — pedido do dono, 15/09/2026). Ninguém mais lê
      essas duas colunas em lugar nenhum do código, e **não existe, nem
      nunca existiu, campo no admin pra preenchê-las** — são graváveis só
      por chamada direta à API, que nenhuma tela faz.
    · **Não é urgente nem some nada visível** — hoje elas só ocupam espaço,
      não confundem ninguém porque não aparecem em tela nenhuma.
    · Como é DROP de coluna, segue a regra do projeto: só com autorização
      explícita do dono, numa migration própria (não fiz sozinho).

11. **Configurar o San Checkout para aceitar pedido avulso deste projeto.**
    *(Achado em 16/09/2026, construindo a troca de plano — item 15 da seção F
    abaixo. O próprio dono disse que ia resolver: "configurarei o checkout a
    aceitar esses dois".)*
    · O Mostraí já expõe `GET /pedido/:id` e processa o webhook de pedido
      avulso (payload sem `tipo`, seção 4.3.3 do `API.md` do Checkout) — o
      código está pronto e no ar desde a migration 041.
    · **O que falta é do lado de quem administra o San Checkout:** confirmar
      que o `contratante_id` deste projeto está habilitado pra pedido avulso
      (não só assinatura), e que o `webhook_url` cadastrado é o mesmo que já
      recebe os eventos de assinatura (`POST /webhook/san-checkout`) — o
      contrato diz que os dois tipos chegam no mesmo endereço.
    · **Trava:** sem isso, `POST /anunciantes/me/trocar-plano` gera o pedido
      e o link de pagamento, mas o Checkout pode recusar a tela ou nunca
      confirmar o pagamento de volta — a troca de plano fica sem efeito
      prático até essa configuração existir.
    · **Só o dono faz** — é configuração do lado do San Checkout, fora do
      repositório do Mostraí.

O primeiro commit levou o `.env` **real** para o repositório, que é **público**.
Detalhes e causa em `docs/erros/2026-09-13-env-real-em-repositorio-publico.md`.

**Feito em 13/09/2026:** `.gitignore` corrigido, `.env` e `node_modules/` fora
do versionamento, **histórico reescrito** (`filter-branch`) e force-push em
`main` e na branch — nenhum commit alcançável contém mais os arquivos.

**Rastro público apagado (13/09/2026).** A reescrita sozinha não bastou: o
GitHub continuava servindo os commits antigos por SHA direto, porque force-push
não dispara a coleta de lixo do lado deles. O repositório foi então **apagado e
recriado** do zero, já com o histórico limpo. Verificado: a URL do commit antigo
responde 404, e um clone novo não tem `.env` em commit nenhum.

**Decisão do dono (13/09/2026):** o repositório **continua público** (a
organização usa vários recursos que só são gratuitos assim), e a rotação das
credenciais fica para quando ele estiver no PC. Enquanto ela não for feita, os
valores antigos continuam válidos em qualquer cópia feita antes da reescrita.

### A.0.0 — RESOLVIDA em 15/09/2026 — o domínio agora serve a aplicação

**Fechada.** O dono apontou `mostrai.sancocore.com.br` para o serviço do Node.
Conferido com `curl` na mesma hora: `GET /health` devolve `{"ok":true}`,
`GET /planos` devolve os 12 planos em JSON e `GET /pontos/fluxo` responde.
A vitrine voltou a montar sozinha.

Ficou um efeito colateral da troca, já corrigido no código: o host estático
antigo servia `/planos` como se fosse `/planos.html`, então buscador, histórico
e link compartilhado daquele período apontam para o endereço sem extensão — e
no Express `/planos` e `/pontos` são rotas de API, que devolviam JSON cru na
cara de quem clicava. O servidor agora redireciona 301 para a página quando
quem pede é uma navegação de documento, e continua entregando JSON para o
`fetch` do site.

O registro abaixo fica como está, para a próxima vez que algo parecer "bug de
código" e for endereço.

<details><summary>O que era (15/09, antes do apontamento)</summary>

`mostrai.sancocore.com.br` serve **só a pasta `public/`, como site estático**.
O Node/Express não está atrás do domínio. Provas, colhidas com `curl`:

| Caminho | Esperado (app no ar) | O que responde hoje |
|---|---|---|
| `GET /health` | 200 `{"ok":true}` | **404 HTML** |
| `GET /pontos/fluxo` | 200 JSON | **404 HTML** |
| `GET /planos` | 200 JSON com os 12 planos | **200 com o HTML de `planos.html`** |
| `GET /obrigado.html` | 200 | **308** para `/obrigado` (rota sem extensão, típica de host estático) |

O cabeçalho `content-security-policy`, que o `src/server.js` manda em toda
resposta desde 14/09, **não vem em nenhuma**. Nenhuma resposta passa pelo
Express.

**Consequência:** a página de planos aparece vazia — `fetch('/planos')` recebe
HTML, `.json()` estoura e a vitrine fica sem card nenhum. E não é só ela:
cadastro, login, painel, admin, player e webhook do Checkout estão todos fora
do ar pelo mesmo motivo. **Os 12 planos existem; ninguém consegue buscá-los.**

**O que NÃO é:** não é bug de código, não é seed faltando, não é CORS. O deploy
estático está inclusive em dia — a página `/obrigado` criada em 15/09 já está
lá, junto com o menu de celular novo.

**O que fazer (só o dono):** apontar o domínio para o serviço do Node no
Northflank — como origem do Cloudflare ou por DNS direto. Depois disso,
conferir `GET /health` devolvendo `{"ok":true}` e `GET /planos` devolvendo
JSON. Enquanto isso não acontecer, nenhuma correção deste repositório muda o
que o cliente vê.

</details>

## A.0.1 — Na volta ao PC, NESTA ordem (nada aqui roda sem o PC)

**Faça o passo 1 antes de qualquer `git push` da sua máquina.** A pasta
`D:\SanCo\MostrAi` ainda tem o histórico antigo, com o `.env` dentro. Um push de
lá republica tudo e desfaz a limpeza inteira.

1. [ ] **Alinhar a pasta local ao repositório novo.** Na pasta do projeto:

   ```
   git remote set-url origin https://github.com/sancompany/MostrAi.git
   git fetch origin
   git checkout main
   git reset --hard origin/main
   git branch -D claude/epic-newton-sc30uz
   git reflog expire --expire=now --all
   git gc --prune=now
   ```

   O seu `.env` continua na pasta, intacto — ele passa a ser ignorado, não
   apagado. Confira no fim: `git log --all --oneline -- .env` tem que vir vazio.

2. [ ] **Rotacionar a senha do Postgres do Supabase**: Supabase → Settings →
   Database → Reset database password.
3. [ ] **Gerar `SESSION_SECRET` novo** e **trocar `ADMIN_PASSWORD`** (e o
   `ADMIN_USER`, se quiser). Trocar o `SESSION_SECRET` derruba todas as sessões
   abertas — é o efeito desejado.
4. [ ] **Supabase → Settings → API**: rotacionar a `service_role key` por
   precaução, e olhar os Logs por acesso vindo de fora do seu IP desde
   13/09/2026.
5. [ ] **Atualizar o `.env` local** com tudo que foi rotacionado, e conferir
   `npm test` + `node src/server.js` subindo com as chaves novas.
6. [ ] **GitHub → Settings → Code security**: ligar Secret scanning e Push
   protection. Em repositório público é de graça, e é a rede de segurança que
   faltou aqui.
7. [ ] Marcar a data da rotação nesta seção e conferir
   `git ls-files | grep -E '^\.env'` → só pode aparecer `.env.example`.

Feito isso, as chaves novas vão para o painel do Northflank no passo A.9, e
**só as novas** — nenhuma das antigas volta a ser usada em lugar nenhum.

## A. Passo a passo pra sair do zero (faça na ordem)

> ## Estado da infraestrutura, conferido DENTRO dos painéis em 15/09/2026
>
> O dono deu acesso ao Cloudflare, ao Northflank e ao Supabase. O que dava pra
> fazer daqui foi feito; o que está bloqueado está nomeado, com o passo exato.
>
> **Feito por mim, com evidência:**
>
> - **Northflank — serviço no ar**, região `nf-southamerica-east`, uma
>   instância, build `SUCCESS`, deploy `COMPLETED`, seguindo `main`
>   automaticamente (o SHA no ar bate com o último commit).
> - **Banco estava NOVE migrations atrás do código** (021 no banco, 030 no
>   código que já servia clientes). As nove foram aplicadas na ordem e
>   registradas em `schema_migrations`; hoje são 31 de 31, lista idêntica à do
>   repositório. Causa: o Northflank não tem "release command" e não havia
>   nada configurado — agora o contêiner roda `node src/db/migrate.js` antes
>   de servir, com trava de aplicação no Postgres. Deploy conferido depois da
>   mudança: `/health` 200 e o site inteiro de pé.
> - **RLS ligada nas 27 tabelas.** O Supabase expõe uma API REST automática
>   sobre o `public` e os papéis `anon`/`authenticated` já vêm com SELECT em
>   tudo: sem RLS, qualquer um com a chave `anon` lia CPF, e-mail, telefone,
>   `senha_hash`, `tokens_senha` e a tabela de sessão. Medido depois:
>   `/rest/v1/anunciantes` com a chave anon devolve `[]`.
> - **Cloudflare: o proxy foi LIGADO** em `mostrai.sancocore.com.br` (estava
>   em "DNS only", sem WAF e sem caminho possível pro Access). Site conferido
>   logo depois: `server: cloudflare` nas respostas, CSP chegando inteira,
>   páginas e API em 200.
> - **Teto de upload caiu pra 95 MB** por causa do proxy: o plano Free do
>   Cloudflare corta corpo acima de 100 MB antes de chegar no nosso servidor.
> - **Fim a fim em produção, de verdade:** criei uma conta de teste pelo site,
>   entrei, li `/anunciantes/me`, `exibicoes` e `criativos` — tudo 200 — e
>   apaguei a conta em seguida (base voltou a zero). Era exatamente esse
>   caminho que estava quebrado antes das migrations.
> - **Os dois crons existem e estão ativos**: conciliação `0 9 * * *` (06h de
>   Brasília, uma execução com SUCCESS) e backup `0 8 * * 0` (domingos; ainda
>   não rodou porque foi criado na segunda).
> - **`SAN_CHECKOUT_API_URL` já está no serviço**, junto com as outras 23
>   variáveis. A API do Checkout responde em `api.sancocore.com.br` (404 com
>   JSON na raiz, que é resposta de aplicação viva).
> - **San Checkout** (o outro projeto): serviço no ar, build `SUCCESS`, site
>   em 200, e as 6 tabelas dele já estavam com RLS ligada.
>
> **Bloqueado pra mim — precisa de você, e é rápido:**
>
> 1. **Bucket `criativos` ainda é privado.** É o que impede o vídeo de tocar
>    na TV: o player lê a URL pública do arquivo. Supabase → Storage →
>    `criativos` → Settings → *Public bucket*. Minha permissão barra "tornar
>    algo público" sozinho, e faz sentido que barre.
> 2. **Access na frente do `/admin`.** Agora é possível (o proxy está
>    ligado). Cloudflare → Zero Trust → Access → Applications → Add →
>    Self-hosted, domínio `mostrai.sancocore.com.br`, path `/admin`, política
>    igual à que já existe no Checkout: permitir `brunosanches.bhs@gmail.com`
>    **ou** qualquer e-mail `@sancocore.com.br`. A criação por API foi barrada
>    pra mim.
> 3. **Fechar a origem** (só o Cloudflare alcançar o Northflank) — depende do
>    item 2 estar de pé primeiro.

1. [x] **`git init` + primeiro commit** — FEITO em 13/09/2026. O `.env` real
   entrou junto (o `.gitignore` não cobria `.env.*`, ao contrário do que esta
   linha afirmava); o histórico foi reescrito e o repositório apagado e
   recriado no mesmo dia. O repositório é público de propósito. O que sobrou
   está na seção A.0 acima — inclusive alinhar a pasta do PC, que ainda tem o
   histórico antigo.
2. [x] **Mover os workflows** — FEITO em 13/09/2026. `ci.yml` e
   `seguranca-semanal.yml` estão em `.github/workflows/` e `infra/github/` foi
   removido. O `ci` roda em push e PR na `main`: sintaxe, migrations num
   Postgres limpo, testes unitários, e uma checagem que **falha se um `.env`
   for versionado** — a guarda que faltava.
3. [ ] **`npm install`** (entrou `connect-pg-simple`).
4. [ ] **`.env` local**: use `.env.example` como guia. **Atenção:** o `.env` que
   está na pasta (o que vazou) NÃO é o de teste que esta linha supunha — ele
   aponta para o projeto real do Supabase, e não existe `.env.real.bak` nem
   `.env.teste` na pasta. Trate-o como real e rotacione (A.0). Variáveis novas
   a conferir: `SITE_URL`, `PROGRAMA_FUNDADOR_ATIVO=false`,
   `MOSTRAI_EMAIL_FROM`/`MOSTRAI_EMAIL_CONTATO` (o antigo `VITRINA_EMAIL_FROM`
   ainda funciona).
5. [ ] **`npm run migrate`** — aplica as 20 migrations em ordem, até a 021 (que remove a máquina de cobertura adiada, com autorização do dono).
6. [x] **`npm test`** (27 unitários) e as **5 suítes e2e** — FEITO em 14/09/2026, primeira rodada desde a migration 021: 27/27 unitários, e 01/02/03/04/05 com zero falhas num Postgres limpo, seguindo a ordem do `tests/e2e/README.md` (as suítes não são idempotentes: sem `reset-db.sh` + `restart.sh` entre elas, sobra dado e o limitador de tentativas em memória derruba asserções).
7. [ ] **Suba local (`npm run dev`) e faça a malha fina** — roteiro na seção C.
8. [ ] **Supabase**: projeto próprio do Mostraí (se ainda for o da Vitrina, renomeie), região **sul-americana**. Bucket `criativos`. Anote `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
9. [ ] **Northflank** (não Render): serviço Node a partir da branch `main`, região sul-americana (mesma do Supabase), variáveis do `.env.example` no painel do serviço, `npm run migrate` como comando de release (ou rode uma vez à mão), `npm start`. `/health` responde `{ok:true}`. **Use só as chaves rotacionadas em A.0.1** — nenhuma das antigas. As variáveis vivem no painel do Northflank; nunca num arquivo do repositório.
10. [ ] **Cloudflare**: DNS `mostrai.sancocore.com.br` → Northflank (proxy ligado). **Access na frente de `/admin`** (Zero Trust → Access → Application, path `/admin*`, política: seu e-mail). Fechar a origem pra que só o Cloudflare alcance o serviço.
11. [ ] **San Checkout**: cadastrar o Mostraí como contratante (URL da API, chave, walletId — manual, no banco do Checkout), **Não existe `SAN_CHECKOUT_WEBHOOK_SECRET` pra combinar** — o webhook é assinado com a própria chave do contratante (corrigido em 14/09/2026, `docs/erros/2026-09-14-webhook-autenticado-por-header-inventado.md`). Auditar a última estação do Checkout (você disse que falta). ~~Confirmar se o webhook manda `eventoId`/`cobrancaId`~~ — **RESPONDIDO em
    14/09/2026, lendo o `API.md` do Checkout (commit `63495d2`): não manda.** O
    payload de assinatura tem cinco campos e nenhum id (seção 4.3.4). A dedupe
    passou a buscar o `chargeId` na rota de conciliação 5.3, e a conciliação
    diária virou `npm run conciliar` — **precisa de um cron job no Northflank**,
    junto com o do backup (A.12). Combinar também o `SAN_CHECKOUT_API_URL`
    (endereço da API, diferente do da tela — `API.md` 2.1).
    ~~As duas perguntas do mês grátis~~ — **PREJUDICADAS**: a migration 021
    removeu `meses_gratis` e a regra "benefício no preço, nunca no tempo" do
    `CONSTRAINTS.md` fechou o assunto. O `INTEGRACAO.md` do Checkout é só um
    redirecionamento hoje; a fonte é o `API.md`.
12. [ ] **Backup**: enquanto o Supabase for Free (sem backup automático), rode `npm run backup` semanalmente (precisa de `pg_dump` no PATH) ou crie um cron job no Northflank. Exceção registrada no `CONSTRAINTS.md`.
13. [ ] **TV Stick**: no admin → Telas → "Gerar chave" → copie o link → abra no navegador/kiosk da TV. Defina o PIN da tela. O link guarda a chave no aparelho; depois disso pode abrir só `/player.html?tela=ID`. Tela vertical é o padrão; `?orientacao=paisagem` desliga o giro. O app kiosk (Fully Kiosk ou similar) é quem trava a tela cheia — o player não promete isso.

## B. Decisões que só você toma (o código já suporta os dois lados)

- [x] **Validar o veredito da Fase 3 da spec** — FEITO em 14/09/2026. Veredito
  confirmado, agora sobre nove itens. Nada do que a aceleração construiu saiu: o
  painel único é a forma do item 2 e os módulos cruzados são o item 4, ambos
  escritos estreito demais na primeira redação. Detalhe em
  `docs/specs/2026-09-12-mostrai.md`, seção "Validação do dono (14/09/2026)".
- [x] **Programa fundador** — **REDESENHADO em 15/09/2026, a seu pedido**: não
  fazia mais sentido como plano de catálogo travado por variável de ambiente,
  porque o item 9 já trava o preço de QUALQUER plano assinado. Virou status de
  CONTA (`anunciantes.fundador`, migration 033): você marca à mão em
  Anunciantes → "Marcar fundador", define o desconto percentual e o piso de
  compromisso (ex.: só trimestral pra cima). O plano seed `fundador-12m` foi
  desativado (migration 034) — não aparece mais em lugar nenhum. Depois do
  primeiro mês, é só parar de marcar contas novas; o que já foi marcado
  continua valendo. Ver RN-14 em `docs/funcional.md`.
- [ ] **Módulos cruzados**: decidir quais planos ganham "tela após N meses" (admin → Planos → coluna "Tela após") e quais opções de comodato ganham "anúncio grátis após N meses" (admin → Opções de comodato → Bônus). Estão desligados (vazios) até você preencher. Mapa completo dos tipos de benefício (os que mudam código e os que são só texto) em `docs/catalogo-beneficios.md`.
- [x] **Vaga de fundador** — **RESOLVIDO em 15/09/2026**: a vaga (mecanismo
  genérico, campo `vagas` de qualquer plano) agora solta sozinha em **15
  minutos** sem pagamento, não mais 7 dias.
- [x] **Troca de plano de quem já paga** — **CONFIRMADO em 15/09/2026**: fica
  como está (recusa e manda falar com você; caminho é cancelar no admin e
  assinar de novo).
- [x] **Comissão sobre renovação** — **CONFIRMADO em 15/09/2026**: mantém —
  o vendedor recebe a cada `cobranca_confirmada`, inclusive renovação. A
  comissão é por VENDEDOR (`vendedores.comissao_percentual`), não por plano,
  então troca de plano do indicado nunca muda a comissão dele.
- [x] **Drop do legado** — **AUTORIZADO e FEITO em 15/09/2026** ("manda
  bala"), migration 036: tabela `afiliados` (e `comissoes.afiliado_id`),
  `pontos.aparelho_id`/`ultima_vez_online`, `exibicoes_contador.ponto_id`.
  `exibicoes_contador.ponto_id` ainda era lido de verdade em duas rotas do
  painel do anunciante (extrato e CSV de exibições) e escrito a cada geração
  de playlist — reescritas pra resolver o ponto por `dispositivo_id` antes do
  drop, senão quebrava produção. `src/financeiro/afiliados-repository.js`
  apagado (zero `require` no código — as rotas `/afiliados/*` que respondem
  410 nunca dependeram dele). `public/nav-auth.js`, `public/afiliado/*` e
  `src/financeiro/san-checkout-1.js` não existem neste repositório (o último
  é a cópia que só existe na sua pasta local — nada a apagar aqui).
- [ ] **Custos fixos**: os seeds (DAS MEI 86,05; Contador 100; Domínio 3,33; Supabase Pro 0; Deslocamento 50) são chute meu — corrija no admin → Custos fixos. Amortização é por tela: preencha custo e prazo de cada TV na aba Telas.
- [ ] **Sessão única por navegador**: cadastrar uma conta no mesmo navegador em que o admin está logado derruba o admin (é o comportamento seguro). Use dois perfis/navegadores pra testar.

## B.1 Construir — decidido em 14/09/2026, ainda não feito

Nasceu do fecho da Estação 1. São os itens 8 e 9 da spec, e a ordem importa: o
9 é pré-requisito do 8 — e o 9 está feito.

1. [x] **Item 9 — plano imutável para quem já assinou.** FEITO em 14/09/2026,
   antes da primeira assinatura paga, que era a condição de entrada.
   `CAMPOS_ATUALIZAVEIS` virou dois grupos: vitrine (`ativo`, `vagas`,
   `rotulo`, `destaque_no_site`) salva no lugar; contrato (nome, valor,
   ciclo, frequência, cobertura, limite de criativos, preço travado, fundador,
   tela-após, benefícios) só entra por `POST /admin/planos/:id/nova-versao`,
   que cria a versão com id `-vN` e aposenta a anterior na mesma transação.
   Migration 026 traz `arquivado_em`, `substituido_por` e a trava de que
   aposentado nunca é ativo. Aba "Planos arquivados" mostra contas ativas e
   cobranças por versão. RN-27 em `docs/funcional.md`.
2. [x] **Item 8 — desconto de comodato sobre os planos de anunciante.** FEITO
   em 15/09/2026. `planos.desconto_comodato_percentual` (migration 033) é
   campo de CONTRATO — como o próprio `valor_mensal`, só muda por versão nova
   — então a pergunta de precedência com `preco_travado` não existia de
   verdade: o travado guarda o preço DO PLANO, e o desconto (comodato e/ou
   fundador) é somado por cima, lido ao vivo a cada cobrança em
   `valorMensalDaConta` (`src/financeiro/san-checkout.js`). Você define o
   valor por linha da grade no admin → Planos, coluna "Desconto comodato".
   Vale pra qualquer conta com o papel `ponto`, em qualquer plano que tenha o
   desconto preenchido.

3. [x] **Ligar/desligar plano: pergunta respondida em 15/09/2026 — some.**
   *(pedido em 14/09/2026.)* O toggle **já existe** — coluna "Ativo" da
   tabela de planos, e `ativo` já está em `CAMPOS_ATUALIZAVEIS`. A pergunta em
   aberto ("o plano desativado aparece apagado em `/planos.html`, ou some da
   vitrine?") o dono respondeu: **some**, sem badge "Desativado" — que é o que
   `GET /planos` já fazia (`WHERE p.ativo`), confirmado empiricamente em
   15/09/2026. Nenhuma mudança de código foi necessária. O acabamento no admin
   (aviso antes de virar a chave, linha "apagada" na tabela do admin — não do
   site) não foi pedido de novo e continua opcional.

   *Foi por aqui que o item 1 saiu:* `ativo=false` era mesmo a alavanca — "a
   linha antiga sai da vitrine e continua servindo quem está nela". O que
   faltava era impedir a edição no lugar e registrar a linhagem, que é o que a
   migration 026 e a rota de nova versão fazem. O aviso visual pedido aqui
   continua de pé: a confirmação antes de publicar versão nova já existe, a
   linha apagada com "Desativado" não.

4. [x] **`tests/e2e/02` reescrito pro mundo pós-021** — FEITO em 14/09/2026.
   Assina o webhook como o Checkout assina (HMAC), afirma que a 1ª cobrança
   (`criada`) ativa a conta na hora, que a renovação (`cobranca_confirmada`)
   estende a cobertura, e que evento sem ação vira pendência sem derrubar
   ninguém. As asserções de `aguardando_ponto`, mês grátis e mínimo de telas
   saíram.
5. [x] **Resumos de contrato órfãos apagados** — FEITO em 14/09/2026.
   `claude/vitrina-san-checkout-requisitos.md` (causa provada de quatro
   defeitos no caminho do dinheiro), `SPEC.md` e `Claude outputs/SPEC.md`. As
   fontes válidas são o `API.md` do Checkout e `docs/specs/2026-09-12-mostrai.md`.

## E5. Estação 5 — o mapa da construção, item a item

Auditoria de 14/09/2026 contra as três listas da skill `construir`:
`desenvolvimento-web.md` (14 itens), `tipo-saas.md` (12) e
`tipo-institucional.md` (11). O Mostraí é dos dois tipos: site público que
converte, e app com conta, painel e assinatura.

Legenda: ✅ existe com evidência · ⚠️ existe pela metade · ❌ não existe.

### Referência-mãe — o que todo site tem

| # | Item | Estado | O que falta |
|---|---|---|---|
| 1 | Mapa de páginas antes de tela | ✅ | `docs/funcional.md` §3, 23 telas com URL |
| 2 | Design system de uma pessoa | ⚠️ | **cor fechada em 14/09**: 24 literais → 0 fora do `:root`. **Estilo inline fechado em 14/09**: 301 atributos `style=` → 0, viraram utilitários `u-*` em `style.css`; as barras de gráfico passaram a `data-pct` aplicado por CSSOM. Falta extrair componentes (`src/ui/`) |
| 3 | Tipografia web | ⚠️ | conferir se usa pilha do sistema e se o corpo é 1 rem em campo de formulário (zoom do Safari) |
| 4 | `<head>` completo | ✅ | **fechado em 14/09**: canonical, theme-color e manifest em 26 de 26; `og:image`/`og:url` absolutos; `site.webmanifest` criado |
| 5 | SEO técnico | ✅ | **fechado em 14/09**: `sitemap.xml` (11 URLs), `robots.txt` corrigido — ele bloqueava as páginas que levam `noindex`, então o Google nunca leria o `noindex` — e JSON-LD em 3 páginas: `Organization`+`WebSite` na home, `Service` nos planos, `ContactPage` no contato. Não é `LocalBusiness`: esse tipo pede endereço físico que o cliente visita, e a rede não tem loja |
| 6 | Páginas que ninguém desenha | ✅ | **fechado em 14/09**: 404 e 500 criadas, servidas com o status certo e ramificando por `Accept` (tela pro navegador, JSON pro `fetch`). A 500 não depende da aplicação |
| 7 | Formato brasileiro | ✅ | **fechado em 14/09**: `src/br/documento.js` (módulo 11, CNPJ alfanumérico) e `src/br/formato.js` (Intl, fuso explícito, E.164), ligados no cadastro, com 8 testes |
| 8 | Imagens e mídia | ⚠️ | conferir `<picture>`, `srcset`, `width`/`height` e `fetchpriority` na imagem principal |
| 9 | Formulários | ⚠️ | `label for`, `autocomplete` e `inputmode` existem em 7-10 páginas. **Turnstile não existe** — formulário público sem anti-bot |
| 10 | Os seis estados de cada tela | ⚠️ | escritos no `docs/funcional.md` §4; falta conferir tela a tela com conta nova, rede lenta e 500 |
| 11 | E-mail transacional | ⚠️ | **não existe `src/emails/` com template base**. Só 3 e-mails: pagamento, redefinição e contato |
| 12 | Segurança de construção | ⚠️ | **CSP no ar em 14/09, sem `unsafe-inline` em nenhuma diretiva** — deu pra ser estrita porque os 301 `style=` viraram classes e os 16 `<script>` inline viraram arquivo `.page.js`; conferida no Chromium, 0 violações em 22 telas. `Permissions-Policy` junto. Falta justificar os 8 usos de `innerHTML` (todos passam por `esc()`) e ligar `report-uri` |
| 13 | Performance na construção | ❌ | sem orçamento no `CONSTRAINTS.md`; sem hash no nome dos assets |
| 14 | Ambiente e build | ⚠️ | **`.editorconfig`, `.nvmrc`, `engines` e `npm run check` criados em 14/09**, e o CI chama o mesmo comando. **Biome entrou em 14/09**: `npm run lint` limpo em 76 arquivos e dentro do `check`, então o CI barra. O formatador está configurado e ainda não passado — reescreveria 63 dos 76 arquivos, e a ordem certa está em `docs/lint.md` |

### Tipo SaaS — conta, painel, assinatura

| # | Item | Estado | O que falta |
|---|---|---|---|
| 1 | Conta de ponta a ponta | ⚠️ | cadastro, login, recuperação e exclusão existem. Faltam: confirmação de e-mail, troca de e-mail com link nos dois endereços, "mostrar senha" |
| 2 | Sessão | ⚠️ | sessão em Postgres, 7 dias. Falta "sair de todos os dispositivos" e o `<dialog>` de reautenticação que preserva o formulário |
| 3 | Primeira sessão | ⚠️ | os cards de ativação de `modos.js` fazem o papel. Falta o checklist de 3-5 passos |
| 4 | Navegação do painel | ✅ | três abas fixas com card de ativação |
| 5 | Tabelas e listas | ❌ | **sem filtro na URL, sem ordenação por coluna, sem paginação, sem exportar CSV**. Com 500 registros a tela não serve |
| 6 | Criar e editar | ⚠️ | falta o "desfazer" no lugar da confirmação |
| 7 | Papéis e convite | ✅ | três papéis, convite com token opaco e validade |
| 8 | Conta e cobrança | ⚠️ | o painel lista cobranças. **Falta a tela "Plano e cobrança"** com próximo vencimento, forma de pagamento, trocar plano e cancelar |
| 9 | Notificações | ❌ | **o criativo aprovado não avisa ninguém** — o anunciante não sabe que entrou no ar. Faltam também: conta aprovada, convite, cobrança recusada, e os de segurança |
| 10 | Painel do dono | ⚠️ | `/admin` existe. Falta o Cloudflare Access (fila do dono, item 4) |
| 11 | Trilha de auditoria | ❌ | **tabela `auditoria` não existe**. "Quem mudou o preço?" não tem resposta |
| 12 | Multi-inquilino / RLS | ⚠️ | autorização só na aplicação — exceção já registrada no `CONSTRAINTS.md` |

### Tipo institucional — a página que converte

| # | Item | Estado | O que falta |
|---|---|---|---|
| 1 | Anatomia da página que converte | ⚠️ | conferir a 360 px: o que é, para quem, um CTA, uma prova, sem rolar |
| 2 | Estrutura mínima de páginas | ✅ | home, planos, pontos, comodato, contato, termos, privacidade |
| 3 | Copy em F | ⚠️ | rodar o `grep` de jargão |
| 4 | Prova social honesta | ❌ | **`docs/provas.md` não existe**. Todo depoimento e número no site precisa de linha com data e autorização (CONAR, Anexo Q) |
| 5 | CTA, formulário e destino do lead | ⚠️ | `/contato` grava e manda e-mail. Falta a resposta automática ao remetente e o prazo escrito na tela |
| 6 | WhatsApp como canal | ✅ | `wa.me` no formato oficial, com mensagem pré-preenchida por página |
| 7 | SEO local | ❌ | **sem JSON-LD `LocalBusiness` nem `Organization`**; Google Business Profile é do dono |
| 8 | Rastreamento com consentimento | ⚠️ | não há GA4 nem pixel hoje — então não precisa de banner. Vale registrar a decisão. **Direitos do titular no ar em 14/09**: exportar dados, revogar consentimento e arrependimento em 7 dias com devolução, no bloco "Seus dados e seus direitos" do perfil (RN-24 a RN-26) |
| 9 | Hospedagem | ✅ | Northflank, não Pages. Item não se aplica na forma escrita |
| 10 | Desempenho de landing | ⚠️ | conferir imagem hero e terceiros antes da primeira interação |
| 11 | Manutenção pós-lançamento | ⚠️ | a lista do que envelhece entra no `RUNBOOK.md` |

### O que a referência de mercado mostrou que falta — **construído em 14/09**

> **Os quatro foram tratados.** O item 4 não existia como falta: o
> `ponto.html` já mostrava sinal e exibições por tela, e minha auditoria errou
> ao marcá-lo. Os outros três foram construídos e verificados contra servidor
> rodando. O registro do que cada um é está em `docs/funcional.md`
> (RN-18, RN-19, RN-20).

| # | O que era | Estado |
|---|---|---|
| 1 | Aviso de "seu anúncio está no ar" | ✅ e-mail na **transição** para aprovado; salvar de novo não reenvia |
| 2 | Extrato do ponto | ✅ migration 022, lançamento por mês, extrato no painel do ponto |
| 3 | Comprovante de veiculação | ✅ CSV por período (`;` + BOM), 403 para conta alheia |
| 4 | Estado da tela para quem cedeu a parede | ✅ **já existia** — auditoria errada |

### O diagnóstico original, para referência

Comparado com **AdQuick** e **Blip** (self-serve DOOH), **Aqui Ads** da
Eletromidia (o equivalente brasileiro, 76 mil telas para PME), **Trillboards**
(portal do dono da tela, que é o nosso "ponto") e **Yodeck/OptiSigns/ScreenCloud**
(gestão de tela e playlist):

1. **Aviso de "seu anúncio está no ar".** No AdQuick, aprovado o criativo, o
   anunciante é notificado. Aqui ele não é — a pessoa paga e fica sem saber
   quando entrou. É o item de notificação mais barato e o mais sentido.
2. **Extrato do ponto.** O Trillboards paga o dono da tela mensalmente e mostra
   o que ele ganhou. Aqui o ponto vê o valor do plano de comodato, mas **não
   existe registro do que foi pago a ele**, nem tela de extrato.
3. **Comprovante de veiculação por tela.** Yodeck e Trillboards chamam de
   *proof-of-play*. Temos `exibicoes_contador`, que é a matéria-prima; falta a
   tela que transforma isso em comprovante para o anunciante.
4. **Estado da tela visível para quem cedeu a parede.** O padrão do setor é o
   dono do ponto ver se a tela dele está no ar. Temos `heartbeat` e
   `pontos-offline` no admin — falta expor no painel do ponto.

Nada disso muda o escopo dos nove itens da spec: são acabamentos do que já foi
decidido. O que for construir vira fatia própria; o que ficar para depois vai
para `docs/proximas-versoes.md` com condição de entrada.

## B.4 — Pesquisa de preço médio do setor em São Paulo (pedida em 15/09/2026)

**Estado: FEITA em 15/09/2026 — `docs/pesquisa-preco-sp.md`.** Com uma
ressalva que vale mais que o resultado: **esse setor não publica preço**. Das
operadoras de mídia indoor que aparecem numa varredura, quase nenhuma tem
tabela pública — o padrão é "fale com um consultor". O que deu pra apurar com
fonte está lá, com grau de confiança item a item; o que não deu está escrito
como não achado, e com o caminho de meia hora pra fechar a lacuna (pedir
proposta como anunciante a três operadoras).

**O que a pesquisa concluiu, em três linhas:** estamos 20% a 34% abaixo do
único concorrente local em todas as faixas; o preço por exibição é idêntico nos
três planos (a grade é linear, sem desconto por volume); e o nosso CPM só fica
competitivo **a partir da quinta tela** — abaixo disso vendemos caro pra uma
rede pequena, que é exatamente o que gera pedido de devolução.

O texto original do pedido fica abaixo, porque as cinco perguntas continuam
sendo a régua: três delas a pesquisa respondeu, duas ficaram abertas por falta
de dado público.

**O que a pesquisa tem que responder**, restrita a **Brasil, estado de São
Paulo**, e a empresas **do mesmo porte da Mostraí** (rede local de mídia
indoor, não veículo nacional):

1. Preço médio cobrado **por faixa de plano** — entrada, intermediário e topo —
   em rede de tela/totem dentro de comércio.
2. **O que cada faixa inclui**: duração do spot, inserções por dia, número de
   pontos alcançados, número de criativos, relatório, produção de arte,
   exclusividade de segmento, prazo mínimo.
3. **Qual o piso e o teto** praticados no interior paulista, separados dos
   preços de capital — comparar tela de shopping em São Paulo com TV de padaria
   em Matão sem avisar é enganar a si mesmo.
4. **Benefício que é padrão de mercado** (todo mundo dá) versus **benefício que
   é diferencial** (poucos dão) nessa faixa de preço.
5. **Como cobram**: mensal, por ciclo com desconto, por inserção, por dia, por
   ponto, CPM.

**Por que importa:** a comparação com a Voltplace já está feita
(`docs/pesquisa-voltplace.md`), mas ela é **uma** empresa, de quatro meses, sem
cidade declarada. Uma decisão de preço não se toma contra um único concorrente.
O que a primeira varredura já achou e serve de ponto de partida está no mesmo
arquivo, seção "Onde nosso preço cai no mercado" — inclusive o achado de que a
Mostraí está **acima** do comparável direto por linha de plano e **abaixo** por
cobertura.

**Entrega esperada:** um arquivo `docs/pesquisa-preco-sp.md` com tabela por
empresa (nome, praça, formato, preço publicado, o que inclui, fonte, grau de
confiança) e uma recomendação de grade. Preço sem fonte não entra.

## C. Malha fina — roteiro do que testar junto comigo

1. Site público: `/`, `/planos.html`, `/seja-um-ponto.html` e `/seja-um-vendedor.html` (viram candidatura, não conta).
2. Admin → Candidaturas → "Gerar convite" (site) ou "Liberar na conta" (pedido do painel). Copiar link → abrir em outro navegador → `convite.html` → conta nasce com os papéis.
3. Painel único: abas Anúncios / Meu ponto / Vendas sempre visíveis; a bloqueada mostra o card de ativação. Anunciante ativa sozinho (endereço); ponto e vendedor viram pedido que você libera.
4. Admin → Telas: gerar chave, PIN, custo/prazo; player na TV; painel da tela por PIN (5 toques no canto superior direito ou tecla P).
5. Assinar plano → checkout (precisa do Checkout configurado) → webhook `criada` (1ª cobrança) → conta ativa na hora.
6. Vendedor: cupom, link `cadastro.html?ref=CUPOM`, comissão aparece em Vendas e em admin → Comissões.
7. Bônus: plano com "tela após N meses" mostra progresso em Anúncios e vira pedido em Candidaturas; opção de comodato com bônus mostra progresso em Meu ponto e ativa o plano ao resgatar.

## D. Falta construir (registrado em `docs/proximas-versoes.md` com condição de entrada)

Impactos/CPM, comprovante PDF, alertas e dunning, arte como serviço, campanha por período, QR rastreável, mapa com foto, uptime público, assinatura eletrônica, kit do vendedor, cupom de primeira compra, trial, sobretaxa de exclusividade, cobertura restrita por ciclo sorteada entre pontos, folga de 15 min pro déficit da hora anterior, endereço pré-preenchido no checkout (depende do Checkout aceitar endereço no `pagador`), duas instâncias do servidor (depende de tirar da memória o cache de playlist, o limite de tentativas e a fila da conciliação). Mais: e-mail de boas-vindas/convite (hoje o link vai por WhatsApp na mão), testes e2e no CI (precisam de Postgres no workflow — o `ci.yml` já sobe um), e Termos/Privacidade revisados pra v2 (skill `legal` — o inventário de dados está em `docs/inventario-de-dados.md`).

## E. O que mudou nesta aceleração (resumo pra você se situar)

- Backend: contas com papéis; convites e candidaturas; dispositivos (tela) com chave, PIN, custo; playlist por tela; planos modulares (grátis, mínimo de telas, preço travado, fundador/vagas, tela após N meses); opções de comodato com bônus de anúncio; custos fixos; sessão em Postgres; scrypt; webhook fail-closed/idempotente/transacional; painel único com modos.
- Front: `seja-um-ponto`/`seja-um-vendedor` viraram candidatura; `convite.html`; `anunciante/ponto.html` por tela; `anunciante/vendedor.html`; `modos.js` (cards de ativação); `player.html` por tela com cache de vídeo e painel por PIN; `planos.html` com fundador e módulos; admin com Candidaturas, Convites, Telas, Vendedores, Custos fixos e campos novos de plano.
- Docs: `README.md`, `CLAUDE.md`, `CONSTRAINTS.md`, `docs/api.md`, `docs/specs/2026-09-12-mostrai.md`, `docs/precificacao.md`, `docs/proximas-versoes.md`, `docs/inventario-de-dados.md`, `docs/erros/*`, `tests/e2e/README.md`.
- Verificação: 14 unitários + 5 suítes e2e (136 checagens, API e navegador) verdes; revisão independente achou 13 defeitos, todos corrigidos.

## F. Rodada de depuração antes de fechar a Estação 5 (aberta em 15/09/2026)

**A Estação 5 não fecha só porque o código está construído e o site está no
ar.** Ela fecha quando o dono revisa o produto em produção
(`mostrai.sancocore.com.br`) e confirma que está no nível que ele quer — e
isso é julgamento de quem usa, não algo que se confere lendo código ou
rodando teste automatizado. Enquanto essa revisão não terminar, a estação
fica aberta (skill `leis`, "bloqueio trava a esteira inteira") e nada da
Estação 6 abre.

**Como funciona esta rodada:**
1. O dono navega o site — como visitante, como anunciante, como dono de
   ponto/vendedor, e no `/admin` — e manda a lista do que precisa de ajuste,
   do jeito que vier (prints, texto solto, um item por vez ou tudo junto).
2. Cada item entra numa linha abaixo, sem inventar nem reformular o que o
   dono relatou.
3. Bug, comportamento errado e página quebrada são corrigidos na hora
   (skill `depurar` — causa raiz, não o sintoma) e a linha vira `[x]` com a
   evidência de reverificado (commit, ou o antes/depois no próprio site).
4. Pedido que é IDEIA nova (não conserto do que já existe) não entra aqui —
   vai para `docs/proximas-versoes.md`, e a linha aqui registra só o
   encaminhamento.
5. A estação fecha quando a lista abaixo estiver toda `[x]` **e** o dono
   disser que está satisfeito com o nível — não antes.

**Ordem escolhida pelo dono (15/09/2026):** primeiro o visual, PC e celular
lado a lado; depois as funcionalidades. Prints chegam um de cada vez, e cada
um vira uma linha nova abaixo assim que resolvido.

### Itens reportados

**1. [ ] CRÍTICO — pagamento confirmado não credita o ciclo; a conta nunca
ativa.** *(Reportado em 15/09/2026, pagamento real de teste no sandbox:
conta "San Company", plano `destaque-3m`, R$ 537,30.)*

*O que acontece:* o cliente paga, a Asaas confirma, o webhook chega no
Mostraí — e a conta fica `pendente_aprovacao` com `plano_id` nulo, sem
cobrança registrada e sem e-mail. Em produção: 1 assinatura ativa,
**0 cobranças**, e uma pendência com o motivo
`"sem chargeId pra deduplicar: checkout não devolveu ultimaCobranca.chargeId"`.

*Causa raiz (provada, nos payloads crus da Asaas guardados pelo Checkout):*
a Asaas **não manda o id do pagamento no evento `CHECKOUT_PAID`** — a lista
completa de campos daquele evento não tem `payment.id` nem
`checkout.payment`, que são justamente os dois lugares onde
`webhookController.js` procura. O id só chega 279 ms depois, no
`PAYMENT_CONFIRMED` (`pay_5i4ahupi228zjoxe`), que traz também
`payment.subscription` e `payment.checkoutSession` — o campo que liga de
volta à sessão de checkout. Resultado no banco do Checkout: a cobrança fica
com `charge_id = null` **e** `asaas_subscription_id = null`.

*Por que não se conserta sozinho:* a conciliação diária tem a MESMA
dependência (`src/financeiro/conciliacao.js`: `if (ultima?.status !==
'confirmado' || !ultima.chargeId)` → conta como "sem cobrança" e não
aplica). Não é atraso de um dia: sem o id, nunca aplica.

*Consequências além do Mostraí:* sem `asaas_subscription_id`, o Checkout
também não cria a linha em `assinaturas` (a tabela está vazia) — então
`/cancelar-assinatura` não acha a assinatura, e os ciclos recorrentes
seguintes ficam sem a "cobrança-modelo".

*Onde fica o conserto:* **no San Checkout**, não aqui — no tratador do
`PAYMENT_CONFIRMED`, achar a cobrança por `payment.checkoutSession` →
`asaas_checkout_id` quando não achar por `charge_id`, e gravar
`charge_id = payment.id` e `asaas_subscription_id = payment.subscription`.
Ideal também: só notificar o contratante depois de ter o id em mãos.
*Decisão do dono pendente:* se o Mostraí deve ganhar uma rede de segurança
própria (aceitar `criadoEm|status` como chave quando o `chargeId` vier
nulo) — é caminho de dinheiro, não mexo sem a palavra dele.

*Atualização em 15/09/2026 — verificado ao vivo:* o conserto foi escrito por
uma sessão do Checkout (commit `740d6bc`, "vincular charge_id pelo
PAYMENT_CONFIRMED, não pelo CHECKOUT_PAID", credita o achado ao Mostraí) mas
**segue só na branch `claude/nifty-meitner-4ffp9s`, sem merge em `main` e
sem deploy** — conferido direto no Northflank do `san-checkout`:
`deployedSHA` continua `3e38c5b...`, o commit antigo com o bug. A cobrança
real travada (`asaas_checkout_id = 0a000018-daa5-4fbc-acb9-4056c22ba250`)
segue como estava: `status: confirmado`, `charge_id: null`,
`asaas_subscription_id: null`. Fora do escopo desta sessão (é o Checkout que
conserta o lado dele). Mesmo quando o deploy sair, **não vai creditar essa
cobrança específica sozinho** — a Asaas já entregou o `PAYMENT_CONFIRMED`
uma vez e não reenvia; vai precisar de reconciliação manual do lado de lá
depois do deploy.

**2. [ ] E-mail não chegou (nem do Mostraí, nem da Asaas).**
*Mostraí:* é consequência do item 1 — `enviarConfirmacaoPagamento` só roda
dentro de `aplicarCicloPago`, que nunca rodou. Não é defeito de SMTP; o SMTP
continua **não verificado** (nenhum envio real aconteceu ainda).
*Asaas:* sandbox; conferir na conta da Asaas se o envio de recibo está
ligado nesse ambiente. Fecha junto com o item 1 — quando o ciclo aplicar, o
e-mail sai e aí sim se sabe se o SMTP funciona.

**3. [x] Aprovação de conta sai; só o criativo é aprovado.** **FEITO em
15/09/2026.** *(Decisão do dono, a partir da observação de que a conta
consegue pagar antes de ser aprovada.)* A observação estava certa e o
código já se comportava assim: `assinar` só barrava conta `suspenso`, e
`aplicarCicloPago` põe `status = 'ativo'` no pagamento — ou seja, pagar já
aprovava. A fila de aprovação de conta nunca foi um portão de verdade.
Mudou: conta nova nasce com status `aprovado` (`src/anunciantes/repository.js`,
`src/anunciantes/routes.js` — por convite ou pelo cadastro aberto, os dois
caminhos), a fila "anunciante(s) pendente(s) de aprovação" saiu do admin
(alerta da Visão geral e badge do menu, `public/admin/index.page.js`) e da
consulta de filas (`src/admin/routes.js`). O único portão que resta é o do
criativo, que já existia e já manda e-mail de aprovado/reprovado.
`enviarContaAprovada`/`conta:aprovacao_recebe` não foram apagados — o caso
real que sobra pra eles é reinstalar uma conta suspensa, que continua
precisando do aviso. RN-34 em `docs/funcional.md`.

*Ponto solto, não decidido:* a conta de teste do próprio dono (id 3, "San
Company", `brunosanches.bhs@gmail.com`) segue com `status =
pendente_aprovacao` no banco — é o valor de antes da RN-34, e a mudança só
afeta contas criadas daqui pra frente, não reescreve retroativamente a que
já existe. Corrigir essa linha é um `UPDATE` de uma linha só (não mexe em
dinheiro nem em schema), mas fica pendente até o dono confirmar se quer que
eu troque agora ou se prefere ver isso na rodada de depuração.

**4. [ ] Duas instâncias do servidor no Northflank — risco se ligar antes da
hora.** *(O dono avisou a intenção de aumentar; verificado em 15/09/2026 antes
de ele agir.)* Hoje o serviço `mostrai` roda em 1 instância só. Três estados
vivem em memória do processo Node; dois deles quebram de verdade com 2
instâncias:
- Cache de playlist por hora (`src/playlist/routes.js`, `new Map()`,
  comentário "uma instância só") — **quebra**: cada instância cacheia
  playlist diferente, o aparelho pode receber conteúdo desatualizado
  dependendo de qual instância responde.
- Limitador de tentativas de login (`src/lib/limite-tentativas.js`,
  `new Map()`) — **quebra**: cada instância conta tentativas por conta
  própria, na prática dobrando (ou mais) as tentativas permitidas contra
  força bruta.
- Fila de retry da conciliação (`src/financeiro/conciliacao.js`) — **não
  quebra**: conferido no Northflank, conciliação roda como job separado
  (`conciliacao`, cron), não como parte do serviço `mostrai`. Escalar o
  serviço principal não toca nisso.

Já registrado em `docs/proximas-versoes.md` com a entrada "Duas instâncias
do servidor no Northflank". Antes de ligar a segunda instância, os dois
primeiros itens acima precisam sair da memória do processo (Postgres ou
Redis, que já existem no projeto). Trabalho pequeno e isolado — fica
pendente até o dono decidir a ordem (visual → funcionalidades → depois
instâncias, ou antes).

**5. [x] Home — símbolo da lâmpada cortado no topo, e dois textos da dobra
principal.** **FEITO em 15/09/2026.** *(Primeiro print da rodada de
depuração visual, desktop.)*

- *Símbolo cortado:* a cópia laranja de `public/img/simbolo-lampada.svg`
  (`translate(-30 -21) scale(1.03)`) passa do limite `0/2000` do desenho
  original e a ponta de cima saía cortada. Conserto: `viewBox` ganhou 40 de
  folga em volta (`-40 -40 2080 2080`) — o desenho, a cor e o deslocamento do
  dono não mudaram, só a margem que evita o corte. Conferido por captura
  isolada do SVG antes/depois.
- *Texto de destaque acima do título:* "Telas de anúncio dentro do comércio
  de Matão-SP" → **"Telas de anúncio dentro do comércio local"** (pedido do
  dono: tirar a limitação ao município).
- *Linha abaixo do botão laranja:* "Tem um comércio? Ganhe com a parede.
  Quer indicar? Seja vendedor parceiro." → "Quer anunciar? Tenha um ponto.
  Quer indicar? Seja um parceiro." (pedido literal do dono; ressalva sobre o
  link "Tenha um ponto" ir pra `/seja-um-ponto.html` foi levantada e o dono
  optou por manter assim) → **corrigido de novo em 15/09/2026: "Tem um
  comércio? Tenha um ponto. Quer indicar? Seja um parceiro."** — o dono
  voltou só a pergunta pro original, mantendo a resposta nova.

**6. [x] Home — texto genérico dos "três papéis" removido, e passo 1 do
"Como funciona" reescrito.** **FEITO em 15/09/2026.** *(Segundo print da
rodada de depuração visual, desktop.)*

- *Removido:* o parágrafo abaixo dos três cartões (Anunciante/Ponto/Vendedor)
  — "São três papéis, mas uma conta só: o mesmo login serve pra anunciar,
  pra ter uma tela no seu comércio e pra indicar — os modos aparecem no seu
  painel, e você liga o que quiser, quando quiser." — pedido do dono, texto
  considerado genérico e sem função ali.
- *Passo 1 do "Como funciona"* ("Crie sua conta e escolha o plano"): "Leva
  dois minutos e é tudo pelo site. O pagamento é no San Checkout (Pix ou
  cartão) e a sua cobertura começa quando ele confirma." →
  **"Escolha o plano que cabe no seu orçamento e cadastre sua empresa pelo
  próprio site, em menos de dois minutos. O pagamento é no cartão, e sua
  cobertura começa assim que ele é aprovado."** — a pedido do dono: sem citar
  o San Checkout (fornecedor não aparece pro público) e só cartão como forma
  de pagamento, com o texto focado em criar conta e escolher o plano.

**7. [x] Planos — alegação falsa de "100% dos pontos", frase final fraca,
descontos das abas, aviso de rede em montagem e nota redundante do ciclo
mensal.** **FEITO em 15/09/2026.** *(Terceiro print da rodada de depuração
visual, desktop.)*

- *"Todo plano coloca a sua marca em 100% dos pontos da rede" — o dono
  apontou como mentira, e é: `src/playlist/gerador.js` exclui da playlist
  quem tem o mesmo `categoria_id` do ponto (bloqueio de concorrente direto,
  a mesma regra da FAQ "Meu anúncio pode cair na tela de um concorrente?").
  Então não é 100% pra todo mundo — quem compete com o dono de um ponto
  específico não entra nele. Reescrito (`public/planos.html`, e as mesmas
  três repetições em `<meta name="description">`, `og:description` e no
  JSON-LD) pra citar a exclusão de concorrente em vez de prometer 100%.
  **Corrigido de novo em 15/09/2026:** o dono achou a menção a "concorrente"
  ruim demais pra aparecer na frase — reescrito de novo (parágrafo e
  JSON-LD) sem citar concorrente e sem prometer 100%: só "Sua marca roda
  pelos pontos da rede" / "O plano define quantas vezes por dia a sua marca
  aparece nas telas ativas".
- *Frase final "...comece a fazer parte da rotina de quem passa por lá"* —
  trocada por "Escolha o seu ritmo e comece agora." (pedido do dono: tirar
  o "de quem passa por lá").
- *Descontos das abas Trimestral/Semestral/Anual (-10%/-15%/-20%)* —
  conferido que já são calculados ao vivo (`atualizarDescontos()` em
  `planos.page.js`) a partir do preço real de cada plano no banco, não um
  número fixo escrito na tela. Testado nos três tiers ativos (Essencial,
  Destaque, Máximo): os três batem exatamente 10%/15%/20% no preço mensal
  equivalente. Nada pra corrigir aqui — só confirmado.
- *Aviso "A rede ainda está em montagem"* (`planos.page.js`) — antes só
  aparecia com **zero** pontos ativos e nunca mudava de texto. Agora
  acompanha a contagem de pontos ativos ("Hoje N pontos estão no ar, e a
  instalação continua") e desaparece sozinho ao chegar em **5** pontos
  ativos (`PONTOS_PARA_TIRAR_AVISO`), a pedido do dono.
- *Nota "Sem fidelidade: ..." do ciclo mensal* — removida (`NOTA_CICLO[1]`
  virou string vazia, e `#cycleNote` agora fica `hidden` quando não há nota
  pro ciclo) — a mesma informação já está na FAQ "Como eu cancelo?" logo
  abaixo, e repetir ali foi considerado desnecessário pelo dono.

**8. [x] Encaminhado — limite de pontos e frequência configuráveis por
plano; achado de brinde: a mesma mentira do "100%" ainda vivia num
benefício do catálogo.** **FEITO em 15/09/2026.** *(Pedido do dono fora de
print, sobre a página de Planos: "adicionar limite de pontos por plano e
quantia de aparições por dia, os dois configuráveis do jeito que eu
quiser".)*

- É IDEIA nova (não conserto do que já existe), então foi só encaminhada —
  regra 4 desta seção. Foram pra `docs/proximas-versoes.md`: **"Cobertura
  restrita por ciclo, sorteada entre pontos"** (já existia; atualizada agora
  pra registrar que o dono quer número livre de pontos por plano, não as
  duas opções fixas do enum atual), e **"Teto de 3 criativos por plano
  travado no código e no banco"** (nova — achada ao procurar "outras
  funções" que também deveriam ser livres e não são).
- A frequência (então `frequencia_dia`) **já era livre nesse momento** —
  campo numérico, editável por plano no admin, sem teto no código.
  Registrado em `proximas-versoes.md` só pra não sumir da lista. *(Ver item
  10: no mesmo dia o dono pediu pra trocar a unidade de "por dia" pra "por
  hora", e isso foi construído.)*
- *Achado ao investigar (não fazia parte do pedido, mas é a mesma mentira já
  corrigida nesta seção, item 7):* o benefício "Alcança 100% dos pontos
  ativos" (catálogo `beneficios`, id 11), ativo e vinculado às 4 versões do
  plano Essencial, dizia a mesma coisa falsa que o parágrafo da página —
  corrigido direto no banco pra "Roda em todos os pontos, menos no do seu
  concorrente direto". É dado (linha de tabela), não código: não precisa de
  deploy, já está no ar. **Corrigido de novo em 15/09/2026:** o dono achou a
  menção a "concorrente" ruim demais — texto virou "Roda pelos pontos ativos
  da rede", sem citar concorrente.

**9. [x] Encaminhado — revisão do mesmo dia: pontos viram lista fixa, e
frequência muda de "por dia" pra "por hora" com folga de 15 min.** **FEITO
em 15/09/2026.** *(Continuação do item 8, mesmo dia, ainda fora de print.)*

- O dono voltou atrás no item 8: em vez de número livre de pontos por
  plano, quer uma **lista fixa** — `1, 2, 3, 5, 10, 15, 20, 25+` mais a
  opção **"todos os pontos"** (que é a que ele vai usar enquanto a rede
  tiver poucos pontos). Atualizei a entrada em `docs/proximas-versoes.md`
  ("Cobertura restrita por ciclo, sorteada entre pontos") pra registrar essa
  troca — ainda não está claro se "25+" é um teto exato de 25 ou "25 ou mais
  sem teto"; fica marcado pra perguntar na hora de construir.
- Pedido novo: trocar a unidade de frequência de "quantas vezes por dia"
  pra "quantas vezes por hora", com liberdade de a exibição rodar até 15
  minutos antes ou depois da hora cheia. Criei entrada nova em
  `proximas-versoes.md` ("Trocar a unidade de frequência de 'por dia' para
  'por hora', com folga de 15 min") — e marquei que isso pode ser a MESMA
  ideia da entrada já existente "Folga de 15 minutos pro déficit da hora
  anterior", só dita de outro jeito, ou pode ser duas coisas diferentes
  (unidade de configuração do plano vs. motor de recuperação de déficit).
  Não juntei as duas sem confirmar — fica registrado pra perguntar ao dono
  antes de construir, pra não implementar a mesma folga duas vezes.

**10. [x] Construído — frequência do plano vira "por hora", direta e livre
(sem a folga de 15 min).** **FEITO em 15/09/2026.** *(O dono simplificou o
pedido do item 9 e mandou "construa": "eu escolho a quantidade de vezes que
quiser que apareça por plano, aqui é N vezes por hora, a quantia que eu
querer mesmo".)*

- `planos.frequencia_dia` virou `planos.frequencia_hora`, e
  `anunciantes.frequencia_dia_propria` virou `frequencia_hora_propria`
  (migration 037) — sem mudar comportamento no ar: os valores existentes
  (36/72/144 por dia, e o padrão 12 da conta própria) já eram múltiplos
  exatos de 12, então a migration divide por 12 e preserva a entrega atual.
  O dono edita cada plano livremente a partir de agora.
- A conversão "por dia → por hora" que existia só pra telas com horário
  diferente do padrão (`horasAbertoPorDia`, 12h padrão) foi **removida** de
  `src/playlist/gerador.js` — não faz mais sentido com a frequência já
  nativa em hora. Isso resolve de brinde um furo antigo (`docs/furos.md`,
  `docs/teia.md`): o "≈Nx por hora" que a vitrine mostrava não batia com o
  que o gerador realmente fazia em pontos de horário não-padrão; agora não
  tem mais conversão escondida nenhuma — o número que aparece é o que roda.
- **Não incluído:** a folga de "±15 minutos" que o dono mencionou no pedido
  anterior (item 9) não apareceu neste pedido final, então não foi
  construída. Fica anotada em `docs/proximas-versoes.md`, na entrada "Folga
  de 15 minutos pro déficit da hora anterior", como possível pedido ainda
  vivo — perguntar ao dono se ainda quer.
- Telas trocadas: `src/db/migrations/037_frequencia_por_hora.sql` (nova);
  `src/playlist/gerador.js`; `src/financeiro/planos-repository.js`;
  `src/financeiro/routes.js`; `src/anunciantes/repository.js`;
  `src/anunciantes/routes.js`; `public/admin/index.page.js` (form de novo
  plano, "Meus anúncios" e "Planos arquivados"); `public/planos.page.js`;
  `public/anunciante/painel.page.js`. Docs: `docs/api.md`, `docs/funcional.md`,
  `docs/teia.md`, `docs/furos.md`, `docs/economia-da-rede.md`,
  `docs/catalogo-beneficios.md`, `docs/pesquisa-voltplace.md`,
  `docs/proximas-versoes.md` (a entrada do item 9 foi removida de lá, por
  estar construída).
- `docs/specs/2026-09-12-mostrai.md` **não foi tocado** — é registro
  histórico congelado da Estação 1/2, já fechadas; ainda cita
  `frequencia_dia` como estava decidido naquela data, o que é esperado.

**11. [x] Construído — status da conta vira só comum/parceiro; `suspenso`
separa em campo próprio.** **FEITO em 16/09/2026.** *(Pedido do dono fora de
print, ainda sobre a página de Anunciantes: "vi que o status de aprovado
pendente e ativo continuam no status do cliente, mude esse status somente
para 2 status comum e parceiro que é a substituição do fundador"; depois:
"o status serve somente para separar parceiro de cliente comum, e os
criativos são aprovados quando sobem em uma aba deles próprio".)*

- `status` deixou de misturar rótulo comercial com estado operacional.
  Agora: `status` (`comum`/`parceiro`, nunca bloqueia nada — substitui o
  flag `fundador`, renomeado por inteiro: `parceiro_desconto_percentual` /
  `parceiro_compromisso_minimo`) e `suspenso` (booleano — o que bloqueia
  login em `/anunciantes/:id/assinar` e some da playlist; ligado pela
  conciliação quando a cobertura vence ou à mão pelo admin, desligado por
  qualquer crédito de ciclo). O gate real de veiculação continua sendo o do
  criativo (RN-34) — confirmado com o dono, não mudou.
- Migração 038: renomeia as colunas do antigo "fundador", adiciona
  `suspenso`, e troca a constraint de status pra `comum`/`parceiro`.
- **Quase deu problema:** a primeira versão da migração 038 tentava gravar
  `status = 'comum'` **antes** de tirar a constraint antiga (que só aceitava
  os 4 valores velhos) — o próprio UPDATE de transição violava a constraint
  que estava tentando substituir. Isso pôs o serviço em **crash-loop** em
  produção por cerca de 10 minutos (o container reiniciava, a migração
  falhava, reiniciava de novo) — sem corromper nada, porque cada migração
  roda numa transação com rollback automático no erro, então o banco nunca
  chegou a ficar com o `status` pela metade. Vi o erro exato nos logs do
  Northflank (`violates check constraint "anunciantes_status_check"`),
  corrigi a ordem (tirar a constraint antes do UPDATE, não depois) e
  empurrei um segundo commit — o deploy completou normal na sequência.
  Confirmado depois: `schema_migrations` tem a 038 aplicada, a conta do
  dono (id 3) saiu com `status: comum, suspenso: false`, e o site respondeu
  normalmente durante todo o processo (o Northflank manteve a versão
  anterior servindo enquanto a nova falhava, não houve indisponibilidade
  visível).
- Telas trocadas: `src/db/migrations/038_status_vira_comum_parceiro.sql`
  (nova); `src/playlist/gerador.js`, `src/financeiro/routes.js`,
  `src/financeiro/san-checkout.js`, `src/financeiro/conciliacao.js`,
  `src/financeiro/planos-repository.js`, `src/anunciantes/repository.js`,
  `src/anunciantes/routes.js`, `src/conta/modos.js`, `src/admin/routes.js`,
  `src/titular/routes.js`; `public/admin/index.page.js` (badge, botão
  "Marcar parceiro", coluna "Suspensa", form "Meus anúncios"),
  `public/anunciante/painel.page.js`, `public/perfil.js`, `public/layout.js`.
  Testes e2e (02, 03, 04, 05) e docs (`funcional.md` RN-14/34/35 nova,
  `api.md`, `catalogo-beneficios.md`, `teia.md`) ajustados. Não roda
  Postgres local nesta sessão — os e2e não foram executados, só
  revisados linha a linha.

**12. [x] Favicon: cruz da San & Co. vira o símbolo da lâmpada.** **FEITO em
16/09/2026.** *(Pedido do dono: "trocar o favicon pela mesma símbolo da
logo trocando a cruz da San & Co"; depois, ida e volta sobre a moldura
circular — "é com esse círculo mesmo, se não o símbolo fica invisível".)*

- `favicon-sanco.png` e `apple-touch-icon.png` regravados a partir de
  `public/img/simbolo-lampada.svg` (mesmo símbolo do hero da home e do
  estado vazio do player), com folga de escala (76%) pra sobreviver a um
  recorte circular de lançador de app, e um círculo desenhado direto no
  PNG (fechado, sem falha) pra o contorno fino não desaparecer em fundo
  escuro. Nome do arquivo ficou o mesmo (`favicon-sanco.png`) — só o
  conteúdo trocou, pra não precisar editar link em nenhuma das 23 páginas.
- Telas trocadas: `public/img/favicon-sanco.png`, `public/img/apple-touch-icon.png`.

**13. [x] Travessão fora de todo texto visível do site, e varredura completa
de `docs/furos.md`.** **FEITO em 16/09/2026.** *(Pedido do dono: "retire os
travessões... já retire todos travessões das páginas"; depois "passe a
varredura em partes q poder ter ficado pra trás" sobre os 132 furos
levantados em 15/09/2026.)*

- Travessão (—) reescrito como texto corrido (vírgula, ponto quebrando em
  duas frases, ou reformulação) em todo texto visível de `public/`
  — títulos, parágrafos, mensagens de erro/sucesso, avisos na TV.
  Comentário de código e CSS não foram tocados (não são visíveis ao
  usuário). Quatro agentes em paralelo (HTML e JS, dois lotes cada) mais
  ajustes manuais nos arquivos que sobraram (`seja-um-ponto.html`,
  `admin/index.page.js`, `anunciante/painel.page.js`, `ponto.page.js`,
  `planos.page.js`).
- Varredura de `docs/furos.md` (seções Alta, Média, Baixa — a Crítica já
  tinha sido conferida antes): de ~100 furos reverificados contra o código
  atual (não contra a descrição do documento, que já estava desatualizada
  em boa parte), só 5 continuavam realmente abertos, e os cinco foram
  fechados nesta rodada:
  - `index.html` não dizia que os três papéis (anunciante/ponto/vendedor)
    cabem numa conta só — frase acrescentada.
  - `POST /contato` só tentava e-mail; se o SMTP falhasse (como está
    falhando agora, item 9 desta lista), a mensagem do titular se perdia
    sem rastro. Migration 039 (`mensagens_contato`) grava antes de tentar
    o e-mail.
  - Abas Pontos e Anunciantes do admin não tinham estado vazio (tabela só
    com cabeçalho com a rede zerada) — ganharam o mesmo padrão das outras
    abas.
  - `docs/api.md` dizia "60 rotas" de admin; a tabela do próprio arquivo e
    o código já tinham 66 — corrigido.
  - Bônus cruzado (ponto ganha anúncio grátis / anunciante ganha tela
    grátis) sem menção nas páginas públicas — parcialmente coberto: o lado
    ponto→anúncio já está em `seja-um-ponto.html`; o lado
    anunciante→tela continua sem menção pública (não fechado, baixa
    prioridade).
- Telas trocadas: praticamente todo `public/*.html` e `public/*.page.js`
  (travessão), `src/conta/routes.js` + `src/db/migrations/039_mensagens_de_contato.sql`
  (contato), `public/admin/index.page.js` (estado vazio), `docs/api.md`
  (contagem de rotas), `public/index.html` e `public/seja-um-ponto.html`
  (texto).

**14. [x] Vitrine: preço cheio + desconto por plano, card reorganizado.**
**FEITO em 16/09/2026.** *(Pedido do dono, detalhando a estrutura do card
e o mecanismo de preço: "1 titulo 2 subtitulo... o preço cheio é o que
fica em cima e quando aplico o desconto ele fica cortado"; depois "coloque
[...] o valor do desconto aplicado, ligado ao desconto que coloco lá, pode
retirar a informação de quantas vezes aparece por dia".)*

- Migration 040: `planos.desconto_percentual`. No admin, cada plano é
  editado por preço cheio (`valor_mensal_cheio`, coluna que já existia,
  agora exposta) + desconto % — o valor cobrado (`valor_mensal`) é sempre
  calculado a partir dos dois, no servidor (`calcularValorMensal`), nunca
  digitado direto. Campo de contrato: só muda publicando versão nova, como
  já era pro valor mensal.
- Card da vitrine: título, preço (riscado só com desconto, com o selo
  "-N%" ligado ao `desconto_percentual` do plano, + o valor cobrado),
  benefícios (frequência por hora entrou como primeiro item, sem
  parêntese). Tirou a linha "R$X/mês" redundante do ciclo mensal, a
  mensagem de economia por ciclo, e a linha "≈Nx por dia".
- Telas trocadas: `src/db/migrations/040_desconto_percentual_do_plano.sql`
  (nova), `src/financeiro/planos-repository.js`, `src/financeiro/routes.js`,
  `public/admin/index.page.js`, `public/planos.page.js`, `public/style.css`,
  `docs/api.md`.

**15. [x] Cancelar assinatura pelo painel, e trocar de plano com crédito
prorata.** **FEITO em 16/09/2026.** *(Pedido do dono: "ligue o cancelar
plano a uma tela do cliente"; e sobre a troca: "a mudança ocorre somente
se o plano for melhor que o atual... será cobrada a diferença entre os
planos junto ao desconto do restante do plano anterior... de forma que
não sairemos perdendo".)*

- Cancelar: `POST /anunciantes/me/cancelar-assinatura` — mesma lógica da
  rota de admin, agora também pelo próprio cliente. Botão "Cancelar
  assinatura" na seção "Sua assinatura" do painel; cobertura já paga
  continua até `data_expiracao`, igual a FAQ já prometia.
- Trocar de plano: a assinatura recorrente do San Checkout não aceita
  desconto (confirmado no `API.md` do Checkout, lido do repositório
  `sancompany/san_checkout`) — a diferença é cobrada como **pedido
  avulso** (migration 041, `pedidos_avulsos`), não como assinatura nova.
  Crédito = dias restantes × (valor mensal do plano atual / 30); custo =
  preço cheio do plano novo × meses do ciclo; só permite a troca quando o
  custo é maior que o crédito (nunca cobra zero, nunca devolve dinheiro).
  Webhook de pedido avulso (`GET /pedido/:id`, `POST /webhook/san-checkout`
  já ramificado pelos dois tipos) aplica a troca só depois do `confirmado`:
  cancela a assinatura antiga no Checkout e ativa o plano novo na conta.
- **Decisão consciente, dita pelo dono:** sem assinatura recorrente nova
  na troca — a cobertura vale pelo período do plano novo, e ao vencer
  precisa assinar de novo, como qualquer plano. Não dá pra ter as duas
  coisas (diferença exata **e** renovação automática) sem um crédito de
  produto por fora, que é escopo novo, não construído.
- **Ainda falta (não bloqueia, registrado pra não esquecer):** aviso por
  e-mail perto do fim do período trocado, convidando a renovar (mesmo
  padrão do e-mail de cobrança falhou) — não existe ainda, então uma
  conta que trocou de plano e não voltar sozinha simplesmente perde a
  cobertura na data, sem lembrete. E não há aba no admin listando
  `pedidos_avulsos` (pendente/pago) — o pago já entra em
  `cobrancas_confirmadas` (aparece na receita), e o que falha vira
  pendência na mesma fila de "Eventos pendentes" de sempre; só não tem
  uma tela dedicada pra ver trocas de plano em lista.
- Telas trocadas: `src/db/migrations/041_pedidos_avulsos.sql` (nova),
  `src/financeiro/pedidos-repository.js` (novo), `src/financeiro/san-checkout.js`,
  `src/financeiro/routes.js`, `public/anunciante/painel.page.js`,
  `public/anunciante/painel.html`, `docs/api.md`, `docs/teia.md`.
- **Combinado com o dono, fora do código:** ele configura no San Checkout
  o que for preciso pra aceitar pedido avulso deste projeto — não é algo
  que o Mostraí resolve por dentro do próprio repositório.

**16. [x] Aviso por e-mail perto do fim do período de uma troca de plano.**
**FEITO em 16/09/2026.** *(Achado construindo o item 15 — "ainda falta" de
lá, promovido a item próprio pra não se perder.)*
· O problema: troca de plano não deixa assinatura recorrente nova, então a
  cobertura vale pelo período contratado e some sozinha, sem aviso nenhum,
  se o cliente não voltar e contratar de novo.
· Onde ficou: na CONCILIAÇÃO DIÁRIA, não numa rotina nova
  (`avisarCoberturaAcabando` em `src/financeiro/conciliacao.js`). A
  pergunta é a mesma que ela já faz todo dia ("o que vence agora") e o cron
  já existe — rotina nova seria um segundo cron pra configurar e esquecer.
· Quem recebe: conta ativa, não suspensa, não cortesia, que vence nos
  próximos 7 dias e **não tem assinatura ativa**. Quem tem assinatura fica
  de fora de propósito: pra esse o motor cobra sozinho, e se falhar quem
  avisa é o `enviarCobrancaFalhou` que já existia.
· Não repete: `anunciantes.aviso_fim_cobertura_para` (migration 043) guarda
  PARA QUAL expiração o aviso saiu, não um booleano nem a data do envio.
  Expiração nova é um valor diferente, então o aviso rearma sozinho na
  próxima troca, sem nenhuma rotina de limpeza. A marca é gravada só depois
  do envio — marcar antes transformaria uma falha de SMTP em aviso que
  nunca sai.
· **Provado contra um Postgres de verdade** (banco descartável, as 43
  migrations do zero, nodemailer interceptado): das seis contas montadas
  (vence em 3 dias sem assinatura, vence em 30, já venceu, suspensa,
  cortesia, com assinatura ativa) só a primeira recebeu; a segunda passada
  no mesmo dia mandou zero; e mexer na expiração fez o aviso voltar.
· Some no relato: `conciliacoes.avisados` entra na mesma linha de
  `expiradas` e aparece na Visão geral do admin. RN-36 em `docs/funcional.md`.
· Telas trocadas: `src/db/migrations/043_aviso_fim_de_cobertura.sql` (nova),
  `src/financeiro/email.js`, `src/financeiro/conciliacao.js`,
  `src/admin/routes.js`, `public/admin/index.page.js`.

**17. [x] Aba no admin listando pedidos avulsos (troca de plano) em lista
própria.** **FEITO em 16/09/2026.** *(Mesma origem do item 16.)*
· Aba **Trocas de plano**, no grupo Financeiro, logo abaixo de Cobranças:
  anunciante, plano de origem, plano de destino com a modalidade, valor da
  diferença, situação, data do pedido e data do pagamento. Dois KPIs em
  cima (trocas pagas e quanto renderam; quantas esperam pagamento) e os
  filtros de sempre (todas / pagas / pendentes / canceladas).
· Leitura pura: `GET /admin/pedidos-avulsos` não altera pedido nenhum. Quem
  muda o status de um pedido continua sendo só o webhook assinado.
· Quem trocou sem ter plano antes aparece como "sem plano" em vez de linha
  vazia (o `LEFT JOIN` é de propósito: `plano_atual_id` é nulável).
· Conferido em navegador de verdade a 1440px e 390px com três pedidos de
  exemplo (pago, pendente, cancelado): três linhas, KPIs certos, nada
  estourando a tela, nenhum erro de JS.

**18. [x] `obrigado.html` mostra texto de primeira contratação pra quem
está voltando de uma troca de plano.** **FEITO em 16/09/2026.** *(Mesma
origem do item 16.)*
· A página agora tem os dois textos e mostra um só. O de sempre continua
  igual. O da troca diz o que é verdade pra quem já está no ar: "Recebemos.
  Seu anúncio continua no ar", não precisa subir nada, o plano novo entra
  quando o banco confirmar, e o prazo não renova sozinho.
· Como distingue: só a volta de PEDIDO traz `?pedido=ID`; assinatura volta
  sem parâmetro nenhum (API.md do Checkout, seção 3.1, conferido no
  repositório do Checkout, não de memória).
· O que a página **não** faz, de propósito: dar o pagamento por confirmado.
  Query string qualquer um escreve — quem digitar `?pedido=X` na barra de
  endereço cai no mesmo texto. Por isso os dois textos falam em "recebemos",
  nunca em "pago". Quem confirma pagamento segue sendo o webhook assinado.
· Se o JS não rodar, aparece o texto da assinatura, que é o caso comum.
· Conferido em navegador a 1440px e 390px, nas duas voltas: título da aba,
  h1 e corpo trocam juntos e o texto errado não fica escondido na página.
· Telas trocadas: `public/obrigado.html`, `public/obrigado.page.js` (nova).

**19. [x] Bônus "anunciante ganha tela grátis" sem menção nas páginas
públicas.** **FEITO em 16/09/2026.** *(Achado na varredura de furos.md —
item 13 fechou o lado inverso, "ponto ganha anúncio grátis", em
`seja-um-ponto.html`; este lado ficou de fora.)*
· `planos.html` já tinha ganhado a linha no card na reorganização do item
  14 (`planos.page.js`: "Ao completar N meses, ganhe uma tela no seu
  comércio"). Faltava a home, que é onde a pessoa decide se clica.
· A home ganhou a linha no cartão "Anunciante", ao lado da do ponto.
· **Sai do dado, não de texto fixo.** O admin pode nunca ter ligado o
  módulo em plano nenhum — hoje, aliás, não está ligado em nenhum plano
  ativo. Então a linha nasce escondida e só aparece se algum plano ativo
  realmente oferecer o bônus; o prazo mostrado é o MENOR entre os que
  oferecem, que é o degrau de entrada. Escrever a promessa à mão no HTML
  faria a home prometer benefício que não está à venda — o mesmo defeito
  que o item 7 corrigiu no "100% dos pontos".
· Conferido em navegador nos dois sentidos: com bônus no dado a linha
  aparece (1440px e 390px, sem estourar a tela); sem bônus no dado, some.
· Telas trocadas: `public/index.html`, `public/index.page.js`.

**20. [x] Depuração visual do site inteiro (desktop e celular) e editor de
planos do admin com o visual da vitrine.** **FEITO em 16/09/2026.** *(Pedido
do dono ao sair: "visualize todas páginas do site e depure de acordo com o
mercado... procure bugs visuais tanto para desktop quanto para celular...
no painel de admin coloque o visual da própria página de planos pública mas
com os dados editáveis... ao invés de assinar plano um botão de salvar novo
plano, separados por mensal trimestral semestral e anual... os formulários
de cadastro login, deixe os menos arredondados... no celular eles quebram a
linha e ficam fora da tela".)*

- **Como foi olhado:** as 18 páginas públicas mais painel, "meu ponto" e
  "vendas" abertas em navegador de verdade (Chromium headless), em 1440px,
  768px e 360px, com os dados reais da API de produção. Medição automática
  de três coisas em cada uma: página mais larga que a tela, elemento
  estourando o contêiner, e campo estreito demais pro dado que recebe.
- **O que estava errado no celular (o que o dono viu):** não era a página
  vazando pra fora da tela — era campo espremido. A linha CEP / Rua e
  bairro / Número cabia três colunas dentro de 292px e cada uma virava
  67px: nem o placeholder `00000-000` aparecia inteiro. O piso de 140px faz
  a linha QUEBRAR em vez de espremer (duas colunas por linha no celular,
  nunca três), e o cartão perdeu 8px de padding, que viram largura útil.
- Mesma origem, outros dois: a dica da senha saía dentro da coluna do campo
  e virava quatro linhas espremidas ao lado do "Confirmar senha" (agora sai
  depois da linha, na largura toda), e o link de indicação do vendedor
  dividia a linha com o botão, quebrando a URL em quatro pedaços no meio da
  palavra (agora ocupa a linha inteira).
- **Arredondamento:** botão e campo saíram da pílula de 999px (tokens novos
  `--radius-btn: 10px` e `--radius-campo: 8px`). Selo e chip continuam
  redondos de propósito: ali a pílula é o que diz "isto é rótulo, não
  botão".
- **Outros achados da varredura:** seletor de ciclo da vitrine virou um
  controle segmentado (quatro pílulas soltas quebravam em duas linhas
  desalinhadas no celular); os cinco KPIs do painel deixavam o quinto
  sozinho numa fileira com um vão do lado (grade de três, quebra 3+2);
  tabela larga no celular rolava pro lado sem pista nenhuma além da última
  coluna cortada no meio da palavra (ganhou sombra de rolagem); a vitrine
  ordenava por nome do tier, então "Destaque" abria a grade e o plano
  destacado não ficava no meio (agora ordena por preço).
- **Travessão que faltou:** o rótulo "Preço fundador — nunca muda" é DADO
  (`planos.rotulo`), não markup — por isso escapou da limpeza do item 13,
  que leu `public/`. Migration 042 tira só a pontuação, mantendo a palavra
  que o dono escolheu.
- **Admin, aba Planos:** a tabela de 15 colunas virou o cartão da própria
  vitrine com os campos abertos — mesma ordem (rótulo, nome, preço riscado
  com o desconto, preço grande calculado ao vivo, lista de benefícios) e o
  mesmo botão no pé, agora "Salvar novo plano" em vez de "Assinar". Segue
  separado por Mensal, Trimestral, Semestral e Anual, com o contador
  "N/3 na vitrine" por modalidade. O botão fica sempre visível (como o
  "Assinar" da vitrine), desligado até haver mudança de contrato pra
  salvar — botão que some é botão que o dono procura.
- **Falso alarme conferido:** o balão do WhatsApp parecia cobrir campo no
  meio do formulário. Não cobre — é artefato de captura de página inteira
  (elemento `fixed` desenha na posição da janela). Medido com a página
  rolada até o fim nas três telas de formulário: não cobre nenhum controle.
- Telas trocadas: `public/style.css`, `public/admin/index.css`,
  `public/admin/index.page.js`, `public/formulario.js`,
  `src/financeiro/planos-repository.js`,
  `src/db/migrations/042_rotulo_sem_travessao.sql` (nova).

**21. [x] Segunda passada da `docs/furos.md` contra o código de hoje.**
**FEITO em 16/09/2026.** *(Pedido do dono: "rode novamente contra furos".)*
· 78 checagens automáticas furo a furo, mais as lentes da própria lista
  aplicadas à árvore inteira (rota órfã, função inexistente, `id` que o JS
  procura, rota fora do doc, tabela sem leitor, coluna morta), mais as 22
  páginas públicas num navegador de verdade a 1440px e 390px.
· 11 alarmes, 9 falsos (erro do teste, não do código) e 4 furos reais.
· **Real 1 — custo por exibição mostrava caro demais pra quem tem desconto.**
  O M11 tinha sido fechado antes de os descontos de parceiro e comodato
  existirem, e a conta inline no painel não os acompanhou. Dono de ponto com
  20% via R$ 0,5672 por exibição onde paga R$ 0,4537. Agora a rota usa
  `valorMensalDaConta`, a mesma função que decide o que o Checkout cobra.
· **Real 2 — a caixa de contato existia no banco e em tela nenhuma.** A
  migration 039 grava a mensagem antes de tentar o e-mail (pra falha de SMTP
  não sumir com o pedido), mas ninguém lia a tabela. Com o SMTP fora (item 2)
  e `/contato.html` sendo o canal de pedido do titular (LGPD, com prazo),
  todo pedido caía num buraco. Aba **Mensagens do site** no admin, com
  contador no menu, coluna dizendo se o aviso saiu, e marcação de respondida
  (migration 044).
· **Reais 3 e 4 — duas rotas vivas fora do `docs/api.md`**, uma delas de
  caminho de dinheiro (`/admin/eventos-pendentes/:id/aplicar`, que credita o
  ciclo depois de conferir no Checkout; o doc só listava o PATCH irmão, que
  arquiva e não credita).
· Detalhe de cada um, com os nove falsos alarmes nomeados, na seção
  "Segunda passada, 16/09/2026" de `docs/furos.md`.

---

**Onde a lista está em 16/09/2026 (fim do dia).** Dos 21 itens, 18 estão
`[x]`. Os três que faltam **não dependem de escrever código aqui**:

- **Item 1** (pagamento confirmado não credita o ciclo) — o conserto é no
  San Checkout, já escrito lá, e segue numa branch sem merge nem deploy.
  Enquanto não sair, a cobrança de teste travada continua travada, e vai
  precisar de reconciliação manual do lado de lá mesmo depois do deploy.
- **Item 2** (e-mail não chegou) — fecha junto com o item 1, e depende da
  senha de app nova do Gmail (`SMTP_PASS`, item 9 do "SÓ O DONO FAZ").
  Nenhum e-mail real saiu ainda, então o SMTP continua não verificado.
- **Item 4** (duas instâncias no Northflank) — não é defeito, é decisão de
  ordem do dono. Antes de ligar a segunda instância, o cache de playlist e
  o limitador de login precisam sair da memória do processo.

Ou seja: **a esteira não está parada esperando código**. Está esperando o
deploy do Checkout, a senha do SMTP e a palavra do dono sobre as instâncias
— e, acima de tudo, a continuação da revisão dele no site no ar, que é o que
de fato fecha a Estação 5.

**Retomada combinada com o dono:** a próxima rodada de depuração (seção F
continua) começa pela tela de Planos, ciclo Mensal — é onde a navegação
parou antes desta lista de pendências.
