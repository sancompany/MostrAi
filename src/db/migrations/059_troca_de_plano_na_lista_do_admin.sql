-- A aba "Trocas de plano" do admin (item 17, docs/PENDENCIAS.md) lia só
-- `pedidos_avulsos` — o mecanismo antigo de troca, agora aposentado (ver
-- POST /anunciantes/me/trocar-plano, que usa POST /trocar-plano do
-- Checkout desde 18/09/2026). Sem este campo, uma troca nova ficava
-- indistinguível de uma renovação de ciclo comum em `cobrancas_confirmadas`
-- — a pergunta que a aba existe pra responder ("quem trocou, de qual pra
-- qual, quando") parava de ter resposta pra tudo que acontecesse a partir
-- de agora.
ALTER TABLE cobrancas_confirmadas ADD COLUMN plano_anterior_id text REFERENCES planos(id);
