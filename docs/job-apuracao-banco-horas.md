# Job `ApuracaoBancoHoras` — especificação para criar no Northflank

Estado: **CRIADO E OPERANDO no Northflank desde 25/09/2026** (1ª execução
real agendada: 01/10/2026 06:00 UTC). O código é o `scripts/apurar-banco-horas.js`,
que chama `src/bancohoras/apuracao.js`. A regra de produto está em
`docs/funcional.md` (RN-53, Saldo de Veiculação); o mapa, os defeitos
corrigidos e as invariantes em `docs/specs/2026-09-27-saldo-de-veiculacao.md`.
Esta página cobre só a operação.

## O que o job faz (cada execução) — desde 27/09/2026, em TEMPO

1. **Registra as horas abertas sem sinal** do mês apurado: hora em que o ponto
   estava aberto e a tela não pediu playlist ganha a obrigação que tinha
   (`src/bancohoras/obrigacao.js`). Rede de segurança: o registro normal é
   feito pelo próprio servidor, minutos depois de cada hora fechar; aqui e no
   `Conciliacao` só entra a hora em que o servidor esteve fora do ar.
2. **Apura** o mês fechado (padrão: o mês anterior no relógio de Matão,
   `America/Sao_Paulo`). Para cada conta pagante com obrigação no mês:
   `saldo = Σ segundos_obrigacao − Σ entrega CONFIRMADA × duração da hora`. Toda
   conta com obrigação ganha a linha do mês (saldo 0 = `drenado`, auditoria).
   **Idempotente:** uma linha por conta × mês; rodar de novo recompõe a mesma
   linha com os mesmos dados. Enquanto ainda chegam comprovantes offline (até
   7 dias + 1 h depois do fim do mês), a linha se recompõe; depois de uma
   apuração nesse prazo, congela. Nunca abaixo do que já voltou.
3. **Liquida** as horas já fechadas (passado o prazo do comprovante): abate
   do saldo, em segundos da duração de cada hora, **só** o banco que a TV
   confirmou. Cada hora é abatida uma vez (`banco_liquidado_em`), numa
   transação por conta.
4. **Registra** a execução em `banco_horas_execucoes` (menos na simulação),
   com `segundos_devidos`, `segundos_abatidos`, `horas_sem_pedido` e
   `linhas_recompostas`.

O job não faz nada disto: não expira saldo, não zera nada na virada do mês,
não gera crédito em dinheiro e não mexe em cobrança.

**Todo dia**, dentro do job `Conciliacao` que já existe (`scripts/conciliar.js`),
rodam as mesmas funções: registro das horas sem sinal das últimas 48 h,
recomposição do mês anterior enquanto ele ainda recebe comprovantes, e a
liquidação. Não há job novo nem apuração paralela: é a mesma `apurarMes`,
idempotente.

## Configuração (igual à do job `conciliacao` em produção, conferida em 25/09/2026)

| Campo | Valor |
|---|---|
| Nome | `ApuracaoBancoHoras` (id `apuracaobancohoras`) |
| Projeto / time | `mostrai` / `san-co` |
| Tipo | Cron job |
| Origem da imagem | build do serviço `mostrai`, branch `main`, SHA mais recente (igual a `conciliacao`) |
| Comando (custom command) | `npm run apurar-banco-horas` |
| Agenda (cron, UTC) | `0 6 1 * *` — dia 1 de cada mês, 06:00 UTC = 03:00 em Matão (a última hora do mês fecha às 00:15) |
| Concorrência | `Forbid` (e o script ainda tem trava no Postgres) |
| Tentativas (`backoffLimit`) | `2` — seguro: as duas etapas são idempotentes |
| Tempo máximo (`activeDeadlineSeconds`) | `600` |
| Plano | `nf-compute-20` (o mesmo da conciliação) |
| Executar ao mudar o código (`runOnSourceChange`) | `never` |

### Variáveis de ambiente (na aba Environment do próprio job)

| Variável | Valor |
|---|---|
| `DATABASE_URL` | a mesma do serviço `mostrai` e dos jobs `Conciliacao` e `Backup` (senha codificada para URL — RUNBOOK §2) |
| `NODE_ENV` | `production` |

O job não usa SMTP, San Checkout, Supabase Storage nem `SESSION_SECRET`: não
coloque essas variáveis nele. Ao trocar a senha do Postgres, este job entra na
lista de lugares a atualizar (lição de 20/09/2026,
`docs/erros/2026-09-20-senha-do-postgres-divergente-entre-supabase-e-northflank.md`).

## Opções e códigos de saída

```
npm run apurar-banco-horas                  # apura (ou recompõe) o mês anterior e liquida
npm run apurar-banco-horas -- --dry-run     # calcula e mostra; não grava nada
npm run apurar-banco-horas -- --mes=2026-10 # apura um mês fechado específico
```

| Código | Significado | O que fazer |
|---|---|---|
| 0 | ok | nada |
| 1 | falhou (banco fora, erro de SQL) | ler o log; rodar de novo termina o que faltou (idempotente) |
| 2 | argumento inválido ou mês ainda aberto | corrigir o `--mes` |
| 3 | outra execução em andamento | esperar a outra terminar |

O log só tem números e ids de conta — nunca `DATABASE_URL`, e-mail ou nome.

## Primeira execução (depois de criar o job)

1. Ainda sem agendar: **Run job** com o comando
   `npm run apurar-banco-horas -- --dry-run`. Esperado: código 0 e duas linhas
   de log `banco de horas (simulação: nada gravado): …`. Nada é gravado.
2. Conferir o que a simulação diz (quantas contas com déficit, quantas
   exibições devidas). Com os dados de teste de hoje, o esperado é perto de
   zero.
3. Decidir se a primeira execução real espera o dia 1 (recomendado: deixar o
   cron rodar) ou se roda agora com o comando padrão.
4. Depois da primeira execução real, conferir a linha nova (somente leitura):
   `SELECT * FROM banco_horas_execucoes ORDER BY id DESC LIMIT 1;` —
   `abortou` vazio e `mes_apurado` = mês anterior.
5. Acrescentar o job ao RUNBOOK §2 como mais um lugar da `DATABASE_URL`.

## Observabilidade

- Log do job no Northflank (duas linhas por execução; a primeira diz se o mês
  ainda é provisório — "ainda chegam comprovantes").
- `banco_horas_execucoes`: uma linha por execução real, com `abortou`
  preenchido quando falha.
- `GET /admin/banco-horas`: as linhas do banco por conta.

## O que continua sendo decisão do operador (não implementado)

`DECISAO_DO_OPERADOR` — o código não inventa regra para estes casos:

- **Ordem de abatimento**: hoje FIFO (a dívida mais antiga sai primeiro).
  LIFO ou outra ordem → decisão.
- **Encerramento/cancelamento da conta com saldo**: hoje o saldo fica
  registrado e a conta sem plano simplesmente não é programada. O que se
  deve ao cliente nesse caso → decisão.
- **Teto diário de devolução**: hoje o teto é por hora (pedido da hora ×
  multiplicador de idade, até 3×) e só no tempo ocioso. Teto por dia → decisão.
- **Mudança de plano com saldo**: o saldo é em SEGUNDOS (desde 27/09/2026) e
  segue a conta; volta em inserções da peça que ela tiver no dia. Converter
  pelo plano novo → decisão.
- **Idade de peso máximo e multiplicador** (3 meses, 3×): números escolhidos
  pelo código, não pelo dono.
