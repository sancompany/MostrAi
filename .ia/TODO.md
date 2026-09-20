# TODO.md — O que falta, organizado por urgência

## NOW

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

## NEXT

- **Teste automatizado para o congelamento da hora da playlist** (ADR-005).
  - Objetivo: cobrir em `tests/` (unitário sobre `gerador.js`, ou um script
    e2e permanente) o comportamento "quem já estava programado não muda de
    posição; quem chega depois entra sempre no fim" — hoje só verificado
    manualmente.
  - Arquivos: `src/playlist/gerador.js`,
    `src/playlist/congelamento-repository.js`, `tests/`.
  - Critério de conclusão: teste roda em `npm test`/`npm run check` e falha
    se a garantia for quebrada.
- **Confirmar se o job `ApuracaoBancoHoras` existe no Northflank**
  (`docs/PENDENCIAS.md`, item A.14; `RUNBOOK.md` já registra a incerteza).
  - Critério de conclusão: job confirmado existente e rodando mensalmente,
    ou criado se não existir.
- **Investigar se `bonus.ponto` sempre `null` em `GET /conta/modos` é
  intencional** (`src/conta/modos.js`) — o banner "você ganhou uma tela"
  nunca aparece no Painel hoje.
  - Critério de conclusão: confirmado como intencional (documentar por
    quê) ou corrigido para refletir o bônus real de quem já cumpriu a
    condição.

## LATER

- Regenerar `docs/teia.md` e `docs/furos.md` (dívida já reconhecida em
  `docs/PENDENCIAS.md` — várias entradas descrevem fluxos aposentados em
  18/09/2026).
- Ensaiar a restauração de um backup (`RUNBOOK.md`, seção 5) — nunca foi
  feito; "backup não restaurado é backup hipotético".
- Investigar a branch `claude/mostrai-estacao-1-pipeline-y2vgr5`
  (Dockerfile de produção para o Northflank) — entender se é trabalho ainda
  relevante ou pode ser descartada.
- Cronometrar um revert completo (`RUNBOOK.md`, seção 4 — "[Estação 6]").

## BUGS

Ver `NOW` acima para os dois bugs abertos com investigação em andamento
(anúncio não veicula; troca de plano falhando). Nenhum outro bug aberto
confirmado nesta sessão além desses dois.

## TECHNICAL DEBT

- `categoria_id` do ponto nunca é gravado por nenhum caminho de cadastro —
  o filtro de "sem concorrente na sua tela" existe no motor mas nunca
  dispara na prática (`docs/furos.md`, já catalogado). Consertar exige
  decidir onde coletar `categoria_id` do ponto em cada um dos caminhos de
  criação (candidatura, admin, `POST /anunciantes/me/pontos`).
- Rate limit de tentativas (`src/lib/limite-tentativas.js`) é em memória —
  reinicia a cada deploy/restart. Aceitável hoje pela escala, mas não
  sobrevive a duas instâncias sem sincronizar.
