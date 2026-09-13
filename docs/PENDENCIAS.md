# Mostraí — pendências (atualizado 13/09/2026, após o primeiro push)

Projeto em `D:\SanCo\MostrAi`, espelhado em
`github.com/sancompany/MostrAi` (branch `main` + `claude/epic-newton-sc30uz`).
O código está no git desde 13/09/2026; **só isso foi feito** — todo o resto
desta lista continua em aberto. **Ordem sugerida: A.0 AGORA, depois o resto da
seção A, depois B.**

## A.0 Vazamento de segredo no push inicial — rastro limpo, rotação pendente

O primeiro commit levou o `.env` **real** para o repositório, que é **público**.
Detalhes e causa em `docs/erros/2026-09-13-env-real-em-repositorio-publico.md`.

**Feito em 13/09/2026:** `.gitignore` corrigido, `.env` e `node_modules/` fora
do versionamento, **histórico reescrito** (`filter-branch`) e force-push em
`main` e na branch — nenhum commit alcançável contém mais os arquivos.

**O que ainda não sumiu:** o GitHub continua servindo os commits antigos por
SHA direto; force-push não faz a coleta de lixo do lado deles. Some por um dos
dois caminhos abaixo — enquanto nenhum for feito, o `.env` antigo está
acessível a quem tiver o SHA.

0. [ ] **Apagar o rastro que sobrou no GitHub**, escolhendo um:
   - **Suporte do GitHub** (https://support.github.com/) — pedir a remoção dos
     commits órfãos do repositório, citando os SHAs antigos. Mantém o
     repositório, o endereço e o histórico de issues.
   - **Apagar e recriar o repositório** com o histórico já limpo. Resolve na
     hora, mas perde estrelas, issues e qualquer configuração do repo.

**Decisão do dono:** o repositório **continua público** (a organização usa
vários recursos que só são gratuitos assim) e a rotação das credenciais fica
para depois. Enquanto ela não for feita, os valores antigos continuam válidos
em qualquer cópia feita antes da reescrita.

1. [ ] **Rotacionar a senha do Postgres do Supabase**: Supabase → Settings →
   Database → Reset database password. Atualizar `DATABASE_URL` no `.env` local
   e no painel do Northflank.
2. [ ] **Trocar `ADMIN_PASSWORD`** (e o `ADMIN_USER`, se quiser) e
   **`SESSION_SECRET`** — trocar o `SESSION_SECRET` derruba todas as sessões
   abertas, que é o efeito desejado.
3. [ ] **Conferir o Supabase**: Settings → API → rotacionar a `service_role
   key` por precaução, e olhar Logs por acesso vindo de fora do seu IP desde
   13/09/2026.
4. [ ] **Ligar as proteções**: GitHub → Settings → Code security → Secret
   scanning + Push protection. Em repositório público é de graça, e é a rede
   de segurança que faltou aqui.
5. [ ] Depois de rotacionar tudo, marcar aqui a data e conferir
   `git ls-files | grep -E '^\.env'` → só pode aparecer `.env.example`.

## A. Passo a passo pra sair do zero (faça na ordem)

1. [x] **`git init` + primeiro commit** — FEITO em 13/09/2026. O `.env` real
   entrou junto (o `.gitignore` não cobria `.env.*`, ao contrário do que esta
   linha afirmava); o histórico foi reescrito no mesmo dia. O repositório é
   público de propósito. O que sobrou está na seção A.0 acima.
2. [ ] **Mover os workflows** (ainda em `infra/github/`, não rodam de lá): `infra/github/ci.yml` → `.github/workflows/ci.yml` e `infra/github/seguranca-semanal.yml` → `.github/workflows/seguranca-semanal.yml` (a ferramenta não consegue gravar em `.github/`).
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
9. [ ] **Northflank** (não Render): serviço Node a partir da branch `main`, região sul-americana (mesma do Supabase), variáveis do `.env.example` no painel do serviço, `npm run migrate` como comando de release (ou rode uma vez à mão), `npm start`. `/health` responde `{ok:true}`.
10. [ ] **Cloudflare**: DNS `mostrai.sancocore.com.br` → Northflank (proxy ligado). **Access na frente de `/admin`** (Zero Trust → Access → Application, path `/admin*`, política: seu e-mail). Fechar a origem pra que só o Cloudflare alcance o serviço.
11. [ ] **San Checkout**: cadastrar o Mostraí como contratante (URL da API, chave, walletId — manual, no banco do Checkout), e combinar `SAN_CHECKOUT_WEBHOOK_SECRET` dos dois lados. Auditar a última estação do Checkout (você disse que falta). **Confirmar se o webhook manda `eventoId`/`cobrancaId`** — sem id, a deduplicação usa hash do corpo + dia (renovação meses depois passa; reentrega no mesmo dia não).
12. [ ] **Backup**: enquanto o Supabase for Free (sem backup automático), rode `npm run backup` semanalmente (precisa de `pg_dump` no PATH) ou crie um cron job no Northflank. Exceção registrada no `CONSTRAINTS.md`.
13. [ ] **TV Stick**: no admin → Telas → "Gerar chave" → copie o link → abra no navegador/kiosk da TV. Defina o PIN da tela. O link guarda a chave no aparelho; depois disso pode abrir só `/player.html?tela=ID`. Tela vertical é o padrão; `?orientacao=paisagem` desliga o giro. O app kiosk (Fully Kiosk ou similar) é quem trava a tela cheia — o player não promete isso.

## B. Decisões que só você toma (o código já suporta os dois lados)

- [ ] **Validar o veredito da Fase 3 da spec** (`docs/specs/2026-09-12-mostrai.md`): "sobrevive, reduzido". E o registro do que foi construído na aceleração (fim do arquivo) — se algo ali não está autorizado, sai.
- [ ] **Programa fundador**: ligar `PROGRAMA_FUNDADOR_ATIVO=true` só quando quiser vender. Revisar o plano seed `fundador-12m` (R$149 travado 12m, 1 mês grátis, mínimo 2 telas, 10 vagas) no admin → Planos → Programa fundador. Os planos normais vieram com o rótulo antigo "Preço fundador — nunca muda" — troque no admin (agora é confuso ao lado do plano fundador de verdade).
- [ ] **Módulos cruzados**: decidir quais planos ganham "tela após N meses" (admin → Planos → coluna "Tela após") e quais opções de comodato ganham "anúncio grátis após N meses" (admin → Opções de comodato → Bônus). Estão desligados (vazios) até você preencher.
- [ ] **Vaga de fundador**: hoje uma assinatura criada e não paga segura a vaga por 7 dias. Ok?
- [ ] **Troca de plano de quem já paga**: o sistema recusa (evita cobrança dupla na Asaas) e manda falar com você. O caminho é: admin → Anunciantes → "cancelar assinatura" (chama o Checkout) → a pessoa assina o novo. Confirmar que é assim que você quer.
- [ ] **Comissão sobre renovação**: hoje o vendedor recebe a cada `cobranca_confirmada` (inclusive renovações). Manter?
- [ ] **Drop do legado** (pede migration própria, com sua permissão): tabela `afiliados`, `pontos.aparelho_id`/`ultima_vez_online`, `exibicoes_contador.ponto_id`, `comissoes.afiliado_id`, `src/financeiro/afiliados-repository.js`, `public/nav-auth.js`, `public/afiliado/*` (hoje são redirects), `src/financeiro/san-checkout-1.js` (cópia antiga que só existe na sua pasta).
- [ ] **Custos fixos**: os seeds (DAS MEI 86,05; Contador 100; Domínio 3,33; Supabase Pro 0; Deslocamento 50) são chute meu — corrija no admin → Custos fixos. Amortização é por tela: preencha custo e prazo de cada TV na aba Telas.
- [ ] **Sessão única por navegador**: cadastrar uma conta no mesmo navegador em que o admin está logado derruba o admin (é o comportamento seguro). Use dois perfis/navegadores pra testar.

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
