-- Extrato do ponto: o registro do que foi efetivamente pago a quem cede a
-- parede.
--
-- Por quê: o ponto via o *valor do plano* de comodato ("R$ 120/mês"), mas não
-- existia registro nenhum do que ele recebeu. Quem cede a parede fica sem saber
-- se o mês passado foi pago, e o dono fica sem saber o que já quitou — os dois
-- lados dependendo da memória. É o padrão do setor: portal de quem hospeda a
-- tela mostra o ganho e o pagamento mês a mês.
--
-- ADITIVA. Não altera nem apaga nada.

CREATE TABLE pagamentos_ponto (
  id            serial PRIMARY KEY,
  ponto_id      int NOT NULL REFERENCES pontos(id) ON DELETE CASCADE,
  -- Primeiro dia do mês de competência. Guardar o mês como data evita o
  -- clássico '2026-9' vs '2026-09' e deixa ordenar e filtrar por período.
  competencia   date NOT NULL,
  valor         numeric(10,2) NOT NULL CHECK (valor >= 0),
  -- Em aberto enquanto NULL. É o que separa "devo" de "paguei".
  pago_em       timestamptz,
  forma         text,
  observacao    text,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  -- Um lançamento por ponto por mês: protege contra o duplo clique no admin,
  -- que é como se paga duas vezes o mesmo mês sem ninguém perceber.
  UNIQUE (ponto_id, competencia)
);

CREATE INDEX idx_pagamentos_ponto_ponto ON pagamentos_ponto (ponto_id, competencia DESC);
