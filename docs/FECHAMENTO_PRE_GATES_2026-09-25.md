# Fechamento pré-gates — 25/09/2026

Relatório da execução autônoma de fechamento ("PROMPT MESTRE DE FECHAMENTO
AUTÔNOMO", recebido 25/09/2026 04:25 UTC). Objetivo: fazer tudo que não
depende do operador e deixar só os gates reais. Cada item termina numa
categoria: **DONE**, **WAITING_OPERATOR**, **WAITING_EXTERNAL**,
**PRODUCT_DECISION**, **LEGAL_REVIEW** ou **DEFERRED_TO_FINAL_RESET**.

Decisões do operador que valeram para esta execução: banco de horas
**MANTER** (obrigação de veiculação, sem expiração, nunca dinheiro); os dados
atuais são de teste (`DADOS_DE_TESTE_AGUARDANDO_RESET`) e não foram tocados;
o San Checkout está em produção.

| | SHA |
|---|---|
| Inicial (`main` e produção) | `6a971de` |
| PR #60 — main verde + 2 bugs do 299f3e5 + heartbeat | `bc4df98` |
| PR #61 — banco de horas MANTER + `npm audit` zerado | `0455e6d` |
| PR #62 — e-mails HTML + comprovante PDF + backup sem arquivo vazio | `ff970a2` |
| PR #63 — E2E sem `networkidle`, roteiros atualizados, docs | `3a1422d` |
| PR #64 — revisão dos PRs #55–#58: 5 correções + 1 decisão registrada | `b3157e1` |
| **Código em produção ao fechar** | **`b3157e1`** (deploy COMPLETED 06:53 UTC, `/health` ok, `/admin` 302) |

Este relatório entra por um PR só de documentação depois do #64; o
auto-deploy do `main` também publica esse commit, sem mudança de código.

---

## 1. Snapshot inicial (04:26 UTC)

- **main:** `6a971de` (PR #59). Nenhum PR aberto.
- **Produção:** Northflank `san-co/mostrai/mostrai`, 2 instâncias
  `nf-compute-50`, `deployedSHA` = `6a971de` — **rodando um SHA com CI
  vermelho** (o Northflank publica o `main` sem esperar o CI).
  Jobs: `conciliacao` (`0 9 * * *`) e `backup` (`0 8 * * 0`);
  `ApuracaoBancoHoras` não existe.
- **CI:** vermelho no `main` — 397 testes, 1 falha:
  `prioridade-planos.test.js:104` (FK `notificacoes_anunciante_id_fkey` no
  teardown). O CI do PR #59 tinha passado; o vermelho só apareceu depois do
  merge. Lint: 15 avisos.
- **Migrations em produção:** 87, última `089_assinatura_pendente_de_pagamento.sql`
  (igual ao repositório).
- **Saúde:** `/health` → `{"ok":true}`; `/admin` fechado pelo Cloudflare Access.
- **Dados:** 4 contas (todas com senha `scrypt`), `banco_horas` vazio,
  `exibicoes_contador` com 2 linhas, 2 telas (§7).
- **Dependências:** 6 vulnerabilidades (1 critical, 3 high, 2 moderate).

## 2. Problemas encontrados

Produto e operação (todos **DONE**):

| # | Problema | Causa | Severidade | Correção | Teste / prova |
|---|---|---|---|---|---|
| 1 | CI vermelho (`prioridade-planos`) | 8 gravações de notificação sem `await` (`aplicarCicloPago` ×3, `avisarConta` ×2, criativo aprovado/recusado, candidatura, conta suspensa/reativada): o `DELETE` da conta corria antes da gravação; jobs globais rodando sobre contas de outros arquivos de teste | Média | #60: `await …registrar().catch()`, `eventos.aguardarGravacoes()` no lugar de 7 `sleep` fixos, `apenasContas` nos jobs globais (produção não passa) | Reprodução 5×: antes 0→1 notificação depois do retorno em 3/5; depois 1·1 em 5/5. `prioridade-planos` isolado 10× verde |
| 2 | **299f3e5 — crédito em dobro no contrato v2** | Webhook v2 deduplicava só por `eventoId` e gravava `chargeId\|status` depois de creditar: conciliação + webhook atrasado (ou 2 `eventoId` da mesma cobrança) = 2 ciclos por 1 pagamento | **Alta** | #60: chave `chargeId\|status` reservada **antes** de creditar, liberada se nada foi creditado ou em erro (`san-checkout.js:658-683`) | 2 testes novos em `webhook-v2-checkout.test.js`; sem a correção falham (esperado 1, veio 2) |
| 3 | **299f3e5 — recompra no mesmo dia esconde o ciclo** | `cobrancaJaRegistrada` aceitava qualquer cobrança do mesmo plano perto da hora | **Alta** | #60: consulta amarrada a `ciclos_contratados.assinatura_id` (`conciliacao.js:95-111`) | Teste "cobrança de OUTRA assinatura do mesmo plano no mesmo dia não esconde o ciclo desta" falhava antes (esperado 2, veio 1) |
| 4 | Banco de horas programava mais que a dívida | `floor((saldo/cobertura) × mult)` multiplicava o tamanho da dívida | Média | #61: `min(ceil(saldo/cobertura), floor(frequenciaBase × mult))` (`gerador.js:347-350`) | Mutação com a fórmula antiga → "programou 16" para dívida de 10 |
| 5 | Banco de horas drenado na geração | Abatia na 1ª geração da hora, antes de confirmar — TV desligada consumia a dívida | Média | #61: geração só programa; liquidação abate o confirmado (§6) | Testes de liquidação e do gerador |
| 6 | Banco de horas tomava a entrega de outros | Banco somado ao déficit entrava no corte RN-30 — contraria MANTER | Média | #61: banco só no tempo ocioso (`caberEm` duas vezes, `pacing.js`) | 2 testes de `montarHoraDeTv` |
| 7 | Apuração do banco em mês UTC | `new Date(ano, mês, 1)` em servidor UTC punha 21h–24h do último dia no mês seguinte | Baixa | #61: mês em `America/Sao_Paulo` | Teste "mês de Matão (não UTC)" |
| 8 | **Backup vazio com cara de backup** | Em 20/09 08:00 o `pg_dump` falhou, mas o redirecionamento já tinha criado `mostrai-20260920-080036.sql.gz` (20 bytes) | **Alta** | #62: `scripts/backup.sh` grava `.parcial`, exige o marcador `PostgreSQL database dump complete`, só então `mv` | Com credencial errada: exit 1 e zero arquivos no destino. O arquivo vazio antigo continua no volume (gate 12) |
| 9 | Mensagem impossível no admin | Rotação em tela do player web mandava "gerar link novo" (rota = 410) | Baixa | #63: "revogue e use Preparar Player" | — |
| 10 | Legenda enganosa no painel | "prioridade nos próximos dias" não vale mais | Baixa | #61: "exibições a devolver · entram no tempo livre das telas" | — |
| 19 | **#55 — benefício pago com créditos apagado antes de começar** | Ativação estrita: em D+1 a varredura de cobertura vencida (dentro da conciliação) chega ANTES de `ativarBeneficiosAgendados` e `fecharAbertos` fechava o agendado junto com o pago que não renovou — créditos gastos, conta sem plano, nenhum aviso | **Alta** | #64: `encerrar` por `'vencido'` mantém o agendado (`manterAgendado`); ele entra no mesmo job | Teste do job na ordem real (`creditos.test.js`); sem a correção, ativados 0 |
| 20 | #55 — pagamento de link cancelado some | Link pago com webhook perdido + link novo antes da conciliação: o antigo vira `'cancelada'` e a conciliação só olhava `'ativa'`/`'pendente_pagamento'` | Média | #64: conciliação olha a intenção cancelada recente (30 dias, nunca paga) e registra a MESMA pendência do webhook, uma vez por cobrança, sem creditar | `assinatura-pendente.test.js`; sem a correção, 0 pendências |
| 21 | #55 — card do plano "vencido" depois de salvar o perfil | PATCH do perfil e foto devolviam a linha crua; o painel troca a conta inteira pela resposta | Baixa | #64: GET/PATCH/foto na mesma forma (`contaParaOPainel`) | `endereco.test.js`; sem a correção, `plano_vigente` indefinido |
| 22 | #55 — datas do benefício agendado um dia antes | Tela mostrava início = último dia pago e fim = último dia pago + N; a ativação entregava um dia depois nos dois | Baixa | #64: início = dia seguinte ao último pago (`vigencia.inicioDepoisDoPago`, 5 lugares), fim = início + N (a régua do benefício imediato), ativação respeita o fim guardado ao dia | `creditos-resgate`, `ficha-conta`, `creditos` |
| 23 | #56/#57 — crédito com status velho | A conciliação carrega a lista inteira e consulta o Checkout uma por uma; um link novo pode cancelar no meio | Baixa | #64: `aplicarCicloPago` relê a assinatura travada (`FOR UPDATE`, depois da conta) | `assinatura-pendente.test.js`; sem a correção, 1 cobrança criada |

Testes e infraestrutura de teste (todos **DONE**):

| # | Problema | Causa | Correção |
|---|---|---|---|
| 11 | Heartbeat V2 instável | O gatilho `marcar_playlists_desatualizadas` marca todas as telas a cada mudança; outros arquivos mexem nisso em paralelo | #60: `sinalizarPlaylist(telaId, db)` + teste dentro de transação com `FOR UPDATE` (§5) |
| 12 | `playlist-contrato-novo` com FK em `exibicoes_contador` | Contas de teste sem ponto caíam na cobertura automática de pontos de outros arquivos | #60: ponto escolhido antes do plano; ordem de teardown |
| 13 | Aviso de lint novo (299f3e5) | Parâmetro `url` sem uso | #60 |
| 14 | E2E travando | `waitUntil: 'networkidle'` nunca assenta com o EventSource (SSE) aberto | #63: `tests/e2e/espera.mjs` |
| 15 | E2E 02 falhando | A ordem documentada punha um reset entre 01 e 02, e o 02 continua o 01 | #63: README e executor na ordem certa |
| 16 | E2E 08 recusava pelo motivo errado | Payload sem o endereço em partes (D5) | #63 |
| 17 | E2E 09 contava um 500 proposital | Upload da foto sem Supabase Storage (o roteiro confere que o pedido segue) | #63: só esse pedido é perdoado |
| 18 | Online 19 com 2 asserções velhas | "nenhum" só batia com zero mídias; `h4` em `text-transform: uppercase` | #63 |

**Não reproduzido:** um 503 num recurso de página pública (1920×1080) na
2ª rodada do roteiro 19 com admin. Não voltou em duas rodadas seguidas
(65/65 cada). O app só responde 503 na credencial do Player
(`src/lib/aparelho.js:67`), e o log de produção da janela não tem erro →
origem fora do app (borda/proxy de saída/terceiro). O roteiro passou a
registrar o endereço de cada erro de console.

Achados **não corrigidos** de propósito (registrados, **PRODUCT_DECISION**):
ver §4.

## 3. CI

| Momento | Estado |
|---|---|
| Início (`6a971de`, `main`) | **vermelho** — 397 testes, 1 falha |
| PR #60 → `bc4df98` | verde (PR e `main`) |
| PR #61 → `0455e6d` | verde (PR e `main`) — 406 testes |
| PR #62 → `ff970a2` | verde (PR e `main`) — 412 testes |
| PR #63 → `3a1422d` | verde (PR e `main`) — 412 testes |
| PR #64 → `b3157e1` | verde (PR e `main`) — 416 testes |
| **Final** | **verde** — `npm run check`: sintaxe, lint (14 avisos, 0 erro), formato, **416/416** |

## 4. Revisão financeira

### 299f3e5 ("San Checkout contrato v2…", 24/09 20:49 UTC)

Empurrado direto no `main`, sem PR. 5 arquivos, +355/−14. Conferido contra
o `API.md` do Checkout (contrato v2 de 24/09/2026, §4.3.3, 4.3.4 e 4.3.6:
`eventoId` diferente + mesmo `chargeId|status` = "fato novo").

- **Dois bugs, os dois corrigidos no #60:** crédito em dobro no v2 e
  recompra no mesmo dia (§2, itens 2 e 3).
- **Conferido sem achado:**
  - `chaveDoEvento` v2;
  - `troca_revertida` (chargeback suspende, o resto vira pendência);
  - estorno parcial/total;
  - `ciclo` nulo recusado pelo Checkout;
  - limpeza de `pendente_troca` com mais de 1 dia;
  - dedupe do webhook de pedido.

### PRs #55–#59

| PR | Assunto | Resultado |
|---|---|---|
| #55 | Revisão Codex dos #50–#54: um link pagável por conta, dedupe solta na falha, vigência no servidor | **4 achados, corrigidos no #64** — §2 itens 19 (alto: benefício apagado em D+1), 20, 21, 22 |
| #56 | Pagamento de intenção já cancelada vira pendência, não credita ciclo | **1 achado corrigido** (§2 item 23, com o #57) + **1 decisão registrada** (abaixo, nota 3) |
| #57 | "Já pagou" enxerga o backfill da 087; admin também recusa aplicar | sem achado próprio (divide o item 23) |
| #58 | Ciclo legado só conta dentro da janela da própria assinatura | sem achado (produção não tem ciclo sem `assinatura_id` desde a L.2) |
| #59 | Datas de benefício/plano pago no dia de Matão (`vigencia.HOJE_SQL`) | sem achado; formatação + dia comercial coerentes |

Método: diff de cada squash lido contra o código atual, cada achado
reproduzido com teste descartável ANTES da correção (a asserção codificava o
comportamento errado e passava), depois virou teste de regressão no
repositório.

Cobertura dos arquivos de pagamento: 46/46 (`webhook-v2-checkout`,
`dedupe-webhook`, `assinatura-pendente`, `renovacao`, `troca-de-plano`),
dentro dos 416/416 (os 4 testes de regressão novos do #64 incluídos).

### Regressões

Três regressões reais: as duas do 299f3e5 (§2, itens 2 e 3) e a do #55 que
apagava o benefício agendado (§2, item 19). Todas corrigidas antes de afetar
alguém — produção só tem dados de teste e nenhum benefício agendado.

### Notas registradas, não corrigidas — PRODUCT_DECISION

1. **Troca de plano com Checkout lento.** O teto de 20 s
   (`TIMEOUT_CHECKOUT_MS`) lança exceção em `trocarPlano`
   (`san-checkout.js:1006`, chamado sem try em `financeiro/routes.js:495`):
   a pessoa vê um 500 genérico, e a linha `pendente_troca` fica até a
   limpeza diária de 1 dia. Nada é cobrado nem trocado. É mais seguro que
   fingir a troca; melhorar a mensagem é decisão de produto.
2. **Janela noturna do benefício agendado.** A ativação usa
   `plano_anterior_valido_ate < HOJE_SQL` (`plano-administrativo.js:489`) e o
   job diário roda 09:00 UTC = 06:00 em Matão. Entre 00:00 e 06:00 o pago já
   venceu e o benefício ainda não começou (~6 h sem cobertura por noite de
   virada). Mudar o horário do job ou a regra é decisão comercial. (O que
   era PERDA nessa virada — o benefício apagado — foi corrigido no #64.)
3. **Assinatura órfã de link cancelado e pago.** A assinatura desse link
   continua viva na Asaas e cobra de novo todo ciclo; nada no Mostraí a
   cancela (os botões de cancelar só olham a assinatura `'ativa'`, e o do
   admin cancelaria a legítima). Cancelar sozinho seria cancelamento
   financeiro automático em produção — decisão do operador. Feito no #64: a
   pendência e a recusa do admin pedem as DUAS coisas (cancelar a
   assinatura E devolver no Checkout). Proposta, se o operador quiser:
   chamar `cancelar-assinatura` no Checkout ao registrar essa pendência.

## 5. Testes

**Unitários e integração** (`npm test`, node:test em paralelo):
397 (1 falha) → 400 → 406 → 412 → **416/416**.

- Pagamento: 46/46.
- Banco de horas: 13/13.
- `pacing`: 43/43.
- E-mail/comprovante: 6/6.
- Senha (inclui hash bcrypt legado): 5/5.

**Heartbeat V2 determinístico** (`tests/player-v2.test.js`, teste "V2 recebe
envelope; mudança marca desatualizada, heartbeat avisa UMA vez"):

- *Sem reprodução natural:* o teste antigo, 8× em paralelo com a suíte
  inteira, passou 8/8.
- *Reprodução determinística:* uma mudança de criativo injetada entre
  "zerar a marca" e o heartbeat derruba o teste antigo.
- *Correção:* as checagens rodam dentro de `BEGIN` + `SELECT … FOR UPDATE`
  na linha da tela, e o gatilho das outras sessões espera o fim da
  transação. Depois vem uma checagem HTTP com
  `playlist_sinalizada_em = 'infinity'`.
- *Prova:* 5/5 com mudança paralela injetada em cada passo.

**Sabotagens (o teste tem que falhar sem a correção):**

1. Correção do webhook v2 retirada → 2 testes falham.
2. Teste da recompra antes da correção → falha.
3. `sinalizarPlaylist` sem a condição "uma vez só" → falha.
4. Multiplicador antigo do banco → "programou 16" para dívida de 10.
5. Executor do banco de horas nos 4 códigos de saída (0, 1, 2, 3) → todos
   conferidos.
6. `backup.sh` com credencial errada → exit 1, nenhum arquivo.

**E2E local** (banco e servidor do contêiner, ordem do `tests/e2e/README.md`):
18 roteiros, **682 checagens, 0 falha**.

| Roteiro | ok | | Roteiro | ok |
|---|---|---|---|---|
| 01 fluxo API | 49 | | 10 painel sem render acumulativo | 7 |
| 02 assinatura/webhook | 33 | | 11 créditos | 23 |
| 03 navegador | 28 | | 12 meus pontos | 35 |
| 04 modos | 29 | | 13 meus criativos | 27 |
| 05 navegador modos | 26 | | 14 financeiro | 15 |
| 06 bloqueio de plano | 12 | | 15 painel único | 51 |
| 07 design do painel | 18 | | 16 ficha de conta | 149 |
| 08 candidatura | 11 | | 17 modelo de créditos | 58 |
| 09 rede | 63 | | 18 rede Player V2 | 48 |

Os roteiros 08 e 09 foram rodados de novo depois das correções do #63; com
as correções do #64, de novo os de pagamento e créditos (01, 02, 06, 11, 15,
16, 17): todos verdes.

**Online 19** (produção, só leitura: nenhuma conta, pedido, tela ou cobrança):

- Parte pública:
  - saúde, CSP sem `unsafe-inline`, HSTS, nosniff;
  - `/planos` canônico (12 planos);
  - rotas aposentadas → 410, redirecionamentos 301;
  - adversarial: webhook sem assinatura ou com assinatura errada → 401, rotas sem credencial → 401, Access fechado;
  - site público em 5 tamanhos sem rolagem horizontal.

  Resultado: **65/65** em três rodadas.
- Admin, com service token **temporário** do Access (criado e apagado no
  mesmo comando, duas vezes): **31/31**. Cobre:
  - login;
  - 6 abas;
  - ficha de ponto e de tela sem chave nem PIN em claro;
  - celular.

  A 1ª rodada teve as 2 asserções velhas (§2, item 18).
- Estado final do Access conferido pela API: 1 policy ("Somente o
  operador"), **0 service tokens**; `/admin/` e `/admin/pontos` → 302 para o
  login do Cloudflare. A senha do admin foi lida do contêiner para um arquivo
  `600` no scratchpad e apagada em seguida.

## 6. Banco de horas — decisão MANTER (DONE; job = WAITING_OPERATOR)

**Arquitetura:** a dívida é **exibição**, nunca dinheiro. A capacidade não
entregue vira saldo e volta no tempo ocioso futuro. Não expira, não zera no
mês e nunca tira a entrega atual de ninguém.

**Migration `090_banco_horas_obrigacao.sql`** (aditiva, no ar desde o #61):

- `exibicoes_contador.vezes_banco` (0 ≤ `vezes_banco` ≤ `vezes_programadas`, por CHECK);
- `exibicoes_contador.banco_liquidado_em`;
- índice parcial das horas com banco pendente;
- tabela `banco_horas_execucoes`, o histórico de cada rodada do job.

**Mudanças:**

1. **Devolução:** `montarHoraDeTv` recebe `banco` e usa `caberEm` duas vezes
   (hora vendida primeiro, banco só no que sobrou, no lugar do
   institucional). Hora cortada (RN-30) não devolve nada.
2. **Ritmo:** `min(ceil(saldo ÷ pontos cobertos), floor(frequênciaBase × multiplicador))`.
   O multiplicador vai de 1× a 3× com a idade da dívida (3 meses). Esses
   números são do código, não do dono → DECISAO_DO_OPERADOR.
3. **Geração só programa** (`vezes_banco`); nada drena na geração. O saldo
   reservado (Σ `vezes_banco` não liquidadas) sai do saldo disponível, e
   outra tela não programa a mesma dívida.
4. **Liquidação** (`liquidarBancoConfirmado`):
   - quando: horas fechadas há mais de 75 min (60 + folga da virada);
   - quanto abate: `LEAST(GREATEST(confirmadas − (programadas − vezes_banco), 0), vezes_banco)`.
     A confirmada conta primeiro para a entrega normal, e na dúvida a dívida fica;
   - como: numa transação por conta, marca `banco_liquidado_em` e drena
     (FIFO, `FOR UPDATE`);
   - quando roda: diário no `Conciliacao` e mensal no job.
5. **Apuração** (`apurarMes`):
   - base: mês fechado em `America/Sao_Paulo`;
   - fórmula: déficit = Σ pedidas − Σ (programadas − vezes_banco), por conta pagante;
   - `ON CONFLICT DO NOTHING`;
   - mês aberto → erro.
6. **Válvula de 3 meses** (`aguardando_credito`) **removida**. A rota antiga
   ficou só para leitura; produção não tem nenhuma linha nela.

**Retry e idempotência:** as duas etapas são idempotentes (UNIQUE na
apuração; `banco_liquidado_em` na liquidação). Rodar de novo depois de uma
falha termina o que faltou.

**Trava:** `pg_try_advisory_lock(90202609)`.

**Códigos de saída:** 0 ok · 1 falha · 2 argumento inválido/mês aberto ·
3 trava ocupada (todos testados).

**Comando do job:**

```
npm run apurar-banco-horas                 # mês anterior fechado
npm run apurar-banco-horas -- --dry-run    # simula, não grava nada
npm run apurar-banco-horas -- --mes=2026-10
```

**Procedimento Northflank** (`docs/job-apuracao-banco-horas.md`):

- Job `ApuracaoBancoHoras`, cron `0 6 1 * *` (dia 1, 03:00 em Matão),
  imagem do build do serviço `mostrai` (`main`), `Forbid`, `backoffLimit 2`,
  `activeDeadlineSeconds 600`, plano `nf-compute-20`.
- Variáveis: só `DATABASE_URL` + `NODE_ENV=production`.
- 1ª execução manual com `--dry-run`, depois conferir `banco_horas_execucoes`.

**Estado em produção:** `banco_horas` vazio, `banco_horas_execucoes` vazio,
job **não criado** (gate 1).

**DECISAO_DO_OPERADOR:** FIFO × LIFO, conta encerrada com saldo, teto
diário, mudança de plano, e os números 3 meses/3×.

## 7. Player

**Heartbeat:** determinístico (§5). O SQL do sinal virou
`sinal.sinalizarPlaylist(telaId, db)` (`src/player/sinal.js`), e a rota usa
a mesma função.

**V2 em produção:** 2 telas de teste, ambas ativas:

| Tela | Contrato | Chave V2 | Último sinal | Situação |
|---|---|---|---|---|
| (a) | `contrato_playlist=1` | não | nunca | V1 que nunca deu sinal |
| (b) | `contrato_playlist=2` | sim (provisionada) | sem sinal nas últimas 2 h | V2 fora do ar |

A ficha da tela no admin mostra os blocos canônicos (Player, Conexão, PIN,
Operação, Área segura, Diagnóstico, Histórico), sem chave nem PIN em claro
(roteiro 19).

**V1 — gate (WAITING_OPERATOR, gate 5).** Superfície que ainda serve o
player web:

- **Servidor:**
  - autenticação só por `X-Aparelho-Id` (`src/lib/aparelho.js`) e busca por
    id numérico (`dispositivos/repository.js`);
  - playlist em array para contrato < 2 (`playlist/routes.js:58-67`);
  - primeiro contato pela playlist (`sinal.js:256`);
  - heartbeat de corpo vazio ou `{erro}`;
  - margens sem teto (`player/config.js`);
  - played antigo (`confirmarExibicao`);
  - painel por PIN (`POST /player/:id/painel`);
  - `contrato_playlist` editável por PATCH (sem controle na UI);
  - `POST /admin/dispositivos/:id/chave-legada` já responde 410.
- **Front:** `public/player.html`, `player.page.js` (660 l.), `player.css`,
  referências em `robots.txt` e `config.js`, rótulos no admin.
- **Banco:** `dispositivos.contrato_playlist`, `aparelho_id` (hash desde a
  083, nada lê), `pin_hash`. A migration 084 está reservada para limpar
  `aparelho_id`.

**Checklist de aposentadoria** (não executada):

1. Confirmar que nenhuma tela usa V1.
2. Tirar o player web e o kiosk.
3. Parar de aceitar só `X-Aparelho-Id` e o id numérico.
4. Envelope sempre; tirar `contrato_playlist` do PATCH.
5. Remover primeiro contato via playlist, heartbeat vazio/`{erro}`, margem
   sem teto, played antigo e painel por PIN.
6. Tirar os ramos V1 do admin e do status.
7. Reescrever os testes.
8. Rodar a 084 (drop de coluna só com autorização explícita).
9. Atualizar os docs.

## 8. E-mails (DONE)

**Antes:** 16 envios em `src/financeiro/email.js`, todos só texto.

**Depois (#62):**

- Todo e-mail ao cliente sai em **HTML + texto puro** pelo mesmo
  `mensagem({previa, saudacao, titulo, paragrafos, destaque, botao, depois, nota})`.
- **Formato:** HTML em tabela com estilo inline, até 600 px, sem imagem,
  prévia oculta.
- **Botão:** `#c2570a` (a cor da marca com texto branco não passa AA).
- **Segurança:** todo dado de cadastro passa por `esc()`.
- **Conferido no Chromium:** 390 px e 800 px sem rolagem horizontal.

**Ao cliente (14):**

- pagamento confirmado (com o PDF);
- cobrança falhou;
- cobertura acabando;
- conta reativada / criada / excluída;
- troca de plano;
- cancelamento;
- código de confirmação;
- redefinição de senha;
- criativo reprovado / no ar;
- novidade;
- arrependimento recebido.

**Internos (2, só texto, para `MOSTRAI_EMAIL_CONTATO`):** contato e
candidatura nova.

O SMTP é só do Mostraí; o Checkout nunca manda e-mail. A chegada numa caixa
real de produção fica para o teste final do operador (gate 3).

## 9. Comprovante de pagamento em PDF (DONE)

- **Existia?** Não — só a coluna `cobrancas_confirmadas.email_confirmacao_enviado_em`
  (migration 008), sem uso.
- **Implementação:** `src/financeiro/comprovante.js`. É um PDF 1.4 escrito à
  mão, de 1 página, em Helvetica/WinAnsi, sem dependência nova, e
  **determinístico** (gerar de novo dá o mesmo arquivo).
  - Número: `MST-` + id da cobrança com 6 dígitos; um por ciclo confirmado.
  - Pagador: CPF mascarado (`***.456.789-**`), CNPJ inteiro.
  - Recebedor: `MOSTRAI_COMPROVANTE_RECEBEDOR` (padrão "Mostraí — San & Co.").
  - **Sem data de cobertura:** o comprovante prova o pagamento, e o ciclo pago
    pode ficar guardado atrás de um benefício.
  - Nunca se chama de nota fiscal. Texto obrigatório: *"Este documento
    comprova o pagamento da contratação indicada e não substitui documento
    fiscal quando sua emissão for aplicável."*
- **Evento que dispara:** `aplicarCicloPago` (webhook do Checkout ou
  conciliação).
  1. `INSERT INTO cobrancas_confirmadas … RETURNING id, criado_em`;
  2. `enviarConfirmacaoPagamento` anexa o PDF;
  3. no sucesso, grava `email_confirmacao_enviado_em`.

  Se o PDF falhar, o e-mail sai sem anexo.

  Fora do escopo: o acerto da troca de plano e o pedido avulso legado.
- **Exemplo** (gerado com o código final): cobrança 42, confirmada em
  25/09/2026 10:05 (Brasília), R$ 267,30, "Plano Destaque — ciclo
  trimestral", pagador "Padaria São João (Matão)", CPF `***.456.789-**`,
  `contato@padaria.test`, recebedor padrão, "Processado por San Checkout
  (Asaas)". Arquivo `comprovante-MST-000042.pdf`, 2.495 bytes; lido pelo
  `pypdf` em modo estrito.
- **Testes** (`tests/email-comprovante.test.js`, 6):
  - PDF válido (xref e `/Length` conferidos) e determinístico;
  - texto obrigatório presente, e o documento nunca diz "nota fiscal";
  - CPF mascarado; sem cobrança não há comprovante;
  - pagamento confirmado sai em HTML + texto com o PDF anexo;
  - HTML escapa `<script>`;
  - todo e-mail ao cliente em HTML + texto e os internos só em texto.

  O SMTP é substituído por um transporte de captura.

## 10. Dependências (DONE)

**Antes** (`npm audit`, 6):

| Severidade | Pacote |
|---|---|
| Critical | `tar` (via `@mapbox/node-pre-gyp` ← `bcrypt`) |
| High | `bcrypt` 5.1.1, `@mapbox/node-pre-gyp` 1.0.11, `nodemailer` 6.10.1 |
| Moderate | `express` 4.22.2 e `qs` 6.15.3 |
| Low | nenhuma |

**Corrigidas (#61, sem `--force`):** `bcrypt` ^6.0.0, `nodemailer` ^10.0.10
e `npm audit fix` comum (`express` 4.22.3, `qs` 6.16.0).

**Restantes:** **0**.

**Justificativa:**

- **bcrypt 6** só troca o `node-pre-gyp` pelo `prebuildify`: mesma API e
  mesmo formato de hash. O bcrypt só confere hash legado, e produção tem 0
  hashes bcrypt.
- **nodemailer 7→10:** as quebras (Node ≥ 20, SES removido, `ENOAUTH`, TLS em
  conteúdo remoto) não tocam o uso (SMTP, `verify`, `sendMail`). Conferido
  com `streamTransport`: multipart + anexo PDF ok.

## 11. Segurança e configuração

- **Segredos no histórico: DONE.** Varredura de `git log --all -p` com os
  padrões de AWS, GitHub, Slack, chave privada, Asaas, URL Postgres com
  senha, JWT, Stripe, senha de app SMTP e token Northflank, sem imprimir
  valores.
  - Achados: só a credencial do Postgres **local do CI** (`@localhost`) e o
    placeholder do `.env.example`.
  - `.env` em 0 commits; `git ls-files` só tem o `.env.example`.
- **Rotação:** **ROTACIONADO — 15/09/2026**, por confirmação do dono
  (PENDENCIAS, item 5 do topo). A checklist A.0.1 continua com as caixas
  desmarcadas e sem a data do passo 7 → gate 10.
- **GitHub Secret scanning / Push protection: NÃO FOI POSSÍVEL PROVAR.** O
  repositório é público, mas a sessão não tem ferramenta que leia
  `security_and_analysis` → gate 10 (WAITING_OPERATOR).
- **Ações em produção durante a execução:**
  - leituras só com `BEGIN READ ONLY`;
  - exec no contêiner do Checkout só para ler **nomes** de variáveis;
  - Access temporário criado e apagado duas vezes (estado final: 0 tokens).

## 12. Ensaio de restauração (DONE)

- **Origem:** volume `/backups` do job `backup`, listado por um run só com
  `ls` (`72311add`, 05:35–05:46 UTC, terminou sozinho; nenhum dump novo).
  - `mostrai-20260920-080036.sql.gz`: 20 bytes, **vazio** (run `4f0f19f0`
    FAILED);
  - `mostrai-20260920-164029.sql.gz`: 47,5 KB (run manual `7c180946`,
    SUCCESS).
- **Destino isolado:** Postgres local 16.13, banco novo `mostrai_ensaio`.
  **Produção não foi tocada.**
- **Resultado:**
  - `gzip -t` ok;
  - `zcat | psql` em 0,7 s;
  - 36 tabelas `public`, com contagens iguais às do dump (anunciantes 3,
    planos 18, pontos 1, dispositivos 1, criativos 1, cobranças 2);
  - 4 erros inofensivos: `transaction_timeout` (parâmetro só do PG17) e o
    cofre `supabase_vault`;
  - `migrate.js` por cima: 25 migrations (065→090) em 0,3 s;
  - app contra o banco restaurado: `/health` ok, 12 planos, login inválido 401;
  - banco de ensaio e dump apagados no fim.
- **RTO medido:** ~1 min técnico (arquivo → app respondendo). Numa
  restauração real, estimativa de 30–60 min (projeto Supabase novo, trocar
  `DATABASE_URL` no serviço e nos jobs, deploy).
- **RPO:** semanal (domingo 08:00 UTC). No ensaio, o último backup válido
  tinha **4 d 13 h**.
- **Problemas:**
  1. backup vazio com cara de backup: corrigido no script; o arquivo antigo
     continua no volume (gate 12);
  2. num Postgres comum só volta o `public` — restaurar num projeto Supabase
     novo.

  Tudo registrado no RUNBOOK §5.

## 13. Asaas sandbox (WAITING_OPERATOR)

`sub_j87cq5u50g6jqv6t` e `sub_xjsad6cpqor5pars`: **não consultadas**. Não
há chave de sandbox acessível nesta sessão:

- o `.env` do Mostraí não tem `ASAAS*`;
- o clone do Checkout só tem `.env.example`;
- o contêiner do Checkout declara `ASAAS_AMBIENTE=producao`.

A chave de produção não foi usada, porque o prompt proíbe tocar em
assinatura de produção.

Contexto da L.2 (25/09): os dois ids não existem em tabela nenhuma do
Mostraí, e o banco do Checkout sandbox estava vazio. São testes abandonados,
sem dinheiro real → gate 11.

## 14. Branches (WAITING_OPERATOR)

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

- **Apagadas:** nenhuma. `git push origin --delete` nas 11 → `HTTP 403` do
  proxy git da sessão, que só permite push na branch designada.
- **Mantidas:** `main` e a branch de trabalho.
- **Precisam revisão:** nenhuma.
- **Gate 9:** o operador apaga as 11 (lista acima).

## 15. Documentação (DONE)

**Atualizados nesta execução:**

- `docs/PENDENCIAS.md`:
  - aviso no topo;
  - **seção M** com os itens que só existiam na conversa e os gates;
  - item 12 (backup) marcado como feito;
  - K.1 e K.2 "sem objeto";
  - nota da válvula removida;
  - Checkout em produção.
- `docs/funcional.md`: RN-53 do banco de horas; comprovante e e-mails.
- `docs/api.md`: `contrato_playlist` sem controle na UI; `bonus` morto.
- `docs/job-apuracao-banco-horas.md`: novo.
- `docs/CONSOLIDATION_STATE.md`: bloco de 25/09.
- `docs/furos.md`: aviso de documento histórico.
- `RUNBOOK.md`:
  - 2 instâncias;
  - §3.1 Checkout em produção FEITA;
  - §5 ensaio de restauração.
- `README.md`.
- `.ia/*`: TODO, RISKS, PROJECT_STATE, INTEGRATIONS, OPERATIONS,
  ARCHITECTURE, HANDOFF, BUSINESS_RULES.
- `docs/teia.md`.
- `tests/e2e/README.md`.
- `.env.example`: `MOSTRAI_COMPROVANTE_RECEBEDOR`.

**Tirados das pendências ativas (superados):**

- rotação de credenciais como "a fazer" (feita em 15/09; falta só a data no
  A.0.1);
- virada do Checkout para produção (feita);
- backup semanal como "a fazer" (job ativo + ensaio);
- válvula de expiração do banco de horas (removida pela decisão MANTER);
- K.1 e K.2 (sem objeto desde a L.2);
- "`bonus.ponto` quebraria o painel" — campo morto, nenhuma tela lê;
- branch `mostrai-estacao-1-pipeline` "não investigada" (ancestral do
  `main`);
- "gerar link novo" para tela V1.

**Conferidos e mantidos:**

- **Acerto proporcional:** o autoteste do Checkout dá 42/42 no `origin/main`
  `43635c4`, extraído só para leitura (o arquivo é idêntico ao do clone
  local). Do lado Mostraí, `troca-de-plano` e `custo-previsto` estão nos
  416/416. A prova com compra real é o gate 3.
- **`bonus.ponto`:** campo morto e intencional, mantido pelo formato da
  resposta.

**Textos legais — inventário (nada alterado; LEGAL_REVIEW, gate 8):**

| Texto | O que está desatualizado |
|---|---|
| `public/termos-de-uso.html` | programa de vendedores; sem modelo de créditos; "vigência começa no pagamento" × pago guardado atrás de benefício; sem banco de horas |
| `public/politica-de-privacidade.html` | dados de vendedor; "emitir nota fiscal" (não há NF sem CNPJ; comprovante não citado); Google Drive listado (código removido em 24/09); SMTP do Workspace não listado; ledger e cupom `PT-` ausentes |
| `public/contrato-anunciante.html` | calendário × benefício; arrependimento condicionado × incondicional (RN-26); "comodante"; atraso × RN-32-A/chargeback; sem banco de horas e comprovante |
| `public/comodato.html` | §3 inteiro no modelo antigo de R$ 50 (também no meta/og); §4.1 horário |
| `contratos/contrato-anunciante-mostrai.pdf` e `contratos/contrato-comodato-mostrai.pdf` | regras antigas (cobertura adiada, cota de autoanúncio) |

## 16. Gates do operador

Só o que depende do operador. Os 8 esperados continuam reais; os 4 últimos
saíram factualmente desta execução.

| # | Gate | Categoria |
|---|---|---|
| 1 | Criar o job `ApuracaoBancoHoras` no Northflank (spec em `docs/job-apuracao-banco-horas.md`; 1ª execução com `--dry-run`) | WAITING_OPERATOR |
| 2 | Enviar o vídeo institucional (nada implementado; caminho em PENDENCIAS §M.A) | WAITING_OPERATOR |
| 3 | Último teste com os dados atuais: compra real, e-mail HTML e PDF chegando numa caixa real, acerto proporcional de uma troca | WAITING_OPERATOR |
| 4 | "Pode resetar" — os dados atuais são de teste (CPF repetido nas contas 3/4/5, ponto 1 sem dono, ponto 3 inativo, 120 créditos na conta 5, plano antigo na conta 3…) | DEFERRED_TO_FINAL_RESET |
| 5 | Decidir o Player V1 (§7) | PRODUCT_DECISION |
| 6 | Decidir o esquema legado antes do reset | DEFERRED_TO_FINAL_RESET |
| 7 | Decisões comerciais abertas: seção L; banco de horas (FIFO×LIFO, conta encerrada com saldo, teto diário, mudança de plano, 3 meses/3×); recebedor do comprovante sem CNPJ; as três notas do §4 (timeout da troca, janela noturna do benefício, cancelar sozinho a assinatura órfã de link cancelado) | PRODUCT_DECISION |
| 8 | Revisão jurídica dos textos (§15) | LEGAL_REVIEW |
| 9 | Apagar as 11 branches mergeadas (§14) | WAITING_OPERATOR |
| 10 | Ligar Secret scanning + Push protection no GitHub e datar a rotação no A.0.1 | WAITING_OPERATOR |
| 11 | Conferir/cancelar no Asaas **sandbox** `sub_j87cq5u50g6jqv6t` e `sub_xjsad6cpqor5pars` | WAITING_OPERATOR |
| 12 | Apagar do volume o backup vazio `mostrai-20260920-080036.sql.gz` (ou nunca restaurar dele) | WAITING_OPERATOR |

**WAITING_EXTERNAL:** nenhum item está parado só por terceiro. O 503
transitório do roteiro 19 fica em observação: o roteiro agora registra o
endereço.

**Confirmações:**

- nenhum reset foi executado;
- nenhum dado do último teste foi apagado ou corrigido; em produção só houve
  leituras `READ ONLY` e migrations aditivas por deploy;
- o job `ApuracaoBancoHoras` **não** foi criado;
- o vídeo institucional **não** foi implementado;
- nenhuma cobrança, estorno ou cancelamento real foi feito;
- o Checkout não foi alterado;
- o Access nunca ficou desligado.

**Adendo (25/09/2026, depois do fechamento acima):** o gate 1 foi cumprido —
o job `ApuracaoBancoHoras` foi criado no Northflank pela especificação deste
relatório e de `docs/job-apuracao-banco-horas.md`, e a 1ª execução manual em
`--dry-run` rodou com sucesso. Estado atualizado em `docs/PENDENCIAS.md`
(item 14 e seção M).

**Segundo adendo (25/09/2026, mesmo dia):** o gate 2 também foi cumprido —
o vídeo institucional que o dono enviou está implementado e publicado em
produção (não só o código: o arquivo real, normalizado, servindo do
Storage, confirmado com `HEAD` real na URL pública). Confirmado também que
o job `ApuracaoBancoHoras` está operacional (não só criado): habilitado,
sem duplicata, mesma SHA de produção, lock e idempotência no código. No
meio do caminho houve um incidente de exposição de credenciais (todos os
segredos do serviço `mostrai` apareceram em texto puro na saída de uma
ferramenta de diagnóstico); 4 segredos foram rotacionados e validados sem
indisponibilidade, e o operador decidiu encerrar o incidente sem rotacionar
os outros 3 (`OPERATOR_ACCEPTED_NO_ROTATION`). Detalhe completo, sem nenhum
valor de segredo: `RUNBOOK.md` §2.1. Estado atualizado em
`docs/PENDENCIAS.md` (seção M) e `.ia/PROJECT_STATE.md`.

**Terceiro adendo (25/09/2026, 21:00 UTC):** RESET FINAL DE DADOS DE TESTE
EXECUTADO — gate 4 cumprido, com autorização do dono. Backup pré-reset
verificado (`/backups/mostrai-20260925-205316.sql.gz`, 73.990 bytes, sha256
`805a18b5…81249`). 132 linhas de teste removidas numa transação com guarda
contra dado real; 9 arquivos de teste removidos do Storage. Estrutura,
planos, configuração, vídeo institucional e jobs preservados; 0 linha
órfã, 0 arquivo órfão. As afirmações da seção "Confirmações" acima ("nenhum
reset foi executado") valiam na data do relatório e continuam registradas
como estavam. Detalhe: `RUNBOOK.md` §5.1.
