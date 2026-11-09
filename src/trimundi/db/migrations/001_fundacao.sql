-- Trimundi — fundação. Banco PRÓPRIO da Trimundi, nunca o da Mostraí.
-- Contrato: docs/trimundi/modelo-de-dados.md. Dinheiro em centavos (bigint),
-- tempo em timestamptz, identificador que sai do sistema sempre aleatório.
-- Toda tabela nasce com RLS ligado e sem política (a API pública do Supabase
-- não lê nada); o acesso é só pelo servidor.

CREATE OR REPLACE FUNCTION trimundi_historico_imutavel() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION '% é histórico e não muda', TG_TABLE_NAME USING ERRCODE = 'check_violation';
END $$;

-- ---------------------------------------------------------------- catálogo
CREATE TABLE eventos (
  id bigserial PRIMARY KEY,
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 120),
  slug text NOT NULL CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{2,59}$'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_eventos_slug ON eventos (lower(slug));

CREATE TABLE edicoes (
  id bigserial PRIMARY KEY,
  evento_id bigint NOT NULL REFERENCES eventos(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 120),
  slug text NOT NULL CHECK (slug ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,39}$'),
  codigo_publico text NOT NULL UNIQUE CHECK (codigo_publico ~ '^[A-Za-z0-9_-]{10,40}$'),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 5000),
  -- Nulo = "A definir".
  inicio_em timestamptz,
  fim_em timestamptz,
  local_nome text CHECK (char_length(local_nome) BETWEEN 1 AND 120),
  cep text CHECK (cep ~ '^[0-9]{8}$'),
  logradouro text CHECK (char_length(logradouro) <= 160),
  numero text CHECK (char_length(numero) <= 20),
  complemento text CHECK (char_length(complemento) <= 80),
  bairro text CHECK (char_length(bairro) <= 80),
  cidade text CHECK (char_length(cidade) <= 80),
  uf text CHECK (uf ~ '^[A-Z]{2}$'),
  classificacao_etaria text CHECK (classificacao_etaria IN ('livre', '10', '12', '14', '16', '18')),
  capacidade integer CHECK (capacidade BETWEEN 1 AND 1000000),
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'publicado', 'pausado', 'encerrado')),
  publicado_em timestamptz,
  encerrado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (fim_em IS NULL OR inicio_em IS NULL OR fim_em > inicio_em)
);
CREATE UNIQUE INDEX ux_edicoes_slug ON edicoes (evento_id, lower(slug));

CREATE TABLE edicao_imagens (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  tipo text NOT NULL CHECK (tipo IN ('banner', 'galeria')),
  caminho text NOT NULL CHECK (char_length(caminho) <= 300),
  url text NOT NULL CHECK (char_length(url) <= 600),
  ordem integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_edicao_imagens_banner ON edicao_imagens (edicao_id) WHERE tipo = 'banner';

-- Textos versionados da edição. Versão gravada não muda nem se apaga; só a
-- marca de vigente anda (RN-T05).
CREATE TABLE termos (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  tipo text NOT NULL CHECK (tipo IN ('regras_entrada', 'condicoes_especiais', 'termos_compra')),
  versao integer NOT NULL CHECK (versao >= 1),
  texto text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 50000),
  hash_sha256 text NOT NULL CHECK (hash_sha256 ~ '^[0-9a-f]{64}$'),
  vigente boolean NOT NULL DEFAULT true,
  publicado_em timestamptz NOT NULL DEFAULT now(),
  publicado_por text NOT NULL CHECK (char_length(publicado_por) <= 200),
  UNIQUE (edicao_id, tipo, versao)
);
CREATE UNIQUE INDEX ux_termos_vigente ON termos (edicao_id, tipo) WHERE vigente;

CREATE OR REPLACE FUNCTION trimundi_termo_imutavel() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'versão de termo não se apaga' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.edicao_id <> OLD.edicao_id OR NEW.tipo <> OLD.tipo OR NEW.versao <> OLD.versao
     OR NEW.texto <> OLD.texto OR NEW.hash_sha256 <> OLD.hash_sha256
     OR NEW.publicado_em <> OLD.publicado_em OR NEW.publicado_por <> OLD.publicado_por THEN
    RAISE EXCEPTION 'versão de termo já gravada não muda — grave outra' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER termos_imutavel BEFORE UPDATE OR DELETE ON termos
  FOR EACH ROW EXECUTE FUNCTION trimundi_termo_imutavel();

CREATE TABLE beneficios (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 60),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 300),
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_beneficios_edicao ON beneficios (edicao_id);

-- Tipo de ingresso.
CREATE TABLE categorias (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 60),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 500),
  limite_por_comprador integer CHECK (limite_por_comprador BETWEEN 1 AND 20),
  ativo boolean NOT NULL DEFAULT true,
  ordem integer NOT NULL DEFAULT 0,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ux_categorias_nome ON categorias (edicao_id, lower(nome));

CREATE TABLE categoria_beneficios (
  categoria_id bigint NOT NULL REFERENCES categorias(id),
  beneficio_id bigint NOT NULL REFERENCES beneficios(id),
  PRIMARY KEY (categoria_id, beneficio_id)
);

CREATE TABLE lotes (
  id bigserial PRIMARY KEY,
  categoria_id bigint NOT NULL REFERENCES categorias(id),
  ordem integer NOT NULL CHECK (ordem BETWEEN 1 AND 1000),
  preco_centavos bigint NOT NULL CHECK (preco_centavos BETWEEN 500 AND 5000000),
  quantidade integer NOT NULL CHECK (quantidade BETWEEN 1 AND 100000),
  inicio_vendas timestamptz,
  fim_vendas timestamptz,
  encerrado_em timestamptz,
  motivo_encerramento text CHECK (motivo_encerramento IN ('esgotado', 'manual')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (categoria_id, ordem),
  CHECK (fim_vendas IS NULL OR inicio_vendas IS NULL OR fim_vendas > inicio_vendas),
  CHECK ((encerrado_em IS NULL) = (motivo_encerramento IS NULL))
);

-- Promoção (combo): a oferta comercial. Cada posição vira um ingresso
-- individual (regra dura 4).
CREATE TABLE promocoes (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 60),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 500),
  preco_total_centavos bigint NOT NULL CHECK (preco_total_centavos BETWEEN 500 AND 5000000),
  quantidade integer NOT NULL CHECK (quantidade BETWEEN 1 AND 10000),
  inicio timestamptz,
  fim timestamptz,
  ativo boolean NOT NULL DEFAULT true,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (fim IS NULL OR inicio IS NULL OR fim > inicio)
);
CREATE UNIQUE INDEX ux_promocoes_nome ON promocoes (edicao_id, lower(nome));

CREATE TABLE promocao_itens (
  id bigserial PRIMARY KEY,
  promocao_id bigint NOT NULL REFERENCES promocoes(id),
  categoria_id bigint NOT NULL REFERENCES categorias(id),
  quantidade integer NOT NULL CHECK (quantidade BETWEEN 1 AND 20),
  beneficio_id bigint REFERENCES beneficios(id),
  ordem integer NOT NULL
);
CREATE INDEX ix_promocao_itens ON promocao_itens (promocao_id, ordem);

-- ------------------------------------------------------------------ venda
-- Dado pessoal: as colunas aceitam nulo SÓ depois da anonimização.
CREATE TABLE compradores (
  id bigserial PRIMARY KEY,
  nome text CHECK (char_length(nome) BETWEEN 2 AND 120),
  cpf text CHECK (cpf ~ '^[0-9]{11}$'),
  email text CHECK (char_length(email) BETWEEN 3 AND 200),
  telefone text CHECK (telefone ~ '^[0-9]{10,11}$'),
  criado_em timestamptz NOT NULL DEFAULT now(),
  anonimizado_em timestamptz,
  CHECK (anonimizado_em IS NOT NULL OR (nome IS NOT NULL AND cpf IS NOT NULL AND email IS NOT NULL))
);
CREATE INDEX ix_compradores_cpf ON compradores (cpf);

CREATE TABLE pedidos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  comprador_id bigint NOT NULL REFERENCES compradores(id),
  origem text NOT NULL DEFAULT 'venda' CHECK (origem IN ('venda', 'teste')),
  status text NOT NULL DEFAULT 'aguardando_pagamento'
    CHECK (status IN ('aguardando_pagamento', 'pago', 'cancelado', 'expirado', 'estornado', 'pago_sem_vaga')),
  total_centavos bigint NOT NULL CHECK (total_centavos BETWEEN 500 AND 100000000),
  -- Prazo da reserva E do pagamento: vai como `expiraEm` para o Checkout
  -- (API.md §4.1.2), que recusa cobrar depois dele.
  reserva_expira_em timestamptz NOT NULL,
  chave_idempotencia text NOT NULL UNIQUE CHECK (chave_idempotencia ~ '^[A-Za-z0-9_-]{8,80}$'),
  charge_id text CHECK (char_length(charge_id) <= 128),
  metodo_pagamento text CHECK (char_length(metodo_pagamento) <= 40),
  valor_cobrado_centavos bigint,
  -- Última tentativa recusada (cartão negado, antifraude): o pedido segue
  -- aguardando até a reserva vencer — dá para tentar outro meio (API.md §4.3.3).
  pagamento_recusado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  pago_em timestamptz,
  encerrado_em timestamptz
);
CREATE INDEX ix_pedidos_edicao_status ON pedidos (edicao_id, status);
CREATE INDEX ix_pedidos_comprador ON pedidos (comprador_id);
CREATE INDEX ix_pedidos_pendentes ON pedidos (reserva_expira_em) WHERE status = 'aguardando_pagamento';

-- Acesso do comprador à página do pedido: token aleatório, só o hash no banco.
CREATE TABLE pedido_acessos (
  id bigserial PRIMARY KEY,
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  origem text NOT NULL CHECK (origem IN ('compra', 'email', 'suporte')),
  criado_em timestamptz NOT NULL DEFAULT now(),
  revogado_em timestamptz
);
CREATE INDEX ix_pedido_acessos ON pedido_acessos (pedido_id);

CREATE TABLE pedido_itens (
  id bigserial PRIMARY KEY,
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  lote_id bigint REFERENCES lotes(id),
  promocao_id bigint REFERENCES promocoes(id),
  descricao text NOT NULL CHECK (char_length(descricao) BETWEEN 1 AND 160),
  quantidade integer NOT NULL CHECK (quantidade BETWEEN 1 AND 20),
  preco_unitario_centavos bigint NOT NULL CHECK (preco_unitario_centavos >= 0),
  total_centavos bigint NOT NULL,
  ordem integer NOT NULL,
  CHECK ((lote_id IS NULL) <> (promocao_id IS NULL)),
  CHECK (total_centavos = quantidade * preco_unitario_centavos)
);
CREATE INDEX ix_pedido_itens_pedido ON pedido_itens (pedido_id, ordem);
CREATE INDEX ix_pedido_itens_promocao ON pedido_itens (promocao_id) WHERE promocao_id IS NOT NULL;

-- Titular de UM ingresso (pode não ser o comprador).
CREATE TABLE participantes (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  nome text CHECK (char_length(nome) BETWEEN 2 AND 120),
  cpf text CHECK (cpf ~ '^[0-9]{11}$'),
  email text CHECK (char_length(email) BETWEEN 3 AND 200),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  anonimizado_em timestamptz,
  CHECK (anonimizado_em IS NOT NULL OR (nome IS NOT NULL AND cpf IS NOT NULL AND email IS NOT NULL))
);
CREATE INDEX ix_participantes_cpf ON participantes (edicao_id, cpf);

-- Uma vaga por ingresso a emitir: qual tipo, de que lote o estoque saiu, de
-- que posição de combo veio e quem é o titular. O estoque do lote é contado
-- por aqui (docs/trimundi/modelo-de-dados.md, "Disponibilidade").
CREATE TABLE reservas (
  id bigserial PRIMARY KEY,
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  pedido_item_id bigint NOT NULL REFERENCES pedido_itens(id),
  posicao integer NOT NULL CHECK (posicao >= 1),
  categoria_id bigint NOT NULL REFERENCES categorias(id),
  lote_id bigint NOT NULL REFERENCES lotes(id),
  promocao_item_id bigint REFERENCES promocao_itens(id),
  participante_id bigint NOT NULL UNIQUE REFERENCES participantes(id),
  valor_centavos bigint NOT NULL CHECK (valor_centavos >= 0),
  UNIQUE (pedido_item_id, posicao)
);
CREATE INDEX ix_reservas_lote ON reservas (lote_id);
CREATE INDEX ix_reservas_pedido ON reservas (pedido_id);

-- Aceite dos textos da edição, com a versão e a evidência (regra dura 10).
CREATE TABLE aceites (
  id bigserial PRIMARY KEY,
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  termo_id bigint NOT NULL REFERENCES termos(id),
  hash_sha256 text NOT NULL CHECK (hash_sha256 ~ '^[0-9a-f]{64}$'),
  ip text CHECK (char_length(ip) <= 64),
  user_agent text CHECK (char_length(user_agent) <= 300),
  aceito_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pedido_id, termo_id)
);
CREATE TRIGGER aceites_imutavel BEFORE UPDATE OR DELETE ON aceites
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Avisos de pagamento: inbox do webhook e registro de cada fato, com
-- deduplicação pelo eventoId do Checkout (API.md §4.3.6).
CREATE TABLE pagamento_eventos (
  id bigserial PRIMARY KEY,
  evento_id text NOT NULL UNIQUE CHECK (char_length(evento_id) BETWEEN 1 AND 160),
  provedor text NOT NULL CHECK (provedor IN ('san_checkout', 'simulado', 'conciliacao', 'teste')),
  pedido_ref text CHECK (char_length(pedido_ref) <= 128),
  pedido_id uuid REFERENCES pedidos(id),
  charge_id text CHECK (char_length(charge_id) <= 128),
  status text NOT NULL CHECK (char_length(status) <= 60),
  payload jsonb NOT NULL,
  ocorrido_em timestamptz,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  processamento text NOT NULL DEFAULT 'recebido'
    CHECK (processamento IN ('recebido', 'processando', 'processado', 'tentando_de_novo', 'morto')),
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  ultimo_erro text CHECK (char_length(ultimo_erro) <= 500),
  resultado text CHECK (char_length(resultado) <= 60),
  processado_em timestamptz
);
CREATE INDEX ix_pagamento_eventos_fila ON pagamento_eventos (proxima_tentativa_em)
  WHERE processamento IN ('recebido', 'tentando_de_novo', 'processando');
CREATE INDEX ix_pagamento_eventos_pedido ON pagamento_eventos (pedido_id);

-- ---------------------------------------------------------------- emissão
CREATE TABLE cortesias (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  classificacao text NOT NULL CHECK (classificacao IN ('convidado', 'equipe', 'patrocinador', 'promocional')),
  emitida_por text NOT NULL CHECK (char_length(emitida_por) <= 200),
  emitida_por_access text CHECK (char_length(emitida_por_access) <= 200),
  chave_idempotencia text NOT NULL UNIQUE CHECK (chave_idempotencia ~ '^[A-Za-z0-9_-]{8,80}$'),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ingressos (
  id bigserial PRIMARY KEY,
  codigo text NOT NULL UNIQUE CHECK (codigo ~ '^[A-Za-z0-9_-]{22}$'),
  codigo_curto text NOT NULL CHECK (codigo_curto ~ '^[A-Z2-9]{4}-[A-Z2-9]{4}$'),
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  categoria_id bigint NOT NULL REFERENCES categorias(id),
  lote_id bigint REFERENCES lotes(id),
  promocao_id bigint REFERENCES promocoes(id),
  pedido_id uuid REFERENCES pedidos(id),
  reserva_id bigint UNIQUE REFERENCES reservas(id),
  cortesia_id bigint UNIQUE REFERENCES cortesias(id),
  participante_id bigint NOT NULL UNIQUE REFERENCES participantes(id),
  origem text NOT NULL CHECK (origem IN ('pago', 'cortesia')),
  valor_centavos bigint NOT NULL CHECK (valor_centavos >= 0),
  status text NOT NULL DEFAULT 'valido' CHECK (status IN ('valido', 'bloqueado', 'cancelado')),
  motivo_status text CHECK (char_length(motivo_status) <= 300),
  emitido_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((origem = 'cortesia') = (cortesia_id IS NOT NULL)),
  CHECK (origem <> 'cortesia' OR (valor_centavos = 0 AND pedido_id IS NULL AND reserva_id IS NULL)),
  CHECK (origem <> 'pago' OR (pedido_id IS NOT NULL AND reserva_id IS NOT NULL))
);
CREATE UNIQUE INDEX ux_ingressos_codigo_curto ON ingressos (edicao_id, codigo_curto);
CREATE INDEX ix_ingressos_edicao ON ingressos (edicao_id, emitido_em DESC);
CREATE INDEX ix_ingressos_pedido ON ingressos (pedido_id);

CREATE TABLE ingresso_beneficios (
  ingresso_id bigint NOT NULL REFERENCES ingressos(id),
  beneficio_id bigint NOT NULL REFERENCES beneficios(id),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 60),
  origem text NOT NULL CHECK (origem IN ('categoria', 'promocao', 'cortesia')),
  resgatado_em timestamptz,
  PRIMARY KEY (ingresso_id, beneficio_id)
);

-- Alterações relevantes de cada ingresso (cancelamento, reembolso,
-- chargeback, check-in...). Só se acrescenta.
CREATE TABLE ingresso_historico (
  id bigserial PRIMARY KEY,
  ingresso_id bigint NOT NULL REFERENCES ingressos(id),
  tipo text NOT NULL CHECK (tipo IN ('emitido', 'cancelado', 'bloqueado', 'desbloqueado', 'reembolso_solicitado',
    'reembolsado', 'chargeback', 'checkin', 'participante_alterado')),
  motivo text CHECK (char_length(motivo) <= 300),
  autor text CHECK (char_length(autor) <= 200),
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_ingresso_historico ON ingresso_historico (ingresso_id, ocorrido_em);
CREATE TRIGGER ingresso_historico_imutavel BEFORE UPDATE OR DELETE ON ingresso_historico
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Reembolso pedido pelo Admin ao Checkout: pedido inteiro (ingresso_id nulo)
-- ou um ingresso; a chave é nossa e única por reembolso (API.md §5.4).
CREATE TABLE reembolsos (
  id bigserial PRIMARY KEY,
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  ingresso_id bigint REFERENCES ingressos(id),
  valor_centavos bigint NOT NULL CHECK (valor_centavos > 0),
  chave_idempotencia text NOT NULL UNIQUE CHECK (chave_idempotencia ~ '^[A-Za-z0-9_-]{8,128}$'),
  motivo text NOT NULL CHECK (char_length(motivo) BETWEEN 1 AND 300),
  status text NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado', 'confirmado', 'negado', 'falhou')),
  solicitado_por text NOT NULL CHECK (char_length(solicitado_por) <= 200),
  solicitado_por_access text CHECK (char_length(solicitado_por_access) <= 200),
  ultimo_erro text CHECK (char_length(ultimo_erro) <= 500),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  confirmado_em timestamptz
);
CREATE INDEX ix_reembolsos_pedido ON reembolsos (pedido_id);

-- ----------------------------------------------------------------- acesso
CREATE TABLE operadores (
  id bigserial PRIMARY KEY,
  nome text CHECK (char_length(nome) BETWEEN 2 AND 120),
  email text CHECK (char_length(email) BETWEEN 3 AND 200),
  email_normalizado text UNIQUE,
  senha_hash text,
  status text NOT NULL DEFAULT 'aguardando_ativacao' CHECK (status IN ('aguardando_ativacao', 'ativo', 'desativado')),
  codigo_hash text CHECK (codigo_hash ~ '^[0-9a-f]{64}$'),
  codigo_expira_em timestamptz,
  codigo_tentativas integer NOT NULL DEFAULT 0,
  -- Sobe a cada desativação ou código novo: a sessão aberta com a versão
  -- antiga deixa de valer na requisição seguinte (RN-T28).
  sessao_versao integer NOT NULL DEFAULT 1,
  criado_em timestamptz NOT NULL DEFAULT now(),
  ativado_em timestamptz,
  desativado_em timestamptz,
  ultimo_acesso_em timestamptz,
  anonimizado_em timestamptz,
  CHECK (anonimizado_em IS NOT NULL OR (nome IS NOT NULL AND email IS NOT NULL AND email_normalizado IS NOT NULL))
);

CREATE TABLE operador_permissoes (
  id bigserial PRIMARY KEY,
  operador_id bigint NOT NULL REFERENCES operadores(id),
  permissao text NOT NULL CHECK (permissao = 'checkin'),
  edicao_id bigint REFERENCES edicoes(id),
  concedida_em timestamptz NOT NULL DEFAULT now(),
  concedida_por text NOT NULL CHECK (char_length(concedida_por) <= 200)
);
CREATE UNIQUE INDEX ux_operador_permissoes ON operador_permissoes (operador_id, permissao, COALESCE(edicao_id, 0));

CREATE TABLE checkins (
  id bigserial PRIMARY KEY,
  ingresso_id bigint NOT NULL REFERENCES ingressos(id),
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  operador_id bigint NOT NULL REFERENCES operadores(id),
  escopo text NOT NULL DEFAULT 'entrada' CHECK (escopo IN ('entrada', 'beneficio')),
  beneficio_id bigint REFERENCES beneficios(id),
  resultado text NOT NULL CHECK (resultado IN ('aceito', 'recusado')),
  motivo text CHECK (char_length(motivo) <= 120),
  registrado_em timestamptz NOT NULL DEFAULT now(),
  lido_no_aparelho_em timestamptz,
  aparelho text CHECK (char_length(aparelho) <= 120)
);
-- Uma entrada aceita por ingresso: dois operadores no mesmo instante, um passa.
CREATE UNIQUE INDEX ux_checkins_entrada ON checkins (ingresso_id) WHERE escopo = 'entrada' AND resultado = 'aceito';
CREATE INDEX ix_checkins_edicao ON checkins (edicao_id, registrado_em DESC);
CREATE TRIGGER checkins_imutavel BEFORE UPDATE OR DELETE ON checkins
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- ------------------------------------------------------------- governança
CREATE TABLE auditoria (
  id bigserial PRIMARY KEY,
  ocorrido_em timestamptz NOT NULL DEFAULT now(),
  autor text NOT NULL CHECK (char_length(autor) <= 200),
  autor_access text CHECK (char_length(autor_access) <= 200),
  acao text NOT NULL CHECK (char_length(acao) <= 80),
  entidade text NOT NULL CHECK (char_length(entidade) <= 40),
  entidade_id text CHECK (char_length(entidade_id) <= 80),
  detalhe jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX ix_auditoria_entidade ON auditoria (entidade, entidade_id, ocorrido_em DESC);
CREATE TRIGGER auditoria_imutavel BEFORE UPDATE OR DELETE ON auditoria
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Eventos de medição (D1), sem dado pessoal.
CREATE TABLE metricas (
  id bigserial PRIMARY KEY,
  nome text NOT NULL CHECK (nome ~ '^[a-z]+:[a-z_]+$'),
  edicao_id bigint REFERENCES edicoes(id),
  propriedades jsonb NOT NULL DEFAULT '{}'::jsonb,
  ocorrido_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_metricas ON metricas (nome, ocorrido_em DESC);
CREATE TRIGGER metricas_imutavel BEFORE UPDATE OR DELETE ON metricas
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Fila de e-mail da Trimundi. Sem provedor configurado a mensagem fica
-- 'aguardando_provedor' — guardada, nunca dada como enviada.
CREATE TABLE emails (
  id bigserial PRIMARY KEY,
  chave text NOT NULL UNIQUE CHECK (char_length(chave) <= 160),
  tipo text NOT NULL CHECK (char_length(tipo) <= 60),
  para text NOT NULL CHECK (char_length(para) BETWEEN 3 AND 200),
  assunto text NOT NULL CHECK (char_length(assunto) <= 200),
  texto text NOT NULL CHECK (char_length(texto) <= 20000),
  status text NOT NULL CHECK (status IN ('aguardando_provedor', 'na_fila', 'enviado', 'falhou')),
  tentativas integer NOT NULL DEFAULT 0,
  proxima_tentativa_em timestamptz NOT NULL DEFAULT now(),
  ultimo_erro text CHECK (char_length(ultimo_erro) <= 500),
  criado_em timestamptz NOT NULL DEFAULT now(),
  enviado_em timestamptz
);
CREATE INDEX ix_emails_fila ON emails (proxima_tentativa_em) WHERE status = 'na_fila';

-- RLS ligado em toda tabela, sem política.
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations' LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t.tablename);
  END LOOP;
END $$;
ALTER TABLE schema_migrations ENABLE ROW LEVEL SECURITY;
