-- Distribuição real (estação de 27/09/2026): quando o criativo foi aprovado,
-- quando ele TOCOU de verdade, e quantas vezes a Mídia Mostraí foi
-- programada × confirmada. ADITIVA: só colunas e tabelas novas, nenhum dado
-- apagado; compatível com deploy em rolagem (o código antigo ignora tudo).

-- ---------------------------------------------------------------------------
-- 1. Criativo: aprovado ≠ no ar
-- ---------------------------------------------------------------------------
-- `aprovado_em`: início do "contexto vigente" da peça. Carimbado pelo banco
-- em TODA passagem pra 'aprovado' (inclusive voltar de 'retirado'), por
-- qualquer caminho (fila do admin, ficha, upload do operador) — não depende
-- de cada rota lembrar. Peça já aprovada antes desta migration fica com o
-- `created_at` (aproximação: nada registrava o momento da aprovação).
--
-- `primeira_exibicao_em` / `ultima_exibicao_em`: só o proof-of-play
-- CONFIRMADO escreve (src/playlist/gerador.js#confirmarExecucao). "No ar" é
-- ter exibição confirmada depois do início do contexto — nunca a aprovação,
-- nunca a playlist gerada, nunca o download.
ALTER TABLE criativos
  ADD COLUMN aprovado_em timestamptz,
  ADD COLUMN primeira_exibicao_em timestamptz,
  ADD COLUMN ultima_exibicao_em timestamptz;

UPDATE criativos SET aprovado_em = created_at WHERE status = 'aprovado' AND aprovado_em IS NULL;

CREATE FUNCTION carimbar_aprovacao_criativo() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'aprovado' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'aprovado') THEN
    NEW.aprovado_em := now();
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER criativos_carimbar_aprovacao
  BEFORE INSERT OR UPDATE OF status ON criativos
  FOR EACH ROW EXECUTE FUNCTION carimbar_aprovacao_criativo();

-- ---------------------------------------------------------------------------
-- 2. Mídia Mostraí: programadas × confirmadas por mídia, tela e hora
-- ---------------------------------------------------------------------------
-- Tabela própria, e não `exibicoes_contador`: aquela é do anunciante
-- (`anunciante_id int`, banco de horas, déficit, comprovante) e a Mídia
-- Mostraí não é venda — misturar exigiria anunciante falso e contaminaria a
-- entrega comercial. Mesma forma de contador (hora × tela), mesma regra de
-- teto: `vezes_confirmadas` nunca passa de `vezes_programadas`.
-- `ponto_id` junto: a métrica por ponto sobrevive à tela ser trocada.
-- Idempotência continua em `execucoes_confirmadas` (por `execucaoId`).
CREATE TABLE midias_exibicoes_contador (
  midia_id int NOT NULL REFERENCES midias_proprias(id) ON DELETE CASCADE,
  dispositivo_id int NOT NULL,
  ponto_id int NOT NULL,
  janela_hora timestamptz NOT NULL,
  vezes_programadas int NOT NULL DEFAULT 0 CHECK (vezes_programadas >= 0),
  vezes_confirmadas int NOT NULL DEFAULT 0 CHECK (vezes_confirmadas >= 0),
  primeira_confirmacao_em timestamptz,
  ultima_confirmacao_em timestamptz,
  PRIMARY KEY (midia_id, dispositivo_id, janela_hora)
);
CREATE INDEX idx_midias_exibicoes_midia_hora ON midias_exibicoes_contador (midia_id, janela_hora);
ALTER TABLE midias_exibicoes_contador ENABLE ROW LEVEL SECURITY;

-- Histórico da situação (ativa/pausada/encerrada): sem ele, "quanto deveria
-- ter tocado" num período com pausa no meio seria chute. O trigger grava
-- toda mudança, venha de qual rota vier. Mídia criada antes desta migration
-- ganha uma linha com a situação atual desde a criação (aproximação — o
-- histórico anterior não existia).
CREATE TABLE midias_proprias_situacoes (
  id bigserial PRIMARY KEY,
  midia_id int NOT NULL REFERENCES midias_proprias(id) ON DELETE CASCADE,
  situacao text NOT NULL CHECK (situacao IN ('ativa', 'pausada', 'encerrada')),
  desde timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_midias_situacoes_midia ON midias_proprias_situacoes (midia_id, desde);
ALTER TABLE midias_proprias_situacoes ENABLE ROW LEVEL SECURITY;

INSERT INTO midias_proprias_situacoes (midia_id, situacao, desde)
SELECT id, situacao, created_at FROM midias_proprias;

CREATE FUNCTION registrar_situacao_midia() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.situacao IS DISTINCT FROM NEW.situacao THEN
    INSERT INTO midias_proprias_situacoes (midia_id, situacao, desde) VALUES (NEW.id, NEW.situacao, now());
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER midias_proprias_registrar_situacao
  AFTER INSERT OR UPDATE OF situacao ON midias_proprias
  FOR EACH ROW EXECUTE FUNCTION registrar_situacao_midia();
