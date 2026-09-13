-- Módulo 2 — Anunciantes (SPEC.md). plano_id ainda sem FK: a tabela `planos`
-- só existe a partir do módulo 6 — vira FK de verdade quando ele for criado.
CREATE TABLE anunciantes (
  id serial PRIMARY KEY,
  nome_empresa text NOT NULL,
  cpf_cnpj text NOT NULL,
  endereco text NOT NULL,
  cidade text NOT NULL,
  uf text NOT NULL,
  cep text NOT NULL,
  contato_email text NOT NULL UNIQUE,
  contato_telefone text NOT NULL,
  senha_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pendente_aprovacao'
    CHECK (status IN ('pendente_aprovacao', 'aprovado', 'aguardando_ponto', 'ativo', 'suspenso')),
  plano_id text,
  data_inicio_cobertura date,
  data_expiracao date,
  indicado_por_cupom text, -- código de cupom do afiliado que trouxe esse anunciante (módulo 6), capturado no cadastro via ?ref=
  -- Pessoa física responsável pela empresa — opcional, ponto de contato
  -- humano pra assuntos de anúncio; cpf_cnpj continua sendo o CNPJ da empresa.
  responsavel_nome text,
  responsavel_cpf text,
  responsavel_email text,
  responsavel_telefone text,
  aceitou_termos_em timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
