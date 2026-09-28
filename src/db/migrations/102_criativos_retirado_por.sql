-- Quem tirou a peça do ar (finalização, 28/09/2026, pedido do dono): o
-- cliente pode PAUSAR e RETOMAR a própria peça aprovada pelo painel; o admin
-- retira pela ficha; a substituição aprovada retira o original. Só volta
-- pela mão do cliente o que o cliente pausou — o que o admin retirou (ou a
-- troca retirou) continua "fora do ar" até o admin colocar no ar de novo.
-- NULL em peça que não está retirada.
ALTER TABLE criativos
  ADD COLUMN IF NOT EXISTS retirado_por text
  CHECK (retirado_por IS NULL OR retirado_por IN ('cliente', 'admin', 'substituicao'));
