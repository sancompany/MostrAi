# Mostraí — pendências (atualizado 13/09/2026, fim do bloco de aceleração v2/v2.1)

Projeto em `D:\SanCo\MostrAi`. Tudo abaixo está na pasta; nada foi commitado em git porque o repositório ainda não existe. **Ordem sugerida: seção A inteira, depois B, depois o resto.**

## A. Passo a passo pra sair do zero (faça na ordem)

1. [ ] **`git init` + primeiro commit** na pasta `D:\SanCo\MostrAi`. Antes, confira que `.env` NÃO entra: `git status` não pode listar `.env`, `.env.real.bak` nem `.env.teste` (o `.gitignore` já cobre `.env.*`). Depois crie o repositório privado no GitHub e ligue a proteção de push com segredo (Settings → Code security → Secret scanning / Push protection).
2. [ ] **Mover os workflows**: `infra/github/ci.yml` → `.github/workflows/ci.yml` e `infra/github/seguranca-semanal.yml` → `.github/workflows/seguranca-semanal.yml` (a ferramenta não consegue gravar em `.github/`).
3. [ ] **`npm install`** (entrou `connect-pg-simple`).
4. [ ] **`.env` local**: use `.env.example` como guia. Novas: `SITE_URL`, `PROGRAMA_FUNDADOR_ATIVO=false`, `MOSTRAI_EMAIL_FROM`/`MOSTRAI_EMAIL_CONTATO` (o antigo `VITRINA_EMAIL_FROM` ainda funciona). O `.env` que estava na pasta era o de TESTE da sessão; o real está em `.env.real.bak` — renomeie de volta pra `.env` e confira as variáveis novas.
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
