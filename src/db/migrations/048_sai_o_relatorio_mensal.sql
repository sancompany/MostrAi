-- SAI O RELATÓRIO MENSAL POR E-MAIL, a pedido do dono em 17/09/2026:
-- "benefícios como relatório mensal, não, não aumente meu trabalho sobre esse
-- tipo de coisa".
--
-- A regra que ele deu vale além desta linha, e fica registrada aqui porque é
-- critério de aceite pra todo benefício futuro:
--
--   PODE — promessa que não gera trabalho recorrente (mesmo que o sistema não
--   verifique). Custa uma frase e nada mais.
--   NÃO PODE — promessa que vira tarefa dele TODO MÊS, pra TODO cliente. Um
--   relatório mensal por e-mail no Máximo é, por cliente, doze tarefas por
--   ano que ninguém automatizou. Trinta clientes no Máximo são 360 tarefas
--   por ano — e o primeiro mês em que ele não mandar, o benefício vira
--   reclamação com prova por escrito.
--
-- O que NÃO some junto: o painel já mostra cada exibição confirmada e já
-- exporta CSV (benefício do Essencial, esse tem código atrás). O relatório
-- mensal não acrescentava dado nenhum — só acrescentava uma entrega manual.
--
-- O Máximo fica com "Tudo do Destaque" mais os números derivados da vitrine
-- (180 horas de tela/mês, 10 pontos, peça de até 30s, 3 criativos), que é
-- cartão completo. Benefício exclusivo novo pro Máximo está em decisão do
-- dono — ver docs/PENDENCIAS.md, seção F.

DELETE FROM planos_beneficios
 WHERE beneficio_id IN (SELECT id FROM beneficios WHERE texto = 'Relatório do mês por e-mail, sem abrir o painel');

DELETE FROM beneficios WHERE texto = 'Relatório do mês por e-mail, sem abrir o painel';
