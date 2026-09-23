-- Separar comodato de plano comercial (23/09/2026, decisão do dono e do GPT,
-- em resposta a um furo achado na reconstrução de Contas).
--
-- O MODELO ATÉ AQUI: uma conta tinha UM campo, `anunciantes.plano_id`, pra
-- representar duas coisas diferentes — o plano comercial de verdade
-- (Essencial/Pro/Prime, pago ou cortesia) E o benefício do comodato
-- (Inicial/Básico, que o dono de ponto ganha por ceder a parede). Quando as
-- duas coexistiam, só uma cabia no campo — sempre a comercial, por regra de
-- guarda em `ajustarPlanoIncluido` (src/pontos/comodato.js). Cancelar o
-- plano comercial então "descobria" o campo inteiro: o comodato, que nunca
-- deveria ter saído dali, simplesmente não estava mais escrito em lugar
-- nenhum.
--
-- O MODELO NOVO: dois campos independentes.
--   `anunciantes.plano_id`           = plano comercial (nenhum/Essencial/Pro/
--                                      Prime), pago ou cortesia — nunca mais
--                                      um produto de comodato.
--   `anunciantes.comodato_plano_id`  = comodato (nenhum/Inicial/Básico),
--                                      espelho do que a modalidade do(s)
--                                      ponto(s) da conta já diz — nunca
--                                      sobrescrito por plano comercial, nunca
--                                      "devolvido": ele nunca sai.
--
-- Regra de negócio (decisão do dono): Básico coexiste com qualquer plano
-- comercial, sempre. Inicial NÃO coexiste com plano comercial — quem tenta
-- comprar ou conceder Essencial/Pro/Prime numa conta em Inicial é bloqueado
-- e mandado trocar a modalidade primeiro (src/pontos/comodato.js
-- #bloqueiaPlanoComercial, já reusa `planos_ponto.permite_assinar`, que já
-- existia com exatamente essa régua desde a migration 049 — só nunca tinha
-- sido aplicada fora do autoatendimento). Nenhuma conversão automática
-- escondida.
--
-- ADITIVA: nenhuma coluna apagada. `plano_id`/`plano_cortesia`/
-- `cortesia_motivo` continuam existindo com o mesmo sentido de sempre pro
-- que sempre foi plano comercial de verdade — só o uso indevido como
-- "onde mora o comodato" é desfeito aqui.

ALTER TABLE anunciantes ADD COLUMN comodato_plano_id text REFERENCES planos(id);
-- Sem índice de propósito: FK pra `planos`, catálogo de poucas dezenas de
-- linhas — mesmo raciocínio da migration 032 (`plano_id`, que aponta pra
-- mesma tabela, também não tem índice).

-- MIGRAÇÃO DE DADOS, em duas etapas — nada aqui é chute: as duas fontes são
-- a verdade viva (a modalidade que o ponto tem HOJE) e o que já estava
-- gravado (pra quem, por algum motivo, não tem mais ponto casando).
--
-- Etapa 1 — deriva `comodato_plano_id` da modalidade REAL de cada ponto, pra
-- TODA conta que tem ponto numa modalidade com plano incluído. Isso vale
-- tanto pra quem hoje já usava `plano_id` como "marcador de comodato" quanto
-- pra quem tinha um plano comercial de verdade por cima (essas contas, sob a
-- regra antiga, tinham o comodato SILENCIOSAMENTE invisível enquanto o
-- comercial ocupava o campo — esta etapa recupera esse dado, que a
-- modalidade do ponto sempre soube, mesmo sem nunca ter sido escrito em
-- `anunciantes`). Dono de mais de um ponto em modalidades diferentes: fica
-- com a melhor (`ORDER BY pp.ordem DESC`, mesmo critério — "não empobrece" —
-- de `credito_comodato_mensal`, que já pega o MAIOR entre os pontos).
UPDATE anunciantes a
   SET comodato_plano_id = m.plano_incluido_id
  FROM (
    SELECT DISTINCT ON (p.anunciante_id) p.anunciante_id, pp.plano_incluido_id
      FROM pontos p
      JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
     WHERE p.anunciante_id IS NOT NULL AND pp.plano_incluido_id IS NOT NULL
     ORDER BY p.anunciante_id, pp.ordem DESC
  ) m
 WHERE a.id = m.anunciante_id;

-- Etapa 2 — quem tinha `cortesia_motivo = 'comodato'` (o sinal explícito de
-- "isto aqui é comodato, não plano comercial de verdade") e por algum
-- motivo NÃO tem ponto casando hoje (ponto excluído, ou nunca existiu por
-- alguma migração de dado anterior): sem ponto vivo, a Etapa 1 não achou
-- nada pra essa conta — usa o que já estava gravado em `plano_id`, em vez de
-- perder o benefício. `COALESCE` não sobrescreve quem a Etapa 1 já resolveu.
UPDATE anunciantes
   SET comodato_plano_id = COALESCE(comodato_plano_id, plano_id)
 WHERE cortesia_motivo = 'comodato';

-- Etapa 3 — limpa o campo comercial de quem só tinha comodato lá (o sinal
-- de que era só comodato SEMPRE foi `cortesia_motivo = 'comodato'` — nunca
-- houve outro jeito de gravar isso, então não há ambiguidade aqui: toda
-- linha com esse motivo, e só essas, tinha o campo comercial ocupado pelo
-- comodato). Vira "nenhum plano comercial", que é o que sempre foi de
-- verdade.
UPDATE anunciantes
   SET plano_id = NULL, plano_cortesia = false, cortesia_motivo = NULL, data_expiracao = NULL
 WHERE cortesia_motivo = 'comodato';
