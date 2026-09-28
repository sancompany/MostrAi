# TODO.md — O que falta, organizado por urgência

## NOW

**Decisões D1–D6 resolvidas (24/09/2026)** — ADR-017; detalhe em
`docs/PENDENCIAS.md`, "Decisões D1–D6 do dono e auditoria seguinte".
Continuam com o dono (nada mudado sozinho):
- C1 pré-venda com 20% em 3/6/12 meses: compromisso maior não dá desconto
  maior; o Anual ficou sem vantagem nenhuma.
- C2 promoção menor que o desconto do ciclo cobraria mais caro (ADR-014
  substitui) — impedir/avisar no admin ou mudar a regra.
- C3 adesão ao Anual grava a promoção sem vantagem (gastaria vaga se houver
  limite de adesões).
- C4 pré-venda termina 31/10 às 00:00 (o digitado) — trocar pra 23:59 se a
  intenção era o dia inteiro.
- A1 conferir o período da mídia própria 1; A2 completar bairro dos pontos
  1 e 2; A3 limpar a descrição de teste da pré-venda (tudo no admin).

**Atualizado 21/09/2026 — plano do dono pros próximos ~2 dias, antes de
começar a vender:**
1. **Revisão visual do painel do anunciante — primeira rodada feita
   (21/09/2026), painel admin ainda não revisado.** Cor da marca corrigida
   (hero deixou de ser azul-marinho, virou laranja queimado dentro de
   `--brand`), hero sem KPI duplicado + estado operacional (ponto
   online/offline), linguagem de métricas corrigida ("previstas", custo
   por 1.000, média diária). Detalhe completo em `.ia/HANDOFF.md`,
   "Advertiser dashboard — segunda camada de refinamento". **Ainda falta**:
   revisão visual do painel ADMIN (não tocado nesta rodada — `public/
   admin/index.css` já usa só tokens, então pode não precisar de nada, mas
   não foi conferido tela por tela); e essa rodada do anunciante está numa
   branch (`claude/busy-noether-hheir2`), aguardando o dono revisar e
   autorizar merge/deploy.
2. Terminar o app Android TV da playlist —
   `docs/proximas-versoes.md`, "App Android TV nativo..." (projeto à
   parte, fora deste repositório).
3. ~~Trocar o San Checkout de sandbox pra produção~~ — **FEITO**: o San
   Checkout está em produção (`ASAAS_AMBIENTE=producao`, Pix e cartão reais
   homologados; conferido em 25/09/2026).
4. Finalizar os testes (checar se `npm run check` e os e2e cobrem o
   redesign do Codex).

**Ordem combinada com o dono, 20/09/2026: ele termina primeiro uma revisão
do site em andamento pelo Codex (fora deste canal); os dois bugs abaixo
ficam reservados pra serem resolvidos por este agente (Claude Code), não
pelo Codex — explícito, não assumir o contrário.**

- **Descobrir a causa real de "anúncio nunca passou na TV"** (conta San
  União, único ponto da rede: "Bruno Henrique Sanches").
  - Objetivo: identificar por que os anúncios dessa conta não estão
    veiculando, e corrigir.
  - Estado: seis hipóteses comuns já descartadas por leitura de código
    (upload/ffmpeg síncrono sem estado quebrado possível; filtro de
    categoria comprovadamente inofensivo hoje — ver abaixo; fila de
    aprovação já visível como contador no admin). Causa real **não
    confirmada**.
  - Checklist ainda pendente (a conferir direto no `/admin` de produção ou
    via acesso de leitura ao Supabase, projeto `MostrAi`):
    1. O criativo dessa conta está com `status = 'aprovado'` E
       `arquivo_normalizado_url IS NOT NULL`?
    2. A conta tem `plano_id` preenchido (pago ou cortesia)?
    3. O plano dela tem `segundos_por_hora` preenchido (não nulo/zero)?
    4. O ponto "Bruno Henrique Sanches" tem `status = 'em_operacao'`?
    5. A(s) tela(s) desse ponto têm `aparelho_id` gerado e
       `ultima_vez_online` recente?
    6. A conta escolheu esse ponto explicitamente em "Onde seu anúncio
       aparece", ou está em branco esperando o sorteio automático?
  - Arquivos envolvidos: `src/playlist/gerador.js`
    (`anunciantesElegiveis`), `src/anunciantes/routes.js` (aprovação/plano),
    `src/dispositivos/repository.js` (pareamento/online).
  - Dependências: acesso de leitura ao Supabase de produção (ferramenta MCP
    exigiu aprovação nesta sessão e não foi concedida a tempo) ou resposta
    do dono ao checklist acima.
  - Critério de conclusão: causa identificada com evidência (não só
    hipótese), corrigida ou explicada ao dono, e o item fechado na seção F
    de `docs/PENDENCIAS.md`.

- **Fechar a causa da falha de troca de plano** ("não foi possível calcular
  o acerto proporcional desta troca").
  - Objetivo: confirmar que a causa é mesmo do lado do San Checkout (já
    apontada nesta sessão) e, se sim, orientar a correção pro lado certo.
  - Estado: os três valores enviados pelo Mostraí foram verificados
    corretos contra o código-fonte real do `sancompany/san_checkout`. A
    falha bate em `dadoIncoerente` de `calcularAcertoDeTroca`
    (`proporcionalService.js` do Checkout) — aponta pra dado de assinatura
    (ciclo/vencimento) incoerente do lado de lá.
  - Dependências: acesso ao banco do San Checkout (projeto Supabase
    `San_Checkout` — ref/host não registrado aqui, ver
    `.ia/INTEGRATIONS.md`) para a assinatura afetada, ou envolvimento de
    quem administra o Checkout.
  - Critério de conclusão: causa confirmada com dado real (não só
    inferência do contrato de API), e a assinatura afetada corrigida ou o
    cliente contornado manualmente.

- **Checar duplicidade de contas por documento (CPF/CNPJ) em produção**
  (21/09/2026, admin reorganizado por este agente).
  - Estado: `src/anunciantes/repository.js` passou a normalizar `cpf_cnpj`
    na gravação (dali pra frente); contas já existentes com o mesmo
    documento em formatações diferentes **não foram consolidadas** — nenhum
    apagamento, nenhum merge automático, a pedido explícito do dono.
  - Query de diagnóstico pronta em `docs/PENDENCIAS.md`, seção G (agrupa por
    documento normalizado, mostra os ids duplicados). Rodada contra o banco
    local: 0 duplicidades (é dado de sandbox). **Produção ainda não foi
    checada.**
  - Critério de conclusão: rodar a query em produção; se houver duplicidade,
    decidir com o dono caso a caso (nunca merge automático) antes de propor
    qualquer constraint `UNIQUE` em `cpf_cnpj`.

- **Marcar `contrato_playlist=2` na(s) tela(s) do app Android nativo, quando
  o dono confirmar o app rodando em hardware real** (21/09/2026 — contrato
  do backend pronto, ver `.ia/HANDOFF.md` e `docs/PENDENCIAS.md` seção H).
  - Estado: nenhuma tela em produção está no contrato novo ainda — todas
    seguem em `1` (array de sempre), player web intocado.
  - Dependência: `sancompany/playlist.mostrai`, `docs/pendencias.md`, "só o
    dono faz" — instalar o APK num aparelho real e testar contra este
    backend de verdade (nunca testado, só JSON sintético do lado do app).
  - Critério de conclusão: `PATCH /admin/dispositivos/:id
    {"contrato_playlist":2}` na tela certa, e confirmação visual de que o
    app está tocando a playlist e reportando `/played` em lote.

## NEXT

- **IDEIA FUTURA, não implementada (21/09/2026, pedido explícito do dono ao
  registrar, não ao construir):** reservar ~20% da capacidade de cada ponto
  pra conteúdo institucional/estratégico (hoje é 100% comercial). Não mexer
  em playlist/pacing pra isso sem novo pedido — ver `.ia/HANDOFF.md`.

- **Completar o teste ponta a ponta do congelamento da hora da playlist**
  (ADR-005).
  - Estado: `tests/playlist-congelamento.test.js` já cobre serialização da
    base/extras e rollback. Ainda falta cobrir o payload final do gerador:
    "quem já estava programado não muda de posição; quem chega depois entra
    sempre no fim".
  - Arquivos: `src/playlist/gerador.js`,
    `src/playlist/congelamento-repository.js`, `tests/`.
  - Critério de conclusão: teste roda em `npm test`/`npm run check` e falha
    se a garantia for quebrada.
- ~~Criar o job `ApuracaoBancoHoras` no Northflank~~ — **FEITO em
  25/09/2026**, pela especificação de `docs/job-apuracao-banco-horas.md`
  (cron `0 6 1 * *` UTC, `Forbid`, `backoffLimit 2`,
  `activeDeadlineSeconds 600`, `nf-compute-20`, imagem do mesmo
  repositório/branch `main` que o `Conciliacao`, variáveis só
  `DATABASE_URL` e `NODE_ENV`). 1ª execução manual com `--dry-run`: código
  0, nada gravado.
- ~~Investigar se `bonus.ponto` sempre `null` é intencional~~ — **resolvido
  (25/09/2026)**: é intencional e o campo `bonus` de `GET /conta/modos` é
  morto (nenhuma tela lê; o módulo de bônus foi aposentado). Detalhe em
  `docs/FECHAMENTO_PRE_GATES_2026-09-25.md`.

## LATER

- Regenerar `docs/teia.md` e `docs/furos.md` (dívida já reconhecida em
  `docs/PENDENCIAS.md` — várias entradas descrevem fluxos aposentados em
  18/09/2026).
- ~~Ensaiar a restauração de um backup~~ — **FEITO em 25/09/2026**
  (`RUNBOOK.md` §5: restauração isolada, RTO/RPO medidos, backup vazio de
  20/09 achado e corrigido no `scripts/backup.sh`).
- ~~Investigar a branch `claude/mostrai-estacao-1-pipeline-y2vgr5`~~ —
  **resolvido**: já está inteira no `main` (0 commits próprios); listada
  para exclusão em `docs/FECHAMENTO_PRE_GATES_2026-09-25.md` §14.
- Cronometrar um revert completo (`RUNBOOK.md`, seção 4 — "[Estação 6]").

## BUGS

Ver `NOW` e a atualização da auditoria abaixo. Além dos dois relatos
anteriores, a auditoria confirmou falhas de integridade na confirmação/banco
de horas. As condições de corrida do congelamento foram corrigidas em
20/09/2026.

## TECHNICAL DEBT

- `docs/furos.md` e registros antigos dizem que `categoria_id` do ponto nunca
  é gravado. Isso está desatualizado: cadastro de endereço/admin gravam e
  produção possui o campo. Falta teste ponta a ponta do bloqueio.
- Rate limit de tentativas (`src/lib/limite-tentativas.js`) é em memória —
  reinicia a cada deploy/restart. Aceitável hoje pela escala, mas não
  sobrevive a duas instâncias sem sincronizar.

## AUDITORIA 20/09/2026 — prioridade acima da fila anterior

- **Fechar integridade `player → confirmação → métrica`**: revisar a TV física; decidir o que constitui conclusão; implementar confirmação durável/idempotente/retry e alinhar dashboard/contador. O anúncio investigado foi programado; a lacuna está depois da playlist. ~~Decidir em item separado se falha física deve criar saldo diferente do banco de capacidade atual.~~ **Decidido na estação do Saldo de Veiculação (27/09/2026):** um saldo só, em tempo — obrigação da hora aberta − entrega confirmada; falha física em hora aberta (inclusive TV sem sinal) entra nele (RN-53).
- **Fechado em 20/09/2026 — concorrência do congelamento**: resolução serializada por `(dispositivo, hora)` com advisory lock transacional; a perdedora relê a base vencedora e extras são calculados/anexados na mesma seção crítica. Coberto por `tests/playlist-congelamento.test.js`. Não confundir repetições legítimas da frequência com duplicação de leva.
- **Corrigir registro de categoria na documentação**: código atual e produção gravam `categoria_id`; falta teste ponta a ponta do bloqueio e regenerar `docs/furos.md`.
- ~~**Triar dependências**~~ — **FEITO (PR #61, 25/09/2026)**: `npm audit` em 0 sem `--force` (bcrypt 6, nodemailer 10, express 4.22.3).

## PLAYER/TV — próximo passo após investigação de 20/09/2026

- Executar o roteiro da TV em `docs/investigacao-player-confirmacao-2026-09-20.md`, capturando playlist, mídia, eventos, heartbeat e status/body de `/played`.
- O modo temporário `?debug=1` já está pronto e não muda a contagem; usá-lo se DevTools remoto não estiver disponível.
- Depois do diagnóstico, aprovar contrato `playing` = iniciada, `ended` = concluída, aceite idempotente = confirmada; ~~definir separadamente se falha física alimenta outro saldo ou o banco atual~~ — alimenta o Saldo de Veiculação (RN-53, 27/09/2026).

## DEBUG DO PLAYER PRONTO — próximo passo é teste físico

- Abrir a URL completa da TV com `&debug=1`; confirmar painel e logs com prefixo `[MostrAi Player Debug]`.
- Observar uma execução completa e registrar playlist, `play()`, eventos, `/played`, heartbeat e avanço; repetir com queda antes/durante a mídia.
- Comparar contadores do painel PIN antes/depois e exportar HAR sem headers/chave.
- Depois do teste, retirar `debug=1` e classificar a evidência antes de alterar contabilização.

## MAPA FUNCIONAL 20/09/2026 — revisão manual ativa

- Inventário completo de usuário/admin: `docs/mapa-funcional-completo-2026-09-20.md`.
- **Novo bug confirmado, não corrigido:** `src/admin/metrica.js` usa `p.status = 'ativo'` na amortização histórica; status atual é `em_operacao`, então a aba Métrica zera esse custo. Tratar quando o dono chegar nessa tela ou autorizar.
- Continuar da metade atual da revisão indicada pelo dono; não reiniciar auditoria nem retomar espontaneamente os bugs técnicos pausados.
- **Fechado:** Termos públicos sincronizados com cadastro multipapel, cobertura imediata, cancelamento pelo painel e orçamento por hora/estimativa de 12h por dia.

## SALDO DE VEICULAÇÃO — estação CONCLUÍDA (#85 mergeado, 27/09/2026)

Validações operacionais que ficam (não bloqueiam; só observar e reportar):

- [ ] Uma noite real com o ponto fechado: nenhuma linha comercial nas horas
  fechadas (`exibicoes_contador` sem linha fora do horário do ponto).
- [ ] Um período aberto com a TV desligada: a hora ganha a obrigação
  (`obrigacao_sem_pedido = true`) e, sem comprovante, vira saldo.
- [ ] Primeira apuração real do `ApuracaoBancoHoras` (01/10/2026, 06:00 UTC):
  log com "hora(s) aberta(s) sem sinal" e "provisório"; linha em
  `banco_horas_execucoes` sem `abortou`; card "Saldo de veiculação" no painel
  só se houver saldo.
- [ ] Recomposição na janela de comprovantes atrasados (até 00:00 de
  08/10/2026 em Matão): o `Conciliacao` diário recompõe a linha de setembro; depois
  disso ela congela (`apurado_em` para de mudar).

Decisão de produto separada (não mexer sem o dono): Mídia Mostraí disputa a
camada da base (T1) com o comercial numa hora cheia — comportamento atual
preservado; ver `.ia/RISKS.md`.

## CARDS DE PONTOS DO CLIENTE — antes e depois do merge (28/09/2026)

- [x] Antes do merge: branch atualizada com a `main` (#97, #98);
  `npm run check` e os e2e 35, 26, 30 e 29 verdes. Merge autorizado pelo
  dono em 28/09/2026.
- [ ] Ao retomar o PR #90: tirar a parte visual do card dele (fica a do
  #100); a fila de salvamento é decisão à parte (`docs/PENDENCIAS.md` §T2).
- [ ] Depois do merge: CI verde no SHA mergeado,
  deploy com o SHA novo, conferir "Onde seu anúncio aparece" no ar em
  desktop e celular com as fotos reais dos pontos (§T1).
- Decisões do dono, fora desta estação: texto de ponto sem horário (§T3),
  "Meus pontos" com o card de foto grande (§T4), mostrar "na cobertura
  hoje" (§T5).

## PROMOÇÕES — reforço visual (28/09/2026)

- [ ] Depois do merge (só com autorização): CI no SHA mergeado, deploy,
  Home/Planos em produção com a pré-venda (id 7) mostrando "ATÉ 30% OFF",
  painel logado com a faixa e o X.
- Pendências do dono herdadas (PENDENCIAS §R): R0–R4.

## CATEGORIAS E CONCORRENTES DIRETOS — antes e depois do merge (28/09/2026)

- [ ] Antes do merge: atualizar a branch com a `main`; se o Plano Básico
  entrou, resolver `coberturaDaConta` (ADR-026), conferir que o Básico
  segue só no ponto da própria conta, rerodar `npm run check` e os e2e
  26/28 (e o 34 do Básico).
- [ ] Depois do merge (só com autorização): CI verde no SHA mergeado,
  deploy com o SHA novo, migration 105 aplicada em produção (48 pares,
  "Terapia capilar" ativa), Admin → Categorias → Cafeteria mostra
  Padaria e Confeitaria / Doceria nos dois lados.
- Decisão do dono, fora desta estação: pares novos além da matriz de
  28/09/2026 (o admin cadastra pela tela).

## QR CODE INSTITUCIONAL — depois do PR (27/09/2026)

- [ ] Depois do merge: CI verde no commit mergeado, deploy com o SHA novo,
  `curl -sI https://mostrai.sancocore.com.br/q/anuncie` → 302 para a página
  de planos com `Cache-Control: no-store`.
- [ ] Validação física: baixar PNG e SVG no admin de produção, imprimir e
  escanear com dois celulares (Android e iPhone); conferir o QR dentro do
  vídeo institucional numa TV a 2–3 m.
- [ ] Se o endereço do site mudar um dia, o antigo continua respondendo
  `/q/anuncie` — o QR impresso aponta pra ele (ADR-024).
- Estação futura, não iniciar sem o dono: QR por ponto, de indicação ou com
  contagem de acessos (`docs/proximas-versoes.md`, "QR rastreável").

