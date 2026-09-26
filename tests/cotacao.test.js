const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const promocoesRepo = require('../src/financeiro/promocoes-repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const { valorMensalDaConta } = require('../src/financeiro/san-checkout');
const { cotarPlano } = require('../src/financeiro/cotacao');

// A cotação é o que a tela de confirmação do pedido mostra (GET
// /anunciantes/me/cotacao). Ela não pode divergir da cobrança: até
// 23/09/2026 a tela mostrava R$ 672,30 pra uma cobrança de R$ 597,60. Estes
// testes provam que ela segue a mesma régua do POST /assinar — promoção
// substitui o desconto do ciclo, parceiro soma por cima (ADR-014; o comodato
// saiu em 24/09/2026, ADR-016).
//
// Célula própria (máximo × 12 meses): os arquivos de teste rodam em paralelo
// no mesmo banco, e o de elegibilidade cria promoção no essencial × 3.

async function planoDeTeste() {
  const id = `plano-teste-cotacao-${randomUUID()}`;
  await pool.query(
    `INSERT INTO planos (id, tier, nome, valor_mensal, valor_mensal_cheio, desconto_percentual, compromisso_meses,
                         frequencia_hora, cobertura, segundos_por_hora, pontos_incluidos, duracao_maxima_segundos, limite_criativos)
     VALUES ($1,'maximo','Teste Cotação',80,100,20,12,0,'todos_pontos',180,10,30,3)`,
    [id],
  );
  const { rows } = await pool.query('SELECT * FROM planos WHERE id = $1', [id]);
  return rows[0];
}

async function contaDeTeste() {
  return anunciantesRepo.criar({
    nome_empresa: `Teste Cotação ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `cotacao-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
}

test('cotarPlano: sem promoção, é o preço do ciclo — igual à cobrança', async () => {
  const plano = await planoDeTeste();
  const conta = await contaDeTeste();
  try {
    const c = await cotarPlano(conta, plano);
    assert.strictEqual(c.promocao, null);
    assert.strictEqual(c.cheioCiclo, 1200);
    assert.strictEqual(c.tabelaMensal, 80);
    assert.strictEqual(c.valorMensal, valorMensalDaConta(conta, plano, null));
    assert.strictEqual(c.valorCiclo, 960);
    assert.strictEqual(c.descontoParceiro, false);
    assert.strictEqual(c.creditoComodato, undefined);
  } finally {
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
    await pool.query('DELETE FROM planos WHERE id = $1', [plano.id]);
  }
});

test('cotarPlano: promoção vigente SUBSTITUI o desconto do ciclo, e parceiro soma por cima (comodato legado não desconta — ADR-016)', async () => {
  const plano = await planoDeTeste();
  const conta = await contaDeTeste();
  const promo = await promocoesRepo.criar({
    nome_interno: `Teste cotação ${randomUUID()}`,
    titulo_publico: 'Pré-venda de teste',
    selo: 'pré-venda',
    publico_elegivel: 'todos',
    status: 'ativa',
    itens: [{ tier: 'maximo', compromissoMeses: 12, descontoPercentual: 25 }],
  });
  try {
    const comum = await cotarPlano(conta, plano);
    assert.ok(comum.promocao, 'a promoção vigente pra essa célula entra na cotação');
    assert.strictEqual(comum.promocao.descontoPercentual, 25);
    assert.strictEqual(comum.promocao.selo, 'pré-venda');
    assert.strictEqual(comum.promocao.duracaoMeses, undefined, 'sem prazo: vale enquanto a assinatura existir');
    assert.strictEqual(comum.promocao.temVantagem, true, '25% da promoção bate os 20% do ciclo');
    // 25% sobre o CHEIO (100), não 25% em cima dos 20% do ciclo.
    assert.strictEqual(comum.tabelaMensal, 75);
    assert.strictEqual(comum.valorCiclo, 900);
    // Mesma régua do POST /assinar: a assinatura que ele gravaria, cobrada
    // pela função da cobrança.
    const assinatura = { promocao_desconto_percentual: 25 };
    assert.strictEqual(comum.valorMensal, valorMensalDaConta(conta, plano, assinatura));

    // Dona de ponto com R$ 50 de crédito LEGADO e parceira com 10%: 75 − 10%
    // = 67,50. O crédito de comodato saiu em 24/09/2026 (ADR-016): não abate.
    await pool.query(
      `UPDATE anunciantes SET papeis = ARRAY['anunciante','ponto'], credito_comodato_mensal = 50,
                              status = 'parceiro', parceiro_desconto_percentual = 10, parceiro_compromisso_minimo = 1
        WHERE id = $1`,
      [conta.id],
    );
    const comDireitos = await anunciantesRepo.buscarPorId(conta.id);
    const c = await cotarPlano(comDireitos, plano);
    assert.strictEqual(c.tabelaMensal, 75, 'o preço de tabela não depende da conta');
    assert.strictEqual(c.valorMensal, 67.5);
    assert.strictEqual(c.valorMensal, valorMensalDaConta(comDireitos, plano, assinatura));
    assert.strictEqual(c.valorCiclo, 810);
    assert.strictEqual(c.descontoParceiro, true);
    assert.strictEqual(c.creditoComodato, undefined, 'crédito de comodato não existe mais na cotação');
  } finally {
    await pool.query('DELETE FROM promocoes WHERE id = $1', [promo.id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
    await pool.query('DELETE FROM planos WHERE id = $1', [plano.id]);
  }
});

// D1 (24/09/2026): a pré-venda de produção dá 20% em todos os ciclos, e o
// Anual já tem 20% normais. A regra de preço fica (promoção substitui o
// ciclo), mas a célula não é anunciada como promoção: `temVantagem` false.
test('cotarPlano: promoção igual ao desconto do ciclo não muda o preço e sai marcada sem vantagem (D1)', async () => {
  const plano = await planoDeTeste();
  const conta = await contaDeTeste();
  const promo = await promocoesRepo.criar({
    nome_interno: `Teste cotação sem vantagem ${randomUUID()}`,
    titulo_publico: 'Pré-venda de teste',
    selo: 'pré-venda',
    publico_elegivel: 'todos',
    status: 'ativa',
    itens: [{ tier: 'maximo', compromissoMeses: 12, descontoPercentual: 20 }],
  });
  try {
    const c = await cotarPlano(conta, plano);
    assert.ok(c.promocao, 'a condição continua sendo a que a cobrança grava');
    assert.strictEqual(c.promocao.temVantagem, false);
    assert.strictEqual(c.tabelaMensal, 80, 'mesmo preço do ciclo normal');
    assert.strictEqual(c.valorCiclo, 960);
  } finally {
    await pool.query('DELETE FROM promocoes WHERE id = $1', [promo.id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
    await pool.query('DELETE FROM planos WHERE id = $1', [plano.id]);
  }
});

test('comVantagem: marca cada célula e resume os ciclos em que a promoção baixa o preço (D1)', () => {
  const planos = [
    { tier: 'essencial', compromisso_meses: 3, valor_mensal: '89.10', valor_mensal_cheio: '99' },
    { tier: 'essencial', compromisso_meses: 6, valor_mensal: '84.15', valor_mensal_cheio: '99' },
    { tier: 'essencial', compromisso_meses: 12, valor_mensal: '79.20', valor_mensal_cheio: '99' },
  ];
  const promo = {
    id: 1,
    itens: [
      { tier: 'essencial', compromissoMeses: 12, descontoPercentual: '20.00' },
      { tier: 'essencial', compromissoMeses: 3, descontoPercentual: '20.00' },
      { tier: 'essencial', compromissoMeses: 6, descontoPercentual: '20.00' },
      // Célula sem plano à venda: não dá pra comprar, não tem vantagem.
      { tier: 'maximo', compromissoMeses: 1, descontoPercentual: '10.00' },
    ],
  };
  const marcada = promocoesRepo.comVantagem(promo, planos);
  assert.deepStrictEqual(
    marcada.itens.map((i) => [i.compromissoMeses, i.temVantagem]),
    [
      [12, false],
      [3, true],
      [6, true],
      [1, false],
    ],
  );
  assert.deepStrictEqual(marcada.ciclosComVantagem, [3, 6]);
  // Promoção MENOR que o ciclo (a regra atual cobraria mais caro): também
  // não é anunciada — decisão comercial em aberto (docs/PENDENCIAS.md).
  assert.strictEqual(promocoesRepo.temVantagem(15, planos[2]), false);
  assert.strictEqual(promocoesRepo.temVantagem(21, planos[2]), true);
});
