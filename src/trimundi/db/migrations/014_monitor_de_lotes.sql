-- TICK — "Desempenho de vendas — lotes do evento" (§7 do prompt master;
-- decisões do dono de 14/11/2026, itens D e E).
--
-- Configuração das cores e dos alertas do painel, por edição. Nulo = o
-- padrão do código (verde abaixo de 70%, amarelo de 70 a 89, laranja de 90 a
-- 99, vermelho em 100%; alertas em 80, 90, 95 e 100%). Os números do painel
-- não são guardados: saem do estoque real a cada leitura, como a venda.
-- Alertas só no painel (item D) — nada é enviado.
--
-- Reversível: ALTER TABLE edicoes DROP COLUMN monitor_lotes;
ALTER TABLE edicoes ADD COLUMN monitor_lotes jsonb
  CHECK (monitor_lotes IS NULL OR jsonb_typeof(monitor_lotes) = 'object');
