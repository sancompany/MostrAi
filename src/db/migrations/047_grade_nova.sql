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
-- ---------------------------------------------------------------------------
-- COMO ESTA MIGRATION TRATA QUEM JÁ PAGOU (RN-27) — e por que ela foi
-- reescrita em 17/09/2026, depois de falhar em produção.
-- ---------------------------------------------------------------------------
-- A primeira versão desta migration ABORTAVA se encontrasse plano ativo com
-- cobrança confirmada. Ela abortou mesmo: produção tinha (e tem) uma cobrança
-- confirmada em `essencial-3m`. A trava acertou em não reescrever o preço de
-- um plano assinado — e errou no que fez depois, porque PARAR NÃO É RESPOSTA:
-- a 045 e a 046 já tinham passado, o container novo morria aqui, e produção
-- ficou com SCHEMA NOVO e CÓDIGO VELHO. O lado do anunciante inteiro caiu
-- (`CAMPOS_PUBLICOS` ainda nomeava `valor_mensal_travado` e
-- `ponto_bonus_resgatado_em`, que a 046 tinha dropado), e o site público
-- continuou no ar disfarçando o estrago.
--
-- A lição, que vale pra toda migration deste projeto: uma trava que aborta no
-- meio de uma sequência só é segura se as anteriores forem reversíveis. Aqui
-- não eram — a 046 dropa coluna. Trava tem que saber o que fazer, não só
-- quando gritar.
--
-- A resposta certa pra "este plano tem assinante" já estava escrita na RN-27,
-- e é o que esta versão faz: NÃO edita o plano assinado. Publica uma VERSÃO
-- NOVA com os números novos, aposenta a antiga apontando `substituido_por`, e
-- quem já assinou continua na antiga — mesmo preço, mesma cota, mesmos
-- benefícios, até o fim do que contratou. Plano ativo SEM cobrança nenhuma é
-- atualizado no lugar, que é o barato e não machuca ninguém.
--
-- Isso vale pra sempre, não só pra hoje: rode esta migration numa base com
-- dez assinantes e ela versiona os dez planos deles, sem perguntar nada.

-- ---------------------------------------------------------------------------
-- 0. Os números da grade, num lugar só
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE _grade ON COMMIT DROP AS
SELECT * FROM (VALUES
  ('essencial',  90,  3, 15, 1,  99::numeric),
  ('destaque',  120,  7, 20, 2, 249::numeric),
  ('maximo',    180, 10, 30, 3, 449::numeric)
) AS g(tier, segundos, pontos, duracao, criativos, cheio);

-- Quem tem cobrança confirmada não pode ser editado: vira versão nova. O id
-- segue a mesma convenção do `proximoId` do repositório (base + `-vN`), pra
-- que o admin e a migration não inventem padrões diferentes.
CREATE TEMP TABLE _versionar ON COMMIT DROP AS
SELECT p.id AS antigo,
       regexp_replace(p.id, '-v[0-9]+$', '') || '-v' || (
         (SELECT COALESCE(MAX(COALESCE(substring(v.id from '-v([0-9]+)$')::int, 1)), 1)
            FROM planos v
           WHERE v.id = regexp_replace(p.id, '-v[0-9]+$', '')
              OR v.id LIKE regexp_replace(p.id, '-v[0-9]+$', '') || '-v%'
         ) + 1
       )::text AS novo
  FROM planos p
 WHERE p.ativo
   AND p.tier IN ('essencial', 'destaque', 'maximo')
   AND EXISTS (SELECT 1 FROM cobrancas_confirmadas c WHERE c.plano_id = p.id);

-- ---------------------------------------------------------------------------
-- 1. Planos ASSINADOS: versão nova com os números novos, antiga aposentada
-- ---------------------------------------------------------------------------
INSERT INTO planos (
  id, tier, nome, valor_mensal, valor_mensal_cheio, compromisso_meses,
  frequencia_hora, cobertura, ativo, destaque_no_site, rotulo, limite_criativos,
  fundador, vagas, desconto_comodato_percentual, desconto_percentual,
  segundos_por_hora, duracao_maxima_segundos, pontos_incluidos
)
SELECT v.novo, p.tier, p.nome,
       round(g.cheio * (1 - COALESCE(d.pct, 0) / 100.0), 2),
       g.cheio, p.compromisso_meses,
       p.frequencia_hora, 'todos_pontos', true, p.destaque_no_site, NULL, g.criativos,
       p.fundador, p.vagas, p.desconto_comodato_percentual, d.pct,
       g.segundos, g.duracao, g.pontos
  FROM _versionar v
  JOIN planos p ON p.id = v.antigo
  JOIN _grade g ON g.tier = p.tier
  CROSS JOIN LATERAL (SELECT CASE p.compromisso_meses
    WHEN 1 THEN NULL WHEN 3 THEN 10 WHEN 6 THEN 15 WHEN 12 THEN 20 ELSE NULL END::numeric AS pct) d;

UPDATE planos p
   SET ativo = false, arquivado_em = now(), substituido_por = v.novo
  FROM _versionar v
 WHERE p.id = v.antigo;

-- ---------------------------------------------------------------------------
-- 2. Planos SEM assinante: atualiza no lugar
-- ---------------------------------------------------------------------------
UPDATE planos p
   SET segundos_por_hora = g.segundos,
       pontos_incluidos = g.pontos,
       duracao_maxima_segundos = g.duracao,
       limite_criativos = g.criativos,
       valor_mensal_cheio = g.cheio,
       desconto_percentual = CASE p.compromisso_meses
         WHEN 1 THEN NULL WHEN 3 THEN 10 WHEN 6 THEN 15 WHEN 12 THEN 20 ELSE NULL END,
       -- `cobertura` guardava a intenção e o gerador ignorava (era 100% pra
       -- todo mundo). Agora quem manda é `pontos_incluidos`, e a coluna antiga
       -- fica coerente em vez de mentir.
       cobertura = 'todos_pontos'
  FROM _grade g
 WHERE g.tier = p.tier
   AND p.ativo
   AND p.id NOT IN (SELECT novo FROM _versionar);

UPDATE planos SET valor_mensal =
  round(valor_mensal_cheio * (1 - COALESCE(desconto_percentual, 0) / 100.0), 2)
  WHERE ativo AND valor_mensal_cheio IS NOT NULL;

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
--
-- O DELETE é só dos planos ATIVOS. Plano arquivado guarda os benefícios que
-- tinha quando foi assinado — é o contrato de quem ficou nele, e apagar isso
-- deixaria o painel do assinante sem as linhas que ele comprou.
DELETE FROM planos_beneficios WHERE plano_id IN (SELECT id FROM planos WHERE ativo);

INSERT INTO beneficios (texto) VALUES
  ('Painel com cada exibição confirmada, ponto a ponto'),
  ('Comprovante em planilha pra baixar quando quiser'),
  ('Peça simples incluída: se você não tem arte, a gente faz'),
  ('Atendimento prioritário no WhatsApp'),
  ('Sua peça entra na frente na fila de aprovação')
ON CONFLICT DO NOTHING;

INSERT INTO planos_beneficios (plano_id, beneficio_id)
SELECT p.id, b.id
  FROM planos p
  CROSS JOIN LATERAL (VALUES
    ('Painel com cada exibição confirmada, ponto a ponto'),
    ('Comprovante em planilha pra baixar quando quiser'),
    ('Peça simples incluída: se você não tem arte, a gente faz')
  ) AS x(texto)
  JOIN beneficios b ON b.texto = x.texto
 WHERE p.ativo AND p.tier = 'essencial'
ON CONFLICT DO NOTHING;

INSERT INTO planos_beneficios (plano_id, beneficio_id)
SELECT p.id, b.id
  FROM planos p
  CROSS JOIN LATERAL (VALUES
    ('Tudo do Essencial'),
    ('Atendimento prioritário no WhatsApp'),
    ('Sua peça entra na frente na fila de aprovação')
  ) AS x(texto)
  JOIN beneficios b ON b.texto = x.texto
 WHERE p.ativo AND p.tier = 'destaque'
ON CONFLICT DO NOTHING;

INSERT INTO planos_beneficios (plano_id, beneficio_id)
SELECT p.id, b.id
  FROM planos p
  CROSS JOIN LATERAL (VALUES ('Tudo do Destaque')) AS x(texto)
  JOIN beneficios b ON b.texto = x.texto
 WHERE p.ativo AND p.tier = 'maximo'
ON CONFLICT DO NOTHING;
