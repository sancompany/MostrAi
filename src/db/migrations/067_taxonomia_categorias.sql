-- Reforma da taxonomia de categorias (22/09/2026, pedido do dono).
--
-- O QUE MUDA, EM CONCEITO — três coisas com papéis diferentes, que o código
-- (e o admin) precisam tratar como diferentes:
--
--   GRUPO       = só organização visual da tela de escolha (ex. "Beleza e
--                 estética"). NUNCA entra na regra de bloqueio.
--   CATEGORIA   = a unidade que o sistema usa pra impedir concorrente direto
--                 na mesma tela (pontos.categoria_id = anunciantes.categoria_id
--                 → bloqueia, ver src/playlist/gerador.js:112). A REGRA EM SI
--                 NÃO MUDA NESTA MIGRATION — só os valores ficam mais
--                 específicos (Barbearia deixa de bloquear Salão de beleza,
--                 por exemplo, porque agora são categorias diferentes).
--   ALIAS       = termo alternativo só pra achar a categoria na busca
--                 ("dentista" acha "Odontologia"). Nunca é comparado na regra
--                 de bloqueio, nunca vira categoria própria.
--
-- POR QUE ADITIVO, NADA APAGADO:
-- As 25 categorias da migration 015 continuam TODAS presentes, com o MESMO
-- id — qualquer anunciante/ponto que já aponte pra uma delas continua
-- resolvendo normalmente (FK intacta, nada quebra). Só 3 delas (Barbearia,
-- Odontologia, Imobiliária) já eram específicas o bastante e ganham
-- grupo+aliases no lugar. As outras 21 (mais "Outro") são amplas demais pro
-- padrão novo — viram `legado = true` e `ativo = false`: somem da lista
-- pública (`GET /categorias`, o que os cadastros oferecem), mas continuam
-- existindo pra quem já as usa, e o admin continua vendo e podendo
-- reclassificar cada conta/ponto uma a uma (não dá pra saber automaticamente
-- se "Clínica / consultório" era uma clínica de odontologia, fisioterapia ou
-- psicologia — teria que adivinhar por conta vinculada, e adivinhar errado
-- aqui é falso-negativo de concorrência, o oposto do que a categoria existe
-- pra evitar). O banco de dev, hoje, não tem nenhum anunciante/ponto usando
-- as antigas (conferido antes de escrever esta migration — ver
-- docs/PENDENCIAS.md, seção K); em produção isso é responsabilidade do admin
-- reclassificar pela aba Categorias, sem pressa, sem automatismo.
--
-- "Outro" deixa de ser uma string mágica comparada no front
-- (`nome === 'Outro'`, public/formulario.js) — o mecanismo novo é
-- `categoria_id = NULL` + `categoria_livre` preenchido, que já é como o
-- sistema representa "não classificado" desde a migration 015 (e que já é
-- ignorado pela regra de bloqueio, de propósito: só quem tem categoria_id
-- nos dois lados bloqueia). A linha "Outro" (id 25) fica gravada, inerte,
-- por segurança de FK de quem já tinha esse id — só não aparece mais em
-- lugar nenhum.

ALTER TABLE categorias ADD COLUMN grupo text;
ALTER TABLE categorias ADD COLUMN aliases text[] NOT NULL DEFAULT '{}';
ALTER TABLE categorias ADD COLUMN legado boolean NOT NULL DEFAULT false;

-- pontos nunca teve o equivalente de anunciantes.categoria_livre (migration
-- 015) — o admin já lia `ponto.categoria_livre` numa tela (renderPontoResumo)
-- que nunca existia de verdade; o campo só aparecia como "-" sempre. Cria a
-- coluna de verdade, mesmo padrão de anunciantes: NULL quando categoria_id
-- está preenchido, texto quando o dono descreveu a atividade e não achou
-- categoria (mesma semântica de "pendente de classificação").
ALTER TABLE pontos ADD COLUMN categoria_livre text;

-- As 3 que já eram específicas o bastante: viram a linha "oficial" da
-- categoria nova, no MESMO id — sem duplicar linha, sem re-apontar FK de
-- ninguém.
UPDATE categorias SET grupo = 'Beleza e estética', aliases = ARRAY['barbeiro', 'barbershop'] WHERE nome = 'Barbearia';
UPDATE categorias SET grupo = 'Saúde', aliases = ARRAY['dentista'] WHERE nome = 'Odontologia';
UPDATE categorias SET grupo = 'Imobiliário', aliases = ARRAY['imóveis', 'casa para vender'] WHERE nome = 'Imobiliária';

-- As 21 amplas demais + "Outro": saem do catálogo ativo, ficam marcadas como
-- legado. Continuam existindo (FK de quem já usa continua válida).
UPDATE categorias SET legado = true, ativo = false
  WHERE nome IN (
    'Salão de beleza / estética', 'Academia / studio', 'Restaurante / lanchonete',
    'Padaria / conveniência', 'Bar / adega', 'Mercado / hortifruti', 'Moda / vestuário',
    'Calçados / acessórios', 'Farmácia / saúde', 'Clínica / consultório',
    'Pet shop / veterinária', 'Oficina / autopeças', 'Concessionária / veículos',
    'Construção / materiais', 'Móveis / decoração', 'Eletro / celulares',
    'Escola / curso', 'Advocacia / contabilidade', 'Financeiro / seguros',
    'Turismo / eventos', 'Serviços gerais', 'Outro'
  );

-- Catálogo novo — aditivo, ativo = true (default da coluna), legado = false
-- (default). Aliases só nos casos que o dono deu como exemplo (seção 5 do
-- pedido) — não é pra inventar sinônimo pra cada uma das ~190 categorias,
-- só pros termos que alguém plausivelmente digitaria em vez do nome oficial.
INSERT INTO categorias (nome, grupo, aliases) VALUES
  -- Alimentação
  ('Restaurante', 'Alimentação', '{}'),
  ('Lanchonete / Hamburgueria', 'Alimentação', '{}'),
  ('Pizzaria', 'Alimentação', '{}'),
  ('Pastelaria', 'Alimentação', '{}'),
  ('Esfiharia', 'Alimentação', '{}'),
  ('Marmitaria', 'Alimentação', '{}'),
  ('Padaria', 'Alimentação', '{}'),
  ('Confeitaria', 'Alimentação', '{}'),
  ('Doceria', 'Alimentação', '{}'),
  ('Cafeteria', 'Alimentação', '{}'),
  ('Sorveteria', 'Alimentação', '{}'),
  ('Açaí', 'Alimentação', '{}'),
  ('Bar / Pub', 'Alimentação', '{}'),
  ('Adega / Distribuidora de bebidas', 'Alimentação', '{}'),
  ('Mercado / Supermercado', 'Alimentação', ARRAY['supermercado', 'mercado']),
  ('Mercearia', 'Alimentação', '{}'),
  ('Conveniência', 'Alimentação', '{}'),
  ('Hortifruti', 'Alimentação', '{}'),
  ('Açougue', 'Alimentação', '{}'),
  ('Casa de carnes', 'Alimentação', '{}'),
  ('Produtos naturais', 'Alimentação', '{}'),

  -- Beleza e estética (Barbearia já existe, upgradada acima)
  ('Salão de beleza', 'Beleza e estética', ARRAY['cabeleireiro', 'cabeleireira']),
  ('Clínica de estética', 'Beleza e estética', ARRAY['estetica']),
  ('Estética facial / corporal', 'Beleza e estética', ARRAY['estetica']),
  ('Manicure / Nail designer', 'Beleza e estética', '{}'),
  ('Cílios / Sobrancelhas', 'Beleza e estética', '{}'),
  ('Depilação', 'Beleza e estética', '{}'),
  ('Bronzeamento', 'Beleza e estética', '{}'),
  ('Maquiagem profissional', 'Beleza e estética', '{}'),
  ('Tatuagem / Piercing', 'Beleza e estética', '{}'),
  ('Massoterapia', 'Beleza e estética', '{}'),
  ('Spa', 'Beleza e estética', '{}'),

  -- Saúde (Odontologia já existe, upgradada acima)
  ('Clínica médica', 'Saúde', '{}'),
  ('Ortodontia', 'Saúde', '{}'),
  ('Fisioterapia', 'Saúde', '{}'),
  ('Psicologia', 'Saúde', '{}'),
  ('Nutrição', 'Saúde', '{}'),
  ('Fonoaudiologia', 'Saúde', '{}'),
  ('Terapia ocupacional', 'Saúde', '{}'),
  ('Quiropraxia', 'Saúde', '{}'),
  ('Oftalmologia', 'Saúde', '{}'),
  ('Ótica', 'Saúde', '{}'),
  ('Farmácia / Drogaria', 'Saúde', '{}'),
  ('Laboratório / Exames', 'Saúde', '{}'),
  ('Clínica de vacinação', 'Saúde', '{}'),
  ('Home care', 'Saúde', '{}'),

  -- Fitness e esporte
  ('Academia', 'Fitness e esporte', ARRAY['musculação']),
  ('CrossFit / Treinamento funcional', 'Fitness e esporte', '{}'),
  ('Estúdio de Pilates', 'Fitness e esporte', '{}'),
  ('Personal trainer', 'Fitness e esporte', '{}'),
  ('Escola de luta / Artes marciais', 'Fitness e esporte', '{}'),
  ('Dança', 'Fitness e esporte', '{}'),
  ('Natação', 'Fitness e esporte', '{}'),
  ('Loja de suplementos', 'Fitness e esporte', '{}'),
  ('Loja de artigos esportivos', 'Fitness e esporte', '{}'),
  ('Quadra / Centro esportivo', 'Fitness e esporte', '{}'),

  -- Moda
  ('Loja de roupas', 'Moda', ARRAY['roupa', 'vestuário']),
  ('Moda feminina', 'Moda', '{}'),
  ('Moda masculina', 'Moda', '{}'),
  ('Moda infantil', 'Moda', '{}'),
  ('Moda íntima', 'Moda', '{}'),
  ('Calçados', 'Moda', '{}'),
  ('Bolsas / Acessórios', 'Moda', '{}'),
  ('Joalheria', 'Moda', '{}'),
  ('Semijoias', 'Moda', '{}'),
  ('Relojoaria', 'Moda', '{}'),
  ('Brechó', 'Moda', '{}'),
  ('Uniformes', 'Moda', '{}'),
  ('Alfaiataria', 'Moda', '{}'),
  ('Costura / Ajustes', 'Moda', '{}'),

  -- Automotivo
  ('Concessionária / Revenda de veículos', 'Automotivo', '{}'),
  ('Revenda de motos', 'Automotivo', '{}'),
  ('Oficina mecânica', 'Automotivo', ARRAY['mecânica', 'mecanico']),
  ('Oficina de motos', 'Automotivo', '{}'),
  ('Autoelétrica', 'Automotivo', '{}'),
  ('Funilaria / Pintura', 'Automotivo', '{}'),
  ('Autopeças', 'Automotivo', '{}'),
  ('Pneus', 'Automotivo', '{}'),
  ('Alinhamento / Balanceamento', 'Automotivo', '{}'),
  ('Estética automotiva', 'Automotivo', '{}'),
  ('Lava-rápido', 'Automotivo', '{}'),
  ('Som / Acessórios automotivos', 'Automotivo', '{}'),
  ('Vidros automotivos', 'Automotivo', '{}'),
  ('Ar-condicionado automotivo', 'Automotivo', '{}'),
  ('Locadora de veículos', 'Automotivo', '{}'),
  ('Despachante veicular', 'Automotivo', '{}'),

  -- Casa, móveis e decoração
  ('Loja de móveis', 'Casa, móveis e decoração', '{}'),
  ('Móveis planejados', 'Casa, móveis e decoração', '{}'),
  ('Colchões', 'Casa, móveis e decoração', '{}'),
  ('Decoração', 'Casa, móveis e decoração', '{}'),
  ('Cama / Mesa / Banho', 'Casa, móveis e decoração', '{}'),
  ('Iluminação', 'Casa, móveis e decoração', '{}'),
  ('Cortinas / Persianas', 'Casa, móveis e decoração', '{}'),
  ('Marcenaria', 'Casa, móveis e decoração', '{}'),
  ('Eletrodomésticos', 'Casa, móveis e decoração', '{}'),
  ('Utilidades domésticas', 'Casa, móveis e decoração', '{}'),
  ('Piscinas', 'Casa, móveis e decoração', '{}'),
  ('Paisagismo', 'Casa, móveis e decoração', '{}'),

  -- Construção
  ('Material de construção', 'Construção', '{}'),
  ('Tintas', 'Construção', '{}'),
  ('Elétrica', 'Construção', '{}'),
  ('Hidráulica', 'Construção', '{}'),
  ('Ferragens', 'Construção', '{}'),
  ('Madeireira', 'Construção', '{}'),
  ('Marmoraria', 'Construção', '{}'),
  ('Vidraçaria', 'Construção', '{}'),
  ('Serralheria', 'Construção', '{}'),
  ('Esquadrias', 'Construção', '{}'),
  ('Pisos / Revestimentos', 'Construção', '{}'),
  ('Arquitetura', 'Construção', '{}'),
  ('Engenharia', 'Construção', '{}'),
  ('Construtora', 'Construção', '{}'),
  ('Energia solar', 'Construção', '{}'),

  -- Tecnologia e eletrônicos
  ('Loja de celulares', 'Tecnologia e eletrônicos', ARRAY['celular', 'smartphone']),
  ('Assistência de celulares', 'Tecnologia e eletrônicos', '{}'),
  ('Informática', 'Tecnologia e eletrônicos', '{}'),
  ('Assistência de informática', 'Tecnologia e eletrônicos', '{}'),
  ('Eletrônicos', 'Tecnologia e eletrônicos', '{}'),
  ('Segurança eletrônica', 'Tecnologia e eletrônicos', '{}'),
  ('Internet / Provedor', 'Tecnologia e eletrônicos', '{}'),
  ('Telecomunicações', 'Tecnologia e eletrônicos', '{}'),
  ('Software / Tecnologia', 'Tecnologia e eletrônicos', '{}'),
  ('Automação comercial', 'Tecnologia e eletrônicos', '{}'),
  ('Games / Videogames', 'Tecnologia e eletrônicos', '{}'),

  -- Educação
  ('Escola particular', 'Educação', '{}'),
  ('Educação infantil', 'Educação', '{}'),
  ('Curso profissionalizante', 'Educação', '{}'),
  ('Escola de idiomas', 'Educação', '{}'),
  ('Reforço escolar', 'Educação', '{}'),
  ('Preparatório / Vestibular', 'Educação', '{}'),
  ('Faculdade / Ensino superior', 'Educação', '{}'),
  ('Escola de música', 'Educação', '{}'),
  ('Escola de dança', 'Educação', '{}'),
  ('Autoescola', 'Educação', '{}'),
  ('Cursos online', 'Educação', '{}'),

  -- Serviços profissionais
  ('Advocacia', 'Serviços profissionais', ARRAY['advogado']),
  ('Contabilidade', 'Serviços profissionais', ARRAY['contador']),
  ('Consultoria empresarial', 'Serviços profissionais', '{}'),
  ('Marketing / Publicidade', 'Serviços profissionais', '{}'),
  ('Agência digital', 'Serviços profissionais', '{}'),
  ('Design', 'Serviços profissionais', '{}'),
  ('Recursos humanos / Recrutamento', 'Serviços profissionais', '{}'),
  ('Despachante', 'Serviços profissionais', '{}'),
  ('Assessoria empresarial', 'Serviços profissionais', '{}'),
  ('Coworking', 'Serviços profissionais', '{}'),
  ('Tradução', 'Serviços profissionais', '{}'),
  ('Certificação digital', 'Serviços profissionais', '{}'),

  -- Financeiro
  ('Banco / Cooperativa de crédito', 'Financeiro', '{}'),
  ('Crédito / Empréstimos', 'Financeiro', '{}'),
  ('Consórcio', 'Financeiro', '{}'),
  ('Seguros', 'Financeiro', '{}'),
  ('Corretora de seguros', 'Financeiro', '{}'),
  ('Investimentos', 'Financeiro', '{}'),
  ('Fintech / Pagamentos', 'Financeiro', '{}'),
  ('Correspondente bancário', 'Financeiro', '{}'),

  -- Imobiliário (Imobiliária já existe, upgradada acima)
  ('Corretor de imóveis', 'Imobiliário', '{}'),
  ('Construtora / Incorporadora', 'Imobiliário', '{}'),
  ('Loteadora', 'Imobiliário', '{}'),
  ('Administração de condomínios', 'Imobiliário', '{}'),
  ('Locação por temporada', 'Imobiliário', '{}'),

  -- Pet
  ('Pet shop', 'Pet', ARRAY['pet', 'animais']),
  ('Clínica veterinária', 'Pet', '{}'),
  ('Banho e tosa', 'Pet', '{}'),
  ('Hotel / Creche para pets', 'Pet', '{}'),
  ('Adestramento', 'Pet', '{}'),
  ('Ração / Nutrição animal', 'Pet', '{}'),

  -- Eventos e entretenimento
  ('Buffet', 'Eventos e entretenimento', '{}'),
  ('Casa de festas', 'Eventos e entretenimento', '{}'),
  ('Fotografia', 'Eventos e entretenimento', '{}'),
  ('Filmagem', 'Eventos e entretenimento', '{}'),
  ('DJ / Produção musical', 'Eventos e entretenimento', '{}'),
  ('Produção de eventos', 'Eventos e entretenimento', '{}'),
  ('Decoração de festas', 'Eventos e entretenimento', '{}'),
  ('Brinquedos / Recreação', 'Eventos e entretenimento', '{}'),
  ('Cinema / Entretenimento', 'Eventos e entretenimento', '{}'),
  ('Parque / Espaço recreativo', 'Eventos e entretenimento', '{}'),
  ('Locação de equipamentos para eventos', 'Eventos e entretenimento', '{}'),

  -- Turismo e hospedagem
  ('Agência de viagens', 'Turismo e hospedagem', '{}'),
  ('Hotel', 'Turismo e hospedagem', '{}'),
  ('Pousada', 'Turismo e hospedagem', '{}'),
  ('Agência de turismo', 'Turismo e hospedagem', '{}'),
  ('Excursões', 'Turismo e hospedagem', '{}'),
  ('Transporte turístico', 'Turismo e hospedagem', '{}'),

  -- Varejo
  ('Papelaria', 'Varejo', '{}'),
  ('Livraria', 'Varejo', '{}'),
  ('Floricultura', 'Varejo', '{}'),
  ('Presentes', 'Varejo', '{}'),
  ('Brinquedos', 'Varejo', '{}'),
  ('Artigos para festas', 'Varejo', '{}'),
  ('Loja de variedades', 'Varejo', '{}'),
  ('Armarinho', 'Varejo', '{}'),
  ('Embalagens', 'Varejo', '{}'),
  ('Produtos de limpeza', 'Varejo', '{}'),
  ('Cosméticos / Perfumaria', 'Varejo', '{}'),

  -- Serviços pessoais
  ('Lavanderia', 'Serviços pessoais', '{}'),
  ('Chaveiro', 'Serviços pessoais', '{}'),
  ('Gráfica', 'Serviços pessoais', '{}'),
  ('Comunicação visual', 'Serviços pessoais', '{}'),
  ('Assistência técnica', 'Serviços pessoais', '{}'),
  ('Limpeza profissional', 'Serviços pessoais', '{}'),
  ('Dedetização', 'Serviços pessoais', '{}'),
  ('Mudanças / Fretes', 'Serviços pessoais', '{}'),
  ('Motoboy / Entregas', 'Serviços pessoais', '{}'),
  ('Serviços funerários', 'Serviços pessoais', '{}'),

  -- Agro
  ('Agropecuária', 'Agro', '{}'),
  ('Insumos agrícolas', 'Agro', '{}'),
  ('Máquinas agrícolas', 'Agro', '{}'),
  ('Implementos agrícolas', 'Agro', '{}'),
  ('Irrigação', 'Agro', '{}'),
  ('Sementes', 'Agro', '{}'),
  ('Fertilizantes', 'Agro', '{}'),
  ('Defensivos agrícolas', 'Agro', '{}'),
  ('Nutrição animal', 'Agro', '{}'),
  ('Veterinária rural', 'Agro', '{}'),
  ('Rações', 'Agro', '{}'),
  ('Cooperativa agrícola', 'Agro', '{}'),

  -- Indústria e empresas B2B
  ('Indústria', 'Indústria e empresas B2B', '{}'),
  ('Metalúrgica', 'Indústria e empresas B2B', '{}'),
  ('Usinagem', 'Indústria e empresas B2B', '{}'),
  ('Embalagens industriais', 'Indústria e empresas B2B', '{}'),
  ('Automação industrial', 'Indústria e empresas B2B', '{}'),
  ('Equipamentos industriais', 'Indústria e empresas B2B', '{}'),
  ('Manutenção industrial', 'Indústria e empresas B2B', '{}'),
  ('Logística', 'Indústria e empresas B2B', '{}'),
  ('Transportadora', 'Indústria e empresas B2B', '{}'),
  ('Distribuidora / Atacado', 'Indústria e empresas B2B', '{}');
