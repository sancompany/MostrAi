-- PONTO MÓVEL V2 — hospedagem temporária, saldo de hospedagem em horas e o
-- ciclo de vida real do ativo (02/10/2026, pedido do dono). Evolui a 112.
--
-- O móvel é um ATIVO FÍSICO da Mostraí: 1 ponto móvel = 1 tela física. Fica
-- numa BASE, pode ser HOSPEDADO por um comércio por alguns dias ou ir a um
-- EVENTO, e volta. Quem hospeda recebe, no encerramento, uma parte do TEMPO
-- OPERACIONAL VÁLIDO da tela (percentual configurável, congelado na
-- hospedagem) em horas de mídia gratuitas na rede — um saldo próprio, que não
-- é crédito, não é Plano Básico e não é dinheiro.
--
-- ADITIVA. Produção conferida antes (só leitura, 02/10/2026): nenhum ponto,
-- tela, evento ou base de móvel — nada a converter.

-- ---------------------------------------------------------------------------
-- 1. Origem do ponto e tipo imutável
-- ---------------------------------------------------------------------------
-- Candidatura sempre gera FIXO; o móvel nasce só pelo Admin (sem candidatura)
-- e nunca tem dono. A base pode não ter conta (um depósito da Mostraí): o que
-- define a base é o lugar — nome e o endereço do ponto.
-- Guarda: um móvel criado pela V1 a partir de candidatura (a 112 deixava)
-- quebraria o CHECK novo com um erro genérico. Para com o motivo em vez de
-- converter dado sozinho — conferir e decidir à mão (RUNBOOK).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pontos WHERE tipo = 'movel' AND (candidatura_id IS NOT NULL OR anunciante_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'migration 113: há ponto móvel vindo de candidatura (ou com dono) — decidir à mão antes de aplicar';
  END IF;
END $$;
ALTER TABLE pontos DROP CONSTRAINT IF EXISTS pontos_movel_coerente;
ALTER TABLE pontos ADD CONSTRAINT pontos_movel_coerente CHECK (
  (tipo = 'fixo' AND base_conta_id IS NULL AND base_nome IS NULL AND base_desde IS NULL)
  OR (tipo = 'movel' AND anunciante_id IS NULL AND candidatura_id IS NULL
      AND base_nome IS NOT NULL AND base_desde IS NOT NULL AND movel_numero IS NOT NULL)
);

-- Tipo é do nascimento: nenhum UPDATE troca fixo ⇄ móvel (a conversão livre
-- da 112 saiu). Aposentar um equipamento móvel como instalação fixa, se um
-- dia existir, é outro procedimento — não um UPDATE.
CREATE OR REPLACE FUNCTION pontos_tipo_imutavel() RETURNS trigger AS $$
BEGIN
  IF NEW.tipo IS DISTINCT FROM OLD.tipo THEN
    RAISE EXCEPTION 'o tipo do ponto não muda depois de criado (ponto %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS pontos_tipo_imutavel ON pontos;
CREATE TRIGGER pontos_tipo_imutavel BEFORE UPDATE OF tipo ON pontos
  FOR EACH ROW EXECUTE FUNCTION pontos_tipo_imutavel();

-- ---------------------------------------------------------------------------
-- 2. Uma tela por ponto móvel
-- ---------------------------------------------------------------------------
-- Ativa ou em reparo conta como "a tela do móvel"; uma inativa pode ficar no
-- histórico (troca de equipamento). A linha do ponto é travada: duas telas
-- criadas ao mesmo tempo não passam juntas.
CREATE OR REPLACE FUNCTION dispositivos_uma_tela_por_movel() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'inativo' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM pontos WHERE id = NEW.ponto_id AND tipo = 'movel') THEN
    PERFORM 1 FROM pontos WHERE id = NEW.ponto_id FOR UPDATE;
    IF EXISTS (SELECT 1 FROM dispositivos
                WHERE ponto_id = NEW.ponto_id AND id <> NEW.id AND status <> 'inativo') THEN
      RAISE EXCEPTION 'ponto móvel tem uma tela só (ponto %)', NEW.ponto_id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS dispositivos_uma_tela_por_movel ON dispositivos;
CREATE TRIGGER dispositivos_uma_tela_por_movel BEFORE INSERT OR UPDATE OF ponto_id, status ON dispositivos
  FOR EACH ROW EXECUTE FUNCTION dispositivos_uma_tela_por_movel();

-- ---------------------------------------------------------------------------
-- 3. Evento: contexto de concorrência e encerramento automático
-- ---------------------------------------------------------------------------
-- categoria_id: o ramo que a trava de concorrente usa DURANTE o evento (NULL
-- = sem restrição — o evento não herda o ramo da base). encerramento: quem
-- encerrou — o Admin ou o sistema, no fim da data prevista.
ALTER TABLE pontos_moveis_eventos ADD COLUMN categoria_id integer REFERENCES categorias(id);
ALTER TABLE pontos_moveis_eventos ADD COLUMN encerramento text
  CHECK (encerramento IS NULL OR encerramento IN ('manual', 'automatico'));

-- ---------------------------------------------------------------------------
-- 4. Interesse em hospedar (site público e painel)
-- ---------------------------------------------------------------------------
-- Só manifestação de interesse: não reserva equipamento nem cria conta.
-- Visitante sem conta deixa os dados (como o contato); conta logada vai com
-- `conta_id`. O Admin decide e agenda.
CREATE TABLE hospedagem_interesses (
  id bigserial PRIMARY KEY,
  conta_id integer REFERENCES anunciantes(id),
  origem text NOT NULL CHECK (origem IN ('publico', 'painel')),
  empresa text NOT NULL,
  responsavel text NOT NULL,
  contato_email text,
  contato_telefone text NOT NULL,
  logradouro text, numero text, complemento text, bairro text,
  cidade text NOT NULL, uf text NOT NULL, cep text,
  endereco text NOT NULL,
  categoria_id integer REFERENCES categorias(id),
  categoria_livre text,
  disponibilidade text,
  observacao text,
  status text NOT NULL DEFAULT 'nova' CHECK (status IN ('nova', 'em_contato', 'agendada', 'recusada')),
  nota_interna text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_por_admin text
);
CREATE INDEX ix_hospedagem_interesses_status ON hospedagem_interesses (status, criado_em DESC);
CREATE INDEX ix_hospedagem_interesses_conta ON hospedagem_interesses (conta_id) WHERE conta_id IS NOT NULL;
ALTER TABLE hospedagem_interesses ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 5. Hospedagem temporária
-- ---------------------------------------------------------------------------
-- Ponto móvel + conta anfitriã + local + período. Não é aluguel: o comércio
-- não paga nada e não vira dono, ponto fixo, Básico nem crédito.
--   programada → ativa (o Admin marca que a tela chegou) → encerrada
--     (pelo Admin, antes ou no fim; ou pelo sistema no fim da data prevista);
--   programada → cancelada (não aconteceu: benefício 0).
-- `percentual`: o global no momento em que o Admin confirmou — nunca muda
-- depois. `tempo_operacional_segundos`/`beneficio_segundos`: apurados UMA vez,
-- no encerramento (o benefício vai para saldo_hospedagem_lancamentos com a
-- chave da hospedagem). `categoria_id`: o ramo do anfitrião, congelado — é o
-- que a trava de concorrente usa enquanto a hospedagem está ativa.
CREATE TABLE pontos_moveis_hospedagens (
  id bigserial PRIMARY KEY,
  ponto_id integer NOT NULL REFERENCES pontos(id),
  conta_id integer NOT NULL REFERENCES anunciantes(id),
  interesse_id bigint REFERENCES hospedagem_interesses(id),
  local text NOT NULL,
  endereco text NOT NULL,
  categoria_id integer REFERENCES categorias(id),
  data_inicio date NOT NULL,
  data_fim date NOT NULL,
  percentual numeric(5,2) NOT NULL CHECK (percentual >= 0 AND percentual <= 100),
  estado text NOT NULL DEFAULT 'programada',
  iniciada_em timestamptz,
  encerrada_em timestamptz,
  cancelada_em timestamptz,
  encerramento text CHECK (encerramento IS NULL OR encerramento IN ('manual', 'automatico')),
  tempo_operacional_segundos integer CHECK (tempo_operacional_segundos IS NULL OR tempo_operacional_segundos >= 0),
  beneficio_segundos integer CHECK (beneficio_segundos IS NULL OR beneficio_segundos >= 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por_admin text,
  encerrado_por_admin text,
  CONSTRAINT pontos_moveis_hospedagens_estado_check
    CHECK (estado IN ('programada', 'ativa', 'encerrada', 'cancelada')),
  CONSTRAINT pontos_moveis_hospedagens_datas_check CHECK (data_fim >= data_inicio),
  CONSTRAINT pontos_moveis_hospedagens_estado_coerente CHECK (
    (estado = 'programada' AND iniciada_em IS NULL AND encerrada_em IS NULL AND cancelada_em IS NULL
       AND tempo_operacional_segundos IS NULL AND beneficio_segundos IS NULL)
    OR (estado = 'ativa' AND iniciada_em IS NOT NULL AND encerrada_em IS NULL AND cancelada_em IS NULL
       AND tempo_operacional_segundos IS NULL AND beneficio_segundos IS NULL)
    OR (estado = 'encerrada' AND iniciada_em IS NOT NULL AND encerrada_em IS NOT NULL AND cancelada_em IS NULL
       AND encerrada_em >= iniciada_em AND encerramento IS NOT NULL
       AND tempo_operacional_segundos IS NOT NULL AND beneficio_segundos IS NOT NULL)
    OR (estado = 'cancelada' AND iniciada_em IS NULL AND encerrada_em IS NULL AND cancelada_em IS NOT NULL
       AND tempo_operacional_segundos IS NULL AND beneficio_segundos IS NULL)
  )
);
CREATE UNIQUE INDEX ux_pontos_moveis_hospedagens_ativa ON pontos_moveis_hospedagens (ponto_id)
  WHERE estado = 'ativa';
CREATE INDEX ix_pontos_moveis_hospedagens_ponto ON pontos_moveis_hospedagens (ponto_id, data_inicio);
CREATE INDEX ix_pontos_moveis_hospedagens_conta ON pontos_moveis_hospedagens (conta_id, criado_em DESC);
ALTER TABLE pontos_moveis_hospedagens ENABLE ROW LEVEL SECURITY;

-- Encerrada não volta a acumular: estado final não muda mais (nem o tempo
-- nem o benefício apurados).
CREATE OR REPLACE FUNCTION hospedagem_final_imutavel() RETURNS trigger AS $$
BEGIN
  IF OLD.estado IN ('encerrada', 'cancelada') THEN
    RAISE EXCEPTION 'hospedagem % já terminou e não muda mais', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER hospedagem_final_imutavel BEFORE UPDATE ON pontos_moveis_hospedagens
  FOR EACH ROW EXECUTE FUNCTION hospedagem_final_imutavel();

-- ---------------------------------------------------------------------------
-- 6. Agenda única do ponto móvel
-- ---------------------------------------------------------------------------
-- Um ponto móvel está em um lugar só: hospedagem e evento ocupam a MESMA
-- agenda (datas inclusivas). Ocupam: hospedagem programada/ativa e evento
-- programado/em andamento. E nunca há dois compromissos em curso ao mesmo
-- tempo (um evento pode começar na véspera, para montagem). A verificação mora
-- no banco — a linha do ponto é travada, então duas requisições ao mesmo
-- tempo não passam juntas — e o domínio (src/pontos/agenda.js) faz a mesma
-- pergunta antes, para responder com o motivo.
CREATE OR REPLACE FUNCTION movel_agenda_verificar() RETURNS trigger AS $$
DECLARE
  ocupa boolean;
  em_curso boolean;
  eh_hospedagem boolean := TG_TABLE_NAME = 'pontos_moveis_hospedagens';
BEGIN
  ocupa := NEW.estado IN ('programada', 'ativa', 'programado', 'em_andamento');
  IF NOT ocupa THEN
    RETURN NEW;
  END IF;
  em_curso := NEW.estado IN ('ativa', 'em_andamento');
  PERFORM 1 FROM pontos WHERE id = NEW.ponto_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM pontos_moveis_hospedagens h
     WHERE h.ponto_id = NEW.ponto_id AND h.estado IN ('programada', 'ativa')
       AND NOT (eh_hospedagem AND h.id = NEW.id)
       AND (daterange(h.data_inicio, h.data_fim, '[]') && daterange(NEW.data_inicio, NEW.data_fim, '[]')
            OR (em_curso AND h.estado = 'ativa'))
  ) OR EXISTS (
    SELECT 1 FROM pontos_moveis_eventos e
     WHERE e.ponto_id = NEW.ponto_id AND e.estado IN ('programado', 'em_andamento')
       AND NOT (NOT eh_hospedagem AND e.id = NEW.id)
       AND (daterange(e.data_inicio, e.data_fim, '[]') && daterange(NEW.data_inicio, NEW.data_fim, '[]')
            OR (em_curso AND e.estado = 'em_andamento'))
  ) THEN
    RAISE EXCEPTION 'agenda do ponto móvel % ocupada nesse período', NEW.ponto_id
      USING ERRCODE = 'exclusion_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER movel_agenda_hospedagens BEFORE INSERT OR UPDATE OF estado, data_inicio, data_fim
  ON pontos_moveis_hospedagens FOR EACH ROW EXECUTE FUNCTION movel_agenda_verificar();
CREATE TRIGGER movel_agenda_eventos BEFORE INSERT OR UPDATE OF estado, data_inicio, data_fim
  ON pontos_moveis_eventos FOR EACH ROW EXECUTE FUNCTION movel_agenda_verificar();

-- ---------------------------------------------------------------------------
-- 7. Tempo operacional da tela
-- ---------------------------------------------------------------------------
-- Intervalos em que a tela estava LIGADA, OPERACIONAL e APTA A EXIBIR, sempre
-- no relógio do servidor:
--   'heartbeat' — o servidor estende o intervalo a cada heartbeat com o
--      Player exibindo (PLAYING/IDLE); um buraco maior que a tolerância abre
--      outro intervalo (src/player/operacao.js);
--   'player'    — o Player conta o que exibiu SEM internet (segmentos com
--      relógio monotônico, ancorados no `servidorAgora` da playlist) e manda
--      quando volta; idempotente por (tela, boot, seq).
-- O tempo válido de um período é a UNIÃO desses intervalos — o mesmo minuto
-- visto pelos dois lados conta uma vez. Nunca `fim − início` do calendário.
CREATE TABLE tela_operacao (
  id bigserial PRIMARY KEY,
  dispositivo_id integer NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  origem text NOT NULL CHECK (origem IN ('heartbeat', 'player')),
  inicio timestamptz NOT NULL,
  fim timestamptz NOT NULL,
  boot_id text,
  seq integer,
  recebido_em timestamptz NOT NULL DEFAULT now(),
  CHECK (fim >= inicio),
  CHECK ((origem = 'player') = (boot_id IS NOT NULL AND seq IS NOT NULL))
);
CREATE UNIQUE INDEX ux_tela_operacao_segmento ON tela_operacao (dispositivo_id, boot_id, seq)
  WHERE origem = 'player';
CREATE INDEX ix_tela_operacao_tela_fim ON tela_operacao (dispositivo_id, fim);
ALTER TABLE tela_operacao ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 8. Saldo de hospedagem
-- ---------------------------------------------------------------------------
-- O que ENTRA no saldo, uma linha imutável por fato:
--   'beneficio' — o encerramento da hospedagem (chave `hospedagem:<id>`: o
--      mesmo encerramento repetido, retry ou job concorrente gravam uma vez);
--   'ajuste'    — correção do Admin, + ou −, com motivo (nunca se edita a
--      linha do benefício).
-- O que SAI é entrega: exibições confirmadas (Proof-of-Play) que o gerador
-- programou na camada de hospedagem (exibicoes_contador.vezes_hospedagem,
-- abaixo) — derivado, nunca digitado. Não expira, não vira dinheiro nem crédito.
CREATE TABLE saldo_hospedagem_lancamentos (
  id bigserial PRIMARY KEY,
  conta_id integer NOT NULL REFERENCES anunciantes(id),
  tipo text NOT NULL CHECK (tipo IN ('beneficio', 'ajuste')),
  segundos integer NOT NULL,
  chave text NOT NULL UNIQUE,
  hospedagem_id bigint REFERENCES pontos_moveis_hospedagens(id),
  motivo text,
  admin text,
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK ((tipo = 'beneficio' AND segundos >= 0 AND hospedagem_id IS NOT NULL)
      OR (tipo = 'ajuste' AND segundos <> 0 AND motivo IS NOT NULL AND admin IS NOT NULL))
);
CREATE INDEX ix_saldo_hospedagem_conta ON saldo_hospedagem_lancamentos (conta_id, criado_em);
ALTER TABLE saldo_hospedagem_lancamentos ENABLE ROW LEVEL SECURITY;

-- A parte da hora programada pela camada de hospedagem (como vezes_banco
-- para o atraso). Confirmação é atribuída por posição: primeiro a parte
-- normal, depois o banco, por último a hospedagem — a gratuita é a última a
-- ser considerada entregue, nunca come a entrega paga.
ALTER TABLE exibicoes_contador ADD COLUMN vezes_hospedagem integer NOT NULL DEFAULT 0;
ALTER TABLE exibicoes_contador ADD CONSTRAINT exibicoes_contador_vezes_hospedagem_check
  CHECK (vezes_hospedagem >= 0 AND vezes_banco + vezes_hospedagem <= vezes_programadas);
CREATE INDEX exibicoes_contador_hospedagem_idx ON exibicoes_contador (anunciante_id, janela_hora)
  WHERE vezes_hospedagem > 0;

-- ---------------------------------------------------------------------------
-- 9. Percentual do benefício (configuração global com auditoria)
-- ---------------------------------------------------------------------------
-- O valor vive em configuracoes_site (chave `hospedagem_percentual`); cada
-- alteração deixa uma linha aqui. Começa em 20% (decisão do dono).
CREATE TABLE hospedagem_percentual_historico (
  id bigserial PRIMARY KEY,
  anterior numeric(5,2),
  novo numeric(5,2) NOT NULL CHECK (novo >= 0 AND novo <= 100),
  admin text NOT NULL,
  alterado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hospedagem_percentual_historico ENABLE ROW LEVEL SECURITY;
INSERT INTO configuracoes_site (chave, valor) VALUES ('hospedagem_percentual', '20')
  ON CONFLICT (chave) DO NOTHING;
