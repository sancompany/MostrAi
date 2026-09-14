# Mostraí — pendências (atualizado 14/09/2026, após o fecho da Estação 2)

Projeto em `D:\SanCo\MostrAi`, espelhado em
`github.com/sancompany/MostrAi` (branch `main` + `claude/mostrai-estacao-1-pipeline-y2vgr5`),
repositório **público** por decisão do dono. Do roteiro abaixo só estão feitos
o git (A.1) e os workflows (A.2); todo o resto continua em aberto.

**Estações 1 (Escopo) e 2 (Fronteiras) fechadas em 14/09/2026.** A spec foi
validada pelo dono (escopo de sete para nove itens), e a auditoria de
fronteiras confirmou a classificação (projeto, não estrutura) e a hospedagem
já decidida na Fase 2 — nada mudou. Registro em
`docs/specs/2026-09-12-mostrai.md`, seções "Validação do dono" e "Estação 2 —
Fronteiras". A esteira está na Estação 3 (Fundação, Sonnet médio) — ainda não
aberta.

**Próximo passo real: a seção A.0.1**, que precisa do PC — alinhar a pasta
local e rotacionar as chaves. Só depois disso vale seguir para A.3 em diante
(Northflank incluso) e para o resto da seção B.

## SÓ O DONO FAZ — fila da corrida de 14/09/2026

Ordenada pelo que desbloqueia mais. Cada item: o que fazer · onde · por quê ·
o que trava · quanto leva.

1. **Tornar o bucket `criativos` público.**
   · Supabase → Storage → `criativos` → Settings → *Public bucket*
   · O código serve criativo, avatar e foto de ponto por `getPublicUrl`
     (`src/anunciantes/routes.js:212`, `src/pontos/routes.js:117`,
     `src/lib/ffmpeg.js:45`). Com o bucket privado essas URLs respondem erro.
   · **Trava:** player sem vídeo e avatar quebrado — a Estação 5 não fecha.
   · ~2 min. *(Tentei pela API; o classificador bloqueia criar superfície
     pública sem decisão humana.)*

2. **Health check no serviço.**
   · Northflank → serviço `mostrai` → Health checks → HTTP, path `/health`,
     porta 3000
   · Sem ele o Northflank não reinicia container travado — ele fica no ar
     respondendo erro.
   · **Trava:** item 2 da prontidão operacional (Estação 6).
   · ~3 min.

3. **Confirmar o build e o primeiro deploy verde.**
   · Northflank → serviço `mostrai` → Builds / Deployments, e depois
     `GET /health` respondendo `{"ok":true}`
   · É a evidência que fecha a Estação 5 — "a versão inicial no ar".
   · **Trava:** a Estação 5 inteira.
   · ~5 min. Falhando, me mande o log.

4. **Autorizar o Cloudflare: DNS e Access.**
   · Cloudflare → zona `sancocore.com.br`
   · DNS `mostrai` → o endereço do serviço no Northflank, proxy ligado; e
     Zero Trust → Access → Application no path `/admin*` com o seu e-mail.
   · **Trava:** a exceção nº 2 do `CONSTRAINTS.md` (o `/admin` protegido só por
     senha) e o fecho da Estação 6.
   · ~10 min. **Eu executo assim que você autorizar** — tenho o acesso; mudar
     DNS e permissão está na lista curta da skill `leis`, que exige sua palavra.

5. **Rotacionar as credenciais (A.0.1), na volta ao PC.**
   · Roteiro completo na seção A.0.1 abaixo
   · Metade já morreu com a exclusão do projeto VitrinaADS; sobram
     `SESSION_SECRET` e `ADMIN_PASSWORD`, que já foram gerados novos e estão no
     Northflank. Falta alinhar a pasta `D:\SanCo\MostrAi` **antes de qualquer
     push de lá**.
   · **Trava:** nada da esteira hoje, mas o histórico antigo na sua pasta
     republica o `.env` se alguém der push.
   · ~20 min.

6. **Conferir a primeira execução do job `Backup`.**
   · Northflank → Jobs → `Backup` → Runs, domingo que vem
   · O container roda como `node` (uid 1000); se o volume vier root, o job
     falha com "permission denied".
   · **Trava:** o ensaio de restauração da Estação 6 (`RUNBOOK.md`, seção 5).
   · ~2 min. Falhando, me mande o log que eu ajusto o Dockerfile.

7. **Decidir as quatro perguntas de produto que sobraram.**
   · `docs/PENDENCIAS.md`, seção B
   · Vaga de fundador por 7 dias; comissão sobre renovação; precedência entre
     `preco_travado` e desconto de comodato; e se plano desativado aparece
     apagado em `/planos.html` ou some.
   · **Trava:** os itens 8 e 9 da spec (seção B.1), que são construção da
     Estação 5.
   · ~10 min de decisão.

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

### A.0.1 — Na volta ao PC, NESTA ordem (nada aqui roda sem o PC)

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
- [ ] **Programa fundador**: ligar `PROGRAMA_FUNDADOR_ATIVO=true` só quando quiser vender. Revisar o plano seed `fundador-12m` (R$149 travado 12m, 10 vagas) no admin → Planos → Programa fundador. Os planos normais vieram com o rótulo antigo "Preço fundador — nunca muda" — troque no admin (agora é confuso ao lado do plano fundador de verdade).
- [ ] **Módulos cruzados**: decidir quais planos ganham "tela após N meses" (admin → Planos → coluna "Tela após") e quais opções de comodato ganham "anúncio grátis após N meses" (admin → Opções de comodato → Bônus). Estão desligados (vazios) até você preencher.
- [ ] **Vaga de fundador**: hoje uma assinatura criada e não paga segura a vaga por 7 dias. Ok?
- [ ] **Troca de plano de quem já paga**: o sistema recusa (evita cobrança dupla na Asaas) e manda falar com você. O caminho é: admin → Anunciantes → "cancelar assinatura" (chama o Checkout) → a pessoa assina o novo. Confirmar que é assim que você quer.
- [ ] **Comissão sobre renovação**: hoje o vendedor recebe a cada `cobranca_confirmada` (inclusive renovações). Manter?
- [ ] **Drop do legado** (pede migration própria, com sua permissão): tabela `afiliados`, `pontos.aparelho_id`/`ultima_vez_online`, `exibicoes_contador.ponto_id`, `comissoes.afiliado_id`, `src/financeiro/afiliados-repository.js`, `public/nav-auth.js`, `public/afiliado/*` (hoje são redirects), `src/financeiro/san-checkout-1.js` (cópia antiga que só existe na sua pasta).
- [ ] **Custos fixos**: os seeds (DAS MEI 86,05; Contador 100; Domínio 3,33; Supabase Pro 0; Deslocamento 50) são chute meu — corrija no admin → Custos fixos. Amortização é por tela: preencha custo e prazo de cada TV na aba Telas.
- [ ] **Sessão única por navegador**: cadastrar uma conta no mesmo navegador em que o admin está logado derruba o admin (é o comportamento seguro). Use dois perfis/navegadores pra testar.

## B.1 Construir — decidido em 14/09/2026, ainda não feito

Nasceu do fecho da Estação 1. São os itens 8 e 9 da spec, e a ordem importa: o
9 é pré-requisito do 8.

1. [ ] **Item 9 — plano imutável para quem já assinou.** Editar um plano no
   admin não pode alcançar quem já paga por ele. Hoje a conta guarda só
   `valor_mensal_travado`; nome, benefícios, `limite_criativos`,
   `frequencia_dia` e `cobertura` são lidos ao vivo da linha do plano
   (`src/financeiro/planos-repository.js`, `CAMPOS_ATUALIZAVEIS`). O desenho
   proposto é versionar a linha: editar cria linha nova, a antiga sai da vitrine
   (`ativo=false`) e continua servindo quem está nela — encaixa no `plano_id`
   `text` que já existe. **Condição de entrada: antes da primeira assinatura
   paga.** Com zero assinantes, editar plano ainda é inofensivo.
2. [ ] **Item 8 — desconto de comodato sobre os planos de anunciante.** Um
   desconto por linha da grade (12 valores no admin, livres entre si), separado
   do desconto de ciclo que o anunciante comum já tem. Vale a partir da
   aprovação da conta e nunca é revogado. Aparece pro comodatário como "quando
   sua conta for aprovada você recebe X% em todos os planos". **Fica pendente
   uma regra de precedência**: quem tem `preco_travado` e ganha o desconto de
   comodato — o desconto incide sobre o travado, ou o travado vence? Decidir
   antes de construir.

3. [ ] **Ligar/desligar plano: aviso e confirmação visual.** *(pedido em
   14/09/2026.)* O toggle **já existe** — coluna "Ativo" da tabela de planos,
   `public/admin/index.html:1092`, e `ativo` já está em `CAMPOS_ATUALIZAVEIS`.
   Falta só o acabamento que o dono pediu: um aviso antes de virar a chave, e a
   linha desativada aparecendo **apagada** na lista, marcada "Desativado", em vez
   de só um checkbox mudando de estado. O padrão visual já existe na mesma tela
   (a lista de benefícios usa `opacity:.55` + "(indisponível)") — reaproveitar,
   não inventar. **Em aberto, pergunta do dono:** o plano desativado aparece
   apagado também em `/planos.html` para o cliente, ou some da vitrine como hoje?
   Mostrar ao cliente um plano que ele não pode assinar é decisão de produto, não
   de código.

   *Nota que encolhe o item 1 acima:* `ativo=false` é exatamente a alavanca que o
   item 9 precisa — "a linha antiga sai da vitrine e continua servindo quem está
   nela" é isso, e desativar não quebra assinante, porque a linha continua
   existindo e a conta lê por `plano_id`. O admin já tem também o formulário
   "+ Novo plano (novo preço/promoção — não mexe no que já existe)". Metade do
   item 9 já está desenhada na interface.

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

## C. Malha fina — roteiro do que testar junto comigo

1. Site público: `/`, `/planos.html` (com e sem `PROGRAMA_FUNDADOR_ATIVO`), `/seja-um-ponto.html` e `/seja-um-vendedor.html` (viram candidatura, não conta).
2. Admin → Candidaturas → "Gerar convite" (site) ou "Liberar na conta" (pedido do painel). Copiar link → abrir em outro navegador → `convite.html` → conta nasce com os papéis.
3. Painel único: abas Anúncios / Meu ponto / Vendas sempre visíveis; a bloqueada mostra o card de ativação. Anunciante ativa sozinho (endereço); ponto e vendedor viram pedido que você libera.
4. Admin → Telas: gerar chave, PIN, custo/prazo; player na TV; painel da tela por PIN (5 toques no canto superior direito ou tecla P).
5. Assinar plano → checkout (precisa do Checkout configurado) → webhook `criada` (1ª cobrança) → conta ativa na hora.
6. Vendedor: cupom, link `cadastro.html?ref=CUPOM`, comissão aparece em Vendas e em admin → Comissões.
7. Bônus: plano com "tela após N meses" mostra progresso em Anúncios e vira pedido em Candidaturas; opção de comodato com bônus mostra progresso em Meu ponto e ativa o plano ao resgatar.

## D. Falta construir (registrado em `docs/proximas-versoes.md` com condição de entrada)

Impactos/CPM, comprovante PDF, alertas e dunning, arte como serviço, campanha por período, QR rastreável, mapa com foto, uptime público, assinatura eletrônica, kit do vendedor, cupom de primeira compra, trial, sobretaxa de exclusividade. Mais: e-mail de boas-vindas/convite (hoje o link vai por WhatsApp na mão), testes e2e no CI (precisam de Postgres no workflow — o `ci.yml` já sobe um), e Termos/Privacidade revisados pra v2 (skill `legal` — o inventário de dados está em `docs/inventario-de-dados.md`).

## E. O que mudou nesta aceleração (resumo pra você se situar)

- Backend: contas com papéis; convites e candidaturas; dispositivos (tela) com chave, PIN, custo; playlist por tela; planos modulares (grátis, mínimo de telas, preço travado, fundador/vagas, tela após N meses); opções de comodato com bônus de anúncio; custos fixos; sessão em Postgres; scrypt; webhook fail-closed/idempotente/transacional; painel único com modos.
- Front: `seja-um-ponto`/`seja-um-vendedor` viraram candidatura; `convite.html`; `anunciante/ponto.html` por tela; `anunciante/vendedor.html`; `modos.js` (cards de ativação); `player.html` por tela com cache de vídeo e painel por PIN; `planos.html` com fundador e módulos; admin com Candidaturas, Convites, Telas, Vendedores, Custos fixos e campos novos de plano.
- Docs: `README.md`, `CLAUDE.md`, `CONSTRAINTS.md`, `docs/api.md`, `docs/specs/2026-09-12-mostrai.md`, `docs/precificacao.md`, `docs/proximas-versoes.md`, `docs/inventario-de-dados.md`, `docs/erros/*`, `tests/e2e/README.md`.
- Verificação: 14 unitários + 5 suítes e2e (136 checagens, API e navegador) verdes; revisão independente achou 13 defeitos, todos corrigidos.
