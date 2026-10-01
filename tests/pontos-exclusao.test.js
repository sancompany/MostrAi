require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pool = require('../src/db/pool');

// Exclusão de ponto no admin (DELETE /admin/pontos/:id) — mesma regra da
// tela (DELETE /admin/dispositivos/:id): sem histórico sai de verdade, junto
// com as telas; com histórico (exibição confirmada, crédito, repasse, Plano
// Básico já dado, mesclagem) recusa com 409 e a saída é inativar as telas.

const criadas = { contas: [], pontos: [] };
test.after(async () => {
  for (const id of criadas.pontos) {
    await pool.query(
      'DELETE FROM exibicoes_contador WHERE dispositivo_id IN (SELECT id FROM dispositivos WHERE ponto_id = $1)',
      [id],
    );
    await pool.query('DELETE FROM creditos_ledger WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('UPDATE pontos SET mesclado_em_ponto_id = NULL WHERE mesclado_em_ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  for (const id of criadas.contas) await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  await pool.end();
});

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, proximo) => {
    req.session = { adminUsuario: 'teste' };
    proximo();
  });
  app.use(require('../src/pontos/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const excluir = async (id) => {
    const r = await fetch(`${base}/admin/pontos/${id}`, { method: 'DELETE' });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { excluir, fechar: () => new Promise((r) => server.close(r)) };
}

async function conta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em)
     VALUES ('Conta Exclusão Ponto', '11144477735', $1, '16999990000', 'x', now()) RETURNING id`,
    [`exclusao-ponto-${randomUUID()}@example.com`],
  );
  criadas.contas.push(rows[0].id);
  return rows[0].id;
}

async function ponto(donoId = null, status = 'em_operacao') {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status,
                         arquivado_em, motivo_arquivamento)
     VALUES ($1, 'Rua Teste, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '16 9', $2, $3,
             CASE WHEN $3 = 'arquivado' THEN now() END, CASE WHEN $3 = 'arquivado' THEN 'teste' END) RETURNING id`,
    [`Ponto Exclusão ${randomUUID()}`, donoId, status],
  );
  criadas.pontos.push(rows[0].id);
  return rows[0].id;
}

async function tela(pontoId) {
  const { rows } = await pool.query(
    `INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela', 'ativo') RETURNING id`,
    [pontoId],
  );
  return rows[0].id;
}

const existe = async (tabela, coluna, id) =>
  (await pool.query(`SELECT 1 FROM ${tabela} WHERE ${coluna} = $1`, [id])).rowCount > 0;

test('ponto sem histórico sai de verdade, com as telas e as escolhas dos clientes', async () => {
  const app = await subirApp();
  try {
    const dono = await conta();
    const cliente = await conta();
    const p = await ponto(dono);
    const t = await tela(p);
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [cliente, p]);
    // Exibição só programada (nunca confirmada) não é histórico — igual à tela.
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas)
       VALUES ($1, $2, date_trunc('hour', now()), 3, 0)`,
      [cliente, t],
    );

    const r = await app.excluir(p);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    assert.strictEqual(await existe('pontos', 'id', p), false);
    assert.strictEqual(await existe('dispositivos', 'id', t), false);
    assert.strictEqual(await existe('anunciantes_pontos', 'ponto_id', p), false);
    assert.strictEqual(await existe('exibicoes_contador', 'dispositivo_id', t), false);
    assert.strictEqual(await existe('anunciantes', 'id', dono), true, 'a conta do dono continua');

    assert.strictEqual((await app.excluir(p)).status, 404, 'segunda exclusão: já não existe');
  } finally {
    await app.fechar();
  }
});

test('ponto que nunca teve tela também se exclui', async () => {
  const app = await subirApp();
  try {
    const p = await ponto(null, 'a_instalar');
    assert.strictEqual((await app.excluir(p)).status, 200);
    assert.strictEqual(await existe('pontos', 'id', p), false);
  } finally {
    await app.fechar();
  }
});

test('id que não existe ou inválido é 404', async () => {
  const app = await subirApp();
  try {
    assert.strictEqual((await app.excluir(2147483000)).status, 404);
    assert.strictEqual((await app.excluir('abc')).status, 404);
  } finally {
    await app.fechar();
  }
});

// Cada caso de histórico: 409 com o motivo, e nada sai (nem ponto, nem tela).
const casos = [
  {
    nome: 'exibição confirmada numa tela do ponto',
    motivo: /histórico de exibições/,
    preparar: async ({ cliente, t }) =>
      pool.query(
        `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas)
         VALUES ($1, $2, date_trunc('hour', now()) - interval '1 hour', 3, 2)`,
        [cliente, t],
      ),
  },
  {
    nome: 'crédito gerado pelo ponto',
    motivo: /créditos/,
    preparar: async ({ dono, p }) =>
      pool.query(
        `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, ponto_id, competencia)
         VALUES ($1, 'credito_mensal_ponto', 1, $2, '2026-09-01')`,
        [dono, p],
      ),
  },
  {
    nome: 'repasse registrado',
    motivo: /repasses/,
    preparar: async ({ p }) =>
      pool.query(
        `INSERT INTO pagamentos_ponto (ponto_id, competencia, valor, pago_em) VALUES ($1, '2026-09-01', 50, now())`,
        [p],
      ),
  },
  {
    nome: 'Plano Básico já dado ao dono',
    motivo: /Plano Básico/,
    preparar: async ({ dono, p }) =>
      pool.query(
        `INSERT INTO beneficios_basico_ponto (ponto_id, conta_id, segundos_por_hora, horas_por_mes,
                                              duracao_maxima_segundos, limite_criativos)
         VALUES ($1, $2, 140, 14, 15, 1)`,
        [p, dono],
      ),
  },
  {
    nome: 'outro ponto mesclado nele',
    motivo: /mesclado/,
    preparar: async ({ p }) => {
      const outro = await ponto(null, 'arquivado');
      await pool.query('UPDATE pontos SET mesclado_em_ponto_id = $1 WHERE id = $2', [p, outro]);
    },
  },
];

for (const caso of casos) {
  test(`recusa com 409 — ${caso.nome}`, async () => {
    const app = await subirApp();
    try {
      const dono = await conta();
      const cliente = await conta();
      const p = await ponto(dono);
      const t = await tela(p);
      await caso.preparar({ dono, cliente, p, t });

      const r = await app.excluir(p);
      assert.strictEqual(r.status, 409, JSON.stringify(r.corpo));
      assert.match(r.corpo.erro, caso.motivo);
      assert.strictEqual(await existe('pontos', 'id', p), true, 'o ponto fica');
      assert.strictEqual(await existe('dispositivos', 'id', t), true, 'a tela fica');
    } finally {
      await pool.query('DELETE FROM pagamentos_ponto WHERE ponto_id IN (SELECT unnest($1::int[]))', [criadas.pontos]);
      await pool.query('DELETE FROM beneficios_basico_ponto WHERE ponto_id IN (SELECT unnest($1::int[]))', [
        criadas.pontos,
      ]);
      await app.fechar();
    }
  });
}

test('ponto arquivado (histórico de mesclagem) recusa com 409', async () => {
  const app = await subirApp();
  try {
    const p = await ponto(null, 'arquivado');
    const r = await app.excluir(p);
    assert.strictEqual(r.status, 409);
    assert.match(r.corpo.erro, /arquivado/);
    assert.strictEqual(await existe('pontos', 'id', p), true);
  } finally {
    await app.fechar();
  }
});
