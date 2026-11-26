-- Marketplace de Lojas — Etapa 3 (26/11/2026, pedido do dono): lojas,
-- planos e assinaturas da loja (receita própria da Mostraí) e o catálogo
-- inicial da vitrine, com captação de interesse.
--
-- ISOLAMENTO DA MOSTRAÍ CORE. Nada aqui altera `planos`, `assinaturas`,
-- `ciclos_contratados`, `obrigacoes_veiculacao`, `pontos` ou `dispositivos`:
--   - plano de loja NÃO é linha de `planos` (o gerador de playlist trata
--     qualquer plano de `planos` como plano de anunciante e poria a loja na
--     rede própria — auditoria de 26/11/2026, risco R3);
--   - assinatura de loja NÃO é linha de `assinaturas` (o webhook do Checkout
--     criaria ciclo contratado e obrigação de veiculação — R3);
--   - o espaço da vitrine NÃO é linha de `pontos` (ponto sem tela ficaria em
--     "aguardando primeiro sinal" e entraria nas consultas globais — R10).
-- O papel 'loja' em `anunciantes.papeis` é só um rótulo (o papel 'ponto'
-- também é): nenhuma consulta da Core decide nada por ele.
--
-- SEM VENDA AO COMPRADOR. A vitrine capta contato; não há pedido, cobrança
-- nem split de terceiro (bloqueado até a V2 do San Checkout —
-- san_checkout/CONSTRAINTS.md, "Fora da V1"). `taxa_percentual` é só o
-- valor contratado para quando a venda existir; nesta versão nada é cobrado
-- por ele.

-- Linhas de histórico não se alteram nem se apagam.
CREATE OR REPLACE FUNCTION marketplace_linha_imutavel() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'registro de histórico do marketplace não se altera nem se apaga (%)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Planos da loja: o que a Mostraí cobra da loja para ela estar na vitrine.
-- Mensal (prazo curto) e Anual+ (12 meses ou mais). Valores definidos no
-- Admin — nenhum preço vem de migration.
-- ---------------------------------------------------------------------------
CREATE TABLE planos_loja (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{1,39}$'),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 2 AND 60),
  modalidade text NOT NULL CHECK (modalidade IN ('mensal', 'anual')),
  prazo_meses int NOT NULL CHECK (prazo_meses BETWEEN 1 AND 60),
  valor_mensal numeric(10, 2) NOT NULL CHECK (valor_mensal >= 0),
  taxa_percentual numeric(5, 2) NOT NULL DEFAULT 0 CHECK (taxa_percentual BETWEEN 0 AND 30),
  -- Dias depois do último dia pago em que a loja ainda fica na vitrine.
  dias_tolerancia int NOT NULL DEFAULT 5 CHECK (dias_tolerancia BETWEEN 0 AND 30),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (modalidade <> 'anual' OR prazo_meses >= 12)
);

-- ---------------------------------------------------------------------------
-- Lojas. A dona é uma conta (`anunciantes` é a tabela de contas). O endereço
-- público é /loja/<slug> — prefixo fixo, nunca a raiz do site.
-- ---------------------------------------------------------------------------
CREATE TABLE lojas (
  id serial PRIMARY KEY,
  -- Uma loja por conta nesta versão (o painel da loja é o da conta).
  conta_id int NOT NULL UNIQUE REFERENCES anunciantes(id),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$'),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 2 AND 80),
  razao_social text CHECK (char_length(razao_social) <= 120),
  documento text CHECK (documento ~ '^([0-9]{11}|[0-9]{14})$'),
  email text CHECK (char_length(email) BETWEEN 3 AND 200),
  telefone text CHECK (telefone ~ '^[0-9]{10,11}$'),
  cidade text CHECK (char_length(cidade) <= 80),
  uf text CHECK (uf ~ '^[A-Z]{2}$'),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 2000),
  logo_url text CHECK (char_length(logo_url) <= 500),
  cor_primaria text CHECK (cor_primaria ~ '^#[0-9a-fA-F]{6}$'),
  -- rascunho: cadastrada, fora da vitrine · ativa: pode aparecer (se a
  -- assinatura estiver em dia) · suspensa: fora por decisão do Admin ·
  -- encerrada: contrato terminado, fica só para consulta.
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'ativa', 'suspensa', 'encerrada')),
  motivo_status text CHECK (char_length(motivo_status) <= 300),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Assinatura da loja: o contrato por prazo, com o plano copiado na hora
-- (mudar o plano depois não muda contrato assinado). Uma ativa por loja.
--   em dia     = o último dia pago + a tolerância ainda não passou
--   vigente    = hoje entre `inicio` e `fim` (o último dia é inclusivo, no
--                relógio de Matão — a mesma régua de src/lib/vigencia.js)
-- A vitrine só mostra loja ativa com assinatura ativa, vigente e em dia.
-- ---------------------------------------------------------------------------
CREATE TABLE assinaturas_loja (
  id serial PRIMARY KEY,
  loja_id int NOT NULL REFERENCES lojas(id),
  plano_loja_id text NOT NULL REFERENCES planos_loja(id),
  modalidade text NOT NULL CHECK (modalidade IN ('mensal', 'anual')),
  prazo_meses int NOT NULL CHECK (prazo_meses BETWEEN 1 AND 60),
  valor_mensal numeric(10, 2) NOT NULL CHECK (valor_mensal >= 0),
  taxa_percentual numeric(5, 2) NOT NULL CHECK (taxa_percentual BETWEEN 0 AND 30),
  dias_tolerancia int NOT NULL CHECK (dias_tolerancia BETWEEN 0 AND 30),
  inicio date NOT NULL,
  fim date NOT NULL,
  -- Último dia coberto por pagamento registrado; NULL = nada pago ainda.
  pago_ate date,
  -- ativa: o contrato em curso (mesmo vencido, até outro tomar o lugar) ·
  -- encerrada: substituída por uma renovação depois de vencer ·
  -- cancelada: interrompida pelo Admin antes do fim.
  status text NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'encerrada', 'cancelada')),
  cancelada_em timestamptz,
  motivo_cancelamento text CHECK (char_length(motivo_cancelamento) <= 300),
  criado_por text NOT NULL CHECK (char_length(criado_por) <= 200),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (fim >= inicio),
  CHECK (pago_ate IS NULL OR pago_ate <= fim),
  CHECK ((status = 'cancelada') = (cancelada_em IS NOT NULL))
);
CREATE UNIQUE INDEX ux_assinatura_loja_ativa ON assinaturas_loja (loja_id) WHERE status = 'ativa';

-- Pagamentos da assinatura, registrados pelo Admin (a cobrança pelo
-- San Checkout entra numa etapa própria). Cada um estende `pago_ate`.
CREATE TABLE assinaturas_loja_pagamentos (
  id serial PRIMARY KEY,
  assinatura_id int NOT NULL REFERENCES assinaturas_loja(id),
  pago_ate date NOT NULL,
  valor numeric(10, 2) NOT NULL CHECK (valor > 0),
  meio text NOT NULL CHECK (char_length(meio) BETWEEN 1 AND 40),
  referencia text CHECK (char_length(referencia) <= 120),
  registrado_por text NOT NULL CHECK (char_length(registrado_por) <= 200),
  registrado_por_access text CHECK (char_length(registrado_por_access) <= 200),
  registrado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_assinaturas_loja_pagamentos ON assinaturas_loja_pagamentos (assinatura_id);
CREATE TRIGGER assinaturas_loja_pagamentos_imutavel BEFORE UPDATE OR DELETE ON assinaturas_loja_pagamentos
  FOR EACH ROW EXECUTE FUNCTION marketplace_linha_imutavel();

-- ---------------------------------------------------------------------------
-- Catálogo da vitrine: os espaços que a loja oferece (tela, painel, totem,
-- outdoor…). Tabela própria — nunca `pontos`.
-- ---------------------------------------------------------------------------
CREATE TABLE lojas_espacos (
  id serial PRIMARY KEY,
  loja_id int NOT NULL REFERENCES lojas(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$'),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 2 AND 80),
  tipo text NOT NULL CHECK (tipo IN ('tela_indoor', 'painel_led', 'totem', 'outdoor', 'empena', 'outro')),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 2000),
  endereco text CHECK (char_length(endereco) <= 200),
  bairro text CHECK (char_length(bairro) <= 80),
  cidade text NOT NULL CHECK (char_length(cidade) BETWEEN 2 AND 80),
  uf text NOT NULL CHECK (uf ~ '^[A-Z]{2}$'),
  latitude numeric(9, 6) CHECK (latitude BETWEEN -90 AND 90),
  longitude numeric(9, 6) CHECK (longitude BETWEEN -180 AND 180),
  medidas text CHECK (char_length(medidas) <= 80),
  fluxo_estimado_mensal int CHECK (fluxo_estimado_mensal >= 0),
  -- Preço de referência; NULL = "sob consulta". Nenhuma venda nesta versão.
  preco numeric(10, 2) CHECK (preco >= 0),
  periodo_preco text CHECK (periodo_preco IN ('dia', 'semana', 'mes')),
  foto_url text CHECK (char_length(foto_url) <= 500),
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'publicado', 'pausado', 'arquivado')),
  ordem int NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loja_id, slug),
  CHECK ((latitude IS NULL) = (longitude IS NULL)),
  CHECK ((preco IS NULL) = (periodo_preco IS NULL))
);
CREATE INDEX ix_lojas_espacos_vitrine ON lojas_espacos (cidade, tipo) WHERE status = 'publicado';

-- Interesse captado pela vitrine (contato). Dado pessoal de quem escreveu:
-- só a loja dona e o Admin leem (docs/inventario-de-dados.md).
CREATE TABLE lojas_contatos (
  id serial PRIMARY KEY,
  loja_id int NOT NULL REFERENCES lojas(id),
  espaco_id int REFERENCES lojas_espacos(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 2 AND 120),
  email text NOT NULL CHECK (char_length(email) BETWEEN 3 AND 200),
  telefone text CHECK (telefone ~ '^[0-9]{10,11}$'),
  mensagem text NOT NULL CHECK (char_length(mensagem) BETWEEN 1 AND 2000),
  periodo_desejado text CHECK (char_length(periodo_desejado) <= 120),
  lido_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lojas_contatos_loja ON lojas_contatos (loja_id, criado_em DESC);

-- Histórico da loja (status, assinatura, pagamento) — quem fez e quando.
CREATE TABLE lojas_eventos (
  id bigserial PRIMARY KEY,
  loja_id int NOT NULL REFERENCES lojas(id),
  acao text NOT NULL CHECK (char_length(acao) <= 60),
  detalhe jsonb NOT NULL DEFAULT '{}'::jsonb,
  autor text NOT NULL CHECK (char_length(autor) <= 200),
  autor_access text CHECK (char_length(autor_access) <= 200),
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_lojas_eventos ON lojas_eventos (loja_id, id);
CREATE TRIGGER lojas_eventos_imutavel BEFORE UPDATE OR DELETE ON lojas_eventos
  FOR EACH ROW EXECUTE FUNCTION marketplace_linha_imutavel();

-- Toda tabela do `public` nasce com RLS e sem política (migration 031 —
-- fecha a API REST do Supabase; tests/rls.test.js).
ALTER TABLE planos_loja ENABLE ROW LEVEL SECURITY;
ALTER TABLE lojas ENABLE ROW LEVEL SECURITY;
ALTER TABLE assinaturas_loja ENABLE ROW LEVEL SECURITY;
ALTER TABLE assinaturas_loja_pagamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lojas_espacos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lojas_contatos ENABLE ROW LEVEL SECURITY;
ALTER TABLE lojas_eventos ENABLE ROW LEVEL SECURITY;
