-- Adiciona o status 'reparo' pra pontos com equipamento temporariamente fora
-- do ar (defeito/manutenção) sem virar 'inativo' (que é remoção definitiva).
ALTER TABLE pontos DROP CONSTRAINT pontos_status_check;
ALTER TABLE pontos ADD CONSTRAINT pontos_status_check
  CHECK (status IN ('lead', 'aguardando_instalacao', 'ativo', 'reparo', 'inativo'));
