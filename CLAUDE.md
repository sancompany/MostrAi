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
Fechadas — evidência completa em `docs/specs/2026-09-12-mostrai.md` (1 e 2) e
`docs/funcional.md`/`docs/api.md` (3 e 4):
- 1 Escopo, 2 Fronteiras, 3 Fundação (CI verde, `RUNBOOK.md`), 4 Contratos
  (contrato de API rota a rota, integração de pagamento, `docs/funcional.md`).
No ar desde 15/09/2026 (`mostrai.sancocore.com.br`, `/health` → `ok:true`,
Cloudflare Access no `/admin`, origem fechada) — era a condição principal de
fecho. Todo o escopo da v1 construído (item 8/9 da spec, fundador redesenhado,
drop do legado, comissão travada — detalhe em `docs/PENDENCIAS.md`, seções B
e B.1).
**Falta só a rodada de depuração da seção F de `docs/PENDENCIAS.md`**: o dono
revisa o site no ar e reporta o que precisa de ajuste — a estação fecha só
com o nível que ele aceita, julgamento dele, não do código.
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
- **Rodada de depuração da Estação 5** (`docs/PENDENCIAS.md`, seção F) — o
  dono revisa o site em produção e reporta o que precisa de ajuste; cada
  item entra na seção F e sai corrigido. Fecha só com a lista `[x]` e o dono
  satisfeito. Nenhuma outra pendência bloqueia hoje.

## Memória entre agentes (Claude Code, Codex, Jules)
Este projeto agora também é trabalhado por mais de um agente de IA, em
sessões que não compartilham memória entre si. `AGENTS.md` (raiz) e `.ia/`
guardam o estado operacional entre sessões — branch atual, o que está pela
metade, decisões que não devem ser desfeitas sem contexto. Leia `AGENTS.md`
antes de continuar qualquer tarefa aqui; não substitui nada deste arquivo
nem de `CONSTRAINTS.md`, é complementar.
