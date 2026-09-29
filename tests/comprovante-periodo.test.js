require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const vigencia = require('../src/lib/vigencia');

// Comprovante de veiculação (CSV) com o período do gráfico (painel do
// usuário, 29/09/2026): `?desde=AAAA-MM-DD` cobre de 00:00 desse dia, em
// Matão, até agora — o mesmo recorte que a tela soma. Com `?dias=N` a janela
// era "agora menos N×24 h" e pegava um pedaço do dia anterior.

const criados = { contas: [], pontos: [] };
test.after(async () => {
  for (const id of criados.contas) {
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  for (const id of criados.pontos) {
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  await pool.end();
});

async function subirApp() {
  const app = express();
  app.use(session({ secret: 'teste-comprovante', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const baixar = async (conta, busca) => {
    const r = await fetch(`${base}/anunciantes/${conta}/exibicoes.csv?${busca}`, {
      headers: { 'x-conta': String(conta) },
    });
    return {
      status: r.status,
      arquivo: r.headers.get('content-disposition'),
      texto: (await r.text()).replace(/^﻿/, ''),
    };
  };
  return { baixar, fechar: () => new Promise((r) => server.close(r)) };
}

// Hora cheia em Matão, `dias` atrás (0 = hoje), como timestamptz.
async function horaEmMatao(dias, hora) {
  const { rows } = await pool.query(
    `SELECT ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - ($1 || ' days')::interval + ($2 || ' hours')::interval)
             AT TIME ZONE 'America/Sao_Paulo') AS t`,
    [dias, hora],
  );
  return rows[0].t;
}

test('?desde= começa às 00:00 do dia em Matão; data inválida cai no ?dias= de sempre', async () => {
  const { rows: contas } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis, endereco, cidade, uf, cep)
     VALUES (now(), 'Comprovante', '11144477735', $1, '16999990000', 'x', '{anunciante}', 'Rua X, 1', 'Matão', 'SP', '15990000') RETURNING id`,
    [`comprovante-${randomUUID()}@example.com`],
  );
  const conta = contas[0].id;
  criados.contas.push(conta);
  const { rows: pontos } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato)
     VALUES ('Ponto do comprovante', 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'R', '16 9') RETURNING id`,
  );
  criados.pontos.push(pontos[0].id);
  const { rows: telas } = await pool.query(
    `INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela', 'ativo') RETURNING id`,
    [pontos[0].id],
  );
  // Ontem às 23 h e hoje à 0 h (Matão): um dia de diferença por uma hora.
  for (const [dias, hora, vezes] of [
    [1, 23, 7],
    [0, 0, 5],
  ]) {
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
       VALUES ($1, $2, $3, $4, $4, $4)`,
      [conta, telas[0].id, await horaEmMatao(dias, hora), vezes],
    );
  }
  const hoje = vigencia.hojeComercial();
  const [a, m, d] = hoje.split('-');
  const app = await subirApp();
  try {
    const soHoje = await app.baixar(conta, `desde=${hoje}`);
    assert.strictEqual(soHoje.status, 200);
    assert.match(soHoje.arquivo, new RegExp(`mostrai-exibicoes-desde-${hoje}\\.csv`));
    const linhas = soHoje.texto.trim().split('\r\n');
    assert.strictEqual(linhas.length, 3, 'cabeçalho, o dia de hoje e o total — a hora de ontem às 23 h fica de fora');
    assert.match(linhas[1], new RegExp(`^${d}/${m}/${a};Ponto do comprovante;Matão;Tela \\d+;5$`));
    assert.strictEqual(linhas[2], ';;;Total;5');
    const ontem = new Date(`${hoje}T00:00:00Z`);
    ontem.setUTCDate(ontem.getUTCDate() - 1);
    const comOntem = await app.baixar(conta, `desde=${ontem.toISOString().slice(0, 10)}`);
    assert.match(comOntem.texto, /;;;Total;12\r\n$/);
    for (const invalido of ['2026-02-31', 'ontem', '2019-12-31', '2999-01-01']) {
      const r = await app.baixar(conta, `desde=${invalido}&dias=30`);
      assert.match(r.arquivo, /mostrai-exibicoes-30dias\.csv/, `desde=${invalido} cai no dias`);
      assert.match(r.texto, /;;;Total;12\r\n$/);
    }
  } finally {
    await app.fechar();
  }
});
