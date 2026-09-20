# Current Handoff

## Updated
2026-09-20

## Current priority
Revisão manual funcional e visual conduzida pelo dono. Ele já está aproximadamente na metade. Não reiniciar auditoria: receber a próxima observação, investigar transversalmente e fazer a menor correção coerente.

## Functional map
Inventário completo de site público, conta, anunciante, ponto, vendedor, player, Checkout, 25 seções admin e jobs em `docs/mapa-funcional-completo-2026-09-20.md`.

## New confirmed finding
`src/admin/metrica.js` usa o status antigo `p.status = 'ativo'` ao calcular amortização histórica. Pontos atuais usam `em_operacao`; a aba Métrica zera amortização e pode inflar margem. Visão geral está correta. Não corrigido porque esta etapa era mapeamento.

## Paused until explicit request
Player/proof-of-play, banco de horas/déficit físico, corridas da playlist e troca proporcional. Manter registrados, não trabalhar espontaneamente.

## Existing temporary diagnostic
`?debug=1` no player local permanece disponível, mas não retomar teste/correção sem pedido.

## Next action
Aguardar a próxima tela/observação do dono. Classificar como bug, inconsistência, melhoria visual, decisão, legado ou não confirmado; checar impactos laterais antes de alterar.
