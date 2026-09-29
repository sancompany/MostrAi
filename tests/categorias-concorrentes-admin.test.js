const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');

// Admin → Categorias → "Concorrentes diretos" (migration 105). Roda o `app`
// REAL (src/server.js): a guarda do /admin e o login de verdade. Só usa
// categorias temporárias — a matriz aprovada (seed) nunca é mexida aqui.
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-concorrentes-admin';
const app = require('../src/server');

// IP próprio por execução: o limitador de tentativas de login conta por IP.
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

let base;
let servidor;
let admin;
const criadas = [];

function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo) {
    const cookie = [...potes.entries()]
      .filter(([, c]) => caminho.startsWith(c.path))
      .map(([nome, c]) => `${nome}=${c.valor}`)
      .join('; ');
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...(cookie ? { cookie } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const path = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor: resto.join('='), path });
    }
    let json = null;
    try {
      json = await r.json();
    } catch {}
    return { status: r.status, json };
  };
}

test.before(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  admin = navegador();
  const r = await admin('POST', '/admin/login', { usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD });
  assert.strictEqual(r.status, 200, 'login do admin');
});

test.after(async () => {
  if (criadas.length) await pool.query('DELETE FROM categorias WHERE id = ANY($1::int[])', [criadas]);
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

async function nova(extra = {}) {
  const r = await admin('POST', '/admin/categorias', { nome: `Conc Admin ${randomUUID()}`, grupo: 'Teste', ...extra });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.push(r.json.id);
  return r.json;
}

async function concorrentesNaLista(id) {
  const r = await admin('GET', '/admin/categorias');
  assert.strictEqual(r.status, 200);
  return r.json.find((c) => c.id === id).concorrentes;
}

test('sem sessão de admin: leitura e escrita recusadas (401)', async () => {
  const anon = navegador();
  const a = await nova();
  assert.strictEqual((await anon('GET', '/admin/categorias')).status, 401);
  assert.strictEqual((await anon('PATCH', `/admin/categorias/${a.id}`, { concorrentes_remover: [] })).status, 401);
  assert.strictEqual((await anon('POST', '/admin/categorias', { nome: 'x', concorrentes_adicionar: [] })).status, 401);
});

test('pôr B em A aparece dos dois lados; tirar A de B some dos dois lados', async () => {
  const a = await nova();
  const b = await nova();
  const r = await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [b.id] });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json.concorrentes, [b.id]);
  assert.deepStrictEqual(await concorrentesNaLista(a.id), [b.id]);
  assert.deepStrictEqual(await concorrentesNaLista(b.id), [a.id], 'o outro lado enxerga sem ninguém gravar nele');

  const { rows } = await pool.query(
    'SELECT count(*)::int AS n FROM categorias_concorrentes WHERE categoria_a = ANY($1::int[]) OR categoria_b = ANY($1::int[])',
    [[a.id, b.id]],
  );
  assert.strictEqual(rows[0].n, 1, 'um par = uma linha');

  // Salvar B com A de novo (os dois lados "pedindo" o mesmo par) não duplica.
  assert.strictEqual(
    (await admin('PATCH', `/admin/categorias/${b.id}`, { concorrentes_adicionar: [a.id, a.id] })).status,
    200,
  );
  const { rows: depois } = await pool.query(
    'SELECT count(*)::int AS n FROM categorias_concorrentes WHERE categoria_a = ANY($1::int[]) OR categoria_b = ANY($1::int[])',
    [[a.id, b.id]],
  );
  assert.strictEqual(depois[0].n, 1);

  assert.strictEqual((await admin('PATCH', `/admin/categorias/${b.id}`, { concorrentes_remover: [a.id] })).status, 200);
  assert.deepStrictEqual(await concorrentesNaLista(a.id), []);
  assert.deepStrictEqual(await concorrentesNaLista(b.id), []);
});

test('salvar só os campos de sempre não mexe nos concorrentes', async () => {
  const a = await nova();
  const b = await nova();
  await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [b.id] });
  const r = await admin('PATCH', `/admin/categorias/${a.id}`, { grupo: 'Outro grupo', aliases: ['x'] });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json.concorrentes, [b.id]);
  assert.strictEqual(r.json.grupo, 'Outro grupo');
});

test('criar categoria já com concorrentes grava o par', async () => {
  const b = await nova();
  const a = await nova({ concorrentes_adicionar: [b.id] });
  assert.deepStrictEqual(a.concorrentes, [b.id]);
  assert.deepStrictEqual(await concorrentesNaLista(b.id), [a.id]);
});

test('validação: consigo mesma, id inválido, inexistente e legado recusam — e nada muda', async () => {
  const a = await nova();
  const b = await nova();
  const legada = await nova({ legado: true });
  await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [b.id] });

  for (const [corpo, motivo] of [
    [{ concorrentes_adicionar: [a.id] }, 'consigo mesma'],
    [{ concorrentes_adicionar: ['abc'] }, 'id inválido'],
    [{ concorrentes_adicionar: 'x' }, 'não é lista'],
    [{ concorrentes_adicionar: [2147480000] }, 'inexistente'],
    [{ concorrentes_adicionar: [legada.id] }, 'legado'],
  ]) {
    const r = await admin('PATCH', `/admin/categorias/${a.id}`, { nome: `Renomeada ${randomUUID()}`, ...corpo });
    assert.strictEqual(r.status, 400, motivo);
  }
  const { rows } = await pool.query('SELECT nome FROM categorias WHERE id = $1', [a.id]);
  assert.strictEqual(rows[0].nome, a.nome, 'transação: o nome não mudou quando os concorrentes falharam');
  assert.deepStrictEqual(await concorrentesNaLista(a.id), [b.id], 'o par anterior ficou intacto');
});

test('par antigo com categoria que virou legado continua até o admin tirar', async () => {
  const a = await nova();
  const b = await nova();
  await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [b.id] });
  await admin('PATCH', `/admin/categorias/${b.id}`, { legado: true });
  const r = await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [b.id] });
  assert.strictEqual(r.status, 200, 'manter um par existente não é "escolher" o legado de novo');
  assert.strictEqual((await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_remover: [b.id] })).status, 200);
  assert.deepStrictEqual(await concorrentesNaLista(a.id), []);
});

test('mesclar: os concorrentes da absorvida passam pra que fica, sem par consigo nem duplicado', async () => {
  const origem = await nova();
  const destino = await nova();
  const c = await nova();
  const d = await nova();
  await admin('PATCH', `/admin/categorias/${origem.id}`, { concorrentes_adicionar: [destino.id, c.id, d.id] });
  await admin('PATCH', `/admin/categorias/${destino.id}`, { concorrentes_adicionar: [origem.id, c.id] });

  const r = await admin('POST', `/admin/categorias/${origem.id}/mesclar`, { destino_id: destino.id });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(
    await concorrentesNaLista(destino.id),
    [c.id, d.id].sort((x, y) => x - y),
  );
  assert.deepStrictEqual(await concorrentesNaLista(origem.id), [], 'a legada fica sem par');
  assert.deepStrictEqual(await concorrentesNaLista(d.id), [destino.id]);
});

test('excluir categoria sem uso leva os pares junto', async () => {
  const a = await nova();
  const b = await nova();
  await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [b.id] });
  assert.strictEqual((await admin('DELETE', `/admin/categorias/${a.id}`)).status, 200);
  assert.deepStrictEqual(await concorrentesNaLista(b.id), []);
});

test('rota pública /categorias não expõe concorrentes', async () => {
  const r = await navegador()('GET', '/categorias');
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.every((c) => !('concorrentes' in c)));
  assert.ok(
    r.json.some((c) => c.nome === 'Terapia capilar'),
    'Terapia capilar está no cadastro',
  );
});

// ---------- achados da revisão independente (28/09/2026) ----------

test('revisão #2: id fora do int do Postgres é 400/404, não 500', async () => {
  const a = await nova();
  const r = await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [3000000000] });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.strictEqual((await admin('PATCH', '/admin/categorias/99999999999', { nome: 'x' })).status, 404);
});

test('revisão #6: só número inteiro vale como id ([[b]] e true recusam)', async () => {
  const a = await nova();
  const b = await nova();
  for (const lixo of [[[b.id]], [true], [`${b.id}.0`], [null]]) {
    const r = await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: lixo });
    assert.strictEqual(r.status, 400, JSON.stringify(lixo));
  }
  assert.deepStrictEqual(await concorrentesNaLista(a.id), []);
});

test('revisão #4: categoria legado não ganha par novo (nem criada já como legado)', async () => {
  const b = await nova();
  const legada = await nova({ legado: true });
  const r = await admin('PATCH', `/admin/categorias/${legada.id}`, { concorrentes_adicionar: [b.id] });
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  const nome = `Conc Admin ${randomUUID()}`;
  const c = await admin('POST', '/admin/categorias', { nome, legado: true, concorrentes_adicionar: [b.id] });
  assert.strictEqual(c.status, 400, JSON.stringify(c.json));
  const { rows } = await pool.query('SELECT 1 FROM categorias WHERE nome = $1', [nome]);
  assert.strictEqual(rows.length, 0, 'transação: a categoria não foi criada');
  assert.deepStrictEqual(await concorrentesNaLista(b.id), []);
});

test('revisão #5: modal velho salvando só o nome não apaga par criado por outra aba', async () => {
  const a = await nova();
  const b = await nova();
  // aba 2 cria o par A ↔ B; aba 1 (aberta antes, sem concorrentes) só renomeia B
  await admin('PATCH', `/admin/categorias/${a.id}`, { concorrentes_adicionar: [b.id] });
  const r = await admin('PATCH', `/admin/categorias/${b.id}`, {
    nome: `Renomeada ${randomUUID()}`,
    concorrentes_adicionar: [],
    concorrentes_remover: [],
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(await concorrentesNaLista(b.id), [a.id]);
});

test('revisão #3: par novo com a categoria que está sendo mesclada não fica preso na legada', async () => {
  const concorrencia = require('../src/categorias/concorrencia');
  const origem = await nova();
  const destino = await nova();
  const x = await nova();
  // Mesclagem em andamento (mesmos passos da rota, transação aberta)...
  const fusao = await pool.connect();
  const edicao = await pool.connect();
  try {
    await fusao.query('BEGIN');
    await fusao.query('SELECT id FROM categorias WHERE id = ANY($1::int[]) FOR UPDATE', [[origem.id, destino.id]]);
    await fusao.query('UPDATE categorias SET canonica_id = $2, legado = true, ativo = false WHERE id = $1', [
      origem.id,
      destino.id,
    ]);
    await concorrencia.moverNaFusao(fusao, origem.id, destino.id);
    // ...e, ao mesmo tempo, o admin põe a origem como concorrente de X.
    await edicao.query('BEGIN');
    const pendente = concorrencia.alterarConcorrentes(edicao, x.id, { adicionar: [origem.id] }).then(
      () => 'gravou',
      (err) => err,
    );
    await new Promise((r) => setTimeout(r, 150));
    await fusao.query('COMMIT');
    const resultado = await pendente;
    await edicao.query(resultado === 'gravou' ? 'COMMIT' : 'ROLLBACK');
    assert.ok(resultado instanceof concorrencia.ErroConcorrentes, `esperava recusa, veio ${resultado}`);
  } finally {
    fusao.release();
    edicao.release();
  }
  assert.deepStrictEqual(await concorrentesNaLista(origem.id), [], 'a legada não ganhou par');
});
