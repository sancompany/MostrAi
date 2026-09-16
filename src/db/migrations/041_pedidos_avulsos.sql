-- Pedido avulso do San Checkout (API.md seção 4.1/4.3.3): pagamento único,
-- sem vínculo de assinatura, usado hoje só pra cobrar a diferença de uma
-- troca de plano (pedido do dono, 16/09/2026) — preço cheio do plano novo
-- menos o crédito dos dias que restam no plano atual. Nunca sai negativo:
-- a rota que cria o pedido recusa a troca quando o crédito já cobriria o
-- plano novo (src/financeiro/routes.js, POST /anunciantes/me/trocar-plano).
--
-- Id em hex, gerado em app (mesmo padrão de tokens_senha), não sequencial —
-- é o que o contrato do Checkout exige pra rota pública de pedido.
CREATE TABLE pedidos_avulsos (
  id text PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  tipo text NOT NULL,
  plano_atual_id text REFERENCES planos(id),
  plano_novo_id text NOT NULL REFERENCES planos(id),
  valor numeric(10,2) NOT NULL CHECK (valor > 0),
  descricao text NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'pago', 'cancelado')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  pago_em timestamptz
);
