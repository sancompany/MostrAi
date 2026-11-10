-- TICK — limite de ingressos por CPF NA EDIÇÃO (pedido do dono, 10/11/2026).
-- Ex.: a TREEMUNDO permite até 4 ingressos por CPF. É da edição, nunca da
-- conta global: outro evento tem o limite dele. Conta os ingressos pagos
-- (não cancelados) e os reservados vivos de pedidos daquele CPF; pedido
-- expirado, cancelado ou reembolsado libera. Vazio = sem limite na edição
-- (o limite por tipo de ingresso, `categorias.limite_por_comprador`, segue
-- valendo à parte).

ALTER TABLE edicoes ADD COLUMN limite_por_cpf integer CHECK (limite_por_cpf BETWEEN 1 AND 100);
