require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const repo = require('../src/creditos/repository');
const planoAdministrativo = require('../src/financeiro/plano-administrativo');

// Resgate de créditos pela rota de verdade (Fatia 1 da reconstrução do
// painel, 23/09/2026). Cobre os quatro furos achados antes de montar a UI:
// benefício agendado nascendo vencido, resgate por cima de benefício aberto
// jogando fora dias/créditos, dois resgates simultâneos passando do saldo, e
// o cupom de indicação existindo só pra quem tinha ponto.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-resgate', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/creditos/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, conta, corpo) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'x-conta': String(conta) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function conta(extra = {}) {
  const campos = {
    nome_empresa: `Resgate ${randomUUID().slice(0, 6)}`,
    cpf_cnpj: '11144477735',
    contato_email: `resgate-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    papeis: '{anunciante}',
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

async function apagar(id) {
  await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

const hoje = () => new Date().toISOString().slice(0, 10);
const somar = (iso, dias) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

test('GET: toda conta ganha cupom de indicação, estável entre chamadas', async () => {
  const c = await conta();
  const app = await subirApp();
  try {
    const a = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.equal(a.status, 200);
    assert.match(a.corpo.indicacao.codigo, /^PT-/, 'conta sem ponto também indica');
    assert.equal(a.corpo.indicacao.cadastradas, 0);
    const [b, d] = await Promise.all([
      app.chamar('GET', '/anunciantes/me/creditos', c.id),
      app.chamar('GET', '/anunciantes/me/creditos', c.id),
    ]);
    assert.equal(b.corpo.indicacao.codigo, a.corpo.indicacao.codigo);
    assert.equal(d.corpo.indicacao.codigo, a.corpo.indicacao.codigo);
    assert.equal(a.corpo.resgate.permitido, true);
    assert.equal(a.corpo.opcoes.length, 12);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('sem plano pago: ativa na hora, validade = hoje + 30 dias por mês, débito ligado ao benefício', async () => {
  const c = await conta();
  const app = await subirApp();
  try {
    await repo.concederAdmin(c.id, 9, { motivo: 'teste' });
    const r = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.equal(r.corpo.status, 'ativo');
    assert.equal(r.corpo.validoAte, somar(hoje(), 90));
    assert.equal(await repo.saldo(c.id), 0);
    const [h] = await planoAdministrativo.historicoDaConta(c.id);
    assert.ok(h.ledger_id, 'o benefício sabe qual débito pagou por ele');
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('com ciclo pago em curso: agenda e conta a validade a partir do FIM do ciclo pago', async () => {
  const fimPago = somar(hoje(), 40);
  const c = await conta({ plano_id: 'destaque-1m', plano_cortesia: false, data_expiracao: fimPago });
  const app = await subirApp();
  try {
    await repo.concederAdmin(c.id, 3, { motivo: 'teste' });
    const r = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.equal(r.corpo.status, 'agendado');
    assert.equal(r.corpo.comecaEm, fimPago);
    // Antes: hoje + 30 — antes mesmo de o ciclo pago acabar, nascia vencido.
    assert.equal(r.corpo.validoAte, somar(fimPago, 30));
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('ativação atrasada (assinatura renovou) preserva a duração comprada', async () => {
  const c = await conta();
  try {
    // Agendado para começar há 10 dias, 30 dias de duração — mas só ativa hoje.
    const inicioPrevisto = somar(hoje(), -10);
    await pool.query(
      `INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, plano_anterior_valido_ate, status, origem)
       VALUES ($1, 'essencial-1m', $2, $3, 'agendado', 'indicacao')`,
      [c.id, somar(inicioPrevisto, 30), inicioPrevisto],
    );
    await planoAdministrativo.ativarBeneficiosAgendados();
    const { rows } = await pool.query('SELECT data_expiracao FROM anunciantes WHERE id = $1', [c.id]);
    assert.equal(rows[0].data_expiracao, somar(hoje(), 30), 'os 30 dias contam de hoje, não de 10 dias atrás');
  } finally {
    await apagar(c.id);
  }
});

test('benefício aberto bloqueia novo resgate, sem debitar nada', async () => {
  const c = await conta();
  const app = await subirApp();
  try {
    await repo.concederAdmin(c.id, 20, { motivo: 'teste' });
    assert.equal(
      (await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 1 })).status,
      200,
    );
    const saldoAntes = await repo.saldo(c.id);
    const r = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'destaque', meses: 1 });
    assert.equal(r.status, 409);
    assert.match(r.corpo.erro, /já tem um benefício em vigor/);
    assert.equal(await repo.saldo(c.id), saldoAntes, 'nenhum crédito sumiu');
    const g = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.equal(g.corpo.resgate.permitido, false, 'a tela explica antes de o cliente tentar');
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('dois resgates simultâneos com saldo para um só: um passa, o saldo nunca fica negativo', async () => {
  const c = await conta();
  const app = await subirApp();
  try {
    await repo.concederAdmin(c.id, 3, { motivo: 'teste' });
    const rs = await Promise.all([
      app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 1 }),
      app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 1 }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await repo.saldo(c.id), 0);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test('saldo insuficiente e período inválido são recusados', async () => {
  const c = await conta();
  const app = await subirApp();
  try {
    await repo.concederAdmin(c.id, 2, { motivo: 'teste' });
    const semSaldo = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, {
      tier: 'essencial',
      meses: 1,
    });
    assert.equal(semSaldo.status, 409);
    assert.match(semSaldo.corpo.erro, /faltam 1 crédito/);
    const invalido = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, {
      tier: 'essencial',
      meses: 2,
    });
    assert.equal(invalido.status, 400);
  } finally {
    await app.fechar();
    await apagar(c.id);
  }
});

test.after(() => pool.end());
