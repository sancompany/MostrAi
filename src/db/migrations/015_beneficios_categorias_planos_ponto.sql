-- Catálogo de benefícios reutilizável: benefício vira registro próprio e o
-- plano só aponta pros que ele dá. Antes era um text[] solto por plano, o que
-- não deixava editar "Até 2 criativos" num lugar só nem reaproveitar entre
-- planos. planos.beneficios (a coluna) some — quem lê plano continua
-- recebendo o campo `beneficios`, agora montado por JOIN
-- (src/financeiro/planos-repository.js).
CREATE TABLE beneficios (
  id serial PRIMARY KEY,
  texto text NOT NULL UNIQUE,
  ordem int NOT NULL DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true
);

CREATE TABLE planos_beneficios (
  plano_id text NOT NULL REFERENCES planos(id) ON DELETE CASCADE,
  beneficio_id int NOT NULL REFERENCES beneficios(id) ON DELETE CASCADE,
  PRIMARY KEY (plano_id, beneficio_id)
);

INSERT INTO beneficios (texto)
  SELECT DISTINCT unnest(beneficios) FROM planos WHERE beneficios IS NOT NULL;

INSERT INTO planos_beneficios (plano_id, beneficio_id)
  SELECT p.id, b.id FROM planos p JOIN beneficios b ON b.texto = ANY(p.beneficios);

ALTER TABLE planos DROP COLUMN beneficios;

-- Ordem de exibição: mantém exatamente a sequência em que os benefícios já
-- apareciam no card de cada plano (Essencial → Máximo, migration 014).
UPDATE beneficios SET ordem = 5  WHERE texto LIKE 'Tudo do%';
UPDATE beneficios SET ordem = 10 WHERE texto LIKE 'Alcança%';
UPDATE beneficios SET ordem = 20 WHERE texto LIKE 'Painel%';
UPDATE beneficios SET ordem = 25 WHERE texto LIKE 'O dobro%';
UPDATE beneficios SET ordem = 28 WHERE texto LIKE 'Prioridade%';
UPDATE beneficios SET ordem = 30 WHERE texto LIKE 'Até 1 criativo%';
UPDATE beneficios SET ordem = 31 WHERE texto LIKE 'Até 2 criativos%';
UPDATE beneficios SET ordem = 32 WHERE texto LIKE 'Até 3 criativos%';
UPDATE beneficios SET ordem = 40 WHERE texto LIKE 'Upload%';
UPDATE beneficios SET ordem = 45 WHERE texto LIKE 'Melhor custo%';
UPDATE beneficios SET ordem = 50 WHERE texto LIKE 'Cobertura%';

-- O limite de criativos tem dois leitores (o upload em src/anunciantes e o
-- rodízio em src/playlist) e eles precisam concordar: trava a faixa no banco,
-- normalizando antes o que já tiver saído dela.
UPDATE planos SET limite_criativos = LEAST(3, GREATEST(1, limite_criativos));
ALTER TABLE planos ADD CONSTRAINT planos_limite_criativos_check
  CHECK (limite_criativos BETWEEN 1 AND 3);

-- Categorias de segmento — mesma lista pro anunciante (o que ele vende) e pro
-- ponto (o que o estabelecimento é). É o que permite não passar anúncio de
-- barbearia dentro de outra barbearia (src/playlist/gerador.js).
CREATE TABLE categorias (
  id serial PRIMARY KEY,
  nome text NOT NULL UNIQUE,
  ativo boolean NOT NULL DEFAULT true
);

INSERT INTO categorias (nome) VALUES
  ('Barbearia'), ('Salão de beleza / estética'), ('Academia / studio'),
  ('Restaurante / lanchonete'), ('Padaria / conveniência'), ('Bar / adega'),
  ('Mercado / hortifruti'), ('Moda / vestuário'), ('Calçados / acessórios'),
  ('Farmácia / saúde'), ('Clínica / consultório'), ('Odontologia'),
  ('Pet shop / veterinária'), ('Oficina / autopeças'), ('Concessionária / veículos'),
  ('Construção / materiais'), ('Móveis / decoração'), ('Eletro / celulares'),
  ('Imobiliária'), ('Escola / curso'), ('Advocacia / contabilidade'),
  ('Financeiro / seguros'), ('Turismo / eventos'), ('Serviços gerais'), ('Outro');

ALTER TABLE anunciantes ADD COLUMN categoria_id int REFERENCES categorias(id);
ALTER TABLE anunciantes ADD COLUMN categoria_livre text; -- preenchido quando escolhe "Outro"
ALTER TABLE pontos ADD COLUMN categoria_id int REFERENCES categorias(id);

-- Casa o segmento em texto livre que já estava gravado com a categoria nova,
-- quando bater exatamente. O resto o admin ajusta na mão.
UPDATE pontos p SET categoria_id = c.id FROM categorias c WHERE lower(c.nome) = lower(p.segmento);

-- Planos de comodato: o dono do ponto escolhe entre receber ajuda de custo em
-- dinheiro ou trocar esse dinheiro por mais espaço pro próprio negócio na
-- tela. Os valores ficam editáveis no admin — o que o ponto contratou é
-- copiado pra pontos.valor_pago_mensal / cota_autoanuncio_slots_hora na
-- aprovação, então mexer no plano depois não muda contrato já fechado.
CREATE TABLE planos_ponto (
  id text PRIMARY KEY,
  nome text NOT NULL,
  chamada text NOT NULL,
  ajuda_custo_mensal numeric NOT NULL DEFAULT 0,
  cota_slots_hora int NOT NULL DEFAULT 0,
  beneficios text[] NOT NULL DEFAULT '{}',
  ordem int NOT NULL DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true
);

INSERT INTO planos_ponto (id, nome, chamada, ajuda_custo_mensal, cota_slots_hora, beneficios, ordem) VALUES
  ('ajuda-custo', 'Ajuda de custo',
   'R$ 50 por mês na sua conta, todo mês, mais uma cota de divulgação do seu próprio negócio.',
   50, 1,
   ARRAY['Tela, player e instalação por nossa conta', 'R$ 50 por mês de ajuda de custo', 'Seu negócio na tela 1x por hora', 'Sem mensalidade e sem operar nada'], 1),
  ('mais-cota', 'Mais tela pro seu negócio',
   'Abre mão dos R$ 50 e o seu próprio negócio aparece o triplo de vezes na tela, o dia inteiro.',
   0, 3,
   ARRAY['Tela, player e instalação por nossa conta', 'Seu negócio na tela 3x por hora', 'Troque seu anúncio quando quiser', 'Sem mensalidade e sem operar nada'], 2);

ALTER TABLE pontos ADD COLUMN plano_ponto_id text REFERENCES planos_ponto(id);

-- Redefinição de senha por link no e-mail (anunciante e vendedor). Token de
-- uso único com validade curta; a limpeza é o próprio DELETE ao usar.
CREATE TABLE tokens_senha (
  token text PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('anunciante', 'afiliado')),
  usuario_id int NOT NULL,
  expira_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
