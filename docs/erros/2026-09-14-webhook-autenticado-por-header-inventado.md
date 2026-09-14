# Webhook autenticado por um header que o Checkout nunca mandou

**O que aconteceu.** O `POST /webhook/san-checkout` exigia um header
`X-Webhook-Secret` conferido contra uma `SAN_CHECKOUT_WEBHOOK_SECRET`. O San
Checkout não manda esse header e nenhuma versão do contrato descreveu esse
esquema: ele assina cada notificação com HMAC-SHA256 e manda
`X-Checkout-Signature` + `X-Checkout-Timestamp` (API.md 4.3.1). Junto vinha um
segundo furo: só `cobranca_confirmada` creditava um ciclo, mas a **primeira**
cobrança paga de uma assinatura chega como `criada` (API.md 4.3.4).

**Sintoma.** Nenhum — não chegou a rodar. Se tivesse ido ao ar: todo webhook
real recusado com 401, nenhum pagamento creditado, e todo cliente pagante
dependendo da conciliação diária, que ainda não tem cron. O fail-closed
funcionou (ninguém seria ativado sem pagar), mas a porta ficou fechada dos dois
lados.

**Causa.** O comentário do código citava `INTEGRACAO.md seção 6/6.1`. Esse
documento foi aposentado e hoje é só um redirecionamento pro `API.md` — que
existe, está no repositório do Checkout e descreve o esquema certo com exemplo
em três linguagens. É a lição de
`2026-09-14-contrato-do-checkout-suposto-em-vez-de-lido.md` repetindo: a
sessão de 14/09 leu o contrato e corrigiu endereçamento, rota e dedupe, mas não
reabriu a autenticação nem o vocabulário de eventos, porque nada ali estava
falhando de forma visível. Os testes fixavam o esquema inventado, então
estavam verdes medindo a coisa errada.

**Correção.** `webhookAutorizado` passou a verificar a assinatura HMAC com os
quatro passos do contrato (janela de 300s, corpo cru, HMAC com a
`SAN_CHECKOUT_KEY`, comparação em tempo constante); `express.json` guarda o
corpo cru no `verify`; `criada` e `cobranca_confirmada` creditam o ciclo pela
mesma dedupe; `SAN_CHECKOUT_WEBHOOK_SECRET` deixou de existir. Cinco testes
novos exercitam assinatura válida, chave errada, replay fora da janela, corpo
adulterado e ausência do corpo cru.

**Como não repetir.** Teste de integração que o próprio projeto escreve e
assina dos dois lados só prova que ele concorda consigo mesmo. Quando o outro
lado do contrato está num repositório que dá pra ler, a asserção tem que ser
derivada **de lá** — no mínimo, conferindo que o header que o teste manda é o
mesmo que o outro lado emite. E comentário que cita documento por nome e seção
envelhece: quando o documento é aposentado, o comentário vira armadilha.
