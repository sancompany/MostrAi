-- TICK — alertas da saúde (B13 do plano de lançamento, 16/11/2026).
--
-- Um aviso por problema, não um por volta: cada sinal crítico aberto vira uma
-- linha. O e-mail sai quando o problema aparece, um lembrete a cada 6 h
-- enquanto ele continua, e um "resolvido" quando some. Duas origens:
--   'vigia:<sinal>'     — a conferência que roda dentro do serviço;
--   'sentinela:<alvo>'  — a tarefa agendada do Northflank, que olha de fora
--                         (o site caiu, a página de saúde respondeu erro).
-- Sem dado pessoal: só a chave do sinal e o texto do aviso (contagens e
-- códigos curtos de pedido).
--
-- Só acréscimo; nada existente muda.
--
-- Reversão (só antes de existir dado):
--   DROP TABLE saude_alertas;

CREATE TABLE saude_alertas (
  chave text PRIMARY KEY CHECK (chave ~ '^(vigia|sentinela):[a-z0-9_]{1,60}$'),
  texto text NOT NULL CHECK (char_length(texto) BETWEEN 1 AND 500),
  aberto_em timestamptz NOT NULL DEFAULT now(),
  -- NULL = ainda não avisado (ou o envio falhou e a próxima volta tenta de novo).
  avisado_em timestamptz,
  avisos integer NOT NULL DEFAULT 0 CHECK (avisos >= 0),
  resolvido_em timestamptz
);
CREATE INDEX ix_saude_alertas_abertos ON saude_alertas (chave) WHERE resolvido_em IS NULL;

ALTER TABLE saude_alertas ENABLE ROW LEVEL SECURITY;
