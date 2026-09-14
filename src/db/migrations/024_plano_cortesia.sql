-- Plano liberado de graça pelo admin (cortesia).
--
-- Por quê: o dono precisa poder pôr alguém no ar sem cobrar — parceria, troca,
-- teste com um comércio, o primeiro cliente de uma rua nova. Isso já era
-- possível na marra, editando `plano_id` e `data_expiracao` à mão no admin, e é
-- justamente esse "na marra" que criava o problema: a conta ficava idêntica a
-- uma pagante. O resumo dizia "5 anunciantes ativos" e três não pagavam nada,
-- sem nenhum lugar no sistema dizendo isso.
--
-- A receita nunca foi afetada (ela sai de `cobrancas_confirmadas`, e cortesia
-- não gera cobrança). O que faltava era a CONTAGEM ser honesta.
--
-- ADITIVA. Não altera nem apaga nada.

ALTER TABLE anunciantes ADD COLUMN plano_cortesia boolean NOT NULL DEFAULT false;

-- Por que foi liberado. Sem isso, seis meses depois ninguém lembra se era
-- parceria, teste ou cortesia de lançamento — e a hora de decidir se renova
-- chega sem a informação que decide.
ALTER TABLE anunciantes ADD COLUMN cortesia_motivo text;
