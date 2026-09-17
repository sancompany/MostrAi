-- REMOÇÕES AUTORIZADAS PELO DONO em 17/09/2026. Migration própria, como
-- manda a regra do projeto: DROP nunca viaja de carona numa aditiva.
--
-- 1. TRAVA DE PREÇO. Autorização literal: "não irei modificar muito os planos
--    então pode retirar o plano travado". Ela existia pra proteger quem
--    assinou de um aumento futuro; com a grade fechada e sem previsão de
--    mexer, virou máquina parada. E carregava um defeito que a revisão de
--    17/09 mediu: `aplicarCicloPago` decidia a trava por
--    `anunciante.plano_id === plano.id`, então migrar a conta pra versão nova
--    de um plano REESCREVIA a trava com o preço novo — o contrário exato do
--    direito que ela prometia.
--
--    Sai junto o rótulo "Preço fundador, nunca muda", que 9 dos 12 planos
--    carregam na vitrine HOJE. Rótulo e mecanismo têm que sair no mesmo
--    lugar: deixar o texto sem o código é a mentira que este projeto já
--    corrigiu três vezes esta semana.
--
-- 2. BÔNUS DE TELA APÓS N MESES. Autorização literal: "esse de receber a tela
--    após tantos meses retire essa função". Nunca esteve ligado em plano
--    nenhum (`ponto_apos_meses` está nulo em todos), então nenhuma conta
--    perde direito adquirido. O bônus INVERSO — dono de ponto que ganha plano
--    de anúncio pelo tempo de comodato — continua: é contrapartida de
--    contrato, não brinde.
--
-- 3. `frequencia_hora` continua por enquanto. A grade nova (047) preenche
--    `segundos_por_hora` em todo plano ativo, e só depois disso a coluna
--    antiga pode cair sem deixar plano sem cota. Fica pra uma migration
--    própria, quando a 047 estiver em produção e conferida.

ALTER TABLE planos DROP COLUMN preco_travado;
ALTER TABLE anunciantes DROP COLUMN valor_mensal_travado;

UPDATE planos SET rotulo = NULL WHERE rotulo ILIKE '%fundador%' OR rotulo ILIKE '%nunca muda%';

ALTER TABLE planos DROP COLUMN ponto_apos_meses;
ALTER TABLE anunciantes DROP COLUMN ponto_bonus_resgatado_em;
