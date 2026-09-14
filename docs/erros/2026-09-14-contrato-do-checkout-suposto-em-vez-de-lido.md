# O contrato do San Checkout foi suposto, não lido (14/09/2026)

**O que.** Três defeitos e um pedaço inteiro de escopo, todos com a mesma
origem: a integração com o San Checkout foi construída a partir do que se
imaginava que ele fazia, e não do `API.md` dele. Ninguém abriu o repositório
`sancompany/san_checkout` até hoje.

**Sintoma.** Nenhum — e é esse o ponto. Tudo passava nos 14 testes e nos 136
checks e2e, porque toda verificação era contra o nosso próprio lado. Os
defeitos só apareceriam com dinheiro real em cima: (a) `cancelar-assinatura`
respondendo 404, porque o código montava `${BASE}/cancelar-assinatura` e o
contrato é `${API}/api/checkout/cancelar-assinatura` — e porque uma variável
só, `SAN_CHECKOUT_BASE_URL`, servia a tela de pagamento e a API, que são
domínios diferentes (API.md 2.1), deixando um dos dois lados necessariamente
errado; (b) a dedupe do webhook chaveada por hash do corpo + dia, quando o
payload de assinatura não tem id nenhum e o corpo de uma renovação é idêntico
ao da anterior — uma retentativa cruzando a meia-noite creditaria um ciclo que
ninguém pagou; (c) `meses_gratis` e `minimo_telas_ativas`, que prometiam
cobertura começando num dia diferente do da cobrança, sendo que o motor cobra
no ato e a cada ciclo, sem carência nem pular ciclo (API.md 7.5).

**Causa.** O contrato mora em outro repositório, e a spec registrou isso como
risco em 12/09 ("a última estação do Checkout ainda não foi auditada") sem que
a leitura acontecesse. Risco declarado e não verificado é risco aceito por
omissão. O `INTEGRACAO.md` citado nos comentários do código já tinha virado um
redirecionamento para o `API.md` — os comentários apontavam para um documento
que não descrevia mais comportamento nenhum.

**Correção.** Repositório do Checkout clonado e lido. `SAN_CHECKOUT_API_URL`
separada da `SAN_CHECKOUT_BASE_URL`; todas as rotas de servidor montadas num
lugar só (`chamarApiCheckout`); dedupe pela chave natural `chargeId + status`,
buscada na rota de conciliação 5.3, que é a única fonte do id; conciliação
diária (`npm run conciliar`), que o contrato chama de não-opcional; e a
máquina de cobertura adiada removida na migration 021.

**Como não repetir.** Integração com estrutura do ecossistema começa lendo o
contrato no repositório dela, não o que o nosso código supõe dela — e a
releitura é obrigatória sempre que a estrutura publicar versão nova. Teste que
só exercita o nosso lado não prova integração nenhuma. **Lição de ecossistema:**
vale para qualquer projeto San & Co. que consuma o San Checkout.
