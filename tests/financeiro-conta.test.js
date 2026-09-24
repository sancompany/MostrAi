require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');

// Financeiro da conta (Fatia 4 do painel único): cada bloco só aparece com
// assunto, a troca só é oferecida enquanto algum ponto recebe em dinheiro, e a
// anotação interna do lançamento nunca sai do servidor.

async function subirApp() {
  const app = express();
  app.use(session({ secret: 'teste-financeiro', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/conta/financeiro'));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ler: async (conta) => {
      const r = await fetch(`${base}/anunciantes/me/financeiro`, { headers: { 'x-conta': String(conta) } });
      return { status: r.status, texto: await r.text() };
    },
    fechar: () => new Promise((r) => server.close(r)),
  };
}

async function criarConta(extra = '') {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante']) RETURNING id`,
    [
      `FC ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `fc-${randomUUID()}@example.com`,
    ],
  );
  if (extra) await pool.query(`UPDATE anunciantes SET ${extra} WHERE id = $1`, [rows[0].id]);
  return rows[0].id;
}

async function limpar(contaId) {
  await pool.query('DELETE FROM pagamentos_ponto WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = $1)', [
    contaId,
  ]);
  await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [contaId]);
  await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [contaId]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
}

test('conta sem plano e sem ponto: nenhum bloco', async () => {
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const { status, texto } = await app.ler(conta);
    assert.equal(status, 200);
    const d = JSON.parse(texto);
    assert.equal(d.pagamentos.mostrar, false);
    assert.equal(d.recebimentos, undefined, 'não existe mais bloco de recebimentos');
    assert.equal(d.pagamentos.plano.situacao, 'sem_plano');
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

// Recebimentos saíram (24/09/2026, ADR-016): ser ponto não recebe dinheiro.
// Um repasse ANTIGO já pago continua no banco (histórico), mas não aparece
// mais no Financeiro do cliente — nem como recebimento, nem como troca.
test('anuncia e tem ponto com repasse antigo: só pagamentos; nada de recebimento nem troca', async () => {
  const conta = await criarConta(
    "plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '10 days'",
  );
  const app = await subirApp();
  try {
    await pool.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES ($1, 'essencial-1m', 149.90)`,
      [conta],
    );
    const {
      rows: [ponto],
    } = await pool.query(
      `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                           anunciante_id, status, plano_ponto_id, valor_pago_mensal)
       VALUES ('P', 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $1, 'em_operacao', 'ajuda-custo', 50) RETURNING id`,
      [conta],
    );
    await pool.query(
      `INSERT INTO pagamentos_ponto (ponto_id, competencia, valor, pago_em, observacao)
       VALUES ($1, '2026-08-01', 50, now(), 'NOTA INTERNA')`,
      [ponto.id],
    );
    const { texto } = await app.ler(conta);
    assert.ok(!/NOTA INTERNA|recebimentos|troca|ajuda/i.test(texto), 'nada do repasse antigo no Financeiro');
    const d = JSON.parse(texto);
    assert.equal(d.pagamentos.mostrar, true);
    assert.equal(d.pagamentos.plano.situacao, 'ativa');
    assert.deepEqual(
      d.pagamentos.cobrancas.map((c) => c.valor),
      [149.9],
    );
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pagamentos_ponto WHERE ponto_id = $1', [
      ponto.id,
    ]);
    assert.equal(rows[0].n, 1, 'o repasse histórico continua no banco');
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test.after(() => pool.end());
