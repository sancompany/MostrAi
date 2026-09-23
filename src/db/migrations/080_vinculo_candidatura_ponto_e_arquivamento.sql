-- Vínculo candidatura → ponto, e arquivamento auditável de ponto duplicado
-- (23/09/2026, auditoria forense do painel pedida pelo dono).
--
-- O BUG: o mesmo estabelecimento aparecia duas vezes em "Onde seu anúncio
-- aparece" — "Bruno H Sanches" em produção era DUAS linhas em `pontos` (ids 1
-- e 2), mesmo nome, mesmo endereço, mesmo CEP, criadas com 3 dias de
-- diferença. A causa era estrutural:
--   · `pontos` não sabia de qual candidatura tinha nascido — nenhuma coluna
--     ligava os dois mundos, então nada impedia uma candidatura já
--     materializada de gerar um segundo ponto;
--   · a guarda de duplicidade (src/pontos/routes.js) só consultava
--     candidaturas EM ABERTO — depois que a primeira virava 'aprovada', o
--     mesmo endereço passava livre.
--
-- O QUE NÃO SE FAZ AQUI, DE PROPÓSITO: um UNIQUE por endereço/CEP. Dois
-- comércios diferentes podem existir legitimamente no mesmo endereço (sala
-- comercial, galeria, box de mercado). A identidade de um ponto é a
-- candidatura que o originou — é isso que vira UNIQUE, e só onde existe.

-- 1. De qual candidatura o ponto nasceu. Nullable: pontos anteriores a esta
--    migration nem sempre têm candidatura rastreável (a candidatura sem conta
--    foi aposentada em 18/09/2026, G.9, e as candidaturas antigas não estão
--    mais na tabela). UNIQUE parcial: uma candidatura materializa NO MÁXIMO
--    um ponto — é a trava de banco contra corrida e contra reaprovação.
ALTER TABLE pontos ADD COLUMN IF NOT EXISTS candidatura_id integer REFERENCES candidaturas(id);
CREATE UNIQUE INDEX IF NOT EXISTS pontos_candidatura_unica
  ON pontos (candidatura_id) WHERE candidatura_id IS NOT NULL;

-- 2. Arquivamento auditável. Não apaga (histórico preservado), não é
--    "inativo" (inativo é um ponto real sem tela funcionando — outra coisa).
--    `arquivado` é um estado próprio, que o status automático NUNCA
--    sobrescreve (ver sincronizarStatusPonto), e que toda listagem da
--    experiência normal já exclui por filtrar status explicitamente.
--    `mesclado_em_ponto_id` diz PARA ONDE ele foi — o registro canônico.
ALTER TABLE pontos ADD COLUMN IF NOT EXISTS arquivado_em timestamptz;
ALTER TABLE pontos ADD COLUMN IF NOT EXISTS motivo_arquivamento text;
ALTER TABLE pontos ADD COLUMN IF NOT EXISTS mesclado_em_ponto_id integer REFERENCES pontos(id);

ALTER TABLE pontos DROP CONSTRAINT IF EXISTS pontos_status_check;
ALTER TABLE pontos ADD CONSTRAINT pontos_status_check
  CHECK (status IN ('a_instalar', 'em_operacao', 'em_reparo', 'inativo', 'arquivado'));

-- Coerência: arquivado ⇔ tem data e motivo; nunca mesclado em si mesmo.
ALTER TABLE pontos DROP CONSTRAINT IF EXISTS pontos_arquivamento_coerente;
ALTER TABLE pontos ADD CONSTRAINT pontos_arquivamento_coerente CHECK (
  (status = 'arquivado') = (arquivado_em IS NOT NULL)
  AND (arquivado_em IS NULL OR motivo_arquivamento IS NOT NULL)
  AND (mesclado_em_ponto_id IS NULL OR (mesclado_em_ponto_id <> id AND arquivado_em IS NOT NULL))
);

-- 3. Backfill do vínculo onde ele existe DE FATO: candidatura aprovada da
--    conta X, cujo ponto foi criado a partir dela — mesma conta dona, mesmo
--    nome de comércio, mesmo endereço, criado depois da candidatura. Só
--    vincula quando o casamento é único dos dois lados; ambíguo fica NULL
--    (melhor sem vínculo do que com vínculo errado).
WITH pares AS (
  SELECT c.id AS candidatura_id, p.id AS ponto_id
    FROM candidaturas c
    JOIN pontos p
      ON p.anunciante_id = c.conta_id
     AND lower(trim(p.nome)) = lower(trim(c.nome_comercio))
     AND lower(trim(p.endereco)) = lower(trim(c.endereco))
     AND p.created_at >= c.criado_em
   WHERE c.tipo = 'ponto' AND c.status = 'aprovada' AND p.candidatura_id IS NULL
),
unicos AS (
  SELECT candidatura_id, ponto_id FROM pares
   WHERE candidatura_id IN (SELECT candidatura_id FROM pares GROUP BY 1 HAVING count(*) = 1)
     AND ponto_id IN (SELECT ponto_id FROM pares GROUP BY 1 HAVING count(*) = 1)
)
UPDATE pontos p SET candidatura_id = u.candidatura_id FROM unicos u WHERE p.id = u.ponto_id;

-- 4. Arquivar duplicatas JÁ EXISTENTES, mesclando no registro canônico.
--    Critério deliberadamente estreito — só arquiva quando é inequivocamente
--    o mesmo estabelecimento E o duplicado não carrega nada:
--      · mesmo dono (inclusive os dois sem dono), mesmo nome, mesmo
--        endereço e mesmo CEP — nome diferente no mesmo endereço é outro
--        comércio e fica intocado;
--      · o duplicado é órfão: nenhuma tela, nenhum anunciante escolheu ele,
--        nenhuma mídia própria aponta pra ele, nenhum pagamento de comodato,
--        e não é a materialização de candidatura nenhuma;
--      · o canônico é o mais antigo não-órfão do grupo.
--    Em produção isto pega exatamente o ponto 2 → ponto 1 (conferido na
--    auditoria: ponto 2 com 0 telas, 0 vínculos, 0 pagamentos). Em qualquer
--    outro banco só age se houver duplicata real do mesmo formato.
WITH ident AS (
  SELECT p.id, p.created_at,
         md5(coalesce(p.anunciante_id::text, '-') || '|' || lower(trim(p.nome)) || '|' ||
             lower(trim(p.endereco)) || '|' || trim(coalesce(p.cep, ''))) AS chave,
         (NOT EXISTS (SELECT 1 FROM dispositivos d WHERE d.ponto_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM anunciantes_pontos ap WHERE ap.ponto_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM midias_proprias_pontos mp WHERE mp.ponto_id = p.id)
          AND NOT EXISTS (SELECT 1 FROM pagamentos_ponto pg WHERE pg.ponto_id = p.id)
          AND p.candidatura_id IS NULL) AS orfao
    FROM pontos p
   WHERE p.status <> 'arquivado'
),
canonicos AS (
  SELECT DISTINCT ON (chave) chave, id AS canonico_id
    FROM ident WHERE NOT orfao
   ORDER BY chave, created_at, id
)
UPDATE pontos p
   SET status = 'arquivado',
       arquivado_em = now(),
       mesclado_em_ponto_id = c.canonico_id,
       motivo_arquivamento = 'duplicata do ponto ' || c.canonico_id ||
         ' (mesmo dono, nome, endereço e CEP; sem telas, vínculos, mídias ou pagamentos) — migration 080'
  FROM ident i JOIN canonicos c ON c.chave = i.chave
 WHERE p.id = i.id AND i.orfao AND i.id <> c.canonico_id;
