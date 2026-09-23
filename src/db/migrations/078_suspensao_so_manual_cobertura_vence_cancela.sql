-- Suspensão só acontece pela mão do admin (23/09/2026, decisão do dono, em
-- resposta direta à reconstrução de Contas: "suspensão só ocorre através de
-- mim pelo admin, nunca suspensão automática — o plano é cancelado
-- automaticamente").
--
-- Até aqui, a conciliação diária (`suspenderCoberturaVencida`,
-- src/financeiro/conciliacao.js) marcava `suspenso = true` em qualquer conta
-- cuja `data_expiracao` tivesse passado — pago ou cortesia, sem distinguir.
-- Isso barrava login, painel e tudo o mais (Parte 27 da reconstrução de
-- Contas), pra uma cobertura que simplesmente venceu, sem nenhuma decisão do
-- dono por trás. Agora essa rotina ENCERRA o plano comercial (mesma ação do
-- botão "Cancelar plano" na ficha — `plano-administrativo.js#encerrar`,
-- reaproveitado, não duplicado), e não mexe em `suspenso`. O comodato (campo
-- próprio desde a migration 077) nunca é tocado por isso.
--
-- `cobranca_contestada` (chargeback) CONTINUA suspendendo automaticamente —
-- não é o mesmo caso: é obrigação contratual do San Checkout
-- (INTEGRACAO.md) por dinheiro CONTESTADO no banco do cliente, não por uma
-- cobertura que só venceu. Ver comentário em src/financeiro/san-checkout.js.
-- O direito de arrependimento (src/titular/routes.js) também continua
-- suspendendo — é o próprio titular pedindo a desativação imediata, um
-- direito legal (LGPD/CDC), não um job automático decidindo por ele.
--
-- Aditiva: só amplia o CHECK existente (nenhum valor antigo invalidado) pra
-- aceitar 'vencido' — o motivo de quem a conciliação encerra sozinha, pra
-- distinguir no histórico de quem o admin encerrou a mão ('cancelado').
ALTER TABLE planos_administrativos DROP CONSTRAINT planos_administrativos_encerrado_motivo_check;
ALTER TABLE planos_administrativos ADD CONSTRAINT planos_administrativos_encerrado_motivo_check
  CHECK (encerrado_motivo IS NULL OR encerrado_motivo IN ('substituido', 'cancelado', 'vencido'));
