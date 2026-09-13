-- 1) Idempotência do webhook do San Checkout. Sem isso, o mesmo evento
-- reentregue (retry por timeout, que o próprio contrato torna provável)
-- estendia a cobertura de novo, gravava outra cobrança e pagava a comissão
-- do vendedor duas vezes.
CREATE TABLE webhooks_processados (
  id text PRIMARY KEY,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- 2) Comissão precisa saber se já foi paga — antes não dava pra marcar nada,
-- então o admin não tinha como saber quanto devia a cada vendedor.
ALTER TABLE comissoes ADD COLUMN pago_em timestamptz;

-- 3) Chave do aparelho: já existia a coluna aparelho_id (migration 001), mas
-- nada a usava. Agora é o que autentica a TV nas rotas /playlist e /player —
-- sem ela qualquer um da internet inflava as exibições que o anunciante paga.
CREATE INDEX IF NOT EXISTS idx_pontos_aparelho ON pontos (aparelho_id);
