-- Uma linha por assinatura de um anunciante específico — o `id` (opaco) é o
-- que vai no link de checkout (?assinatura=id), então quando o San Checkout
-- chama GET /plano/:id de volta a gente já sabe exatamente quem é o
-- anunciante (sem depender de bater CPF digitado na tela). A Asaas cobra o
-- valor cheio do compromisso a cada ciclo (QUARTERLY/SEMIANNUALLY/YEARLY,
-- ver san-checkout.js) automaticamente, sem precisar consultar de novo —
-- não há contador de ciclo pra manter aqui.
CREATE TABLE assinaturas (
  id text PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  plano_id text NOT NULL REFERENCES planos(id),
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'cancelada')),
  created_at timestamptz NOT NULL DEFAULT now()
);
