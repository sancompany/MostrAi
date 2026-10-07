const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const credencial = require('../src/player/credencial');
const sinal = require('../src/player/sinal');
const { sincronizarStatusPonto } = require('../src/pontos/repository');
const { subirApp, novoPonto, novaTela, instalarPlayer, limparPontos } = require('./apoio-player');

// SV3 (07/10/2026, migration 117): invalidação de playlist GLOBAL. O gatilho
// da 083 gravava em TODA tela ativa a cada mudança — dois comandos
// concorrentes travavam as mesmas linhas de `dispositivos` em ordem diferente
// e o Postgres derrubava um (deadlock 40P01 → 500; CI do PR #121, revogar
// credencial × DELETE de telas). Agora cada transação relevante grava UMA
// linha no livro `playlist_mudancas`; a tela compara com a cobertura da
// última playlist que recebeu.

const contas = [];
let app;

test.before(async () => {
  app = await subirApp();
});

test.after(async () => {
  for (const id of contas) {
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await limparPontos();
  await app.fechar();
  await pool.end();
});

const versaoGlobal = async () =>
  Number((await pool.query('SELECT COALESCE(max(id), 0) AS v FROM playlist_mudancas')).rows[0].v);

// O livro avançou por causa DESTE comando: a linha nova tem de existir e ser
// posterior a `antes` (outros arquivos rodam em paralelo no mesmo banco, então
// "avançou" é o que dá pra afirmar — e é exatamente o que importa).
async function avanca(rotulo, fn) {
  const antes = await versaoGlobal();
  await fn();
  assert.ok((await versaoGlobal()) > antes, `${rotulo}: a versão global da playlist avança`);
}

async function novaConta() {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Invalidação ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: '52998224725',
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `invalidacao-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  contas.push(conta.id);
  return conta;
}

async function novoCriativo(contaId) {
  return criativosRepo.criar({
    anunciante_id: contaId,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/invalidacao-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: 15,
  });
}

test('SV3 1: mudar criativo invalida a playlist', async () => {
  const conta = await novaConta();
  await avanca('criativo novo', () => novoCriativo(conta.id));
  const { rows } = await pool.query('SELECT id FROM criativos WHERE anunciante_id = $1', [conta.id]);
  await avanca('criativo aprovado', () => criativosRepo.atualizar(rows[0].id, { status: 'aprovado' }));
});

test('SV3 2: mudar o que importa no ponto invalida', async () => {
  const pid = await novoPonto();
  await avanca('status do ponto', () => pool.query("UPDATE pontos SET status = 'em_operacao' WHERE id = $1", [pid]));
});

test('SV3 3: adicionar/remover vínculo anunciante-ponto invalida', async () => {
  const conta = await novaConta();
  const pid = await novoPonto();
  await avanca('vínculo novo', () =>
    pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [conta.id, pid]),
  );
  await avanca('vínculo removido', () =>
    pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1 AND ponto_id = $2', [conta.id, pid]),
  );
});

test('SV3 4: mudar o status de uma tela invalida', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  await avanca('tela em reparo', () =>
    pool.query("UPDATE dispositivos SET status = 'reparo' WHERE id = $1", [tela.id]),
  );
});

test('SV3 transação: várias mudanças na mesma transação gravam UMA linha', async () => {
  const conta = await novaConta();
  const cliente = await pool.connect();
  try {
    // REPEATABLE READ: só as linhas desta transação aparecem além do retrato.
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const antes = Number((await cliente.query('SELECT COALESCE(max(id), 0) AS v FROM playlist_mudancas')).rows[0].v);
    for (let i = 0; i < 5; i++) {
      await cliente.query(
        `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos)
         VALUES ($1, 'o.mp4', $2, 15)`,
        [conta.id, `https://exemplo.test/${randomUUID()}.mp4`],
      );
    }
    const { rows } = await cliente.query('SELECT count(*)::int AS n FROM playlist_mudancas WHERE id > $1', [antes]);
    assert.strictEqual(rows[0].n, 1, 'cinco criativos, uma marca');
    await cliente.query('ROLLBACK');
  } finally {
    cliente.release();
  }
});

test('SV3 7: uma mudança com várias telas ativas NÃO escreve em nenhuma linha de dispositivos', async () => {
  const pid = await novoPonto();
  const telas = [];
  for (let i = 0; i < 6; i++) telas.push(await novaTela(pid));
  const conta = await novaConta();
  const c = await novoCriativo(conta.id);
  // REPEATABLE READ: o xmin visto só muda se ESTA transação reescrever a
  // linha — escritas de outros arquivos de teste em paralelo não entram.
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    const versoes = async () =>
      (await cliente.query('SELECT id, xmin::text AS x FROM dispositivos WHERE ponto_id = $1 ORDER BY id', [pid])).rows;
    const antes = await versoes();
    const v0 = Number((await cliente.query('SELECT COALESCE(max(id), 0) AS v FROM playlist_mudancas')).rows[0].v);
    await cliente.query("UPDATE criativos SET status = 'aprovado' WHERE id = $1", [c.id]);
    const v1 = Number((await cliente.query('SELECT COALESCE(max(id), 0) AS v FROM playlist_mudancas')).rows[0].v);
    assert.ok(v1 > v0, 'a versão global avançou');
    assert.deepStrictEqual(await versoes(), antes, 'nenhuma tela foi reescrita (xmin igual)');
    await cliente.query('ROLLBACK');
  } finally {
    cliente.release();
  }
});

test('SV3 6: revogar credencial enquanto outra operação apaga e atualiza telas — sem deadlock, sem 500', async () => {
  // Um ponto com telas instaladas (o revogar mexe no status do ponto, que
  // dispara o gatilho) e outros pontos cujas telas são apagadas em paralelo
  // (cada DELETE de tela também dispara). Antes: 40P01 intermitente.
  const rodadas = 12;
  const erros = [];
  for (let r = 0; r < rodadas; r++) {
    const alvo = await novoPonto();
    const telaAlvo = await novaTela(alvo);
    await instalarPlayer(telaAlvo.id);
    await sincronizarStatusPonto(alvo);
    const outro = await novoPonto();
    for (let i = 0; i < 4; i++) await novaTela(outro);
    const terceiro = await novoPonto();
    const telaTerceiro = await novaTela(terceiro);
    const tentativas = [
      () => app.chamar('POST', `/admin/dispositivos/${telaAlvo.id}/credencial/revogar`),
      () => pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [outro]),
      () => pool.query("UPDATE dispositivos SET status = 'reparo' WHERE id = $1", [telaTerceiro.id]),
      () => pool.query("UPDATE pontos SET status = 'em_operacao' WHERE id = $1", [terceiro]),
    ];
    const resultados = await Promise.allSettled(tentativas.map((f) => f()));
    for (const res of resultados) {
      if (res.status === 'rejected') erros.push(`${res.reason?.code || ''} ${res.reason?.message}`);
      else if (res.value?.status && res.value.status !== 200) erros.push(`HTTP ${res.value.status}`);
    }
    // A revogação valeu (quem chama vê a tela sem credencial).
    const { rows } = await pool.query('SELECT chave_hash FROM dispositivos WHERE id = $1', [telaAlvo.id]);
    assert.strictEqual(rows[0].chave_hash, null);
  }
  assert.deepStrictEqual(erros, [], 'nenhuma operação caiu (deadlock 40P01 vira 500)');
  // Revogar direto também segue.
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  await instalarPlayer(tela.id);
  assert.strictEqual(await credencial.revogar(tela.id), true);
});

test('SV3 5: transação que segura uma tela e muda um ponto × DELETE de telas de outro ponto — sem 40P01', async () => {
  // A ordem exata do deadlock do CI: T1 já segura uma linha de dispositivos e
  // dispara o gatilho; T2 apagou outras telas e o gatilho dela varre a rede.
  // Com o gatilho da 083 isto é 40P01 sempre (prova no PR); com o da 117
  // nenhum dos dois espera o outro.
  const a = await novoPonto();
  const telaA = await novaTela(a);
  const b = await novoPonto();
  for (let i = 0; i < 4; i++) await novaTela(b);
  const t1 = await pool.connect();
  const t2 = await pool.connect();
  try {
    await t1.query('BEGIN');
    await t2.query('BEGIN');
    await t1.query("UPDATE dispositivos SET apelido = 'segurada' WHERE id = $1", [telaA.id]);
    const apagar = t2.query('DELETE FROM dispositivos WHERE ponto_id = $1', [b]).then(
      () => 'ok',
      (e) => e.code,
    );
    await new Promise((r) => setTimeout(r, 300));
    const mudar = t1.query("UPDATE pontos SET status = 'em_operacao' WHERE id = $1", [a]).then(
      () => 'ok',
      (e) => e.code,
    );
    assert.deepStrictEqual(await Promise.all([mudar, apagar]), ['ok', 'ok']);
  } finally {
    await t1.query('ROLLBACK').catch(() => {});
    await t2.query('ROLLBACK').catch(() => {});
    t1.release();
    t2.release();
  }
});

test('SV3 8: sem mudança não pede playlist de novo; mudança nova pede UMA vez', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  // REPEATABLE READ: o livro visto é o do início da transação — outros
  // arquivos de teste gravando mudanças em paralelo não entram no meio.
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    // Como depois de um GET /playlist que cobriu tudo até a última mudança.
    await cliente.query(
      `UPDATE dispositivos SET playlist_gerada_desde = (SELECT max(em) FROM playlist_mudancas),
              playlist_desatualizada_em = NULL, playlist_sinalizada_em = NULL WHERE id = $1`,
      [tela.id],
    );
    assert.strictEqual(await sinal.sinalizarPlaylist(tela.id, cliente), false, 'nada mudou: não regenera');
    await cliente.query("UPDATE pontos SET status = 'em_operacao' WHERE id = $1", [pid]);
    assert.strictEqual(await sinal.sinalizarPlaylist(tela.id, cliente), true, 'mudou: pede a playlist');
    assert.strictEqual(await sinal.sinalizarPlaylist(tela.id, cliente), false, 'uma vez por mudança');
    await cliente.query('ROLLBACK');
  } finally {
    cliente.release();
  }
});

test('SV3: GET /playlist registra até onde a tela está coberta e limpa a marca direcionada', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  await pool.query(
    "UPDATE dispositivos SET playlist_desatualizada_em = clock_timestamp() - interval '1 minute' WHERE id = $1",
    [tela.id],
  );
  const r = await app.chamar('GET', `/playlist/${p.dispositivoId}`, { chave: p.chaveAparelho });
  assert.strictEqual(r.status, 200);
  const { rows } = await pool.query(
    'SELECT playlist_gerada_desde, playlist_desatualizada_em, playlist_entregue_em FROM dispositivos WHERE id = $1',
    [tela.id],
  );
  assert.ok(rows[0].playlist_gerada_desde, 'cobertura gravada');
  assert.ok(rows[0].playlist_entregue_em);
  assert.strictEqual(rows[0].playlist_desatualizada_em, null, 'marca antiga resolvida');
});
