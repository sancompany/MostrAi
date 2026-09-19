-- Confirmação de e-mail por código: o e-mail é o login e o canal de
-- recuperação de senha — se estiver errado, a pessoa fica sem entrar e sem
-- forma de recuperar sozinha. Pedido do dono, 19/09/2026, pra ter controle
-- maior sobre isso (não é sobre reduzir passos do cadastro).
--
-- Não bloqueia login nem uso da conta — isso reabriria a fila de aprovação
-- que o dono já decidiu não existir (16/09/2026, ver src/anunciantes/routes.js).
-- É só um estado que o front mostra enquanto não confirmado, com um aviso
-- pra digitar o código.
--
-- DEFAULT true na criação da coluna pra não acender o aviso em conta que já
-- usa a plataforma há semanas; muda pra false logo depois, então toda conta
-- NOVA (cujo INSERT não cita a coluna) nasce sem confirmar.
ALTER TABLE anunciantes ADD COLUMN email_confirmado boolean NOT NULL DEFAULT true;
ALTER TABLE anunciantes ALTER COLUMN email_confirmado SET DEFAULT false;

-- Código de uso único e validade curta — mesmo padrão de tokens_senha
-- (migration 015), só que numérico (pra digitar, não clicar num link).
CREATE TABLE tokens_confirmacao_email (
  id serial PRIMARY KEY,
  anunciante_id int NOT NULL REFERENCES anunciantes(id) ON DELETE CASCADE,
  codigo text NOT NULL,
  expira_em timestamptz NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_tokens_confirmacao_email_conta ON tokens_confirmacao_email(anunciante_id);
