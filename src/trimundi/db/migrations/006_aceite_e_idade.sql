-- Trimundi — aceite dos Termos de Uso e da Política de Privacidade e
-- proteção contra menores (pedido do dono, 10/11/2026).
--   · conta: só para maiores de 18 anos; o aceite guarda a versão, quando,
--     de onde (IP) e por qual navegador — prova do que foi aceito;
--   · pedido de edição com classificação etária: quem compra declara que
--     cada participante tem a idade mínima e vai mostrar documento com foto.

ALTER TABLE clientes ADD COLUMN termos_versao text CHECK (char_length(termos_versao) <= 20);
ALTER TABLE clientes ADD COLUMN termos_aceitos_em timestamptz;
ALTER TABLE clientes ADD COLUMN maioridade_declarada_em timestamptz;
ALTER TABLE clientes ADD COLUMN aceite_ip text CHECK (char_length(aceite_ip) <= 64);
ALTER TABLE clientes ADD COLUMN aceite_user_agent text CHECK (char_length(aceite_user_agent) <= 300);
-- Aceite e maioridade andam juntos: um sem o outro não existe.
ALTER TABLE clientes ADD CONSTRAINT clientes_aceite_completo
  CHECK ((termos_aceitos_em IS NULL) = (maioridade_declarada_em IS NULL) AND (termos_aceitos_em IS NULL) = (termos_versao IS NULL));

ALTER TABLE pedidos ADD COLUMN declaracao_idade_em timestamptz;
