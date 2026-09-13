CREATE TABLE criativos (
  id serial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id),
  arquivo_original_url text NOT NULL,
  arquivo_normalizado_url text,
  thumbnail_url text,
  editado_pelo_operador boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'aprovado', 'reprovado')),
  duracao_segundos int,
  created_at timestamptz NOT NULL DEFAULT now()
);
