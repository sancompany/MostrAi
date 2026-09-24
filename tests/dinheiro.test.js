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
// Preço da mensalidade — sem desconto de comodato (24/09/2026, ADR-016)
// ---------------------------------------------------------------------------
// O crédito de R$ 50 do comodato Básico (`credito_comodato_mensal`) saiu do
// preço: ser ponto agora gera CRÉDITOS no ledger, nunca desconto em reais.
// O campo continua no banco como legado (0 contas com valor em produção na
// auditoria), sem efeito nenhum aqui.
const { valorMensalDaConta } = require('../src/financeiro/san-checkout');

const conta = (extra = {}) => ({ papeis: ['anunciante'], status: 'comum', ...extra });
const donoDePonto = (extra = {}) => conta({ papeis: ['anunciante', 'ponto'], ...extra });

test('a conta paga a tabela', () => {
  assert.strictEqual(valorMensalDaConta(conta(), { tier: 'destaque', valor_mensal: 249, compromisso_meses: 1 }), 249);
});

test('crédito de comodato legado em reais NÃO desconta mais nada, em nenhum plano', () => {
  const dono = donoDePonto({ credito_comodato_mensal: 50 });
  for (const [tier, valor] of [
    ['essencial', 99],
    ['destaque', 249],
    ['maximo', 449],
  ]) {
    assert.strictEqual(valorMensalDaConta(dono, { tier, valor_mensal: valor, compromisso_meses: 1 }), valor, tier);
  }
});

test('desconto de parceiro continua valendo sozinho', () => {
  const dono = donoDePonto({
    status: 'parceiro',
    parceiro_desconto_percentual: 10,
    parceiro_compromisso_minimo: 3,
    credito_comodato_mensal: 50,
  });
  // 249 - 10% = 224.10, e nada de comodato por cima
  assert.strictEqual(valorMensalDaConta(dono, { tier: 'destaque', valor_mensal: 249, compromisso_meses: 3 }), 224.1);
});

test('desconto_comodato_percentual gravado no plano não desconta nada', () => {
  const plano = { tier: 'destaque', valor_mensal: 249, compromisso_meses: 1, desconto_comodato_percentual: 20 };
  assert.strictEqual(valorMensalDaConta(donoDePonto(), plano), 249);
});
