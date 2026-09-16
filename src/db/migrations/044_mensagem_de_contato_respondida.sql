-- A migration 039 passou a GRAVAR a mensagem de contato antes de tentar o
-- e-mail, pra que uma falha de SMTP perdesse o aviso e não o dado. Só que
-- nenhuma tela lê essa tabela: o dado ficou salvo e invisível, que é o mesmo
-- furo por outra porta — e /contato.html é o canal declarado de pedido do
-- titular (LGPD art. 18), que tem prazo legal pra responder.
--
-- A aba nova no admin mostra a lista. Esta coluna é o que a torna uma FILA e
-- não um mural: sem marcar o que já foi respondido, a tela vira uma lista que
-- se relê para sempre e para de ser olhada.
ALTER TABLE mensagens_contato ADD COLUMN respondida_em timestamptz;
