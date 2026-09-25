# Fechamento pré-gates — 25/09/2026

> Relatório da execução autônoma de fechamento ("PROMPT MESTRE DE FECHAMENTO
> AUTÔNOMO"). Em construção durante a execução; a versão final substitui este
> aviso.

## 14. Branches

Inventário das branches remotas (origem `sancompany/MostrAi`), conferido em
25/09/2026 contra o `main` e contra os PRs mergeados. Registrado **antes** de
apagar, com o SHA completo — qualquer uma pode ser recriada a partir dele
(`git push origin <sha>:refs/heads/<nome>`).

| Branch | SHA da cabeça | Situação | Classificação |
|---|---|---|---|
| `claude/checkout-contrato-v2` | `78235a7ef1f1fded6bbfccf4c745e12f9507d345` | ancestral do `main` (0 commits à frente) — commit 299f3e5 | SAFE_TO_DELETE |
| `claude/epic-newton-sc30uz` | `b3c01edcf13ca802efbe056d6314b97f51ad89b1` | ancestral do `main` | SAFE_TO_DELETE |
| `claude/fase-3-sse-cross-instance` | `9a517bf4754838f009cef3857cc01152082c79fc` | cabeça = PR #28, mergeado (squash) | SAFE_TO_DELETE |
| `claude/fase-4-sino-notificacoes` | `df0488ef98188d0f347313afda7cf224961af43a` | cabeça = PR #30, mergeado | SAFE_TO_DELETE |
| `claude/fase-5-sem-reload` | `9c860153b220c170a3beedebbfe26e321504ba3c` | cabeça = PR #27, mergeado | SAFE_TO_DELETE |
| `claude/handoff-doc` | `32d7ed1388b7382f9cb10d791548b16cb77c56d1` | cabeça = PR #26, mergeado | SAFE_TO_DELETE |
| `claude/mostrai-estacao-1-pipeline-y2vgr5` | `44929d6cb168692be8f02c0c5851d07f7b854a46` | ancestral do `main` (resolve o item "não investigada" de `.ia/RISKS.md`) | SAFE_TO_DELETE |
| `claude/nifty-galileo-rwryqd` | `69c723ecd87ce3032fc18e9fef3f821b0feba840` | cabeça = PR #46, mergeado | SAFE_TO_DELETE |
| `claude/painel-unico-creditos` | `16c8a2d3b55c39d86ef48cd9859cbfb85c29d31e` | cabeça = PR #25, mergeado | SAFE_TO_DELETE |
| `claude/pool-max-conexoes` | `73f983a04a89f801bf7ef71da48172fd5f8d7a11` | cabeça = PR #29, mergeado | SAFE_TO_DELETE |
| `claude/wonderful-hypatia-i7y4xx` | `0c8ede3bfd4b10cb58c2f809fb2e9c4c6eb675a4` | cabeça = PR #48, mergeado | SAFE_TO_DELETE |
| `claude/busy-noether-hheir2` | (em uso) | branch de trabalho desta execução | KEEP |
| `main` | — | produção | KEEP |

Nenhuma ficou como NEEDS_REVIEW: toda branch com commit "à frente" do `main`
tem a cabeça idêntica à de um PR já mergeado (squash muda o SHA, não o
conteúdo).
