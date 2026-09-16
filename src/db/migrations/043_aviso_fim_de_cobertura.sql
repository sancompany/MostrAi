-- Aviso de que a cobertura está acabando (seção F, item 16).
--
-- Quem troca de plano paga um PEDIDO AVULSO, não uma assinatura: a cobertura
-- vale pelo período contratado e some sozinha, porque não existe recorrência
-- pra renovar. Sem aviso nenhum, o anúncio simplesmente para de rodar num dia
-- qualquer e o cliente descobre pelo silêncio.
--
-- A coluna guarda PARA QUAL expiração o aviso já saiu, não um booleano nem a
-- data do envio. Assim o reenvio se resolve sozinho: expiração nova (outra
-- troca, ou um plano novo assinado) é um valor diferente do guardado, e o
-- aviso volta a valer sem nenhuma rotina de limpeza.
ALTER TABLE anunciantes ADD COLUMN aviso_fim_cobertura_para timestamptz;

-- Contador no relato da conciliação, ao lado de `expiradas`: sem isto o
-- número de avisos enviados existiria só no stdout do cron, que é onde
-- ninguém olha. A Visão geral do admin lê desta linha.
ALTER TABLE conciliacoes ADD COLUMN avisados int NOT NULL DEFAULT 0;
