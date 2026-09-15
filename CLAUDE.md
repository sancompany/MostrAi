# Mostraí

Projeto da San & Co. Segue as leis do plugin `san-co` (Leis, estações,
`construir`, `revisar`, `seguranca-san`, `checkout`, `classificar`, `legal`).

## Antes de propor ou escrever qualquer coisa, leia
- `CONSTRAINTS.md` — o que este projeto NÃO faz, e os limites assumidos
- `docs/specs/2026-09-12-mostrai.md` — por que existe, e o escopo validado
- `docs/erros/` — o que já deu errado aqui; não repita
- `docs/PENDENCIAS.md` — o que falta, e o que só o dono faz
- `docs/api.md` — o mapa das rotas
- `README.md` — como rodar e testar
- `RUNBOOK.md` — como operar, reverter e restaurar
- `docs/funcional.md` — o que o sistema faz, tela por tela
- `docs/teia.md` — as 387 funções e como cada uma se liga às outras
- `docs/furos.md` — os 132 furos levantados; hipóteses com endereço, não fatos
- `docs/pesquisa-voltplace.md` — o concorrente de Matão, lado a lado, e onde
  nosso preço cai no mercado
- `docs/pesquisa-preco-sp.md` — preço de mercado em São Paulo por faixa de
  plano, com fonte e grau de confiança em cada número

## Classificação
Porte: produto externo, com cliente pagante · Dado: financeiro, senha,
documento · Vida útil: anos → **rigor no topo da escala**. Nenhuma lei
dispensada por proporcionalidade.

## Estado na esteira
Estação atual: **5 — Construção**, aberta em 14/09/2026.
Fechadas:
- 1 Escopo — validada, reaberta e refechada em 14/09/2026 quando o contrato do
  San Checkout foi lido pela primeira vez · evidência:
  `docs/specs/2026-09-12-mostrai.md`, seções "Validação do dono" e "Reabertura e
  novo fecho da Estação 1"
- 2 Fronteiras — auditoria confirmou a classificação (projeto, não estrutura) e
  a hospedagem (Northflank + Supabase próprio, mesma região) · evidência:
  `docs/specs/2026-09-12-mostrai.md`, seção "Estação 2 — Fronteiras"
- 3 Fundação — repositório e árvore conformes à Lei 1; `.env` fora do
  versionamento com guarda no CI; **CI verde num push real** (`ci` run #9,
  commit `3c98465`, `success`, em `main`); `RUNBOOK.md` iniciado · evidência:
  `RUNBOOK.md` e a execução do CI
- 4 Contratos — modelo de dados e 20 migrations aplicando num Postgres limpo;
  **contrato de API conferido rota a rota** (as de `/admin` viraram tabela
  explícita, conferíveis mecanicamente contra o código); integração de pagamento
  fechada contra o `API.md` do Checkout; inventário de dados revisado;
  `docs/funcional.md` escrito, respondendo às quatro perguntas de prontidão ·
  evidência: `docs/funcional.md`, `docs/api.md`, `docs/inventario-de-dados.md`
**A versão inicial está no ar desde 15/09/2026** — `mostrai.sancocore.com.br`
responde pelo Node (`GET /health` → `{"ok":true}`, `GET /planos` → os 12 planos
em JSON, as 15 páginas em 200). Era a condição principal de fecho da estação.
Falta só o item 8 da spec (desconto de comodato por linha da grade), que
depende de uma decisão do dono registrada em `docs/PENDENCIAS.md` B.1.2: o
desconto incide sobre o preço travado, ou o preço travado ganha?
Fechados em 14/09: direitos do titular (RN-24 a RN-26), plano imutável para
quem já assinou (item 9, RN-27) e a tabela de eventos da métrica com as três
consultas salvas (aba Métrica no admin).
Fechados em 15/09: os 132 furos de `docs/furos.md` percorridos (só sobraram os
dois que dependem do dono — prova social e CNPJ), RN-28 a RN-31, o formatador
aplicado com o `check` passando a barrar, e a pesquisa de preço de mercado
(`docs/pesquisa-preco-sp.md`).
Próxima estação: 6 — Prontidão, pede Opus com esforço alto.

## Mapa de caminhos
- Entrada da aplicação: `src/server.js` · rotas e regras: `src/<domínio>/`
  (`routes.js` + `repository.js` por assunto)
- Dados e migrations: `src/db/migrations/` (aplicadas por `src/db/migrate.js`)
  · variáveis: `.env.example`
- Bibliotecas internas: `src/lib/` (senha, aparelho, pacing, limite, ffmpeg)
- Site estático, sem build: `public/` · componentes mínimos: `public/layout.js`,
  `public/perfil.js`, `public/modos.js` · player: `public/player.html`
- Integração com o San Checkout: `src/financeiro/san-checkout.js`
- Testes: `tests/` (`npm test`) · lint: `npm run lint` (Biome; motivo das regras em
  `docs/lint.md`) · tudo junto: `npm run check` · CI: `.github/workflows/`

## Conformidade
Violação segue o ciclo da skill `leis`. Não existe estado final fora de
conformidade: ou corrige, ou vira exceção registrada no `CONSTRAINTS.md`.

## Pendências que bloqueiam a esteira
- ~~O domínio não serve a aplicação~~ — **resolvida em 15/09/2026**
  (`docs/PENDENCIAS.md`, A.0.0). `mostrai.sancocore.com.br` responde pelo Node:
  `/health` devolve `{"ok":true}` e `/planos` devolve JSON. Endereço sem
  extensão (`/planos`, herdado do host estático antigo) agora é redirecionado
  301 para a página quando quem pede é navegação de documento.
- **Rotação das credenciais vazadas em 13/09/2026** (`docs/PENDENCIAS.md`, A.0.1)
  — precisa do PC; até lá senha do Postgres, `SESSION_SECRET` e `ADMIN_PASSWORD`
  antigos seguem válidos. Nenhum push da pasta `D:\SanCo\MostrAi` antes do passo 1.
- **Item 8 da spec não construído** — desconto de comodato por linha da grade.
  O item 9 (plano imutável) foi construído em 14/09.
- **`SAN_CHECKOUT_API_URL` é variável nova** e precisa ser combinada com quem
  administra o Checkout antes do deploy — é o endereço da API, diferente do da
  tela de pagamento.
- ~~`npm run conciliar` precisa de cron diário~~ — **existe e está ativo**
  (`0 9 * * *`, uma execução com SUCCESS). O backup roda aos domingos
  (`0 8 * * 0`). A Visão geral do admin mostra a última conciliação.
- **Bucket `criativos` ainda é privado no Supabase** — é o que impede o vídeo
  de tocar na TV. Precisa do dono: Storage → `criativos` → Public bucket.
- **Falta o Cloudflare Access na frente do `/admin`** — o proxy já está ligado
  (feito em 15/09), então agora é só criar a aplicação. Receita exata em
  `docs/PENDENCIAS.md`, seção A.
- **Migrations agora rodam no arranque do contêiner** (`Dockerfile`): o banco
  de produção chegou a ficar nove migrations atrás do código. Se uma migration
  falhar, o contêiner não sobe e o anterior continua servindo.
