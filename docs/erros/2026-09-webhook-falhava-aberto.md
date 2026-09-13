# Webhook de pagamento aceitava qualquer POST sem segredo configurado

**Sintoma.** Com `SAN_CHECKOUT_WEBHOOK_SECRET` vazio no `.env`, o endpoint
`POST /webhook/san-checkout` processava qualquer corpo. Como o payload é só
`{tipo, planoId, evento}` e o id da assinatura aparece na URL de checkout do
próprio anunciante, dava para ativar uma conta sem pagar nada.

**Causa raiz.** A função de autorização foi escrita para *liberar* quando o
segredo não estivesse configurado ("trava opcional"), com a intenção de não
quebrar até combinar o segredo dos dois lados. Segurança que falha aberta.

**Correção.** Falha fechado: sem segredo configurado, ninguém entra.
Comparação em tempo constante (`crypto.timingSafeEqual`). Idempotência por
evento (tabela `webhooks_processados`) e transação nas três escritas.

**Guarda.** `tests/seguranca.test.js` — "webhook falha fechado quando o
segredo não está configurado".

**Como evitar na origem.** Nenhuma verificação de credencial tem caminho
"se não configurado, passa". Se a env falta, o serviço recusa e loga — e a
falta aparece no primeiro teste em vez de em produção.

**Ecossistema:** sim — vale para qualquer projeto que receba webhook do
Checkout. Entrada sugerida no catálogo compartilhado.
