require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const { custoDoBeneficio, opcoesDisponiveis } = require('../src/creditos/regras');
const { nomeDoCiclo, comNomeDeCiclo, duracaoDoCiclo } = require('../src/lib/ciclos');
const creditosRepo = require('../src/creditos/repository');

// Benefício por créditos = CICLO (24/09/2026, ADR-018): mesma linguagem do
// plano pago — Mensal, Trimestral, Semestral, Anual — e mesma tabela de
// créditos de sempre, linear (custo mensal × meses, sem desconto por ciclo).

const TABELA = {
  essencial: { 1: 3, 3: 9, 6: 18, 12: 36 },
  destaque: { 1: 7, 3: 21, 6: 42, 12: 84 },
  maximo: { 1: 10, 3: 30, 6: 60, 12: 120 },
};

test('tabela de créditos por ciclo: Essencial 3/9/18/36, Pro 7/21/42/84, Prime 10/30/60/120', () => {
  for (const [tier, linha] of Object.entries(TABELA)) {
    for (const [meses, custo] of Object.entries(linha)) {
      assert.equal(custoDoBeneficio(tier, Number(meses)), custo, `${tier} ${meses}`);
      assert.equal(custo, TABELA[tier][1] * Number(meses), 'linear, sem desconto por ciclo');
    }
  }
  assert.equal(custoDoBeneficio('maximo', 2), null, 'só os 4 ciclos do plano pago');
});

test('opções trazem o nome do ciclo, igual ao plano pago', () => {
  const ciclos = [...new Set(opcoesDisponiveis(0).map((o) => `${o.meses}:${o.ciclo}`))];
  assert.deepEqual(ciclos, ['1:Mensal', '3:Trimestral', '6:Semestral', '12:Anual']);
  assert.equal(nomeDoCiclo(6), 'Semestral');
  assert.equal(duracaoDoCiclo(6), '6 meses', 'a duração continua como explicação secundária');
  assert.equal(duracaoDoCiclo(1), '1 mês');
});

test('registro antigo "· 6 meses" aparece como ciclo só quando é inequívoco', () => {
  assert.equal(comNomeDeCiclo('Resgate: Prime · 6 meses'), 'Resgate: Prime · Semestral');
  assert.equal(comNomeDeCiclo('Resgate: Essencial · 1 mês'), 'Resgate: Essencial · Mensal');
  assert.equal(comNomeDeCiclo('Resgate: Pro · 12 meses'), 'Resgate: Pro · Anual');
  assert.equal(comNomeDeCiclo('Resgate: Pro · 2 meses'), 'Resgate: Pro · 2 meses', 'fora dos 4 ciclos: intacto');
  assert.equal(comNomeDeCiclo('parceria de 3 meses'), 'parceria de 3 meses', 'duração em texto livre: intacto');
  assert.equal(comNomeDeCiclo(null), null);
});

async function conta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis)
     VALUES (now(), $1, '11144477735', $2, '16999990000', 'x', '{anunciante}') RETURNING *`,
    [`Ciclo ${randomUUID().slice(0, 6)}`, `ciclo-${randomUUID()}@example.com`],
  );
  return rows[0];
}

async function apagar(id) {
  await require('../src/lib/eventos').aguardarGravacoes(); // métrica grava solta; espera terminar antes de apagar
  for (const t of ['notificacoes', 'planos_administrativos', 'creditos_ledger', 'eventos']) {
    await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]);
  }
  await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-ciclo', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/creditos/routes'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (conta, caminho, corpo) => {
    const r = await fetch(`${base}${caminho}`, {
      method: corpo ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json', 'x-conta': String(conta) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

test('resgate: "Prime · Semestral", 60 créditos, 6 meses de duração; histórico e notificação no mesmo nome', async () => {
  const c = await conta();
  const app = await subirApp();
  try {
    await creditosRepo.concederAdmin(c.id, 60, { motivo: 'teste' });
    // Registro ANTIGO (antes do ADR-018) continua íntegro no banco.
    await pool.query(
      `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao) VALUES ($1, 'concessao_admin', 18, 'teste antigo'),
              ($1, 'resgate_beneficio', -18, 'Resgate: Essencial · 6 meses')`,
      [c.id],
    );
    const r = await app.chamar(c.id, '/anunciantes/me/creditos/resgatar', { tier: 'maximo', meses: 6 });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const { rows: ledger } = await pool.query(
      `SELECT observacao, quantidade FROM creditos_ledger WHERE anunciante_id = $1 AND tipo = 'resgate_beneficio' ORDER BY id`,
      [c.id],
    );
    assert.deepEqual(
      ledger.map((l) => [l.observacao, l.quantidade]),
      [
        ['Resgate: Essencial · 6 meses', -18],
        ['Resgate: Prime · Semestral', -60],
      ],
      'o registro antigo não é reescrito; o novo já nasce com o ciclo',
    );
    const { rows: plano } = await pool.query(
      `SELECT p.compromisso_meses, h.valido_ate - (now() AT TIME ZONE 'America/Sao_Paulo')::date AS dias
         FROM planos_administrativos h JOIN planos p ON p.id = h.plano_id WHERE h.anunciante_id = $1`,
      [c.id],
    );
    assert.equal(plano[0].compromisso_meses, 6);
    assert.equal(plano[0].dias, 180, '6 meses de 30 dias');
    const { rows: avisos } = await pool.query(`SELECT titulo FROM notificacoes WHERE anunciante_id = $1`, [c.id]);
    assert.ok(avisos.some((a) => a.titulo === 'Prime · Semestral ativado por créditos'));

    const g = await app.chamar(c.id, '/anunciantes/me/creditos');
    assert.equal(g.corpo.beneficioAtivo.nome, 'Prime · Semestral');
    assert.equal(g.corpo.beneficioAtivo.ciclo, 'Semestral');
    const obs = g.corpo.movimentacoes.filter((m) => m.tipo === 'resgate_beneficio').map((m) => m.observacao);
    assert.deepEqual(obs.sort(), ['Resgate: Essencial · Semestral', 'Resgate: Prime · Semestral']);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('benefício por créditos NUNCA renova sozinho nem consome crédito no fim', async () => {
  const planoAdm = require('../src/financeiro/plano-administrativo');
  const c = await conta();
  const app = await subirApp();
  try {
    await creditosRepo.concederAdmin(c.id, 100, { motivo: 'teste' });
    const r = await app.chamar(c.id, '/anunciantes/me/creditos/resgatar', { tier: 'essencial', meses: 1 });
    assert.equal(r.status, 200);
    const saldoDepoisDoResgate = await creditosRepo.saldo(c.id);
    assert.equal(saldoDepoisDoResgate, 97);
    await pool.query(
      `UPDATE planos_administrativos SET valido_ate = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE anunciante_id = $1`,
      [c.id],
    );
    await pool.query(
      `UPDATE anunciantes SET data_expiracao = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE id = $1`,
      [c.id],
    );
    await planoAdm.encerrarBeneficiosVencidos({ apenasContas: [c.id] });
    await planoAdm.ativarBeneficiosAgendados({ apenasContas: [c.id] });
    const {
      rows: [depois],
    } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [c.id]);
    assert.equal(depois.plano_id, null, 'sem plano pago nem benefício programado: fica sem plano');
    assert.equal(await creditosRepo.saldo(c.id), 97, 'nenhum crédito consumido automaticamente');
    const { rows } = await pool.query(`SELECT status FROM planos_administrativos WHERE anunciante_id = $1`, [c.id]);
    assert.deepEqual(
      rows.map((x) => x.status),
      ['encerrado'],
      'nenhum benefício novo criado',
    );
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test.after(() => pool.end());
