-- Saldo de Veiculação (estação de 27/09/2026 — o "banco de horas" do
-- cliente passa a ser contado em TEMPO). Mapa, defeitos e invariantes:
-- docs/specs/2026-09-27-saldo-de-veiculacao.md.
--
-- ADITIVA: só colunas novas, nenhuma apagada; as colunas em exibições
-- (`exibicoes_*`) continuam gravadas como equivalentes, pra leitura antiga.
-- Nenhuma tabela nova (RLS da 091 continua cobrindo tudo).
--
-- Por que a duração passa a ser guardada (a 058 dizia que não precisava):
-- o que se vende é tempo de tela, e o saldo em exibições era convertido pela
-- duração ATUAL da peça — trocar a peça de 15 s por uma de 30 s dobrava, em
-- segundos, uma dívida que já estava fechada. Cada hora agora guarda a
-- duração que ela usou; o saldo é em segundos; "exibições equivalentes" é
-- derivado na leitura, com a peça de hoje.

-- ---------------------------------------------------------------------------
-- 1. A hora de cada tela guarda a obrigação e a duração usadas
-- ---------------------------------------------------------------------------
-- segundos_obrigacao: tempo que a conta tinha direito NESTA tela NESTA hora —
--   inserções inteiras de base × pontos do plano ÷ pontos cobertos (RN-49 sem
--   o teto), × minutos abertos ÷ 60, ÷ telas ativas do ponto. Não inclui a
--   reposição da hora anterior (é a mesma dívida, não uma nova). NULL = linha
--   gravada antes desta migration.
-- duracao_segundos: duração média das peças usada na hora (converte
--   exibição em tempo sem depender da peça de hoje).
-- minutos_abertos: quanto da hora o ponto opera (src/lib/operacao-tela.js).
--   Hora fechada (0) não grava linha comercial nenhuma.
-- obrigacao_sem_pedido: linha criada pela apuração para hora ABERTA em que a
--   tela não pediu playlist (sem sinal) — a obrigação existia, a entrega não.
ALTER TABLE exibicoes_contador
  ADD COLUMN IF NOT EXISTS segundos_obrigacao integer,
  ADD COLUMN IF NOT EXISTS duracao_segundos integer,
  ADD COLUMN IF NOT EXISTS minutos_abertos smallint,
  ADD COLUMN IF NOT EXISTS obrigacao_sem_pedido boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exibicoes_contador_saldo_check') THEN
    ALTER TABLE exibicoes_contador ADD CONSTRAINT exibicoes_contador_saldo_check CHECK (
      (segundos_obrigacao IS NULL OR segundos_obrigacao >= 0)
      AND (duracao_segundos IS NULL OR duracao_segundos > 0)
      AND (minutos_abertos IS NULL OR minutos_abertos BETWEEN 0 AND 60)
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. O saldo do mês em segundos
-- ---------------------------------------------------------------------------
-- segundos_obrigacao / segundos_entregues: o que a conta tinha direito no mês
--   e o que a TV CONFIRMOU (entrega normal, na duração de cada hora).
-- segundos_banco: obrigação − entregue, quando positivo — o saldo nascido.
-- segundos_drenados: quanto desse saldo já voltou em exibição confirmada.
-- apurado_em: última (re)apuração. Dentro do prazo do comprovante offline
--   (7 dias + 1 h depois do fim do mês) a apuração se recompõe; depois, não.
ALTER TABLE banco_horas
  ADD COLUMN IF NOT EXISTS segundos_obrigacao bigint,
  ADD COLUMN IF NOT EXISTS segundos_entregues bigint,
  ADD COLUMN IF NOT EXISTS segundos_banco bigint,
  ADD COLUMN IF NOT EXISTS segundos_drenados bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS apurado_em timestamptz;

-- Linhas antigas (produção em 27/09/2026: nenhuma, conferido só-leitura):
-- convertidas pela duração média das peças aprovadas da conta (20 s sem
-- nenhuma) — a mesma estimativa que a tela já fazia.
UPDATE banco_horas b
   SET segundos_banco = b.exibicoes_banco * d.duracao,
       segundos_drenados = b.exibicoes_drenadas * d.duracao,
       segundos_obrigacao = b.exibicoes_pedidas * d.duracao,
       segundos_entregues = b.exibicoes_entregues * d.duracao
  FROM (
    SELECT a.id,
           COALESCE((SELECT ROUND(AVG(c.duracao_segundos))::int FROM criativos c
                      WHERE c.anunciante_id = a.id AND c.status = 'aprovado'), 20) AS duracao
      FROM anunciantes a
  ) d
 WHERE d.id = b.anunciante_id AND b.segundos_banco IS NULL;

ALTER TABLE banco_horas ALTER COLUMN segundos_banco SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'banco_horas_segundos_check') THEN
    ALTER TABLE banco_horas ADD CONSTRAINT banco_horas_segundos_check
      CHECK (segundos_banco >= 0 AND segundos_drenados >= 0 AND segundos_drenados <= segundos_banco);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. Evidência do job em segundos e das horas sem sinal
-- ---------------------------------------------------------------------------
ALTER TABLE banco_horas_execucoes
  ADD COLUMN IF NOT EXISTS segundos_devidos bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS segundos_abatidos bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS horas_sem_pedido integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS linhas_recompostas integer NOT NULL DEFAULT 0;
