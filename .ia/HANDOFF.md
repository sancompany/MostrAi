# Current Handoff

## Updated
2026-09-20

## Agent
Claude Code

## Branch
`claude/busy-noether-hheir2` (sincronizada com `main`, commit `b3fe101` no
momento em que esta tarefa começou — esta tarefa adiciona um commit em cima
dele, ver `.ia/DECISIONS.md` para nada relacionado a isto, é só
scaffolding).

## Current objective
Preparar o repositório para desenvolvimento contínuo entre Claude Code,
OpenAI Codex Cloud e Google Jules: criar a estrutura `.ia/` + `AGENTS.md`
como memória persistente compartilhada. Não implementar funcionalidade nova
nesta tarefa.

## Current state
Estação 5 (Construção) da esteira San & Co., no ar em produção desde
15/09/2026. `npm run check` verde (122 testes). Dois bugs em aberto sem
causa confirmada (ver abaixo). Nav e playlist tiveram mudanças reais nesta
mesma sessão, antes desta tarefa de scaffolding — ver `.ia/PROJECT_STATE.md`
pro retrato completo.

**Incidente resolvido no mesmo dia, depois da tarefa de scaffolding**:
produção caiu inteira (500 em toda rota que toca o banco) porque a senha do
Postgres foi trocada no Supabase sem atualizar `DATABASE_URL` no Northflank
— nem no serviço `mostrai`, nem nos jobs `Conciliacao`/`Backup` (cada um
guarda a própria cópia da variável, não há secret group compartilhado).
Corrigido nos três lugares e confirmado (site, admin, e os dois jobs
disparados manualmente com sucesso). Detalhe completo em
`docs/erros/2026-09-20-senha-do-postgres-divergente-entre-supabase-e-northflank.md`.
De passagem, confirmado que o job `ApuracaoBancoHoras` **não existe** no
Northflank (só `Conciliacao` e `Backup`) — já não era mais incerteza depois
disso, ver `.ia/TODO.md`.

## Work completed (nesta sessão, antes e durante esta tarefa)
- Corrigido revezamento de criativos que travava no mais recente + duração
  de imagem passou a usar o teto do plano.
- Simplificado texto de confirmação de troca de plano.
- **Congelamento da hora da playlist** (migration 064 +
  `src/playlist/congelamento-repository.js` + mudanças em
  `src/playlist/gerador.js`) — escolha de ponto nova entra na hora corrente
  sem reposicionar quem já rodava. Testado manualmente, sem teste
  automatizado ainda.
- **Nav consolidada**: aba única "Painel" (era "Anúncios"); "Vendas" e "Meu
  ponto" saíram do topo; candidatura a ponto virou card simplificado no fim
  do Painel; link pra quem já é vendedor/ponto.
- **Esta tarefa**: criada a estrutura `.ia/` completa (12 arquivos) +
  `AGENTS.md` na raiz; `CLAUDE.md` recebeu uma seção curta apontando pra
  cá (conteúdo original preservado integralmente); `README.md` e
  `RUNBOOK.md` corrigidos em um ponto cada (menu com uma aba só; playlist
  sem cache em memória — ver `.ia/DECISIONS.md` ADR-004).

## Files changed recently
Ver o commit desta tarefa (`chore(ai): add shared project context and agent
handoff`) para a lista exata. Resumo: `AGENTS.md` (novo), `.ia/*.md` (12
arquivos novos), `CLAUDE.md` (seção adicionada no fim), `README.md` (uma
frase corrigida sobre o menu), `RUNBOOK.md` (uma frase corrigida sobre cache
da playlist).

## External systems touched
Nenhum sistema externo foi alterado nesta tarefa de scaffolding. Uma
consulta de leitura ao Supabase (`list_projects`) foi feita com sucesso via
ferramenta MCP; uma segunda chamada (`execute_sql`, consulta à conta "San
União" para o bug de playlist) retornou "requires approval" e não foi
insistida.

## What is working
Produção inteira — site, `/admin`, login, playlist, jobs `Conciliacao` e
`Backup` — confirmada de pé depois do incidente de senha do Postgres (ver
acima). Nenhuma mudança de código de produto foi feita nesta sessão depois
do scaffolding — só a correção operacional da credencial.

## What is not working
- Anúncio da conta "San União" (único ponto da rede: "Bruno Henrique
  Sanches") não está veiculando na TV — causa não confirmada. Ver
  `.ia/TODO.md` (NOW) pro checklist específico.
- Troca de plano falha com "não foi possível calcular o acerto proporcional
  desta troca" para uma assinatura específica — apontado como problema do
  lado do San Checkout, não confirmável sem acesso ao banco dele.

## Next task
**Combinado com o dono em 20/09/2026, ordem explícita:**
1. Ele termina primeiro uma revisão do site em andamento pelo **Codex**
   (sessão separada, fora deste agente) — não é trabalho deste canal.
2. **Os dois bugs abaixo ficam reservados pra serem resolvidos AQUI**
   (Claude Code), não pelo Codex — ele foi explícito sobre isso. Não
   assumir que o Codex vai mexer neles nem duplicar a investigação lá.
3. Ideia nova pra registrar sem implementar ainda: **banco de horas nos
   dois sentidos** (hora com sobra roda mais anúncio em vez de só
   institucional, e isso vira crédito que amortece hora apertada depois) —
   detalhada em `docs/proximas-versoes.md`, entrada "Banco de horas nos
   dois sentidos: sobra acelera, aperto puxa do banco". Não é uma tarefa do
   `NOW`, é ideia pra próxima rodada — não comece a implementar sem o dono
   pedir explicitamente.

Conforme `.ia/TODO.md` (NOW), quando for a vez de atacar os dois bugs: para
o primeiro (anúncio não veicula), o próximo passo mais direto é ganhar
acesso de leitura ao Supabase de produção (projeto `MostrAi` — descubra o
ref/host pelo `list_projects` da ferramenta MCP, não está registrado em
arquivo por ser identificador de infraestrutura, ver `.ia/INTEGRATIONS.md`)
— se a ferramenta MCP `Supabase` estiver disponível e uma chamada
`execute_sql` for aprovada, rodar a consulta que já estava pronta nesta
sessão (buscar a conta por nome/e-mail, cruzar plano → cobertura de pontos
→ criativo aprovado → tela) em vez de pedir o checklist manual ao dono.
Para o segundo (troca de plano), o próximo passo é acesso ao banco do San
Checkout (projeto Supabase `San_Checkout`, mesma ressalva) para a
assinatura específica, ou envolvimento de quem administra o Checkout.

## Known bugs
Ver "What is not working" acima e `.ia/TODO.md` (BUGS). Nenhum outro bug
confirmado nesta sessão.

## Important decisions
Ver `.ia/DECISIONS.md` inteiro antes de "corrigir" qualquer coisa que
pareça estranha à primeira vista — em especial ADR-004/ADR-005 (playlist
sem cache + congelamento — são dois mecanismos diferentes, não um
contradizendo o outro) e ADR-008 (nav com uma aba só é decisão do dono, não
uma remoção acidental).

## Do not undo
- Não recolocar cache em memória na playlist (ADR-004) — a estabilidade
  vem de semente determinística + congelamento em tabela (ADR-005).
- Não restaurar as abas "Vendas"/"Meu ponto" no menu do topo (ADR-008) —
  as páginas continuam existindo, só o link do menu saiu, por pedido
  explícito do dono.
- Não trocar `custoPorExibicao` de volta para dividir pelo confirmado
  (ADR-007) — foi tentado e revertido no mesmo dia por decisão de produto.
- Não editar uma migration já aplicada — sempre uma migration nova.
- Não versionar nenhum valor real de `.env`, chave, token ou segredo, nem
  em `.ia/`.

## Useful commands
```bash
set -a && source .env && set +a   # exportar env vars antes de rodar comandos
npm run check                      # sintaxe + lint + formato + testes (o que o CI roda)
npm run migrate                    # aplicar migrations pendentes
curl https://mostrai.sancocore.com.br/health   # confirmar deploy
```
Ver `.ia/OPERATIONS.md` para a lista completa.

## Notes for next agent
Esta tarefa seguiu um roteiro dado pelo usuário (originado numa sessão com
outra ferramenta de IA) para criar exatamente esta estrutura `.ia/` +
`AGENTS.md`. Se você é o próximo agente (de qualquer ferramenta): leia
`AGENTS.md` primeiro, depois este arquivo, depois `.ia/PROJECT_STATE.md`. Os
dois bugs em "What is not working" são a prioridade — ambos têm
investigação de código já feita e documentada, faltando só acesso a dado
real (Supabase de produção ou do Checkout) pra fechar. Não repita a
investigação de código do zero; comece por `.ia/TODO.md` (NOW).
