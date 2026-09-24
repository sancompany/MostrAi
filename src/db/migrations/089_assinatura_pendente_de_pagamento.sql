-- Consolidação final (24/09/2026) — integração com o San Checkout.
--
-- A assinatura nascia 'ativa' no instante em que o link de pagamento era
-- gerado, antes de qualquer cobrança: um clique em "Assinar" abandonado no
-- checkout já contava como assinatura ativa (bloqueava um segundo "Assinar",
-- entrava na conciliação diária e no "Cancelar assinatura" como se a Asaas
-- tivesse algo a cancelar). Agora ela nasce 'pendente_pagamento' e só vira
-- 'ativa' quando o backend recebe o primeiro ciclo pago (webhook `criada` ou
-- conciliação) — o entitlement nunca depende de o navegador voltar do
-- Checkout. Linhas já 'ativa' não são tocadas.
ALTER TABLE assinaturas DROP CONSTRAINT IF EXISTS assinaturas_status_check;
ALTER TABLE assinaturas ADD CONSTRAINT assinaturas_status_check
  CHECK (status IN ('pendente_pagamento', 'ativa', 'cancelada', 'pendente_troca', 'trocada'));
