-- PONTO FIXO E PONTO MÓVEL (02/10/2026, pedido do dono).
--
-- Ponto FIXO é o de sempre: mora num estabelecimento, e a conta que cedeu a
-- parede é a DONA (`anunciante_id`) — é ela que ganha o que todo dono ganha
-- (crédito mensal, Plano Básico, cupom de indicação).
--
-- Ponto MÓVEL é um ativo da própria Mostraí: ela cria, movimenta, define a
-- base e cadastra os eventos. Ele tem uma BASE (o comércio onde fica quando
-- não está em evento) e pode sair para eventos (campeonato, feira, festa) e
-- voltar. A conta da base é custodiante/parceira — NUNCA dona: por isso
-- `anunciante_id` fica NULL no móvel (CHECK abaixo), e todo benefício que
-- nasce de `anunciante_id` (src/creditos/ponto.js SQL_PONTOS_ELEGIVEIS, Plano
-- Básico, cupom) passa longe dele sem nenhuma regra nova. A organização de
-- um evento é texto do evento, nunca conta.
--
-- Local atual NÃO é coluna: é derivado (evento em andamento → o local dele;
-- senão → a base). Próximo evento também (o programado de data mais próxima
-- que ainda não terminou) — src/pontos/movel.js decide os dois.
--
-- ADITIVA: colunas novas com padrão 'fixo' + duas tabelas novas + uma coluna
-- nula no ledger do Proof-of-Play. Todo ponto existente continua fixo e com o
-- mesmo comportamento.

-- ---------------------------------------------------------------------------
-- 1. O tipo do ponto e a base do móvel
-- ---------------------------------------------------------------------------
ALTER TABLE pontos ADD COLUMN tipo text NOT NULL DEFAULT 'fixo';
ALTER TABLE pontos ADD CONSTRAINT pontos_tipo_check CHECK (tipo IN ('fixo', 'movel'));

-- Base atual do móvel: a conta custodiante, o nome do lugar (o nome do
-- comércio, não o da conta) e desde quando. O ENDEREÇO da base é o próprio
-- endereço do ponto (colunas de endereço + histórico em
-- pontos_enderecos_historico) — não se duplica.
-- Sem cascata: conta não é apagada fisicamente (excluir é anonimizar).
ALTER TABLE pontos ADD COLUMN base_conta_id integer REFERENCES anunciantes(id);
ALTER TABLE pontos ADD COLUMN base_nome text;
ALTER TABLE pontos ADD COLUMN base_desde timestamptz;
-- Número do móvel ("Mostraí Móvel #01"): dado uma vez, nunca reaproveitado.
ALTER TABLE pontos ADD COLUMN movel_numero integer;
CREATE SEQUENCE pontos_movel_numero_seq;
CREATE UNIQUE INDEX ux_pontos_movel_numero ON pontos (movel_numero) WHERE movel_numero IS NOT NULL;

-- A regra de propriedade mora no banco, não só na rota: móvel não tem dona
-- (é da Mostraí) e sempre tem base; fixo não tem base.
ALTER TABLE pontos ADD CONSTRAINT pontos_movel_coerente CHECK (
  (tipo = 'fixo' AND base_conta_id IS NULL AND base_nome IS NULL AND base_desde IS NULL)
  OR (tipo = 'movel' AND anunciante_id IS NULL AND base_conta_id IS NOT NULL
      AND base_nome IS NOT NULL AND base_desde IS NOT NULL AND movel_numero IS NOT NULL)
);
CREATE INDEX ix_pontos_base_conta ON pontos (base_conta_id) WHERE base_conta_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Bases anteriores (histórico de movimentação de base)
-- ---------------------------------------------------------------------------
-- Só períodos FECHADOS: a base atual mora em `pontos`. Uma linha nasce quando
-- o Admin troca a base, ou quando o móvel volta a ser fixo. `conta_id` sem
-- chave estrangeira, como em pontos_enderecos_historico: o histórico continua
-- dizendo quem foi mesmo se a conta for anonimizada.
CREATE TABLE pontos_moveis_bases (
  id bigserial PRIMARY KEY,
  ponto_id integer NOT NULL REFERENCES pontos(id) ON DELETE CASCADE,
  conta_id integer,
  nome text NOT NULL,
  -- A linha do endereço da base naquele período (retrato, para leitura).
  endereco text,
  desde timestamptz NOT NULL,
  ate timestamptz NOT NULL,
  alterado_por_admin text,
  CHECK (ate >= desde)
);
CREATE INDEX ix_pontos_moveis_bases_ponto ON pontos_moveis_bases (ponto_id, ate DESC);
ALTER TABLE pontos_moveis_bases ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3. Eventos do ponto móvel
-- ---------------------------------------------------------------------------
-- Cadastro leve: nome, organização, local, datas; público estimado e
-- observação são opcionais. O público é ESTIMATIVA do evento — nunca entra em
-- Proof-of-Play, impressão ou alcance.
--
-- Estados:
--   programado   — cadastrado, ainda não começou (candidato a "próximo evento");
--   em_andamento — o Admin marcou que o ponto está lá (vira o local atual);
--   encerrado    — o Admin encerrou e o ponto voltou para a base;
--   cancelado    — não aconteceu: nunca vira local atual nem próximo evento,
--                  e fica no histórico.
-- `iniciado_em`/`encerrado_em` são os instantes em que o Admin marcou —
-- é por eles que uma exibição confirmada se liga ao evento (auditoria).
CREATE TABLE pontos_moveis_eventos (
  id bigserial PRIMARY KEY,
  ponto_id integer NOT NULL REFERENCES pontos(id) ON DELETE CASCADE,
  nome text NOT NULL,
  organizacao text NOT NULL,
  local text NOT NULL,
  data_inicio date NOT NULL,
  data_fim date NOT NULL,
  publico_estimado integer,
  observacao text,
  estado text NOT NULL DEFAULT 'programado',
  iniciado_em timestamptz,
  encerrado_em timestamptz,
  cancelado_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now(),
  criado_por_admin text,
  CONSTRAINT pontos_moveis_eventos_estado_check
    CHECK (estado IN ('programado', 'em_andamento', 'encerrado', 'cancelado')),
  CONSTRAINT pontos_moveis_eventos_datas_check CHECK (data_fim >= data_inicio),
  CONSTRAINT pontos_moveis_eventos_publico_check CHECK (publico_estimado IS NULL OR publico_estimado > 0),
  CONSTRAINT pontos_moveis_eventos_estado_coerente CHECK (
    (estado = 'programado' AND iniciado_em IS NULL AND encerrado_em IS NULL AND cancelado_em IS NULL)
    OR (estado = 'em_andamento' AND iniciado_em IS NOT NULL AND encerrado_em IS NULL AND cancelado_em IS NULL)
    OR (estado = 'encerrado' AND iniciado_em IS NOT NULL AND encerrado_em IS NOT NULL AND cancelado_em IS NULL)
    OR (estado = 'cancelado' AND iniciado_em IS NULL AND encerrado_em IS NULL AND cancelado_em IS NOT NULL)
  )
);
-- Um ponto está em no máximo UM lugar: um evento em andamento por ponto.
CREATE UNIQUE INDEX ux_pontos_moveis_eventos_em_andamento ON pontos_moveis_eventos (ponto_id)
  WHERE estado = 'em_andamento';
CREATE INDEX ix_pontos_moveis_eventos_ponto ON pontos_moveis_eventos (ponto_id, data_inicio);
ALTER TABLE pontos_moveis_eventos ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 4. Contexto do Proof-of-Play
-- ---------------------------------------------------------------------------
-- Em qual evento a exibição aconteceu (só auditoria). Preenchido na
-- confirmação pelo instante da exibição contra o período em que o Admin
-- marcou o ponto no evento; NULL em ponto fixo e na base. Nunca decide se a
-- exibição conta — a regra de contabilização não muda.
ALTER TABLE execucoes_confirmadas ADD COLUMN evento_id bigint REFERENCES pontos_moveis_eventos(id);
CREATE INDEX ix_execucoes_confirmadas_evento ON execucoes_confirmadas (evento_id) WHERE evento_id IS NOT NULL;
