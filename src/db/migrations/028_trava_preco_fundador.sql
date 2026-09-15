-- Trava o preço dos planos que já prometem preço travado.
--
-- Nove planos da grade carregam o rótulo "Preço fundador — nunca muda" e
-- estavam com `preco_travado = false`. O site prometia, por escrito e na
-- vitrine, um preço que o sistema não segurava: na renovação seguinte o
-- assinante pagaria o valor novo do plano, contrariando o que leu na hora de
-- comprar. Promessa publicada que o código não cumpre é a pior das três
-- saídas possíveis — pior que tirar o rótulo e pior que reescrevê-lo.
--
-- Decisão do dono em 15/09/2026: travar de verdade. É barato agora (zero
-- assinantes) e o compromisso é exatamente o que a vitrine já anunciava.
--
-- O que `preco_travado` faz: quando a primeira cobrança do plano é confirmada,
-- `anunciantes.valor_mensal_travado` guarda o valor daquele momento, e toda
-- renovação cobra esse valor mesmo que o plano suba de preço depois
-- (src/financeiro/san-checkout.js, aplicarCicloPago). Não alcança quem assinar
-- um plano diferente depois — é por assinatura, não por conta.
--
-- ADITIVA. Só liga uma flag; nenhuma coluna alterada ou removida.

UPDATE planos
   SET preco_travado = true
 WHERE rotulo ILIKE '%fundador%'
   AND NOT preco_travado;
