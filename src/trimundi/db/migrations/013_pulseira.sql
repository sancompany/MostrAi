-- TICK — pulseira por tipo de ingresso (decisão do dono, 14/11/2026, item G).
--
-- Campo opcional no tipo de ingresso: a cor ou o código da pulseira que a
-- portaria entrega a quem entra com aquele tipo (ex.: "Azul", "VIP-02"). A
-- portaria mostra na leitura do ingresso. Nulo = sem pulseira definida — o
-- que vale para todos os tipos que já existem; nada existente muda.
--
-- Reversível: ALTER TABLE categorias DROP COLUMN pulseira;
ALTER TABLE categorias ADD COLUMN pulseira text
  CHECK (pulseira IS NULL OR char_length(pulseira) BETWEEN 1 AND 40);
