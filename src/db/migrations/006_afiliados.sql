CREATE TABLE afiliados (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  cpf text NOT NULL,
  chave_pix text NOT NULL,
  telefone text NOT NULL,
  email text NOT NULL UNIQUE,
  senha_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pendente_aprovacao' CHECK (status IN ('pendente_aprovacao', 'aprovado', 'inativo')),
  codigo_cupom text NOT NULL UNIQUE,
  comissao_percentual numeric NOT NULL DEFAULT 12,
  aceitou_termos_em timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
