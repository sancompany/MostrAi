-- Ponto cheio deve parar de aparecer pra ESCOLHA NOVA (RN-42), não só ganhar
-- compensação depois (RN-49) ou cortar na hora (RN-30) — pedido do dono,
-- 18/09/2026 (docs/PENDENCIAS.md, G.7). `escolha_bloqueada_em` é sinal
-- STICKY: entra sozinho quando a ocupação cruza 80%, e só sai por ação do
-- admin (POST /admin/pontos/:id/liberar-escolha) — nunca volta sozinho só
-- porque a ocupação caiu (um anunciante saindo não deve reabrir a vaga sem
-- alguém olhar antes). Quem já escolheu ou já foi alocado ali continua —
-- o bloqueio é só pra escolha NOVA.
ALTER TABLE pontos ADD COLUMN escolha_bloqueada_em timestamptz;
