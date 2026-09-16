-- O dono pediu (16/09/2026) que travessão saísse de todo texto visível do
-- site. A varredura daquele dia leu `public/`, e por isso não alcançou este:
-- o rótulo do card de plano é DADO, não markup — vem de `planos.rotulo` e
-- aparece na vitrine em cima do preço. Só a pontuação muda; a palavra que o
-- dono escolheu pro rótulo fica como está.
UPDATE planos SET rotulo = replace(rotulo, ' — ', ', ') WHERE rotulo LIKE '%—%';
