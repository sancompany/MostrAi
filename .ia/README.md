# `.ia/` — memória operacional compartilhada do Mostraí

Esta pasta existe para que Claude Code, OpenAI Codex Cloud e (depois) Google
Jules consigam continuar o mesmo projeto sem depender de uma conversa
anterior. Ela não substitui `CLAUDE.md`/`CONSTRAINTS.md` (as leis da San &
Co. continuam valendo) nem os `docs/` existentes (spec, API, funcional,
furos, pendências) — ela é a camada de **estado operacional entre agentes**:
o que mudou, o que está pela metade, o que não pode ser "corrigido" sem
contexto, e por onde continuar agora.

## Arquivos

| Arquivo | O que responde |
|---|---|
| `CONTEXT.md` | O que é o Mostraí, pra quem, e como funciona por fora |
| `ARCHITECTURE.md` | Como o sistema é construído por dentro (stack, pastas, dados, deploy) |
| `PROJECT_STATE.md` | O que está pronto, pela metade, ou quebrado, agora |
| `BUSINESS_RULES.md` | As regras de negócio reais, com a fórmula do código quando existe |
| `INTEGRATIONS.md` | GitHub, Supabase, Cloudflare, Northflank, San Checkout, Google — pra que serve cada uma e onde aparece no código |
| `OPERATIONS.md` | Comandos confirmados: rodar local, testar, migrar, fazer deploy, depurar |
| `DECISIONS.md` | Decisões que um agente novo poderia tentar "corrigir" sem precisar |
| `TODO.md` | O que falta fazer, organizado por urgência, incluindo bugs abertos |
| `RISKS.md` | Riscos reais conhecidos — produto, arquitetura, banco, deploy, segurança |
| `HANDOFF.md` | O estado exato de agora, pro próximo agente assumir sem esta conversa |
| `AGENT_PROTOCOL.md` | Como um agente deve investigar, modificar e encerrar a sessão |

## Ordem recomendada de leitura

1. `AGENTS.md` (raiz do repositório)
2. `.ia/HANDOFF.md`
3. `.ia/PROJECT_STATE.md`
4. `.ia/CONTEXT.md`
5. `.ia/ARCHITECTURE.md`
6. `.ia/BUSINESS_RULES.md`
7. `.ia/DECISIONS.md`
8. Documentação específica da tarefa (`docs/api.md`, `docs/funcional.md`,
   `docs/PENDENCIAS.md`, etc. — a fonte de verdade de produto e conformidade
   continua sendo `docs/` e `CLAUDE.md`, não esta pasta)

## O que é permanente e o que muda a toda hora

**Praticamente fixos** (mudam só quando a arquitetura ou o modelo de negócio
muda de verdade): `README.md` (este arquivo), `CONTEXT.md`, `ARCHITECTURE.md`,
`BUSINESS_RULES.md`, `INTEGRATIONS.md`, `OPERATIONS.md`, `AGENT_PROTOCOL.md`.

**Atualizados a cada sessão relevante**: `HANDOFF.md` (sempre, é o estado do
momento), `PROJECT_STATE.md` (quando algo muda de "pela metade" para "pronto"
ou aparece quebrado), `TODO.md` (quando um item entra, sai, ou muda de
seção), `RISKS.md` (quando um risco é descoberto ou mitigado).

**Append-only**: `DECISIONS.md` — uma decisão registrada não se apaga, só
ganha um ADR novo que a substitui, com o motivo da mudança.

## O que esta pasta não é

Não é onde ficam as leis de conformidade da San & Co. (isso é `CLAUDE.md` e
`CONSTRAINTS.md`, e continuam sendo lidos primeiro pela skill `leis`). Não é
onde fica o mapa rota-a-rota da API (isso é `docs/api.md`) nem o inventário
de dado pessoal (`docs/inventario-de-dados.md`). Quando algo já tem um lugar
certo em `docs/`, esta pasta aponta pra lá em vez de duplicar.
