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
  **contrato de API conferido rota a rota** (as 55 de `/admin` viraram tabela
  explícita, conferíveis mecanicamente contra o código); integração de pagamento
  fechada contra o `API.md` do Checkout; inventário de dados revisado;
  `docs/funcional.md` escrito, respondendo às quatro perguntas de prontidão ·
  evidência: `docs/funcional.md`, `docs/api.md`, `docs/inventario-de-dados.md`
Falta para fechar a atual: itens 8 e 9 da spec; tabela de eventos da métrica;
**a versão inicial no ar** — que é o que fecha a estação. Direitos do titular
construídos em 14/09 (RN-24, RN-25, RN-26): exportar dados, revogar
consentimento e arrependimento em 7 dias com devolução na fila do admin.
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
- **Rotação das credenciais vazadas em 13/09/2026** (`docs/PENDENCIAS.md`, A.0.1)
  — precisa do PC; até lá senha do Postgres, `SESSION_SECRET` e `ADMIN_PASSWORD`
  antigos seguem válidos. Nenhum push da pasta `D:\SanCo\MostrAi` antes do passo 1.
- **Itens 8 e 9 da spec não construídos** — o 9 (plano imutável para quem já
  assinou) tem que estar de pé antes da primeira assinatura paga.
- **`SAN_CHECKOUT_API_URL` é variável nova** e precisa ser combinada com quem
  administra o Checkout antes do deploy — é o endereço da API, diferente do da
  tela de pagamento.
- **`npm run conciliar` precisa de cron diário no Northflank.** Sem ele, um
  webhook perdido vira cliente pagante sem cobertura.
