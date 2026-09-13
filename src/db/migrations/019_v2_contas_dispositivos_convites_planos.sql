-- v2 (re-escopo de 12/09/2026, docs/specs/2026-09-12-mostrai.md).
-- Tudo aqui é aditivo: nenhuma coluna ou tabela existente é apagada.
-- O que deixou de ser usado (afiliados, pontos.aparelho_id,
-- pontos.ultima_vez_online, exibicoes_contador.ponto_id, comissoes.afiliado_id)
-- fica no lugar até o dono decidir o drop — lista curta das leis.

-- ---------------------------------------------------------------------------
-- 1) Uma conta por pessoa, papéis vindos do convite.
--    A tabela `anunciantes` é a tabela de contas (nome histórico, ver
--    CONSTRAINTS.md). Vendedor vira papel + perfil, em vez de login à parte.
-- ---------------------------------------------------------------------------
ALTER TABLE anunciantes ADD COLUMN papeis text[] NOT NULL DEFAULT '{anunciante}';
CREATE INDEX idx_anunciantes_papeis ON anunciantes USING gin (papeis);

-- Conta só de vendedor (ou só de ponto) não tem endereço comercial próprio.
ALTER TABLE anunciantes ALTER COLUMN endereco DROP NOT NULL;
ALTER TABLE anunciantes ALTER COLUMN cidade DROP NOT NULL;
ALTER TABLE anunciantes ALTER COLUMN uf DROP NOT NULL;
ALTER TABLE anunciantes ALTER COLUMN cep DROP NOT NULL;

CREATE TABLE vendedores (
  conta_id int PRIMARY KEY REFERENCES anunciantes(id),
  chave_pix text NOT NULL,
  codigo_cupom text NOT NULL UNIQUE,
  comissao_percentual numeric NOT NULL DEFAULT 12,
  status text NOT NULL DEFAULT 'aprovado' CHECK (status IN ('aprovado', 'inativo')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Migra os afiliados existentes para contas + perfil de vendedor. E-mail que
-- já existir como conta ganha só o papel e o perfil.
INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                         status, papeis, aceitou_termos_em, created_at)
SELECT a.nome, a.cpf, a.email, a.telefone, a.senha_hash,
       'aprovado', '{vendedor}', COALESCE(a.aceitou_termos_em, now()), a.created_at
FROM afiliados a
WHERE NOT EXISTS (SELECT 1 FROM anunciantes x WHERE lower(x.contato_email) = lower(a.email));

UPDATE anunciantes x SET papeis = array_append(x.papeis, 'vendedor')
FROM afiliados a
WHERE lower(x.contato_email) = lower(a.email) AND NOT ('vendedor' = ANY (x.papeis));

INSERT INTO vendedores (conta_id, chave_pix, codigo_cupom, comissao_percentual, status, created_at)
SELECT x.id, a.chave_pix, a.codigo_cupom, a.comissao_percentual,
       CASE WHEN a.status = 'aprovado' THEN 'aprovado' ELSE 'inativo' END, a.created_at
FROM afiliados a JOIN anunciantes x ON lower(x.contato_email) = lower(a.email)
ON CONFLICT (conta_id) DO NOTHING;

ALTER TABLE comissoes ADD COLUMN vendedor_conta_id int REFERENCES anunciantes(id);
UPDATE comissoes c SET vendedor_conta_id = x.id
FROM afiliados a JOIN anunciantes x ON lower(x.contato_email) = lower(a.email)
WHERE c.afiliado_id = a.id;
-- Comissão nova nasce só com vendedor_conta_id; a coluna antiga fica
-- preenchida no histórico e vazia daqui pra frente (não é drop).
ALTER TABLE comissoes ALTER COLUMN afiliado_id DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 2) Dispositivo (tela) é entidade própria. Ponto é o comércio/endereço.
--    Chave de aparelho, PIN, último sinal, custo de equipamento e contador de
--    exibição passam a viver aqui. Ajuda de custo e cota de autoanúncio
--    continuam no ponto (a cota é dividida entre as telas dele).
-- ---------------------------------------------------------------------------
CREATE TABLE dispositivos (
  id serial PRIMARY KEY,
  ponto_id int NOT NULL REFERENCES pontos(id),
  apelido text NOT NULL DEFAULT 'Tela 1',
  aparelho_id text UNIQUE,
  pin_hash text,
  status text NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'reparo', 'inativo')),
  ultima_vez_online timestamptz,
  -- Custo real desta tela (TV + stick + molde + instalação) e prazo de
  -- amortização — é daqui que sai a margem, não de constante no código.
  custo_equipamento numeric NOT NULL DEFAULT 0,
  meses_amortizacao int NOT NULL DEFAULT 36 CHECK (meses_amortizacao > 0),
  instalado_em date,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_dispositivos_ponto ON dispositivos (ponto_id);

-- Todo ponto existente ganha uma tela herdando a chave e o último sinal.
INSERT INTO dispositivos (ponto_id, apelido, aparelho_id, ultima_vez_online, status, instalado_em)
SELECT id, 'Tela 1', aparelho_id, ultima_vez_online,
       CASE WHEN status = 'reparo' THEN 'reparo' WHEN status = 'inativo' THEN 'inativo' ELSE 'ativo' END,
       CASE WHEN status = 'ativo' THEN created_at::date END
FROM pontos;

-- Contador de exibições passa a ser por tela.
ALTER TABLE exibicoes_contador ADD COLUMN dispositivo_id int REFERENCES dispositivos(id);
UPDATE exibicoes_contador e SET dispositivo_id = d.id
FROM dispositivos d WHERE d.ponto_id = e.ponto_id AND e.dispositivo_id IS NULL;
ALTER TABLE exibicoes_contador ALTER COLUMN dispositivo_id SET NOT NULL;

-- A unicidade antiga (anunciante, ponto, hora) impediria duas telas do mesmo
-- ponto na mesma hora. Nome da constraint é o automático do Postgres; se não
-- existir com esse nome, o bloco procura pelo formato.
DO $$
DECLARE nome text;
BEGIN
  SELECT conname INTO nome FROM pg_constraint
  WHERE conrelid = 'exibicoes_contador'::regclass AND contype = 'u'
    AND pg_get_constraintdef(oid) LIKE '%anunciante_id, ponto_id, janela_hora%';
  IF nome IS NOT NULL THEN
    EXECUTE format('ALTER TABLE exibicoes_contador DROP CONSTRAINT %I', nome);
  END IF;
END $$;
ALTER TABLE exibicoes_contador
  ADD CONSTRAINT exibicoes_contador_dispositivo_unq UNIQUE (anunciante_id, dispositivo_id, janela_hora);
CREATE INDEX idx_exibicoes_dispositivo_hora ON exibicoes_contador (dispositivo_id, janela_hora);

-- ---------------------------------------------------------------------------
-- 3) Candidatura (formulário público) e convite (link gerado pelo dono).
--    Ponto e vendedor só entram por convite; anunciante continua com cadastro
--    aberto.
-- ---------------------------------------------------------------------------
CREATE TABLE candidaturas (
  id serial PRIMARY KEY,
  tipo text NOT NULL CHECK (tipo IN ('ponto', 'vendedor')),
  nome text NOT NULL,
  nome_comercio text,
  contato_telefone text NOT NULL,
  contato_email text,
  endereco text, cidade text, uf text, cep text,
  segmento text,
  fluxo_estimado_mensal int,
  mensagem text,
  status text NOT NULL DEFAULT 'nova' CHECK (status IN ('nova', 'em_contato', 'aprovada', 'recusada')),
  criado_em timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE convites (
  id serial PRIMARY KEY,
  token text NOT NULL UNIQUE,
  papeis text[] NOT NULL,
  nome_sugerido text,
  email_sugerido text,
  candidatura_id int REFERENCES candidaturas(id),
  expira_em timestamptz NOT NULL,
  usado_em timestamptz,
  conta_id int REFERENCES anunciantes(id),
  criado_em timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE candidaturas ADD COLUMN convite_id int REFERENCES convites(id);

-- ---------------------------------------------------------------------------
-- 4) Plano modular: campos no plano, não variáveis de ambiente.
-- ---------------------------------------------------------------------------
ALTER TABLE planos ADD COLUMN meses_gratis int NOT NULL DEFAULT 0 CHECK (meses_gratis >= 0);
-- Cobertura só começa a contar quando a rede tiver ao menos N telas ativas.
ALTER TABLE planos ADD COLUMN minimo_telas_ativas int NOT NULL DEFAULT 1 CHECK (minimo_telas_ativas >= 0);
ALTER TABLE planos ADD COLUMN preco_travado boolean NOT NULL DEFAULT false;
ALTER TABLE planos ADD COLUMN fundador boolean NOT NULL DEFAULT false;
ALTER TABLE planos ADD COLUMN vagas int CHECK (vagas IS NULL OR vagas > 0); -- NULL = sem limite

-- O que a conta efetivamente paga (travado na primeira cobrança) e quantos
-- meses grátis já recebeu — evita creditar o bônus duas vezes.
ALTER TABLE anunciantes ADD COLUMN valor_mensal_travado numeric;
ALTER TABLE anunciantes ADD COLUMN meses_gratis_creditados int NOT NULL DEFAULT 0;
-- Ciclos pagos enquanto a rede ainda não tinha o mínimo de telas do plano.
-- A cobertura só começa a contar quando o mínimo é atingido — aí esses meses
-- viram data_expiracao de uma vez (coberturas.js). Nada pago se perde.
ALTER TABLE anunciantes ADD COLUMN meses_cobertura_pendentes int NOT NULL DEFAULT 0;

-- Plano de fundador sugerido pela pesquisa de preço (docs/precificacao.md).
-- Entra DESLIGADO: o dono revisa preço e vagas no admin antes de ativar.
INSERT INTO planos (id, tier, nome, valor_mensal, valor_mensal_cheio, compromisso_meses, frequencia_dia,
                    cobertura, ativo, limite_criativos, rotulo, destaque_no_site,
                    meses_gratis, minimo_telas_ativas, preco_travado, fundador, vagas)
VALUES ('fundador-12m', 'destaque', 'Fundador', 149, 249, 12, 72, 'todos_pontos', false, 2,
        'Preço fundador — travado por 12 meses', false, 1, 2, true, true, 10)
ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 5) Custos fixos da operação — lançados pelo dono, entram na margem.
-- ---------------------------------------------------------------------------
CREATE TABLE custos_fixos (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  valor_mensal numeric NOT NULL DEFAULT 0 CHECK (valor_mensal >= 0),
  ativo boolean NOT NULL DEFAULT true,
  observacao text
);
INSERT INTO custos_fixos (nome, valor_mensal, observacao) VALUES
  ('DAS MEI', 86.05, 'tabela 2026, serviços — conferir todo janeiro'),
  ('Contador', 100, 'estimativa para MEI'),
  ('Domínio .com.br', 3.33, 'R$ 39,99/ano'),
  ('Supabase Pro', 0, 'zerado enquanto no gratuito; US$ 25/mês depois'),
  ('Deslocamento de manutenção', 50, 'estimativa: uma ronda por mês');

-- ---------------------------------------------------------------------------
-- 6) Sessão em Postgres (connect-pg-simple). Antes era MemoryStore: todo
--    deploy deslogava todo mundo (docs/erros/2026-09-sessao-em-memoria.md).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid")
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
