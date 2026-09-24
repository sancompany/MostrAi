require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pool = require('../src/db/pool');

// Contraparte do Player V2 (docs/player-v2-contract.md de
// sancompany/Playlist.MostrAi, main 28bc93d) exercitada pelas rotas reais:
// provisionamento, autenticação, hello, heartbeat, config, playlist,
// proof-of-play e OTA — V1 e V2 lado a lado.

process.env.SESSION_SECRET ||= 'teste-player-v2';

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(require('../src/player/routes'));
  app.use(require('../src/playlist/routes'));
  app.use(require('../src/dispositivos/routes'));
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'JSON inválido' });
    res.status(500).json({ erro: 'erro interno' });
  });
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  // `legado`: só `X-Aparelho-Id`, como o player web e o Android V1 mandam.
  const chamar = async (metodo, caminho, { corpo, chave, v2 = true, cru, legado = false } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (v2) Object.assign(headers, { 'X-Player-Version': '1.0.0+2', 'X-Player-Contract': '2' });
    if (chave !== undefined && legado) headers['X-Aparelho-Id'] = chave;
    else if (chave !== undefined) Object.assign(headers, { 'X-Aparelho-Key': chave, 'X-Aparelho-Id': chave });
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: cru ?? (corpo === undefined ? undefined : JSON.stringify(corpo)),
    });
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { status: r.status, json, texto };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

const pontosCriados = [];
// compat V1 (só teste): chave gravada na tela, identificada pela PK — como
// as TVs V1 em campo têm. O admin não gera mais chave legada (410).
const chaveV1 = (telaId) => require('../src/player/credencial').gerarChaveLegada(telaId);

async function novoPonto(extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2) RETURNING id`,
    [`P2 ${randomUUID().slice(0, 8)}`, extra.horario ? JSON.stringify(extra.horario) : null],
  );
  pontosCriados.push(rows[0].id);
  return rows[0].id;
}

// Tela nova + arquivo de instalação + troca do token: o caminho do Player V2.
async function telaProvisionada(app, pontoId) {
  const pid = pontoId || (await novoPonto());
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const arq = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`)).json.arquivo;
  const cred = (
    await app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: arq.tokenProvisionamento } })
  ).json;
  return { tela, cred, token: arq.tokenProvisionamento, pontoId: pid };
}

const hb = (extra = {}) => ({
  versaoContrato: 2,
  estado: 'IDLE',
  configVersionAplicada: 0,
  fila: { pendentes: 0, maisAntigoEm: null },
  erro: null,
  ...extra,
});

let app;
test.before(async () => {
  app = await subirApp();
});

// ---------------------------------------------------------------------------
// Consolidação (24/09/2026): [Preparar Player], dispositivoId de 5 dígitos,
// olho do PIN auditado, exclusão bloqueada com exibição confirmada.
// ---------------------------------------------------------------------------
test('preparar-player: dispositivoId de 5 dígitos + chave, uma vez; Player autentica com a credencial direta', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const r = await app.chamar('POST', `/admin/dispositivos/${tela.id}/preparar-player`);
  assert.equal(r.status, 201);
  const { arquivo } = r.json;
  assert.match(arquivo.dispositivoId, /^[1-9]\d{4}$/);
  assert.ok(arquivo.chaveAparelho.length >= 40);
  assert.ok(/^https?:\/\//.test(arquivo.baseUrl));
  assert.equal(arquivo.rotacaoTela, 0);
  assert.equal(await statusDoPonto(pid), 'aguardando_primeiro_sinal');
  const { rows } = await pool.query('SELECT * FROM dispositivos WHERE id = $1', [tela.id]);
  assert.ok(!JSON.stringify(rows[0]).includes(arquivo.chaveAparelho), 'chave em claro no banco');
  assert.equal(rows[0].dispositivo_uid, arquivo.dispositivoId);
  // Ficha: dispositivoId aparece, chave não; baseUrl vem no bloco CONEXÃO.
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(ficha.identidade.dispositivoId, arquivo.dispositivoId);
  assert.equal(ficha.conexao.baseUrl, arquivo.baseUrl);
  assert.ok(!JSON.stringify(ficha).includes(arquivo.chaveAparelho));
  // O Player usa a credencial direta pelo dispositivoId; a PK não autentica.
  const hbOk = await app.chamar('POST', `/player/${arquivo.dispositivoId}/heartbeat`, {
    corpo: hb(),
    chave: arquivo.chaveAparelho,
  });
  assert.equal(hbOk.status, 200);
  assert.equal(await statusDoPonto(pid), 'em_operacao');
  const porPk = await app.chamar('POST', `/player/${tela.id}/heartbeat`, { corpo: hb(), chave: arquivo.chaveAparelho });
  assert.equal(porPk.status, 401, 'tela com dispositivoId não responde pela PK');
  assert.equal(await eventosDe(tela.id, 'PLAYER_PREPARED'), 1);
  // Preparar de novo troca a identidade: a anterior deixa de valer.
  const r2 = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/preparar-player`)).json.arquivo;
  assert.notEqual(r2.dispositivoId, arquivo.dispositivoId);
  assert.equal(
    (
      await app.chamar('POST', `/player/${arquivo.dispositivoId}/heartbeat`, {
        corpo: hb(),
        chave: arquivo.chaveAparelho,
      })
    ).status,
    401,
  );
  assert.equal(
    (await app.chamar('POST', `/player/${r2.dispositivoId}/heartbeat`, { corpo: hb(), chave: r2.chaveAparelho }))
      .status,
    200,
  );
  // Fluxo antigo de chave aposentado.
  assert.equal((await app.chamar('POST', `/admin/dispositivos/${tela.id}/chave-legada`)).status, 410);
});

test('PIN: olho devolve o PIN só pelo cofre e registra PIN_REVEALED; tela sem PIN → 404', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}/pin`)).status, 404);
  assert.equal(
    (await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: '4321' } })).status,
    200,
  );
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.ok(!JSON.stringify(ficha).includes('4321'), 'PIN em claro na ficha');
  const olho = await app.chamar('GET', `/admin/dispositivos/${tela.id}/pin`);
  assert.equal(olho.status, 200);
  assert.equal(olho.json.pin, '4321');
  assert.equal(await eventosDe(tela.id, 'PIN_REVEALED'), 1);
});

test('excluir tela: bloqueado (409) quando já há exibição confirmada; livre sem histórico', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const {
    rows: [conta],
  } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em)
     VALUES ('Excluir Tela', '00000000000191', $1, '16999990000', 'x', now()) RETURNING id`,
    [`excluir-tela-${randomUUID().slice(0, 8)}@teste.com`],
  );
  try {
    await pool.query(
      `INSERT INTO exibicoes_contador (janela_hora, dispositivo_id, anunciante_id, vezes_programadas, vezes_confirmadas)
       VALUES (date_trunc('hour', now()), $1, $2, 4, 3)`,
      [tela.id, conta.id],
    );
    const r = await app.chamar('DELETE', `/admin/dispositivos/${tela.id}`);
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /inative/);
    await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [tela.id]);
    assert.equal((await app.chamar('DELETE', `/admin/dispositivos/${tela.id}`)).status, 200);
  } finally {
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [conta.id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
  }
});

test('número da tela: menor número livre por ponto (excluir a 2 de [1,2,3] e criar → Tela 2)', async () => {
  const pid = await novoPonto();
  const criar = async () => (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const t1 = await criar();
  const t2 = await criar();
  const t3 = await criar();
  assert.deepEqual([t1.nome, t2.nome, t3.nome], ['Tela 1', 'Tela 2', 'Tela 3']);
  assert.equal((await app.chamar('DELETE', `/admin/dispositivos/${t2.id}`)).status, 200);
  const t4 = await criar();
  assert.equal(t4.nome, 'Tela 2', 'o número livre é reaproveitado');
  assert.notEqual(t4.id, t2.id, 'a PK é outra — identidade operacional não depende dela');
  const t5 = await criar();
  assert.equal(t5.nome, 'Tela 4');
});

test.after(async () => {
  await app.fechar();
  for (const id of pontosCriados) {
    await pool.query(
      'DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (SELECT id FROM dispositivos WHERE ponto_id = $1)',
      [id],
    );
    await pool.query(
      'DELETE FROM exibicoes_contador WHERE dispositivo_id IN (SELECT id FROM dispositivos WHERE ponto_id = $1)',
      [id],
    );
    await pool.query(
      'DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (SELECT id FROM dispositivos WHERE ponto_id = $1)',
      [id],
    );
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  await pool.query("DELETE FROM player_releases WHERE versao LIKE 'teste-%'");
  await pool.end();
});

// ---------------------------------------------------------------------------
// 59. Provisionamento
// ---------------------------------------------------------------------------
test('provisionamento: token válido vira dispositivoId + chave; nada disso fica em claro no banco', async () => {
  const { tela, cred, token } = await telaProvisionada(app);
  assert.match(cred.dispositivoId, /^[1-9]\d{4}$/, 'dispositivoId: 5 dígitos, 10000–99999');
  assert.ok(cred.chaveAparelho.length >= 40);
  const { rows } = await pool.query('SELECT * FROM dispositivos WHERE id = $1', [tela.id]);
  const linha = JSON.stringify(rows[0]);
  assert.ok(!linha.includes(cred.chaveAparelho), 'chave em claro no banco');
  const { rows: tk } = await pool.query('SELECT * FROM tokens_provisionamento WHERE dispositivo_id = $1', [tela.id]);
  assert.ok(!JSON.stringify(tk).includes(token), 'token em claro no banco');
  assert.ok(!JSON.stringify(tk).includes(cred.chaveAparelho), 'credencial em claro no banco');
});

test('provisionamento: inválido, expirado e consumido fora da janela → 401 (nunca 404, nunca fallback)', async () => {
  assert.equal(
    (await app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: 'tok_nao_existe' } })).status,
    401,
  );
  assert.equal((await app.chamar('POST', '/player/provisionar', { corpo: {} })).status, 400);

  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const arq = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`)).json.arquivo;
  await pool.query(
    `UPDATE tokens_provisionamento SET expira_em = now() - interval '1 minute' WHERE dispositivo_id = $1`,
    [tela.id],
  );
  assert.equal(
    (await app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: arq.tokenProvisionamento } }))
      .status,
    401,
  );

  const { tela: t2, token } = await telaProvisionada(app);
  await pool.query(
    `UPDATE tokens_provisionamento SET usado_em = now() - interval '11 minutes' WHERE dispositivo_id = $1`,
    [t2.id],
  );
  assert.equal(
    (await app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: token } })).status,
    401,
  );
});

test('provisionamento: repetir o mesmo token na janela devolve AS MESMAS credenciais; o 1º uso da chave fecha a janela', async () => {
  const { cred, token } = await telaProvisionada(app);
  const repetido = await app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: token } });
  assert.equal(repetido.status, 200);
  assert.deepEqual(repetido.json, cred);
  await app.chamar('POST', `/player/${cred.dispositivoId}/heartbeat`, { corpo: hb(), chave: cred.chaveAparelho });
  assert.equal(
    (await app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: token } })).status,
    401,
  );
});

test('provisionamento: duas trocas simultâneas do mesmo token geram UMA identidade', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const { tokenProvisionamento } = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`)).json
    .arquivo;
  const [a, b] = await Promise.all([
    app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento } }),
    app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento } }),
  ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.json, b.json);
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM tela_eventos WHERE dispositivo_id = $1 AND tipo = 'PLAYER_PROVISIONED'`,
    [tela.id],
  );
  assert.equal(rows[0].n, 1);
});

test('provisionamento: token novo invalida o anterior e NÃO derruba o Player que já roda', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const primeiro = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`)).json.arquivo;
  const segundo = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`)).json.arquivo;
  assert.notEqual(primeiro.tokenProvisionamento, segundo.tokenProvisionamento);
  assert.equal(
    (
      await app.chamar('POST', '/player/provisionar', {
        corpo: { tokenProvisionamento: primeiro.tokenProvisionamento },
      })
    ).status,
    401,
  );
  const vivo = await app.chamar('POST', `/player/${cred.dispositivoId}/heartbeat`, {
    corpo: hb(),
    chave: cred.chaveAparelho,
  });
  assert.equal(vivo.status, 200, 'gerar instalador não mexe na credencial atual');
  // Só a TROCA do token novo substitui a identidade.
  const novo = (
    await app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: segundo.tokenProvisionamento } })
  ).json;
  assert.notEqual(novo.dispositivoId, cred.dispositivoId);
  assert.equal(
    (await app.chamar('POST', `/player/${cred.dispositivoId}/heartbeat`, { corpo: hb(), chave: cred.chaveAparelho }))
      .status,
    401,
  );
});

// ---------------------------------------------------------------------------
// 60. Autenticação
// ---------------------------------------------------------------------------
test('auth: chave certa passa; errada, vazia, ausente, de outra tela e por query string → 401', async () => {
  const { cred } = await telaProvisionada(app);
  const { cred: outra } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).status, 200);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: `${cred.chaveAparelho}x` })).status, 401);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: '' })).status, 401);
  assert.equal((await app.chamar('POST', url, { corpo: hb() })).status, 401);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: outra.chaveAparelho })).status, 401);
  assert.equal(
    (await app.chamar('POST', `${url}?chave=${encodeURIComponent(cred.chaveAparelho)}`, { corpo: hb() })).status,
    401,
  );
  assert.equal(
    (await app.chamar('POST', '/player/tela_ffffffffffffffffffff/heartbeat', { corpo: hb(), chave: 'x' })).status,
    401,
  );
  assert.equal((await app.chamar('POST', '/player/nao-e-id/heartbeat', { corpo: hb(), chave: 'x' })).status, 401);
});

test('auth V1: player web pelo ID numérico com a chave legada; V2 no mesmo backend', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const chave = await chaveV1(tela.id);
  const pl = await app.chamar('GET', `/playlist/${tela.id}`, { chave, v2: false });
  assert.equal(pl.status, 200);
  assert.ok(Array.isArray(pl.json), 'V1 continua recebendo o array');
  const hbV1 = await app.chamar('POST', `/player/${tela.id}/heartbeat`, { cru: '', chave, v2: false });
  assert.equal(hbV1.status, 200);
  assert.ok(hbV1.json.margens);
  assert.ok(!('configVersion' in hbV1.json), 'V1 não recebe campos V2');
});

test('auth: revogar derruba todas as chaves; tela em reparo não recebe playlist mas continua dando sinal', async () => {
  const { tela, cred } = await telaProvisionada(app);
  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { status: 'reparo' } });
  assert.equal((await app.chamar('GET', `/playlist/${cred.dispositivoId}`, { chave: cred.chaveAparelho })).status, 403);
  assert.equal(
    (await app.chamar('POST', `/player/${cred.dispositivoId}/heartbeat`, { corpo: hb(), chave: cred.chaveAparelho }))
      .status,
    200,
  );
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/revogar`);
  assert.equal(
    (await app.chamar('POST', `/player/${cred.dispositivoId}/heartbeat`, { corpo: hb(), chave: cred.chaveAparelho }))
      .status,
    401,
  );
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(ficha.identidade.credencial.estado, 'revogada');
});

test('rotação: candidata vai no heartbeat, 1º uso promove, antiga vale 24 h e depois não', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  assert.equal((await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`)).status, 200);
  const r1 = await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho });
  const nova = r1.json.novaChave;
  assert.ok(nova && nova !== cred.chaveAparelho);
  // Reenvia até o Player usar (resposta pode ter se perdido).
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.novaChave, nova);
  const r2 = await app.chamar('POST', url, { corpo: hb(), chave: nova });
  assert.equal(r2.status, 200);
  assert.ok(!r2.json.novaChave, 'promovida: não manda mais');
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).status, 200, 'sobreposição');
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.ok(ficha.identidade.credencial.anterior);
  assert.ok(!JSON.stringify(ficha).includes(nova));
  await pool.query(`UPDATE dispositivos SET chave_anterior_expira_em = now() - interval '1 second' WHERE id = $1`, [
    tela.id,
  ]);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).status, 401);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: nova })).status, 200);
});

test('rotação: candidata recusada nunca apaga a atual (cancelar rotação volta ao normal)', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`);
  const nova = (await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.novaChave;
  await app.chamar('DELETE', `/admin/dispositivos/${tela.id}/credencial/rotacao`);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: nova })).status, 401);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).status, 200);
});

// ---------------------------------------------------------------------------
// 61/62. Hello e heartbeat
// ---------------------------------------------------------------------------
test('hello: primeiro sinal, metadados, reenvio atualiza; corpo que não é objeto → 400; tipo errado é ignorado', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/hello`;
  const corpo = {
    contrato: 2,
    versaoApp: '1.0.0',
    buildNumber: 2,
    fabricante: 'TCL',
    modelo: '32S6500S',
    android: '8.0.0',
    largura: 1920,
    altura: 1080,
    timezone: 'America/Sao_Paulo',
  };
  const r = await app.chamar('POST', url, { corpo, chave: cred.chaveAparelho });
  assert.equal(r.status, 200);
  assert.equal(r.json.configVersion, 1);
  let f = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(f.saude, 'operando');
  assert.equal(f.diagnostico.resolucao, '1920×1080');
  assert.equal(f.identidade.build, 2);
  await app.chamar('POST', url, {
    corpo: { ...corpo, versaoApp: '1.1.0', buildNumber: 3, largura: 'x' },
    chave: cred.chaveAparelho,
  });
  f = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(f.identidade.versao, '1.1.0');
  assert.equal(f.diagnostico.resolucao, null, 'largura com tipo errado não vira dado');
  assert.equal((await app.chamar('POST', url, { cru: '[1,2]', chave: cred.chaveAparelho })).status, 400);
  assert.equal((await app.chamar('POST', url, { cru: '{quebrado', chave: cred.chaveAparelho })).status, 400);
  const { rows } = await pool.query(
    `SELECT tipo FROM tela_eventos WHERE dispositivo_id = $1 AND tipo IN ('FIRST_SEEN','UPDATE_INSTALLED') ORDER BY id`,
    [tela.id],
  );
  assert.deepEqual(
    rows.map((x) => x.tipo),
    ['FIRST_SEEN', 'UPDATE_INSTALLED'],
  );
});

test('heartbeat V2: snapshot completo, erro null limpa, fila ausente fica desconhecida, sem linha por heartbeat', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  const r = await app.chamar('POST', url, {
    chave: cred.chaveAparelho,
    corpo: hb({
      estado: 'PLAYBACK_ERROR',
      configVersionAplicada: 1,
      criativoId: 'cri_456',
      ultimaPlaylistOkEm: '2026-09-23T10:02:11-03:00',
      fila: { pendentes: 412, maisAntigoEm: '2026-09-22T08:00:00-03:00' },
      erro: {
        codigo: 'PLAYBACK_FALHOU',
        ocorreuEm: '2026-09-23T03:14:00-03:00',
        mensagem: 'ERROR_CODE_DECODING_FAILED\n',
      },
      desvioRelogioMs: -4200,
      update: { estado: 'READY' },
    }),
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.configVersion, 1);
  assert.ok(r.json.servidorAgora && r.json.margens);
  let f = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(f.saude, 'erro_do_player');
  assert.equal(f.operacao.criativoAtual, 'cri_456');
  assert.equal(f.diagnostico.fila.pendentes, 412);
  assert.equal(f.diagnostico.erro.codigo, 'PLAYBACK_FALHOU');
  assert.ok(!f.diagnostico.erro.mensagem.includes('\n'), 'mensagem sanitizada');
  assert.equal(f.diagnostico.desvioRelogioMs, -4200);
  assert.equal(f.diagnostico.update.estado, 'READY');
  assert.equal(f.configuracao.situacao, 'atualizada');

  await app.chamar('POST', url, {
    chave: cred.chaveAparelho,
    corpo: { versaoContrato: 2, estado: 'NAO_EXISTE', configVersionAplicada: 1, erro: null },
  });
  f = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(f.diagnostico.erro, null, 'erro: null limpa');
  assert.equal(f.operacao.playerEstado, null, 'estado fora do contrato não é gravado');
  assert.equal(f.diagnostico.fila.pendentes, 412, 'fila ausente = não informado agora, mantém o último');
  assert.equal(f.saude, 'operando');
  const { rows } = await pool.query(`SELECT tipo FROM tela_eventos WHERE dispositivo_id = $1 ORDER BY id`, [tela.id]);
  const tipos = rows.map((x) => x.tipo);
  assert.ok(tipos.includes('ERROR_STARTED') && tipos.includes('ERROR_RESOLVED') && tipos.includes('CONFIG_APPLIED'));
  assert.ok(tipos.includes('UPDATE_READY'));
  assert.ok(tipos.length < 10, 'nada de uma linha por heartbeat');
  assert.equal((await app.chamar('POST', url, { cru: '"texto"', chave: cred.chaveAparelho })).status, 400);
});

test('heartbeat: silêncio longo vira OFFLINE + ONLINE no histórico quando volta', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho });
  await pool.query(`UPDATE dispositivos SET ultima_vez_online = now() - interval '2 hours' WHERE id = $1`, [tela.id]);
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json.saude, 'sem_sinal');
  await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho });
  const { rows } = await pool.query(
    `SELECT tipo FROM tela_eventos WHERE dispositivo_id = $1 AND tipo IN ('OFFLINE','ONLINE') ORDER BY ocorrido_em`,
    [tela.id],
  );
  assert.deepEqual(
    rows.map((x) => x.tipo),
    ['OFFLINE', 'ONLINE'],
  );
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json.saude, 'operando');
});

// ---------------------------------------------------------------------------
// 64. Config
// ---------------------------------------------------------------------------
test('config: desejada sobe só quando muda campo da config; GET /config entrega o combinado', async () => {
  const pid = await novoPonto({
    horario: {
      seg: { abre: '09:00', fecha: '18:00' },
      ter: null,
      qua: null,
      qui: null,
      sex: null,
      sab: null,
      dom: null,
    },
  });
  const { tela, cred } = await telaProvisionada(app, pid);
  const cfg = async () =>
    (await app.chamar('GET', `/player/${cred.dispositivoId}/config`, { chave: cred.chaveAparelho })).json;
  let c = await cfg();
  assert.equal(c.configVersion, 1);
  assert.equal(c.operacao.regime, 'FOLLOW_POINT');
  assert.deepEqual(c.operacao.porDiaDaSemana.seg, [{ inicio: '09:00', fim: '18:00' }]);
  assert.deepEqual(c.operacao.porDiaDaSemana.ter, [], 'fechado vai como lista vazia explícita');
  assert.ok(!('pinPainel' in c), 'sem PIN, o campo não vai (ausente = não mexa)');
  assert.ok(!('versaoMinimaBuild' in c) && !('cache' in c), 'nada inventado');

  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { custo_equipamento: 900 } });
  assert.equal((await cfg()).configVersion, 1, 'campo fora da config não sobe a versão');

  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, {
    corpo: { margem_superior: 2.5, rotacao_tela: 90, timezone: 'America/Manaus' },
  });
  c = await cfg();
  assert.equal(c.configVersion, 2);
  assert.equal(c.margens.superior, 2.5);
  assert.equal(c.rotacaoTela, 90);
  assert.equal(c.operacao.timezone, 'America/Manaus');

  await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: '4821' } });
  c = await cfg();
  assert.equal(c.configVersion, 3);
  assert.equal(c.pinPainel, '4821');
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.ok(!JSON.stringify(ficha).includes('4821'), 'PIN nunca volta pro admin');
  assert.equal(
    (await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: '12345' } })).status,
    400,
  );

  await pool.query(
    `UPDATE pontos SET horario_semanal = jsonb_set(horario_semanal, '{ter}', '{"abre":"10:00","fecha":"12:00"}') WHERE id = $1`,
    [pid],
  );
  c = await cfg();
  assert.equal(c.configVersion, 4, 'horário do ponto mudou: tela que segue o ponto recebe config nova');
  assert.deepEqual(c.operacao.porDiaDaSemana.ter, [{ inicio: '10:00', fim: '12:00' }]);

  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { modo_horario: '24h' } });
  c = await cfg();
  assert.deepEqual(c.operacao, { regime: 'HORAS_24', timezone: 'America/Manaus' });

  for (const ruim of [
    { margem_esquerda: 11 },
    { rotacao_tela: 45 },
    { timezone: 'Marte/Base' },
    { update_horas_entre_tentativas: 0 },
  ]) {
    assert.equal(
      (await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: ruim })).status,
      400,
      JSON.stringify(ruim),
    );
  }
});

// ---------------------------------------------------------------------------
// 65. Playlist: V2/V1, contentHash, desatualizada
// ---------------------------------------------------------------------------
test('playlist: V2 recebe envelope; mudança marca desatualizada, heartbeat avisa UMA vez, GET limpa', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  const pl = await app.chamar('GET', `/playlist/${cred.dispositivoId}`, { chave: cred.chaveAparelho });
  assert.equal(pl.json.versaoContrato, 2);
  // Primeiro sinal põe o ponto em operação — a cobertura muda, então é
  // mudança de playlist de verdade e o heartbeat avisa.
  assert.deepEqual((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.playlist, {
    atualizar: true,
  });
  const semMarca = () =>
    pool.query(
      'UPDATE dispositivos SET playlist_desatualizada_em = NULL, playlist_sinalizada_em = NULL WHERE id = $1',
      [tela.id],
    );
  await semMarca();
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.playlist, undefined);

  // Marca feita há 10 s (o GET só limpa o que é anterior à geração, com folga).
  await pool.query(`UPDATE dispositivos SET playlist_desatualizada_em = now() - interval '10 seconds' WHERE id = $1`, [
    tela.id,
  ]);
  assert.deepEqual((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.playlist, {
    atualizar: true,
  });
  assert.equal(
    (await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.playlist,
    undefined,
    'uma vez só',
  );
  const antesDoGet = new Date();
  await app.chamar('GET', `/playlist/${cred.dispositivoId}`, { chave: cred.chaveAparelho });
  const { rows } = await pool.query('SELECT playlist_desatualizada_em FROM dispositivos WHERE id = $1', [tela.id]);
  // A marca anterior ao GET foi limpa. (Uma marca NOVA pode aparecer logo
  // depois: outros arquivos de teste mudam criativos em paralelo.)
  const marca = rows[0].playlist_desatualizada_em;
  // Marca dos 5 s anteriores à geração fica de propósito (folga contra a
  // corrida de commit, src/playlist/routes.js); tudo antes disso é limpo.
  assert.ok(marca === null || new Date(marca) > new Date(antesDoGet.getTime() - 5000), 'nunca fica true pra sempre');
  // V1 (sem X-Player-Contract) recebe o array de sempre, sem contentHash.
  const v1 = await app.chamar('GET', `/playlist/${cred.dispositivoId}`, { chave: cred.chaveAparelho, v2: false });
  assert.ok(Array.isArray(v1.json));
});

test('playlist: gatilho do banco marca as telas ativas quando um criativo muda', async () => {
  const { tela } = await telaProvisionada(app);
  await pool.query('UPDATE dispositivos SET playlist_desatualizada_em = NULL WHERE id = $1', [tela.id]);
  const { rows: c } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash)
     VALUES (now(), 'Hash', '11144477735', $1, '1', 'x') RETURNING id`,
    [`hash-${randomUUID()}@x.com`],
  );
  const { rows: cr } = await pool.query(
    `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, conteudo_sha256, conteudo_bytes)
     VALUES ($1, 'a.mp4', 'https://x/1.mp4', repeat('ab', 32), 10) RETURNING id`,
    [c[0].id],
  );
  const { rows } = await pool.query('SELECT playlist_desatualizada_em FROM dispositivos WHERE id = $1', [tela.id]);
  assert.ok(rows[0].playlist_desatualizada_em, 'criativo novo marca a playlist como desatualizada');

  // URL trocada sem hash novo: o hash antigo mentiria — zera (Player cai no V1).
  const criativosRepo = require('../src/anunciantes/criativos-repository');
  const depois = await criativosRepo.atualizar(cr[0].id, { arquivo_normalizado_url: 'https://x/2.mp4' });
  assert.equal(depois.conteudo_sha256, null);
  const comHash = await criativosRepo.atualizar(cr[0].id, {
    arquivo_normalizado_url: 'https://x/3.mp4',
    conteudo_sha256: 'c'.repeat(64),
  });
  assert.equal(comHash.conteudo_sha256, 'c'.repeat(64), 'substituição com hash novo mantém o hash novo');
  await pool.query('DELETE FROM criativos WHERE id = $1', [cr[0].id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [c[0].id]);
});

// ---------------------------------------------------------------------------
// 66. Proof-of-play
// ---------------------------------------------------------------------------
test('proof V2: idempotente por execucaoId, item ruim é status (200), envelope ruim é 400', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/played`;
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  const janelaId = `${tela.id}|${hora.toISOString()}`;
  const { rows: c } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash)
     VALUES (now(), 'Proof', '11144477735', $1, '1', 'x') RETURNING id`,
    [`proof-${randomUUID()}@x.com`],
  );
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas) VALUES ($1, $2, $3, 5)`,
    [c[0].id, tela.id, hora],
  );
  const evento = (id, extra = {}) => ({
    execucaoId: id,
    janelaId,
    itemProgramacaoId: `${janelaId}|0|${c[0].id}`,
    criativoId: '1',
    iniciadoEm: new Date().toISOString(),
    terminadoEm: new Date().toISOString(),
    ...extra,
  });
  const e1 = randomUUID();
  const r = await app.chamar('POST', url, {
    chave: cred.chaveAparelho,
    corpo: {
      eventos: [
        evento(e1),
        evento(e1),
        evento(randomUUID(), { itemProgramacaoId: undefined }),
        evento(randomUUID(), { itemProgramacaoId: `${janelaId}|0|99999999999` }),
        { semExecucaoId: true },
      ],
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.json.resultados.map((x) => x.status),
    ['contabilizado', 'duplicado', 'item_invalido', 'item_invalido'],
  );
  const repete = await app.chamar('POST', url, { chave: cred.chaveAparelho, corpo: { eventos: [evento(e1)] } });
  assert.equal(repete.json.resultados[0].status, 'duplicado');
  const { rows } = await pool.query(
    'SELECT vezes_confirmadas FROM exibicoes_contador WHERE anunciante_id = $1 AND dispositivo_id = $2',
    [c[0].id, tela.id],
  );
  assert.equal(rows[0].vezes_confirmadas, 1, 'mesmo execucaoId NUNCA conta duas vezes');

  assert.equal((await app.chamar('POST', url, { chave: cred.chaveAparelho, corpo: { eventos: 'x' } })).status, 400);
  assert.equal(
    (await app.chamar('POST', url, { chave: cred.chaveAparelho, corpo: { eventos: Array(501).fill({}) } })).status,
    400,
  );
  assert.equal((await app.chamar('POST', url, { chave: cred.chaveAparelho, cru: '{quebrado' })).status, 400);
  await pool.query('DELETE FROM execucoes_confirmadas WHERE dispositivo_id = $1', [tela.id]);
  await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [tela.id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [c[0].id]);
});

test('proof: erro interno (banco fora) é 500 — nunca 400, que viraria quarentena permanente no Player', async () => {
  const { cred } = await telaProvisionada(app);
  const execucoesRepo = require('../src/playlist/execucoes-repository');
  const original = execucoesRepo.confirmarComDedup;
  execucoesRepo.confirmarComDedup = async () => {
    throw new Error('connection terminated');
  };
  try {
    const r = await app.chamar('POST', `/player/${cred.dispositivoId}/played`, {
      chave: cred.chaveAparelho,
      corpo: { eventos: [{ execucaoId: randomUUID(), janelaId: 'x', itemProgramacaoId: 'y' }] },
    });
    assert.equal(r.status, 500);
  } finally {
    execucoesRepo.confirmarComDedup = original;
  }
});

// ---------------------------------------------------------------------------
// 67. OTA
// ---------------------------------------------------------------------------
test('OTA: nada ativo → sem update; release só vale ativa e com assinatura conferida; build igual/menor → nada', async () => {
  const { cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  const beat = async () => (await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json;
  assert.equal((await beat()).update, undefined);

  const sha = 'd'.repeat(64);
  const nova = await app.chamar('POST', '/admin/player-releases', {
    corpo: { versao: 'teste-1.1.0', build: 900001, url: 'https://cdn/x.apk', sha256: sha, tamanho_bytes: 123 },
  });
  assert.equal(nova.status, 201);
  assert.equal((await beat()).update, undefined, 'segurada não é anunciada');
  assert.equal(
    (await app.chamar('PATCH', `/admin/player-releases/${nova.json.id}`, { corpo: { ativa: true } })).status,
    400,
  );
  await app.chamar('POST', `/admin/player-releases/${nova.json.id}/assinatura-conferida`);
  assert.equal(
    (await app.chamar('PATCH', `/admin/player-releases/${nova.json.id}`, { corpo: { ativa: true } })).status,
    200,
  );
  const m = (await beat()).update;
  assert.deepEqual(m, {
    available: true,
    required: false,
    version: 'teste-1.1.0',
    build: 900001,
    url: 'https://cdn/x.apk',
    sha256: sha,
    size: 123,
  });

  await app.chamar('PATCH', `/admin/player-releases/${nova.json.id}`, { corpo: { ativa: false } });
  assert.equal((await beat()).update, undefined, 'segurar de novo tira o anúncio');

  for (const ruim of [
    { versao: 'teste-x', build: 0, url: 'https://a', sha256: sha },
    { versao: 'teste-x', build: 5, url: 'http://a', sha256: sha },
    { versao: 'teste-x', build: 5, url: 'https://a', sha256: 'curto' },
  ]) {
    assert.equal(
      (await app.chamar('POST', '/admin/player-releases', { corpo: ruim })).status,
      400,
      JSON.stringify(ruim),
    );
  }
});

test('OTA: manifesto respeita build instalado e build mínimo (releases.aplicavelA)', async () => {
  const releases = require('../src/player/releases');
  const { rows } = await pool.query(
    `INSERT INTO player_releases (versao, build, url, sha256, assinatura_conferida_em, ativa, build_minimo)
     VALUES ('teste-min', 900010, 'https://cdn/m.apk', repeat('e', 64), now(), true, 5) RETURNING id`,
  );
  try {
    assert.equal((await releases.aplicavelA(900010))?.build, undefined, 'build igual: nada');
    assert.equal((await releases.aplicavelA(900011))?.build, undefined, 'build maior instalado: nada');
    assert.equal((await releases.aplicavelA(4))?.build, undefined, 'abaixo do build mínimo: nada');
    assert.equal((await releases.aplicavelA(6)).build, 900010);
    assert.equal(await releases.aplicavelA(undefined), null, 'sem build conhecido não compara');
  } finally {
    await pool.query('DELETE FROM player_releases WHERE id = $1', [rows[0].id]);
  }
});

// ---------------------------------------------------------------------------
// Auditoria A/B (24/09/2026): rotação, corrida, V1 ponta a ponta
// ---------------------------------------------------------------------------
const credencialMod = require('../src/player/credencial');
const statusDoPonto = async (id) => (await pool.query('SELECT status FROM pontos WHERE id = $1', [id])).rows[0].status;
const eventosDe = async (telaId, tipo) =>
  (
    await pool.query('SELECT count(*)::int AS n FROM tela_eventos WHERE dispositivo_id = $1 AND tipo = $2', [
      telaId,
      tipo,
    ])
  ).rows[0].n;

test('rotação: 403 (tela fora do ar) NÃO promove a candidata — ela volta no heartbeat seguinte', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`);
  const nova = (await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.novaChave;
  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { status: 'reparo' } });
  // O Player descarta a candidata em resposta que não é sucesso.
  assert.equal((await app.chamar('GET', `/playlist/${cred.dispositivoId}`, { chave: nova })).status, 403);
  const r = await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho });
  assert.equal(r.status, 200, 'a chave atual continua valendo');
  assert.equal(r.json.novaChave, nova, 'a candidata é reenviada');
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: nova })).status, 200);
});

test('rotação: só resposta 2xx promove; 400/500 com a candidata não a oficializam (Codex P1)', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`);
  const k1 = (await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.novaChave;
  // Corpo estruturalmente inválido: 400 — o Player descarta a candidata.
  assert.equal((await app.chamar('POST', url, { cru: '[1]', chave: k1 })).status, 400);
  const { rows } = await pool.query('SELECT chave_nova_hash FROM dispositivos WHERE id = $1', [tela.id]);
  assert.ok(rows[0].chave_nova_hash, 'candidata segue pendente');
  const r = await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho });
  assert.equal(r.status, 200);
  assert.equal(r.json.novaChave, k1, 'e volta no heartbeat seguinte');
  // Promoção que falha no banco vira 503 (o Player repete), nunca 200.
  const original = credencialMod.promoverChaveNova;
  credencialMod.promoverChaveNova = async () => {
    throw Object.assign(new Error('banco fora'), { code: '57P01' });
  };
  try {
    assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).status, 503);
  } finally {
    credencialMod.promoverChaveNova = original;
  }
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).status, 200);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).json.novaChave, undefined);
});

test('rotação: admin cancela no meio de uma resposta 2xx → a chave que o aparelho recebeu "sim" vale', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`);
  const k1 = (await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.novaChave;
  const original = credencialMod.promoverChaveNova;
  credencialMod.promoverChaveNova = async (...args) => {
    await credencialMod.cancelarRotacao(tela.id);
    return original(...args);
  };
  try {
    assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).status, 200);
  } finally {
    credencialMod.promoverChaveNova = original;
  }
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).status, 200, 'nunca tranca');
  // Revogação no meio vence: nenhuma chave ressuscita.
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`);
  const k2 = (await app.chamar('POST', url, { corpo: hb(), chave: k1 })).json.novaChave;
  credencialMod.promoverChaveNova = async (...args) => {
    await credencialMod.revogar(tela.id);
    return original(...args);
  };
  try {
    await app.chamar('POST', url, { corpo: hb(), chave: k2 });
  } finally {
    credencialMod.promoverChaveNova = original;
  }
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k2 })).status, 401);
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).status, 401);
});

test('rotação: resposta que promoveu se perdeu → aparelho volta com a anterior e recebe a atual de novo', async () => {
  const { tela, cred } = await telaProvisionada(app);
  const url = `/player/${cred.dispositivoId}/heartbeat`;
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`);
  const k1 = (await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.novaChave;
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).status, 200); // "perdida"
  const r = await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho });
  assert.equal(r.status, 200, 'anterior ainda vale');
  assert.equal(r.json.novaChave, k1, 'a atual é reenviada');
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: k1 })).status, 200);
  const { rows } = await pool.query('SELECT chave_atual_cifrada FROM dispositivos WHERE id = $1', [tela.id]);
  assert.equal(rows[0].chave_atual_cifrada, null, 'usada uma vez, a cópia cifrada some');
  assert.equal((await app.chamar('POST', url, { corpo: hb(), chave: cred.chaveAparelho })).json.novaChave, undefined);
});

test('provisionamento: gerar arquivo novo enquanto o token é trocado não trava (Codex P2)', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  for (let i = 0; i < 5; i++) {
    const arq = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`)).json.arquivo;
    const [troca, gerar] = await Promise.all([
      app.chamar('POST', '/player/provisionar', { corpo: { tokenProvisionamento: arq.tokenProvisionamento } }),
      app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`),
    ]);
    assert.ok([200, 401].includes(troca.status), `troca: ${troca.status}`);
    assert.equal(gerar.status, 201, `gerar: ${gerar.status}`);
  }
});

test('V1: chave antiga em texto (backfill da 083) autentica só com X-Aparelho-Id; hash do SQL = hash do Node', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const chaveV1 = `v1-${randomUUID()}`;
  await pool.query('UPDATE dispositivos SET aparelho_id = $2 WHERE id = $1', [tela.id, chaveV1]);
  // Mesma expressão da seção 2 da migration 083.
  await pool.query(
    `UPDATE dispositivos
        SET chave_hash = encode(sha256(convert_to(aparelho_id, 'UTF8')), 'hex'),
            chave_fingerprint = upper(right(encode(sha256(convert_to(aparelho_id, 'UTF8')), 'hex'), 6))
      WHERE id = $1`,
    [tela.id],
  );
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(
    ficha.identidade.credencial.fingerprint,
    credencialMod.fingerprintDoHash(credencialMod.hashDaChave(chaveV1)),
  );
  const pl = await app.chamar('GET', `/playlist/${tela.id}`, { chave: chaveV1, v2: false, legado: true });
  assert.equal(pl.status, 200);
  assert.ok(Array.isArray(pl.json));
  assert.equal(ficha.identidade.credencial.rotacionavel, false, 'V1 não tem rotação');
  assert.equal((await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/rotacionar`)).status, 400);
  // Revogar apaga também a chave em texto: um rollback não a ressuscita.
  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/revogar`);
  const { rows } = await pool.query('SELECT aparelho_id FROM dispositivos WHERE id = $1', [tela.id]);
  assert.equal(rows[0].aparelho_id, null);
  assert.equal(
    (await app.chamar('GET', `/playlist/${tela.id}`, { chave: chaveV1, v2: false, legado: true })).status,
    401,
  );
});

test('V1: primeiro contato pela playlist conta como sinal (ponto entra no ar), um FIRST_SEEN só', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const chave = await chaveV1(tela.id);
  // Chave V1 gravada = Player preparado; sem sinal ainda é "aguardando
  // primeiro sinal" (migration 088), não "aguardando instalação".
  assert.equal(await statusDoPonto(pid), 'aguardando_primeiro_sinal');
  assert.equal((await app.chamar('GET', `/playlist/${tela.id}`, { chave, v2: false, legado: true })).status, 200);
  assert.equal(await statusDoPonto(pid), 'em_operacao');
  await app.chamar('POST', `/player/${tela.id}/heartbeat`, { cru: '', chave, v2: false, legado: true });
  assert.equal(await eventosDe(tela.id, 'FIRST_SEEN'), 1);
});

test('V1: heartbeat {erro:texto}, played {anuncianteId} string/número, painel por PIN, envelope por contrato_playlist', async () => {
  const pid = await novoPonto();
  const tela = (await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} })).json;
  const chave = await chaveV1(tela.id);
  const v1 = { chave, v2: false, legado: true };

  const hbErro = await app.chamar('POST', `/player/${tela.id}/heartbeat`, { ...v1, corpo: { erro: 'vídeo travou' } });
  assert.equal(hbErro.status, 200);
  let ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(ficha.saude, 'erro_do_player');
  await app.chamar('POST', `/player/${tela.id}/heartbeat`, { ...v1, corpo: { erro: null } });
  ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.notEqual(ficha.saude, 'erro_do_player', 'erro null limpa');

  // Número e string passam do parse (o Android V1 manda string); não
  // programado é a recusa de sempre do V1.
  for (const anuncianteId of [999999, '999999']) {
    const r = await app.chamar('POST', `/player/${tela.id}/played`, { ...v1, corpo: { anuncianteId } });
    assert.equal(r.status, 400);
    assert.match(r.json.erro, /não está programado/);
  }
  assert.match(
    (await app.chamar('POST', `/player/${tela.id}/played`, { ...v1, corpo: { anuncianteId: 'x' } })).json.erro,
    /obrigatório/,
  );

  assert.equal(
    (await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: '4321' } })).status,
    200,
  );
  assert.equal((await app.chamar('POST', `/player/${tela.id}/painel`, { ...v1, corpo: { pin: '0000' } })).status, 401);
  assert.equal((await app.chamar('POST', `/player/${tela.id}/painel`, { ...v1, corpo: { pin: '4321' } })).status, 200);
  // Tela só com player web pode ficar sem PIN.
  assert.equal((await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: null } })).status, 200);

  await pool.query('UPDATE dispositivos SET contrato_playlist = 2 WHERE id = $1', [tela.id]);
  const env = await app.chamar('GET', `/playlist/${tela.id}`, v1);
  assert.equal(env.status, 200);
  assert.ok(!Array.isArray(env.json) && Array.isArray(env.json.itens), 'Android V1 do contrato 2 recebe envelope');

  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { status: 'reparo' } });
  assert.equal(
    (await app.chamar('POST', `/player/${tela.id}/played`, { ...v1, corpo: { anuncianteId: 1 } })).status,
    403,
  );
});

test('V2: PIN não pode ser removido; revogar tira o ponto do ar e reprovisionar devolve', async () => {
  const { tela, cred, pontoId } = await telaProvisionada(app);
  await app.chamar('POST', `/player/${cred.dispositivoId}/hello`, {
    corpo: { contrato: 2 },
    chave: cred.chaveAparelho,
  });
  assert.equal(await statusDoPonto(pontoId), 'em_operacao');
  assert.equal(
    (await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: '1234' } })).status,
    200,
  );
  assert.equal((await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: null } })).status, 400);

  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/revogar`);
  assert.equal(await statusDoPonto(pontoId), 'a_instalar', 'Player revogado não exibe');
  const arq = (await app.chamar('POST', `/admin/dispositivos/${tela.id}/provisionamento`)).json.arquivo;
  const r = await app.chamar('POST', '/player/provisionar', {
    corpo: { tokenProvisionamento: arq.tokenProvisionamento },
  });
  assert.equal(r.status, 200);
  assert.equal(await statusDoPonto(pontoId), 'em_operacao');
});

test('margens: valor antigo acima de 10 segue intacto para o V1; o V2 recebe no máximo 10', async () => {
  const { tela, cred } = await telaProvisionada(app);
  await pool.query('UPDATE dispositivos SET margem_superior = 15, margem_esquerda = 4 WHERE id = $1', [tela.id]);
  const v2 = await app.chamar('POST', `/player/${cred.dispositivoId}/heartbeat`, {
    corpo: hb(),
    chave: cred.chaveAparelho,
  });
  assert.deepEqual(v2.json.margens, { superior: 10, direita: 0, inferior: 0, esquerda: 4 });
  const cfg = await app.chamar('GET', `/player/${cred.dispositivoId}/config`, { chave: cred.chaveAparelho });
  assert.equal(cfg.json.margens.superior, 10);
  // Comportamento V1 é decidido pelos headers (sem X-Player-Contract), não
  // pela forma do id: a tela com dispositivoId só responde por ele.
  const v1 = await app.chamar('POST', `/player/${cred.dispositivoId}/heartbeat`, {
    cru: '',
    chave: cred.chaveAparelho,
    v2: false,
    legado: true,
  });
  assert.equal(v1.json.margens.superior, 15, 'player web respeita até 20');
  assert.equal(
    (await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { margem_superior: 11 } })).status,
    400,
    'escrita nova tem teto 10',
  );
});
