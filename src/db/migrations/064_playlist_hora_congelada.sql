-- A hora de uma tela, uma vez montada, precisa ficar deterministicamente
-- igual em cada poll do player (15 em 15 min) — sem isto, qualquer mudança
-- no meio da hora (ponto escolhido, criativo aprovado, saldo do banco de
-- horas drenando) mudava o TOTAL de participantes que entra em
-- `montarHoraDeTv`, e o embaralhamento/espalhamento (src/lib/pacing.js)
-- reposiciona TODO MUNDO quando o total muda — não só quem chegou depois.
-- O dono pediu o oposto (19/09/2026): quem já tinha vaga mantém a vaga;
-- quem chega no meio da hora entra sempre no FIM.
--
-- `base` congela a entrada exata (por anunciante: frequência, déficit,
-- duração) que gerou a hora na primeira vez — reprocessá-la de novo pelo
-- mesmo `montarHoraDeTv` com a mesma semente reproduz sempre a mesma
-- sequência, sem precisar guardar a sequência pronta. `extras` é a fila,
-- em ordem, de quem chegou depois: cada leva nova é decidida uma vez e
-- nunca mais se mexe, então a próxima leva sempre entra depois dela.
CREATE TABLE playlist_hora_congelada (
  dispositivo_id int NOT NULL REFERENCES dispositivos(id),
  janela_hora timestamptz NOT NULL,
  base jsonb NOT NULL,
  extras jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (dispositivo_id, janela_hora)
);
