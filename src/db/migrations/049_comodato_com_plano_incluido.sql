-- O COMODATO VIRA UMA ESCOLHA ENTRE DINHEIRO E TELA, desenhada pelo dono em
-- 17/09/2026. Conta inteira em docs/economia-da-rede.md seção 10.
--
--   OPÇÃO A — "Recebe os R$ 50"
--     R$ 50/mês na conta + plano básico incluído (45s/hora em até 3 pontos,
--     peça de até 15s, 1 criativo) = 13,5 horas de tela por mês.
--     NÃO pode assinar plano de catálogo enquanto estiver recebendo.
--
--   OPÇÃO B — "Troca os R$ 50 por tela"
--     Sem dinheiro, e o Essencial inteiro incluído (90s/hora em 3 pontos) =
--     27 horas de tela por mês, o dobro da opção A.
--     PODE assinar Destaque ou Máximo, com R$ 50 de abatimento.
--
-- POR QUE AS DUAS OPÇÕES SÃO JUSTAS, com número (régua: R$ 1,0185 por 1000
-- segundos, que é o preço de tabela do Essencial):
--
--   Opção A custa ao Mostraí  R$ 50,00 de caixa + R$ 49,50 de estoque = R$ 99,50
--   Opção B custa ao Mostraí  R$  0,00 de caixa + R$ 99,00 de estoque = R$ 99,00
--
-- As duas custam praticamente o mesmo, então o comerciante escolhe pelo que
-- prefere (dinheiro ou alcance) e não por qual é o negócio melhor. Não existe
-- arbitragem entre elas. E a B não tira nada do caixa, que no lançamento —
-- com R$ 2.500 de equipamento por ponto e receita zero — é o que importa.
--
-- O ABATIMENTO DE R$ 50 NO DESTAQUE E NO MÁXIMO NÃO É DESCONTO DE VERDADE, e
-- isso é uma qualidade, não um defeito: quem pega o Destaque desembolsa
-- R$ 199 mas deixa de receber R$ 50, então paga R$ 249 — a tabela cheia. O
-- preço de catálogo não é corroído, e nenhum comerciante da cidade vai poder
-- dizer que o vizinho comprou o Destaque pela metade. O único presente real
-- da grade é o Essencial da opção B, que devolve R$ 99 por R$ 50 abertos mão
-- (2x) — proporção que se defende sozinha para quem cede a parede e hospeda
-- R$ 2.500 de equipamento.
--
-- O QUE ESTA MIGRATION NÃO FAZ, de propósito:
--   · não dropa `cota_slots_hora` nem `desconto_comodato_percentual` — DROP
--     tem migration própria e autorização própria neste projeto. Ficam
--     zerados, sem efeito, até o dono mandar tirar.
--   · não decide se o dono do ponto aparece na TELA DELE. Hoje
--     `anunciantesElegiveis` exclui `dono_conta_id` da rotação paga daquele
--     ponto (item 28 de docs/PENDENCIAS.md). Com o plano incluído, essa
--     exclusão passa a queimar cobertura que ele ganhou — mas mudar isso muda
--     a playlist de todo mundo, então é decisão do dono, não da migration.

-- ---------------------------------------------------------------------------
-- 1. O plano básico do comodato
-- ---------------------------------------------------------------------------
-- `ativo = false` de propósito: mantém ele FORA da vitrine e fora do
-- `POST /anunciantes/:id/assinar`, que recusa plano inativo. Este plano não se
-- compra — ele vem junto do comodato, concedido pelo sistema. Plano inativo
-- continua existindo e valendo para quem está nele (é a mesma regra que
-- protege quem assinou uma versão aposentada).
INSERT INTO planos (
  id, tier, nome, valor_mensal, compromisso_meses, frequencia_hora, cobertura,
  ativo, destaque_no_site, limite_criativos, fundador,
  segundos_por_hora, duracao_maxima_segundos, pontos_incluidos
) VALUES (
  'comodato-basico', 'essencial', 'Comodato — plano básico', 0, 1, 3, 'todos_pontos',
  false, false, 1, false,
  45, 15, 3
) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. O que cada opção de comodato dá
-- ---------------------------------------------------------------------------
ALTER TABLE planos_ponto ADD COLUMN plano_incluido_id text REFERENCES planos(id);
ALTER TABLE planos_ponto ADD COLUMN permite_assinar boolean NOT NULL DEFAULT false;
ALTER TABLE planos_ponto ADD COLUMN desconto_assinatura_reais numeric NOT NULL DEFAULT 0
  CHECK (desconto_assinatura_reais >= 0);

-- ---------------------------------------------------------------------------
-- 3. O crédito que a conta carrega
-- ---------------------------------------------------------------------------
-- Fica na CONTA, não no plano, porque é direito de quem cedeu a parede e não
-- característica do produto. `valorMensalDaConta` abate ele do preço.
--
-- NÃO ACUMULA por ponto nesta versão: dono de três pontos tem crédito de
-- R$ 50, não de R$ 150. É a escolha conservadora — soltar depois é uma linha,
-- apertar depois é tirar direito de quem já tem. Nenhum dos três pontos
-- previstos tem dono repetido, então isso não morde hoje.
ALTER TABLE anunciantes ADD COLUMN credito_comodato_mensal numeric NOT NULL DEFAULT 0
  CHECK (credito_comodato_mensal >= 0);

-- ---------------------------------------------------------------------------
-- 4. As duas opções, reescritas
-- ---------------------------------------------------------------------------
-- `cota_slots_hora` vai a zero nas duas: o autoanúncio na própria tela era
-- medido em repetições e valia ~R$ 5,50 (opção A) ou ~R$ 16,50 (opção B) por
-- mês. Trocar os R$ 50 por aquilo era um negócio 4,5x contra o comerciante —
-- ninguém que fizesse a conta aceitaria, e quem aceitasse sem fazer ia se
-- sentir passado para trás. O plano incluído põe ele na REDE, não só na
-- própria parede, e vale o que os R$ 50 valem.
UPDATE planos_ponto SET
  nome = 'Recebe os R$ 50',
  chamada = 'R$ 50 por mês na sua conta, todo mês, e o seu negócio na rede em até 3 pontos.',
  ajuda_custo_mensal = 50,
  cota_slots_hora = 0,
  plano_incluido_id = 'comodato-basico',
  permite_assinar = false,
  desconto_assinatura_reais = 0,
  beneficios = ARRAY[
    'Tela, player e instalação por nossa conta',
    'R$ 50 por mês de ajuda de custo',
    '13,5 horas de tela por mês pro seu negócio, em até 3 pontos da rede',
    'Peça de até 15 segundos',
    'Sem mensalidade e sem operar nada'
  ],
  ordem = 1
 WHERE id = 'ajuda-custo';

UPDATE planos_ponto SET
  nome = 'Troca os R$ 50 por tela',
  chamada = 'Abre mão da ajuda de custo e leva o plano Essencial inteiro, sem pagar nada.',
  ajuda_custo_mensal = 0,
  cota_slots_hora = 0,
  plano_incluido_id = (SELECT id FROM planos WHERE tier = 'essencial' AND compromisso_meses = 1 AND ativo LIMIT 1),
  permite_assinar = true,
  desconto_assinatura_reais = 50,
  beneficios = ARRAY[
    'Tela, player e instalação por nossa conta',
    'O plano Essencial inteiro, de graça: 27 horas de tela por mês em 3 pontos',
    'O dobro da tela da outra opção',
    'Peça de até 15 segundos',
    'Pode subir pro Destaque ou pro Máximo com R$ 50 de abatimento',
    'Sem mensalidade e sem operar nada'
  ],
  ordem = 2
 WHERE id = 'mais-cota';

-- O percentual de comodato por linha da grade (RN-32) fica zerado: quem manda
-- agora é o crédito em reais da conta. Dois descontos de comodato ao mesmo
-- tempo seria abatimento dobrado sem ninguém ter decidido isso.
UPDATE planos SET desconto_comodato_percentual = NULL;
