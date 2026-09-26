const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const promocoesRepo = require('../src/financeiro/promocoes-repository');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const { valorMensalDaConta } = require('../src/financeiro/san-checkout');
const { cotarPlano } = require('../src/financeiro/cotacao');

// Preço promocional SEM prazo (26/09/2026): o San Checkout não altera o valor
// de uma assinatura de cartão já paga, então a promoção não pode prometer
// "N meses e depois volta ao preço normal". A janela de compra só decide até
// quando entram adesões novas; quem aderiu mantém o preço enquanto AQUELA
// assinatura existir. Cancelou e contratou de novo = preço vigente na nova.

const HORA = 60 * 60 * 1000;
const criados = { promocoes: [], contas: [], planos: [] };

async function planoDeTeste() {
  const id = `plano-teste-sem-prazo-${randomUUID()}`;
  // Cheio 100, ciclo trimestral a 90 (10%): a promoção de 30% dá 70.
  await pool.query(
    `INSERT INTO planos (id, tier, nome, valor_mensal, valor_mensal_cheio, compromisso_meses, frequencia_hora, cobertura, segundos_por_hora, pontos_incluidos, duracao_maxima_segundos, limite_criativos)
     VALUES ($1,'destaque','Teste Sem Prazo',90,100,3,0,'todos_pontos',600,1,30,3)`,
    [id],
  );
  criados.planos.push(id);
  return (await pool.query('SELECT * FROM planos WHERE id = $1', [id])).rows[0];
}

async function contaDeTeste() {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Teste Sem Prazo ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `sem-prazo-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criados.contas.push(conta.id);
  return conta;
}

// Uma promoção por vez cobrindo a célula destaque × trimestral: a do teste
// anterior sai antes de a próxima entrar.
async function promocao(extra = {}) {
  await pool.query(`UPDATE promocoes SET status = 'encerrada' WHERE id = ANY($1::int[])`, [criados.promocoes]);
  const promo = await promocoesRepo.criar({
    nome_interno: `Sem prazo ${randomUUID()}`,
    titulo_publico: 'Promoção sem prazo',
    publico_elegivel: 'todos',
    status: 'ativa',
    itens: [{ tier: 'destaque', compromissoMeses: 3, descontoPercentual: 30 }],
    ...extra,
  });
  criados.promocoes.push(promo.id);
  return promo;
}

// A mesma sequência do POST /anunciantes/:id/assinar (financeiro/routes.js):
// condição vigente e elegível no instante da adesão → snapshot na assinatura.
async function aderir(conta, plano) {
  const estado = await promocoesRepo.estadoComercialDaConta(conta);
  const condicao = await promocoesRepo.condicaoVigente(plano.tier, plano.compromisso_meses, estado);
  return assinaturasRepo.criar({
    anuncianteId: conta.id,
    planoId: plano.id,
    promocaoId: condicao?.promocao.id,
    promocaoDescontoPercentual: condicao?.descontoPercentual,
  });
}

test.after(async () => {
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = ANY($1::int[])', [criados.contas]);
  await pool.query('DELETE FROM promocoes WHERE id = ANY($1::int[])', [criados.promocoes]);
  await pool.query('DELETE FROM anunciantes WHERE id = ANY($1::int[])', [criados.contas]);
  await pool.query('DELETE FROM planos WHERE id = ANY($1::text[])', [criados.planos]);
  await pool.end();
});

test('promoção tem janela de compra com início e fim', async () => {
  const inicio = new Date(Date.now() - HORA).toISOString();
  const fim = new Date(Date.now() + 24 * HORA).toISOString();
  const promo = await promocao({ compra_inicio: inicio, compra_fim: fim });
  assert.strictEqual(new Date(promo.compra_inicio).toISOString(), inicio);
  assert.strictEqual(new Date(promo.compra_fim).toISOString(), fim);
  assert.strictEqual(promocoesRepo.situacaoExibicao(promo).situacao_exibicao, 'ativa');
});

test('fora da janela não entra adesão nova (antes do início e depois do fim)', async () => {
  const plano = await planoDeTeste();
  const conta = await contaDeTeste();
  const promo = await promocao({
    compra_inicio: new Date(Date.now() + HORA).toISOString(),
    compra_fim: new Date(Date.now() + 2 * HORA).toISOString(),
  });
  assert.strictEqual(await promocoesRepo.condicaoVigente(plano.tier, 3), null, 'agendada: ainda não aceita');

  await promocoesRepo.atualizar(promo.id, {
    compra_inicio: new Date(Date.now() - 2 * HORA).toISOString(),
    compra_fim: new Date(Date.now() - HORA).toISOString(),
  });
  assert.strictEqual(await promocoesRepo.condicaoVigente(plano.tier, 3), null, 'encerrada: não aceita');
  const assinatura = await aderir(conta, plano);
  assert.strictEqual(assinatura.promocao_id, null);
  assert.strictEqual(valorMensalDaConta(conta, plano, assinatura), 90, 'adesão depois do fim paga o preço do ciclo');
  const cotacao = await cotarPlano(conta, plano);
  assert.strictEqual(cotacao.promocao, null);
  assert.strictEqual(cotacao.valorMensal, 90);
});

test('limite de adesões continua valendo: esgotou, não entra ninguém novo', async () => {
  const plano = await planoDeTeste();
  const primeira = await contaDeTeste();
  const segunda = await contaDeTeste();
  const promo = await promocao({ limite_adesoes: 1 });
  const a1 = await aderir(primeira, plano);
  assert.strictEqual(a1.promocao_id, promo.id);
  const a2 = await aderir(segunda, plano);
  assert.strictEqual(a2.promocao_id, null, 'a segunda adesão já não cabe no limite');
  assert.strictEqual(valorMensalDaConta(segunda, plano, a2), 90);
  assert.strictEqual(valorMensalDaConta(primeira, plano, a1), 70, 'quem entrou antes do limite mantém o preço');
});

test('assinatura feita na janela conserva o preço depois do fim da promoção, sem prazo', async () => {
  const plano = await planoDeTeste();
  const conta = await contaDeTeste();
  const promo = await promocao({ compra_fim: new Date(Date.now() + 24 * HORA).toISOString() });
  const assinatura = await aderir(conta, plano);
  assert.strictEqual(assinatura.promocao_id, promo.id);
  assert.strictEqual(Number(assinatura.promocao_desconto_percentual), 30);
  assert.strictEqual(assinatura.promocao_valido_ate, null, 'nenhuma data de fim é gravada');
  assert.strictEqual(valorMensalDaConta(conta, plano, assinatura), 70);

  // Janela fecha, promoção encerrada e editada, preço-base muda: nada disso
  // mexe no que essa assinatura contratou.
  await promocoesRepo.atualizar(promo.id, {
    compra_fim: new Date(Date.now() - HORA).toISOString(),
    status: 'encerrada',
    itens: [{ tier: 'destaque', compromissoMeses: 3, descontoPercentual: 5 }],
  });
  await pool.query('UPDATE planos SET valor_mensal = 95, valor_mensal_cheio = 120 WHERE id = $1', [plano.id]);
  const planoDepois = (await pool.query('SELECT * FROM planos WHERE id = $1', [plano.id])).rows[0];
  const guardada = await assinaturasRepo.buscarPorId(assinatura.id);
  assert.strictEqual(Number(guardada.promocao_desconto_percentual), 30, 'snapshot travado na adesão');
  assert.strictEqual(valorMensalDaConta(conta, planoDepois, guardada), 84, '30% sobre o cheio, sem data para acabar');
});

test('cancelar não dá direito ao mesmo preço numa assinatura nova', async () => {
  const plano = await planoDeTeste();
  const conta = await contaDeTeste();
  const promo = await promocao({ compra_fim: new Date(Date.now() + 24 * HORA).toISOString() });
  const antiga = await aderir(conta, plano);
  assert.strictEqual(valorMensalDaConta(conta, plano, antiga), 70);
  await assinaturasRepo.marcarCancelada(antiga.id);

  // A promoção acabou: contratar de novo é preço vigente na nova contratação.
  await promocoesRepo.atualizar(promo.id, { compra_fim: new Date(Date.now() - HORA).toISOString() });
  const nova = await aderir(conta, plano);
  assert.notStrictEqual(nova.id, antiga.id);
  assert.strictEqual(nova.promocao_id, null, 'a condição não passa de uma assinatura para outra');
  assert.strictEqual(valorMensalDaConta(conta, plano, nova), 90);
});

test('admin: sem campo de duração, resumo e card mostram "enquanto a assinatura permanecer ativa"', async () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin', 'index.page.js'), 'utf8');
  assert.doesNotMatch(js, /duracao_beneficio_meses/, 'o formulário não lê nem envia duração');
  assert.doesNotMatch(js, /Duração da condição/);
  assert.doesNotMatch(js, /<dt>Duração<\/dt>/);
  assert.match(js, /const BENEFICIO_PROMOCAO = 'enquanto a assinatura permanecer ativa'/);
  assert.match(js, /<dt>Benefício<\/dt><dd>\$\{BENEFICIO_PROMOCAO\}<\/dd>/);
  assert.match(js, /Condição do preço promocional/);
  for (const arquivo of [
    'public/admin/index.page.js',
    'public/planos.page.js',
    'public/anunciante/confirmar-plano.page.js',
  ]) {
    const texto = fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
    assert.doesNotMatch(texto, /válido por .{0,40}meses|meses de desconto|volta ao preço normal/i, arquivo);
  }

  // A API ignora uma duração enviada à mão: o campo saiu do que o admin grava.
  const promo = await promocao({ duracao_beneficio_meses: 3 });
  const lida = await promocoesRepo.buscarPorId(promo.id);
  assert.strictEqual(lida.duracao_beneficio_meses, 12, 'fica o padrão da coluna, sem efeito');
});
