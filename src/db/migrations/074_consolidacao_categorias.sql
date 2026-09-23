-- Consolidação da taxonomia de categorias (23/09/2026, reconstrução de
-- Contas + Categorias, pedido do dono).
--
-- A migration 067 trocou 25 categorias amplas por ~230 específicas. Revisando
-- as 229 ativas uma a uma, sobraram pares que são O MESMO NEGÓCIO com dois
-- nomes (Açougue × Casa de carnes, Agência de viagens × Agência de turismo,
-- Seguros × Corretora de seguros...) ou concorrentes diretos disputando o
-- mesmo cliente (Hotel × Pousada, Pneus × Alinhamento/Balanceamento, Sementes
-- × Fertilizantes × Defensivos, que qualquer revenda de insumos vende junto).
--
-- Por que isso importa além de "lista mais limpa": categoria é a unidade do
-- bloqueio de concorrente (src/playlist/gerador.js compara só categoria_id).
-- Dois nomes pro mesmo negócio = dois ids = um açougue que escolheu "Casa de
-- carnes" passa na tela de um açougue que escolheu "Açougue". Fundir aqui
-- FECHA esse furo — é o único sentido em que a regra de bloqueio muda: fica
-- mais protetora, nunca menos.
--
-- Critério usado (o resto das 229 fica como está):
--   FUNDE  — sinônimo, ou negócios que o cliente final trata como a mesma
--            compra (quem procura hotel também considera pousada).
--   NÃO FUNDE — genérico × específico (Loja de roupas × Moda feminina,
--            Clínica médica × Oftalmologia): fundir bloquearia gente que não
--            concorre (moda masculina × moda feminina). Esses continuam
--            separados; o grupo organiza.
--
-- COMO FUNDE, SEM APAGAR NADA (CONSTRAINTS.md, "migrations são aditivas"):
--   1. `canonica_id` (coluna nova) aponta da categoria absorvida pra que
--      ficou — o mapeamento fica gravado, não some na migração.
--   2. Contas e pontos que usavam a absorvida passam a apontar pra canônica
--      (é o mesmo negócio — reapontar é o que mantém o bloqueio correto; o
--      contrário deixaria dois concorrentes com ids diferentes).
--   3. A absorvida vira `legado = true, ativo = false` — sai do cadastro e da
--      busca pública, mas a linha continua existindo (FK, histórico, auditoria).
--   4. O nome dela vira alias da canônica: quem digitar "pousada" na busca
--      continua achando — só que acha "Hotel / Pousada".
--
-- As 22 legadas da 067 (amplas demais, tipo "Clínica / consultório") NÃO são
-- reapontadas aqui: continuam sem mapeamento automático, pelo mesmo motivo
-- que a 067 deu — não dá pra saber se "Clínica / consultório" era dentista ou
-- fisioterapeuta, e chutar errado é falso-negativo de concorrência.
--
-- Defensiva de produção: o admin pode ter renomeado/criado categorias pela
-- tela desde a 067. Toda operação aqui é por NOME e vira no-op se a linha
-- não existir; renomear só acontece se o nome novo estiver livre (senão a
-- constraint UNIQUE derrubaria a migration e, com ela, o arranque do
-- contêiner — ver Dockerfile).

ALTER TABLE categorias ADD COLUMN canonica_id int REFERENCES categorias(id) ON DELETE SET NULL;
CREATE INDEX categorias_canonica_id_idx ON categorias (canonica_id);

-- origem (absorvida) → destino (canônica), pelos nomes ATUAIS (antes dos
-- renomes abaixo).
CREATE TEMP TABLE _fusao (origem text PRIMARY KEY, destino text NOT NULL) ON COMMIT DROP;
INSERT INTO _fusao (origem, destino) VALUES
  -- Alimentação
  ('Doceria', 'Confeitaria'),
  ('Casa de carnes', 'Açougue'),
  ('Mercearia', 'Mercado / Supermercado'),
  -- Beleza e estética (as duas já tinham o MESMO alias "estetica")
  ('Estética facial / corporal', 'Clínica de estética'),
  -- Saúde (ortodontista é dentista; consultório odontológico faz aparelho)
  ('Ortodontia', 'Odontologia'),
  -- "Dança" (Fitness) e "Escola de dança" (Educação) — a mesma coisa em dois grupos
  ('Dança', 'Escola de dança'),
  -- Moda
  ('Relojoaria', 'Joalheria'),
  ('Alfaiataria', 'Costura / Ajustes'),
  -- Automotivo
  ('Alinhamento / Balanceamento', 'Pneus'),
  ('Estética automotiva', 'Lava-rápido'),
  -- "Despachante" (Serviços profissionais) e "Despachante veicular" (Automotivo)
  ('Despachante', 'Despachante veicular'),
  -- Casa (móvel planejado é o que a marcenaria faz)
  ('Marcenaria', 'Móveis planejados'),
  -- "Construtora" (Construção) e "Construtora / Incorporadora" (Imobiliário)
  ('Construtora', 'Construtora / Incorporadora'),
  -- Tecnologia (provedor de internet é telecom, e disputa o mesmo plano)
  ('Telecomunicações', 'Internet / Provedor'),
  -- Serviços profissionais
  ('Agência digital', 'Marketing / Publicidade'),
  ('Assessoria empresarial', 'Consultoria empresarial'),
  -- Financeiro
  ('Corretora de seguros', 'Seguros'),
  ('Correspondente bancário', 'Crédito / Empréstimos'),
  -- Imobiliário
  ('Corretor de imóveis', 'Imobiliária'),
  -- Três nomes pra ração (dois no Agro, um no Pet) — a casa de rações vende pros dois
  ('Nutrição animal', 'Ração / Nutrição animal'),
  ('Rações', 'Ração / Nutrição animal'),
  -- Eventos (foto e vídeo de evento é o mesmo contrato)
  ('Filmagem', 'Fotografia'),
  -- Turismo
  ('Pousada', 'Hotel'),
  ('Agência de turismo', 'Agência de viagens'),
  ('Transporte turístico', 'Excursões'),
  -- Serviços pessoais (banner, placa e adesivo: as duas fazem)
  ('Comunicação visual', 'Gráfica'),
  -- Agro ("Insumos agrícolas" já é, literalmente, semente + adubo + defensivo)
  ('Sementes', 'Insumos agrícolas'),
  ('Fertilizantes', 'Insumos agrícolas'),
  ('Defensivos agrícolas', 'Insumos agrícolas'),
  ('Implementos agrícolas', 'Máquinas agrícolas'),
  -- Indústria e B2B
  ('Transportadora', 'Logística');

-- Pares resolvidos pra id (ignora o que não existir mais em produção, e nunca
-- funde uma linha nela mesma).
CREATE TEMP TABLE _fusao_ids ON COMMIT DROP AS
  SELECT o.id AS origem_id, d.id AS destino_id
    FROM _fusao f
    JOIN categorias o ON o.nome = f.origem
    JOIN categorias d ON d.nome = f.destino
   WHERE o.id <> d.id;

-- 2. Reaponta quem usava a absorvida.
UPDATE anunciantes a SET categoria_id = f.destino_id
  FROM _fusao_ids f WHERE a.categoria_id = f.origem_id;
UPDATE pontos p SET categoria_id = f.destino_id
  FROM _fusao_ids f WHERE p.categoria_id = f.origem_id;

-- 1 e 3. Grava o mapeamento e tira do cadastro.
UPDATE categorias c SET canonica_id = f.destino_id, legado = true, ativo = false
  FROM _fusao_ids f WHERE c.id = f.origem_id;

-- 4 + renomes + aliases. `novo_nome` NULL = mantém o nome. Aliases são
-- SOMADOS aos que já existem (nunca substituem — o admin pode ter
-- acrescentado os dele pela tela). Só termos que alguém plausivelmente
-- digitaria no lugar do nome oficial — a mesma régua da 067.
CREATE TEMP TABLE _ajuste (nome text PRIMARY KEY, novo_nome text, aliases text[] NOT NULL) ON COMMIT DROP;
INSERT INTO _ajuste (nome, novo_nome, aliases) VALUES
  -- canônicas que absorveram alguém
  ('Confeitaria', 'Confeitaria / Doceria', ARRAY['doceria', 'doces', 'bolos']),
  ('Açougue', 'Açougue / Casa de carnes', ARRAY['casa de carnes', 'carnes']),
  ('Mercado / Supermercado', NULL, ARRAY['mercearia', 'minimercado']),
  ('Clínica de estética', NULL, ARRAY['estética facial', 'estética corporal', 'esteticista']),
  ('Odontologia', NULL, ARRAY['ortodontia', 'ortodontista', 'aparelho dental']),
  ('Escola de dança', NULL, ARRAY['dança', 'ballet', 'balé']),
  ('Joalheria', 'Joalheria / Relojoaria', ARRAY['relojoaria', 'relógios', 'joias']),
  ('Costura / Ajustes', NULL, ARRAY['alfaiataria', 'alfaiate', 'costureira', 'conserto de roupas']),
  ('Pneus', 'Pneus / Alinhamento', ARRAY['alinhamento e balanceamento', 'balanceamento', 'borracharia']),
  ('Lava-rápido', 'Lava-rápido / Estética automotiva', ARRAY['estética automotiva', 'lava jato', 'polimento']),
  ('Despachante veicular', NULL, ARRAY['despachante', 'documentação de veículo', 'licenciamento']),
  ('Móveis planejados', 'Móveis planejados / Marcenaria', ARRAY['marcenaria', 'marceneiro', 'móveis sob medida']),
  ('Construtora / Incorporadora', NULL, ARRAY['construtora', 'incorporadora']),
  ('Internet / Provedor', 'Internet / Telecomunicações', ARRAY['provedor de internet', 'fibra óptica', 'telefonia', 'telecomunicações']),
  ('Marketing / Publicidade', NULL, ARRAY['agência digital', 'marketing digital', 'agência de publicidade']),
  ('Consultoria empresarial', NULL, ARRAY['assessoria empresarial', 'consultoria']),
  ('Seguros', NULL, ARRAY['corretora de seguros', 'corretor de seguros', 'seguro auto']),
  ('Crédito / Empréstimos', NULL, ARRAY['correspondente bancário', 'consignado', 'empréstimo']),
  ('Imobiliária', NULL, ARRAY['corretor de imóveis', 'corretora de imóveis']),
  ('Ração / Nutrição animal', 'Rações / Nutrição animal', ARRAY['ração', 'casa de rações', 'nutrição animal']),
  ('Fotografia', 'Fotografia / Filmagem', ARRAY['filmagem', 'fotógrafo', 'vídeo de eventos']),
  ('Hotel', 'Hotel / Pousada', ARRAY['pousada', 'hospedagem']),
  ('Agência de viagens', NULL, ARRAY['agência de turismo', 'pacotes de viagem', 'passagens']),
  ('Excursões', 'Excursões / Transporte turístico', ARRAY['transporte turístico', 'fretamento']),
  ('Gráfica', 'Gráfica / Comunicação visual', ARRAY['comunicação visual', 'placas', 'adesivos', 'banners']),
  ('Insumos agrícolas', NULL, ARRAY['sementes', 'fertilizantes', 'adubo', 'defensivos agrícolas']),
  ('Máquinas agrícolas', 'Máquinas e implementos agrícolas', ARRAY['implementos agrícolas', 'tratores']),
  ('Logística', 'Logística / Transportadora', ARRAY['transportadora', 'transporte de cargas']),
  -- nomes que só confundiam na busca pública (que não mostra o grupo):
  -- "Nutrição" × "Rações / Nutrição animal", "Embalagens" × "Embalagens
  -- industriais", "Brinquedos" (loja) × "Brinquedos / Recreação" (festa)
  ('Nutrição', 'Nutricionista', ARRAY['nutrição', 'dieta']),
  ('Embalagens', 'Loja de embalagens', ARRAY['embalagens']),
  ('Brinquedos / Recreação', 'Recreação / Locação de brinquedos', ARRAY['pula-pula', 'recreação infantil', 'brinquedos para festa']),
  -- só aliases (o nome já é o certo, faltava o termo que a pessoa digita)
  ('Marmitaria', NULL, ARRAY['marmitex', 'quentinha']),
  ('Hortifruti', NULL, ARRAY['sacolão', 'quitanda']),
  ('Manicure / Nail designer', NULL, ARRAY['unha', 'pedicure', 'esmalteria']),
  ('Cílios / Sobrancelhas', NULL, ARRAY['design de sobrancelha', 'extensão de cílios', 'micropigmentação']),
  ('Tatuagem / Piercing', NULL, ARRAY['tattoo', 'tatuador']),
  ('Massoterapia', NULL, ARRAY['massagem', 'massagista']),
  ('Psicologia', NULL, ARRAY['psicólogo', 'terapia']),
  ('Fisioterapia', NULL, ARRAY['fisioterapeuta']),
  ('Clínica médica', NULL, ARRAY['médico', 'consultório médico']),
  ('Ótica', NULL, ARRAY['óculos', 'lentes de contato']),
  ('Laboratório / Exames', NULL, ARRAY['análises clínicas']),
  ('Natação', NULL, ARRAY['escola de natação', 'hidroginástica']),
  ('Escola de luta / Artes marciais', NULL, ARRAY['jiu-jitsu', 'muay thai', 'karatê', 'judô']),
  ('Calçados', NULL, ARRAY['sapataria', 'sapatos', 'tênis']),
  ('Moda íntima', NULL, ARRAY['lingerie']),
  ('Concessionária / Revenda de veículos', NULL, ARRAY['carros', 'seminovos']),
  ('Elétrica', NULL, ARRAY['material elétrico', 'eletricista']),
  ('Hidráulica', NULL, ARRAY['material hidráulico', 'encanador']),
  ('Energia solar', NULL, ARRAY['placa solar', 'painel solar', 'fotovoltaico']),
  ('Assistência de celulares', NULL, ARRAY['conserto de celular']),
  ('Assistência técnica', NULL, ARRAY['conserto de eletrodomésticos']),
  ('Clínica veterinária', NULL, ARRAY['veterinário', 'veterinária']),
  ('Loja de variedades', NULL, ARRAY['bazar']),
  ('Dedetização', NULL, ARRAY['controle de pragas']),
  ('Serviços funerários', NULL, ARRAY['funerária']),
  ('Distribuidora / Atacado', NULL, ARRAY['atacadista']);

UPDATE categorias c
   SET aliases = ARRAY(SELECT DISTINCT x FROM unnest(c.aliases || a.aliases) AS x ORDER BY x)
  FROM _ajuste a WHERE c.nome = a.nome;

UPDATE categorias c SET nome = a.novo_nome
  FROM _ajuste a
 WHERE c.nome = a.nome
   AND a.novo_nome IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM categorias x WHERE x.nome = a.novo_nome);
