const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');

// "Custo por exibição prevista" (24/09/2026, ADR-018): valor contratado no
// ciclo ÷ exibições previstas no ciclo, do SNAPSHOT gravado quando o ciclo
// começa (compra, renovação, troca). Não depende de exibição realizada, do
// preço atual do admin, nem da duração dos criativos da conta.

process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-de-teste';
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const ciclo = require('../src/financeiro/ciclo-contratado');

// Cópia privada de um plano do catálogo (inativa): mexer no preço dela não
// afeta os outros arquivos de teste rodando em paralelo no mesmo banco.
const planosCriados = [];
async function planoDeTeste(base, extra = {}) {
  const id = `teste-custo-${randomUUID().slice(0, 8)}`;
  const campos = { id, ativo: false, ...extra };
  await pool.query(
    `INSERT INTO planos
     SELECT (jsonb_populate_record(NULL::planos, to_jsonb(p) || $2::jsonb)).* FROM planos p WHERE p.id = $1`,
    [base, JSON.stringify(campos)],
  );
  planosCriados.push(id);
  return (await pool.query('SELECT * FROM planos WHERE id = $1', [id])).rows[0];
}

async function conta(extra = {}) {
  const campos = {
    nome_empresa: `Custo ${randomUUID().slice(0, 6)}`,
    cpf_cnpj: '11144477735',
    contato_email: `custo-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    papeis: '{anunciante}',
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, ${nomes.join(', ')})
     VALUES (now(), ${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  return rows[0];
}

async function pagar(c, plano, promo = null) {
  const assinatura = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: plano.id, status: 'ativa' });
  if (promo) {
    await pool.query(
      `UPDATE assinaturas SET promocao_desconto_percentual = $2, promocao_valido_ate = now() + interval '300 days' WHERE id = $1`,
      [assinatura.id, promo],
    );
  }
  const atual = await assinaturasRepo.buscarPorId(assinatura.id);
  await sc.aplicarCicloPago(atual, `teste-custo-${randomUUID()}`);
  return atual;
}

async function situacao(contaId) {
  return ciclo.situacaoDoCusto(await anunciantesRepo.buscarPorId(contaId));
}

async function apagar(id) {
  await require('../src/lib/eventos').aguardarGravacoes(); // métrica grava solta; espera terminar antes de apagar
  for (const t of ['ciclos_contratados', 'notificacoes', 'planos_administrativos', 'creditos_ledger', 'eventos']) {
    await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]);
  }
  await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

// Prime: 180 s/hora × 10 pontos × 12 h × 30 dias = 180 h/mês; ÷ 30 s de peça
// = 21.600 exibições previstas por mês (a mesma régua de GET /planos).
const PRIME_MES = 21600;

for (const [meses, nome] of [
  [1, 'Mensal'],
  [3, 'Trimestral'],
  [6, 'Semestral'],
  [12, 'Anual'],
]) {
  test(`${nome}: valor do ciclo ÷ exibições previstas do ciclo inteiro`, async () => {
    const plano = await planoDeTeste(`maximo-${meses}m`);
    const c = await conta();
    try {
      await pagar(c, plano);
      const s = await situacao(c.id);
      const valorCiclo = Math.round(Number(plano.valor_mensal) * meses * 100) / 100;
      assert.equal(s.tipo, 'pago');
      assert.equal(s.ciclo, nome);
      assert.equal(s.cicloMeses, meses);
      assert.equal(s.exibicoesPrevistasMes, PRIME_MES);
      assert.equal(s.exibicoesPrevistasCiclo, PRIME_MES * meses, 'o ciclo inteiro, não um mês');
      assert.equal(s.valorCiclo, valorCiclo);
      assert.ok(Math.abs(s.custoPorExibicaoPrevista - valorCiclo / (PRIME_MES * meses)) < 1e-12);
      assert.ok(s.custoPorExibicaoPrevista < 0.1 && s.custoPorExibicaoPrevista > 0.01, 'microvalor');
    } finally {
      await apagar(c.id);
    }
  });
}

test('exibições previstas do snapshot = régua da vitrine (GET /planos)', () => {
  const { horasDeTelaPorMes, exibicoesPorMes } = require('../src/lib/pacing');
  for (const p of [
    { segundos_por_hora: 90, pontos_incluidos: 3, duracao_maxima_segundos: 15 },
    { segundos_por_hora: 120, pontos_incluidos: 7, duracao_maxima_segundos: 20 },
    { segundos_por_hora: 180, pontos_incluidos: 10, duracao_maxima_segundos: 30 },
  ]) {
    assert.equal(
      ciclo.exibicoesPrevistasMes(p),
      exibicoesPorMes(horasDeTelaPorMes(p.segundos_por_hora, p.pontos_incluidos), p.duracao_maxima_segundos),
    );
  }
});

test('promoção travada na assinatura entra no valor contratado', async () => {
  const plano = await planoDeTeste('maximo-3m');
  const c = await conta();
  try {
    await pagar(c, plano, 25);
    const s = await situacao(c.id);
    // 25% sobre o CHEIO (449) = 336,75/mês × 3 = 1.010,25 — o que a
    // cobrança usou, não o preço de tabela do ciclo (404,10 × 3).
    assert.equal(s.valorCiclo, 1010.25);
    const { rows } = await pool.query('SELECT valor FROM cobrancas_confirmadas WHERE anunciante_id = $1', [c.id]);
    assert.equal(Number(rows[0].valor), s.valorCiclo, 'snapshot = o que foi cobrado');
  } finally {
    await apagar(c.id);
  }
});

test('preço alterado no admin depois da compra não muda o ciclo contratado', async () => {
  const plano = await planoDeTeste('destaque-3m');
  const c = await conta();
  try {
    await pagar(c, plano);
    const antes = await situacao(c.id);
    await pool.query('UPDATE planos SET valor_mensal = 999, segundos_por_hora = 999 WHERE id = $1', [plano.id]);
    const depois = await situacao(c.id);
    assert.deepEqual(depois, antes, 'mesmo valor, mesmas exibições, mesmo custo');
  } finally {
    await apagar(c.id);
  }
});

test('renovação grava um ciclo novo com a condição daquele ciclo; histórico não muda', async () => {
  const plano = await planoDeTeste('essencial-1m');
  const c = await conta();
  try {
    const assinatura = await pagar(c, plano);
    await pool.query('UPDATE planos SET valor_mensal = 50 WHERE id = $1', [plano.id]);
    await sc.aplicarCicloPago(assinatura, `teste-custo-${randomUUID()}`);
    const { rows } = await pool.query(
      'SELECT origem, valor_ciclo FROM ciclos_contratados WHERE anunciante_id = $1 ORDER BY id',
      [c.id],
    );
    assert.deepEqual(
      rows.map((r) => [r.origem, Number(r.valor_ciclo)]),
      [
        ['compra', 99],
        ['renovacao', 50],
      ],
      'o ciclo antigo continua com o valor dele; o novo usa o valor realmente cobrado',
    );
    assert.equal((await situacao(c.id)).valorCiclo, 50, 'o card lê o ciclo em vigor');
  } finally {
    await apagar(c.id);
  }
});

test('troca de plano grava o ciclo do plano novo; nunca reaproveita o anterior', async () => {
  const antigo = await planoDeTeste('essencial-3m');
  const novo = await planoDeTeste('maximo-3m');
  const c = await conta();
  try {
    const assinaturaAntiga = await pagar(c, antigo);
    const nova = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: novo.id, status: 'pendente_troca' });
    await sc.processarWebhookAssinatura({
      tipo: 'assinatura',
      evento: 'plano_trocado',
      planoId: nova.id,
      planoAnterior: assinaturaAntiga.id,
      chargeId: `troca-${randomUUID()}`,
      status: 'confirmado',
      acertoCobrado: 40,
    });
    const s = await situacao(c.id);
    assert.equal(s.origem, 'troca');
    assert.equal(s.exibicoesPrevistasCiclo, PRIME_MES * 3);
    assert.equal(
      s.valorCiclo,
      Math.round(Number(novo.valor_mensal) * 3 * 100) / 100,
      'ciclo do plano novo, não o acerto',
    );
    const { rows } = await pool.query(
      'SELECT plano_id, origem FROM ciclos_contratados WHERE anunciante_id = $1 ORDER BY id',
      [c.id],
    );
    assert.deepEqual(
      rows.map((r) => [r.plano_id, r.origem]),
      [
        [antigo.id, 'compra'],
        [novo.id, 'troca'],
      ],
    );
  } finally {
    await apagar(c.id);
  }
});

test('benefício por créditos e cortesia legada NUNCA mostram valor monetário', async () => {
  const beneficio = await conta({
    plano_id: 'maximo-3m',
    plano_cortesia: true,
    cortesia_motivo: 'Benefício por créditos',
    data_expiracao: '2099-01-01',
  });
  const cortesia = await conta({
    plano_id: 'maximo-3m',
    plano_cortesia: true,
    cortesia_motivo: 'Cortesia administrativa',
    data_expiracao: '2099-01-01',
  });
  try {
    await pool.query(
      `INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em)
       VALUES ($1, 'maximo-3m', '2099-01-01', 'ativo', 'indicacao', now()), ($2, 'maximo-3m', '2099-01-01', 'ativo', 'admin', now())`,
      [beneficio.id, cortesia.id],
    );
    assert.deepEqual(await situacao(beneficio.id), { tipo: 'beneficio' });
    assert.deepEqual(await situacao(cortesia.id), { tipo: 'cortesia' });
  } finally {
    await apagar(beneficio.id);
    await apagar(cortesia.id);
  }
});

test('plano sem exibição prevista não divide por zero; conta paga sem snapshot mostra "-"', async () => {
  assert.equal(ciclo.custoPorExibicaoPrevista({ valor_ciclo: 100, exibicoes_previstas_ciclo: 0 }), null);
  assert.equal(ciclo.custoPorExibicaoPrevista({ valor_ciclo: 0, exibicoes_previstas_ciclo: 100 }), null);
  assert.equal(ciclo.custoPorExibicaoPrevista(null), null);
  const plano = await planoDeTeste('essencial-1m', { duracao_maxima_segundos: null });
  const semExibicao = await conta();
  const semSnapshot = await conta({ plano_id: 'essencial-1m', plano_cortesia: false, data_expiracao: '2099-01-01' });
  try {
    await pagar(semExibicao, plano);
    const s = await situacao(semExibicao.id);
    assert.equal(s.exibicoesPrevistasCiclo, 0);
    assert.equal(s.custoPorExibicaoPrevista, null);
    assert.deepEqual(await situacao(semSnapshot.id), { tipo: 'sem_snapshot' });
  } finally {
    await apagar(semExibicao.id);
    await apagar(semSnapshot.id);
  }
});

test('snapshot antigo (backfill da migration) continua valendo com o preço de hoje diferente', async () => {
  const plano = await planoDeTeste('essencial-3m');
  const c = await conta({ plano_id: plano.id, plano_cortesia: false, data_expiracao: '2099-01-01' });
  try {
    await pool.query(
      `INSERT INTO ciclos_contratados (anunciante_id, plano_id, origem, ciclo_meses, valor_ciclo,
                                       exibicoes_previstas_mes, exibicoes_previstas_ciclo, criado_em)
       VALUES ($1, $2, 'compra', 3, 267.30, 6480, 19440, now() - interval '30 days')`,
      [c.id, plano.id],
    );
    await pool.query('UPDATE planos SET valor_mensal = 500 WHERE id = $1', [plano.id]);
    const s = await situacao(c.id);
    assert.equal(s.valorCiclo, 267.3);
    assert.ok(Math.abs(s.custoPorExibicaoPrevista - 267.3 / 19440) < 1e-12);
  } finally {
    await apagar(c.id);
  }
});

test('microvalor: 4 casas abaixo de R$ 1, nunca "R$ 0,00" pra valor positivo', () => {
  const window = { location: { hostname: 'localhost', origin: 'http://localhost' }, fetch: () => {} };
  const document = {
    addEventListener() {},
    querySelectorAll: () => [],
    documentElement: {},
  };
  class MutationObserver {
    observe() {}
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/config.js'), 'utf8'), {
    window,
    document,
    MutationObserver,
    setTimeout,
    clearTimeout,
  });
  const f = (v) => window.fmtMicroBRL(v).replace(/\s/g, ' ');
  assert.equal(f(0.0125), 'R$ 0,0125');
  assert.equal(f(267.3 / 19440), 'R$ 0,0138');
  assert.equal(f(0.00004), 'R$ 0,00004');
  assert.equal(f(0.0000012), 'R$ 0,000001');
  assert.equal(f(0.00000001), '< R$ 0,000001');
  assert.equal(f(12.5), 'R$ 12,50');
  assert.equal(f(0), '-');
  assert.equal(f(null), '-');
  assert.equal(f(-1), '-');
});

test.after(async () => {
  for (const id of planosCriados) await pool.query('DELETE FROM planos WHERE id = $1', [id]).catch(() => {});
  await pool.end();
});
