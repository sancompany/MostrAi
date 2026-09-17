-- NOMES E SUBTÍTULOS DOS PLANOS, definidos pelo dono em 17/09/2026.
--
--   tier        nome novo     subtítulo
--   ----------  ------------  -------------------------------------------------
--   (comodato)  Básico        Tudo o que você precisa para dar o primeiro passo.
--   essencial   Essencial     Mais recursos para avançar com facilidade.
--   destaque    Pro           Mais desempenho e recursos para ir além.
--   maximo      Prime         A experiência completa, sem limitações.
--
-- O `tier` NÃO muda. Ele é chave de regra em código (crédito de comodato só
-- vale em `destaque` e `maximo`, a grade da 047 casa por tier) e tem CHECK no
-- banco desde a migration 005. Renomear a chave junto com o rótulo é o jeito
-- clássico de trocar uma mudança de texto por uma quebra de regra — o nome é
-- do cliente, o tier é do código.
--
-- `rotulo` é campo de VITRINE (muda na hora, não alcança quem já assinou), e é
-- onde o subtítulo mora. O Essencial já tinha um; os outros três nasceram sem.

UPDATE planos SET nome = 'Básico',    rotulo = 'Tudo o que você precisa para dar o primeiro passo.' WHERE id = 'comodato-basico';
UPDATE planos SET nome = 'Essencial', rotulo = 'Mais recursos para avançar com facilidade.'         WHERE tier = 'essencial' AND id <> 'comodato-basico';
UPDATE planos SET nome = 'Pro',       rotulo = 'Mais desempenho e recursos para ir além.'           WHERE tier = 'destaque';
UPDATE planos SET nome = 'Prime',     rotulo = 'A experiência completa, sem limitações.'            WHERE tier = 'maximo';

-- Os benefícios de herança citam o plano anterior pelo NOME, então mudam
-- junto — "Tudo do Destaque" num card que se chama Prime é texto órfão, e
-- ninguém na cidade vai saber o que era o Destaque.
UPDATE beneficios SET texto = 'Tudo do Pro' WHERE texto = 'Tudo do Destaque';

-- "Tudo do Essencial" continua valendo: o nome do Essencial não mudou.
