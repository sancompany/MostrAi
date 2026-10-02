-- SESSÕES OPERACIONAIS DO PLAYER (02/10/2026, Ponto Móvel / "conectividade
-- não é operação").
--
-- Heartbeat responde "consigo falar com a tela AGORA?"; não responde "a tela
-- operou?". Uma tela de ponto móvel passa dias sem internet exibindo a
-- programação guardada — o servidor só fica sabendo depois. Cada sessão aqui
-- é um FATO medido pela própria TV: de quando o ciclo de exibição começou até
-- quando parou (ou até o último checkpoint, se ainda está aberta), com
-- duração pelo relógio MONOTÔNICO do aparelho (uptime — não anda para trás
-- nem pula com o relógio de parede) e, quando a TV já tinha falado com o
-- servidor naquele boot, os instantes ancorados no relógio do servidor.
--
-- O Player registra fatos; o backend decide o que valem. Esta tabela NÃO
-- alimenta cobrança, saldo, benefício nem obrigação — é evidência técnica
-- para o Admin ("a tela operou offline das 10 h às 18 h") e reconstrução do
-- estado operacional depois que a comunicação volta.
--
-- Idempotente por (dispositivo_id, sessao_id): o Player reenvia a mesma
-- sessão (aberta, a cada checkpoint; fechada, até o ACK). O upsert SÓ
-- ESTENDE — duração nunca diminui, sessão encerrada nunca reabre, e outro
-- boot nunca sobrescreve (src/player/operacao.js).
--
-- ADITIVA: uma tabela nova, nada existente muda.

CREATE TABLE sessoes_operacionais (
  dispositivo_id integer NOT NULL REFERENCES dispositivos(id) ON DELETE CASCADE,
  sessao_id text NOT NULL,
  boot_count integer,
  inicio_uptime_ms bigint NOT NULL,
  fim_uptime_ms bigint NOT NULL,
  duracao_ms bigint NOT NULL,
  -- Relógio de parede da TV: informativo. Sem RTC, volta do reboot errado.
  inicio_parede_em timestamptz NOT NULL,
  fim_parede_em timestamptz NOT NULL,
  -- Relógio do servidor projetado pela TV (âncora + monotônico): NULL quando
  -- a sessão começou num boot sem nenhum contato com o servidor.
  inicio_servidor_em timestamptz,
  fim_servidor_em timestamptz,
  encerrada boolean NOT NULL DEFAULT false,
  motivo text,
  recebida_em timestamptz NOT NULL DEFAULT now(),
  atualizada_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (dispositivo_id, sessao_id),
  CONSTRAINT sessoes_operacionais_duracao_check CHECK (duracao_ms >= 0 AND fim_uptime_ms >= inicio_uptime_ms)
);

-- "Última operação conhecida" e "operação sincronizada depois" da ficha da
-- tela no Admin.
CREATE INDEX sessoes_operacionais_recentes ON sessoes_operacionais (dispositivo_id, atualizada_em DESC);

-- Fecha a API REST automática do Supabase para a chave `anon`
-- (docs/erros/2026-09-26-tabelas-novas-sem-rls.md; guarda em tests/rls.test.js).
ALTER TABLE sessoes_operacionais ENABLE ROW LEVEL SECURITY;
