-- BENEFÍCIOS DO CARD, rodada de revisão do dono (17/09/2026).
--
-- 1) "Painel com cada exibição confirmada, ponto a ponto" -> "Dashboard
--    intuitivo". A frase antiga descrevia a mecânica; o dono quer a promessa.
--    O painel continua mostrando exibição confirmada ponto a ponto — o que
--    muda é como isso é vendido, não o que é entregue.
--
-- 2) "Comprovante em planilha pra baixar quando quiser" sai do card.
--    DESATIVADO, não apagado: `beneficios.ativo = false` tira do site e
--    mantém o vínculo com os planos (o SELECT da vitrine filtra por `ativo`).
--    Apagar a linha derrubaria `planos_beneficios` junto, e voltar atrás
--    viraria recadastro em 12 planos. A exportação em CSV continua no painel
--    — o que saiu foi o anúncio dela, não a função.
--
-- Texto de benefício é do CATÁLOGO: muda nos 12 planos de uma vez, sem versão
-- nova de plano. É de vitrine, não de contrato — ninguém perde nada do que
-- assinou porque a frase do card mudou.

UPDATE beneficios SET texto = 'Dashboard intuitivo'
 WHERE texto = 'Painel com cada exibição confirmada, ponto a ponto';

UPDATE beneficios SET ativo = false
 WHERE texto = 'Comprovante em planilha pra baixar quando quiser';
