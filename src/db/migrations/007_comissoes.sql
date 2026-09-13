CREATE TABLE comissoes (
  id serial PRIMARY KEY,
  afiliado_id int NOT NULL REFERENCES afiliados(id),
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  valor_confirmado numeric NOT NULL,
  comissao_valor numeric NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
