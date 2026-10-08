-- 119 — o horário que valia na hora congelada (PA2, docs/PENDENCIAS.md;
-- revisão Codex do PR #124).
--
-- O POP de minuto fechado não credita (src/playlist/gerador.js
-- #confirmarExecucao), mas era julgado pelo horário da tela no instante em
-- que o POP CHEGA: o lote de 60 s ou a fila offline (até 7 dias) que chegam
-- depois de mudar o horário do ponto, ou a alocação da tela móvel, eram
-- julgados pelo horário novo — recusando minuto que estava aberto ou
-- creditando minuto que estava fechado.
--
-- Agora a primeira geração da hora grava o horário em vigor na tela junto da
-- hora congelada, e o POP é julgado por ele. `horario_registrado` separa
-- "sem horário" (null = dia inteiro) de linha gravada antes desta migration
-- (ou pelo contêiner antigo durante o deploy): sem registro, vale o horário
-- de agora, como antes.
ALTER TABLE playlist_hora_congelada
  ADD COLUMN IF NOT EXISTS horario_semanal jsonb,
  ADD COLUMN IF NOT EXISTS horario_registrado boolean NOT NULL DEFAULT false;
