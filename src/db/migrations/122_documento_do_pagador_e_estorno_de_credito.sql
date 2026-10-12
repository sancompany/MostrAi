-- 122 — Auditoria técnica, lote 1 (11/10/2026). ADITIVA: coluna nova em
-- `assinaturas`; em `creditos_ledger`, um tipo novo no CHECK (o conjunto só
-- cresce, como na 082), uma coluna nova com índice único e uma regra de
-- coerência que toda linha existente já cumpre. Nada é apagado nem renomeado.

-- ---------------------------------------------------------------------------
-- 1. AUD-006 — o documento com que o pagador assinou no Checkout
-- ---------------------------------------------------------------------------
-- O Checkout identifica a assinatura por `planoId` + `documento` (API.md
-- 4.3.4), e o `documento` é o que o pagador confirmou na tela dele — pode
-- diferir do `anunciantes.cpf_cnpj` (campo editável na tela; cadastro
-- corrigido depois pelo admin). A Mostraí nunca guardava esse valor: cancelar,
-- consultar, trocar e o link de renovação mandavam o cpf_cnpj da conta, o
-- Checkout respondia 404 e a Asaas seguia cobrando. Gravado só com dígitos,
-- pelo evento de ciclo pago que trouxer o campo (`criada`); um ciclo novo com
-- OUTRO documento passa a valer e abre pendência (2ª recorrência do mesmo
-- plano no Checkout). Nulo nas assinaturas antigas, que seguem com o
-- cpf_cnpj da conta (o comportamento de hoje) até o próximo ciclo pago
-- trazer o documento.
ALTER TABLE assinaturas ADD COLUMN documento_pagador text;

-- ---------------------------------------------------------------------------
-- 2. AUD-009 — o crédito de indicação volta quando o pagamento volta no prazo
-- ---------------------------------------------------------------------------
-- O crédito de indicação nasce na transação do ciclo pago (+1 por cobrança,
-- idempotente por `cobranca_confirmada_id`). O estorno TOTAL confirmado pela
-- Asaas desfazia horas e cobertura do indicado, mas o crédito do ponto ficava:
-- benefício pago com dinheiro devolvido. Agora a confirmação de um estorno
-- pedido dentro do prazo de 7 dias grava uma linha negativa
-- `estorno_indicacao` — nunca maior que o saldo do ponto (saldo negativo por
-- indicação não existe, spec R2 §7; os 7 dias são limite assumido pela
-- auditoria até o PG7, CONSTRAINTS.md) —, UMA por cobrança: o índice único em
-- `estorno_de_cobranca_id` é a idempotência (aviso repetido do PSP não
-- reverte duas vezes). `cobranca_confirmada_id` continua sendo só do crédito
-- (o índice único dele é o que impede crédito em dobro).
ALTER TABLE creditos_ledger DROP CONSTRAINT creditos_ledger_tipo_check;
ALTER TABLE creditos_ledger ADD CONSTRAINT creditos_ledger_tipo_check CHECK (tipo IN (
  'indicacao_primeiro_pagamento',
  'indicacao_renovacao',
  'credito_mensal_ponto',
  'concessao_admin',
  'estorno_admin',
  'resgate_beneficio',
  'estorno_resgate',
  'estorno_indicacao'
));
ALTER TABLE creditos_ledger ADD COLUMN estorno_de_cobranca_id integer REFERENCES cobrancas_confirmadas(id);
ALTER TABLE creditos_ledger ADD CONSTRAINT creditos_ledger_estorno_indicacao_coerente CHECK (
  (tipo = 'estorno_indicacao') = (estorno_de_cobranca_id IS NOT NULL)
);
CREATE UNIQUE INDEX idx_creditos_ledger_estorno_de_cobranca
  ON creditos_ledger (estorno_de_cobranca_id) WHERE estorno_de_cobranca_id IS NOT NULL;
