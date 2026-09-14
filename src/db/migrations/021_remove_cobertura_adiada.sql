-- Remove a máquina de "a cobertura começa depois da cobrança".
--
-- Por quê: o San Checkout cobra no ato da assinatura e a cada `ciclo` a partir
-- dali. Não existe carência, mês grátis, pular ciclo nem desconto na
-- assinatura (API.md do Checkout, seção 7.5 — "O que a assinatura NÃO faz").
-- Tudo que está sendo removido aqui prometia ao assinante um calendário de
-- cobertura diferente do calendário de cobrança, e os dois se afastam até a
-- pessoa estar pagando por tempo que já consumiu. Promessa que o motor de
-- pagamento não cumpre vira cobrança indevida, e cobrança indevida não volta
-- com redeploy.
--
-- Benefício comercial, a partir daqui, se dá no PREÇO (o valor que o nosso
-- GET /plano/{id} devolve ao checkout), nunca no tempo.
--
-- DESTRUTIVA POR AUTORIZAÇÃO EXPLÍCITA DO DONO (14/09/2026). O CONSTRAINTS.md
-- exige permissão nominal para drop, e ela foi dada nesta data. Nada foi a
-- produção e nenhuma base tem linha dessas colunas.
--
-- O que NÃO sai: planos_ponto.plano_bonus_* (módulo 2 — ponto ativo há N meses
-- ganha M meses de anúncio). Ele não cria assinatura nenhuma, então não há
-- calendário de cobrança para dessincronizar: a pessoa recebe cobertura, o
-- prazo acaba, e aí ela assina normalmente e é cobrada no ato.

ALTER TABLE planos DROP COLUMN IF EXISTS meses_gratis;
ALTER TABLE planos DROP COLUMN IF EXISTS minimo_telas_ativas;

ALTER TABLE anunciantes DROP COLUMN IF EXISTS meses_gratis_creditados;
ALTER TABLE anunciantes DROP COLUMN IF EXISTS meses_cobertura_pendentes;

-- 'aguardando_ponto' existia só para a conta que pagou e esperava a rede
-- chegar ao mínimo. Sem mínimo, quem pagou está ativo.
UPDATE anunciantes SET status = 'ativo' WHERE status = 'aguardando_ponto';

ALTER TABLE anunciantes DROP CONSTRAINT IF EXISTS anunciantes_status_check;
ALTER TABLE anunciantes ADD CONSTRAINT anunciantes_status_check
  CHECK (status IN ('pendente_aprovacao', 'aprovado', 'ativo', 'suspenso'));
