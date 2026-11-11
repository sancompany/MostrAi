-- TICK — operador dentro da conta TICK (pedido do dono, 11/11/2026).
--
-- A ativação (código de 8 caracteres, uso único, 72 h, 5 tentativas, revogado
-- por "gerar código novo") continua a mesma; o que muda é ONDE ela termina:
-- em vez de criar uma senha só para a portaria, o código liga o cadastro de
-- operador à conta TICK de quem o usa (mesmo e-mail do convite). A partir
-- daí, a mesma sessão da conta abre a portaria — um login, um cadastro.
--
-- Uma conta, no máximo um operador (e vice-versa): UNIQUE. Nada existente
-- muda: operadores já ativos com senha própria seguem entrando por
-- /ticket/entrar até receberem um código novo e ligarem a conta.
ALTER TABLE operadores ADD COLUMN cliente_id bigint UNIQUE REFERENCES clientes(id);
ALTER TABLE operadores ADD COLUMN vinculado_em timestamptz;
ALTER TABLE operadores ADD CONSTRAINT operadores_vinculo_coerente
  CHECK ((cliente_id IS NULL) = (vinculado_em IS NULL));
