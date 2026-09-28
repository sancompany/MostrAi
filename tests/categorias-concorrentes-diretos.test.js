const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const dispositivosRepo = require('../src/dispositivos/repository');
const pontosRepo = require('../src/pontos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const concorrencia = require('../src/categorias/concorrencia');
const { coberturaDaConta } = require('../src/anunciantes/entrada-no-ar');
const { instalarPlayer } = require('./apoio-player');

// Concorrentes diretos entre categorias (migration 105). A proteção do dono
// da tela é CATEGORIA DO PONTO × CATEGORIA DO ANUNCIANTE:
//   mesma categoria → bloqueia · par registrado → bloqueia · resto → exibe.
// Grupo e aliases nunca bloqueiam; não há exclusividade entre anunciantes.
//
// Os pares da matriz aprovada (seed da 105) são lidos, nunca alterados aqui —
// outros arquivos rodam em paralelo no mesmo banco. O que precisa mexer em
// par (adicionar/tirar) usa categorias temporárias criadas pelo próprio teste.

async function idDaCategoria(nome) {
  const { rows } = await pool.query('SELECT id, grupo FROM categorias WHERE nome = $1', [nome]);
  if (!rows[0]) throw new Error(`categoria "${nome}" não existe no catálogo`);
  return rows[0].id;
}

async function grupoDe(nome) {
  const { rows } = await pool.query('SELECT grupo FROM categorias WHERE nome = $1', [nome]);
  return rows[0]?.grupo;
}

async function categoriaTemporaria(grupo = 'Teste concorrência') {
  const { rows } = await pool.query(
    "INSERT INTO categorias (nome, grupo, aliases) VALUES ($1, $2, '{}') RETURNING id",
    [`Cat Conc ${randomUUID()}`, grupo],
  );
  return rows[0].id;
}

async function telaNoPonto(categoriaId) {
  const ponto = await pontosRepo.criar({
    nome: `Ponto Conc ${randomUUID()}`,
    endereco: 'Rua Y, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'Teste',
    responsavel_nome: 'Fulano',
    responsavel_contato: '16999990000',
    categoria_id: categoriaId || null,
  });
  const criado = await dispositivosRepo.criar(ponto.id, { apelido: `Teste ${randomUUID()}` });
  await dispositivosRepo.atualizar(criado.id, { status: 'ativo' });
  await instalarPlayer(criado.id);
  return { ponto, dispositivo: await dispositivosRepo.buscarComPonto(criado.id) };
}

// Escolha explícita do ponto: com outros arquivos em paralelo a rede tem
// vários pontos, e a cobertura automática poderia cair noutro. A trava de
// categoria vale igual com escolha (só a DONA do ponto é isenta).
async function anunciante(categoriaId, pontoId, extra = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Anunciante Conc ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `conc-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
    categoria_id: categoriaId || null,
  });
  await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m', ...extra });
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: 'https://exemplo.test/normalizado.mp4',
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [conta.id, pontoId]);
  return (await pool.query('SELECT * FROM anunciantes WHERE id = $1', [conta.id])).rows[0];
}

async function limpar({ ponto, dispositivo }, contas = [], categorias = []) {
  const contaIds = contas.map((c) => c.id);
  await dispositivosRepo.deletar(dispositivo.id);
  await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = ANY($1::int[]) OR ponto_id = $2', [
    contaIds,
    ponto.id,
  ]);
  await pool.query('UPDATE pontos SET anunciante_id = NULL WHERE id = $1', [ponto.id]);
  await pool.query('DELETE FROM pontos WHERE id = $1', [ponto.id]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = ANY($1::int[])', [contaIds]);
  await pool.query('DELETE FROM anunciantes WHERE id = ANY($1::int[])', [contaIds]);
  if (categorias.length) await pool.query('DELETE FROM categorias WHERE id = ANY($1::int[])', [categorias]);
}

async function naPlaylist(dispositivo) {
  const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
  return new Set(envelope.itens.map((i) => i.anuncianteId).filter(Boolean));
}

// Ponto da categoria X, anunciante da categoria Y: o anúncio entra?
async function entra(nomePonto, nomeAnunciante) {
  const tela = await telaNoPonto(await idDaCategoria(nomePonto));
  const conta = await anunciante(await idDaCategoria(nomeAnunciante), tela.ponto.id);
  try {
    return (await naPlaylist(tela.dispositivo)).has(conta.id);
  } finally {
    await limpar(tela, [conta]);
  }
}

// ---------- casos pedidos pelo dono ----------

test('mesma categoria bloqueia', async () => {
  assert.strictEqual(await entra('Cafeteria', 'Cafeteria'), false);
});

test('mesmo grupo SEM relação cadastrada permite (grupo nunca bloqueia)', async () => {
  const g1 = await categoriaTemporaria('Grupo Conc Mesmo');
  const g2 = await categoriaTemporaria('Grupo Conc Mesmo');
  const tela = await telaNoPonto(g1);
  const conta = await anunciante(g2, tela.ponto.id);
  try {
    assert.ok((await naPlaylist(tela.dispositivo)).has(conta.id));
  } finally {
    await limpar(tela, [conta], [g1, g2]);
  }
});

test('Academia × CrossFit bloqueia — nos dois sentidos', async () => {
  assert.strictEqual(await entra('Academia', 'CrossFit / Treinamento funcional'), false);
  assert.strictEqual(await entra('CrossFit / Treinamento funcional', 'Academia'), false);
});

test('Academia × Pilates permite (mesmo grupo Fitness, sem par)', async () => {
  assert.strictEqual(await grupoDe('Academia'), await grupoDe('Estúdio de Pilates'));
  assert.strictEqual(await entra('Academia', 'Estúdio de Pilates'), true);
});

test('Barbearia × Salão de beleza permite', async () => {
  assert.strictEqual(await entra('Barbearia', 'Salão de beleza'), true);
  assert.strictEqual(await entra('Salão de beleza', 'Barbearia'), true);
});

test('Barbearia × Terapia capilar permite (Terapia capilar só concorre consigo)', async () => {
  assert.strictEqual(await entra('Barbearia', 'Terapia capilar'), true);
  assert.strictEqual(await entra('Terapia capilar', 'Barbearia'), true);
  assert.strictEqual(await entra('Terapia capilar', 'Terapia capilar'), false);
});

test('Cafeteria × Padaria bloqueia', async () => {
  assert.strictEqual(await entra('Cafeteria', 'Padaria'), false);
  assert.strictEqual(await entra('Padaria', 'Cafeteria'), false);
});

test('Pet shop × Clínica veterinária permite', async () => {
  assert.strictEqual(await entra('Pet shop', 'Clínica veterinária'), true);
});

test('Hotel / Pousada × Locação por temporada bloqueia (grupos diferentes, par explícito)', async () => {
  assert.notStrictEqual(await grupoDe('Hotel / Pousada'), await grupoDe('Locação por temporada'));
  assert.strictEqual(await entra('Hotel / Pousada', 'Locação por temporada'), false);
  assert.strictEqual(await entra('Locação por temporada', 'Hotel / Pousada'), false);
});

test('Design × Marketing / Publicidade bloqueia', async () => {
  assert.strictEqual(await entra('Design', 'Marketing / Publicidade'), false);
  assert.strictEqual(await entra('Marketing / Publicidade', 'Design'), false);
});

test('ponto Cafeteria: anunciantes Academia e CrossFit entram os dois (sem exclusividade entre anunciantes)', async () => {
  const tela = await telaNoPonto(await idDaCategoria('Cafeteria'));
  const academia = await anunciante(await idDaCategoria('Academia'), tela.ponto.id);
  const crossfit = await anunciante(await idDaCategoria('CrossFit / Treinamento funcional'), tela.ponto.id);
  const padaria = await anunciante(await idDaCategoria('Padaria'), tela.ponto.id);
  try {
    const ids = await naPlaylist(tela.dispositivo);
    assert.ok(ids.has(academia.id), 'Academia é elegível na cafeteria');
    assert.ok(ids.has(crossfit.id), 'CrossFit é elegível na cafeteria, mesmo concorrendo com a Academia');
    assert.ok(!ids.has(padaria.id), 'Padaria concorre com Cafeteria — fica fora');
  } finally {
    await limpar(tela, [academia, crossfit, padaria]);
  }
});

// ---------- regras de contorno ----------

test('alias nunca define concorrência: nome de categoria igual a alias não bloqueia', async () => {
  // Salão de beleza tem alias "cabeleireiro"; uma categoria chamada assim não
  // é o mesmo id, nem par — exibe.
  const g = await categoriaTemporaria();
  await pool.query("UPDATE categorias SET aliases = ARRAY['salao de beleza', 'barbearia'] WHERE id = $1", [g]);
  const tela = await telaNoPonto(await idDaCategoria('Barbearia'));
  const conta = await anunciante(g, tela.ponto.id);
  try {
    assert.ok((await naPlaylist(tela.dispositivo)).has(conta.id));
  } finally {
    await limpar(tela, [conta], [g]);
  }
});

test('par registrado depois bloqueia; tirar o par devolve o anúncio na geração seguinte', async () => {
  const cPonto = await categoriaTemporaria();
  const cAnunciante = await categoriaTemporaria();
  const cNeutra = await categoriaTemporaria();
  const tela = await telaNoPonto(cPonto);
  const conta = await anunciante(cAnunciante, tela.ponto.id);
  const neutra = await anunciante(cNeutra, tela.ponto.id);
  try {
    let ids = await naPlaylist(tela.dispositivo);
    assert.ok(ids.has(conta.id) && ids.has(neutra.id), 'sem par, os dois entram');

    const cliente = await pool.connect();
    try {
      await concorrencia.alterarConcorrentes(cliente, cAnunciante, { adicionar: [cPonto] });
    } finally {
      cliente.release();
    }
    ids = await naPlaylist(tela.dispositivo);
    assert.ok(!ids.has(conta.id), 'par cadastrado: sai já na próxima geração (a vaga congelada some)');
    assert.ok(ids.has(neutra.id), 'categoria sem par continua');

    const c2 = await pool.connect();
    try {
      await concorrencia.alterarConcorrentes(c2, cPonto, { remover: [cAnunciante] });
    } finally {
      c2.release();
    }
    ids = await naPlaylist(tela.dispositivo);
    assert.ok(ids.has(conta.id), 'par removido (pelo OUTRO lado): volta na próxima geração');
  } finally {
    await limpar(tela, [conta, neutra], [cPonto, cAnunciante, cNeutra]);
  }
});

test('dona do ponto que escolheu o próprio ponto não é barrada pelo par (a proteção é dela)', async () => {
  const cPonto = await categoriaTemporaria();
  const cDona = await categoriaTemporaria();
  await pool.query('INSERT INTO categorias_concorrentes (categoria_a, categoria_b) VALUES ($1, $2)', [
    Math.min(cPonto, cDona),
    Math.max(cPonto, cDona),
  ]);
  const tela = await telaNoPonto(cPonto);
  const dona = await anunciante(cDona, tela.ponto.id);
  await pool.query('UPDATE pontos SET anunciante_id = $2 WHERE id = $1', [tela.ponto.id, dona.id]);
  const dispositivo = await dispositivosRepo.buscarComPonto(tela.dispositivo.id);
  try {
    assert.ok((await naPlaylist(dispositivo)).has(dona.id));
  } finally {
    await limpar(tela, [dona], [cPonto, cDona]);
  }
});

test('coberturaDaConta (entrada no ar) segue a mesma regra do gerador', async () => {
  const tela = await telaNoPonto(await idDaCategoria('Cafeteria'));
  const padaria = await anunciante(await idDaCategoria('Padaria'), tela.ponto.id);
  const academia = await anunciante(await idDaCategoria('Academia'), tela.ponto.id);
  const plano = { pontos_incluidos: 1 };
  try {
    const { rows } = await pool.query('SELECT status FROM pontos WHERE id = $1', [tela.ponto.id]);
    assert.strictEqual(rows[0].status, 'em_operacao');
    assert.ok(!(await coberturaDaConta(padaria, plano)).some((p) => p.id === tela.ponto.id));
    assert.ok((await coberturaDaConta(academia, plano)).some((p) => p.id === tela.ponto.id));
  } finally {
    await limpar(tela, [padaria, academia]);
  }
});

test('bloqueia(): mesma categoria, par e sem categoria', () => {
  const pares = new Set([7]);
  assert.strictEqual(concorrencia.bloqueia(5, 5, new Set()), true);
  assert.strictEqual(concorrencia.bloqueia(7, 5, pares), true);
  assert.strictEqual(concorrencia.bloqueia(8, 5, pares), false);
  assert.strictEqual(concorrencia.bloqueia(null, 5, pares), false);
  assert.strictEqual(concorrencia.bloqueia(7, null, pares), false);
  assert.deepStrictEqual(concorrencia.parNormalizado(9, 3), [3, 9]);
  assert.strictEqual(concorrencia.parNormalizado(3, 3), null);
});

// ---------- seed da migration 105 ----------

test('seed: 48 pares da matriz aprovada, Terapia capilar criada sem par', async () => {
  const nome = async (id) => (await pool.query('SELECT nome FROM categorias WHERE id = $1', [id])).rows[0].nome;
  const { rows } = await pool.query(
    `SELECT a.nome AS a, b.nome AS b FROM categorias_concorrentes cc
       JOIN categorias a ON a.id = cc.categoria_a JOIN categorias b ON b.id = cc.categoria_b`,
  );
  const tem = (x, y) => rows.some((r) => (r.a === x && r.b === y) || (r.a === y && r.b === x));
  // A matriz INTEIRA, lida da própria migration: nenhum par pode ter virado
  // no-op por nome errado (o seed é por nome e ignora nome que não existe).
  const sql = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../src/db/migrations/105_concorrentes_diretos_entre_categorias.sql'),
    'utf8',
  );
  const matriz = [
    ...sql.slice(sql.indexOf('FROM (VALUES'), sql.indexOf(') AS par')).matchAll(/\('([^']+)', '([^']+)'\)/g),
  ];
  assert.strictEqual(matriz.length, 48, 'a matriz aprovada tem 48 pares');
  for (const [, x, y] of matriz) assert.ok(tem(x, y), `seed: ${x} ↔ ${y}`);
  for (const [x, y] of [
    ['Academia', 'Personal trainer'],
    ['Açaí', 'Sorveteria'],
    ['Restaurante', 'Marmitaria'],
    ['Esfiharia', 'Pastelaria'],
    ['Agropecuária', 'Insumos agrícolas'],
    ['Oficina mecânica', 'Pneus / Alinhamento'],
    ['Banco / Cooperativa de crédito', 'Crédito / Empréstimos'],
    ['Fisioterapia', 'Quiropraxia'],
    ['Spa', 'Massoterapia'],
    ['Loja de roupas', 'Brechó'],
    ['Esquadrias', 'Vidraçaria'],
    ['Loja de celulares', 'Eletrônicos'],
    ['Logística / Transportadora', 'Mudanças / Fretes'],
    ['Loja de suplementos', 'Produtos naturais'],
  ]) {
    assert.ok(tem(x, y), `${x} ↔ ${y}`);
  }
  for (const [x, y] of [
    ['Barbearia', 'Salão de beleza'],
    ['Academia', 'Estúdio de Pilates'],
    ['Pet shop', 'Clínica veterinária'],
    ['Pizzaria', 'Pastelaria'],
    ['Moda feminina', 'Moda masculina'],
  ]) {
    assert.ok(!tem(x, y), `${x} × ${y} não é par`);
  }
  const { rows: terapia } = await pool.query(
    "SELECT id, grupo, aliases, ativo, legado FROM categorias WHERE nome = 'Terapia capilar'",
  );
  assert.strictEqual(terapia.length, 1);
  assert.strictEqual(terapia[0].grupo, 'Beleza e estética');
  assert.ok(terapia[0].ativo && !terapia[0].legado);
  assert.deepStrictEqual([...terapia[0].aliases].sort(), [
    'terapeuta capilar',
    'terapia capilar',
    'tratamento capilar',
    'tricologia',
    'tricologista',
  ]);
  assert.strictEqual((await concorrencia.concorrentesDe(terapia[0].id)).size, 0);
  // Tabela nunca guarda um par "virado" nem categoria consigo mesma.
  const { rows: tortos } = await pool.query('SELECT 1 FROM categorias_concorrentes WHERE categoria_a >= categoria_b');
  assert.strictEqual(tortos.length, 0);
  assert.ok(await nome(terapia[0].id));
});

test('tabela recusa par invertido, consigo mesma e repetido', async () => {
  const a = await categoriaTemporaria();
  const b = await categoriaTemporaria();
  const [x, y] = [Math.min(a, b), Math.max(a, b)];
  try {
    await assert.rejects(
      pool.query('INSERT INTO categorias_concorrentes VALUES ($1, $2)', [y, x]),
      /check/i,
      'invertido',
    );
    await assert.rejects(pool.query('INSERT INTO categorias_concorrentes VALUES ($1, $1)', [x]), /check/i);
    await pool.query('INSERT INTO categorias_concorrentes VALUES ($1, $2)', [x, y]);
    await assert.rejects(pool.query('INSERT INTO categorias_concorrentes VALUES ($1, $2)', [x, y]), /duplicate/i);
  } finally {
    await pool.query('DELETE FROM categorias WHERE id = ANY($1::int[])', [[a, b]]);
  }
  const { rows } = await pool.query('SELECT 1 FROM categorias_concorrentes WHERE categoria_a = $1', [x]);
  assert.strictEqual(rows.length, 0, 'apagar a categoria leva o par junto (CASCADE)');
});

test.after(() => pool.end());
