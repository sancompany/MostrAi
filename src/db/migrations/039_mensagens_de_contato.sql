-- POST /contato só tentava enviar e-mail e respondia ok; se o SMTP falhasse
-- (como falhou nesta rodada, senha de app do Gmail expirada), a mensagem do
-- titular se perdia sem nenhum rastro — inclusive pedidos de dados pessoais
-- (LGPD art. 18), que esse formulário também atende (furos.md, seção Média).
-- Agora a mensagem é gravada antes de tentar o e-mail: falha de SMTP perde o
-- aviso, não perde o dado.
CREATE TABLE mensagens_contato (
  id serial PRIMARY KEY,
  nome text NOT NULL,
  email text NOT NULL,
  telefone text,
  mensagem text NOT NULL,
  email_enviado boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
