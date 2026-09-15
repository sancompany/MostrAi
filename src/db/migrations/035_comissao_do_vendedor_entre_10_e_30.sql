-- Quem define o percentual de comissão é o dono, mas dentro de uma faixa —
-- decisão de produto de 15/09/2026: entre 10% e 30%. Comissão é por
-- VENDEDOR (não por plano), então troca de plano do indicado nunca muda o
-- percentual dele; esta trava só limita o valor que o dono pode digitar.
ALTER TABLE vendedores ADD CONSTRAINT vendedores_comissao_percentual_faixa
  CHECK (comissao_percentual >= 10 AND comissao_percentual <= 30);
