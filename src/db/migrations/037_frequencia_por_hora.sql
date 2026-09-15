-- Frequência do plano deixa de ser "vezes por dia" (convertida pelo horário
-- de cada ponto) e vira "vezes por hora", direta e livre — pedido do dono,
-- 15/09/2026, na rodada de depuração da página de Planos: "eu escolho a
-- quantidade de vezes que quiser que apareça por plano, aqui é N vezes por
-- hora, a quantia que eu querer mesmo".
--
-- Os valores atuais (36/72/144 por dia) já eram múltiplos exatos de 12 —
-- HORAS_ABERTO_PADRAO, o mesmo divisor que o gerador de playlist usava pra
-- converter por dia em por hora quando o ponto não declarava horário. Migrar
-- dividindo por 12 preserva o comportamento de hoje; o dono ajusta cada
-- plano livremente depois, pelo admin.
ALTER TABLE planos RENAME COLUMN frequencia_dia TO frequencia_hora;
UPDATE planos SET frequencia_hora = GREATEST(1, ROUND(frequencia_hora / 12.0));

ALTER TABLE anunciantes RENAME COLUMN frequencia_dia_propria TO frequencia_hora_propria;
UPDATE anunciantes SET frequencia_hora_propria = GREATEST(1, ROUND(frequencia_hora_propria / 12.0))
  WHERE frequencia_hora_propria IS NOT NULL;
