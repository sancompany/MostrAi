-- Item 4 da spec, redesenhado: "fundador" deixa de ser um PLANO separado
-- (fora da grade, atrás de PROGRAMA_FUNDADOR_ATIVO, com vagas e trava de
-- preço) e passa a ser um STATUS da CONTA. Motivo: a partir do item 9
-- (migration 026), todo plano já trava o preço de quem assinou — a trava
-- que o plano fundador usava para "nunca mudar de preço" não distingue mais
-- nada, porque isso já é assim para qualquer plano. O que sobra de especial
-- num fundador é um desconto A MAIS, dado a UMA conta específica, à mão pelo
-- dono — não um plano de catálogo.
--
-- `fundador_desconto_percentual` e `fundador_compromisso_minimo` são
-- decisão do dono por conta (marca quem quiser, com o desconto e o piso de
-- compromisso que quiser) — não têm default de negócio, só a validação de
-- faixa.
ALTER TABLE anunciantes ADD COLUMN fundador boolean NOT NULL DEFAULT false;
ALTER TABLE anunciantes ADD COLUMN fundador_desconto_percentual numeric
  CHECK (fundador_desconto_percentual IS NULL OR (fundador_desconto_percentual > 0 AND fundador_desconto_percentual <= 100));
ALTER TABLE anunciantes ADD COLUMN fundador_compromisso_minimo integer
  CHECK (fundador_compromisso_minimo IS NULL OR fundador_compromisso_minimo > 0);

-- Item 8 da spec: desconto para conta comodato (papel 'ponto') nos planos de
-- anunciante, valor por LINHA da grade (cada plano tem o seu). Fica em
-- CAMPOS_CONTRATO (como valor_mensal) — editar no lugar mudaria o que quem
-- já assinou está pagando; muda só por "nova versão" (migration 026).
ALTER TABLE planos ADD COLUMN desconto_comodato_percentual numeric
  CHECK (desconto_comodato_percentual IS NULL OR (desconto_comodato_percentual > 0 AND desconto_comodato_percentual <= 100));
