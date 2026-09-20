# AGENT_PROTOCOL.md — Protocolo compartilhado (Claude Code, Codex, Jules)

Este protocolo vale para qualquer agente que trabalhe neste repositório,
independente da ferramenta. Ele não substitui as leis da San & Co.
(`CLAUDE.md`, `CONSTRAINTS.md`, skill `leis`) — é complementar, focado em
continuidade entre sessões e ferramentas diferentes.

## Ao iniciar

1. Ler `AGENTS.md` (raiz do repositório).
2. Ler `.ia/HANDOFF.md` — o estado exato deixado pelo último agente.
3. Ler `.ia/PROJECT_STATE.md` — o que está pronto, pela metade, ou
   quebrado.
4. Consultar `.ia/CONTEXT.md`, `.ia/ARCHITECTURE.md` e
   `.ia/BUSINESS_RULES.md` conforme a tarefa exigir — não é preciso ler os
   três inteiros toda vez, mas saiba que existem antes de assumir algo
   sobre o domínio.
5. Verificar o Git: branch atual, se bate com o que `HANDOFF.md` diz,
   commits recentes (`git log --oneline -15`), se há mudança não commitada.
6. Verificar o código relacionado à tarefa específica — ler o arquivo real,
   não confiar só na descrição em `.ia/`.

## Antes de modificar

- Localizar a implementação existente (`Grep`/busca de código) antes de
  escrever algo novo — duplicar uma função que já existe é o erro mais caro
  de corrigir depois.
- Entender as dependências do que vai mudar (quem chama, quem é chamado,
  que migration/tabela está envolvida).
- Verificar `.ia/DECISIONS.md` — se a coisa que parece estranha tem um ADR
  explicando por que é assim, **não é bug**, é decisão.
- Verificar efeitos colaterais: mudança em `src/lib/pacing.js` afeta o
  motor de playlist inteiro; mudança em `src/financeiro/` pode afetar
  cobrança real; mudança em migration afeta todo ambiente que já rodou
  aquele schema.

## Durante

- Preservar a arquitetura existente (`.ia/ARCHITECTURE.md`, `.ia/DECISIONS.md`)
  — não introduzir ORM, framework de frontend, ou trocar SQL cru por
  biblioteca de query builder "de passagem" numa tarefa que não pediu isso.
- Evitar duplicação — reusar componentes e utilitários que já existem
  (`src/lib/`, `public/config.js`, `public/modos.js`, etc.).
- Não trocar biblioteca por preferência pessoal do agente.
- **Investigar antes de perguntar ao usuário.** Antes de pedir status de
  deploy, nome de serviço, branch atual, schema, migrations, logs, estado
  de infraestrutura, domínio, ou IDs não sensíveis: tente descobrir direto
  pelo repositório, pela CLI, pela API, ou pela integração disponível no
  ambiente (GitHub, Supabase, Cloudflare, Northflank — ver
  `.ia/INTEGRATIONS.md` e `.ia/OPERATIONS.md`). Só pergunte o que
  genuinamente exige uma decisão humana ou uma credencial que você não tem.
- O padrão esperado ao lidar com infraestrutura/estado externo é:

  ```
  DESCOBRIR → VALIDAR → AGIR → VERIFICAR RESULTADO → DOCUMENTAR
  ```

  Ex.: antes de perguntar "qual é o ID do projeto Supabase?", chame
  `list_projects` se a ferramenta MCP estiver disponível. Antes de assumir
  que um deploy funcionou, confira `/health` ou uma string nova no arquivo
  publicado. Depois de confirmar, registre em `.ia/` o que mudou.
- Uma chamada de ferramenta que exige aprovação e não é concedida **não é o
  mesmo que negação** — não insista em loop, avise no `HANDOFF.md` que
  ficou pendente, e prossiga por outro caminho (perguntar ao usuário,
  documentar o que falta).

## Ao terminar

- Validar as alterações (ler o diff, não só confiar que rodou sem erro).
- Executar os testes relevantes (`npm run check` no mínimo; testes
  específicos do que mudou — ver `.ia/OPERATIONS.md`).
- Atualizar `.ia/TODO.md` (item concluído sai ou muda de seção; item novo
  descoberto entra).
- Atualizar `.ia/PROJECT_STATE.md` quando algo passou de "pela metade" para
  "pronto", ou apareceu quebrado.
- Atualizar `.ia/DECISIONS.md` (novo ADR) se uma decisão arquitetural real
  foi tomada — não para toda mudança, só para decisão que outro agente
  poderia querer desfazer sem contexto.
- **Sempre atualizar `.ia/HANDOFF.md`** antes de encerrar, mesmo que a
  mudança pareça pequena — é o que permite o próximo agente (de qualquer
  ferramenta) continuar sem esta conversa.
