CREATE TABLE cobrancas_confirmadas (
  id serial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  plano_id text NOT NULL REFERENCES planos(id),
  valor numeric NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  nota_fiscal_status text NOT NULL DEFAULT 'pendente' CHECK (nota_fiscal_status IN ('pendente', 'emitida')),
  nota_fiscal_url text,
  drive_file_id text,
  email_confirmacao_enviado_em timestamptz
);
