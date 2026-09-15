-- Consequência direta da migration 033: fundador deixou de ser um plano de
-- catálogo, então a rota pública `GET /planos` parou de esconder plano
-- `fundador=true` atrás de PROGRAMA_FUNDADOR_ATIVO (ver src/financeiro/routes.js).
-- Sem essa checagem, um plano fundador legado com `ativo=true` passaria a
-- aparecer na vitrine como se fosse um plano normal — o que nunca foi a
-- intenção. Desativa (só vitrine; não cancela quem já assinou) qualquer
-- plano marcado fundador que ainda estivesse ativo.
UPDATE planos SET ativo = false WHERE fundador AND arquivado_em IS NULL;
