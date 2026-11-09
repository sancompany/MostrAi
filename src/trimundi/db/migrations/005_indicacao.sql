-- Trimundi — indicação (pedido do dono, 09/11/2026): link individual,
-- rastreio de quem indicou, conversões válidas e recompensa. Sem níveis,
-- pontos nem gamificação.
--   · indicador: um código por cliente (sempre) ou por operador (quando o
--     Admin habilita);
--   · campanha: por edição — a recompensa, quantas existem (ex.: 50 copos),
--     quantas indicações valem uma recompensa e o limite por pessoa;
--   · conversão: o pedido PAGO de quem chegou pelo link (uma por pessoa
--     indicada e campanha); sai se o pedido for reembolsado ou contestado;
--   · recompensa: concedida ao bater o critério, enquanto houver; entregue
--     uma vez só.

CREATE TABLE indicadores (
  id bigserial PRIMARY KEY,
  cliente_id bigint UNIQUE REFERENCES clientes(id),
  operador_id bigint UNIQUE REFERENCES operadores(id),
  codigo text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Z2-9]{8}$'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((cliente_id IS NULL) <> (operador_id IS NULL))
);

ALTER TABLE operadores ADD COLUMN indicacao_habilitada boolean NOT NULL DEFAULT false;
ALTER TABLE pedidos ADD COLUMN indicador_id bigint REFERENCES indicadores(id);

CREATE TABLE campanhas_indicacao (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 80),
  recompensa text NOT NULL CHECK (char_length(recompensa) BETWEEN 1 AND 80),
  quantidade integer NOT NULL CHECK (quantidade BETWEEN 1 AND 100000),
  indicacoes_por_recompensa integer NOT NULL DEFAULT 1 CHECK (indicacoes_por_recompensa BETWEEN 1 AND 100),
  limite_por_indicador integer CHECK (limite_por_indicador BETWEEN 1 AND 1000),
  inicio timestamptz,
  fim timestamptz,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (fim IS NULL OR inicio IS NULL OR fim > inicio)
);
-- Uma campanha ativa por edição: a conversão sabe sempre para onde vai.
CREATE UNIQUE INDEX ux_campanha_ativa ON campanhas_indicacao (edicao_id) WHERE ativo;

CREATE TABLE indicacoes (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas_indicacao(id),
  indicador_id bigint NOT NULL REFERENCES indicadores(id),
  pedido_id uuid NOT NULL UNIQUE REFERENCES pedidos(id),
  cliente_id bigint NOT NULL REFERENCES clientes(id),
  valida boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
-- Uma pessoa indicada conta uma vez por campanha (vários pedidos não somam).
CREATE UNIQUE INDEX ux_indicacao_pessoa ON indicacoes (campanha_id, cliente_id) WHERE valida;
CREATE INDEX ix_indicacoes_indicador ON indicacoes (campanha_id, indicador_id) WHERE valida;

CREATE TABLE recompensas_indicacao (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas_indicacao(id),
  indicador_id bigint NOT NULL REFERENCES indicadores(id),
  status text NOT NULL DEFAULT 'concedida' CHECK (status IN ('concedida', 'entregue', 'revogada')),
  concedida_em timestamptz NOT NULL DEFAULT now(),
  entregue_em timestamptz,
  entregue_por text CHECK (char_length(entregue_por) <= 200),
  revogada_em timestamptz,
  CHECK ((status = 'entregue') = (entregue_em IS NOT NULL))
);
CREATE INDEX ix_recompensas ON recompensas_indicacao (campanha_id, indicador_id, status);

ALTER TABLE indicadores ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanhas_indicacao ENABLE ROW LEVEL SECURITY;
ALTER TABLE indicacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE recompensas_indicacao ENABLE ROW LEVEL SECURITY;
