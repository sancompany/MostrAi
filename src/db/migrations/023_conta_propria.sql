-- Conta de anunciante do próprio Mostraí, operada de dentro do admin.
--
-- Por quê: a rede precisa anunciar a si mesma — chamada para novos
-- anunciantes, aviso de vaga de ponto, institucional. Hoje isso só seria
-- possível criando uma conta comum e assinando um plano de mentira, o que
-- sujaria a receita e a margem com dinheiro que não existe.
--
-- O desenho reusa o que já existe em vez de criar máquina paralela: continua
-- sendo uma linha em `anunciantes`, entra na mesma playlist, gera os mesmos
-- contadores de exibição. Muda em três pontos, e só neles:
--   1. não precisa de plano — a frequência vem de `frequencia_dia_propria`;
--   2. não tem teto de criativos (o do plano é no máximo 3);
--   3. nunca gera cobrança, então não aparece na receita nem na margem.
--
-- Diferente da cota de autoanúncio do ponto, que só roda nas telas daquele
-- comércio, a conta própria roda na rede inteira — é anúncio da rede, não
-- contrapartida de comodato.
--
-- ADITIVA. Não altera nem apaga nada.

ALTER TABLE anunciantes ADD COLUMN conta_propria boolean NOT NULL DEFAULT false;

-- Quantas vezes por dia o anúncio próprio aparece em cada tela. O gerador
-- divide pelas horas de funcionamento, igual faz com `planos.frequencia_dia`.
ALTER TABLE anunciantes ADD COLUMN frequencia_dia_propria int
  CHECK (frequencia_dia_propria IS NULL OR frequencia_dia_propria > 0);

-- Só pode existir UMA. Sem isto, dois cliques no admin criam duas contas
-- próprias e o inventário da rede passa a ser dividido entre elas sem que
-- ninguém perceba — o tipo de erro que só aparece olhando a playlist.
CREATE UNIQUE INDEX idx_uma_conta_propria ON anunciantes ((conta_propria)) WHERE conta_propria;
