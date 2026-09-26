const test = require('node:test');
const assert = require('node:assert');
const pool = require('../src/db/pool');
const { subirApp, ipDeTeste, novoPonto, novaTela, instalarPlayer, limparPontos, eventosDe } = require('./apoio-player');

// Contraparte do Player MVP (docs/player-mvp-contract.md), pelas rotas reais.

let app;
test.before(async () => {
  app = await subirApp();
});
test.after(async () => {
  await app.fechar();
  await limparPontos();
  await pool.query("DELETE FROM tentativas_acesso WHERE chave LIKE '10.%'");
  await pool.end();
});

const gerarCodigo = async (telaId) => app.chamar('POST', `/admin/dispositivos/${telaId}/codigo-instalacao`);
const provisionar = (corpo, ip = ipDeTeste()) => app.chamar('POST', '/player/provisionar', { corpo, ip });
const codigoDaTela = (id) => `M-${String(id).padStart(4, '0')}`;

// ---------------------------------------------------------------------------
// Instalação: ID da tela + código de instalação (§3)
// ---------------------------------------------------------------------------
test('instalação: código certo vira credencial; ID em qualquer forma normalizável; auth funciona depois', async () => {
  const pid = await novoPonto();
  for (const forma of ['M-', 'M', '', 'min']) {
    const tela = await novaTela(pid);
    const g = await gerarCodigo(tela.id);
    assert.equal(g.status, 201);
    assert.match(g.json.codigo, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
    assert.equal(g.json.codigoTela, codigoDaTela(tela.id));
    const idDigitado = forma === 'min' ? String(tela.id) : `${forma}${String(tela.id).padStart(4, '0')}`.toLowerCase();
    const r = await provisionar({
      codigoTela: idDigitado,
      codigoInstalacao: g.json.codigo.replace('-', '').toLowerCase(),
    });
    assert.equal(r.status, 200, `forma ${forma}: ${r.texto}`);
    assert.equal(r.json.dispositivoId, codigoDaTela(tela.id));
    assert.ok(r.json.chaveAparelho.length >= 40);
    const cfg = await app.chamar('GET', `/player/${r.json.dispositivoId}/config`, { chave: r.json.chaveAparelho });
    assert.equal(cfg.status, 200, 'autentica com a credencial recebida');
    assert.equal(await eventosDe(tela.id, 'PLAYER_PROVISIONED'), 1);
  }
});

test('instalação: formato ruim é 400; tela inexistente, código errado, expirado e usado são 401 iguais', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const { codigo } = (await gerarCodigo(tela.id)).json;
  assert.equal((await provisionar({ codigoTela: 'X-12', codigoInstalacao: codigo })).status, 400);
  assert.equal((await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: '7K4M' })).status, 400);
  assert.equal((await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: '7K4M9Q2O' })).status, 400);
  assert.equal((await provisionar({ codigoInstalacao: codigo })).status, 400);
  assert.equal((await app.chamar('POST', '/player/provisionar', { cru: '[1]', ip: ipDeTeste() })).status, 400);

  const inexistente = await provisionar({ codigoTela: 'M-2147480000', codigoInstalacao: codigo });
  assert.equal(inexistente.status, 401);
  const errado = await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: 'AAAA-AAAA' });
  assert.equal(errado.status, 401);
  assert.deepEqual(errado.json, inexistente.json, 'mesma resposta para os dois');

  // Expirado.
  await pool.query(
    `UPDATE tokens_provisionamento SET expira_em = now() - interval '1 second' WHERE dispositivo_id = $1`,
    [tela.id],
  );
  assert.equal((await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: codigo })).status, 401);

  // Uso único: depois de usado e fora da repetição, não vale mais.
  const g2 = (await gerarCodigo(tela.id)).json;
  const ok = await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: g2.codigo });
  assert.equal(ok.status, 200);
  await pool.query(
    `UPDATE tokens_provisionamento SET usado_em = now() - interval '1 hour' WHERE dispositivo_id = $1 AND usado_em IS NOT NULL`,
    [tela.id],
  );
  assert.equal((await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: g2.codigo })).status, 401);
});

test('instalação: validade de 30 min, código só volta em claro enquanto vale, nunca a chave', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const g = (await gerarCodigo(tela.id)).json;
  const minutos = (new Date(g.expiraEm) - new Date(g.criadoEm)) / 60000;
  assert.ok(Math.abs(minutos - 30) < 0.1, `validade ${minutos} min`);
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(ficha.identidade.provisionamento.codigo, g.codigo, 'admin reexibe o código pendente');
  const { rows } = await pool.query('SELECT * FROM tokens_provisionamento WHERE dispositivo_id = $1', [tela.id]);
  const semHifen = g.codigo.replace('-', '');
  assert.ok(!JSON.stringify(rows).includes(semHifen), 'código em claro no banco');
  assert.ok(!JSON.stringify(rows).includes(g.codigo), 'código em claro no banco');
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

  const cred = (await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: g.codigo })).json;
  const depois = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(depois.identidade.provisionamento.codigo, null, 'código usado não volta');
  assert.ok(!JSON.stringify(depois).includes(cred.chaveAparelho), 'chave permanente nunca vai ao admin');
  const { rows: tela2 } = await pool.query('SELECT * FROM dispositivos WHERE id = $1', [tela.id]);
  assert.ok(!JSON.stringify(tela2).includes(cred.chaveAparelho), 'chave em claro no banco');
  const { rows: ev } = await pool.query('SELECT detalhe FROM tela_eventos WHERE dispositivo_id = $1', [tela.id]);
  assert.ok(!JSON.stringify(ev).includes(cred.chaveAparelho) && !JSON.stringify(ev).includes(semHifen));
});

test('instalação: código novo cancela o anterior; código de outra tela não vale', async () => {
  const pid = await novoPonto();
  const a = await novaTela(pid);
  const b = await novaTela(pid);
  const antigo = (await gerarCodigo(a.id)).json.codigo;
  const novo = (await gerarCodigo(a.id)).json.codigo;
  const deB = (await gerarCodigo(b.id)).json.codigo;
  assert.equal((await provisionar({ codigoTela: codigoDaTela(a.id), codigoInstalacao: antigo })).status, 401);
  assert.equal((await provisionar({ codigoTela: codigoDaTela(a.id), codigoInstalacao: deB })).status, 401);
  assert.equal((await provisionar({ codigoTela: codigoDaTela(a.id), codigoInstalacao: novo })).status, 200);
  assert.equal((await provisionar({ codigoTela: codigoDaTela(b.id), codigoInstalacao: deB })).status, 200);
});

test('instalação: 5 erros para a tela cancelam o código pendente (o certo deixa de valer)', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const { codigo } = (await gerarCodigo(tela.id)).json;
  const ip = ipDeTeste();
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: 'BBBB-BBBB' }, ip)).status,
      401,
    );
  }
  assert.equal(
    (await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: codigo }, ipDeTeste())).status,
    401,
  );
  const { rows } = await pool.query(
    `SELECT tentativas_erradas, cancelado_em, codigo_cifrado FROM tokens_provisionamento WHERE dispositivo_id = $1`,
    [tela.id],
  );
  assert.equal(rows[0].tentativas_erradas, 5);
  assert.ok(rows[0].cancelado_em);
  assert.equal(rows[0].codigo_cifrado, null);
  assert.equal(await eventosDe(tela.id, 'PROVISIONING_FAILED'), 6);
  // Gerar outro resolve.
  const outro = (await gerarCodigo(tela.id)).json.codigo;
  assert.equal(
    (await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: outro }, ipDeTeste())).status,
    200,
  );
});

test('instalação: limite por origem (10 tentativas em 15 min) → 429 com Retry-After', async () => {
  const ip = ipDeTeste();
  let ultima;
  for (let i = 0; i < 11; i++) {
    ultima = await provisionar({ codigoTela: 'M-2147480001', codigoInstalacao: 'CCCC-CCCC' }, ip);
  }
  assert.equal(ultima.status, 429);
  assert.ok(Number(ultima.headers.get('retry-after')) > 0);
});

test('instalação: repetir o mesmo par em 5 min devolve A MESMA credencial; o 1º uso da chave fecha a janela', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const { codigo } = (await gerarCodigo(tela.id)).json;
  const corpo = { codigoTela: codigoDaTela(tela.id), codigoInstalacao: codigo };
  const r1 = await provisionar(corpo);
  const r2 = await provisionar(corpo);
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json, r1.json);
  assert.equal(await eventosDe(tela.id, 'PLAYER_PROVISIONED'), 1, 'repetição não reinstala');
  await app.chamar('GET', `/player/${r1.json.dispositivoId}/config`, { chave: r1.json.chaveAparelho });
  assert.equal((await provisionar(corpo)).status, 401, 'janela fechada no primeiro uso');
});

test('instalação: duas trocas simultâneas do mesmo código geram UMA credencial', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const { codigo } = (await gerarCodigo(tela.id)).json;
  const corpo = { codigoTela: codigoDaTela(tela.id), codigoInstalacao: codigo };
  const [a, b] = await Promise.all([provisionar(corpo), provisionar(corpo)]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.json.chaveAparelho, b.json.chaveAparelho);
  assert.equal(await eventosDe(tela.id, 'PLAYER_PROVISIONED'), 1);
});

test('instalação: tela com Player conectado não gera código (409); revogar cancela o pendente e permite reinstalar', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const pendente = (await gerarCodigo(tela.id)).json.codigo;
  assert.equal((await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/revogar`)).status, 200);
  assert.equal(
    (await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: pendente })).status,
    401,
    'revogar cancela o código pendente',
  );

  const antigo = await instalarPlayer(tela.id);
  const bloqueado = await gerarCodigo(tela.id);
  assert.equal(bloqueado.status, 409);
  assert.match(bloqueado.json.erro, /revogue/);

  await app.chamar('POST', `/admin/dispositivos/${tela.id}/credencial/revogar`);
  assert.equal(
    (await app.chamar('GET', `/player/${antigo.dispositivoId}/config`, { chave: antigo.chaveAparelho })).status,
    401,
    'credencial revogada',
  );
  const novo = await instalarPlayer(tela.id);
  assert.equal(novo.dispositivoId, antigo.dispositivoId, 'o ID da tela não muda');
  assert.notEqual(novo.chaveAparelho, antigo.chaveAparelho);
  assert.equal(
    (await app.chamar('GET', `/player/${novo.dispositivoId}/config`, { chave: novo.chaveAparelho })).status,
    200,
  );
  assert.equal(
    (await app.chamar('GET', `/player/${novo.dispositivoId}/config`, { chave: antigo.chaveAparelho })).status,
    401,
  );
});

test('credencial: só a própria tela aceita; a chave de uma tela não abre outra', async () => {
  const pid = await novoPonto();
  const a = await novaTela(pid);
  const b = await novaTela(pid);
  const ca = await instalarPlayer(a.id);
  const cb = await instalarPlayer(b.id);
  assert.equal(
    (await app.chamar('GET', `/player/${cb.dispositivoId}/config`, { chave: ca.chaveAparelho })).status,
    401,
  );
  assert.equal((await app.chamar('GET', `/player/${ca.dispositivoId}/config`, { chave: '' })).status, 401);
  assert.equal((await app.chamar('GET', `/player/${ca.dispositivoId}/config`)).status, 401);
  assert.equal(
    (await app.chamar('GET', `/player/${ca.dispositivoId}/config`, { chave: ca.chaveAparelho })).status,
    200,
  );
});

test('credencial e código nunca vão para o log', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const escrito = [];
  const originais = {};
  for (const nivel of ['log', 'info', 'warn', 'error', 'debug']) {
    originais[nivel] = console[nivel];
    console[nivel] = (...args) => {
      escrito.push(args.map(String).join(' '));
      originais[nivel](...args);
    };
  }
  let cred;
  let codigo;
  try {
    codigo = (await gerarCodigo(tela.id)).json.codigo;
    await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: 'DDDD-DDDD' });
    cred = (await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: codigo })).json;
  } finally {
    Object.assign(console, originais);
  }
  const tudo = escrito.join('\n');
  assert.ok(!tudo.includes(cred.chaveAparelho));
  assert.ok(!tudo.includes(codigo) && !tudo.includes(codigo.replace('-', '')));
});
