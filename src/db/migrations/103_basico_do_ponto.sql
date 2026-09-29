-- Plano Básico como BENEFÍCIO DO PONTO (28/09/2026, decisão do dono — ADR-025
-- em .ia/DECISIONS.md; substitui a parte "ser ponto não é plano" do ADR-016).
--
-- Todo estabelecimento que vira ponto ativo recebe, sem custo e enquanto
-- continuar ponto: 14 h/mês de veiculação, peça de até 15 s, 1 criativo no
-- ar, e o único ponto é O PRÓPRIO estabelecimento. Continua recebendo também
-- o +1 crédito/mês (migration 082) — são benefícios separados.
--
-- NÃO É PLANO COMERCIAL: não mora em `anunciantes.plano_id`, não passa pelo
-- Checkout, não aparece na vitrine, não é consumido por crédito. Soma-se ao
-- plano comercial (Essencial/Pro/Prime) que a conta tiver, com a ORIGEM de
-- cada obrigação preservada: uma linha por ponto aqui, e a parcela do Básico
-- de cada hora separada em `exibicoes_contador.segundos_obrigacao_basico`.
--
-- Os números ficam COPIADOS na linha (e não só em constante): mudar a regra
-- amanhã não reescreve o que um benefício já concedido prometeu.
--
-- Nada dos planos legados é reaproveitado: `comodato-basico` (45 s/h em 3
-- pontos, migration 049) e `inicial-1m` continuam inativos, como histórico.

-- ON DELETE CASCADE: ponto e conta não se apagam em produção (ponto é
-- arquivado, conta é excluída logicamente e anonimizada) — o CASCADE só
-- existe pra limpeza física de dado de teste não travar na linha do Básico.
CREATE TABLE IF NOT EXISTS beneficios_basico_ponto (
  id serial PRIMARY KEY,
  ponto_id integer NOT NULL REFERENCES pontos(id) ON DELETE CASCADE,
  conta_id integer NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  segundos_por_hora integer NOT NULL CHECK (segundos_por_hora > 0),
  horas_por_mes integer NOT NULL CHECK (horas_por_mes > 0),
  duracao_maxima_segundos integer NOT NULL CHECK (duracao_maxima_segundos > 0),
  limite_criativos integer NOT NULL CHECK (limite_criativos > 0),
  inicio timestamptz NOT NULL DEFAULT now(),
  fim timestamptz,
  motivo_fim text CHECK (motivo_fim IS NULL OR motivo_fim IN (
    'ponto_arquivado', 'dono_mudou', 'conta_excluida', 'conta_interna'
  )),
  CHECK ((fim IS NULL) = (motivo_fim IS NULL)),
  CHECK (fim IS NULL OR fim >= inicio)
);

-- Um Básico ATIVO por ponto, garantido pelo banco: rodar a sincronização de
-- novo (job diário, duas instâncias, provisionamento repetido) nunca duplica.
CREATE UNIQUE INDEX IF NOT EXISTS idx_beneficios_basico_ponto_ativo
  ON beneficios_basico_ponto (ponto_id) WHERE fim IS NULL;
CREATE INDEX IF NOT EXISTS idx_beneficios_basico_ponto_conta ON beneficios_basico_ponto (conta_id);

ALTER TABLE beneficios_basico_ponto ENABLE ROW LEVEL SECURITY;

-- A parcela do Básico dentro da obrigação da hora (segundos_obrigacao, que
-- continua sendo o TOTAL — é o que o Saldo lê). NULL/0 = hora sem Básico.
ALTER TABLE exibicoes_contador ADD COLUMN IF NOT EXISTS segundos_obrigacao_basico integer;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'exibicoes_contador_basico_check') THEN
    ALTER TABLE exibicoes_contador ADD CONSTRAINT exibicoes_contador_basico_check CHECK (
      segundos_obrigacao_basico IS NULL
      OR (segundos_obrigacao_basico >= 0
          AND (segundos_obrigacao IS NULL OR segundos_obrigacao_basico <= segundos_obrigacao))
    );
  END IF;
END $$;

-- Pontos que JÁ são ativos hoje (a mesma régua do crédito mensal,
-- src/creditos/ponto.js#SQL_PONTOS_ELEGIVEIS) recebem o Básico a partir de
-- AGORA — sem obrigação retroativa, sem cobrança, sem assinatura.
INSERT INTO beneficios_basico_ponto (ponto_id, conta_id, segundos_por_hora, horas_por_mes,
                                     duracao_maxima_segundos, limite_criativos)
SELECT p.id, p.anunciante_id, 140, 14, 15, 1
  FROM pontos p
  JOIN anunciantes a ON a.id = p.anunciante_id
 WHERE p.status <> 'arquivado'
   AND a.excluido_em IS NULL
   AND NOT a.conta_propria
   AND EXISTS (SELECT 1 FROM dispositivos d
                WHERE d.ponto_id = p.id AND d.status = 'ativo' AND d.chave_hash IS NOT NULL)
ON CONFLICT (ponto_id) WHERE fim IS NULL DO NOTHING;
