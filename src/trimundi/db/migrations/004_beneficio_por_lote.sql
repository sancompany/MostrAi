-- Trimundi — benefício do ingresso com estoque e resgate (pedido do dono,
-- 09/11/2026). Ex.: "Ingresso TREEMUNDO — direito a 1 copão personalizado".
--   · o Admin diz QUAL benefício um lote dá (lotes.beneficio_id) e QUANTOS
--     existem (beneficios.quantidade; vazio = sem limite);
--   · elegibilidade: a linha em ingresso_beneficios, gravada na emissão só
--     enquanto houver estoque (ingresso cancelado devolve a unidade);
--   · resgate: uma vez só (resgatado_em/por), gravado na portaria.

ALTER TABLE beneficios ADD COLUMN quantidade integer CHECK (quantidade BETWEEN 1 AND 100000);
ALTER TABLE lotes ADD COLUMN beneficio_id bigint REFERENCES beneficios(id);

ALTER TABLE ingresso_beneficios DROP CONSTRAINT ingresso_beneficios_origem_check;
ALTER TABLE ingresso_beneficios ADD CONSTRAINT ingresso_beneficios_origem_check
  CHECK (origem IN ('categoria', 'lote', 'promocao', 'cortesia'));
ALTER TABLE ingresso_beneficios ADD COLUMN resgatado_por text CHECK (char_length(resgatado_por) <= 200);
ALTER TABLE ingresso_beneficios ADD CONSTRAINT ingresso_beneficios_resgate
  CHECK ((resgatado_em IS NULL) = (resgatado_por IS NULL));
CREATE INDEX ix_ingresso_beneficios_beneficio ON ingresso_beneficios (beneficio_id);
