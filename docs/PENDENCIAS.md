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

### Roteiro da revisão, definido pelo dono em 17/09/2026

O dono fechou a ordem da rodada. A Estação 5 só fecha quando os três tópicos
estiverem revisados E ele disser que está satisfeito.

1. **Sem login — desktop e celular.** O site público inteiro, nas duas
   larguras, corrigindo tudo o que for visual.
2. **Logado — os quatro papéis:** anunciante, dono de ponto, vendedor e admin.
3. **Funcionalidades e caminhos:** planos, cadastros, aprovação de criativos,
   playlist de criativos, e o resto das funções, testados de ponta a ponta.

**Depois disso, nesta ordem:** limpar o banco (abaixo) → fechar a Estação 5 →
abrir e fechar a Estação 6 (Prontidão) → o dono sobe o San Checkout para
produção → os dois projetos ficam prontos juntos.

### LIMPEZA DO BANCO — marcada, e só depois da revisão

**Quando:** depois que os três tópicos acima estiverem revisados, e antes do
primeiro ponto real ser instalado. O dono: "assim podemos limpar todas as
contas e dados do banco e aí sim posso colocar o primeiro ponto; antes disso
o lixo de testes fica atrapalhando".

**Não é para executar por iniciativa própria.** Apagar conta e cobrança não
tem volta, e a base de produção hoje tem uma cobrança confirmada de verdade
(R$ 267,30, conta 3). Quando o dono der o sinal, o passo é:
1. Backup manual ANTES, conferido (o job `Backup` roda aos domingos — não
   basta esperar o próximo).
2. Lista item a item do que apaga e do que fica, aprovada por ele — contas,
   cobranças, assinaturas, candidaturas, criativos, mensagens, eventos,
   pontos, telas, contadores de exibição. Planos e benefícios FICAM: são
   catálogo, não dado de teste.
3. Só então o script, numa transação, com contagem antes e depois.

### O FAVICON E O SÍMBOLO DA MARCA SÃO DUAS PEÇAS — erro cometido em 17/09/2026

Registrado porque já custou um retrabalho e vai custar de novo se ninguém
escrever:

- `public/img/simbolo-lampada.svg` — **símbolo da marca**, a lâmpada SEM
  círculo, fundo transparente. Vai na hero da home e no cartão institucional
  do player.
- `public/img/simbolo-mostrai.svg` — **favicon**, a lâmpada DENTRO do disco
  branco com contorno preto. Vai só nos ícones (`favicon-*.png`,
  `apple-touch-icon.png`) e em lugar nenhum mais.

O erro foi tratar as duas como a mesma coisa: apaguei o símbolo da marca e
pus o favicon na hero, "pra não ter duas versões da mesma marca". Não são
duas versões — são duas peças com trabalhos diferentes. A regra de "definir
uma vez" vale para o que precisa continuar idêntico, não para peças
distintas que por acaso se parecem.

### Decisões abertas com o dono (17/09/2026, depois do merge da grade)

**F-D1 [x] Benefício exclusivo do Máximo.** *(FECHADO em 17/09/2026: "esqueça esse benefício". O Prime fica com "Tudo do Pro" mais os números derivados, que é cartão completo.)* O relatório mensal por e-mail saiu
na migration 048 (pedido do dono: "não aumente meu trabalho sobre esse tipo de
coisa"). O Máximo ficou só com "Tudo do Destaque" mais os números derivados —
180h de tela/mês, 10 pontos, peça de 30s, 3 criativos. É cartão completo, mas
sem linha própria. **Três caminhos, e nenhum é do código escolher:**
· *(a)* Deixar como está. O Máximo se sustenta nos números.
· *(b)* Voltar "Prioridade em horário de pico", que o dono autorizou
  ("benefícios fantasiosos como prioridade em horário de pico podem existir").
  **Ressalva registrada uma vez, e a decisão é dele:** não existe prioridade de
  horário em linha nenhuma do gerador, então é promessa que não se cumpre num
  produto com cliente pagante — CDC art. 37 chama isso de publicidade
  enganosa, e este projeto está classificado no topo da escala de rigor.
· *(c)* **A versão VERDADEIRA da mesma promessa, que é barata:** quando a hora
  passa de 3600s e o corte proporcional entra (RN-30), cortar os planos de
  cima por último. A frase vira "quando a hora enche, você é o último a perder
  tempo de tela" — verdadeira, exclusiva, sem trabalho recorrente, e hoje ela
  nunca morde porque a rede está vazia. Custa um peso por tier na função de
  corte e uma emenda na RN-30.

**F-D2 [x] "Peça simples incluída" saiu dos planos.** *(FECHADO em 17/09/2026:
o dono esclareceu que nunca foi benefício — produção de peça é serviço à
parte, negociado no WhatsApp, com preço caso a caso. Virou a RN-45; saiu do
banco na migration 050 e do `obrigado.html`.)*

**F-D3 [~] Planos de comodato — CONSTRUÍDO o motor (migration 049), falta a
troca de opção e as telas.** O dono fechou o desenho em 17/09/2026 e ele está
na RN-43 e na seção 10 de `docs/economia-da-rede.md`. O que já roda, provado
de ponta a ponta pelo fluxo real de aprovação de ponto (12 conferências):
as duas opções com os números certos, o plano incluído concedido na mesma
transação que cria o ponto, o crédito de R$ 50 abatendo a mensalidade, a
trava que impede quem recebe a ajuda de custo de assinar catálogo, e a
garantia de que conta que já pagava não perde o plano ao virar ponto.
**Falta, e está aberto:**
· **F-D3.1/3.2 [x]** — a troca de modalidade existe, com mão única de propósito:
  trocar a ajuda de custo por tela o dono do ponto faz sozinho; voltar a
  receber só pelo admin. Construído e provado em 17/09/2026 (RN-43).
· **F-D3.2** — a página pública do comodato e o painel do dono do ponto ainda
  mostram os textos antigos ("o triplo de vezes na tela"), que a 049 corrigiu
  no banco mas ninguém conferiu no navegador.
· **F-D3.3 [x]** — o dono do ponto aparece na tela dele. Decidido e
  construído em 17/09/2026 (RN-44), fechando o item 28 junto.
· **F-D3.4 [x]** — confirmado pelo dono em 17/09/2026: o crédito NÃO acumula
  por ponto. Dono de três pontos tem R$ 50, não R$ 150.

### Itens reportados

**1. [x] CRÍTICO — pagamento confirmado não credita o ciclo; a conta nunca
ativa.**
> **FECHADO em 17/09/2026, conferido no banco de produção, não no código:** a
> conta 3 (San Company) está `status=comum`, `plano_id=essencial-3m`,
> `data_expiracao=2026-12-16`, com 1 cobrança confirmada e 2 assinaturas — ou
> seja, o ciclo aplicou. Havia 0 eventos de assinatura pendentes em aberto.
> O item ficou aberto no documento depois de já ter sido resolvido; a linha
> estava mentindo sobre o estado do sistema. *(Reportado em 15/09/2026, pagamento real de teste no sandbox:
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

**2. [~] E-mail não chegou (nem do Mostraí, nem da Asaas).**
*Mostraí:* a premissa mudou. Era "consequência do item 1, porque
`aplicarCicloPago` nunca rodou" — mas ele rodou (item 1 fechado acima). Então
se o e-mail não saiu, o problema é o SMTP mesmo, e é o item 9 da fila do dono:
senha de app do Gmail recusada com `535-5.7.8`.
*Como saber agora, sem esperar outro pagamento:* **admin → Eventos pendentes →
"Testar agora"** (`GET /admin/diagnostico/smtp`, construído em 17/09/2026).
Faz o login no servidor sem mandar mensagem e diz na hora se a senha passou.
O dono trocou a variável no Northflank em 17/09; falta ele clicar e ver.
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

**22. [x] Varredura de lógica da playlist.** **FEITO em 16/09/2026** (o que
era conserto mecânico). *(Pedido do dono: "rode novamente o site em busca de
qualquer erro de lógica, principalmente na playlist".)*
· **Consertado: o comprovante de veiculação mostrava o dia errado.**
  `janela_hora` é `timestamptz` e a sessão do Postgres roda em UTC, então
  `date_trunc('day', ...)` cortava o dia em UTC e não em Matão. Tudo o que
  rodava ANTES das 21h caía no dia anterior. Medido com três exibições do
  mesmo dia (9h, 15h e 21h30 de Matão): o painel partia em dois dias, 6
  exibições em 15/09 e 3 em 16/09. Agora sai um dia só, 16/09, com as 9.
  Valia nos três lugares — CSV do comprovante, gráfico do painel do
  anunciante e painel da própria TV — e no rótulo da barra, que usava
  `new Date(dia).getDate()` e voltava um dia no navegador brasileiro.
· Os outros achados **não viraram código**, porque mexem no que os planos
  vendem: estão logo abaixo, como decisão do dono.

**23. [x] A frequência que o plano vende agora é a que a tela entrega.**
**FEITO em 16/09/2026**, depois do "procure uma solução pra isso".
· **O furo:** o gerador montava uma lista com `frequencia_hora` cópias de cada
  anunciante e o player tocava a lista em LAÇO. A lista não tinha relação
  nenhuma com os 3600 segundos da hora, então a frequência entregue era
  "quantas voltas cabem na hora". Um anunciante na rede: vendia 3, entregava
  **180**. Trinta anunciantes: vendia 12, entregava 5. O produto piorava 36×
  conforme a rede desse certo.
· **A solução: a hora virou um orçamento de 3600 segundos**, gasto nesta
  ordem — exibição contratada, cota do dono do ponto, e o resto vira espaço
  vago. O espaço vago é preenchido com a peça institucional que o player JÁ
  TINHA (`#vazio`, "Este espaço pode ser do seu negócio"), então o inventário
  não vendido passa a vender a própria rede em vez de repetir de graça o
  anúncio de quem pagou por três.
· **As exibições são espalhadas pela hora**, não sorteadas: três vezes por
  hora amontoadas em cinco minutos não é três vezes por hora.
· **Medido depois**, vídeo de 20s:

  | cenário | vende | entregava | entrega agora |
  |---|---|---|---|
  | 1 anunciante | 3x/h | 180x/h | **3x/h** |
  | Essencial + Destaque + Máximo | 3 / 6 / 12 | 25 / 49 / 106 | **3 / 6 / 12** |
  | 30 anunciantes (rede vendida) | 12x/h | 5x/h | 6x/h, e o corte vira evento |

· **Efeito colateral bom:** `vezes_programadas` e `vezes_confirmadas` voltaram
  a ser comparáveis, então o déficit da RN-10 volta a funcionar e o custo por
  exibição para de despencar quanto mais vazia a rede estiver.
· **A vitrine não mudou uma palavra** — ela já dizia "3x por hora em cada
  ponto". O que mudou foi a tela passar a cumprir.
· **O que o dono precisa saber:** no lançamento, o anunciante deixa de receber
  180 exibições por hora e passa a receber as 3 que comprou. Hoje isso não
  atinge ninguém (a única assinatura viva é a conta de teste do próprio dono),
  e é por isso que este era o momento de consertar. A alternativa — entregar o
  excedente como bônus declarado — está registrada na RN-39 com o motivo de
  não ter sido escolhida.
· **O player agora acorda na virada da hora**, com atraso de alguns segundos
  derivado da chave do aparelho. Sem isso a TV tocaria até 15 minutos da hora
  anterior enquanto o servidor já contava na hora nova, e a conta não fechava.
  O atraso por chave evita que a rede inteira bata no servidor no mesmo
  segundo.
· Telas trocadas: `src/lib/pacing.js` (reescrito), `src/playlist/gerador.js`,
  `public/player.page.js`, `public/player.css`, `tests/pacing.test.js`
  (16 testes, dos quais 12 novos). RN-09, RN-10, RN-39 e RN-40 em
  `docs/funcional.md`.

**24. [x] O teto da playlist passou de slots para segundos.** **FEITO junto do
item 23** — era a mesma conta. A RN-09 antiga dizia "200 slots por hora, trava
sobre os 240 slots teóricos", e os 240 só existiam com vídeo de 15s. Com 30s,
200 slots davam 6000 segundos numa hora de 3600: metade do programado não
cabia e virava déficit que a hora seguinte nunca quitava (medido: déficit
oscilando em 1 a 4 por hora, para sempre). Agora o orçamento é 3600s e o
déficit fica em zero nas mesmas condições.

**25. [x] Exibição tocada offline nunca é contada.** *(FECHADO em 17/09/2026 pela decisão do dono: passada uma hora sem rede, a tela para de exibir anúncio e fica só na peça da Mostraí, agora com telefone e QR code. Virou a RN-47.)* *(Mesma varredura.)* O
player toca do cache quando a internet cai — está escrito na tela, "offline,
tocando playlist em cache" — e o `POST /played` de cada exibição é
`fire-and-forget` com `.catch(() => {})`, sem fila e sem retentativa. O
anúncio rodou, o comerciante viu, e o painel do anunciante não conta.
Conserto: guardar as confirmações não entregues no `localStorage` e enviá-las
na volta da conexão, com a hora em que aconteceram. Pequeno e isolado, mas
mexe na contagem que fatura — por isso não entrou junto do conserto de fuso.

**26. [x] Confirmação de exibição não tem teto.** *(FECHADO em 17/09/2026, tratado como bug a pedido do dono: o teto é `vezes_programadas`, e reenvio da TV responde 200 com `contou:false` em vez de erro. Virou a RN-46.)* *(Mesma varredura.)*
`confirmarExibicao` faz `vezes_confirmadas = vezes_confirmadas + 1` sem
comparar com `vezes_programadas`. A rota diz, com razão, que uma chave válida
não pode inflar quem não estava na playlist — mas pode inflar sem limite quem
estava. Hoje isso é até necessário, porque o laço do player confirma muito
mais do que programou (item 23); depois que o 23 for decidido, isto vira uma
trava de uma linha. **Não mexer antes do 23.**

**27. [x] `limiteDeCriativos` trava em 3 e o upload não sabe disso.** *(FECHADO em 17/09/2026: teto duro de 3, decidido pelo dono, recusado na gravação do plano com o motivo na mensagem. Virou a RN-48.)*
*(Mesma varredura.)* `src/playlist/gerador.js` limita a rotação a 3 criativos
por conta, como trava de segurança contra um zero a mais no admin. Mas o
upload (`POST /anunciantes/:id/criativos`) aceita o que `limite_criativos`
disser. Se o dono criar um plano com 5 criativos, o cliente sobe 5, o plano
vende 5, e a tela roda 3 — sem aviso em lugar nenhum. Hoje é latente (o maior
plano tem 3). Ou os dois números passam a sair do mesmo lugar, ou o admin
avisa que acima de 3 não roda.
> **Atualização de 17/09/2026:** a grade nova encosta o Máximo EXATAMENTE no
> teto (3 criativos). Continua latente, mas sem folga nenhuma: o próximo
> plano que o dono criar com 4 já cai no furo, sem aviso em lugar nenhum. O
> conserto barato é `limiteDeCriativos` parar de ter o 3 escrito na mão e o
> admin recusar plano acima do que o gerador roda.

**28. [x] Anunciante que também é dono de ponto não roda na própria tela.**
*(FECHADO em 17/09/2026 pela decisão do dono: "sim o dono do ponto passa na própria tela". Virou a RN-44. A exclusão só sobrevive enquanto a tela tiver cota de autoanúncio > 0, que é o único caso de aparecer em dobro.)*
> **Ficou PIOR com a grade nova (17/09/2026), e continua aberto.** Agora ele
> pode ESCOLHER o próprio ponto em `PUT /anunciantes/me/pontos` — a rota
> aceita, porque só confere limite do plano e status `em_operacao`. Gasta uma
> das 3 (ou 7, ou 10) vagas de cobertura que pagou num ponto onde
> `anunciantesElegiveis` vai excluí-lo de qualquer jeito. Antes era uma tela a
> menos de graça; agora é uma vaga paga que some sem aviso. A decisão do dono
> continua sendo a mesma pergunta (pode ou não pode aparecer na própria tela),
> mas a correção mínima, valha o que valer a resposta, é a rota avisar em vez
> de aceitar em silêncio.
*(Mesma varredura; é o furo "papéis cruzados" da `docs/furos.md` que nunca
teve decisão.)* `anunciantesElegiveis` exclui `dono_conta_id` da rotação paga
daquela tela. Quem é as duas coisas paga cobertura de "todos os pontos",
recebe o desconto de comodato (RN-32) e fica de fora justamente da tela que
está no próprio balcão — onde os clientes dele passam. Entra só pela cota de
autoanúncio, que não é contada nem cobrada. Pode ser de propósito (evita
aparecer duas vezes), mas não está escrito em regra nenhuma, e o passo 9 do
`docs/funcional.md` promete o contrário: "o vídeo entra na playlist de todas
as telas ativas".

**29. [x] DECISÃO DO DONO — a dívida de superlotação não é registrada, e sem
ela a folga de 15 minutos não tem o que saldar.**
> **FECHADO em 17/09/2026, e o esclarecimento do dono mudou o que a regra é.**
> A folga nunca foi estoque reservado nem dívida a saldar: é tolerância de
> RELÓGIO. "Não pode passar de 1 hora, mas digamos que passe alguns minutos,
> aí sim pode deixar passar" — ou seja, a peça que começou dentro da hora e
> terminou depois dela. O `played` dessa peça chega numa hora que não é a
> dela, e agora é creditado à hora anterior (RN-46). Não existe dívida a
> registrar porque não existe dívida: existe atraso de segundos. O texto
> abaixo é o registro da leitura ANTERIOR, que estava errada. *(Achado em 16/09/2026,
quando o dono lembrou que "caso aconteça superlotamento de anúncios existe a
regra de 15 minutos de flexibilidade".)*
· **A regra existe e está bem desenhada** — `docs/economia-da-rede.md` seção
  4, item 5, e `docs/proximas-versoes.md`: reservar os primeiros ~15 minutos
  de cada hora só pra saldar o déficit da hora anterior, em vez de ele
  competir de novo pelo mesmo corte. **Nunca foi construída**: não existe uma
  linha de código de folga em `src/lib/pacing.js` nem em `src/playlist/`.
· **E, como está escrita, ela não funcionaria.** Medido numa rede
  superlotada estável (30 anunciantes de 12x/h, pedido de 7200s numa hora de
  3600s):

  | hora | contratou | programou | confirmou | déficit registrado |
  |---|---|---|---|---|
  | 1 a 6 | 12 | 6 | 6 | **0** |

  O anunciante deixa de receber 6 exibições por hora, todas as horas, e o
  déficit fica em zero. `gravarProgramados` grava em `vezes_programadas` o
  número DEPOIS do corte proporcional, então `deficit = programadas −
  confirmadas` não enxerga nada. A folga de 15 minutos chegaria e não teria
  dívida pra saldar.
· **A raiz:** o `deficit` de hoje compensa **falha de entrega** (tela
  offline, vídeo que não tocou) e não **falta de inventário** (rede vendida
  além da hora). São duas dívidas diferentes, e só a primeira está escrita.
· **O conserto tem três partes, nesta ordem:**
  1. **Registrar o contratado separado do programado.** Uma coluna aditiva
     em `exibicoes_contador` (`vezes_contratadas`) guardando o que o plano
     prometia naquela hora, antes do corte. Sem isso nada mais funciona, e é
     também o que permite ao painel do anunciante dizer a verdade quando a
     rede estiver cheia.
  2. **A folga de 15 minutos, na definição do dono** (corrigida por ele em
     16/09/2026): os 15 minutos são **tolerância**, não inventário
     reservado. A hora inteira continua vendável; o que muda é que a virada
     deixa de ser parede — exibição programada numa hora conta como entregue
     se acontecer até 15 minutos depois. É a mesma janela que resolve o
     problema do item 26 (confirmação chegando contra o contador da hora
     nova) e o do item 25 pela metade.
  3. **O freio que impede a dívida de crescer pra sempre.** A tolerância não
     cria capacidade: se a rede for vendida estruturalmente acima dos 3600
     segundos por hora, a dívida cresce até o infinito de qualquer jeito. O
     freio já existe no banco e não está ligado: `planos.vagas` /
     `vagas_restantes`, que a vitrine já sabe mostrar. A conta de quantas
     vagas cabem sai direto do orçamento de 3600 segundos (ver item 30).

**30. [x] A lógica da rede chegou em 17/09/2026 — desenhada, revisada, e
CONSTRUÍDA no mesmo dia, em cinco fatias.** *(Fechada em 17/09/2026. O que
segue abaixo é o registro do desenho e da revisão; o que foi construído está
resumido logo aqui.)*
> **O que foi ao código** (commits `6feb525`, `797018e`, `0c821bc`,
> `b96bae3`, `c5b2840`; migrations 045, 046 e 047):
> - **Motor** — a hora virou orçamento de 3600s (RN-09) e o plano passou a
>   vender TEMPO, não repetição (RN-39): `segundos_por_hora`, com as
>   inserções saindo de `floor(segundos / duração)`. O corte proporcional
>   passou a ser medido em segundos e o que sobra vira peça institucional
>   (RN-40).
> - **Cobertura por pontos** (RN-42) — `pontos_incluidos` mais a tabela
>   `anunciantes_pontos`; o contratante escolhe no painel, e quem não escolhe
>   cai numa distribuição automática ESTÁVEL (hash de `conta-ponto`), que dá
>   sempre o mesmo resultado mas redistribui quando a rede cresce.
> - **Duração como benefício** (RN-41) — `duracao_maxima_segundos`, com o
>   upload recusando acima do teto, e os seis textos que prometiam "15 a 30
>   segundos" corrigidos.
> - **Remoções autorizadas** — preço travado (mecanismo + rótulo, no mesmo
>   commit, como este item exigia) e bônus de tela após N meses. Pontos
>   ficaram com dois status: `a_instalar` e `em_operacao`.
> - **Grade** — Essencial 90s/h · 3 pontos · 15s · 1 criativo · R$ 99;
>   Destaque 120s · 7 · 20s · 2 · R$ 249; Máximo 180s · 10 · 30s · 3 ·
>   R$ 449. A vitrine DERIVA horas/pontos/duração/criativos dos campos do
>   plano; a tabela de benefícios guarda só o que é qualitativo.
>
> **Das cinco armadilhas da revisão, quatro estão fechadas:** Master e tela
> ao vivo (cancelados pelo dono), problema do lançamento (resolvido pela
> promessa "cobre até N pontos"), e a armadilha do parceiro (morreu junto com
> a trava de preço). **Continua latente a da cortesia** — `plano_cortesia`
> some da margem —, que só morde quando existir cobrança externa.
>
> **Continua aberto:** o item 28 (dono de ponto pode escolher o próprio
> ponto e ser excluído dele, agora gastando vaga paga) e o item 29 (dívida de
> superlotação não registrada). E nada disso é verificável de ponta a ponta
> antes do primeiro ponto instalado — o que passa a ser a próxima trava real.

*Registro do desenho e da revisão, como chegou:* O dono trouxe: anunciante escolhe em quais pontos anuncia,
plano limitado por número de pontos, ponto cheio sai da escolha, quem não
escolhe roda sorteado entre os livres, plano Master sob consulta, tela de
pontos com playlist ao vivo, e planos que evoluem com a rede preservando o
preço do parceiro.
· **O desenho inteiro, com as contas refeitas e os problemas encontrados,
  está na seção 6 de `docs/economia-da-rede.md`.** Resumo do que a revisão
  achou, tudo verificado no código:
  1. Com o plano de entrada dando 3 pontos numa rede de 3 pontos, a escada de
     preço não fica fraca — ela deixa de existir. Saída proposta: entrada = 1
     ponto ("o ponto da sua rua"), que vende bem já no primeiro dia.
  2. O limite de 15s deixa de ser necessário: ele existia pra espremer slots
     de uma hora fixa, e agora o inventário cresce com os pontos.
  3. **Armadilha do Master:** `liberar-plano` grava `plano_cortesia = true` e
     a receita do admin exclui cortesia — um Master de R$ 2.000 cobrado no
     Asaas ficaria invisível na margem. Precisa separar cortesia de cobrança
     externa antes.
  4. **Armadilha do parceiro:** migrar a conta pra versão nova do plano faz
     `mesmoPlano` virar falso em `aplicarCicloPago` e reescreve
     `valor_mensal_travado` com o preço novo — o contrário do direito de
     manter o preço.
  5. **Armadilha da tela ao vivo:** autoplay de vídeo pra cada visitante
     reabre o erro de saída de vídeo já registrado em `docs/erros/`. Caminho
     seguro é thumb em rotação, e uma rota de leitura pura que não programe
     contador.
· **Decidido em 17/09/2026** (seção 6.8 de `docs/economia-da-rede.md`):
  Essencial 3 pontos / 3x/h / 10s · Destaque 7 pontos / 6x/h / 15s · Máximo
  todos os pontos / 12x/h / 30s. Plano Master cancelado, tela ao vivo
  cancelada. A escolha de pontos é do contratante que já paga: marca até o
  limite do plano, ou deixa desmarcado e o sistema escolhe.
· **A decisão resolveu 3 das 5 armadilhas** — Master (cancelado, e a
  armadilha da cortesia vai junto, latente), tela ao vivo (cancelada) e o
  problema do lançamento, que o dono resolveu por um caminho melhor que o
  proposto: duração e frequência sustentam a escada enquanto os pontos se
  equivalem.
· **Ajustes de 17/09/2026 (segunda rodada):** Máximo ganhou teto de 10
  pontos (não é mais "todos"). O preço travado sai — o dono não pretende
  mexer nos planos, então o mecanismo perdeu a razão de existir, e com ele
  cai a armadilha do parceiro na troca de versão. **Atenção ao tirar:** 9
  dos 12 planos da vitrine hoje carregam o rótulo "Preço fundador, nunca
  muda" e o painel diz "Preço travado por N meses" — o rótulo e a frase têm
  que sair no MESMO commit, senão o site promete o que o código não faz
  mais. A vitrine passa a dizer "cobre até N pontos da rede", que é honesto
  em qualquer tamanho. Os pontos passam a ter dois status só: a instalar e
  em operação.
· **A conta de preço foi feita** (seção 7 de `docs/economia-da-rede.md`) e
  achou um problema grande: com pontos × frequência × duração crescendo
  juntos, o Máximo consome **40x** o Essencial e custa **4x**. O preço por
  1000 segundos de tela fica em R$ 3,06 no Essencial e **R$ 0,31** no
  Máximo — espalhamento de 9,9x. Numa rede de 10 pontos, só Essencial rende
  R$ 39.600/mês e só Máximo rende R$ 3.990: **a mesma rede rende dez vezes
  menos se o degrau de cima vender bem.** Quatro grades alternativas estão
  calculadas em 7.4, com a recomendação (opção E: frequência igual pra
  todos, escada por pontos e duração, R$ 99 / 249 / 449 — abaixo do
  concorrente nos três degraus).
· **Continuam abertas** (seção 6.9): o preço com três eixos; o direito do
  parceiro na troca de versão (`mesmoPlano` reescreve o preço travado); a
  vitrine não poder prometer ponto que não existe (a rede tem ZERO pontos
  ativos hoje, conferido em produção); "15 a 30 segundos" escrito em seis
  lugares que viram mentira com 10s; e o fato de que nada disso é
  verificável de ponta a ponta antes do primeiro ponto instalado.
· **Impacto na esteira — a avaliação mudou, e vale dizer por quê.** A leitura
  inicial foi "é escopo novo sobre produto no ar, abre como v2". O dono optou
  por construir dentro da Estação 5, e a decisão se sustenta porque o motor
  antigo estava ERRADO, não só pequeno: vendia N repetições e entregava
  "quantas voltas cabem na hora" (item 23), com a entrega piorando 36x
  conforme a rede crescesse. Isso é depuração, não escopo novo — e a
  cobertura por pontos é a forma correta do mesmo conserto. Com zero cliente
  pagante, o custo de fazer agora é o menor que jamais será.

**30.1 [ ] (o cálculo de vagas que originou o item, mantido)**
*(O dono perguntou em 16/09/2026 quantas vagas cabem numa hora e disse que
daria a lógica da rede ao chegar em casa. As contas abaixo já estão feitas e
esperam essa lógica pra virar código.)*
· **Quantas exibições cabem numa hora:** de **120 a 240**, conforme a
  duração das peças — 3600s ÷ 30s = 120, 3600s ÷ 15s = 240.
· **Quantas CONTAS cabem**, com a duração virando benefício do plano
  (Essencial até 15s, os outros até 30s):

  | plano | consumo | % da hora | rede só disso | teto de receita |
  |---|---|---|---|---|
  | Essencial 3x de 15s | 45 s/h | 1,3% | 80 contas | R$ 7.920/mês |
  | Destaque 6x de 30s | 180 s/h | 5,0% | 20 contas | R$ 3.980/mês |
  | Máximo 12x de 30s | 360 s/h | 10,0% | 10 contas | R$ 3.990/mês |

  Misturas: 6:3:1 dá **30 contas** e R$ 4.770/mês; 1:1:1 dá 18 contas e
  R$ 4.182/mês; 1:2:3 dá 12 contas e R$ 3.388/mês.
· **O que muda tudo:** hoje TODO plano é `todos_pontos` e o gerador não
  filtra anunciante por tela — então esse teto é da **REDE INTEIRA**, não por
  tela. Instalar mais telas aumenta o alcance de cada anunciante, não o
  número de vagas. Pra vender mais contas só há três caminhos: peça mais
  curta, frequência menor, ou tornar a `cobertura` real (o anunciante compra
  um ponto em vez de todos), que é o desenho parado na seção 4 do
  `docs/economia-da-rede.md`. É provavelmente disso que trata a "lógica da
  rede" que o dono vai trazer.
· **Observação de preço, que não é minha decisão:** Máximo e Destaque custam
  praticamente o mesmo por segundo de tela (R$ 3,08 e R$ 3,07 por 1000s,
  assumindo 12h de comércio aberto). Quem sobe de Destaque pra Máximo paga o
  dobro e recebe o dobro, sem desconto por volume. O Essencial fica em
  R$ 6,11 — o dobro dos outros. A escada é coerente de Essencial pra
  Destaque e plana de Destaque pra cima.
· **O que está pronto pra construir assim que a lógica chegar:**
  `duracao_maxima_segundos` como campo de contrato do plano (o ffmpeg já mede
  a duração no upload), impresso como benefício na vitrine, com todos os
  planos existentes entrando em 30s pra nada mudar até o dono atribuir.
· **Enquanto nada disso for construído**, o que protege a rede é o evento
  `playlist:teto_corta` (já existe) e o aviso antecipado
  `playlist:hora_quase_cheia` a partir de 80% de ocupação (construído hoje,
  item 23) — os dois são sinal pro dono, não trava automática.

---

**Onde a lista está em 16/09/2026 (fim do dia).** Dos 30 itens, 21 estão
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

---

## F.1 — Revisão do dono, tópico 1 (sem login): telas conferidas

Uma seção por tela, na ordem em que o dono navegou. Cada linha é o que ele
relatou, do jeito que relatou, e o que saiu feito.

### Home — [x] sem ajuste
Relatado em 17/09/2026: *"a home estava completa já, nada a consertar nela"*.

### Planos (`/planos.html`) — [x] rodada de 17/09/2026

**P1. [x] "O que mexe no mensal mexe no trimestral também."**
O dono pediu "ideia correta sobre o que mexe só no mensal e o que mexe em
todos". A regra, conferida linha a linha no banco de produção e no
`src/financeiro/planos-repository.js`:

> **O produto é do tier. A oferta é do ciclo.**

Uma linha de `planos` é **um tier × um ciclo** — "Essencial trimestral" é uma
linha, "Essencial anual" é outra. São 12 linhas na vitrine (3 tiers × 4
ciclos), e o seletor da página só troca qual grupo de 4 aparece.

| Campo | Escopo certo | O que o admin faz hoje |
|---|---|---|
| `nome`, `rotulo` | **do tier** — igual nos 4 ciclos | edita um cartão só |
| `segundos_por_hora`, `pontos_incluidos`, `duracao_maxima_segundos`, `limite_criativos` | **do tier** | edita um cartão só |
| `valor_mensal_cheio` | **do tier** (é o preço de referência) | edita um cartão só |
| benefícios (o vínculo) | **do tier** | edita um cartão só |
| benefícios (o **texto**) | **do catálogo** — muda nos 12 planos de uma vez | edita em Benefícios |
| `desconto_percentual` (e o `valor_mensal` que sai dele) | **do ciclo** | certo |
| `ativo`, `destaque_no_site`, `vagas` | **do ciclo** | certo |

Ou seja, o que o dono sentiu tem duas caras, e as duas são reais:
· mexer num campo **de tier** num cartão só **não** propaga pros outros três —
  a vitrine passa a prometer coisas diferentes com o mesmo nome em abas
  diferentes, e nada avisa;
· mexer no **texto** de um benefício propaga pros doze de uma vez, sem versão
  nova, porque `beneficios` é catálogo compartilhado.

**O que não dá pra fazer:** travar no banco. A RN-27 versiona plano por
edição de contrato (id novo, `-vN`), e os quatro ciclos não versionam juntos
— uma trava de igualdade recusaria a primeira das quatro edições legítimas.

**O que foi feito:** a aba Planos do `/admin` passa a **comparar os quatro
ciclos de cada tier** e abrir um aviso em cima quando eles discordam, dizendo
o tier, o campo, e qual valor está em qual ciclo. Junto, uma legenda fixa com
a tabela acima em duas linhas. Conferido: **nenhuma divergência hoje na base
de produção** (os 12 planos estão coerentes).

**P2. [x] "Esse primeiro texto está desatualizado, já que agora mudou para
horas por mês."** A lead falava em tempo de tela *"a cada hora"* — que é a
conta de dentro (`segundos_por_hora`), não o número grande que o card mostra.
Reescrita em horas por mês.

**P3. [x] "Retire o 'Planos de lançamento' lá do começo e substitua os 3
textos."** O chapéu tinha prazo de validade embutido: no dia em que o
lançamento acabasse, ficaria mentindo na primeira linha da página de preços.
Os três viraram:
· chapéu → **"Anuncie nas telas de Matão"**
· título → **"Escolha quantas horas de tela a sua marca tem por mês"**
· texto → **"Três coisas mudam de um plano para o outro: quantas horas de
  tela você tem por mês, em quantos pontos da rede a sua peça aparece, e
  quanto ela pode durar. Os pontos quem escolhe é você. E quanto mais tempo
  você fica com a gente, menos paga por mês."**

**P4. [x] "Nos planos o título vem primeiro e o subtítulo embaixo; aqui está
ao contrário."** Trocada a ordem no card da vitrine **e** no cartão do admin,
que é o espelho dele de propósito. O subtítulo deixou de ser chapéu laranja
(em cima do nome funcionava como etiqueta; embaixo competiria com o próprio
nome) e virou linha de apoio cinza.

**P5. [x] Achados na mesma passada, não relatados pelo dono:**
· a pílula **"-10%" saía riscada** junto com o preço cheio — `text-decoration`
  desce pros filhos em fluxo e item de flex não é caixa inline atômica, então
  o `text-decoration: none` da pílula não segurava. O risco passou pro `<span>`
  do preço;
· a **nota do ciclo** ("você paga uma vez a cada 3 meses") estava DEPOIS da
  caixa de aviso da rede, e o `margin-top` negativo dela — feito pra encostar
  no seletor — puxava a nota pra debaixo do aviso, longe do que ela explica.
  Subiu pra logo abaixo do seletor;
· no celular o seletor de ciclo **quebrava em duas linhas desalinhadas**
  (2 em cima, 2 embaixo, larguras diferentes), exatamente o que o comentário
  do CSS dizia estar resolvido. Virou grade 2×2 de colunas iguais abaixo de
  460px.

**P6. [ ] Para o dono decidir (dado, não código):** na aba **Mensal** nenhum
card tem a faixa **"Mais escolhido"** — `destaque_no_site` é `false` nos três
planos mensais e `true` nos outros nove. É campo de vitrine, de ciclo, e a
troca é um clique no `/admin` → Planos. Não mexi: é escolha comercial.

#### Planos — segunda leva do dono (17/09/2026)

**P7. [x] Benefícios do card enxutos.** Saiu "X min de tela a cada hora" (a
conta de DENTRO — mesma grandeza do total do mês em outra unidade) e saiu
"Comprovante em planilha". "Painel com cada exibição confirmada, ponto a
ponto" virou **"Dashboard intuitivo"**. Ficaram horas/mês, pontos, duração da
peça e criativos. O comprovante foi **desativado, não apagado** (migration
053): o vínculo com os 12 planos continua e a exportação em CSV continua no
painel — o que saiu foi o anúncio dela.

**P8. [x] Botões.** Os três em laranja, **menos o "Mais escolhido", que é
azul** — é o que diferencia ele de relance numa linha de três botões iguais.
Mesmo azul da borda e da faixa do card. Os três cards já ficam da mesma
altura (`align-items: stretch` da grade) e os botões agora descem pro pé
(`.plan-card .btn { margin-top: auto }`): antes o Pro, que tem dois
benefícios a mais, deixava os três "Assinar" em alturas diferentes.

**P9. [x] O aviso laranja passa a ter UMA contagem só.** Ponto **ativo** é o
que já tem cadastro na rede — em operação **mais** esperando instalação. A
vitrine não separa os dois ("Hoje a rede tem 3 pontos"); quem separa é o
admin. O desenho de status fica em aberto, por decisão do dono, pra quando
ele chegar na aba do admin.

*Ressalva registrada uma vez, e a decisão é dele:* a contagem única conta
ponto que ainda não veicula. Quem lê "a rede tem 3 pontos" e assina o
Essencial (3 pontos) pode entender que aparece em 3 telas hoje. O que segura
isso é a RN-49 logo abaixo, no mesmo aviso: enquanto nem todos veiculam, o
tempo se concentra, e o painel mostra o número exato. Com 1 ponto no ar o
Essencial recebe **as 27 horas/mês contratadas inteiras** — então a promessa
de horas é cumprida mesmo quando a de lugares ainda não é.

**P10. [x] O bônus da RN-49 no painel virou HORAS POR MÊS.** Estava em
segundos por hora, que é a unidade do motor: o cliente comprou horas por mês,
é assim que o card vende, e trocar de unidade no meio obrigava ele a
multiplicar por 12 e por 30 pra saber se ganhou algo. Os campos
`segundos_por_hora_base` e `segundos_por_hora_hoje` saíram da resposta de
`/anunciantes/me/pontos-disponiveis` — ninguém lia, e campo que ninguém lê
dessincroniza calado.

**P11. [x] Teto da RN-49 confirmado pelo dono: 600 segundos** (um sexto da
hora por anunciante). Fica como está.

*Cenário real do lançamento, conferido:* 1 ponto instalado + 2 a instalar.
O Essencial (3 pontos) recebe 27 horas/mês — o contratado inteiro, com uma
tela só no ar. O Pro chega a 60 das 84 e o Prime a 60 das 180, os dois no
teto. A rede **nasce cobrindo o Essencial**, como o dono previu.

**P12. [ ] Fica pro dono, na aba Planos do admin:** o comportamento dos
planos (e o desenho de status de ponto) é conversa da revisão do `/admin`, não
desta tela. Nada foi mexido no motor além da RN-49.

### ONDE PARAMOS NA ABA PLANOS (17/09/2026) — retomar por aqui

A parte visual da tela de Planos está fechada e no ar. **O que ficou em
aberto é uma coisa só, e é do motor:** qual é o divisor da RN-49.

**Decisão do dono, tomada em 17/09/2026:** contar **todos os pontos já
cadastrados**, inclusive os `a_instalar`, no divisor — "assim não bate no teto
nunca". Ele acrescentou que isso não precisa ser passado ao cliente final, e
que a correção entra **no dashboard quando a revisão continuar**. Por isso
NÃO foi implementado ainda: está marcado aqui, não construído.

**O número que o dono ainda não tinha quando decidiu** (medido com a função de
verdade, no cenário do lançamento — 1 ponto no ar + 2 a instalar):

| | contratado | A) divisor = quem veicula (hoje) | C) divisor = todos os cadastrados (decidido) |
|---|---|---|---|
| Essencial | 27 h/mês | **27 h** (integral) | **9 h** |
| Pro | 84 h/mês | 60 h (teto) | 28 h |
| Prime | 180 h/mês | 60 h (teto) | 60 h |
| hora da tela, 1 assinante de cada | — | 41% | 27% |

É verdade que C **nunca bate no teto** — o Prime encosta nele exatamente e os
outros ficam abaixo. O que o teto deixa de fazer, porém, a divisão faz no
lugar: **C entrega menos que A em todos os planos**, e no Essencial derruba de
27h (o contratado inteiro) para 9h. Ou seja, C não tira o teto do caminho —
troca o teto por uma entrega menor, que é o problema que a RN-49 nasceu pra
resolver.

Duas saídas possíveis pra quando voltarmos, e as duas atendem "não bater no
teto" sem derrubar a entrega:
1. **Divisor = quem veicula, e teto maior.** Com 900s (1/4 da hora) o Pro
   entrega as 84h inteiras e o Prime chega a 90h de 180.
2. **Divisor = todos os cadastrados, com piso.** A entrega nunca cai abaixo do
   que o anunciante receberia sem a regra nenhuma — hoje C já respeita isso,
   mas por acidente, não por construção.

Nada disso bloqueia a revisão: o que está no ar é A (divisor = quem veicula,
teto 600s), que é o comportamento mais generoso dos dois.

**Retomada combinada:** o dono está longe do PC, então a revisão segue pelo
**celular** (tópico 1, metade mobile). A aba Planos volta depois, junto com a
revisão do `/admin`, onde o comportamento dos planos e o desenho de status de
ponto já estavam marcados pra ser conversados.


### Revisão do dono, tópico 1 — metade CELULAR (17/09/2026)

Varredura das 16 páginas sem login a 390px (iPhone), medida no navegador, não
lida no código.

**Limpo em todas:** nenhuma rola na horizontal, nenhum erro de JS, menu mobile
com 48px por item, botão do WhatsApp já com o respiro que tira o conteúdo de
baixo dele, nenhum campo sem rótulo.

**M1. [x] Duas promessas que o sistema não cumpre mais.** Era o F-D3.2, que
estava marcado como "corrigido no banco, não conferido no navegador".
· `seja-um-ponto.html` dizia *"todo ponto tem uma cota própria na tela"* — a
  cota foi zerada na migration 049, quando a contrapartida virou plano de
  verdade — e *"com alguns meses de tela no ar você ainda ganha um período de
  plano de anúncio na rede inteira"*, que era o `ponto_apos_meses` removido por
  autorização do dono. "Rede inteira" também nunca valeu na grade nova: são
  até 3 pontos.
· `index.html` prometia *"o triplo de espaço na tela"* a quem abre mão dos
  R$ 50. Conferido no banco: `comodato-basico` são 45s/hora e `essencial-1m`
  são 90s — é o **dobro**, e em pontos da rede, não "na tela".
· Os dois agora dizem o que o contrato de comodato já dizia. Ele era a única
  das três peças que estava certa, e virou a fonte.

**M2. [x] Campo de formulário fazia o iPhone dar zoom sozinho.** Todos os
campos estavam em `.95rem` (15,2px), um fio abaixo do limiar de 16px do
Safari do iOS: ao focar o campo, o navegador amplia a página e ela fica torta
no meio do cadastro. Agora 16px no celular; no desktop nada muda.

**M3. [x] Alvo de toque.** Seletor de ciclo de 36px → 44px; olho da senha de
30px → 44px. O menu do próprio site já usava 48px, então esses dois eram os
únicos abaixo do piso na mesma tela.

**M4. [x] Sobra de CSS:** `.senha-olho { position: absolute }` estava
declarado duas vezes, quatro linhas uma da outra.

**Erro meu no meio da varredura, registrado porque a lição é geral:** o
servidor local caiu e minha medição deu "ok" em seis páginas — a página de
erro do Chrome não rola na horizontal e não tem campo nenhum, então passa por
limpa. O medidor agora confere que a página é a página (`main` ou `form`
presente) antes de medir, e grita quando não é. **Medidor sem prova de carga
não mede nada; ele só concorda.**

**M5. [x] Textos encurtados para leitura no celular (pedido do dono,
17/09/2026: "explicações ficam muito grandes, quem quer rapidez precisa de
texto mais curto").**

Medido antes de reescrever, a 390px, ranqueado por quanto cada bloco ocupa da
tela — palpite não decide o que cortar:

| página | texto corrido antes | depois | |
|---|---|---|---|
| index | 1,54 telas | **0,91** | −41% |
| planos | 0,89 | **0,44** | −51% |
| pontos | 0,86 | **0,60** | −30% |
| seja-um-ponto | 0,67 | **0,53** | −20% |
| contato | 0,65 | **0,56** | −14% |
| seja-um-vendedor | 0,61 | **0,55** | −10% |

**O pior bloco era o aviso da Planos: 138 palavras, 0,61 de uma tela** — e ele
fica entre o seletor de ciclo e os preços, no caminho de quem tem pressa.
Metade dele era da mesma rodada. Virou **48 palavras (0,26 de tela)**: fica
visível só o que muda a decisão de comprar — quantos pontos existem, que a
cobrança começa no pagamento, o bônus em uma linha e os 7 dias de
arrependimento. A mecânica inteira do bônus desceu para um `<details>`
("Como isso funciona"), conferido por teclado: foca, Enter abre, Enter fecha,
anel de foco presente.

**Uma decisão de método:** não existem duas versões do texto, uma pro celular
e outra pro desktop. Um texto de 50 palavras numa chamada é longo demais nas
duas telas, e manter duas versões é garantir que uma delas envelheça sozinha
(a regra de "texto nasce num lugar só"). Onde o detalhe é necessário de
verdade, ele fica no mesmo texto, recolhido.

**`comodato.html` NÃO foi encurtado, de propósito.** São 4,5 telas de texto,
de longe a maior — mas é o contrato, e quem abre aquela página foi ler. Cortar
cláusula para caber na tela é o oposto do que o documento existe para fazer.

**Também saiu:** o respiro entre seções no celular (64px+64px viravam 128px de
nada por emenda — 15% da tela, e a Planos tem quatro antes dos preços). Agora
36px no celular, desktop intacto. E a menção ao "comprovante em planilha" na
home, último lugar que ainda o anunciava depois da migration 053.

**M6. [x] O aviso laranja ficou só com a rede (pedido do dono, 18/09/2026).**
A ressalva da cobrança e os 7 dias de arrependimento saíram da vitrine e foram
para a **tela de pedido** — é lá que a pessoa decide pagar; na vitrine eram
interrupção no meio de quem ainda estava escolhendo. O aviso ficou com uma
coisa só, agora dita por inteiro: o tamanho da rede **e até quantos pontos a
cobertura dos planos vai**, que é o que faltava pra "faltam pontos" significar
alguma coisa.

> Rede em montagem: 3 pontos hoje. A cobertura dos planos vai até 10 pontos,
> então hoje ainda faltam telas pra completar os maiores. **Você não paga por
> ponto que não existe:** o tempo dos que faltam vai pras telas já no ar.
> *Como isso funciona +*

45 palavras: 219px no celular, 142px no desktop. Os 7 dias continuam ditos na
FAQ da mesma página, no contrato do anunciante e na confirmação da assinatura.

**M7. [x] BUG na tela de pedido: ela descrevia o plano no modelo ANTIGO.**
Achado ao mover o texto. A confirmação dizia `${plano.frequencia_hora}x por
hora em cada tela` — o modelo de antes da grade por segundos (migration 045).
Era a última frase que o cliente lia antes de pagar, e descrevia outro
produto. Agora diz o mesmo do card: *"Essencial — até 27 horas de tela por mês
na rede, em até 3 pontos, peça de até 15s"*. Conferido de ponta a ponta com
conta criada e logada, em dois planos.

**M8. [x] `horas_por_mes` passou a vir do SERVIDOR** (`GET /planos`), com a
função de `src/lib/pacing.js`. O número já era calculado à mão na vitrine e no
admin, e a tela de pedido ia virar a terceira cópia — que é como três telas
passam a prometer números diferentes pro mesmo plano. Campo novo, nada
removido.

*Duplicação que fica registrada, e não foi mexida nesta passada:*
`horasDeTelaPorMes` ainda existe à mão em `public/planos.page.js` e em
`public/admin/index.page.js`. Com o campo no payload, as duas podem passar a
lê-lo — é um passo próprio, e misturar com esta mudança deixaria a revisão
maior do que precisa.

**M9. [x] Corrida fechada no aviso.** Ele passou a precisar dos planos (pra
dizer "até N pontos") e os dois `fetch` corriam soltos: numa rede lenta o
aviso montava antes e saía com "mais pontos" em vez do número. Provado com
`/planos` atrasado 1,5s no navegador — o tipo de corrida que nunca aparece na
máquina de quem escreve e sempre aparece no celular.

---

## G. GUARDADO PRA DEPOIS DA REVISÃO — grade de horas e banco de horas

Conversado com o dono em 17/09/2026, **não construído**, e explicitamente
adiado por ele: *"vamos ir por revisão primeiro e deixe guardado essas coisas
por enquanto"*. Nada aqui está no ar. Registrado porque a conversa tinha
números que não se refazem de cabeça.

### G.1 A conta de inventário que faltava

O dono apontou que ela nunca tinha sido feita: **pontos × horas do mês**.

Um ponto tem **360 h de vitrine por mês** (12 h de comércio aberto × 30 dias).
A trava real, porém, não é o mês — é a **hora**: em cada tela, a soma de todos
os anunciantes tem que caber em 3600 s.

| plano | s/hora | h por ponto/mês | % da tela | h TOTAL | consome da rede/hora |
|---|---|---|---|---|---|
| Essencial | 90 | 9 h | 2,50% | 27 h | 270 s |
| Pro | 120 | 12 h | 3,33% | 84 h | 840 s |
| Prime | 180 | 18 h | 5,00% | 180 h | 1800 s |

**O achado mais importante, e ele não tem nada a ver com a RN-49:** os planos
escalam em DOIS eixos ao mesmo tempo — mais segundos *e* mais pontos. O efeito
no preço por unidade de estoque:

| | preço | consome | **R$ por 1000 s de rede** |
|---|---|---|---|
| Essencial | R$ 99 | 270 s/h | **R$ 367** |
| Pro | R$ 249 | 840 s/h | R$ 296 |
| Prime | R$ 449 | 1800 s/h | **R$ 249** |

O Prime custa 4,5× o Essencial e come **6,7×** o inventário: **quem paga mais
é quem paga menos pelo estoque**, 32% mais barato por segundo de rede. Isso
existe desde antes de qualquer conversa desta rodada.

### G.2 As horas do plano — CORRIGIDO pelo dono em 18/09/2026

**Esta seção estava errada e foi refeita.** Eu tinha registrado que o dono
queria **27 h em cada ponto**. Ele corrigiu: *"eu quis dizer somente os pontos
totais do plano ser 27 horas, não cada ponto ser 27 horas (…) no Essencial, ao
invés de ser 27 horas cada ponto, é 27 horas por 3 pontos"*. Vale igual pro
Pro e pro Prime, e **todos os pontos consomem o mesmo tempo da hora**.

**Isso é exatamente o que o sistema faz hoje** (conferido na função de
verdade, `horasDeTelaPorMes`, em 18/09/2026):

| plano | total do plano | dividido em | em cada ponto | consumo por hora |
|---|---|---|---|---|
| Essencial | **27 h** | 3 pontos | 9 h | 90 s, igual em todos |
| Pro | **84 h** | 7 pontos | 12 h | 120 s, igual em todos |
| Prime | **180 h** | 10 pontos | 18 h | 180 s, igual em todos |

**Consequências de o registro estar errado, e agora não estar:**

1. **Não há mudança de 3× a fazer.** O que eu tinha anotado (27 h por ponto)
   seria triplicar a grade.
2. **O "excesso de horas" que ele temia não existe neste eixo.** O estouro que
   eu media — o Prime consumindo 5400 s por hora, mais de um ponto inteiro só
   pra ele — só aparecia na leitura errada. Com o total preservado, o Prime
   consome 1800 s por hora da rede, que é o de hoje.
3. **O que continua valendo do G.1 é o desequilíbrio entre os tiers** (o Prime
   paga 32% menos por segundo de rede que o Essencial). Esse achado independe
   desta correção e segue aberto.
4. A moldura que ele fechou **já está no ar**: o plano vende *horas totais na
   rede, divididas entre os pontos*, e o card diz assim.

*Lição pra mim, registrada onde não se perde: eu tinha os dois números
(o total e o por ponto) e escolhi o errado sem devolver a conta pra ele
confirmar. Número de contrato lido de uma frase ambígua se confere repetindo
o número, não repetindo a frase.*

**Alternativa que resolve o desequilíbrio do G.1 junto:** mesmo tempo por
ponto em TODOS os planos (27 h), e o que o plano compra é **cobertura** —
Essencial 3 pontos (81 h), Pro 7 (189 h), Prime 10 (270 h). Aí o R$ por
1000 s vira R$ 122 / R$ 132 / R$ 166, e o card fica óbvio: *"27 horas em cada
ponto; o plano diz em quantos"*. **Ressalva:** isso inverte o desconto por
volume (o plano caro passa a pagar MAIS por unidade), o que é difícil de
vender. O ponto de equilíbrio é uma decisão de preço do dono, não de código.

### G.3 BANCO DE HORAS — ideia do dono, e a válvula que falta

Proposta dele: *"criamos um banco de horas mensal para anúncios que não
couberam; eles ganham prioridade no próximo mês e abatem as horas"*. Resolve
duas coisas de uma vez — o teto da hora e a falta de pontos —, e **torna o
teto da RN-49 desnecessário**: em vez de concentrar agressivamente ou cortar,
entrega o que cabe e guarda o resto com prioridade.

**A ressalva, registrada uma vez:** banco que só enche é **dívida que cresce**.
Se a rede não crescer, passa a existir hora devida que nunca será entregue — e
isso é pior que entregar menos, porque vira promessa escrita com número. Ele
precisa de uma válvula. A mais limpa: prioridade no mês seguinte e, se não
drenar em N meses, o saldo vira **crédito em dinheiro** na conta. Aí a
promessa é sempre cumprível.

**Tamanho do trabalho:** tabela própria (saldo por anunciante), consumo no
gerador da playlist, drenagem com prioridade, e tela no painel. Não é ajuste
de front — é bloco próprio, e por isso foi adiado.

### G.4 Ainda não trazido pelo dono

Ele avisou em 18/09/2026 que há **mais uma atualização do San Checkout, sobre
mudança de plano e cancelamento**, e que traz quando a revisão permitir. As
duas atualizações anteriores já foram lidas e adotadas (RN-50 e RN-51). Esta
ainda **não foi lida** — nada foi assumido sobre ela.

### Revisão do dono, tópico 1 (sem login), passada pelo PC — Home (18/09/2026)

**H1. [x] Card do Ponto prometia dinheiro pra quem escolhe a modalidade que
NÃO dá dinheiro.** *"Sua parede rende dinheiro todo mês (…) está rendendo
dinheiro pra quem? Está louco em afirmar isso."* — o título e o texto do
card citavam "R$ 50 por mês de ajuda de custo" como se fosse a única
recompensa, mas a segunda modalidade do comodato troca o dinheiro por mais
tempo de tela, sem pagar nada. Era a mesma família de erro do "triplo de
espaço" já corrigido em `seja-um-ponto.html` (F-D3.2) — e ficou pra trás
porque a home é uma página separada.

Título → **"Uma tela grátis no seu comércio"**. Texto → **"A gente instala
tudo sem custo pra você. Em troca, escolhe como quer ser recompensado."**
O valor exato (R$ 50, ou o dobro de tempo de tela) fica só em
`seja-um-ponto.html` e no contrato de comodato — os dois lugares que já
versionam esse número quando o dono mexe nele pelo admin. O `data-ajuda-custo`
que buscava o valor em `/planos-ponto` só existia pra preencher essa frase;
saiu junto com ela, do HTML e de `index.page.js`.

**H2. [x] "Como funciona" — passo a passo curto, sem explicação longa.**
Cada um dos 4 passos perdeu a explicação (prazo de "menos de dois minutos",
regra de cobertura, formato 9:16, etc.) e ficou com uma frase funcional. O
detalhe continua dito na tela onde a pessoa de fato executa cada passo
(cadastro, upload, painel) — nada se perdeu, só saiu do lugar que é vitrine.

**H3. [x] Os 4 cards de "Por que funciona" encurtados.** O eyebrow, o título
e o lead da seção ficaram como estavam — o dono disse que gostou.

**H4. [x] Botão "Ver planos e preços" → "Ver planos" em todo lugar que
redireciona pra `/planos.html`.** Dois no `index.html` (hero e o antigo
fecho) e um em `404.html` ("Ver os planos" → "Ver planos"). Botões de ação
dentro do painel do anunciante ("Escolher plano", "Trocar de plano") não
mudaram — são outra ação, não "ver".

**H5. [x] A home não termina mais num botão de planos.** *"Só não gostei
dessa finalização (…) coloque a página de contatos ali, somente o formulário
e a resposta rápida do WhatsApp e outros canais."* A seção final
("Esteja presente. Seja lembrado." + botão) foi substituída por um atalho de
contato embutido: o mesmo formulário de `contato.html`, o card de resposta
rápida (WhatsApp) e o de outros canais (e-mail) — **sem** o card de
Privacidade/LGPD, que fica só na página `contato.html` completa, de onde a
FAQ de direitos do titular já é linkada. O link **Contato** do menu continua
apontando pra página inteira, como pedido. `contato.page.js` (o script do
envio) é genérico — mesmos ids, reaproveitado sem duplicar lógica.

Conferido no navegador nos dois tamanhos, envio do formulário testado
(mock da API): sem "R$ 50" na home, sem menção a LGPD, `npm run check`
verde (sintaxe + lint + formato + 92 testes), sem rolagem horizontal no
celular.

**H5.1 [x] "Esteja presente. Seja lembrado." volta pra home** — o dono pediu
pra manter, só que entre "Por que funciona" e o novo bloco de contato (não
mais como o fecho da página). Botão corrigido pra **"Ver planos"** (era
"Ver planos e preços"), na mesma regra do H4.

### Revisão do dono, tópico 1 (sem login), rodada 3 — Home (18/09/2026)

**H6. [x] "Tem um comércio? / Quer indicar?" colavam um no outro no
celular** e o toque num link acertava o outro por engano. Cada convite virou
um bloco próprio (`<span>`), lado a lado no desktop — cabem numa linha — e
empilhados com 12px de respiro abaixo de 480px. Conferido no navegador: os
dois blocos ficam a 12px de distância, sem sobreposição.

**H7. [x] Os três CTAs dos cards agora começam com "Quero".** Anunciante:
"Ver planos e anunciar" → **"Quero anunciar"**, e o link deixou de ir pro
cadastro solto e passa a levar direto pra `/planos.html` — é lá que a
pessoa escolhe o plano antes de criar a conta. Ponto: "Quero uma tela no
meu comércio" → **"Quero ser ponto"**. Vendedor: já estava certo, sem
mudança.

**H8. [x] Card do Anunciante: "painel" → "dashboard"**, alinhando com o
mesmo termo do benefício "Dashboard intuitivo" que os planos já usam.

**H9. [x] Passo 2 ("Suba seu vídeo") ganhou o link de contato** depois de
"A gente ajuda": quem não tem arte pronta agora tem o caminho, não só a
promessa. Mesma convenção do resto do site (`<a href="/contato.html">Fale
com a gente</a>`).

**H10. [x] Passos 3 e 4 reescritos pelo dono:**
· Passo 3 — "Aprovamos o criativo e já começa a anunciar" / "O anúncio
  entra nos pontos, normalmente no mesmo dia."
· Passo 4 — "Acompanhe o desempenho" / "Veja no seu dashboard exclusivo
  quantas vezes seu anúncio foi visto."

**H11. [x] Razão 4 de "Por que funciona" reescrita:** "Você troca o anúncio
quando quer" / "Promoção nova? Novo anúncio? Pode subir de onde estiver,
com só alguns cliques, e entra no ar logo após a aprovação."

Conferido nos dois tamanhos, `npm run check` verde (92 testes), sem
rolagem horizontal no celular.

### Revisão do dono, tópico 1 — Planos, rodada 4 (18/09/2026)

**P13. [x] Os três textos do topo, reescritos pelo dono:**
· chapéu: "Anuncie nas telas de Matão" → **"Anuncie nas nossas telas"**
· título: **"Escolha o plano ideal para dar mais visibilidade à sua marca"**
· texto: **"Personalize sua campanha: defina o tempo de exibição, a
  quantidade de pontos e a duração de cada anúncio."**

A cidade continua dita no `<title>` e no `<meta description>` da página —
não se perdeu, só saiu do chapéu.

**P14. [x] O aviso laranja explica a mecânica do bônus, não só promete
ela.** O dono: *"deixe um pouco melhor, igual estava antes (…) explique
bem essa parte"* — a versão anterior (rodada M9) dizia só "você não paga
por ponto que não existe" sem dizer O QUE acontece. Agora a frase visível
diz o mecanismo com as palavras do próprio dono: **"Planos que cobrem mais
pontos do que a rede tem hoje (até N pontos) ganham horas bônus, divididas
entre os pontos já ativos — até a rede completar a cobertura do plano."**
O `<details>` "Como isso funciona" continua existindo pra quem quer a
mecânica completa (como a hora se concentra, o teto por tela, e que o
bônus some sozinho conforme a rede cresce).

Medido no celular: 50 palavras visíveis, 244px (29% da tela) — mais
explicativo que a rodada anterior (26%) e ainda longe do que a versão
original de 138 palavras/61% ocupava.

Conferido nos dois tamanhos, com rede parcial real (2 no ar + 1 a
instalar): eyebrow/h1/lead e o aviso completo (visível + `<details>`
aberto) batendo com o texto pedido, `npm run check` verde (92 testes), sem
rolagem horizontal no celular.

### Revisão do dono, tópico 1 — Planos, rodada 5 (18/09/2026)

**P15. [x] Aviso laranja movido pra cima do seletor de ciclo.** Ordem
antiga: seletor → nota do ciclo → aviso de rede. Nova: **aviso de rede →
seletor → nota do ciclo.** Conferido no DOM e nas duas telas.

**P16. [x] "Como eu cancelo?" atualizada — já existe autoatendimento.**
A resposta mandava falar com a gente por WhatsApp/e-mail pra algo que o
próprio painel já resolve sozinho: o botão **"Cancelar assinatura"**
(`btnCancelarAssinatura`, `painel.page.js`). A FAQ agora aponta pro botão
primeiro.

**P17. [x] "Quando meu anúncio começa a rodar?"** perdeu o parêntese
"(dá pra fazer pelo celular)" — informação certa, mas redundante: o painel
já é responsivo em toda parte, não precisa ser dito aqui.

**P18. [x] "Não tenho vídeo. Dá pra anunciar assim mesmo?" reescrita e
reorganizada em dois parágrafos**, corrigindo uma promessa que não é mais
verdadeira: a versão antiga dizia *"ou te indica quem grava um vídeo na
sua loja"* — a Mostraí **não grava conteúdo no comércio do anunciante**.
Agora:
· 1º parágrafo — o que está incluído: o cliente manda logo, fotos, um
  vídeo que já tenha e o contato pelo WhatsApp; a Mostraí edita e monta o
  anúncio; isso é parte do plano (cobre a veiculação).
· 2º parágrafo — o que é serviço à parte: produção profissional com
  equipe, preço combinado antes de qualquer cobrança (RN-45, sem mudança).

**P19. [x] Pergunta "Vou receber nota fiscal?" removida.**

### P20. [ ] "O preço pode subir depois que eu assinar?" — NÃO ALTERADA,
e o motivo fica registrado aqui

O dono pediu pra mudar a resposta: *"o checkout aceita troca de preço,
então sim, mudanças aconteceram — e isso entra como um dos pontos de
mudanças na atualização do checkout"* (a terceira atualização pendente do
San Checkout, sobre troca de plano e cancelamento — ver seção G.4, ainda
não detalhada por ele).

**Não mudei o texto ainda**, porque essa garantia não vive só nesta FAQ —
ela é **RN-11** (`docs/funcional.md`, sustentada pela versão de plano da
RN-27: quem assina fica na versão que aceitou) e está **também escrita no
Termos de Uso** (`termos-de-uso.html`: *"Os planos (…) e valores vigentes
são sempre os exibidos (…) no momento da contratação"*). Trocar só a
resposta da FAQ deixaria o site contradizendo o próprio contrato: FAQ diz
que o preço pode mudar, Termos de Uso diz que não.

Antes de tocar nisso preciso saber, do dono: a regra NOVA é que o preço
**pode mesmo subir pra quem já assinou** (revogando a RN-11), ou é algo
mais específico — por exemplo, o Checkout **agora permitindo** trocar o
valor cobrado de uma assinatura ativa é uma capacidade técnica nova, que
não obriga a Mostraí a usá-la pra reajustar quem já pagou. A resposta a
essa pergunta decide se RN-11, esta FAQ e o Termos de Uso mudam juntos, ou
se nada muda e a resposta atual continua certa. Fica esperando o resto da
atualização do Checkout (G.4), como ele mesmo combinou.

Conferido: 9 perguntas na FAQ (era 10), textos batendo com o pedido nos
dois tamanhos, `npm run check` verde (92 testes), sem rolagem horizontal.

### Revisão do dono, tópico 1 — Planos, rodada 6 (18/09/2026)

**P18.1 [x] Correção sobre "Não tenho vídeo?": a versão da rodada 5 estava
errada.** O dono: *"não tem nada de criação de anúncio incluída em plano
nenhum, é pagamento à parte pelo WhatsApp"* e *"retire a ideia de que
falaremos com equipe de vídeos profissionais"*. A resposta anterior tratava
a montagem do anúncio como incluída no plano ("isso está incluído no
plano, que cobre a veiculação") — contradizia a RN-45 (produção é serviço
à parte, negociado, preço caso a caso), que já estava certa desde antes
desta rodada de revisão. Reescrita:

> Dá. A produção do seu anúncio é negociada direto pelo WhatsApp: você
> manda o que tiver — logo, fotos, um vídeo — e a gente combina o que dá
> pra fazer com isso. É cobrado um valor extra pela criação do anúncio,
> que varia com a dificuldade de montar a peça. A gente não faz vídeo
> profissional (filmagem, produção com equipe) — só o que você já tem em
> mãos.
> **Fale com a gente no WhatsApp.**

O link usa a convenção do resto do site (`data-wa` + `href` literal, pra
funcionar mesmo sem JS — `layout.js` reescreve pela constante única do
número em `config.js`).

**P20 — confirmado pelo dono, continua pendência.** Sobre "o preço pode
subir depois que eu assinar": *"sim, pode ser (…) deixe como pendência a
se resolver quando eu enviar a nova atualização do checkout."* Sem
mudança na FAQ, RN-11 ou Termos de Uso — como já estava registrado.

**Sobre "o aviso laranja ainda não atualizou": não é bug.** Conferido em
produção: `GET /pontos` devolve `[]` (zero pontos cadastrados) e o
`planos.page.js` servido já é a versão nova (contém a frase "Você não
paga por ponto"). O aviso mostra só **"Rede em montagem: nenhum ponto
ainda."** porque é exatamente o que a regra manda: o parágrafo do bônus só
entra com pelo menos uma tela **veiculando** — sem nenhuma tela no ar não
existe pra onde concentrar o tempo, e o texto completo com "Como isso
funciona" apareceria prometendo algo que a rede vazia não cumpre. Ele
aparece assim que o primeiro ponto for cadastrado como `em_operacao`.

### Revisão do dono, tópico 1 — Planos, rodada 7 (18/09/2026)

**P21. [x] "peça"/"criativo" → "anúncio" em todo texto da vitrine.**
Termo técnico continua no código, no banco e nos comentários — só a
palavra que o cliente lê muda. `derivados()` em `public/planos.page.js`
reescrita: "Anúncio de até N segundos", "N anúncios por vez, que revezam
entre si". Migration `054_beneficio_anuncio_nao_peca.sql` renomeia o único
benefício de catálogo com a palavra antiga vinculado a plano **ativo** (id
17, nos quatro planos Pro): "Sua peça entra na frente na fila de
aprovação" → "Seu anúncio tem prioridade de aprovação". Os outros três
benefícios com "criativo" (ids 1, 4, 12) estão presos a versões
**arquivadas** (RN-27) e não aparecem em lugar nenhum da vitrine — não
precisam mudar.

**P22. [x] Subtítulo do card (`rotulo`) volta à cor laranja** —
`var(--brand-text)`, revertendo o cinza (`var(--text-dim)`) de uma rodada
anterior. Pedido explícito do dono ao revisar o card do Essencial.

**P23. [x] Contorno leve em cada botão do seletor de ciclo** (Mensal /
Trimestral / Semestral / Anual), pra distinguir um do outro agora que
ficaram juntos sem espaço: `.cycle-toggle button` ganha
`border: 1px solid var(--border)`; o botão ativo continua sobrescrevendo
com `border-color: var(--brand)`.

**P24. [x] Benefícios de cada plano reescritos com a lista exata que o
dono ditou**, na ordem dele: Essencial — horas de tela por mês, "Em até N
pontos da rede, escolhidos por você", "Anúncio de até N segundos", "N
anúncio(s) ativo(s) por vez" (mais dashboard, que já existia); Pro e Prime
herdam "Tudo do [tier anterior]" e listam só o que muda. Números de horas
mantidos como o **cálculo real produz** (84h Pro, 180h Prime) — o dono
ditou 90h/200h de cabeça, mas a própria mensagem fecha dizendo que vai
acertar preços e benefícios de verdade depois desta revisão; não troquei
o número certo pelo aproximado dele. Ele confirma/corrige quando fechar
os preços.

**P25. [x] Bloco de preço redesenhado para os ciclos acima de Mensal**
(Trimestral/Semestral/Anual — Mensal continua com o preço simples de
sempre). Três linhas, nessa ordem, em `montarPreco()`
(`public/planos.page.js`):
1. Valor cheio do **ciclo inteiro** riscado + badge de desconto (não é
   mais o valor mensal riscado).
2. Valor total do ciclo já com desconto, em destaque (número grande).
3. "Você economizou R$X." — a diferença entre as duas linhas acima, ou
   seja, **sempre a economia do ciclo inteiro, nunca a mensal** — seguida,
   numa segunda linha separada, de "Equivalente a R$Y/mês." em cor normal.

Nota abaixo do seletor de ciclo simplificada para uma frase por ciclo
(`NOTA_CICLO`): "Você paga uma vez a cada N meses"/"por ano".

**P25.1 [x] Correção no meio da rodada — interrupção do dono:** *"o vc
economizou x é o valor inteiro do ciclo não do mês e o faça verde."*
Conferido com conta manual e com Playwright contra o servidor local, nos
três planos × três ciclos (9 combinações): a economia **já era** a do
ciclo inteiro (ex.: Essencial Trimestral — R$297,00 − R$267,30 =
R$29,70; não R$99,00 − R$89,10 = R$9,90, que seria a mensal). Não havia
bug de cálculo, só a cor pendente. Feito:
- "Você economizou R$X." pintado em verde (`var(--ok)`, `#15803d` — o
  mesmo tom usado nos checks de benefício e nas mensagens de sucesso do
  site, contraste 4.5:1+ no fundo branco do card).
- "Equivalente a R$Y/mês." separado pra linha de baixo, em cor normal
  (`var(--text-dim)`), a pedido do dono nessa mesma interrupção.

Verificado com Playwright (desktop 1280px e mobile 390px), nos três
ciclos acima de Mensal: cor da linha da economia = `rgb(21, 128, 61)`
(verde), cor da linha "Equivalente" = `rgb(91, 100, 114)` (cinza normal),
valores batendo com o cálculo manual em todas as 9 combinações.

**P26. [x] FAQ "Não tenho vídeo?" reescrita, tom mais formal** — o dono:
*"ficou muito informal, retire os — e deixe mais formal."* Removidos os
travessões da versão da rodada 6; texto reorganizado em frases completas,
sem mudar o conteúdo (produção é serviço à parte, negociado pelo
WhatsApp, sem gravação profissional).

### G.5 [ ] Pendência nova: fluxo de cadastro de ponto ("seja um ponto")

O dono tentou cadastrar um ponto ele mesmo durante esta revisão e achou o
caminho **"completamente bagunçado"** — palavras dele, sem mais detalhe
ainda sobre o que especificamente está errado. **Registrado como
pendência, sem investigação nem tentativa de conserto nesta rodada** —
ele vai descrever o que viu, ou eu confiro o fluxo do zero, numa rodada
futura.

**Consequência direta:** o dono pediu explicitamente pra **adiar a
revisão do aviso laranja** (o parágrafo de bônus por rede em montagem,
P-anteriores desta seção) **até depois** que o caminho de "seja um ponto"
estiver corrigido — faz sentido revisar o aviso sobre pontos só depois que
o cadastro de ponto em si estiver confiável. Nenhuma mudança no aviso
laranja nesta rodada por causa disso.

Conferido: `npm run lint` e `npm run check` verdes, Playwright confirma os
três planos nos quatro ciclos (desktop e mobile), migration 054 aplicada
localmente e testada.

**P25.2 [x] "Você economizou" e "Equivalente a.../mês" também no Mensal.**
Pedido do dono, ainda na mesma revisão do bloco de preço: *"adicione o
texto de economia e o texto de equivalência no mensal também, assim fica
todos iguais mesmo que não entre diferenças claras."* O Mensal não tem
desconto pra comparar (não existe `cheio` nesse ciclo), então as duas
linhas entram com o resultado literal disso — "Você economizou R$0,00." e
"Equivalente a R$X,00/mês." (igual ao próprio preço) — só pra manter a
mesma estrutura visual nos quatro ciclos, sem esconder que aqui não há
economia real. Sem linha riscada no Mensal (não pedida, e não há valor
cheio diferente pra riscar).

### Revisão do dono, tópico 1 — Onde estamos, rodada 1 (18/09/2026)

**P27. [x] Texto de abertura sem travessão e com CTA.** O dono: *"retire
aquele travessão do texto e coloque um cta melhorado nesse texto
horrendo."* O parágrafo virou frase corrida sem travessão, e ganhou um
convite embutido pra quem está avaliando anunciar:

> Cada ponto é gente esperando: a cadeira do salão, a espera da academia, a
> mesa do restaurante. Sua marca aparece neles, e ponto novo entra na sua
> cobertura sem custo a mais. **Veja os planos e comece a anunciar** →
> `/planos.html`.

O CTA de baixo da página ("Seu comércio pode ser o próximo" → `/seja-um-
ponto.html`) já fala com quem quer HOSPEDAR uma tela; este de cima fala
com quem quer ANUNCIAR — os dois papéis que a página atende, cada um com
seu convite.

**P28. [ ] Poluição visual do mapa — pendência aberta, esperando decisão
do dono.** Ele: *"no mapa será que não tem como omitir todas essas
localizações [restaurante, hospital, mercado etc.] atrapalhando a
visualização dos locais de pontos?"* O mapa é um `<iframe>` do embed
gratuito do Google (`maps.google.com/maps?q=...&output=embed`, sem chave
de API) — nesse modo o Google não aceita nenhum parâmetro pra desligar a
camada de pontos comerciais; só dá pra fazer isso customizando o estilo
do mapa, e customizar estilo só existe na Maps JavaScript API, que exige
projeto no Google Cloud com cobrança ativa e chave própria (**não é** o
Google Workspace que ele já paga — são produtos e faturamento
diferentes, confirmado a ele nesta rodada). Três caminhos, aguardando
escolha dele:
1. Trocar por um mapa sem chave (Leaflet + tiles CartoDB, estilo claro
   sem ícone de comércio) — sem custo, mas é a primeira dependência
   externa carregada por CDN no projeto (hoje é tudo self-hosted, sem
   build step).
2. Google Maps com estilo customizado — resolve de verdade, mas exige
   cadastrar cartão e criar chave no Google Cloud (autorização dele antes
   de qualquer mudança de cobrança, como sempre).
3. Manter o Google como está, só ajustar zoom/enquadramento — sem custo,
   mas não resolve a poluição visual, só reduz a área visível.
**Nenhuma mudança no mapa nesta rodada** até ele responder.

**P29. [x] Foto de exemplo do "ponto completo" — agora trocável pelo
admin, sem deploy.** O dono: *"essa foto do ponto completo deve ser
possível ser trocada no painel do admin quando eu quiser trocá-la."* Não
é foto de nenhum ponto real (isso já existe, por ponto, em
`foto_instalacao_url` — `/admin/pontos/:id/foto`); é a ilustração
genérica do totem montado, hoje um arquivo estático
(`/img/exemplo-ponto-completo.jpg`). Como o filesystem do container é
efêmero e a esteira roda 2 instâncias, sobrescrever o arquivo local não
funcionaria (não persistiria no redeploy, e uma instância não veria o
que a outra escreveu) — a foto tem que morar no mesmo bucket público do
Supabase Storage que já guarda avatar de anunciante e criativo:
- Migration 055: tabela `configuracoes_site` (chave/valor genérica,
  extensível pra outras configurações de site no futuro), guardando a
  URL da foto customizada sob a chave `foto_exemplo_ponto_url`.
- `POST /admin/pontos/foto-exemplo` — mesmo padrão de upload das fotos
  de ponto (multer → Supabase Storage, chave fixa `site/exemplo-ponto-
  completo.jpg`, `upsert: true`), grava a URL pública (com `?v=` de
  cache-bust) na configuração.
- `GET /pontos/config` — pública, devolve a URL customizada ou `null`.
- `pontos.page.js` troca a `src` da foto só quando existe customização;
  sem nenhuma troca, continua a imagem estática de sempre.
- Painel admin, aba **Pontos**: novo bloco com upload e link "ver foto
  atual" (ou aviso de que ainda é a padrão), acima do cadastro manual de
  ponto.

**P30. [x] Legenda da foto simplificada.** O dono: *"o texto abaixo dele
deve ter somente 'assim fica nosso totem completo'."* Trocado
`<figcaption>` de "Assim fica um ponto completo. A moldura cobre a TV e
só a marca do anunciante aparece." para **"Assim fica nosso totem
completo."**

Conferido: `npm run lint` e `npm run check` verdes (92 testes), migration
055 aplicada localmente, Playwright confirma o texto de abertura, a
legenda nova e o fallback da foto (sem customização, mostra o arquivo
estático) em `pontos.html`.
