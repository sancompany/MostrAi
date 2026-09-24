-- Snapshot comercial de cada ciclo PAGO (24/09/2026, última alteração
-- estrutural da rodada — ADR-018). É daqui que sai o "Custo por exibição
-- prevista" do painel:
--
--   valor efetivamente contratado no ciclo ÷ exibições previstas no ciclo
--
-- Uma linha por ciclo que COMEÇA: compra (primeiro ciclo de uma
-- assinatura), renovação (cada ciclo seguinte) e troca de plano (o ciclo do
-- plano novo). Nunca é recalculada: preço mudado no admin depois, promoção
-- encerrada, plano com outra duração de peça — nada disso reescreve um ciclo
-- que já foi contratado. Só a próxima compra/troca/renovação grava outro.
--
-- Por que tabela nova e não colunas em `cobrancas_confirmadas`: na troca de
-- plano a cobrança registra o ACERTO proporcional (`plano_anterior_id`
-- preenchido), não o valor do ciclo contratado; e o valor de uma renovação
-- pode mudar (promoção vence no meio da assinatura). A cobrança continua
-- sendo o registro do DINHEIRO; esta é a do CONTRATO de cada ciclo. Quando a
-- linha nasce de uma cobrança de ciclo inteiro, as duas se apontam.
--
-- `exibicoes_previstas_mes` é a régua canônica da vitrine (src/lib/
-- pacing.js#exibicoesPorMes sobre horasDeTelaPorMes: segundos por hora ×
-- pontos × 12h × 30 dias ÷ duração máxima da peça do plano) — o mesmo número
-- que GET /planos mostra como "exibições por mês". Ciclo = mês × meses.
-- O custo por exibição não é coluna: é a divisão dessas duas, que nunca
-- mudam depois de gravadas.
CREATE TABLE ciclos_contratados (
  id serial PRIMARY KEY,
  -- CASCADE: o snapshot pertence à cobrança/assinatura/conta que o gerou.
  -- Em produção nada disso é apagado (conta sai por `excluido_em`), mas um
  -- registro de contrato nunca pode segurar a limpeza do que o originou.
  anunciante_id integer NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  plano_id text NOT NULL REFERENCES planos(id),
  assinatura_id text REFERENCES assinaturas(id) ON DELETE CASCADE,
  cobranca_confirmada_id integer REFERENCES cobrancas_confirmadas(id) ON DELETE CASCADE,
  origem text NOT NULL CHECK (origem IN ('compra', 'renovacao', 'troca')),
  ciclo_meses integer NOT NULL CHECK (ciclo_meses IN (1, 3, 6, 12)),
  valor_ciclo numeric(12, 2) NOT NULL CHECK (valor_ciclo >= 0),
  exibicoes_previstas_mes integer NOT NULL CHECK (exibicoes_previstas_mes >= 0),
  exibicoes_previstas_ciclo integer NOT NULL CHECK (exibicoes_previstas_ciclo >= 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  CHECK (exibicoes_previstas_ciclo = exibicoes_previstas_mes * ciclo_meses)
);
CREATE INDEX idx_ciclos_contratados_conta ON ciclos_contratados (anunciante_id, id DESC);
-- Um ciclo por cobrança (o webhook e a conciliação nunca gravam dois).
CREATE UNIQUE INDEX idx_ciclos_contratados_cobranca ON ciclos_contratados (cobranca_confirmada_id)
  WHERE cobranca_confirmada_id IS NOT NULL;
ALTER TABLE ciclos_contratados ENABLE ROW LEVEL SECURITY;

-- Histórico: cada cobrança de CICLO INTEIRO que já existe (plano_anterior_id
-- nulo — o acerto de troca não é um ciclo) vira o snapshot daquele ciclo,
-- com o valor que foi de fato cobrado e as exibições do plano daquela
-- versão (planos são versionados: `essencial-3m` e `essencial-3m-v2` são
-- linhas diferentes, e a de cada cobrança é a que o cliente contratou).
-- Primeira cobrança do plano na conta = compra; as seguintes = renovação.
-- Produção em 24/09/2026: 2 cobranças de ciclo inteiro (contas 3 e 5) e 1
-- acerto de troca (conta 5), que fica de fora — o valor do ciclo novo
-- daquela troca não foi registrado em lugar nenhum, e não se inventa.
INSERT INTO ciclos_contratados (
  anunciante_id, plano_id, cobranca_confirmada_id, origem, ciclo_meses, valor_ciclo,
  exibicoes_previstas_mes, exibicoes_previstas_ciclo, criado_em
)
SELECT c.anunciante_id, c.plano_id, c.id,
       CASE WHEN row_number() OVER (PARTITION BY c.anunciante_id, c.plano_id ORDER BY c.id) = 1
            THEN 'compra' ELSE 'renovacao' END,
       p.compromisso_meses,
       c.valor,
       e.mes,
       e.mes * p.compromisso_meses,
       c.criado_em
  FROM cobrancas_confirmadas c
  JOIN planos p ON p.id = c.plano_id
  CROSS JOIN LATERAL (
    SELECT CASE WHEN coalesce(p.duracao_maxima_segundos, 0) > 0
                THEN floor(round(greatest(coalesce(p.segundos_por_hora, 0), 0) * greatest(coalesce(p.pontos_incluidos, 0), 0) * 12 * 30 / 3600.0)
                           * 3600 / p.duracao_maxima_segundos)::int
                ELSE 0 END AS mes
  ) e
 WHERE c.plano_anterior_id IS NULL
   AND p.compromisso_meses IN (1, 3, 6, 12)
 ORDER BY c.id;
