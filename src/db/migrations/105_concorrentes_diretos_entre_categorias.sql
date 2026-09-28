-- Concorrentes diretos entre categorias (28/09/2026, estação isolada
-- "Categorias e proteção contra concorrentes diretos", pedido do dono).
--
-- Até aqui a proteção do dono da tela era uma regra só: anúncio da MESMA
-- categoria do ponto não entra (src/playlist/gerador.js). Isso deixa passar
-- concorrente de verdade com nome diferente — a academia vê anúncio de
-- CrossFit, a cafeteria vê anúncio de padaria. Esta tabela é a segunda regra:
--
--   mesma categoria (ponto × anunciante)           → bloqueia (como já era)
--   par registrado aqui (ponto × anunciante)       → bloqueia
--   qualquer outra coisa                           → exibe
--
-- O que NÃO define concorrência, de propósito:
--   · GRUPO — é só organização da tela do admin. "Mesmo grupo" bloquearia
--     academia × pilates, pet shop × veterinário, barbearia × salão.
--   · ALIASES — servem à busca; nunca bloqueiam nada.
--   · anunciante × anunciante — não existe exclusividade entre anunciantes.
--     A proteção é do ponto: CATEGORIA DO PONTO × CATEGORIA DO ANUNCIANTE.
--
-- Um par por linha, guardado normalizado (categoria_a < categoria_b): a
-- relação é simétrica por construção — não existe "A concorre com B" sem "B
-- concorre com A", nem o mesmo par duas vezes, nem categoria concorrendo
-- consigo mesma (isso já é a regra 1). Editável pelo admin (Categorias →
-- editar → "Concorrentes diretos"); vale só pra programação FUTURA — nada de
-- proof-of-play, métricas ou playlists já geradas é reescrito.
CREATE TABLE categorias_concorrentes (
  categoria_a int NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
  categoria_b int NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
  criado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (categoria_a, categoria_b),
  CHECK (categoria_a < categoria_b)
);
-- A PK cobre busca por categoria_a; este cobre o outro lado ("concorrentes
-- de X" = X em qualquer uma das duas colunas).
CREATE INDEX categorias_concorrentes_b_idx ON categorias_concorrentes (categoria_b, categoria_a);
ALTER TABLE categorias_concorrentes ENABLE ROW LEVEL SECURITY;

-- Terapia capilar: não existia nada equivalente (nenhum nome nem alias com
-- capilar/tricologia; Salão de beleza é cabeleireiro, outro negócio). Nasce
-- ativa, no grupo Beleza e estética, e SEM par cruzado — concorre só consigo
-- mesma (barbearia, salão, clínica de estética e spa continuam exibindo).
INSERT INTO categorias (nome, grupo, aliases, ativo, legado)
VALUES ('Terapia capilar', 'Beleza e estética',
        ARRAY['terapeuta capilar', 'terapia capilar', 'tratamento capilar', 'tricologia', 'tricologista'],
        true, false)
ON CONFLICT (nome) DO NOTHING;

-- Matriz aprovada pelo dono (48 pares). Por NOME, como a 074: se o admin
-- renomeou ou apagou alguma categoria, o par vira no-op em vez de derrubar a
-- migration (e com ela o arranque do contêiner). Todos os nomes existiam em
-- produção em 28/09/2026.
INSERT INTO categorias_concorrentes (categoria_a, categoria_b)
SELECT DISTINCT least(ca.id, cb.id), greatest(ca.id, cb.id)
  FROM (VALUES
    -- Fitness (Academia × Pilates NÃO: público e aula diferentes)
    ('Academia', 'CrossFit / Treinamento funcional'),
    ('Academia', 'Personal trainer'),
    ('CrossFit / Treinamento funcional', 'Personal trainer'),
    -- Café da manhã / café
    ('Cafeteria', 'Padaria'),
    ('Cafeteria', 'Confeitaria / Doceria'),
    ('Padaria', 'Confeitaria / Doceria'),
    -- Sobremesa gelada
    ('Açaí', 'Sorveteria'),
    -- Refeições
    ('Restaurante', 'Lanchonete / Hamburgueria'),
    ('Restaurante', 'Pizzaria'),
    ('Restaurante', 'Esfiharia'),
    ('Restaurante', 'Pastelaria'),
    ('Restaurante', 'Marmitaria'),
    ('Lanchonete / Hamburgueria', 'Pizzaria'),
    ('Lanchonete / Hamburgueria', 'Esfiharia'),
    ('Lanchonete / Hamburgueria', 'Pastelaria'),
    ('Pizzaria', 'Esfiharia'),
    ('Esfiharia', 'Pastelaria'),
    -- Varejo alimentar
    ('Mercado / Supermercado', 'Conveniência'),
    ('Mercado / Supermercado', 'Hortifruti'),
    ('Mercado / Supermercado', 'Açougue / Casa de carnes'),
    -- Pet e agro (Pet shop × Clínica veterinária NÃO)
    ('Pet shop', 'Banho e tosa'),
    ('Pet shop', 'Rações / Nutrição animal'),
    ('Agropecuária', 'Rações / Nutrição animal'),
    ('Agropecuária', 'Insumos agrícolas'),
    -- Automotivo
    ('Oficina mecânica', 'Autoelétrica'),
    ('Oficina mecânica', 'Ar-condicionado automotivo'),
    ('Oficina mecânica', 'Pneus / Alinhamento'),
    -- Financeiro
    ('Banco / Cooperativa de crédito', 'Crédito / Empréstimos'),
    -- Saúde
    ('Fisioterapia', 'Quiropraxia'),
    -- Beleza e bem-estar (Barbearia × Salão NÃO; Terapia capilar sem par)
    ('Spa', 'Massoterapia'),
    -- Moda
    ('Loja de roupas', 'Moda feminina'),
    ('Loja de roupas', 'Moda masculina'),
    ('Loja de roupas', 'Moda infantil'),
    ('Loja de roupas', 'Moda íntima'),
    ('Loja de roupas', 'Brechó'),
    -- Casa e construção
    ('Material de construção', 'Ferragens'),
    ('Material de construção', 'Tintas'),
    ('Material de construção', 'Pisos / Revestimentos'),
    ('Loja de móveis', 'Móveis planejados / Marcenaria'),
    ('Serralheria', 'Esquadrias'),
    ('Esquadrias', 'Vidraçaria'),
    -- Tecnologia
    ('Assistência de informática', 'Informática'),
    ('Loja de celulares', 'Eletrônicos'),
    -- Serviços profissionais
    ('Design', 'Marketing / Publicidade'),
    -- Turismo e hospedagem
    ('Agência de viagens', 'Excursões / Transporte turístico'),
    ('Hotel / Pousada', 'Locação por temporada'),
    -- Transporte
    ('Logística / Transportadora', 'Mudanças / Fretes'),
    -- Saúde e nutrição
    ('Loja de suplementos', 'Produtos naturais')
  ) AS par (a, b)
  JOIN categorias ca ON ca.nome = par.a
  JOIN categorias cb ON cb.nome = par.b
 WHERE ca.id <> cb.id
ON CONFLICT DO NOTHING;
