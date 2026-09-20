# AGENTS.md — Mostraí

Este repositório é trabalhado por mais de um agente de IA (Claude Code, OpenAI
Codex Cloud, e futuramente Google Jules), em sessões separadas que não
compartilham memória entre si. A `.ia/` é a memória operacional compartilhada
entre eles — o que substitui "lembrar da conversa anterior".

## Antes de trabalhar neste repositório

1. Leia `.ia/README.md` (o que é cada arquivo e em que ordem ler).
2. Leia `.ia/HANDOFF.md` (o estado exato de agora, deixado pelo último agente).
3. Leia `.ia/PROJECT_STATE.md` (o que está pronto, quebrado, ou pela metade).
4. Siga `.ia/AGENT_PROTOCOL.md` (como investigar, modificar e encerrar a sessão).

Este projeto também é governado pelas leis internas da San & Co. (`CLAUDE.md`,
`CONSTRAINTS.md`) — isso continua valendo e não é substituído pela `.ia/`. A
`.ia/` existe para o que as leis da San & Co. não cobrem: contexto operacional
enxuto para um agente que nunca viu este código antes de dar continuidade sem
precisar reconstruir tudo do zero lendo o histórico do Git a dedo.

## Regras

- **Código, Git e infraestrutura real têm prioridade sobre documentação
  desatualizada.** Se um arquivo em `.ia/` disser uma coisa e o código disser
  outra, o código venceu — corrija o arquivo em `.ia/` e siga.
- **Investigue antes de perguntar ao usuário.** Antes de pedir status de
  deploy, nome de serviço, branch atual, schema, migrations, logs, estado de
  infraestrutura, domínio ou IDs não sensíveis, tente descobrir direto pelo
  repositório, pela CLI ou pela API do serviço (GitHub, Supabase, Cloudflare,
  Northflank) quando o ambiente disponibilizar acesso. Pergunte só o que
  genuinamente não dá pra descobrir sozinho (credenciais, uma decisão de
  produto, autorização para algo irreversível).
- **Alteração significativa exige atualizar `.ia/HANDOFF.md`** antes de
  encerrar a sessão — é o que permite o próximo agente (de qualquer
  ferramenta) continuar sem essa conversa.
- **Secrets nunca são versionados.** Nenhum valor real de `.env`, chave,
  token, senha ou cookie entra em arquivo do repositório, incluindo os de
  `.ia/`. Nomes de variável sim; valores não.
- **Este documento não substitui `.ia/AGENT_PROTOCOL.md`** — leia os dois.
