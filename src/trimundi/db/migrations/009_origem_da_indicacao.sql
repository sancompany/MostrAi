-- TICK — origem da indicação (pedido do dono, 10/11/2026). Separa, no
-- servidor, os cinco conceitos:
--   · link permanente ............ indicadores (já existia: um código por
--                                  conta de comprador ou de operador);
--   · registro da indicação ...... indicacao_origens (esta tabela): quem
--                                  trouxe esta conta para esta edição. O
--                                  primeiro link vale; outro link depois não
--                                  troca a origem, nem de pedido novo;
--   · conversão confirmada ....... o pedido pago com ingresso de pé que leva
--                                  pedidos.indicador_id (já existia; um
--                                  indicador por pedido);
--   · promoção ................... campanhas_indicacao (já existia);
--   · benefício concedido ........ recompensas_indicacao (já existia).

CREATE TABLE indicacao_origens (
  cliente_id bigint NOT NULL REFERENCES clientes(id),
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  indicador_id bigint NOT NULL REFERENCES indicadores(id),
  registrada_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cliente_id, edicao_id)
);
CREATE INDEX ix_indicacao_origens_indicador ON indicacao_origens (indicador_id, edicao_id);
ALTER TABLE indicacao_origens ENABLE ROW LEVEL SECURITY;

-- Desempenho de quem indicou: pedidos por indicador e edição.
CREATE INDEX ix_pedidos_indicador ON pedidos (indicador_id, edicao_id) WHERE indicador_id IS NOT NULL;
