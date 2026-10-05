-- MOSTRAÍ MÓVEL como opção de seleção do anunciante (05/10/2026, pedido do
-- dono).
--
-- A V1.1 (migration 114) tirou o móvel sem alocação do inventário — certo
-- para a VEICULAÇÃO, mas o produto sumiu do catálogo de escolha. Agora são
-- duas coisas separadas:
--   * CATÁLOGO: "Mostraí Móvel" é UMA opção lógica, sempre disponível, que
--     ocupa UMA posição do plano. Não é ponto, não tem endereço, horário ou
--     categoria — é a preferência "quero a frota móvel ativa".
--   * INVENTÁRIO ATIVO: continua o da 114 — só a unidade alocada, dentro do
--     período e do horário da alocação, recebe comercial. O backend resolve,
--     a cada hora, quais unidades estão ativas (src/lib/pacing.js,
--     `coberturaDoAnunciante`).
--
-- Representação explícita: um instante na conta (NULL = não escolheu), na
-- mesma régua de `anunciantes_pontos.escolhido_em` — a ordem das escolhas
-- decide quem fica se o plano encolher. Nada de ponto fictício nem de
-- `ponto_id` mágico.
--
-- Aditiva. Escolha antiga de um móvel ESPECÍFICO (o modelo da 112/114, em que
-- o anunciante marcava o equipamento) vira a escolha da opção Mostraí Móvel,
-- com o instante mais antigo — o cliente não escolhe equipamento, e a
-- escolha nunca pode apontar para uma unidade que amanhã está em outro lugar.
-- Produção estava com 0 pontos móveis quando esta foi escrita.

ALTER TABLE anunciantes ADD COLUMN IF NOT EXISTS mostrai_movel_escolhido_em timestamptz;
COMMENT ON COLUMN anunciantes.mostrai_movel_escolhido_em IS
  'Escolheu a opção MOSTRAÍ MÓVEL (o pool das unidades móveis alocadas, resolvido a cada hora) em: ocupa 1 posição do plano. NULL = não escolheu.';

UPDATE anunciantes a
   SET mostrai_movel_escolhido_em = m.em
  FROM (SELECT ap.anunciante_id, min(ap.escolhido_em) AS em
          FROM anunciantes_pontos ap JOIN pontos p ON p.id = ap.ponto_id
         WHERE p.tipo = 'movel'
         GROUP BY ap.anunciante_id) m
 WHERE a.id = m.anunciante_id AND a.mostrai_movel_escolhido_em IS NULL;

DELETE FROM anunciantes_pontos ap USING pontos p WHERE p.id = ap.ponto_id AND p.tipo = 'movel';
