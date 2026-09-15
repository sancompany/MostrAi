-- Índices nas chaves estrangeiras que as telas consultam o tempo todo.
--
-- O painel de saúde do Supabase lista 20 FKs sem índice. Não vale criar os 20:
-- metade aponta para tabela de catálogo que nunca passa de algumas dezenas de
-- linhas (planos, beneficios, planos_ponto, categorias), onde o Postgres varre
-- a tabela inteira mais rápido do que usaria o índice — e índice que não serve
-- pra nada ainda custa em toda escrita.
--
-- Estes dez são os que ficam do lado que CRESCE e que aparecem em consulta de
-- tela, não de manutenção:
--   · criativos e cobrancas por anunciante  → painel do anunciante, toda visita
--   · comissoes por vendedor e por anunciante → painel de vendas
--   · pontos por conta                       → "meus pontos"
--   · exibicoes_contador por ponto           → extrato e painel da tela
--   · assinaturas por anunciante             → busca da assinatura ativa, em
--     todo webhook e em toda conciliação
--   · convites e candidaturas                → fila do admin, que é a tela
--     mais usada por quem opera
--
-- Feito com a base ainda vazia de propósito: criar índice em tabela grande
-- trava escrita, e aqui não trava nada.
--
-- ADITIVA.
CREATE INDEX IF NOT EXISTS idx_criativos_anunciante ON criativos (anunciante_id);
CREATE INDEX IF NOT EXISTS idx_cobrancas_anunciante ON cobrancas_confirmadas (anunciante_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_vendedor ON comissoes (vendedor_conta_id);
CREATE INDEX IF NOT EXISTS idx_comissoes_anunciante ON comissoes (anunciante_id);
CREATE INDEX IF NOT EXISTS idx_pontos_anunciante ON pontos (anunciante_id);
CREATE INDEX IF NOT EXISTS idx_exibicoes_ponto ON exibicoes_contador (ponto_id);
CREATE INDEX IF NOT EXISTS idx_assinaturas_anunciante ON assinaturas (anunciante_id);
CREATE INDEX IF NOT EXISTS idx_convites_conta ON convites (conta_id);
CREATE INDEX IF NOT EXISTS idx_convites_candidatura ON convites (candidatura_id);
CREATE INDEX IF NOT EXISTS idx_candidaturas_convite ON candidaturas (convite_id);
