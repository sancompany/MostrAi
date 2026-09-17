const test = require('node:test');
const assert = require('node:assert');

const { arredondar, multiplicar, percentual } = require('../src/lib/dinheiro');

// A falha original: 89.10 * 3 em JavaScript dá 267.29999999999995 — e esse é
// o valor que ia gravado em cobrancas_confirmadas e enviado ao San Checkout
// como o `valor` a cobrar na Asaas.
test('multiplicar não acumula erro de ponto flutuante', () => {
  assert.strictEqual(multiplicar(89.1, 3), 267.3);
  assert.strictEqual(multiplicar(349.9, 12), 4198.8);
  assert.strictEqual(multiplicar(0.1, 3), 0.3); // o clássico 0.1+0.1+0.1 !== 0.3
});

test('percentual arredonda em centavos, não em float', () => {
  assert.strictEqual(percentual(267.3, 10), 26.73);
  assert.strictEqual(percentual(1000, 10), 100);
});

test('arredondar corta pra 2 casas', () => {
  assert.strictEqual(arredondar(267.299999999999), 267.3);
});

// ---------------------------------------------------------------------------
// Crédito de comodato em reais (migration 049, desenho do dono de 17/09/2026)
// ---------------------------------------------------------------------------
// Quem cede a parede escolhe: recebe R$ 50 por mês, ou troca os R$ 50 por
// tela. Quem troca leva o Essencial de graça e, se quiser subir, paga o
// Destaque ou o Máximo com R$ 50 abatidos. O abatimento é em REAIS, não em
// percentual, porque tem que valer exatamente o que ele deixou de receber.
const { valorMensalDaConta } = require('../src/financeiro/san-checkout');

const conta = (extra = {}) => ({ papeis: ['anunciante'], status: 'comum', ...extra });
const donoDePonto = (extra = {}) => conta({ papeis: ['anunciante', 'ponto'], ...extra });

test('sem crédito de comodato, a conta paga a tabela', () => {
  assert.strictEqual(valorMensalDaConta(conta(), { valor_mensal: 249, compromisso_meses: 1 }), 249);
});

test('dono de ponto que trocou os R$ 50 por tela paga R$ 50 a menos', () => {
  const dono = donoDePonto({ credito_comodato_mensal: 50 });
  assert.strictEqual(valorMensalDaConta(dono, { valor_mensal: 249, compromisso_meses: 1 }), 199);
  assert.strictEqual(valorMensalDaConta(dono, { valor_mensal: 449, compromisso_meses: 1 }), 399);
});

// O crédito é direito de quem cedeu a parede. Conta comum com o campo
// preenchido por engano não pode sair pagando menos.
test('crédito só vale pra quem tem o papel de ponto', () => {
  const comum = conta({ credito_comodato_mensal: 50 });
  assert.strictEqual(valorMensalDaConta(comum, { valor_mensal: 249, compromisso_meses: 1 }), 249);
});

// Crédito maior que a mensalidade zera a conta — nunca vira dinheiro de volta.
// Sem esse piso, um crédito de R$ 50 num plano de R$ 30 mandaria valor
// negativo pro San Checkout, que é cobrança inválida na Asaas.
test('crédito nunca deixa a mensalidade negativa', () => {
  const dono = donoDePonto({ credito_comodato_mensal: 50 });
  assert.strictEqual(valorMensalDaConta(dono, { valor_mensal: 30, compromisso_meses: 1 }), 0);
  assert.strictEqual(valorMensalDaConta(dono, { valor_mensal: 50, compromisso_meses: 1 }), 0);
});

// O ciclo longo já desconta no `valor_mensal` do plano; o crédito entra
// DEPOIS, sobre o valor já descontado.
test('crédito entra depois do desconto de ciclo, não antes', () => {
  const dono = donoDePonto({ credito_comodato_mensal: 50 });
  // Destaque anual: 249 - 20% = 199.20 na tabela; com o crédito, 149.20.
  assert.strictEqual(valorMensalDaConta(dono, { valor_mensal: 199.2, compromisso_meses: 12 }), 149.2);
});

// Parceiro é percentual e comodato é reais: os dois podem existir na mesma
// conta, e a ordem importa pro centavo.
test('desconto de parceiro em percentual e crédito em reais se somam na ordem certa', () => {
  const dono = donoDePonto({
    status: 'parceiro',
    parceiro_desconto_percentual: 10,
    parceiro_compromisso_minimo: 3,
    credito_comodato_mensal: 50,
  });
  // 249 - 10% = 224.10, depois -50 = 174.10
  assert.strictEqual(valorMensalDaConta(dono, { valor_mensal: 249, compromisso_meses: 3 }), 174.1);
});
