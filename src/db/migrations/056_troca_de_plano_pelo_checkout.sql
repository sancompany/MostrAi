-- O San Checkout passou a ter POST /trocar-plano (18/09/2026): cobra o
-- acerto proporcional no cartão salvo e altera a MESMA assinatura na Asaas,
-- sem cancelar e sem o assinante digitar cartão de novo.
--
-- Do nosso lado, cada assinatura é uma linha própria (o `id` é o `planoId`
-- que o Checkout usa pra puxar valor/ciclo em GET /plano/:id — migration
-- 011). Trocar de plano precisa de uma linha NOVA representando o destino
-- (é dela que o Checkout lê o preço/ciclo novo antes de cobrar), e só
-- depois de a troca confirmar é que a antiga sai de circulação.
--
-- Dois status novos:
-- 'pendente_troca' — a linha nova, criada ANTES de chamar o Checkout.
--   Existe só pra `GET /plano/:id` poder servir o preço/ciclo de destino;
--   nunca é a assinatura "ativa" do anunciante enquanto está neste status,
--   e uma troca que falhar apaga a linha (nunca fica pendente pra sempre).
-- 'trocada' — a linha antiga, depois que a troca confirma. Diferente de
--   'cancelada': a assinatura de verdade na Asaas continua a MESMA, só
--   mudou de valor/ciclo por baixo da linha nova. 'cancelada' significa
--   que a assinatura na Asaas acabou de verdade.
ALTER TABLE assinaturas DROP CONSTRAINT assinaturas_status_check;
ALTER TABLE assinaturas ADD CONSTRAINT assinaturas_status_check
  CHECK (status IN ('ativa', 'cancelada', 'pendente_troca', 'trocada'));
