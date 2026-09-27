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
- **Congelamento da hora (ADR-005) ainda não tem teste ponta a ponta da ordem
  completa** — `tests/playlist-congelamento.test.js` cobre a seção crítica,
  base vencedora, anexação e rollback, mas uma regressão que altere a posição
  final no payload do gerador ainda depende dos testes de pacing e da revisão
  manual. Criticidade: média.
- ~~`GET /conta/modos` sempre devolve `bonus.ponto: null`~~ — resolvido
  (25/09/2026): intencional. O bônus por tempo de ponto foi aposentado (o
  ponto rende crédito mensal, ADR-016) e nenhuma tela lê o campo `bonus`;
  o comentário do código que dizia o contrário estava velho.

## Deploy / infraestrutura

- ~~**Uma instância só do serviço web**~~ — desatualizado: o serviço roda
  com **2 instâncias** (`nf-compute-50`, conferido no Northflank em
  25/09/2026; item 4, preparação para 2 instâncias).
- **Supabase no plano Free**: sem backup automático do lado do provedor — a
  mitigação é o job próprio `Backup` (dump semanal, 26 retenções).
  **Ensaio de restauração feito em 25/09/2026** (`RUNBOOK.md` §5): banco
  isolado, `public` íntegro, app no ar; RPO semanal (até 7 dias). Achado no
  ensaio: um backup vazio de 20/09 ficou no volume — corrigido no
  `scripts/backup.sh`; o arquivo vazio continua lá (não restaurar dele).
- ~~Job `ApuracaoBancoHoras` ainda não criado no Northflank~~ — criado em
  25/09/2026 (`docs/job-apuracao-banco-horas.md`); 1ª execução real em
  01/10/2026. Desde 27/09/2026 o `Conciliacao` diário também registra horas
  sem sinal e recompõe o mês anterior no prazo do comprovante.
- **Segredos do Northflank não usam secret group compartilhado** — cada
  serviço/job guarda sua própria cópia de cada variável
  (`DATABASE_URL` incluída). Trocar um segredo exige lembrar de atualizar
  em cada recurso separadamente; esquecer um já derrubou produção uma vez
  (20/09/2026, ver `docs/erros/2026-09-20-senha-do-postgres-divergente-entre-supabase-e-northflank.md`).
  Migrar pra um secret group do projeto eliminaria essa classe de erro.
- ~~Branch `claude/mostrai-estacao-1-pipeline-y2vgr5` não investigada~~ —
  resolvido (25/09/2026): já está inteira no `main`; listada para exclusão
  em `docs/FECHAMENTO_PRE_GATES_2026-09-25.md` §14.

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
- **Decisão de produto — banco de horas:** decidido MANTER em 25/09/2026 (obrigação de veiculação). **Desde 27/09/2026 (Saldo de Veiculação, RN-53):** saldo = obrigação da hora aberta − entrega CONFIRMADA, em segundos; ponto fechado não deve; o saldo volta só no tempo ocioso; só a exibição confirmada abate.
- **Mitigado em 20/09/2026 — concorrência do congelamento:** base e extras passaram a ser resolvidos sob lock transacional por tela/hora. A base perdedora é descartada antes da resposta e uma nova leva não pode ser anexada duas vezes. Manter o teste dedicado e não retirar a seção crítica ao otimizar o gerador.
- **Correção de risco antigo:** categoria do ponto é gravável e existe em produção. O risco real restante é ausência de teste ponta a ponta do bloqueio, não ausência do dado.
- **Dependências:** ~~1 crítica, 3 altas, 6 moderadas~~ — `npm audit` em 0 desde 25/09/2026 (PR #61).

## Mapa funcional — achado de 20/09/2026

- **Métrica financeira (P1):** a consulta histórica de margem em `src/admin/metrica.js` filtra o status antigo `p.status = 'ativo'`; desde a migration 045 o ponto operacional é `em_operacao`. A amortização histórica fica zerada e pode superestimar margem. A Visão geral usa o status correto. Não corrigido durante o inventário.

## Saldo de Veiculação — riscos que ficaram (27/09/2026)

- **Mídia Mostraí na camada da base (T1).** Regra existente, preservada: numa
  hora cheia a Mídia é cortada junto com a base comercial, na mesma
  proporção — e o tempo que ela ocupa deixa de estar livre pra compensação e
  saldo antigo. Conflito de produto a decidir (Mídia antes ou depois do
  comercial); a reserva de 20% da Mostraí NÃO foi transformada em regra da
  playlist.
- **Hora sem sinal usa a cobertura de HOJE.** Conta que saiu do ponto depois
  da hora sem sinal perde aquela hora (erro a favor da Mostraí); conta que
  chegou depois não é cobrada. Roda diário (48 h) pra a diferença ser pequena.
  Ponto em operação SEM tela ativa não gera obrigação (não há linha onde
  gravá-la) — hoje, produção: 0 pontos assim.
- **Teto de 1/6 da hora (RN-49) mantido.** A parte da obrigação acima dele
  vira saldo (não some mais), mas só volta em capacidade ociosa de outras
  horas — numa rede muito menor que o plano, o saldo pode crescer mais rápido
  que a capacidade de devolver.
- **Card "Horas de tela no mês" do painel** continua mostrando o contratado
  da vitrine (12 h/dia × 30 dias, "até"), não a obrigação real por horário do
  ponto. Não mexido nesta estação (sem redesenho); o saldo é o número exato.
- **Apuração de 01/10 é provisória** até 08/10 (comprovante offline); o
  cliente pode ver um saldo que diminui nesses dias.

