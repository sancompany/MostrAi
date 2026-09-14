# Dinheiro calculado em ponto flutuante puro (14/09/2026)

**O que.** `89.10 * 3` em JavaScript dá `267.29999999999995`. Esse era o valor
gravado em `cobrancas_confirmadas`, usado no cálculo da comissão do vendedor,
e — mais grave — o `valor` que o nosso `GET /plano/{id}` mandava para o San
Checkout cobrar na Asaas.

**Sintoma.** Nenhum visível: os testes passavam porque nenhum comparava o
valor exato, e a exibição usa `toLocaleString` que arredonda na tela. O erro
só apareceria no valor cobrado de verdade ou numa auditoria de conciliação.

**Causa.** Multiplicação de valores monetários feita direto em float
(`valorMensal * compromisso_meses`, `valor * (percentual/100)`), sem passar
por centavos inteiros antes de voltar a reais.

**Correção.** `src/lib/dinheiro.js` — `multiplicar` e `percentual` operam em
centavos (`Math.round(reais*100)` antes de multiplicar), nunca em float direto.
Aplicado nos três pontos que gravam ou enviam valor: `montarRespostaPlano`
(o que vai para a Asaas), `aplicarCicloPago` (o que grava em
`cobrancas_confirmadas`) e `registrarComissaoSeHouver`.

**Como não repetir.** Nenhuma multiplicação ou percentual de dinheiro fora de
`src/lib/dinheiro.js`. Se aparecer um terceiro ponto fazendo `valor * algo`,
é o mesmo bug de novo.
