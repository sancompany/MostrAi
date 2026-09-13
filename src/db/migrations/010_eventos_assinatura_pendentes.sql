-- Fila de reconciliação manual: eventos de assinatura do San Checkout que
-- não deram pra correlacionar automaticamente com um anunciante (CPF do
-- pagador não bateu com nenhum cpf_cnpj cadastrado), ou eventos que ainda
-- não têm ação automática definida (falha/estorno/cancelamento — ver
-- src/financeiro/san-checkout.js). Nada é perdido, tudo cai aqui pro admin
-- olhar depois.
CREATE TABLE eventos_assinatura_pendentes (
  id serial PRIMARY KEY,
  payload jsonb NOT NULL,
  motivo text NOT NULL,
  resolvido boolean NOT NULL DEFAULT false,
  criado_em timestamptz NOT NULL DEFAULT now()
);
