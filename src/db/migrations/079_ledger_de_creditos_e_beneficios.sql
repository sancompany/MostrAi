-- Ledger de créditos e ciclo de vida do benefício (23/09/2026, pedido do
-- dono: reconstrução do painel da conta).
--
-- ANTES: `indicacoes_pagas` era 1 linha por indicado, pra sempre — só a
-- PRIMEIRA cobrança confirmada de cada indicado gerava crédito (UNIQUE
-- (ponto_conta_id, indicado_conta_id) bloqueava qualquer linha seguinte).
-- Renovação nunca gerava crédito novo. Sem valor, sem tipo, sem
-- reconciliação — só COUNT(*).
--
-- AGORA: `creditos_ledger` é um ledger de verdade — uma linha imutável por
-- EVENTO (primeiro pagamento, cada renovação, concessão do admin, resgate),
-- com quantidade (positiva = crédito, negativa = débito de resgate) e tipo.
-- O saldo é sempre SOMA(quantidade), nunca uma coluna à parte — mesmo
-- raciocínio de auditabilidade que já vale para `cobrancas_confirmadas`.
--
-- `indicacoes_pagas` NÃO é apagada nem alterada — continua como registro
-- histórico imutável de "esse indicado já gerou o primeiro crédito". Código
-- novo não escreve mais nela; só lê pra saber se um indicado específico já
-- creditou antes de migrar pro ledger (ver backfill abaixo). Nenhum dado é
-- perdido, nenhuma tabela é dropada.
CREATE TABLE creditos_ledger (
  id bigserial PRIMARY KEY,
  anunciante_id integer NOT NULL REFERENCES anunciantes(id),
  tipo text NOT NULL CHECK (tipo IN (
    'indicacao_primeiro_pagamento',
    'indicacao_renovacao',
    'concessao_admin',
    'estorno_admin',
    'resgate_beneficio',
    'estorno_resgate'
  )),
  -- Positiva em crédito (indicação, concessão), negativa em débito (resgate,
  -- estorno de concessão). Nunca zero — não existe "evento de crédito zero".
  quantidade integer NOT NULL CHECK (quantidade <> 0),
  -- Preenchido só em indicação: quem pagou e gerou o crédito.
  origem_conta_id integer REFERENCES anunciantes(id),
  -- Preenchido só em indicação: a cobrança exata que gerou este crédito —
  -- é a chave de idempotência (ver índice único abaixo). Sem isso, webhook
  -- duplicado ou reprocessamento da conciliação poderia gerar o mesmo
  -- crédito duas vezes.
  cobranca_confirmada_id integer REFERENCES cobrancas_confirmadas(id),
  -- Preenchido só em concessão/estorno do admin: usuário admin responsável.
  concedido_por text,
  observacao text,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_creditos_ledger_conta ON creditos_ledger (anunciante_id, criado_em DESC);
-- Idempotência real: o mesmo pagamento nunca gera duas linhas de crédito,
-- nem que o webhook chegue duplicado ou a conciliação diária reprocesse.
CREATE UNIQUE INDEX idx_creditos_ledger_cobranca ON creditos_ledger (cobranca_confirmada_id)
  WHERE cobranca_confirmada_id IS NOT NULL;

-- Backfill: cada indicado que já gerou crédito antes desta migration vira 1
-- linha de ledger 'indicacao_primeiro_pagamento', com a data original —
-- migração explícita e auditável (não é suposição: o UNIQUE de
-- indicacoes_pagas já GARANTIA que era exatamente 1 crédito por linha,
-- então virar 1 linha de ledger de quantidade 1 não inventa nada). Sem
-- `cobranca_confirmada_id` (o dado de qual cobrança gerou cada linha
-- antiga não foi guardado em indicacoes_pagas) — fica NULL, e o índice de
-- idempotência acima não se aplica a essas linhas (WHERE NOT NULL).
INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, origem_conta_id, observacao, criado_em)
SELECT ponto_conta_id, 'indicacao_primeiro_pagamento', 1, indicado_conta_id,
       'migrado de indicacoes_pagas (079)', criado_em
  FROM indicacoes_pagas;

-- Ciclo de vida do benefício: estende `planos_administrativos` (migration
-- 075) em vez de criar tabela nova — ela já guarda `plano_anterior_id`/
-- `plano_anterior_origem`/`encerrado_motivo`, só nunca os usava pra voltar
-- ao plano anterior de verdade, só pra histórico. Aqui ela ganha o que
-- falta pra isso ser real: um estado explícito (`agendado` pra um benefício
-- esperando o ciclo pago atual terminar — REGRA: ciclo pago sempre termina
-- integralmente, nunca é interrompido no meio) e a validade do plano
-- anterior, pra saber QUANDO ativar o agendado.
ALTER TABLE planos_administrativos ADD COLUMN status text NOT NULL DEFAULT 'ativo'
  CHECK (status IN ('agendado', 'ativo', 'encerrado'));
UPDATE planos_administrativos SET status = 'encerrado' WHERE encerrado_em IS NOT NULL;
-- No máximo 1 benefício ATIVO e 1 AGENDADO por conta ao mesmo tempo — a
-- mesma trava que `fecharAbertos()` já aplica na aplicação, repetida aqui
-- como invariante do banco (padrão do projeto: nunca confiar só na
-- checagem em JS quando dá pra repetir no schema).
CREATE UNIQUE INDEX idx_planos_admin_um_ativo ON planos_administrativos (anunciante_id) WHERE status = 'ativo';
CREATE UNIQUE INDEX idx_planos_admin_um_agendado ON planos_administrativos (anunciante_id) WHERE status = 'agendado';

-- Validade do plano ANTERIOR (comercial pago, se havia) no momento da
-- concessão/resgate — sem isso não dá pra saber quando um benefício
-- agendado deve entrar em vigor (o ciclo pago já em curso continua valendo
-- até essa data, sem cobrar durante o benefício).
ALTER TABLE planos_administrativos ADD COLUMN plano_anterior_valido_ate date;
-- Quando o benefício de fato entrou em vigor pra quem recebe — igual a
-- `inicio` pra concessão imediata; só depois de `inicio`, no dia em que o
-- ciclo pago anterior terminou, pra um benefício que nasceu `agendado`.
ALTER TABLE planos_administrativos ADD COLUMN ativado_em timestamptz;
UPDATE planos_administrativos SET ativado_em = inicio WHERE status IN ('ativo', 'encerrado');

-- De onde veio o benefício: concessão direta do admin, ou resgate de
-- créditos (indicação ou concedidos). Sem isso a ficha da conta não
-- consegue dizer "Prime por créditos" vs. "Prime cortesia administrativa".
ALTER TABLE planos_administrativos ADD COLUMN origem text NOT NULL DEFAULT 'admin'
  CHECK (origem IN ('admin', 'indicacao'));
-- Liga o benefício ao débito que pagou por ele no ledger (resgate) — nulo
-- pra concessão direta do admin (essa não debita crédito nenhum).
ALTER TABLE planos_administrativos ADD COLUMN ledger_id bigint REFERENCES creditos_ledger(id);

-- Central de atualizações da conta (pedido do dono): histórico de eventos
-- relevantes pro dono da conta ver, distinto de `eventos` (métrica interna,
-- não é pra o cliente ler). Uma linha por evento, nunca apagada — "lida"
-- é só uma marca de tempo, não um estado que esconde a linha.
CREATE TABLE notificacoes (
  id bigserial PRIMARY KEY,
  anunciante_id integer NOT NULL REFERENCES anunciantes(id),
  tipo text NOT NULL,
  titulo text NOT NULL,
  descricao text,
  entidade_tipo text,
  entidade_id integer,
  link text,
  lida_em timestamptz,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notificacoes_conta ON notificacoes (anunciante_id, criado_em DESC);
CREATE INDEX idx_notificacoes_nao_lidas ON notificacoes (anunciante_id) WHERE lida_em IS NULL;
