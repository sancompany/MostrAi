# Mostraí — pendências (atualizado 14/09/2026, após o fecho da Estação 1)

Projeto em `D:\SanCo\MostrAi`, espelhado em
`github.com/sancompany/MostrAi` (branch `main` + `claude/epic-newton-sc30uz`),
repositório **público** por decisão do dono. Do roteiro abaixo só estão feitos
o git (A.1) e os workflows (A.2); todo o resto continua em aberto.

**A Estação 1 (Escopo) fechou em 14/09/2026** — a spec foi validada pelo dono e
o escopo passou de sete para nove itens. O registro está em
`docs/specs/2026-09-12-mostrai.md`, seção "Validação do dono". A esteira está na
Estação 2 (Fronteiras), que entra como auditoria do que a Fase 2 da spec já
decidiu.

**Próximo passo real: a seção A.0.1**, que precisa do PC — alinhar a pasta
local e rotacionar as chaves. Só depois disso vale seguir para A.3 em diante
(Northflank incluso) e para o resto da seção B.

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
5. [ ] **`npm run migrate`** — aplica 019 (contas com papéis, dispositivos, convites, candidaturas, planos modulares, custos fixos, sessão em Postgres) e 020 (modos da conta, módulos cruzados de plano). São aditivas; nada é apagado.
6. [ ] **`npm test`** (14 unitários) e, se quiser, o roteiro de `tests/e2e/README.md` num Postgres local.
7. [ ] **Suba local (`npm run dev`) e faça a malha fina** — roteiro na seção C.
8. [ ] **Supabase**: projeto próprio do Mostraí (se ainda for o da Vitrina, renomeie), região **sul-americana**. Bucket `criativos`. Anote `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
9. [ ] **Northflank** (não Render): serviço Node a partir da branch `main`, região sul-americana (mesma do Supabase), variáveis do `.env.example` no painel do serviço, `npm run migrate` como comando de release (ou rode uma vez à mão), `npm start`. `/health` responde `{ok:true}`. **Use só as chaves rotacionadas em A.0.1** — nenhuma das antigas. As variáveis vivem no painel do Northflank; nunca num arquivo do repositório.
10. [ ] **Cloudflare**: DNS `mostrai.sancocore.com.br` → Northflank (proxy ligado). **Access na frente de `/admin`** (Zero Trust → Access → Application, path `/admin*`, política: seu e-mail). Fechar a origem pra que só o Cloudflare alcance o serviço.
11. [ ] **San Checkout**: cadastrar o Mostraí como contratante (URL da API, chave, walletId — manual, no banco do Checkout), e combinar `SAN_CHECKOUT_WEBHOOK_SECRET` dos dois lados. Auditar a última estação do Checkout (você disse que falta). **Confirmar se o webhook manda `eventoId`/`cobrancaId`** — sem id, a deduplicação usa hash do corpo + dia (renovação meses depois passa; reentrega no mesmo dia não).
    **Trazer o `API.md` e o `INTEGRACAO.md` do Checkout junto** — ficaram duas
    perguntas do mês grátis esperando por eles, deixadas em aberto de propósito
    no fecho da Estação 1: (a) hoje o mês grátis é creditado **uma vez na vida da
    conta** (`anunciantes.meses_gratis_creditados`); é isso mesmo, ou é a cada
    ciclo? (b) o código estende a cobertura em `compromisso_meses + meses_gratis`,
    mas quem define quando a Asaas cobra é o ciclo da assinatura no Checkout —
    então não dá pra garantir daqui que a pessoa **não seja cobrada** no mês que
    era pra ser grátis. Verificado só do lado do Mostraí.
12. [ ] **Backup**: enquanto o Supabase for Free (sem backup automático), rode `npm run backup` semanalmente (precisa de `pg_dump` no PATH) ou crie um cron job no Northflank. Exceção registrada no `CONSTRAINTS.md`.
13. [ ] **TV Stick**: no admin → Telas → "Gerar chave" → copie o link → abra no navegador/kiosk da TV. Defina o PIN da tela. O link guarda a chave no aparelho; depois disso pode abrir só `/player.html?tela=ID`. Tela vertical é o padrão; `?orientacao=paisagem` desliga o giro. O app kiosk (Fully Kiosk ou similar) é quem trava a tela cheia — o player não promete isso.

## B. Decisões que só você toma (o código já suporta os dois lados)

- [x] **Validar o veredito da Fase 3 da spec** — FEITO em 14/09/2026. Veredito
  confirmado, agora sobre nove itens. Nada do que a aceleração construiu saiu: o
  painel único é a forma do item 2 e os módulos cruzados são o item 4, ambos
  escritos estreito demais na primeira redação. Detalhe em
  `docs/specs/2026-09-12-mostrai.md`, seção "Validação do dono (14/09/2026)".
- [ ] **Programa fundador**: ligar `PROGRAMA_FUNDADOR_ATIVO=true` só quando quiser vender. Revisar o plano seed `fundador-12m` (R$149 travado 12m, 1 mês grátis, mínimo 2 telas, 10 vagas) no admin → Planos → Programa fundador. Os planos normais vieram com o rótulo antigo "Preço fundador — nunca muda" — troque no admin (agora é confuso ao lado do plano fundador de verdade).
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

## C. Malha fina — roteiro do que testar junto comigo

1. Site público: `/`, `/planos.html` (com e sem `PROGRAMA_FUNDADOR_ATIVO`), `/seja-um-ponto.html` e `/seja-um-vendedor.html` (viram candidatura, não conta).
2. Admin → Candidaturas → "Gerar convite" (site) ou "Liberar na conta" (pedido do painel). Copiar link → abrir em outro navegador → `convite.html` → conta nasce com os papéis.
3. Painel único: abas Anúncios / Meu ponto / Vendas sempre visíveis; a bloqueada mostra o card de ativação. Anunciante ativa sozinho (endereço); ponto e vendedor viram pedido que você libera.
4. Admin → Telas: gerar chave, PIN, custo/prazo; player na TV; painel da tela por PIN (5 toques no canto superior direito ou tecla P).
5. Assinar plano → checkout (precisa do Checkout configurado) → webhook → conta ativa ou "aguardando ponto" (mínimo de telas) → cobertura liga sozinha quando a tela entra.
6. Vendedor: cupom, link `cadastro.html?ref=CUPOM`, comissão aparece em Vendas e em admin → Comissões.
7. Bônus: plano com "tela após N meses" mostra progresso em Anúncios e vira pedido em Candidaturas; opção de comodato com bônus mostra progresso em Meu ponto e ativa o plano ao resgatar.

## D. Falta construir (registrado em `docs/proximas-versoes.md` com condição de entrada)

Impactos/CPM, comprovante PDF, alertas e dunning, arte como serviço, campanha por período, QR rastreável, mapa com foto, uptime público, assinatura eletrônica, kit do vendedor, cupom de primeira compra, trial, sobretaxa de exclusividade. Mais: e-mail de boas-vindas/convite (hoje o link vai por WhatsApp na mão), testes e2e no CI (precisam de Postgres no workflow — o `ci.yml` já sobe um), e Termos/Privacidade revisados pra v2 (skill `legal` — o inventário de dados está em `docs/inventario-de-dados.md`).

## E. O que mudou nesta aceleração (resumo pra você se situar)

- Backend: contas com papéis; convites e candidaturas; dispositivos (tela) com chave, PIN, custo; playlist por tela; planos modulares (grátis, mínimo de telas, preço travado, fundador/vagas, tela após N meses); opções de comodato com bônus de anúncio; custos fixos; sessão em Postgres; scrypt; webhook fail-closed/idempotente/transacional; painel único com modos.
- Front: `seja-um-ponto`/`seja-um-vendedor` viraram candidatura; `convite.html`; `anunciante/ponto.html` por tela; `anunciante/vendedor.html`; `modos.js` (cards de ativação); `player.html` por tela com cache de vídeo e painel por PIN; `planos.html` com fundador e módulos; admin com Candidaturas, Convites, Telas, Vendedores, Custos fixos e campos novos de plano.
- Docs: `README.md`, `CLAUDE.md`, `CONSTRAINTS.md`, `docs/api.md`, `docs/specs/2026-09-12-mostrai.md`, `docs/precificacao.md`, `docs/proximas-versoes.md`, `docs/inventario-de-dados.md`, `docs/erros/*`, `tests/e2e/README.md`.
- Verificação: 14 unitários + 5 suítes e2e (136 checagens, API e navegador) verdes; revisão independente achou 13 defeitos, todos corrigidos.
