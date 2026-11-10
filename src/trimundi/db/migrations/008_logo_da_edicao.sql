-- TICK — logo do evento (pedido do dono, 10/11/2026): a ficha do Admin ganha
-- "Identidade visual", com banner e logo. O banner já existia; o logo entra
-- na MESMA tabela de imagens, pelo mesmo caminho de envio e o mesmo
-- armazenamento (o bucket da Mostraí, pasta trimundi/). Um por edição, como
-- o banner: enviar outro substitui.

ALTER TABLE edicao_imagens DROP CONSTRAINT edicao_imagens_tipo_check;
ALTER TABLE edicao_imagens ADD CONSTRAINT edicao_imagens_tipo_check CHECK (tipo IN ('banner', 'logo', 'galeria'));
CREATE UNIQUE INDEX ux_edicao_imagens_logo ON edicao_imagens (edicao_id) WHERE tipo = 'logo';
