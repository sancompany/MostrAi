-- TICK — Campanhas, PR 4: a promoção de preço (modalidade 'desconto', 017)
-- passa a valer no pedido. O preço é calculado SEMPRE no servidor, na criação
-- do pedido, sob a trava da edição (pedidos.criar) — o navegador nunca manda
-- preço. Cada vaga com desconto guarda a campanha que a deu; o item do pedido
-- guarda a campanha e o preço cheio do lote (o que o comprador viu riscado).
--
-- Só acréscimos, todos opcionais (NULL = sem desconto, como todo pedido de
-- antes). Nenhum dado existente muda; nenhuma tabela ou coluna sai.
--
-- O que conta como "unidade promocional usada" (pendência P1): vaga com a
-- campanha cujo ingresso FOI emitido (pago — mesmo que depois reembolsado ou
-- cancelado) + vaga de pedido aguardando pagamento com a reserva viva.
-- Reserva vencida sem pagamento não conta (nunca foi vendida).
--
-- Reversão (só antes de existir pedido com desconto):
--   DROP INDEX ix_reservas_campanha;
--   ALTER TABLE reservas DROP COLUMN campanha_id;
--   ALTER TABLE pedido_itens DROP CONSTRAINT pedido_itens_desconto_coerente;
--   ALTER TABLE pedido_itens DROP COLUMN campanha_id, DROP COLUMN preco_original_centavos;

ALTER TABLE pedido_itens ADD COLUMN campanha_id bigint REFERENCES campanhas(id);
ALTER TABLE pedido_itens ADD COLUMN preco_original_centavos bigint;
-- Item com desconto: só de ingresso individual (lote, nunca combo), com o
-- preço cheio registrado e o preço cobrado abaixo dele.
ALTER TABLE pedido_itens ADD CONSTRAINT pedido_itens_desconto_coerente CHECK (
  (campanha_id IS NULL) = (preco_original_centavos IS NULL)
  AND (campanha_id IS NULL OR (lote_id IS NOT NULL AND preco_unitario_centavos < preco_original_centavos))
);

ALTER TABLE reservas ADD COLUMN campanha_id bigint REFERENCES campanhas(id);
CREATE INDEX ix_reservas_campanha ON reservas (campanha_id) WHERE campanha_id IS NOT NULL;
