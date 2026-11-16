-- TICK — Campanhas: promoção de preço em INGRESSO INDIVIDUAL (pedido do dono,
-- 16/11/2026). "Os primeiros 30 VIP com 30% de desconto", "Pista por R$ 79,90
-- até meia-noite ou enquanto houver". Usa a mesma tabela `campanhas` (mesmo
-- status, janela, pausa, acumulação, prioridade, alvos e auditoria) — nada de
-- sistema paralelo de desconto. Os combos (promocoes) seguem como estão.
--
-- O que muda aqui (só na tabela `campanhas`, criada na 015 e ainda fora de
-- produção):
--   · a modalidade passa a aceitar 'desconto' — a restrição de modalidade é
--     trocada por outra MAIS AMPLA (nenhum dado existente fica inválido);
--   · colunas novas do desconto: tipo (percentual, valor fixo em centavos, ou
--     preço promocional), valor e quantidade promocional (o estoque da
--     promoção, contado por ingresso).
-- A aplicação do desconto no pedido (pedido_itens/reservas) vem na 018.
--
-- Reversão (só antes de existir campanha 'desconto'):
--   ALTER TABLE campanhas DROP CONSTRAINT campanhas_desconto_coerente;
--   ALTER TABLE campanhas DROP COLUMN desconto_tipo, DROP COLUMN desconto_valor,
--     DROP COLUMN quantidade_promocional;
--   ALTER TABLE campanhas DROP CONSTRAINT campanhas_modalidade_check;
--   ALTER TABLE campanhas ADD CONSTRAINT campanhas_modalidade_check
--     CHECK (modalidade IN ('ordem_compra', 'indicacao'));

ALTER TABLE campanhas DROP CONSTRAINT campanhas_modalidade_check;
ALTER TABLE campanhas ADD CONSTRAINT campanhas_modalidade_check
  CHECK (modalidade IN ('ordem_compra', 'indicacao', 'desconto'));

ALTER TABLE campanhas ADD COLUMN desconto_tipo text
  CHECK (desconto_tipo IS NULL OR desconto_tipo IN ('percentual', 'valor', 'preco'));
-- percentual: 1 a 90 (%); valor: centavos a menos; preco: preço final em centavos.
ALTER TABLE campanhas ADD COLUMN desconto_valor bigint
  CHECK (desconto_valor IS NULL OR desconto_valor BETWEEN 1 AND 5000000);
ALTER TABLE campanhas ADD COLUMN quantidade_promocional integer
  CHECK (quantidade_promocional IS NULL OR quantidade_promocional BETWEEN 1 AND 100000);
ALTER TABLE campanhas ADD CONSTRAINT campanhas_desconto_coerente CHECK (
  (modalidade = 'desconto') = (desconto_tipo IS NOT NULL AND desconto_valor IS NOT NULL AND quantidade_promocional IS NOT NULL)
  AND (desconto_tipo IS DISTINCT FROM 'percentual' OR desconto_valor BETWEEN 1 AND 90)
);
