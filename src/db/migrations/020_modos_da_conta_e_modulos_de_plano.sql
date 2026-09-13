-- v2.1 — painel único com três modos e módulos cruzados de plano.
-- Tudo aditivo.

-- ---------------------------------------------------------------------------
-- 1) Candidatura feita de dentro da conta (modo bloqueado do painel): o dono
--    libera o papel direto na conta, sem convite. `origem` distingue o
--    formulário público, o pedido de dentro do painel e o bônus de plano.
-- ---------------------------------------------------------------------------
ALTER TABLE candidaturas ADD COLUMN conta_id int REFERENCES anunciantes(id);
ALTER TABLE candidaturas ADD COLUMN origem text NOT NULL DEFAULT 'site'
  CHECK (origem IN ('site', 'painel', 'bonus_plano'));
ALTER TABLE candidaturas ADD COLUMN chave_pix text;
ALTER TABLE candidaturas ADD COLUMN plano_ponto_id text REFERENCES planos_ponto(id);
CREATE INDEX idx_candidaturas_conta ON candidaturas (conta_id) WHERE conta_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Módulo do plano de anunciante: "ao completar N meses de cobertura,
--    ganha direito a uma tela no seu comércio". NULL = plano sem o módulo.
--    O resgate vira uma candidatura de ponto (origem bonus_plano) e fica
--    marcado na conta pra não repetir.
-- ---------------------------------------------------------------------------
ALTER TABLE planos ADD COLUMN ponto_apos_meses int CHECK (ponto_apos_meses > 0);
ALTER TABLE anunciantes ADD COLUMN ponto_bonus_resgatado_em timestamptz;

-- ---------------------------------------------------------------------------
-- 3) Módulo da opção de comodato: "ponto ativo há N meses ganha M meses do
--    plano X sem pagar". NULL = opção sem o módulo. O resgate ativa o plano
--    na própria conta do dono (papel anunciante entra junto).
-- ---------------------------------------------------------------------------
ALTER TABLE planos_ponto ADD COLUMN plano_bonus_id text REFERENCES planos(id);
ALTER TABLE planos_ponto ADD COLUMN plano_bonus_apos_meses int CHECK (plano_bonus_apos_meses > 0);
ALTER TABLE planos_ponto ADD COLUMN plano_bonus_meses int CHECK (plano_bonus_meses > 0);
ALTER TABLE anunciantes ADD COLUMN anuncio_bonus_resgatado_em timestamptz;

-- Vendedor liberado de dentro do painel pode entrar sem chave Pix — o painel
-- de vendas pede antes de a primeira comissão ser paga.
ALTER TABLE vendedores ALTER COLUMN chave_pix DROP NOT NULL;
