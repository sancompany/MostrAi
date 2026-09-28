-- Exclusão de mídia própria (estação mestre de finalização, 28/09/2026,
-- Admin → Mídia Mostraí). Exclusão LÓGICA: a linha fica, com
-- `situacao = 'excluida'`, porque tudo o que a mídia produziu aponta pra
-- ela — `midias_exibicoes_contador` (exibições confirmadas pela TV, que são
-- o comprovante), `midias_proprias_situacoes` (histórico de estado, gravado
-- pelo trigger da 099) e a hora congelada da playlist (`midia:N` em
-- `playlist_hora_congelada`). Apagar a linha cascatearia o contador e o
-- histórico (FKs da 099 com ON DELETE CASCADE), e o comprovante do que já
-- tocou sumiria junto. O arquivo no bucket também fica (nada o apaga hoje).
--
-- Quem lê já filtra `situacao = 'ativa'` pra tocar e pra ocupar capacidade
-- (src/midias/repository.js); 'excluida' nunca entra na playlist. A lista
-- do admin devolve as excluídas por último, só pra consulta.
--
-- ADITIVA: só o CHECK das duas tabelas ganha o valor novo.
ALTER TABLE midias_proprias DROP CONSTRAINT midias_proprias_situacao_check;
ALTER TABLE midias_proprias
  ADD CONSTRAINT midias_proprias_situacao_check
  CHECK (situacao IN ('ativa', 'pausada', 'encerrada', 'excluida'));

ALTER TABLE midias_proprias_situacoes DROP CONSTRAINT midias_proprias_situacoes_situacao_check;
ALTER TABLE midias_proprias_situacoes
  ADD CONSTRAINT midias_proprias_situacoes_situacao_check
  CHECK (situacao IN ('ativa', 'pausada', 'encerrada', 'excluida'));
