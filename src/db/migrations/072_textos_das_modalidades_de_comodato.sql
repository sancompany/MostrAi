-- Textos das duas modalidades de comodato (rodada de integridade do admin,
-- 23/09/2026). A migration 063 repontou o que cada modalidade DÁ — quem
-- recebe os R$ 50 passou a ganhar o plano Inicial (60s/hora em 1 ponto,
-- ~6h/mês); quem troca os R$ 50 por tela passou a ganhar o Básico
-- (45s/hora em até 3 pontos, ~14h/mês) — mas não reescreveu o que cada
-- modalidade PROMETE. O formulário "Seja um ponto" (public/modos.js) e o
-- convite (public/convite.page.js) mostram `chamada` e `beneficios` direto
-- desta tabela, então o comerciante lia:
--   · "Recebe os R$ 50": 13,5 horas em até 3 pontos (é ~6h, na própria tela);
--   · "Troca os R$ 50 por tela": "o plano Essencial inteiro, 27 horas" e
--     "pode subir pro Destaque ou pro Máximo" (é o Básico, ~14h; e os nomes
--     dos pagos são Essencial/Pro/Prime, com crédito nos três desde esta
--     rodada — ver san-checkout.js#TIERS_COM_CREDITO).
-- Promessa de oferta diferente do que o sistema entrega.
--
-- GUARDADA de propósito: cada campo só muda se ainda tiver EXATAMENTE o texto
-- que a migration 049 gravou. Se o dono editou algum deles pela antiga tela
-- Configurações > Comodato, a edição dele fica — nada é sobrescrito às cegas.
-- Horas: mesma conta de src/lib/pacing.js#horasDeTelaPorMes (12h abertas/dia,
-- 30 dias), arredondada como a vitrine arredonda.
--
-- Sem travessão nos textos: é texto público do site (migration 042).

-- "1 ponto (pode ser a sua própria tela)" e não "na sua própria tela": o
-- motor não amarra o ponto do Inicial à tela do dono — vale a escolha de
-- pontos normal (PUT /anunciantes/me/pontos aceita o próprio ponto) ou o
-- sorteio. Prometer "na sua tela" seria prometer o que o sistema não garante.
UPDATE planos_ponto
   SET chamada = 'R$ 50 por mês na sua conta, todo mês, e o seu negócio em 1 ponto da rede.'
 WHERE id = 'ajuda-custo'
   AND chamada = 'R$ 50 por mês na sua conta, todo mês, e o seu negócio na rede em até 3 pontos.';

UPDATE planos_ponto
   SET beneficios = ARRAY[
     'Tela, player e instalação por nossa conta',
     'R$ 50 por mês de ajuda de custo',
     'Plano Inicial: cerca de 6 horas de tela por mês pro seu negócio, em 1 ponto da rede (pode ser a sua própria tela)',
     'Peça de até 15 segundos',
     'Sem mensalidade e sem operar nada'
   ]
 WHERE id = 'ajuda-custo'
   AND beneficios = ARRAY[
     'Tela, player e instalação por nossa conta',
     'R$ 50 por mês de ajuda de custo',
     '13,5 horas de tela por mês pro seu negócio, em até 3 pontos da rede',
     'Peça de até 15 segundos',
     'Sem mensalidade e sem operar nada'
   ];

UPDATE planos_ponto
   SET chamada = 'Abre mão da ajuda de custo e leva o plano Básico, sem pagar nada.'
 WHERE id = 'mais-cota'
   AND chamada = 'Abre mão da ajuda de custo e leva o plano Essencial inteiro, sem pagar nada.';

UPDATE planos_ponto
   SET beneficios = ARRAY[
     'Tela, player e instalação por nossa conta',
     'Plano Básico de graça: cerca de 14 horas de tela por mês em até 3 pontos da rede',
     'Mais que o dobro da tela da outra opção',
     'Peça de até 15 segundos',
     'Pode assinar o Essencial, o Pro ou o Prime com R$ 50 de abatimento',
     'Sem mensalidade e sem operar nada'
   ]
 WHERE id = 'mais-cota'
   AND beneficios = ARRAY[
     'Tela, player e instalação por nossa conta',
     'O plano Essencial inteiro, de graça: 27 horas de tela por mês em 3 pontos',
     'O dobro da tela da outra opção',
     'Peça de até 15 segundos',
     'Pode subir pro Destaque ou pro Máximo com R$ 50 de abatimento',
     'Sem mensalidade e sem operar nada'
   ];
