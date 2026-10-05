-- MOSTRAÍ MÓVEL = REDE MÓVEL DE UMA CIDADE (05/10/2026, pedido do dono —
-- reconstrução final do Ponto Móvel).
--
-- O modelo da 112–114 nasceu com "1 ponto móvel = 1 equipamento = 1 tela".
-- Errado para o produto: o ponto móvel (pontos.tipo = 'movel') passa a ser a
-- REDE MÓVEL COMERCIAL de uma cidade — "Mostraí Móvel — Matão/SP" — e as
-- telas físicas dela são `dispositivos` comuns, quantas forem. O anunciante
-- escolhe a REDE (1 posição do plano); cada TELA tem a sua alocação
-- (hospedagem ou evento), o seu contexto e a sua agenda. Player, credencial,
-- heartbeat e POP continuam por tela, sem mudança.
--
-- Produção quando esta foi escrita (consulta só leitura, 05/10/2026): um
-- ponto móvel (id 9, sem cidade/UF, com foto), uma tela (id 10, provisionada,
-- com sinal), 0 hospedagens, 0 eventos, 0 interesses, 0 aceites de termo, 0
-- movimentações, 0 lançamentos de saldo; custo/amortização sem valor em
-- nenhuma tela (0 e o padrão 36). As migrations 112–114 não foram editadas.

-- ---------------------------------------------------------------------------
-- 1. A rede móvel: cidade + UF obrigatórias e únicas
-- ---------------------------------------------------------------------------
-- O único móvel existente é a rede de Matão/SP (a operação da Mostraí). Os
-- IDs não mudam: a tela 10 continua ligada ao ponto 9, com a mesma
-- credencial e o mesmo Player — nada a reinstalar.
-- (vazio conta como sem: o cadastro antigo gravava '' em vez de NULL)
UPDATE pontos SET cidade = 'Matão', uf = 'SP'
 WHERE tipo = 'movel' AND (COALESCE(btrim(cidade), '') = '' OR COALESCE(uf, '') !~ '^[A-Z]{2}$');
-- Nome que era o padrão do equipamento ("Mostraí Móvel #02", "Mostraí
-- Movel") vira o nome público da rede.
UPDATE pontos SET nome = 'Mostraí Móvel — ' || cidade
 WHERE tipo = 'movel' AND nome ~* '^\s*mostra[ií]\s+m[oó]vel(\s*#?\s*[0-9]+)?\s*$';

ALTER TABLE pontos ADD CONSTRAINT pontos_rede_movel_cidade
  CHECK (tipo <> 'movel' OR (cidade IS NOT NULL AND btrim(cidade) <> '' AND uf ~ '^[A-Z]{2}$'));
-- Uma rede comercial por cidade + UF (arquivada não conta).
CREATE UNIQUE INDEX ux_pontos_rede_movel_cidade ON pontos (lower(btrim(cidade)), uf)
  WHERE tipo = 'movel' AND status <> 'arquivado';

-- ---------------------------------------------------------------------------
-- 2. Várias telas por rede
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS dispositivos_uma_tela_por_movel ON dispositivos;
DROP FUNCTION IF EXISTS dispositivos_uma_tela_por_movel();

-- ---------------------------------------------------------------------------
-- 3. Alocação por TELA
-- ---------------------------------------------------------------------------
-- Hospedagem (V1): UMA tela. `ponto_id` continua sendo a rede.
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN dispositivo_id integer REFERENCES dispositivos(id);
ALTER TABLE pontos_moveis_hospedagens DISABLE TRIGGER hospedagem_final_imutavel;
UPDATE pontos_moveis_hospedagens h
   SET dispositivo_id = (SELECT d.id FROM dispositivos d WHERE d.ponto_id = h.ponto_id
                          ORDER BY (d.status = 'inativo'), d.id LIMIT 1);
ALTER TABLE pontos_moveis_hospedagens ENABLE TRIGGER hospedagem_final_imutavel;
ALTER TABLE pontos_moveis_hospedagens ALTER COLUMN dispositivo_id SET NOT NULL;
CREATE INDEX ix_pontos_moveis_hospedagens_tela ON pontos_moveis_hospedagens (dispositivo_id)
  WHERE estado IN ('programada', 'ativa');
-- "Uma hospedagem ativa por PONTO" (113) vira por TELA: duas telas da rede
-- podem estar hospedadas ao mesmo tempo em comércios diferentes.
DROP INDEX IF EXISTS ux_pontos_moveis_hospedagens_ativa;
CREATE UNIQUE INDEX ux_pontos_moveis_hospedagens_ativa_tela ON pontos_moveis_hospedagens (dispositivo_id)
  WHERE estado = 'ativa';

-- Evento: da rede, com UMA OU VÁRIAS telas participantes (sem copiar o
-- evento por tela). Endereço do local passa a existir; organização vira
-- opcional.
ALTER TABLE pontos_moveis_eventos ADD COLUMN endereco text
  CHECK (endereco IS NULL OR length(endereco) <= 300);
ALTER TABLE pontos_moveis_eventos ALTER COLUMN organizacao DROP NOT NULL;
CREATE TABLE pontos_moveis_evento_telas (
  evento_id bigint NOT NULL REFERENCES pontos_moveis_eventos(id) ON DELETE CASCADE,
  dispositivo_id integer NOT NULL REFERENCES dispositivos(id),
  PRIMARY KEY (evento_id, dispositivo_id)
);
CREATE INDEX ix_pontos_moveis_evento_telas_tela ON pontos_moveis_evento_telas (dispositivo_id);
-- "Um evento em andamento por PONTO" (112) sai: a rede pode ter eventos
-- simultâneos com telas diferentes. "Um em curso por tela" fica com a agenda
-- (`movel_tela_ocupada`, abaixo).
DROP INDEX IF EXISTS ux_pontos_moveis_eventos_em_andamento;
ALTER TABLE pontos_moveis_evento_telas ENABLE ROW LEVEL SECURITY;
INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id)
SELECT e.id, d.id
  FROM pontos_moveis_eventos e
  JOIN LATERAL (SELECT x.id FROM dispositivos x WHERE x.ponto_id = e.ponto_id
                 ORDER BY (x.status = 'inativo'), x.id LIMIT 1) d ON true;

-- ---------------------------------------------------------------------------
-- 4. Agenda por TELA (substitui a agenda única do ponto, 113/114)
-- ---------------------------------------------------------------------------
-- Duas telas da mesma rede podem estar em compromissos simultâneos; a MESMA
-- tela nunca: [inicio, fim) de um compromisso dela não cruza o de outro, e
-- dois em curso nunca coexistem. Trava por tela (advisory lock da transação,
-- sem travar a linha da tela — o heartbeat não disputa). Mesmo código de
-- erro de antes (src/pontos/agenda.js traduz).
DROP TRIGGER IF EXISTS movel_agenda_hospedagens ON pontos_moveis_hospedagens;
DROP TRIGGER IF EXISTS movel_agenda_eventos ON pontos_moveis_eventos;
DROP FUNCTION IF EXISTS movel_agenda_verificar();

CREATE OR REPLACE FUNCTION movel_tela_ocupada(
  tela integer, de timestamptz, ate timestamptz, em_curso boolean, sem_hospedagem bigint, sem_evento bigint
) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM pontos_moveis_hospedagens h
     WHERE h.dispositivo_id = tela AND h.estado IN ('programada', 'ativa')
       AND h.id IS DISTINCT FROM sem_hospedagem
       AND (tstzrange(h.inicio, h.fim, '[)') && tstzrange(de, ate, '[)') OR (em_curso AND h.estado = 'ativa'))
  ) OR EXISTS (
    SELECT 1 FROM pontos_moveis_evento_telas et JOIN pontos_moveis_eventos e ON e.id = et.evento_id
     WHERE et.dispositivo_id = tela AND e.estado IN ('programado', 'em_andamento')
       AND e.id IS DISTINCT FROM sem_evento
       AND (tstzrange(e.inicio, e.fim, '[)') && tstzrange(de, ate, '[)') OR (em_curso AND e.estado = 'em_andamento'))
  )
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION movel_agenda_hospedagem() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.id = NEW.dispositivo_id AND d.ponto_id = NEW.ponto_id) THEN
    RAISE EXCEPTION 'a tela % não é da rede móvel %', NEW.dispositivo_id, NEW.ponto_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.estado NOT IN ('programada', 'ativa') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(115, NEW.dispositivo_id);
  IF movel_tela_ocupada(NEW.dispositivo_id, NEW.inicio, NEW.fim, NEW.estado = 'ativa', NEW.id, NULL) THEN
    RAISE EXCEPTION 'agenda da tela % ocupada nesse período', NEW.dispositivo_id USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movel_agenda_hospedagens BEFORE INSERT OR UPDATE OF estado, inicio, fim, dispositivo_id
  ON pontos_moveis_hospedagens FOR EACH ROW EXECUTE FUNCTION movel_agenda_hospedagem();

-- Tela entrando num evento: tem de ser da rede do evento e estar livre.
CREATE OR REPLACE FUNCTION movel_agenda_evento_tela() RETURNS trigger AS $$
DECLARE
  ev pontos_moveis_eventos%ROWTYPE;
BEGIN
  SELECT * INTO ev FROM pontos_moveis_eventos WHERE id = NEW.evento_id;
  IF NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.id = NEW.dispositivo_id AND d.ponto_id = ev.ponto_id) THEN
    RAISE EXCEPTION 'a tela % não é da rede móvel %', NEW.dispositivo_id, ev.ponto_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF ev.estado NOT IN ('programado', 'em_andamento') THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(115, NEW.dispositivo_id);
  IF movel_tela_ocupada(NEW.dispositivo_id, ev.inicio, ev.fim, ev.estado = 'em_andamento', NULL, ev.id) THEN
    RAISE EXCEPTION 'agenda da tela % ocupada nesse período', NEW.dispositivo_id USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movel_agenda_evento_telas BEFORE INSERT OR UPDATE
  ON pontos_moveis_evento_telas FOR EACH ROW EXECUTE FUNCTION movel_agenda_evento_tela();

-- Evento mudando de período ou entrando em andamento: confere cada tela dele.
CREATE OR REPLACE FUNCTION movel_agenda_evento() RETURNS trigger AS $$
DECLARE
  tela integer;
BEGIN
  IF NEW.estado NOT IN ('programado', 'em_andamento') THEN
    RETURN NEW;
  END IF;
  FOR tela IN SELECT et.dispositivo_id FROM pontos_moveis_evento_telas et WHERE et.evento_id = NEW.id ORDER BY 1 LOOP
    PERFORM pg_advisory_xact_lock(115, tela);
    IF movel_tela_ocupada(tela, NEW.inicio, NEW.fim, NEW.estado = 'em_andamento', NULL, NEW.id) THEN
      RAISE EXCEPTION 'agenda da tela % ocupada nesse período', tela USING ERRCODE = 'exclusion_violation';
    END IF;
  END LOOP;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movel_agenda_eventos BEFORE UPDATE OF estado, inicio, fim
  ON pontos_moveis_eventos FOR EACH ROW EXECUTE FUNCTION movel_agenda_evento();

-- ---------------------------------------------------------------------------
-- 5. A cota da rede numa hora: o pool determinístico
-- ---------------------------------------------------------------------------
-- As telas da rede que estavam ALOCADAS no instante `hora` (o início da
-- janela), por id. Depende só da rede e da hora — qualquer tela, a qualquer
-- momento da hora, vê o mesmo pool —, e é por ele que a parcela da rede se
-- divide (src/lib/pacing.js#parcelaNoPool): tela que entra no meio da hora
-- só participa da próxima; a que sai leva a fração dela consigo (não
-- entrega), e a soma das telas nunca passa da cota da rede. "Alocada no
-- instante" = hospedagem iniciada antes e não encerrada até ele, ou evento
-- (com a tela) iniciado antes e não encerrado até ele; tela fora de
-- operação no cadastro (status ≠ ativo) não entra.
CREATE OR REPLACE FUNCTION rede_movel_pool(rede integer, hora timestamptz) RETURNS integer[] AS $$
  SELECT COALESCE(array_agg(d.id ORDER BY d.id), ARRAY[]::integer[])
    FROM dispositivos d
   WHERE d.ponto_id = rede AND d.status = 'ativo'
     AND (EXISTS (SELECT 1 FROM pontos_moveis_hospedagens h
                   WHERE h.dispositivo_id = d.id AND h.estado IN ('ativa', 'encerrada')
                     AND h.iniciada_em <= hora AND (h.encerrada_em IS NULL OR h.encerrada_em > hora))
          OR EXISTS (SELECT 1 FROM pontos_moveis_evento_telas et JOIN pontos_moveis_eventos e ON e.id = et.evento_id
                      WHERE et.dispositivo_id = d.id AND e.estado IN ('em_andamento', 'encerrado')
                        AND e.iniciado_em <= hora AND (e.encerrado_em IS NULL OR e.encerrado_em > hora)))
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- 6. Termo de hospedagem FÍSICO (assinado em papel)
-- ---------------------------------------------------------------------------
-- O sistema deixa de ser plataforma de assinatura: sai o aceite eletrônico
-- (0 aceites em produção; os termos eram só as minutas da 113/114) e entra o
-- controle operacional — o Admin marca que o termo físico foi assinado (data
-- e observação opcionais; o papel fica arquivado na Mostraí). O anexo
-- digitalizado NÃO entra: o único bucket do projeto é público, e documento
-- assinado não vai para endereço público (docs/PENDENCIAS.md). Iniciar exige
-- isto + a entrega do equipamento (hospedagem_movimentacoes, que continua).
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN termo_assinado boolean NOT NULL DEFAULT false;
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN termo_assinado_em date;
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN termo_observacao text
  CHECK (termo_observacao IS NULL OR length(termo_observacao) <= 1000);
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN termo_marcado_por text;
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN termo_marcado_em timestamptz;

DROP TABLE IF EXISTS hospedagem_aceites;
DROP FUNCTION IF EXISTS hospedagem_aceite_imutavel();
DROP TABLE IF EXISTS hospedagem_termos;
DROP FUNCTION IF EXISTS hospedagem_termo_imutavel();

-- ---------------------------------------------------------------------------
-- 7. Custo/amortização de equipamento saem do produto
-- ---------------------------------------------------------------------------
-- Nenhuma tela tinha custo informado (todas 0 / padrão 36 meses): não há
-- histórico a preservar. `instalado_em` continua (é data, não financeiro).
ALTER TABLE dispositivos DROP COLUMN IF EXISTS custo_equipamento;
ALTER TABLE dispositivos DROP COLUMN IF EXISTS meses_amortizacao;
