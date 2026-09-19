-- Créditos de indicação do dono de ponto (pedido do dono, 19/09/2026): toda
-- conta com papel `ponto` ganha um cupom de indicação próprio, e cada
-- comerciante que se cadastra com esse cupom E PAGA pelo menos uma vez vira
-- um crédito permanente pro dono do ponto. Ao acumular créditos suficientes,
-- a conta dele ganha o plano de anúncio de um tier acima, de graça — nunca
-- comissão em dinheiro (isso já existe pra vendedor, migration 019, e é
-- outro mecanismo, outra tabela).
--
-- DUAS TABELAS, não uma: o cupom (quem indica) e o crédito (o que essa
-- indicação rendeu) têm ciclos de vida diferentes — o cupom nasce uma vez
-- com o papel ponto; o crédito nasce um por indicado, ao longo do tempo.

-- O cupom do ponto NÃO é uma linha em `vendedores` (migration 019): aquela
-- tabela tem `chave_pix NOT NULL` (não faz sentido sem pagamento em dinheiro)
-- e `comissao_percentual` com CHECK 10-30 (migration 035) — usar ela aqui
-- forçaria um dono de ponto a carregar uma taxa de comissão que não
-- significa nada. Prefixo fixo "PT-" no código (nunca gerado por
-- gerarCupom(), que só produz letras+dígitos) garante que este namespace
-- nunca colide com codigo_cupom de vendedores — os dois são UNIQUE
-- separadamente, e a validação no cadastro precisa resolver sem ambiguidade.
CREATE TABLE cupons_ponto (
  conta_id int PRIMARY KEY REFERENCES anunciantes(id),
  codigo text NOT NULL UNIQUE,
  criado_em timestamptz NOT NULL DEFAULT now()
);

-- Uma linha por indicado que confirmou pelo menos UM pagamento — nunca por
-- ciclo de renovação (diferente de `comissoes`, que lança uma linha por
-- cobrança). O UNIQUE é o que faz o crédito ser permanente e contado uma
-- vez só: o webhook tenta inserir em toda renovação (mesmo padrão de
-- ON CONFLICT DO NOTHING de banco_horas, migration 058), e só a primeira
-- tentativa gera linha. Cancelamento do indicado depois não tira o crédito
-- — é conquista de quem indicou, não saldo do indicado.
CREATE TABLE indicacoes_pagas (
  id serial PRIMARY KEY,
  ponto_conta_id int NOT NULL REFERENCES anunciantes(id),
  indicado_conta_id int NOT NULL REFERENCES anunciantes(id),
  criado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ponto_conta_id, indicado_conta_id)
);
CREATE INDEX idx_indicacoes_pagas_ponto ON indicacoes_pagas (ponto_conta_id);

-- Motivo de cortesia dedicado (mesma coluna de sempre, `anunciantes.cortesia_motivo`,
-- migration 024): 'indicacao', ao lado de 'comodato' e 'bônus de ponto' já em uso.
-- Nenhuma coluna nova pra isso — é só uma string nova num campo que já existe.
