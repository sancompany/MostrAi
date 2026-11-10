-- Trimundi — conta do cliente (pedido do dono, 09/11/2026): nome, CPF,
-- e-mail e senha; o e-mail precisa ser confirmado antes da primeira compra.
-- Nada de endereço, telefone ou data de nascimento.

CREATE TABLE clientes (
  id bigserial PRIMARY KEY,
  nome text CHECK (char_length(nome) BETWEEN 2 AND 120),
  cpf text CHECK (cpf ~ '^[0-9]{11}$'),
  email text CHECK (char_length(email) BETWEEN 3 AND 200),
  senha_hash text,
  email_confirmado_em timestamptz,
  -- Sobe ao trocar a senha: a sessão aberta antes cai na requisição seguinte.
  sessao_versao integer NOT NULL DEFAULT 1,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  ultimo_acesso_em timestamptz,
  anonimizado_em timestamptz,
  CHECK (anonimizado_em IS NOT NULL OR (nome IS NOT NULL AND cpf IS NOT NULL AND email IS NOT NULL AND senha_hash IS NOT NULL))
);
CREATE UNIQUE INDEX ux_clientes_email ON clientes (email) WHERE anonimizado_em IS NULL;
CREATE UNIQUE INDEX ux_clientes_cpf ON clientes (cpf) WHERE anonimizado_em IS NULL;

-- Links de uso único (confirmar e-mail, redefinir senha): só o hash fica.
CREATE TABLE cliente_tokens (
  id bigserial PRIMARY KEY,
  cliente_id bigint NOT NULL REFERENCES clientes(id),
  tipo text NOT NULL CHECK (tipo IN ('confirmar_email', 'redefinir_senha')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expira_em timestamptz NOT NULL,
  usado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_cliente_tokens ON cliente_tokens (cliente_id, tipo);

-- O pedido de venda nasce da conta (o pedido de teste do Admin, não).
ALTER TABLE pedidos ADD COLUMN cliente_id bigint REFERENCES clientes(id);
CREATE INDEX ix_pedidos_cliente ON pedidos (cliente_id);

ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliente_tokens ENABLE ROW LEVEL SECURITY;
