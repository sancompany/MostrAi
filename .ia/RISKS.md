# RISKS.md — Riscos reais conhecidos

Só riscos com evidência no código, no Git ou em documentação existente do
projeto. Criticidade indicada quando ajuda a priorizar.

## Documentação / drift de arquitetura

- **`RUNBOOK.md` (corrigido nesta sessão) e `CONSTRAINTS.md` (não
  corrigido) descreviam a playlist com "cache em memória por processo"**,
  desenho removido em 17/09/2026 (ver `.ia/DECISIONS.md`, ADR-004).
  `CONSTRAINTS.md` usa essa premissa como parte do motivo de um veto
  ("Playlist gerada em Edge Function"). A CONCLUSÃO do veto (não usar Edge
  Function) pode ou não continuar válida por outro motivo — não foi
  reavaliada nesta sessão porque `CONSTRAINTS.md` é documento de governança
  da San & Co., fora do escopo desta tarefa de scaffolding. **Risco**: um
  agente novo lê `CONSTRAINTS.md`, reafirma o veto pelo motivo errado, ou
  pior, "corrige" o motivo sem entender que a conclusão pode precisar de
  reavaliação de verdade, não só de texto. Criticidade: baixa (não afeta
  produção), mas gera confusão de continuidade.
- **`docs/teia.md` e `docs/furos.md` têm entradas desatualizadas por
  mudanças anteriores a esta sessão** (ex.: menções a `seja-um-ponto.html`/
  `seja-um-vendedor.html`, aposentados em 18/09/2026) — já registrado como
  dívida em `docs/PENDENCIAS.md` ("os dois documentos precisam de uma
  rodada de regeneração própria"). Não é novo, só reafirmado aqui.

## Bugs abertos sem causa confirmada

- **"Anúncio nunca passou na TV"** (conta San União, único ponto da rede).
  Seis hipóteses comuns descartadas por análise de código; causa real não
  confirmada por falta de acesso ao banco de produção nesta sessão. Ver
  `.ia/TODO.md` (BUGS) para o checklist específico. **Criticidade: alta** —
  é dinheiro de cliente pagante sem entrega comprovada, numa rede de só um
  ponto (sem "outros pontos" pra diluir o problema).
- **Troca de plano falhando ("não foi possível calcular o acerto
  proporcional")** para uma assinatura específica — root cause apontada
  para o lado do San Checkout (dado de ciclo/vencimento incoerente ou
  cobrança confirmada faltando), não confirmável sem acesso ao banco do
  Checkout. **Criticidade: média** — bloqueia um fluxo de autoatendimento
  (cliente não consegue trocar de plano sozinho), mas tem contorno manual
  (o dono resolve por fora).

## Produto / arquitetura

- **Filtro "sem concorrente" ainda precisa de teste ponta a ponta**: a
  hipótese anterior de ausência de `categoria_id` foi refutada pelo código e
  por produção. O risco restante é comportamental: provar que todas as formas
  de criar/editar conta e ponto resultam na exclusão esperada na playlist.
- **Congelamento da hora (ADR-005) não tem teste automatizado dedicado** em
  `tests/` — só foi verificado manualmente nesta sessão (script descartável
  não commitado). Uma regressão futura no comportamento "sempre no fim"
  não seria pega pelo `npm run check`. Criticidade: média.
- **`GET /conta/modos` sempre devolve `bonus.ponto: null`** por comentário
  explícito no código — o banner de "você ganhou uma tela" nunca aparece no
  Painel. Não investigado se é intencional; risco de ser um benefício de
  plano vendido que não está sendo comunicado a quem já cumpriu a condição.
  Criticidade: a confirmar.

## Deploy / infraestrutura

- **Uma instância só do serviço web** — troca de deploy deixa uma janela de
  alguns segundos com 503 (medido, `RUNBOOK.md`). Aceito como decisão de
  custo, não bug — mas é um risco real de disponibilidade a cada deploy.
- **Supabase no plano Free**: sem backup automático do lado do provedor — a
  mitigação é o job próprio `Backup` (dump semanal, 26 retenções). **O
  backup nunca foi restaurado de teste** (`RUNBOOK.md`, seção 5: "Este
  backup nunca foi restaurado. Backup não restaurado é backup hipotético").
  Criticidade: alta até o primeiro ensaio de restauração acontecer.
- **Job `ApuracaoBancoHoras` — status de existência no Northflank não
  confirmado** nesta sessão. Se não existir, o déficit mensal do banco de
  horas nunca fecha e ninguém ganha prioridade — silencioso, sem erro
  visível até alguém notar que o banco de horas não está funcionando.
- **Branch `claude/mostrai-estacao-1-pipeline-y2vgr5` não investigada** —
  pode ser trabalho relevante esquecido ou experimento morto. Risco de
  algum agente futuro divergir dela sem saber que existe, ou de conflito se
  alguém tentar mesclá-la sem entender o que é.

## Segurança

- CSP estrita e webhook fail-closed/idempotente/transacional já são pontos
  fortes confirmados (ver `.ia/DECISIONS.md`, ADR-010/ADR-011) — não é
  risco, registrado aqui só para não ser "redescoberto" como lacuna.
- Rate limit de tentativas (`src/lib/limite-tentativas.js`) é **em memória**
  — reinicia a cada restart do processo (o próprio `README.md` documenta
  isso como limitação conhecida, não como bug).

## Dívida técnica

- `docs/teia.md`/`docs/furos.md` precisam de regeneração (ver acima) —
  dívida já reconhecida pelo próprio projeto, não descoberta nesta sessão.
- Testes de ponta a ponta com Playwright dependem de um binário de Chromium
  específico do ambiente de execução (`PW_CHROME`) — não documentado como
  instalar esse binário do zero num ambiente novo (só como reaproveitar o
  que já existe). Ver `.ia/OPERATIONS.md`.

## Atualização — auditoria de 20/09/2026

- **Crítico — integridade de confirmação:** `/played` sai no começo da tentativa e falhas são ignoradas, sem identidade, retry ou idempotência por execução. Métricas podem divergir da reprodução real.
- **Decisão de produto — banco de horas:** ele foi implementado deliberadamente para déficit de capacidade (`pedidas - programadas`), não falha física. A drenagem também ocorre quando a recuperação cabe na programação. Decidir se falha da TV cria mecanismo separado; não classificar o cálculo atual isoladamente como bug.
- **Alto — concorrência do congelamento:** duas primeiras requisições podem responder bases distintas; extras concorrentes podem duplicar.
- **Correção de risco antigo:** categoria do ponto é gravável e existe em produção. O risco real restante é ausência de teste ponta a ponta do bloqueio, não ausência do dado.
- **Dependências:** audit atual contém 1 vulnerabilidade crítica, 3 altas e 6 moderadas.

## Mapa funcional — achado de 20/09/2026

- **Métrica financeira (P1):** a consulta histórica de margem em `src/admin/metrica.js` filtra o status antigo `p.status = 'ativo'`; desde a migration 045 o ponto operacional é `em_operacao`. A amortização histórica fica zerada e pode superestimar margem. A Visão geral usa o status correto. Não corrigido durante o inventário.
