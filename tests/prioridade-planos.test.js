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
    'ciclos_contratados',
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
    trocar: async (conta, planoNovoId) => {
      const r = await fetch(`${base}/anunciantes/me/trocar-plano`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-conta': String(conta) },
        body: JSON.stringify({ planoNovoId }),
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
    assert.match(maior.corpo.confirmacao.texto, /começa na hora/);
    assert.equal(maior.corpo.confirmacao.botaoManter, 'Manter plano atual');
    assert.equal(maior.corpo.confirmacao.atual.origem, 'Benefício por créditos');
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

// Conta PAGANDO `tierPago` em dia, com a assinatura ativa, e um benefício
// por créditos PROGRAMADO (`tierProgramado`) pra quando o pago acabar — o
// estado que o resgate "igual ou maior que o pago" deixa (ADR-016).
async function pagandoComProgramado(tierPago, tierProgramado) {
  const c = await contaComBeneficio(tierPago, { plano_cortesia: false, cortesia_motivo: null });
  await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = $1', [c.id]);
  await pool.query(
    `INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, plano_anterior_id,
                                         plano_anterior_origem, plano_anterior_valido_ate)
     VALUES ($1, $2, $3, 'agendado', 'indicacao', $4, 'assinatura', $5)`,
    [c.id, PLANO[tierProgramado], somar(70), PLANO[tierPago], somar(40)],
  );
  const antiga = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO[tierPago], status: 'ativa' });
  return { c, antiga };
}

// Caso 2 do mapa de pago × benefício (26/09/2026): a troca de plano pago
// (síncrona ou aprovada pelo webhook `plano_trocado`) passa pelo mesmo passo
// do ciclo pago — benefício PROGRAMADO de nível menor que o novo pago é
// encerrado, senão ele ativaria por cima do pago maior quando o ciclo
// acabasse (`ativarBeneficiosAgendados` não compara nível).
test('trocar-plano pra um nível maior encerra o benefício PROGRAMADO menor (troca sem acerto, síncrona)', async () => {
  const { c } = await pagandoComProgramado('pro', 'pro');
  const original = sc.trocarPlano;
  sc.trocarPlano = async () => ({
    status: 200,
    corpo: { valor: 199.99, ciclo: 'MONTHLY', acerto: { cobrado: false } },
  });
  const app = await subirApp();
  try {
    const r = await app.trocar(c.id, PLANO.prime);
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const { conta, historico } = await estado(c.id);
    assert.equal(conta.plano_id, PLANO.prime, 'o Prime pago entrou');
    assert.deepEqual(historico, [
      { plano_id: PLANO.pro, status: 'encerrado', encerrado_motivo: 'superado_por_plano_pago' },
    ]);
  } finally {
    sc.trocarPlano = original;
    await app.fechar();
    await apagar(c.id);
  }
});

test('trocar-plano pra um nível menor mantém o benefício programado igual ou maior na fila', async () => {
  const { c } = await pagandoComProgramado('pro', 'prime');
  const original = sc.trocarPlano;
  sc.trocarPlano = async () => ({ status: 200, corpo: { valor: 99.99, ciclo: 'MONTHLY', acerto: { cobrado: false } } });
  const app = await subirApp();
  try {
    const r = await app.trocar(c.id, PLANO.essencial);
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const { historico } = await estado(c.id);
    assert.deepEqual(historico, [{ plano_id: PLANO.prime, status: 'agendado', encerrado_motivo: null }]);
  } finally {
    sc.trocarPlano = original;
    await app.fechar();
    await apagar(c.id);
  }
});

test('webhook plano_trocado (troca com acerto aprovada) também encerra o benefício programado menor', async () => {
  const { c, antiga } = await pagandoComProgramado('pro', 'pro');
  const nova = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO.prime, status: 'pendente_troca' });
  try {
    await sc.processarWebhookAssinatura({
      versao: 2,
      eventoId: `evt-troca-${randomUUID()}`,
      tipo: 'assinatura',
      planoId: nova.id,
      planoAnterior: antiga.id,
      documento: '11144477735',
      evento: 'plano_trocado',
      valor: 199.99,
      ciclo: 'MONTHLY',
      acertoCobrado: 0,
    });
    const { conta, historico } = await estado(c.id);
    assert.equal(conta.plano_id, PLANO.prime, 'a troca aprovada foi aplicada');
    assert.deepEqual(historico, [
      { plano_id: PLANO.pro, status: 'encerrado', encerrado_motivo: 'superado_por_plano_pago' },
    ]);
  } finally {
    await pool.query('DELETE FROM webhooks_processados WHERE id LIKE $1', ['%evt-troca-%']);
    await apagar(c.id);
  }
});

// ---------------------------------------------------------------------------
// Caso 1 do mapa de pago × benefício (26/09/2026, decisão do dono): conta em
// benefício por créditos com a assinatura paga GUARDADA por baixo. Antes, se
// os dois eram o mesmo plano, /assinar mandava "use Trocar de plano" e
// trocar-plano recusava conta em benefício — um beco. Agora:
//   · mesmo plano/ciclo que já paga → 409 claro, nada muda;
//   · outro plano → o caminho que já valia pra planos diferentes: cancela a
//     assinatura cobrada no Checkout, cria a nova; os dias guardados somam no
//     plano novo quando ele for pago; o ADR-016 decide quando ele entra; o
//     benefício na frente continua.
const creditosRepoFila = require('../src/creditos/repository');
const planoAdministrativo = require('../src/financeiro/plano-administrativo');
const diasDeUmMes = () => {
  const hoje = new Date(`${vigencia.hojeComercial()}T00:00:00Z`);
  const fim = new Date(hoje);
  fim.setUTCMonth(fim.getUTCMonth() + 1);
  return Math.round((fim - hoje) / 86400000);
};

async function beneficioSobrePago(tierBeneficio, tierPago) {
  const c = await contaComBeneficio(tierBeneficio, {
    plano_pago_guardado_id: PLANO[tierPago],
    plano_pago_guardado_dias: 30,
  });
  // O benefício foi pago com créditos: débito real no ledger, ligado a ele.
  await creditosRepoFila.concederAdmin(c.id, 7, { motivo: 'teste' });
  const debito = await creditosRepoFila.debitarResgate(c.id, 7, 'Resgate: teste');
  await pool.query('UPDATE planos_administrativos SET ledger_id = $2 WHERE anunciante_id = $1', [c.id, debito.id]);
  const paga = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO[tierPago], status: 'ativa' });
  await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status) VALUES ($1, $2, 199.99, 'pendente')`,
    [c.id, PLANO[tierPago]],
  );
  await cicloPagoDe(c.id, PLANO[tierPago], paga.id);
  return { c, paga };
}

// O snapshot que um ciclo pago de verdade deixa (migration 087): é por ele
// que uma assinatura cancelada "já teve ciclo pago" e sua renovação atrasada
// ainda credita.
async function cicloPagoDe(contaId, planoId, assinaturaId) {
  await pool.query(
    `INSERT INTO ciclos_contratados (anunciante_id, plano_id, assinatura_id, origem, ciclo_meses, valor_ciclo,
                                     exibicoes_previstas_mes, exibicoes_previstas_ciclo)
     VALUES ($1, $2, $3, 'compra', 1, 199.99, 1, 1)`,
    [contaId, planoId, assinaturaId],
  );
}

async function retrato(contaId) {
  const q = async (sql) => (await pool.query(sql, [contaId])).rows;
  return {
    conta: await q(
      `SELECT plano_id, plano_cortesia, data_expiracao, plano_pago_guardado_id, plano_pago_guardado_dias
         FROM anunciantes WHERE id = $1`,
    ),
    assinaturas: await q(
      'SELECT id, plano_id, status FROM assinaturas WHERE anunciante_id = $1 ORDER BY created_at, id',
    ),
    beneficios: await q(
      'SELECT id, plano_id, status, encerrado_motivo, valido_ate FROM planos_administrativos WHERE anunciante_id = $1 ORDER BY id',
    ),
    cobrancas: await q('SELECT count(*)::int AS n FROM cobrancas_confirmadas WHERE anunciante_id = $1'),
    ledger: await q('SELECT tipo, quantidade FROM creditos_ledger WHERE anunciante_id = $1 ORDER BY id'),
  };
}

function contandoCancelamentos() {
  const original = sc.cancelarAssinatura;
  const chamadas = [];
  sc.cancelarAssinatura = async (id) => {
    chamadas.push(id);
  };
  return { chamadas, restaurar: () => (sc.cancelarAssinatura = original) };
}

test('benefício + MESMO plano pago guardado: /assinar → 409 claro, sem nenhuma mutação', async () => {
  const { c } = await beneficioSobrePago('pro', 'pro');
  const cancel = contandoCancelamentos();
  const app = await subirApp();
  try {
    const antes = await retrato(c.id);
    for (const extra of [{}, { confirmarBeneficio: true }]) {
      const r = await app.assinar(c.id, PLANO.pro, extra);
      assert.equal(r.status, 409);
      assert.equal(
        r.corpo.erro,
        'Você já possui o Pro · Mensal pago. Ele voltará automaticamente quando seu benefício atual terminar.',
      );
    }
    assert.deepEqual(await retrato(c.id), antes, 'nada criado, cancelado, cobrado ou mexido');
    assert.equal(cancel.chamadas.length, 0, 'nada cancelado no Checkout');
  } finally {
    cancel.restaurar();
    await app.fechar();
    await apagar(c.id);
  }
});

test('benefício + pago A (mesmo plano) → contratar B: troca no plano guardado, benefício intacto, dias somados uma vez, sem estorno, fim do benefício traz B', async () => {
  const { c, paga } = await beneficioSobrePago('pro', 'pro');
  const cancel = contandoCancelamentos();
  const app = await subirApp();
  try {
    const antes = await retrato(c.id);
    // Antes: "use Trocar de plano" (beco). Agora: o aviso do benefício e,
    // confirmado, o link da assinatura NOVA.
    const aviso = await app.assinar(c.id, PLANO.essencial);
    assert.equal(aviso.status, 409);
    assert.ok(aviso.corpo.confirmacao, 'o aviso do benefício vem antes');
    const r = await app.assinar(c.id, PLANO.essencial, { confirmarBeneficio: true });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.ok(r.corpo.checkoutUrl);

    // A assinatura A (já cobrada) foi cancelada no Checkout UMA vez; B nasceu
    // pendente de pagamento. Nada cobrado ainda.
    assert.deepEqual(cancel.chamadas, [paga.id]);
    const pedido = await retrato(c.id);
    assert.deepEqual(
      pedido.assinaturas.map((a) => [a.plano_id, a.status]),
      [
        [PLANO.pro, 'cancelada'],
        [PLANO.essencial, 'pendente_pagamento'],
      ],
    );
    assert.deepEqual(pedido.conta, antes.conta, 'conta intacta até o pagamento: benefício na frente, A guardado');
    assert.deepEqual(pedido.beneficios, antes.beneficios, 'o benefício não é encerrado pelo pedido');
    assert.equal(pedido.cobrancas[0].n, antes.cobrancas[0].n);

    // Pagamento de B (webhook v2, entregue duas vezes): um ciclo só.
    const nova = pedido.assinaturas[1];
    const eventoId = `evt-beco-${randomUUID()}`;
    const payload = {
      versao: 2,
      tipo: 'assinatura',
      eventoId,
      ocorridoEm: new Date().toISOString(),
      planoId: nova.id,
      documento: '11144477735',
      assinaturaId: `sub-beco-${randomUUID()}`,
      chargeId: `pay-beco-${randomUUID()}`,
      statusFinanceiro: 'confirmado',
      ciclo: 'MONTHLY',
      cicloCanonico: 'mensal',
      metodoPagamento: 'assinatura',
      evento: 'criada',
      valor: 99.99,
    };
    const fetchOriginal = globalThis.fetch;
    globalThis.fetch = async (url) => {
      throw new Error(`o pagamento v2 não consulta o Checkout: ${url}`);
    };
    try {
      await sc.processarWebhookAssinatura(payload);
      await sc.processarWebhookAssinatura(payload);
      await sc.processarWebhookAssinatura({ ...payload, eventoId: `${eventoId}-2` });
    } finally {
      globalThis.fetch = fetchOriginal;
    }

    const pago = await retrato(c.id);
    assert.equal(pago.cobrancas[0].n, antes.cobrancas[0].n + 1, 'uma cobrança só, mesmo com reentrega');
    const [conta] = pago.conta;
    assert.equal(conta.plano_id, PLANO.pro, 'o benefício Pro continua valendo agora');
    assert.equal(conta.plano_cortesia, true);
    assert.equal(conta.plano_pago_guardado_id, PLANO.essencial, 'o plano guardado agora é B');
    assert.equal(conta.plano_pago_guardado_dias, 30 + diasDeUmMes(), 'os 30 dias de A + o mês de B, uma vez');
    assert.deepEqual(
      pago.beneficios.map((b) => [b.status, b.encerrado_motivo]),
      [['ativo', null]],
      'benefício intacto',
    );
    assert.deepEqual(pago.ledger, antes.ledger, 'nenhum crédito devolvido nem mexido');

    // Fim do benefício: entra exatamente B, com os dias guardados.
    await pool.query(
      `UPDATE planos_administrativos SET valido_ate = $2 WHERE anunciante_id = $1 AND status = 'ativo'`,
      [c.id, somar(-1)],
    );
    await pool.query('UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1', [c.id, somar(-1)]);
    await planoAdministrativo.encerrarBeneficiosVencidos({ apenasContas: [c.id] });
    const [fim] = (await retrato(c.id)).conta;
    assert.equal(fim.plano_id, PLANO.essencial, 'entra o plano pago B');
    assert.equal(fim.plano_cortesia, false);
    assert.equal(String(fim.data_expiracao).slice(0, 10), somar(30 + diasDeUmMes()));
    assert.equal(fim.plano_pago_guardado_id, null);
  } finally {
    cancel.restaurar();
    await app.fechar();
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [c.id]);
    await pool.query("DELETE FROM webhooks_processados WHERE id LIKE '%beco%'");
    await apagar(c.id);
  }
});

// Revisão Codex do PR #78: renovação ATRASADA da assinatura antiga A (já
// cancelada, mas com ciclo pago antes — o dinheiro entrou de verdade)
// processada DEPOIS de B pago. O ciclo soma os dias pagos, mas nunca desfaz
// a escolha mais nova do cliente nem encerra o benefício.
async function pagarPorWebhook(assinaturaId) {
  const fetchOriginal = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`o pagamento v2 não consulta o Checkout: ${url}`);
  };
  try {
    await sc.processarWebhookAssinatura({
      versao: 2,
      tipo: 'assinatura',
      eventoId: `evt-atraso-${randomUUID()}`,
      ocorridoEm: new Date().toISOString(),
      planoId: assinaturaId,
      documento: '11144477735',
      assinaturaId: `sub-atraso-${randomUUID()}`,
      chargeId: `pay-atraso-${randomUUID()}`,
      statusFinanceiro: 'confirmado',
      ciclo: 'MONTHLY',
      cicloCanonico: 'mensal',
      metodoPagamento: 'assinatura',
      evento: 'cobranca_confirmada',
      valor: 99.99,
    });
  } finally {
    globalThis.fetch = fetchOriginal;
  }
}

test('benefício: renovação atrasada da assinatura antiga A, depois de B pago, soma os dias e mantém B', async () => {
  const { c, paga } = await beneficioSobrePago('pro', 'pro');
  const cancel = contandoCancelamentos();
  const app = await subirApp();
  try {
    const r = await app.assinar(c.id, PLANO.essencial, { confirmarBeneficio: true });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const { rows: novas } = await pool.query(`SELECT id FROM assinaturas WHERE anunciante_id = $1 AND plano_id = $2`, [
      c.id,
      PLANO.essencial,
    ]);
    await pagarPorWebhook(novas[0].id); // B pago
    await pagarPorWebhook(paga.id); // renovação atrasada de A (cancelada)
    const [conta] = (await retrato(c.id)).conta;
    assert.equal(conta.plano_id, PLANO.pro, 'o benefício continua na frente');
    assert.equal(conta.plano_cortesia, true);
    assert.equal(conta.plano_pago_guardado_id, PLANO.essencial, 'B continua sendo o plano guardado');
    assert.equal(conta.plano_pago_guardado_dias, 30 + 2 * diasDeUmMes(), 'os dias pagos de A e B somam');
    const { rows: beneficios } = await pool.query(
      `SELECT status FROM planos_administrativos WHERE anunciante_id = $1`,
      [c.id],
    );
    assert.deepEqual(
      beneficios.map((b) => b.status),
      ['ativo'],
    );
  } finally {
    cancel.restaurar();
    await app.fechar();
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [c.id]);
    await pool.query("DELETE FROM webhooks_processados WHERE id LIKE '%atraso%'");
    await apagar(c.id);
  }
});

test('sem benefício: renovação atrasada de uma assinatura já substituída estende a cobertura e mantém o plano atual', async () => {
  const c = await contaComBeneficio('essencial', { plano_cortesia: false, cortesia_motivo: null });
  await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = $1', [c.id]);
  // A (Pro) paga e depois cancelada; B (Essencial) é o plano pago em vigor.
  const antiga = await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO.pro, status: 'cancelada' });
  await cicloPagoDe(c.id, PLANO.pro, antiga.id);
  await assinaturasRepo.criar({ anuncianteId: c.id, planoId: PLANO.essencial, status: 'ativa' });
  const antes = (await retrato(c.id)).conta[0];
  try {
    await pagarPorWebhook(antiga.id);
    const [conta] = (await retrato(c.id)).conta;
    assert.equal(conta.plano_id, PLANO.essencial, 'o plano escolhido depois não volta pro antigo');
    assert.ok(
      String(conta.data_expiracao).slice(0, 10) > String(antes.data_expiracao).slice(0, 10),
      'o ciclo pago estende a cobertura',
    );
  } finally {
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [c.id]);
    await pool.query("DELETE FROM webhooks_processados WHERE id LIKE '%atraso%'");
    await apagar(c.id);
  }
});

test('trocar-plano continua recusando conta em benefício (sem segundo caminho financeiro)', async () => {
  const { c } = await beneficioSobrePago('pro', 'pro');
  const app = await subirApp();
  try {
    const r = await app.trocar(c.id, PLANO.prime);
    assert.equal(r.status, 400);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test.after(() => pool.end());
