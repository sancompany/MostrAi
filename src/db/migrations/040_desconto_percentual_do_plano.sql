-- Pedido do dono, 16/09/2026: em vez de digitar o valor mensal já com
-- desconto embutido, o admin digita o preço cheio (`valor_mensal_cheio`,
-- coluna que já existia) e uma porcentagem de desconto — o `valor_mensal`
-- cobrado de verdade passa a ser calculado a partir dos dois
-- (planos-repository.js, calcularValorMensal), não mais digitado direto.
-- Sem desconto (coluna vazia), valor_mensal = valor_mensal_cheio.
ALTER TABLE planos ADD COLUMN desconto_percentual numeric(5,2);
