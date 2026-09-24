-- Créditos do ponto no lugar de Inicial/Básico e do repasse de R$ 50
-- (24/09/2026, reestruturação do modelo de benefícios dos pontos, pedido do
-- dono — ADR-016 em .ia/DECISIONS.md).
--
-- ANTES: quem cedia a parede escolhia uma "modalidade de comodato"
-- (`planos_ponto`): "Recebe os R$ 50" (repasse mensal em dinheiro + plano
-- Inicial) ou "Troca os R$ 50 por tela" (plano Básico + R$ 50 de crédito
-- monetário na mensalidade). AGORA: ser ponto não é plano. Ponto aprovado com
-- tela instalada e ativa gera 1 CRÉDITO por mês — a mesma unidade do ledger
-- de indicação/concessão, resgatável em benefício Essencial/Pro/Prime.
--
-- NADA É APAGADO. O que existia fica como histórico:
--   · `planos_ponto` (as duas modalidades) viram inativas — nenhuma escolha
--     nova, nenhuma tela as oferece; as linhas continuam (FK de pontos e
--     candidaturas antigas);
--   · `planos` 'inicial-1m' e 'comodato-basico' já eram `ativo = false`
--     (nunca se venderam) — continuam existindo pro histórico;
--   · `pagamentos_ponto` (repasses) continua com o que já foi pago; nenhuma
--     rota cria linha nova;
--   · `anunciantes.comodato_plano_id`/`credito_comodato_mensal` e
--     `pontos.plano_ponto_id`/`valor_pago_mensal` ficam como estão — o
--     código deixa de ler e de escrever. Auditoria de produção em
--     24/09/2026: 0 contas com comodato_plano_id, 0 com crédito monetário,
--     1 ponto (id 1, sem conta dona) com a modalidade antiga, 1 repasse
--     histórico pago (set/2026). Nenhuma equivalência é inventada.
--
-- Contrato JURÍDICO de comodato do equipamento (TV, suporte) é outra coisa e
-- não é tocado aqui: comodato deixa de ser PLANO COMERCIAL, não deixa de ser
-- a forma de ceder o equipamento.

-- 1. Crédito mensal do ponto no ledger único.
ALTER TABLE creditos_ledger DROP CONSTRAINT creditos_ledger_tipo_check;
ALTER TABLE creditos_ledger ADD CONSTRAINT creditos_ledger_tipo_check CHECK (tipo IN (
  'indicacao_primeiro_pagamento',
  'indicacao_renovacao',
  'credito_mensal_ponto',
  'concessao_admin',
  'estorno_admin',
  'resgate_beneficio',
  'estorno_resgate'
));
-- De qual ponto e de qual mês (competência = dia 1 do mês, fuso de Matão).
ALTER TABLE creditos_ledger ADD COLUMN IF NOT EXISTS ponto_id integer REFERENCES pontos(id);
ALTER TABLE creditos_ledger ADD COLUMN IF NOT EXISTS competencia date;
ALTER TABLE creditos_ledger ADD CONSTRAINT creditos_ledger_credito_ponto_coerente CHECK (
  (tipo = 'credito_mensal_ponto') = (ponto_id IS NOT NULL AND competencia IS NOT NULL)
  AND (competencia IS NULL OR extract(day FROM competencia) = 1)
);
-- Idempotência de verdade: UM crédito por ponto por mês, não importa quantas
-- vezes o job rode nem de quem o ponto seja — troca de dono no meio do mês
-- não gera o mês de novo pra conta nova.
CREATE UNIQUE INDEX IF NOT EXISTS idx_creditos_ledger_ponto_competencia
  ON creditos_ledger (ponto_id, competencia) WHERE tipo = 'credito_mensal_ponto';

-- 2. Benefício encerrado porque um plano PAGO de nível maior entrou.
ALTER TABLE planos_administrativos DROP CONSTRAINT planos_administrativos_encerrado_motivo_check;
ALTER TABLE planos_administrativos ADD CONSTRAINT planos_administrativos_encerrado_motivo_check
  CHECK (encerrado_motivo IS NULL OR encerrado_motivo IN (
    'substituido', 'cancelado', 'vencido', 'superado_por_plano_pago'
  ));

-- 3. Plano PAGO guardado enquanto um benefício está por cima dele. O
-- `plano_id` da conta continua sendo o que vale AGORA (é o que o gerador, o
-- painel e o admin leem); quando um benefício (igual ou maior) entra por
-- cima de um plano pago, o pago fica guardado aqui com os DIAS de cobertura
-- que ainda tinha — e volta sozinho quando o benefício termina, com esses
-- dias intactos. Renovação paga durante o benefício soma dias aqui (o
-- tempo pago nunca se perde).
ALTER TABLE anunciantes ADD COLUMN IF NOT EXISTS plano_pago_guardado_id text REFERENCES planos(id);
ALTER TABLE anunciantes ADD COLUMN IF NOT EXISTS plano_pago_guardado_dias integer;
ALTER TABLE anunciantes ADD CONSTRAINT anunciantes_plano_pago_guardado_coerente CHECK (
  (plano_pago_guardado_id IS NULL) = (plano_pago_guardado_dias IS NULL)
  AND (plano_pago_guardado_dias IS NULL OR plano_pago_guardado_dias >= 0)
);

-- 4. Modalidades de comodato aposentadas (linhas preservadas).
UPDATE planos_ponto SET ativo = false WHERE ativo;
