-- Reconstrução de Ofertas/Promoções (23/09/2026, pedido do dono): a promoção
-- deixa de ser segmentada por "logado vs deslogado" e passa a ser segmentada
-- por ELEGIBILIDADE COMERCIAL (novo assinante, assinante atual, ou todos) —
-- `mostrar_logados` não decide mais quem vê, e fica na tabela sem uso
-- (aditivo: colunas não são apagadas, ver CONSTRAINTS.md "Migrations são
-- aditivas"). `mostrar_admin` também para de ser lido — a Visão Geral passa
-- a mostrar toda promoção vigente automaticamente, sem opt-in por checkbox.

ALTER TABLE promocoes ADD COLUMN publico_elegivel text NOT NULL DEFAULT 'todos'
  CHECK (publico_elegivel IN ('novos', 'assinantes', 'todos'));

-- Formato da mídia (Parte B do pedido) — escolhido ANTES do upload, decide
-- a proporção esperada da imagem. Nulo = promoção sem mídia visual ainda
-- (o texto sozinho continua funcionando em todo lugar que a promoção aparece).
ALTER TABLE promocoes ADD COLUMN formato_midia text
  CHECK (formato_midia IS NULL OR formato_midia IN ('horizontal', 'quadrado', 'vertical'));

-- Status explícito (Parte F): Rascunho/Ativa/Encerrada substitui o checkbox
-- solto "ativa" no meio dos outros. Backfill a partir do valor atual de
-- `ativa` — promoção que já estava ligada vira 'ativa', as outras 'rascunho'
-- (nenhuma promoção existente tinha motivo de já estar "encerrada" por
-- controle manual; o que já passou da janela de compra continua sendo
-- calculado à parte, na leitura, a partir de `compra_fim`).
ALTER TABLE promocoes ADD COLUMN status text
  CHECK (status IN ('rascunho', 'ativa', 'encerrada'));
UPDATE promocoes SET status = CASE WHEN ativa THEN 'ativa' ELSE 'rascunho' END;
ALTER TABLE promocoes ALTER COLUMN status SET NOT NULL;
ALTER TABLE promocoes ALTER COLUMN status SET DEFAULT 'rascunho';
