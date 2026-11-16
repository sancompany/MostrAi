-- TICK — Campanhas (§3 do prompt master). Desenho aprovado pelo dono em
-- 16/11/2026: docs/trimundi/specs/2026-11-15-campanhas-desenho.md (v2) e
-- decisões C1–C7, R1–R3 em docs/trimundi/decisoes-comerciais-2026-11-14.md.
--
-- SÓ CRIA: nenhuma tabela, coluna ou dado existente é alterado aqui.
--
-- Garantias pelo banco (não só pelo código):
--   · posição imutável (gatilho) e única por (campanha, posição) e por
--     (campanha, ingresso); contador de posição que só cresce;
--   · prêmio com chave de idempotência única; no máximo um prêmio
--     não acumulável de pé por ingresso; nunca o mesmo brinde duas vezes no
--     mesmo ingresso;
--   · prêmio entregue é final (gatilho) e prêmio nunca é apagado;
--   · histórico dos prêmios só de acréscimo (gatilho);
--   · R1: no máximo UMA campanha de indicação não acumulável ATIVA por edição
--     (índice único parcial — vale também para duas ativações simultâneas).
--
-- Reversão (só se ainda não houver campanha nova em uso):
--   DROP TABLE campanha_premio_eventos, campanha_premios, campanha_posicoes,
--              campanha_faixas, campanha_alvos, campanhas;
--   DROP FUNCTION trimundi_campanha_regras(), trimundi_faixa_regras(),
--                 trimundi_premio_regras();
--   (e, da 016: DROP TABLE campanha_indicacoes.)

CREATE TABLE campanhas (
  id bigserial PRIMARY KEY,
  edicao_id bigint NOT NULL REFERENCES edicoes(id),
  modalidade text NOT NULL CHECK (modalidade IN ('ordem_compra', 'indicacao')),
  nome text NOT NULL CHECK (char_length(nome) BETWEEN 1 AND 80),
  descricao text NOT NULL DEFAULT '' CHECK (char_length(descricao) <= 1000),
  -- Regulamento público; revisão jurídica antes da 1ª publicação (C7).
  regras text NOT NULL DEFAULT '' CHECK (char_length(regras) <= 5000),
  regras_revisadas_em timestamptz,
  regras_revisadas_por text CHECK (char_length(regras_revisadas_por) <= 200),
  banner_chave text CHECK (char_length(banner_chave) <= 300),
  status text NOT NULL DEFAULT 'rascunho' CHECK (status IN ('rascunho', 'ativa', 'pausada', 'encerrada')),
  inicio timestamptz,
  fim timestamptz,
  relampago boolean NOT NULL DEFAULT false,
  acumula boolean NOT NULL DEFAULT false,
  prioridade integer NOT NULL DEFAULT 0 CHECK (prioridade BETWEEN -1000 AND 1000),
  escada text NOT NULL DEFAULT 'maior_nivel' CHECK (escada IN ('maior_nivel', 'cumulativa')),
  limite_por_pessoa integer CHECK (limite_por_pessoa BETWEEN 1 AND 1000),
  prazo_retirada timestamptz,
  inclui_combos boolean NOT NULL DEFAULT true,
  proxima_posicao integer NOT NULL DEFAULT 1 CHECK (proxima_posicao >= 1),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  encerrada_em timestamptz,
  CHECK (fim IS NULL OR inicio IS NULL OR fim > inicio),
  CHECK ((status = 'encerrada') = (encerrada_em IS NOT NULL))
);
CREATE INDEX ix_campanhas_edicao ON campanhas (edicao_id, status);
-- R1 (16/11/2026): uma campanha de indicação NÃO acumulável ativa por edição.
CREATE UNIQUE INDEX ux_campanha_indicacao_exclusiva ON campanhas (edicao_id)
  WHERE modalidade = 'indicacao' AND NOT acumula AND status = 'ativa';

-- Contador que só cresce (C6: a retomada nunca reaproveita posição) e
-- campanha encerrada que não reabre.
CREATE FUNCTION trimundi_campanha_regras() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trimundi AS $$
BEGIN
  IF NEW.proxima_posicao < OLD.proxima_posicao THEN
    RAISE EXCEPTION 'o contador de posições da campanha só cresce' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'encerrada' AND NEW.status <> 'encerrada' THEN
    RAISE EXCEPTION 'campanha encerrada não reabre' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.modalidade <> OLD.modalidade OR NEW.edicao_id <> OLD.edicao_id THEN
    RAISE EXCEPTION 'modalidade e edição da campanha não mudam' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campanhas_regras BEFORE UPDATE ON campanhas
  FOR EACH ROW EXECUTE FUNCTION trimundi_campanha_regras();
CREATE TRIGGER campanhas_sem_apagar BEFORE DELETE ON campanhas
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- Tipos e lotes que participam (ordem de compra). Sem linhas = edição toda.
CREATE TABLE campanha_alvos (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas(id),
  categoria_id bigint REFERENCES categorias(id),
  lote_id bigint REFERENCES lotes(id),
  CHECK (categoria_id IS NOT NULL OR lote_id IS NOT NULL)
);
CREATE UNIQUE INDEX ux_campanha_alvos ON campanha_alvos (campanha_id, COALESCE(categoria_id, 0), COALESCE(lote_id, 0));

-- Faixas (ordem de compra: posições de..ate) ou níveis (indicação: "de"
-- indicações). `repete`: "a cada `de` indicações, 1 prêmio" — o formato das
-- campanhas de indicação de antes (migration 016).
CREATE TABLE campanha_faixas (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas(id),
  ordem integer NOT NULL CHECK (ordem BETWEEN 1 AND 20),
  de integer NOT NULL CHECK (de BETWEEN 1 AND 1000000),
  ate integer CHECK (ate IS NULL OR (ate >= de AND ate <= 1000000)),
  repete boolean NOT NULL DEFAULT false,
  -- O brinde: nome livre, ligado ao catálogo de benefícios quando escolhido.
  premio text NOT NULL CHECK (char_length(premio) BETWEEN 1 AND 80),
  beneficio_id bigint REFERENCES beneficios(id),
  quantidade integer NOT NULL DEFAULT 1 CHECK (quantidade BETWEEN 1 AND 100),
  estoque integer CHECK (estoque BETWEEN 1 AND 1000000),
  custo_unitario_centavos bigint NOT NULL DEFAULT 0 CHECK (custo_unitario_centavos BETWEEN 0 AND 100000000),
  UNIQUE (campanha_id, ordem),
  CHECK (NOT repete OR ate IS NULL)
);

-- Faixas sem sobreposição (ordem de compra), níveis crescentes e no máximo
-- um nível `repete`, sozinho (indicação).
CREATE FUNCTION trimundi_faixa_regras() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trimundi AS $$
DECLARE
  m text;
BEGIN
  SELECT modalidade INTO m FROM campanhas WHERE id = NEW.campanha_id;
  IF m = 'ordem_compra' THEN
    IF NEW.ate IS NULL OR NEW.repete THEN
      RAISE EXCEPTION 'faixa de ordem de compra precisa de posição final e não repete' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM campanha_faixas f WHERE f.campanha_id = NEW.campanha_id AND f.id <> NEW.id
                AND int4range(f.de, f.ate, '[]') && int4range(NEW.de, NEW.ate, '[]')) THEN
      RAISE EXCEPTION 'faixas da campanha não podem se sobrepor' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.ate IS NOT NULL THEN
      RAISE EXCEPTION 'nível de indicação não tem posição final' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM campanha_faixas f WHERE f.campanha_id = NEW.campanha_id AND f.id <> NEW.id
                AND (f.repete OR NEW.repete)) THEN
      RAISE EXCEPTION 'o nível que se repete é o único da campanha' USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM campanha_faixas f WHERE f.campanha_id = NEW.campanha_id AND f.id <> NEW.id
                AND ((f.ordem < NEW.ordem AND f.de >= NEW.de) OR (f.ordem > NEW.ordem AND f.de <= NEW.de))) THEN
      RAISE EXCEPTION 'os níveis de indicação precisam crescer' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campanha_faixas_regras BEFORE INSERT OR UPDATE ON campanha_faixas
  FOR EACH ROW EXECUTE FUNCTION trimundi_faixa_regras();

-- Posição definitiva de cada ingresso pago na campanha (ordem de compra).
-- Imutável. O resultado é o que aconteceu NA HORA (C1: posição em todas as
-- campanhas em que se qualifica; o prêmio só da vencedora).
CREATE TABLE campanha_posicoes (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas(id),
  posicao integer NOT NULL CHECK (posicao >= 1),
  ingresso_id bigint NOT NULL REFERENCES ingressos(id),
  pedido_id uuid NOT NULL REFERENCES pedidos(id),
  comprador_cliente_id bigint REFERENCES clientes(id),
  faixa_id bigint REFERENCES campanha_faixas(id),
  resultado text NOT NULL CHECK (resultado IN ('premiado', 'sem_estoque', 'limite_por_pessoa', 'nao_acumulavel', 'sem_faixa')),
  vencedora_id bigint REFERENCES campanhas(id),
  -- R2: instante oficial = quando a TICK aplicou a confirmação; a hora do
  -- Checkout fica só para auditoria e investigação de atraso.
  confirmado_em timestamptz NOT NULL,
  confirmado_no_checkout_em timestamptz,
  atribuida_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campanha_id, posicao),
  UNIQUE (campanha_id, ingresso_id),
  CHECK ((resultado = 'nao_acumulavel') = (vencedora_id IS NOT NULL))
);
CREATE INDEX ix_campanha_posicoes_ingresso ON campanha_posicoes (ingresso_id);
CREATE TRIGGER campanha_posicoes_imutavel BEFORE UPDATE OR DELETE ON campanha_posicoes
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

-- O prêmio. Ordem de compra: do ingresso. Indicação: do indicador (um por
-- nível — C2 —, e um por repetição no nível que se repete).
CREATE TABLE campanha_premios (
  id bigserial PRIMARY KEY,
  campanha_id bigint NOT NULL REFERENCES campanhas(id),
  faixa_id bigint NOT NULL REFERENCES campanha_faixas(id),
  ingresso_id bigint REFERENCES ingressos(id),
  indicador_id bigint REFERENCES indicadores(id),
  repeticao integer CHECK (repeticao >= 1),
  posicao_id bigint REFERENCES campanha_posicoes(id),
  comprador_cliente_id bigint REFERENCES clientes(id),
  premio text NOT NULL CHECK (char_length(premio) BETWEEN 1 AND 80),
  beneficio_id bigint REFERENCES beneficios(id),
  -- Identidade do brinde para "nunca o mesmo brinde duas vezes no ingresso":
  -- 'b:<benefício>' ou 'n:<nome normalizado>'.
  brinde text NOT NULL CHECK (char_length(brinde) BETWEEN 3 AND 90),
  quantidade integer NOT NULL CHECK (quantidade BETWEEN 1 AND 100),
  valor_centavos bigint NOT NULL CHECK (valor_centavos >= 0),
  exclusivo boolean NOT NULL,
  so_admin boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'concedido' CHECK (status IN ('concedido', 'entregue', 'revogado', 'expirado')),
  motivo text CHECK (char_length(motivo) <= 200),
  concedido_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  entregue_em timestamptz,
  entregue_por text CHECK (char_length(entregue_por) <= 200),
  revogado_em timestamptz,
  expirado_em timestamptz,
  atualizado_em timestamptz NOT NULL DEFAULT clock_timestamp(),
  chave text NOT NULL UNIQUE CHECK (char_length(chave) BETWEEN 5 AND 120),
  CHECK ((ingresso_id IS NULL) <> (indicador_id IS NULL)),
  CHECK ((status = 'entregue') = (entregue_em IS NOT NULL)),
  CHECK (status <> 'revogado' OR revogado_em IS NOT NULL),
  CHECK (status <> 'expirado' OR expirado_em IS NOT NULL)
);
CREATE UNIQUE INDEX ux_premio_exclusivo ON campanha_premios (ingresso_id)
  WHERE exclusivo AND ingresso_id IS NOT NULL AND status IN ('concedido', 'entregue');
CREATE UNIQUE INDEX ux_premio_brinde ON campanha_premios (ingresso_id, brinde)
  WHERE ingresso_id IS NOT NULL AND status IN ('concedido', 'entregue');
CREATE INDEX ix_premios_indicador ON campanha_premios (campanha_id, indicador_id, status);
CREATE INDEX ix_premios_faixa ON campanha_premios (faixa_id, status);
CREATE INDEX ix_premios_comprador ON campanha_premios (campanha_id, comprador_cliente_id, status);
CREATE INDEX ix_premios_ingresso ON campanha_premios (ingresso_id) WHERE ingresso_id IS NOT NULL;

-- Prêmio nunca é apagado; o entregue é final (nunca revogado — C2); a
-- identidade do prêmio não muda depois de criada.
CREATE FUNCTION trimundi_premio_regras() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, trimundi AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prêmio de campanha não se apaga' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'entregue' AND (NEW.status <> 'entregue' OR NEW.entregue_em IS DISTINCT FROM OLD.entregue_em) THEN
    RAISE EXCEPTION 'prêmio entregue é final' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.chave <> OLD.chave OR NEW.campanha_id <> OLD.campanha_id OR NEW.faixa_id <> OLD.faixa_id
     OR NEW.ingresso_id IS DISTINCT FROM OLD.ingresso_id OR NEW.indicador_id IS DISTINCT FROM OLD.indicador_id
     OR NEW.repeticao IS DISTINCT FROM OLD.repeticao THEN
    RAISE EXCEPTION 'a identidade do prêmio não muda' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER campanha_premios_regras BEFORE UPDATE OR DELETE ON campanha_premios
  FOR EACH ROW EXECUTE FUNCTION trimundi_premio_regras();

-- Histórico de cada prêmio, só de acréscimo.
CREATE TABLE campanha_premio_eventos (
  id bigserial PRIMARY KEY,
  premio_id bigint NOT NULL REFERENCES campanha_premios(id),
  acao text NOT NULL CHECK (acao IN ('concedido', 'entregue', 'revogado', 'expirado', 'restaurado', 'alerta')),
  autor text NOT NULL CHECK (char_length(autor) BETWEEN 1 AND 200),
  motivo text CHECK (char_length(motivo) <= 200),
  em timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ix_premio_eventos ON campanha_premio_eventos (premio_id, id);
CREATE TRIGGER campanha_premio_eventos_imutavel BEFORE UPDATE OR DELETE ON campanha_premio_eventos
  FOR EACH ROW EXECUTE FUNCTION trimundi_historico_imutavel();

ALTER TABLE campanhas ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanha_alvos ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanha_faixas ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanha_posicoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanha_premios ENABLE ROW LEVEL SECURITY;
ALTER TABLE campanha_premio_eventos ENABLE ROW LEVEL SECURITY;
