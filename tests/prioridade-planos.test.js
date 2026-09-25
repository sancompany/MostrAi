require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const vigencia = require('../src/lib/vigencia');

// Prioridade entre plano PAGO e BENEFÍCIO por créditos (24/09/2026, ADR-016,
// regras 23-33 do pedido do dono). Níveis: Essencial 1, Pro 2, Prime 3.
//   pago MAIOR que o benefício em vigor → entra na hora, benefício encerrado
//     ('superado_por_plano_pago'), sem devolver créditos;
//   pago IGUAL ou MENOR → benefício continua, o pago fica guardado e começa
//     depois (nunca diminui o serviço na hora, nunca sobrepõe o mesmo nível).

process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-de-teste';
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');

const PLANO = { essencial: 'essencial-1m', pro: 'destaque-1m', prime: 'maximo-1m' };

// Dia de Matão (RN-32-B), não UTC: entre 21:00 e 00:00 UTC os dois divergem.
const somar = (dias) => vigencia.somarDias(vigencia.hojeComercial(), dias);

async function contaComBeneficio(tierBeneficio, extra = {}) {
  const planoId = PLANO[tierBeneficio];
  const campos = {
    nome_empresa: `Fila ${randomUUID().slice(0, 6)}`,
    cpf_cnpj: '11144477735',
    contato_email: `fila-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    papeis: '{anunciante}',
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    plano_id: planoId,
    plano_cortesia: true,
    cortesia_motivo: 'Benefício por créditos',
    data_expiracao: somar(40),
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, ${nomes.join(', ')})
     VALUES (now(), ${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  await pool.query(
    `INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em)
     VALUES ($1, $2, $3, 'ativo', 'indicacao', now())`,
    [rows[0].id, planoId, somar(40)],
  );
  return rows[0];
}

async function pagar(conta, tier) {
  const assinatura = await assinaturasRepo.criar({ anuncianteId: conta.id, planoId: PLANO[tier], status: 'ativa' });
  await sc.aplicarCicloPago(assinatura, `teste-fila-${randomUUID()}`);
}

async function estado(contaId) {
  const {
    rows: [conta],
  } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaId]);
  const { rows: historico } = await pool.query(
    'SELECT plano_id, status, encerrado_motivo FROM planos_administrativos WHERE anunciante_id = $1 ORDER BY id',
    [contaId],
  );
  return { conta, historico };
}

async function apagar(id) {
  await require('../src/lib/eventos').aguardarGravacoes(); // métrica grava solta; espera terminar antes de apagar
  for (const tabela of [
    'notificacoes',
    'planos_administrativos',
    'creditos_ledger',
    'cobrancas_confirmadas',
    'comissoes',
    'eventos',
  ]) {
    await pool.query(`DELETE FROM ${tabela} WHERE anunciante_id = $1`, [id]);
  }
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

const MATRIZ = [
  ['essencial', 'pro', 'imediato'],
  ['essencial', 'prime', 'imediato'],
  ['pro', 'prime', 'imediato'],
  ['prime', 'pro', 'depois'],
  ['prime', 'essencial', 'depois'],
  ['pro', 'essencial', 'depois'],
  ['pro', 'pro', 'depois'],
  ['prime', 'prime', 'depois'],
  ['essencial', 'essencial', 'depois'],
];

for (const [beneficio, pago, esperado] of MATRIZ) {
  test(`benefício ${beneficio} + pago ${pago} → ${esperado === 'imediato' ? 'pago na hora, benefício termina' : 'benefício continua, pago depois'}`, async () => {
    const c = await contaComBeneficio(beneficio);
    try {
      await pagar(c, pago);
      const { conta, historico } = await estado(c.id);
      if (esperado === 'imediato') {
        assert.equal(conta.plano_id, PLANO[pago], 'o pago entrou');
        assert.equal(conta.plano_cortesia, false);
        assert.deepEqual(historico, [
          { plano_id: PLANO[beneficio], status: 'encerrado', encerrado_motivo: 'superado_por_plano_pago' },
        ]);
        assert.equal(conta.plano_pago_guardado_id, null);
        // O Essencial não volta depois: nada agendado, nada guardado.
      } else {
        assert.equal(conta.plano_id, PLANO[beneficio], 'o benefício continua valendo agora');
        assert.equal(conta.plano_cortesia, true);
        assert.equal(String(conta.data_expiracao).slice(0, 10), somar(40), 'benefício até o fim');
        assert.equal(conta.plano_pago_guardado_id, PLANO[pago], 'o pago fica guardado pra depois');
        assert.ok(conta.plano_pago_guardado_dias >= 28, 'com o período pago inteiro');
        assert.deepEqual(historico, [{ plano_id: PLANO[beneficio], status: 'ativo', encerrado_motivo: null }]);
      }
    } finally {
      await apagar(c.id);
    }
  });
}

test('benefício termina → o pago guardado assume com os dias pagos intactos; renovação durante o benefício soma', async () => {
  const planoAdm = require('../src/financeiro/plano-administrativo');
  const c = await contaComBeneficio('prime');
  try {
    await pagar(c, 'pro');
    await pagar(c, 'pro'); // renovou enquanto o Prime valia
    const { conta: meio } = await estado(c.id);
    assert.ok(meio.plano_pago_guardado_dias >= 56, 'dois ciclos guardados');
    await pool.query(
      `UPDATE planos_administrativos SET valido_ate = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE anunciante_id = $1`,
      [c.id],
    );
    await pool.query(
      `UPDATE anunciantes SET data_expiracao = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE id = $1`,
      [c.id],
    );
    await planoAdm.encerrarBeneficiosVencidos({ apenasContas: [c.id] });
    const { conta } = await estado(c.id);
    assert.equal(conta.plano_id, PLANO.pro, 'voltou pro Pro pago');
    assert.equal(conta.plano_cortesia, false);
    assert.equal(String(conta.data_expiracao).slice(0, 10), somar(meio.plano_pago_guardado_dias));
  } finally {
    await apagar(c.id);
  }
});

test('job diário: a varredura de cobertura vencida não apaga o pago guardado sob o benefício', async () => {
  const planoAdm = require('../src/financeiro/plano-administrativo');
  const { encerrarCoberturaVencida } = require('../src/financeiro/conciliacao');
  const c = await contaComBeneficio('prime');
  try {
    await pagar(c, 'pro');
    await pool.query(
      `UPDATE planos_administrativos SET valido_ate = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE anunciante_id = $1`,
      [c.id],
    );
    await pool.query(
      `UPDATE anunciantes SET data_expiracao = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE id = $1`,
      [c.id],
    );
    // Mesma ordem do scripts/conciliar.js: a varredura roda antes.
    const varridas = await encerrarCoberturaVencida({ apenasContas: [c.id] });
    assert.ok(!varridas.some((v) => v.id === c.id), 'o benefício é da rotina de benefícios');
    await planoAdm.encerrarBeneficiosVencidos({ apenasContas: [c.id] });
    const { conta } = await estado(c.id);
    assert.equal(conta.plano_id, PLANO.pro, 'voltou pro Pro pago');
    assert.equal(conta.plano_pago_guardado_id, null);
  } finally {
    await apagar(c.id);
  }
});

test('encerrar a cortesia por cima do pago guardado devolve o pago, nunca apaga', async () => {
  const planoAdm = require('../src/financeiro/plano-administrativo');
  const c = await contaComBeneficio('prime');
  try {
    await pagar(c, 'pro');
    const { conta: antes } = await estado(c.id);
    await planoAdm.encerrar({ conta: antes, adminUsuario: 'teste', motivo: 'cancelado' });
    const { conta } = await estado(c.id);
    assert.equal(conta.plano_id, PLANO.pro);
    assert.equal(conta.plano_cortesia, false);
    assert.equal(String(conta.data_expiracao).slice(0, 10), somar(antes.plano_pago_guardado_dias));
  } finally {
    await apagar(c.id);
  }
});

test('fila: benefício PROGRAMADO menor que o novo pago é encerrado; igual ou maior fica', async () => {
  const menor = await contaComBeneficio('essencial', { plano_id: null, plano_cortesia: false, data_expiracao: null });
  const maior = await contaComBeneficio('prime', { plano_id: null, plano_cortesia: false, data_expiracao: null });
  try {
    for (const c of [menor, maior]) {
      await pool.query(
        `UPDATE planos_administrativos SET status = 'agendado', ativado_em = NULL WHERE anunciante_id = $1`,
        [c.id],
      );
      await pagar(c, 'pro');
    }
    assert.deepEqual((await estado(menor.id)).historico, [
      { plano_id: PLANO.essencial, status: 'encerrado', encerrado_motivo: 'superado_por_plano_pago' },
    ]);
    assert.deepEqual((await estado(maior.id)).historico, [
      { plano_id: PLANO.prime, status: 'agendado', encerrado_motivo: null },
    ]);
    assert.equal((await estado(maior.id)).conta.plano_id, PLANO.pro, 'Pro pago agora, Prime programado depois');
  } finally {
    await apagar(menor.id);
    await apagar(maior.id);
  }
});

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-fila', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/financeiro/routes').router);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    assinar: async (conta, planoId, extra = {}) => {
      const r = await fetch(`${base}/anunciantes/${conta}/assinar`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-conta': String(conta) },
        body: JSON.stringify({ planoId, ...extra }),
      });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    fechar: () => new Promise((r) => server.close(r)),
  };
}

test('/assinar com benefício em vigor pede confirmação ANTES de pagar, com o texto do que acontece', async () => {
  const c = await contaComBeneficio('essencial');
  const app = await subirApp();
  try {
    const maior = await app.assinar(c.id, PLANO.prime);
    assert.equal(maior.status, 409);
    assert.match(maior.corpo.confirmacao.texto, /será encerrado e os créditos utilizados não serão devolvidos/);
    assert.match(maior.corpo.confirmacao.texto, /começa imediatamente/);
    const igual = await app.assinar(c.id, PLANO.essencial);
    assert.equal(igual.status, 409);
    assert.match(igual.corpo.confirmacao.texto, /começa logo depois/);
    const confirmado = await app.assinar(c.id, PLANO.prime, { confirmarBeneficio: true });
    assert.equal(confirmado.status, 200, JSON.stringify(confirmado.corpo));
    assert.ok(confirmado.corpo.checkoutUrl);
    const { historico } = await estado(c.id);
    assert.equal(historico[0].status, 'ativo', 'nada muda antes do pagamento confirmar');
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('resgate enquanto paga: menor que o plano base é recusado sem consumir crédito', async () => {
  const creditosRepo = require('../src/creditos/repository');
  const c = await contaComBeneficio('pro', { plano_cortesia: false, cortesia_motivo: null });
  await pool.query(`DELETE FROM planos_administrativos WHERE anunciante_id = $1`, [c.id]);
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-fila-2', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/creditos/routes'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    await creditosRepo.concederAdmin(c.id, 10, { motivo: 'teste' });
    const r = await fetch(`http://127.0.0.1:${server.address().port}/anunciantes/me/creditos/resgatar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-conta': String(c.id) },
      body: JSON.stringify({ tier: 'essencial', meses: 1 }),
    });
    assert.equal(r.status, 409);
    assert.match((await r.json()).erro, /Seu plano Pro já oferece mais recursos que o benefício Essencial/);
    assert.equal(await creditosRepo.saldo(c.id), 10);
    const g = await fetch(`http://127.0.0.1:${server.address().port}/anunciantes/me/creditos`, {
      headers: { 'x-conta': String(c.id) },
    });
    const d = await g.json();
    assert.ok(
      d.opcoes.filter((o) => o.tier === 'essencial').every((o) => !o.disponivel && o.bloqueio),
      'as opções abaixo do plano aparecem indisponíveis, com o motivo',
    );
  } finally {
    await new Promise((r) => server.close(r));
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [c.id]);
    await apagar(c.id);
  }
});

test.after(() => pool.end());
