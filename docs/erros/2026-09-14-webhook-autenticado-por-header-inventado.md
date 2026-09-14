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

**Causa.** A integração inteira foi escrita a partir de
`claude/vitrina-san-checkout-requisitos.md` — um resumo do contrato escrito à
mão dentro deste repositório, herdado da Vitrina, nunca conferido contra a
fonte. Esse arquivo é a origem dos quatro defeitos já achados no caminho do
dinheiro, e é possível apontar a linha de cada um:

- **Autenticação:** o documento não diz **nada** sobre como o webhook é
  autenticado. A única pista é a seção 5, "`X-Checkout-Key` compartilhada
  (mesma chave nos dois sentidos)". Isso está certo — o segredo do HMAC é a
  própria `X-Checkout-Key` — mas sem o mecanismo, e o buraco foi preenchido
  inventando um header `X-Webhook-Secret`.
- **Vocabulário de eventos:** a tabela da seção 3 classifica `criada`
  explicitamente como "só registrado, sem ação automática". Não foi descuido;
  foi uma decisão errada escrita como se fosse o contrato.
- **Endereçamento e prefixo da rota** (corrigidos em 14/09): a seção 4 manda
  `POST {SAN_CHECKOUT_BASE_URL}/cancelar-assinatura` — base errada e sem o
  prefixo `/api/checkout`.

O comentário que citava `INTEGRACAO.md seção 6/6.1` veio depois e deu ao
esquema inventado uma aparência de fundamentação: um leitor seguinte vê uma
citação de documento e seção e não reabre. Mas ele é agravante, não causa —
o `INTEGRACAO.md` nunca descreveu esse esquema.

A sessão de 14/09 leu o `API.md` pela primeira vez e corrigiu endereçamento,
rota e dedupe, sem reabrir autenticação nem eventos, porque nada ali estava
falhando de forma visível. Os testes fixavam o esquema inventado, então
estavam verdes medindo a coisa errada.

**Correção.** `webhookAutorizado` passou a verificar a assinatura HMAC com os
quatro passos do contrato (janela de 300s, corpo cru, HMAC com a
`SAN_CHECKOUT_KEY`, comparação em tempo constante); `express.json` guarda o
corpo cru no `verify`; `criada` e `cobranca_confirmada` creditam o ciclo pela
mesma dedupe; `SAN_CHECKOUT_WEBHOOK_SECRET` deixou de existir. Cinco testes
novos exercitam assinatura válida, chave errada, replay fora da janela, corpo
adulterado e ausência do corpo cru.

**Como não repetir.** Resumo de contrato escrito à mão dentro do projeto que
consome o contrato é a armadilha, não o atalho. Ele parece documentação, é
versionado junto com o código, e cala justamente onde o autor não sabia —
silêncio que o leitor seguinte preenche inventando. Enquanto o outro lado do
contrato estiver num repositório que dá pra ler, a fonte é ele; um resumo
local, se existir, diz em que commit da fonte foi conferido, ou não existe.

Dois corolários: teste de integração que o próprio projeto escreve e assina
dos dois lados só prova que ele concorda consigo mesmo — quando a fonte é
legível, a asserção sai **de lá**. E comentário que cita documento por nome e
seção envelhece: aposentado o documento, o comentário vira fundamentação
falsa.
