-- Drop autorizado pelo dono em 15/09/2026 ("manda bala") — lista exata de
-- `docs/PENDENCIAS.md`, seção B. Cada um já estava marcado como não-usado
-- desde a migration 019, exceto `exibicoes_contador.ponto_id`: esse ainda
-- era lido em duas rotas do painel do anunciante e escrito a cada geração de
-- playlist — reescritas pra ler/gravar por `dispositivo_id` (que já é
-- NOT NULL e sempre resolve o ponto via `dispositivos.ponto_id`) antes desta
-- migration, senão o drop quebrava produção. `idx_exibicoes_ponto`
-- (migration 032) sai junto, automaticamente, com a coluna.
--
-- Tabela `afiliados` e `afiliados-repository.js`: sem nenhum require no
-- código (as rotas /afiliados/* que respondem 410 nunca dependeram do
-- repository) — dead code puro desde a migration 019.
ALTER TABLE comissoes DROP COLUMN afiliado_id;
DROP TABLE afiliados;

ALTER TABLE pontos DROP COLUMN aparelho_id;
ALTER TABLE pontos DROP COLUMN ultima_vez_online;

ALTER TABLE exibicoes_contador DROP COLUMN ponto_id;
