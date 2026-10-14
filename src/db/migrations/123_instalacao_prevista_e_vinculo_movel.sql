-- 123 — Pontos aguardando instalação + Mostraí Móvel provisório + agenda
-- (estação focal de 14/10/2026, ADR-047). ADITIVA: só colunas novas, todas
-- anuláveis e sem default, um índice parcial e CHECKs que toda linha
-- existente já cumpre (as colunas nascem nulas). Nada é apagado, renomeado
-- nem preenchido: produção tem 0 hospedagens e 0 eventos, e linha encerrada
-- ou cancelada de hospedagem é imutável por gatilho (113) — backfill nela
-- seria impossível e nem é preciso.
--
-- A regra "ponto fixo vendável" NÃO vira coluna: é derivada do histórico real
-- das telas (alguma já deu o 1º sinal — dispositivos.primeiro_sinal_em), num
-- predicado único em src/pontos/repository.js (fixoVendavelSql). Aprovar o
-- estabelecimento não é o mesmo que ter inventário no lugar.

-- ---------------------------------------------------------------------------
-- 1. Data prevista da instalação fixa
-- ---------------------------------------------------------------------------
-- Informação do Admin para a logística (agenda do Móvel, ficha do ponto).
-- Nula = "Sem data definida". Não muda status, playlist nem a escolha: o
-- ponto só vira vendável com o 1º sinal de uma tela, nunca por esta data.
ALTER TABLE pontos ADD COLUMN instalacao_prevista_em date;

-- ---------------------------------------------------------------------------
-- 2. A passagem do Móvel sabe em qual ponto fixo está
-- ---------------------------------------------------------------------------
-- Até aqui o local da hospedagem era só texto (local/endereço copiados do
-- ponto ao criar o compromisso). O vínculo permite mostrar a unidade alocada
-- e as passagens na ficha do ponto, a lista "aguardando instalação" da
-- agenda, e o aviso "instalação fixa concluída — encerre a alocação" (nada
-- encerra sozinho). Sem ON DELETE de propósito: apagar um ponto com passagem
-- registrada daria UPDATE numa hospedagem imutável; src/pontos/repository.js
-- (deletar) recusa antes, com 409. O ponto vinculado é sempre FIXO e da conta
-- anfitriã — conferido no app (src/pontos/hospedagem.js), não aqui.
-- `ponto_id` continua sendo a REDE móvel: obrigação, POP e saldo seguem da
-- rede e da conta, nunca do estabelecimento (RN-71b).
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN local_ponto_id integer REFERENCES pontos(id);
CREATE INDEX ix_pontos_moveis_hospedagens_local_ponto
  ON pontos_moveis_hospedagens (local_ponto_id)
  WHERE local_ponto_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Motivo da alocação (os dois contextos do compromisso)
-- ---------------------------------------------------------------------------
-- Só o Admin vê. Nulo nas linhas antigas (a tela mostra "—").
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN motivo_alocacao text
  CONSTRAINT pontos_moveis_hospedagens_motivo_alocacao_check CHECK (
    motivo_alocacao IS NULL
    OR motivo_alocacao IN ('aguardando_instalacao', 'evento', 'ativacao_comercial', 'teste_ponto', 'outro')
  );
ALTER TABLE pontos_moveis_eventos ADD COLUMN motivo_alocacao text
  CONSTRAINT pontos_moveis_eventos_motivo_alocacao_check CHECK (
    motivo_alocacao IS NULL
    OR motivo_alocacao IN ('aguardando_instalacao', 'evento', 'ativacao_comercial', 'teste_ponto', 'outro')
  );

-- ---------------------------------------------------------------------------
-- 4. Cancelamento auditável: por quê e quem
-- ---------------------------------------------------------------------------
-- O cancelamento manual passa a exigir motivo (1 a 300 caracteres, validado
-- no app). O cancelamento automático do job (programado que não começou até o
-- fim previsto) continua sem motivo gravado: já fica marcado
-- encerramento = 'automatico', e o porquê é derivado na leitura. O motivo só
-- existe em linha cancelada. O "quando" já existe (cancelada_em/cancelado_em).
ALTER TABLE pontos_moveis_hospedagens ADD COLUMN motivo_cancelamento text
  CONSTRAINT pontos_moveis_hospedagens_motivo_cancelamento_check CHECK (
    motivo_cancelamento IS NULL
    OR (estado = 'cancelada' AND char_length(motivo_cancelamento) BETWEEN 1 AND 300)
  );
ALTER TABLE pontos_moveis_eventos ADD COLUMN motivo_cancelamento text
  CONSTRAINT pontos_moveis_eventos_motivo_cancelamento_check CHECK (
    motivo_cancelamento IS NULL
    OR (estado = 'cancelado' AND char_length(motivo_cancelamento) BETWEEN 1 AND 300)
  );
-- A hospedagem já guarda quem encerrou (encerrado_por_admin, 113) e passa a
-- guardar ali também quem cancelou. O evento não guardava ninguém: ganha a
-- mesma coluna.
ALTER TABLE pontos_moveis_eventos ADD COLUMN encerrado_por_admin text
  CONSTRAINT pontos_moveis_eventos_encerrado_por_admin_check CHECK (
    encerrado_por_admin IS NULL OR char_length(encerrado_por_admin) <= 200
  );
