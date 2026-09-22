-- Reformulação da área comercial (22/09/2026, pedido do dono): "Planos" vira
-- "Ofertas" (Preços + Promoções), e o formulário de candidatura de ponto
-- ganha endereço separado (rua/bairro deixam de vir concatenados no mesmo
-- campo). Três mudanças de schema, sem relação entre si, na mesma migration
-- porque nasceram do mesmo pedido.

-- ---------------------------------------------------------------------------
-- 1. Bairro e complemento como campos próprios (Parte W do pedido)
-- ---------------------------------------------------------------------------
-- `endereco` continua existindo e guardando "rua, número" como sempre guardou
-- (nenhum dado existente muda) — `bairro` e `complemento` são NOVOS, opcionais,
-- e o formulário canônico passa a preencher os três separados em vez de
-- concatenar bairro dentro de `endereco` (era o que `public/formulario.js`
-- #ligarCep fazia: `${logradouro}, ${bairro}` no mesmo campo).
ALTER TABLE pontos ADD COLUMN bairro text;
ALTER TABLE pontos ADD COLUMN complemento text;
ALTER TABLE candidaturas ADD COLUMN bairro text;
ALTER TABLE candidaturas ADD COLUMN complemento text;

-- ---------------------------------------------------------------------------
-- 2. Promoções — entidade separada do produto (Parte L a T do pedido)
-- ---------------------------------------------------------------------------
-- Produto continua sendo só Essencial/Pro/Prime (tier, fixo em código).
-- Promoção é uma condição comercial temporária que se aplica a uma matriz
-- tier × ciclo, com janela de COMPRA separada da DURAÇÃO do benefício (Parte
-- O: "compra até 31/10, condição válida por 12 meses da adesão" — duas datas
-- diferentes, não uma).
CREATE TABLE promocoes (
  id serial PRIMARY KEY,
  nome_interno text NOT NULL,
  titulo_publico text NOT NULL,
  subtitulo text,
  descricao text,
  selo text,
  imagem_url text,
  -- Janela de COMPRA: fora dela a promoção não aparece pra escolha nova, mas
  -- quem já aderiu continua com a condição (ver `promocao_valido_ate` em
  -- `assinaturas`, abaixo). Nula = sem limite naquele lado.
  compra_inicio timestamptz,
  compra_fim timestamptz,
  -- Quantos meses, a partir da adesão, a condição promocional vale — depois
  -- disso a assinatura volta pro preço vigente normal (Parte T: não
  -- recalcula retroativamente os meses já dentro da janela prometida).
  duracao_beneficio_meses int NOT NULL DEFAULT 12 CHECK (duracao_beneficio_meses > 0),
  -- Teto opcional de adesões (Parte M) — contado em `assinaturas` por
  -- `promocao_id`, não guardado aqui (uma coluna contada bate sempre; um
  -- contador dedicado desalinha se alguém cancelar e reassinar).
  limite_adesoes int CHECK (limite_adesoes IS NULL OR limite_adesoes > 0),
  mostrar_home boolean NOT NULL DEFAULT false,
  mostrar_planos boolean NOT NULL DEFAULT true,
  mostrar_logados boolean NOT NULL DEFAULT false,
  mostrar_admin boolean NOT NULL DEFAULT true,
  ativa boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- A matriz produto × ciclo (Parte N): uma linha por combinação participante,
-- cada uma com o próprio desconto — ciclo que não tem linha aqui não
-- participa (Mensal pode ficar de fora só não criando a linha dele).
CREATE TABLE promocoes_itens (
  id serial PRIMARY KEY,
  promocao_id int NOT NULL REFERENCES promocoes(id) ON DELETE CASCADE,
  tier text NOT NULL CHECK (tier IN ('essencial', 'destaque', 'maximo')),
  compromisso_meses int NOT NULL CHECK (compromisso_meses IN (1, 3, 6, 12)),
  desconto_percentual numeric(5,2) NOT NULL CHECK (desconto_percentual > 0 AND desconto_percentual <= 100),
  UNIQUE (promocao_id, tier, compromisso_meses)
);

-- A assinatura GUARDA a condição prometida (Parte T) — snapshot, não
-- referência viva: se o preço-base mudar depois, ou a promoção for editada
-- ou encerrada, quem já aderiu não é recalculado até `promocao_valido_ate`
-- passar. `promocao_id` fica só pra contar adesões e pra exibição (qual
-- promoção deu esse desconto); o desconto de verdade cobrado é sempre
-- `promocao_desconto_percentual`, travado no instante da adesão.
ALTER TABLE assinaturas ADD COLUMN promocao_id int REFERENCES promocoes(id);
ALTER TABLE assinaturas ADD COLUMN promocao_desconto_percentual numeric(5,2);
ALTER TABLE assinaturas ADD COLUMN promocao_valido_ate timestamptz;
