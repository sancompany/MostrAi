require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const repo = require('../src/creditos/repository');
const { etapasDosPrimeirosPassos } = require('../src/anunciantes/primeiros-passos');

// Estação da conta (26/09/2026): o painel se adapta ao estado REAL da conta.
//   A — conta nova (sem plano, ponto, crédito ou histórico): créditos e
//       indicação escondidos; onboarding com o plano como próximo passo.
//   B — anunciante com compensação (saldo > 0, sem ponto): créditos sim,
//       indicação NÃO (crédito ≠ ponto). Depois de usar tudo: versão compacta.
//   C — ponto com saldo 0: créditos e indicação aparecem.
//   D — ponto + anunciante com plano: plano, créditos e indicação.
// E a troca de benefício por créditos (crédito → crédito) e o aviso da troca
// crédito → pago, com o que se perde.

process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-de-teste';

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-conta', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/creditos/routes'));
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/financeiro/routes').router);
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

const criadas = [];
async function conta(extra = {}) {
  const campos = {
    nome_empresa: `Conta ${randomUUID().slice(0, 6)}`,
    cpf_cnpj: '11144477735',
    contato_email: `conta-${randomUUID()}@example.com`,
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
  criadas.push(rows[0].id);
  return rows[0];
}

async function virarPonto(contaId) {
  await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
     VALUES ('Padaria da conta', 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'R', '16 9', $1)`,
    [contaId],
  );
}

test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criadas) {
    for (const tabela of ['notificacoes', 'planos_administrativos', 'creditos_ledger', 'eventos']) {
      await pool.query(`DELETE FROM ${tabela} WHERE anunciante_id = $1`, [id]);
    }
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
});

test('A — conta nova: créditos e indicação escondidos; onboarding começa pelo plano', async () => {
  const c = await conta();
  const app = await subirApp();
  try {
    const cr = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.equal(cr.status, 200);
    assert.deepEqual(cr.corpo.exibicao, { mostrar: false, compacto: false });
    assert.equal(cr.corpo.indicacao, null);
    const pp = await app.chamar('GET', '/anunciantes/me/primeiros-passos', c.id);
    assert.equal(pp.status, 200);
    assert.equal(pp.corpo.proxima, 'plano');
    assert.equal(pp.corpo.numeroDaProxima, 1);
    assert.equal(pp.corpo.jaTevePlano, false);
    assert.deepEqual(
      pp.corpo.etapas.map((e) => [e.id, e.feito, e.disponivel]),
      [
        ['plano', false, true],
        ['criativo', false, false],
        ['pontos', false, false],
        ['exibicoes', false, false],
      ],
    );
  } finally {
    await app.fechar();
  }
});

test('B — anunciante compensado pela Mostraí: créditos aparecem, indicação não; saldo zerado vira compacto', async () => {
  const c = await conta();
  await repo.concederAdmin(c.id, 9, { motivo: 'compensação' });
  const app = await subirApp();
  try {
    const cheio = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.deepEqual(cheio.corpo.exibicao, { mostrar: true, compacto: false });
    assert.equal(cheio.corpo.indicacao, null, 'crédito não libera indicação');
    const r = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 3 });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const zerado = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.equal(zerado.corpo.saldo, 0);
    assert.deepEqual(zerado.corpo.exibicao, { mostrar: true, compacto: true }, 'histórico fica, a tabela sai');
    assert.equal(zerado.corpo.indicacao, null);
  } finally {
    await app.fechar();
  }
});

test('C — ponto com saldo 0: créditos e indicação aparecem', async () => {
  const c = await conta({ papeis: '{ponto}' });
  await virarPonto(c.id);
  const app = await subirApp();
  try {
    const cr = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.equal(cr.corpo.saldo, 0);
    assert.equal(cr.corpo.ehPonto, true);
    assert.deepEqual(cr.corpo.exibicao, { mostrar: true, compacto: false });
    assert.match(cr.corpo.indicacao.codigo, /^PT-/);
  } finally {
    await app.fechar();
  }
});

test('C′ — candidatura em análise não é ponto: nada de indicação', async () => {
  const c = await conta();
  await pool.query(
    `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, endereco, cidade, uf, cep, conta_id, origem)
     VALUES ('ponto', 'Resp', 'Comércio em análise', '16999990000', 'Rua X, 1', 'Matão', 'SP', '15990-000', $1, 'painel')`,
    [c.id],
  );
  const app = await subirApp();
  try {
    const cr = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.equal(cr.corpo.ehPonto, false, 'pedido em análise não é ponto');
    assert.equal(cr.corpo.indicacao, null);
    assert.equal(cr.corpo.exibicao.mostrar, false);
  } finally {
    await app.fechar();
  }
});

test('D — ponto + anunciante com benefício: plano no onboarding feito, créditos e indicação', async () => {
  const c = await conta();
  await virarPonto(c.id);
  await repo.concederAdmin(c.id, 30, { motivo: 'teste' });
  const app = await subirApp();
  try {
    assert.equal(
      (await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'maximo', meses: 1 })).status,
      200,
    );
    const cr = await app.chamar('GET', '/anunciantes/me/creditos', c.id);
    assert.deepEqual(cr.corpo.exibicao, { mostrar: true, compacto: false });
    assert.ok(cr.corpo.indicacao);
    assert.equal(cr.corpo.beneficioAtivo.nome, 'Prime · Mensal');
    const pp = await app.chamar('GET', '/anunciantes/me/primeiros-passos', c.id);
    assert.equal(pp.corpo.etapas[0].feito, true);
    assert.equal(pp.corpo.proxima, 'criativo');
    assert.equal(pp.corpo.numeroDaProxima, 2);
    assert.equal(pp.corpo.jaTevePlano, true);
    const pontos = pp.corpo.etapas.find((e) => e.id === 'pontos');
    assert.equal(pontos.disponivel, false, 'no benefício a Mostraí distribui');
  } finally {
    await app.fechar();
  }
});

test('crédito → crédito: Essencial Trimestral ativo → Pro; cancelar não muda nada, confirmar troca uma vez', async () => {
  const c = await conta();
  await repo.concederAdmin(c.id, 40, { motivo: 'teste' });
  const app = await subirApp();
  try {
    assert.equal(
      (await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 3 })).status,
      200,
    );
    const saldoAntes = await repo.saldo(c.id); // 40 − 9 = 31

    // 1. escolhe o Pro → 2. o sistema mostra o impacto (sem debitar nada)
    const aviso = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'destaque', meses: 3 });
    assert.equal(aviso.status, 409);
    assert.equal(aviso.corpo.substituicao.nome, 'Essencial · Trimestral');
    assert.equal(aviso.corpo.substituicao.creditosGastos, 9);
    assert.ok(aviso.corpo.substituicao.validoAte);
    // "Manter plano atual" = não reenviar: nada mudou
    assert.equal(await repo.saldo(c.id), saldoAntes);
    const { rows: antes } = await pool.query(
      `SELECT status FROM planos_administrativos WHERE anunciante_id = $1 ORDER BY id`,
      [c.id],
    );
    assert.deepEqual(
      antes.map((r) => r.status),
      ['ativo'],
    );

    // 3. confirma → 4. executa
    const ok = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, {
      tier: 'destaque',
      meses: 3,
      substituirBeneficioId: aviso.corpo.substituicao.id,
    });
    assert.equal(ok.status, 200, JSON.stringify(ok.corpo));
    assert.equal(await repo.saldo(c.id), saldoAntes - 21, 'o Pro Trimestral custa 21, debitado uma vez');
    const { rows: depois } = await pool.query(
      `SELECT h.status, h.encerrado_motivo, p.tier FROM planos_administrativos h JOIN planos p ON p.id = h.plano_id
        WHERE h.anunciante_id = $1 ORDER BY h.id`,
      [c.id],
    );
    assert.deepEqual(depois, [
      { status: 'encerrado', encerrado_motivo: 'substituido', tier: 'essencial' },
      { status: 'ativo', encerrado_motivo: null, tier: 'destaque' },
    ]);
    const { rows: estornos } = await pool.query(
      `SELECT 1 FROM creditos_ledger WHERE anunciante_id = $1 AND quantidade > 0 AND tipo <> 'concessao_admin'`,
      [c.id],
    );
    assert.equal(estornos.length, 0, 'os créditos do Essencial não voltam');
    const { rows: conta2 } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [c.id]);
    assert.equal(conta2[0].plano_id, 'destaque-3m');

    // Duplo clique: o mesmo pedido de novo encontra o Pro e para, sem debitar.
    const repetido = await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, {
      tier: 'destaque',
      meses: 3,
      substituirBeneficioId: aviso.corpo.substituicao.id,
    });
    assert.equal(repetido.status, 409);
    assert.equal(await repo.saldo(c.id), saldoAntes - 21);
  } finally {
    await app.fechar();
  }
});

test('crédito → pago: /assinar mostra plano, origem, validade e créditos gastos antes de pagar', async () => {
  const c = await conta();
  await repo.concederAdmin(c.id, 9, { motivo: 'teste' });
  const app = await subirApp();
  try {
    assert.equal(
      (await app.chamar('POST', '/anunciantes/me/creditos/resgatar', c.id, { tier: 'essencial', meses: 3 })).status,
      200,
    );
    const r = await app.chamar('POST', `/anunciantes/${c.id}/assinar`, c.id, { planoId: 'maximo-1m' });
    assert.equal(r.status, 409);
    const cf = r.corpo.confirmacao;
    assert.equal(cf.titulo, 'Você já possui um benefício ativo');
    assert.equal(cf.encerraBeneficio, true);
    assert.equal(cf.atual.plano, 'Essencial · Trimestral');
    assert.equal(cf.atual.origem, 'Benefício por créditos');
    assert.equal(cf.atual.creditosGastos, 9);
    assert.match(cf.texto, /créditos utilizados não serão devolvidos/);
    assert.equal(cf.botaoManter, 'Manter plano atual');
    assert.equal(cf.botao, 'Continuar com a troca');
    const { rows } = await pool.query(`SELECT status FROM planos_administrativos WHERE anunciante_id = $1`, [c.id]);
    assert.deepEqual(
      rows.map((x) => x.status),
      ['ativo'],
      'o aviso não encerra nada',
    );
  } finally {
    await app.fechar();
  }
});

test('onboarding: exibição confirmada fecha o fluxo; pontos opcionais nunca seguram o próximo passo', () => {
  const base = { temPlano: true, beneficio: false, criativosAprovados: 1, pontosEscolhidos: 0 };
  const semExib = etapasDosPrimeirosPassos({ ...base, criativosEnviados: 1, exibicoes: 0 });
  assert.equal(semExib.proxima, 'exibicoes');
  assert.equal(semExib.numeroDaProxima, 4);
  assert.equal(semExib.concluido, false);
  const pronto = etapasDosPrimeirosPassos({ ...base, criativosEnviados: 1, exibicoes: 12 });
  assert.equal(pronto.concluido, true);
  assert.equal(pronto.proxima, null);
  const emAnalise = etapasDosPrimeirosPassos({ ...base, criativosEnviados: 1, criativosAprovados: 0, exibicoes: 0 });
  assert.equal(emAnalise.etapas[1].detalhe, 'Em análise pela Mostraí');
});
