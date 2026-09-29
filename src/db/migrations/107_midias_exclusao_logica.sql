-- Exclusão de mídia própria (estação "Refino operacional da Mídia Mostraí",
-- 29/09/2026). Exclusão LÓGICA: a linha fica, com `situacao = 'excluida'`,
-- porque tudo o que a mídia produziu aponta pra ela —
-- `midias_exibicoes_contador` (exibições confirmadas pela TV, o comprovante)
-- e `midias_proprias_situacoes` (histórico de estado, gravado pelo trigger da
-- 099), as duas com FK ON DELETE CASCADE. Um DELETE físico apagaria o
-- comprovante do que já tocou junto com a mídia.
--
-- Quem toca ou ocupa capacidade já filtra `situacao = 'ativa'`
-- (src/midias/repository.js), então 'excluida' nunca entra na playlist nem
-- na conta de capacidade. A lista do admin deixa as excluídas de fora.
--
-- ADITIVA: só o CHECK das duas tabelas ganha o valor novo. O mesmo desenho
-- estava no PR #91 (pausado, migration 101 de lá), que ao ser retomado fica
-- com esta.
ALTER TABLE midias_proprias DROP CONSTRAINT midias_proprias_situacao_check;
ALTER TABLE midias_proprias
  ADD CONSTRAINT midias_proprias_situacao_check
  CHECK (situacao IN ('ativa', 'pausada', 'encerrada', 'excluida'));

ALTER TABLE midias_proprias_situacoes DROP CONSTRAINT midias_proprias_situacoes_situacao_check;
ALTER TABLE midias_proprias_situacoes
  ADD CONSTRAINT midias_proprias_situacoes_situacao_check
  CHECK (situacao IN ('ativa', 'pausada', 'encerrada', 'excluida'));
