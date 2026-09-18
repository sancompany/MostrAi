-- Banco de horas (G.3 de docs/PENDENCIAS.md, ideia do dono: "criamos um
-- banco de horas mensal para anúncios que não couberam; eles ganham
-- prioridade no próximo mês e abatem as horas"). Pra apurar QUANTO não
-- coube por causa da hora estar vendida (RN-30, teto de 3600s), falta
-- guardar o que o anunciante PEDIU antes do corte proporcional — hoje
-- `exibicoes_contador.vezes_programadas` só guarda o que sobrou DEPOIS do
-- corte, então a diferença "pedido menos programado" não existe em lugar
-- nenhum pra somar no fim do mês.
--
-- `vezes_pedidas` nasce igual a `vezes_programadas` seguindo o mesmo
-- DEFAULT 0 — linha nova sempre grava as duas juntas (src/playlist/
-- gerador.js). Linhas antigas (antes desta migration) ficam com
-- `vezes_pedidas = vezes_programadas`: não é possível reconstruir o que
-- foi pedido antes de a coluna existir, e assumir "não teve corte" nesses
-- meses é o lado seguro (nunca inventa um déficit que não dá pra provar).
ALTER TABLE exibicoes_contador ADD COLUMN vezes_pedidas int NOT NULL DEFAULT 0;
UPDATE exibicoes_contador SET vezes_pedidas = vezes_programadas;
