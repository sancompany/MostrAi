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

## A.0 Vazamento de segredo no push inicial — rastro limpo, rotação pendente

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
