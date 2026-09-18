-- TERMINOLOGIA DA VITRINE: "peça" e "criativo" viram "anúncio" no que o
-- cliente lê (pedido do dono, 18/09/2026, na revisão da aba Planos). O termo
-- técnico continua no código e no banco — só a palavra que aparece no card
-- muda.
--
-- Só existe UM benefício de catálogo com a palavra antiga vinculado a plano
-- ATIVO: o id 17, nos quatro planos Pro (destaque-1m-v2/3m/6m/12m). Os
-- outros três que citam "criativo" (ids 1, 4, 12) estão presos a versões
-- ARQUIVADAS (essencial-1m, destaque-1m) e não aparecem em lugar nenhum da
-- vitrine hoje — não precisam mudar.
--
-- Texto é campo de VITRINE (`beneficios.texto`), muda na hora, não alcança
-- quem já assinou de um jeito diferente.
UPDATE beneficios SET texto = 'Seu anúncio tem prioridade de aprovação'
 WHERE texto = 'Sua peça entra na frente na fila de aprovação';
