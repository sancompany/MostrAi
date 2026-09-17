-- A PEÇA PRONTA SAI DOS PLANOS, a pedido do dono em 17/09/2026: "sobre os
-- anúncios, nunca disse que era benefício, e sim fica separado dos planos com
-- negociação direta pelo WhatsApp, pelo valor que vai ser cobrado".
--
-- "Peça simples incluída: se você não tem arte, a gente faz" estava no
-- ESSENCIAL, que é o plano de R$ 99 e o que mais vende. Cada cliente novo
-- podia cobrar uma arte, e trinta clientes seriam trinta peças na mão do
-- dono — o mesmo problema do relatório mensal que saiu na 048, só que no
-- plano de maior volume.
--
-- Produção de peça vira SERVIÇO À PARTE: negociado no WhatsApp, com preço
-- combinado caso a caso. Não é benefício de plano, não entra na vitrine, e
-- não cria obrigação recorrente pra ninguém.
--
-- A regra que o dono deu, e que vale pra todo benefício futuro:
--   PODE  — promessa que não gera trabalho recorrente.
--   NÃO PODE — promessa que vira tarefa dele, todo mês, pra todo cliente.
-- Quando o serviço é real e dá trabalho, ele tem preço; não vira brinde
-- escrito no card.

DELETE FROM planos_beneficios
 WHERE beneficio_id IN (
   SELECT id FROM beneficios WHERE texto = 'Peça simples incluída: se você não tem arte, a gente faz'
 );

DELETE FROM beneficios WHERE texto = 'Peça simples incluída: se você não tem arte, a gente faz';
