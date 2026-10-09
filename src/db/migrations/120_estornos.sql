-- 120 — estorno como ação do Admin, separado do cancelamento (estação
-- "Pagamentos / cancelamento ≠ estorno", 09/10/2026; ADR-046).
--
-- CANCELAR para a recorrência; ESTORNAR devolve o dinheiro de UMA cobrança.
-- Nenhum dos dois dispara o outro. O estorno é pedido no Admin, executado
-- pelo operador no painel da Asaas (o `/estornar` do San Checkout só alcança
-- pedido avulso; cobrança de assinatura não tem `pedido_id`) e CONFIRMADO só
-- pelo webhook `cobranca_estornada`, casado pelo `chargeId`. Nada aqui marca
-- dinheiro como devolvido sem o PSP dizer.

-- 1) A cobrança passa a saber quem ela é no PSP e em que estado o dinheiro
--    está. `pago_em` é a confirmação no PSP (`ocorridoEm` do evento que
--    confirmou); sem ela, o instante em que a Mostraí registrou — e
--    `pago_em_fonte` diz qual foi. É dele que contam os 7 dias do estorno
--    ordinário.
ALTER TABLE cobrancas_confirmadas
  ADD COLUMN IF NOT EXISTS charge_id text,
  ADD COLUMN IF NOT EXISTS pago_em timestamptz,
  ADD COLUMN IF NOT EXISTS pago_em_fonte text NOT NULL DEFAULT 'registro',
  ADD COLUMN IF NOT EXISTS status_financeiro text NOT NULL DEFAULT 'confirmado',
  ADD COLUMN IF NOT EXISTS valor_estornado numeric(12, 2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrancas_pago_em_fonte_check') THEN
    ALTER TABLE cobrancas_confirmadas ADD CONSTRAINT cobrancas_pago_em_fonte_check
      CHECK (pago_em_fonte IN ('psp', 'registro'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrancas_status_financeiro_check') THEN
    ALTER TABLE cobrancas_confirmadas ADD CONSTRAINT cobrancas_status_financeiro_check
      CHECK (status_financeiro IN ('confirmado', 'estornado_parcialmente', 'estornado', 'contestado'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobrancas_valor_estornado_check') THEN
    ALTER TABLE cobrancas_confirmadas ADD CONSTRAINT cobrancas_valor_estornado_check
      CHECK (valor_estornado >= 0 AND valor_estornado <= valor);
  END IF;
END $$;

-- Um chargeId, uma cobrança: é a mesma guarda da dedupe do webhook, agora
-- também no banco.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cobrancas_charge_id ON cobrancas_confirmadas (charge_id)
  WHERE charge_id IS NOT NULL;

-- 2) Backfill pelo SIGNIFICADO (nunca por id): a cobrança existente ganha o
--    chargeId e a confirmação do PSP só quando há exatamente UM webhook
--    assinado (HMAC conferido na entrada) que a descreve — mesma assinatura
--    (pelo ciclo), evento que credita, status confirmado, mesmo valor,
--    recebido no instante em que a cobrança foi gravada — e a chave
--    `chargeId|confirmado` dele está na dedupe. Sem isso, fica sem chargeId
--    (o estorno pelo Admin recusa, dizendo por quê) e `pago_em` = registro.
WITH candidatos AS (
  SELECT cc.id AS cobranca_id,
         w.payload->>'chargeId' AS charge_id,
         w.payload->>'ocorridoEm' AS ocorrido_em
    FROM cobrancas_confirmadas cc
    JOIN ciclos_contratados cic ON cic.cobranca_confirmada_id = cc.id
    JOIN webhooks_recebidos w
      ON w.payload->>'planoId' = cic.assinatura_id
     AND w.status = 'processado'
     AND w.payload->>'evento' IN ('criada', 'cobranca_confirmada')
     AND w.payload->>'statusFinanceiro' = 'confirmado'
     AND w.payload->>'chargeId' ~ '^[A-Za-z0-9_-]{1,100}$'
     -- CASE: o cast só roda no texto que já passou pelo formato (o
     -- planejador não garante a ordem dos ANDs).
     AND CASE WHEN w.payload->>'valor' ~ '^[0-9]+(\.[0-9]+)?$' THEN (w.payload->>'valor')::numeric END = cc.valor
     AND w.payload->>'ocorridoEm' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$'
     AND w.recebido_em BETWEEN cc.criado_em - interval '10 minutes' AND cc.criado_em + interval '1 minute'
    JOIN webhooks_processados wp ON wp.id = (w.payload->>'chargeId') || '|confirmado'
   WHERE cc.charge_id IS NULL
),
-- Único nos DOIS sentidos: uma cobrança com um webhook só, e um chargeId
-- casando uma cobrança só (senão o índice único abortaria a migration).
unicos AS (
  SELECT cobranca_id, min(charge_id) AS charge_id, min(ocorrido_em) AS ocorrido_em
    FROM candidatos
   GROUP BY cobranca_id
  HAVING count(*) = 1
)
UPDATE cobrancas_confirmadas cc
   SET charge_id = u.charge_id,
       pago_em = u.ocorrido_em::timestamptz,
       pago_em_fonte = 'psp'
  FROM unicos u
 WHERE cc.id = u.cobranca_id
   AND (SELECT count(*) FROM unicos u2 WHERE u2.charge_id = u.charge_id) = 1
   AND NOT EXISTS (SELECT 1 FROM cobrancas_confirmadas x WHERE x.charge_id = u.charge_id);

UPDATE cobrancas_confirmadas SET pago_em = criado_em WHERE pago_em IS NULL;
ALTER TABLE cobrancas_confirmadas ALTER COLUMN pago_em SET DEFAULT now();
ALTER TABLE cobrancas_confirmadas ALTER COLUMN pago_em SET NOT NULL;

-- 3) A trilha do estorno: uma linha por pedido de devolução de UMA cobrança.
--    'solicitado' = decidido aqui, aguardando a Asaas; 'confirmado' = o PSP
--    avisou (webhook); 'cancelado' = encerrado sem devolver (o operador não
--    executou, ou desistiu), com quem e por quê. Nunca há 'confirmado' sem
--    o evento do PSP (`psp_evento_id`).
--    tipo: 'ordinario' (Admin, dentro de 7 dias de `pago_em`), 'excepcional'
--    (Admin, sem janela, com categoria), 'desistencia' (pedido pelo cliente
--    no art. 49 — o Admin executa), 'externo' (devolução feita direto na
--    Asaas, sem pedido aqui — só registrada quando o PSP avisa).
CREATE TABLE IF NOT EXISTS estornos (
  id serial PRIMARY KEY,
  cobranca_id integer NOT NULL REFERENCES cobrancas_confirmadas(id),
  anunciante_id integer NOT NULL REFERENCES anunciantes(id),
  tipo text NOT NULL CHECK (tipo IN ('ordinario', 'excepcional', 'desistencia', 'externo')),
  categoria text CHECK (categoria IN ('duplicidade', 'cobranca_indevida', 'erro_operacional', 'obrigacao_legal', 'administrativa')),
  valor numeric(12, 2) NOT NULL CHECK (valor > 0),
  motivo text NOT NULL CHECK (length(btrim(motivo)) > 0),
  status text NOT NULL DEFAULT 'solicitado' CHECK (status IN ('solicitado', 'confirmado', 'cancelado')),
  solicitado_por text,
  solicitado_por_access text,
  solicitado_em timestamptz NOT NULL DEFAULT now(),
  arrependimento_id integer REFERENCES arrependimentos(id),
  status_financeiro_antes text NOT NULL,
  status_financeiro_depois text,
  valor_confirmado numeric(12, 2),
  psp_charge_id text,
  psp_evento_id text,
  confirmado_em timestamptz,
  cancelado_por text,
  cancelado_motivo text,
  cancelado_em timestamptz,
  CHECK (tipo <> 'excepcional' OR categoria IS NOT NULL),
  CHECK (status <> 'confirmado' OR psp_evento_id IS NOT NULL),
  CHECK (status <> 'cancelado' OR (cancelado_motivo IS NOT NULL AND length(btrim(cancelado_motivo)) > 0))
);

-- Um pedido em aberto por cobrança: dois cliques, duas abas ou dois admins
-- nunca viram duas devoluções do mesmo dinheiro.
CREATE UNIQUE INDEX IF NOT EXISTS idx_estornos_um_aberto_por_cobranca ON estornos (cobranca_id)
  WHERE status = 'solicitado';
-- O mesmo aviso do PSP confirma uma linha só.
CREATE UNIQUE INDEX IF NOT EXISTS idx_estornos_evento_psp ON estornos (psp_evento_id)
  WHERE psp_evento_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_estornos_cobranca ON estornos (cobranca_id);
CREATE INDEX IF NOT EXISTS idx_estornos_arrependimento ON estornos (arrependimento_id) WHERE arrependimento_id IS NOT NULL;
ALTER TABLE estornos ENABLE ROW LEVEL SECURITY;
