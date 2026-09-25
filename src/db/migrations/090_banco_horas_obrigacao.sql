-- Banco de horas como obrigação de veiculação (decisão do dono, 25/09/2026:
-- MANTER). Capacidade contratada que não coube vira saldo; o saldo volta em
-- capacidade OCIOSA de horas futuras; só a exibição CONFIRMADA abate o saldo.
-- Sem expiração automática, sem zerar na virada do mês, nunca crédito em
-- dinheiro.
--
-- vezes_banco: quantas das `vezes_programadas` desta hora vieram do banco
--   (programadas por cima do que a hora vendida já tinha, no tempo que
--   sobrou). A entrega normal da hora é `vezes_programadas - vezes_banco`.
-- banco_liquidado_em: quando a parte do banco desta hora foi abatida do
--   saldo — uma vez só, depois que a janela de prova da hora fechou (60 min
--   + a folga da virada, src/playlist/gerador.js#confirmarExecucao). Enquanto
--   NULL, as `vezes_banco` desta linha ficam reservadas no saldo, pra outra
--   tela não programar a mesma dívida de novo.
ALTER TABLE exibicoes_contador
  ADD COLUMN IF NOT EXISTS vezes_banco integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS banco_liquidado_em timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exibicoes_contador_vezes_banco_check') THEN
    ALTER TABLE exibicoes_contador ADD CONSTRAINT exibicoes_contador_vezes_banco_check
      CHECK (vezes_banco >= 0 AND vezes_banco <= vezes_programadas);
  END IF;
END $$;

-- A liquidação e a reserva só olham linhas com banco ainda não abatido.
CREATE INDEX IF NOT EXISTS exibicoes_contador_banco_pendente_idx
  ON exibicoes_contador (anunciante_id, janela_hora)
  WHERE vezes_banco > 0 AND banco_liquidado_em IS NULL;

-- Registro de cada execução do job de apuração (scripts/apurar-banco-horas.js)
-- — a evidência de que o cron mensal rodou, e do que ele fez. Simulação
-- (--dry-run) não grava aqui: não escreve nada em lugar nenhum.
CREATE TABLE IF NOT EXISTS banco_horas_execucoes (
  id serial PRIMARY KEY,
  comecou_em timestamptz NOT NULL,
  terminou_em timestamptz NOT NULL DEFAULT now(),
  mes_apurado date,
  anunciantes_com_deficit integer NOT NULL DEFAULT 0,
  linhas_novas integer NOT NULL DEFAULT 0,
  linhas_liquidadas integer NOT NULL DEFAULT 0,
  exibicoes_abatidas integer NOT NULL DEFAULT 0,
  abortou text
);
