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
- `docs/funcional.md` e `RUNBOOK.md` — **não existem ainda** (Estações 4 e 6)

## Classificação
Porte: produto externo, com cliente pagante · Dado: financeiro, senha,
documento · Vida útil: anos → **rigor no topo da escala**. Nenhuma lei
dispensada por proporcionalidade.

## Estado na esteira
Estação atual: **2 — Fronteiras**, aberta em 14/09/2026.
Fechadas:
- 1 Escopo — spec validada pelo dono, veredito da Fase 3 confirmado sobre nove
  itens · evidência: `docs/specs/2026-09-12-mostrai.md`, seção
  "Validação do dono (14/09/2026)"
Falta para fechar a atual: confirmar a classificação da skill `classificar` e
registrar as capacidades consumidas do ecossistema — boa parte já está escrita
na Fase 2 da spec; a Estação 2 entra como auditoria do que já foi decidido.
Próxima estação: 3 — Fundação, pede Sonnet com esforço médio.

## Mapa de caminhos
- Entrada da aplicação: `src/server.js` · rotas e regras: `src/<domínio>/`
  (`routes.js` + `repository.js` por assunto)
- Dados e migrations: `src/db/migrations/` (aplicadas por `src/db/migrate.js`)
  · variáveis: `.env.example`
- Bibliotecas internas: `src/lib/` (senha, aparelho, pacing, limite, ffmpeg)
- Site estático, sem build: `public/` · componentes mínimos: `public/layout.js`,
  `public/perfil.js`, `public/modos.js` · player: `public/player.html`
- Integração com o San Checkout: `src/financeiro/san-checkout.js`
- Testes: `tests/` (`npm test`) · CI: `.github/workflows/`

## Conformidade
Violação segue o ciclo da skill `leis`. Não existe estado final fora de
conformidade: ou corrige, ou vira exceção registrada no `CONSTRAINTS.md`.

## Pendências que bloqueiam a esteira
- **Rotação das credenciais vazadas em 13/09/2026** (`docs/PENDENCIAS.md`, A.0.1)
  — precisa do PC; até lá senha do Postgres, `SESSION_SECRET` e `ADMIN_PASSWORD`
  antigos seguem válidos. Nenhum push da pasta `D:\SanCo\MostrAi` antes do passo 1.
- **Itens 8 e 9 da spec não construídos** — o 9 (plano imutável para quem já
  assinou) tem que estar de pé antes da primeira assinatura paga.
- **Mês grátis: comportamento não confirmado do lado do Checkout** — resolve na
  Estação 4, com o `API.md` e o `INTEGRACAO.md` do San Checkout em mãos.
