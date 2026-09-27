# Mídia Mostraí nunca gerava comprovante

**Sintoma.** Não havia como saber quantas vezes uma Mídia Mostraí tinha
tocado: nenhuma métrica, nenhum registro.

**Causa raiz.** O gerador mandava os itens `midia:N` com `contabiliza:
false`, e o Player (FilaProofOfPlay.registrarInicio) só cria execução pra
item com `contabiliza: true`. O servidor recusava `midia:N` no `/played`
como `item_invalido`.

**Correção.** Itens da Mídia Mostraí com `contabiliza: true`; o `/played`
aceita `midia:N` e credita em `midias_exibicoes_contador` (migration 099 —
programadas × confirmadas por mídia/tela/hora, mesmo teto), nunca em
`exibicoes_contador`. Idempotência continua por `execucaoId`. Métricas em
`src/midias/metricas.js`. Contrato: `docs/player-mvp-contract.md` §7/§8.

**Regra.** Métrica de exibição só existe onde existe comprovante: antes de
prometer "quantas vezes tocou", conferir se o Player gera o evento.
