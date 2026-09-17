-- A GRADE NOVA, aprovada pelo dono em 17/09/2026.
-- Racional inteiro em docs/economia-da-rede.md seções 6 a 9.
--
--   plano      | tempo/hora por ponto | pontos | peça até | criativos | mensal
--   -----------|----------------------|--------|----------|-----------|-------
--   Essencial  | 1,5 min (90s)        |      3 |      15s |         1 | R$  99
--   Destaque   | 2 min   (120s)       |      7 |      20s |         2 | R$ 249
--   Máximo     | 3 min   (180s)       |     10 |      30s |         3 | R$ 449
--
-- Os ciclos longos mantêm a escada de desconto que já existia: 0 / 10 / 15 /
-- 20 por cento. O preço cheio é o mensal; `valor_mensal` sai calculado dele.
--
-- POR QUE ATUALIZA NO LUGAR, e não publica versão nova (RN-27). A regra de
-- versionar existe pra proteger QUEM JÁ ASSINOU de ter o contrato mudado sob
-- os pés. Nenhum plano tem assinante pagante hoje. Em vez de confiar nisso,
-- o bloco abaixo CONFERE: se qualquer plano que esta migration toca tiver
-- cobrança confirmada, ela aborta com a lista, e aí a publicação tem mesmo
-- que virar versão nova. Migration que reescreve preço não pode ser
-- otimista.

DO $$
DECLARE
  pagos text;
BEGIN
  SELECT string_agg(DISTINCT plano_id, ', ') INTO pagos
    FROM cobrancas_confirmadas
   WHERE plano_id IN (SELECT id FROM planos WHERE ativo);
  IF pagos IS NOT NULL THEN
    RAISE EXCEPTION 'plano ativo com cobrança confirmada: % — publique versão nova em vez de editar (RN-27)', pagos;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Os números de cada tier
-- ---------------------------------------------------------------------------
UPDATE planos SET segundos_por_hora = 90,  pontos_incluidos = 3,  duracao_maxima_segundos = 15, limite_criativos = 1
  WHERE tier = 'essencial';
UPDATE planos SET segundos_por_hora = 120, pontos_incluidos = 7,  duracao_maxima_segundos = 20, limite_criativos = 2
  WHERE tier = 'destaque';
UPDATE planos SET segundos_por_hora = 180, pontos_incluidos = 10, duracao_maxima_segundos = 30, limite_criativos = 3
  WHERE tier = 'maximo';

-- `cobertura` guardava a intenção e o gerador ignorava (era 100% pra todo
-- mundo). Agora quem manda é `pontos_incluidos`, e a coluna antiga fica
-- coerente em vez de mentir.
UPDATE planos SET cobertura = 'todos_pontos';

-- ---------------------------------------------------------------------------
-- 2. Preço: cheio é o mensal, e o ciclo longo desconta em cima dele
-- ---------------------------------------------------------------------------
UPDATE planos SET valor_mensal_cheio = CASE tier
    WHEN 'essencial' THEN 99 WHEN 'destaque' THEN 249 WHEN 'maximo' THEN 449 END,
  desconto_percentual = CASE compromisso_meses
    WHEN 1 THEN NULL WHEN 3 THEN 10 WHEN 6 THEN 15 WHEN 12 THEN 20 ELSE NULL END
  WHERE tier IN ('essencial', 'destaque', 'maximo');

UPDATE planos SET valor_mensal =
  round(valor_mensal_cheio * (1 - COALESCE(desconto_percentual, 0) / 100.0), 2)
  WHERE valor_mensal_cheio IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Benefícios
-- ---------------------------------------------------------------------------
-- Só os QUALITATIVOS entram aqui. Horas de tela, número de pontos, duração da
-- peça e quantidade de criativos são DERIVADOS dos campos acima e a vitrine
-- calcula na hora — escrever "27 horas" à mão é criar um número que envelhece
-- sozinho no dia em que alguém mexer em `segundos_por_hora`.
--
-- Sai "Prioridade em horário de pico" (id 10): não existe uma linha de código
-- de prioridade de horário em lugar nenhum do gerador, e ela estava no card
-- do Máximo em produção. Saem também as que viram redundância quando as horas
-- aparecem.
DELETE FROM planos_beneficios;

INSERT INTO beneficios (texto) VALUES
  ('Painel com cada exibição confirmada, ponto a ponto'),
  ('Comprovante em planilha pra baixar quando quiser'),
  ('Peça simples incluída: se você não tem arte, a gente faz'),
  ('Atendimento prioritário no WhatsApp'),
  ('Sua peça entra na frente na fila de aprovação'),
  ('Relatório do mês por e-mail, sem abrir o painel')
ON CONFLICT DO NOTHING;

INSERT INTO planos_beneficios (plano_id, beneficio_id)
SELECT p.id, b.id
  FROM planos p
  CROSS JOIN LATERAL (VALUES
    ('Painel com cada exibição confirmada, ponto a ponto', 1),
    ('Comprovante em planilha pra baixar quando quiser', 2),
    ('Peça simples incluída: se você não tem arte, a gente faz', 3)
  ) AS x(texto, ordem)
  JOIN beneficios b ON b.texto = x.texto
 WHERE p.tier = 'essencial';

INSERT INTO planos_beneficios (plano_id, beneficio_id)
SELECT p.id, b.id
  FROM planos p
  CROSS JOIN LATERAL (VALUES
    ('Tudo do Essencial', 1),
    ('Atendimento prioritário no WhatsApp', 2),
    ('Sua peça entra na frente na fila de aprovação', 3)
  ) AS x(texto, ordem)
  JOIN beneficios b ON b.texto = x.texto
 WHERE p.tier = 'destaque';

INSERT INTO planos_beneficios (plano_id, beneficio_id)
SELECT p.id, b.id
  FROM planos p
  CROSS JOIN LATERAL (VALUES
    ('Tudo do Destaque', 1),
    ('Relatório do mês por e-mail, sem abrir o painel', 2)
  ) AS x(texto, ordem)
  JOIN beneficios b ON b.texto = x.texto
 WHERE p.tier = 'maximo';
