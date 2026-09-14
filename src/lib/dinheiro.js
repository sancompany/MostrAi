// Aritmética de dinheiro em centavos, nunca em float direto.
//
// `89.10 * 3` em JavaScript dá `267.29999999999995` — 14 casas decimais que
// não deveriam existir num valor que vai para `cobrancas_confirmadas`, entra
// no cálculo de comissão do vendedor, e é o `valor` que o nosso
// `GET /plano/{id}` manda para o San Checkout cobrar na Asaas.
//
// A correção não é `.toFixed(2)` no fim (que só esconde o erro na exibição);
// é multiplicar em centavos (inteiros, sem erro de ponto flutuante) e voltar
// para reais só no final.
function arredondar(valorEmReais) {
  return Math.round(Number(valorEmReais) * 100) / 100;
}

// valor × multiplicador (ex.: mensalidade × meses do ciclo), em centavos.
function multiplicar(valorEmReais, multiplicador) {
  const centavos = Math.round(Number(valorEmReais) * 100) * Number(multiplicador);
  return centavos / 100;
}

// valor × percentual (ex.: comissão), em centavos.
function percentual(valorEmReais, pct) {
  const centavos = Math.round(Number(valorEmReais) * 100 * (Number(pct) / 100));
  return centavos / 100;
}

module.exports = { arredondar, multiplicar, percentual };
