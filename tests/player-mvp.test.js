const test = require('node:test');
const assert = require('node:assert');
const pool = require('../src/db/pool');
const {
  subirApp,
  ipDeTeste,
  novoPonto,
  novaTela,
  instalarPlayer,
  garantirPinSaida,
  limparPontos,
  eventosDe,
} = require('./apoio-player');
const pinSaida = require('../src/player/pin-saida');

// Contraparte do Player MVP (docs/player-mvp-contract.md), pelas rotas reais.

let app;
test.before(async () => {
  app = await subirApp();
  await garantirPinSaida();
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
  assert.equal(ficha.instalacao.codigo, g.codigo, 'admin reexibe o código pendente');
  const { rows } = await pool.query('SELECT * FROM tokens_provisionamento WHERE dispositivo_id = $1', [tela.id]);
  const semHifen = g.codigo.replace('-', '');
  assert.ok(!JSON.stringify(rows).includes(semHifen), 'código em claro no banco');
  assert.ok(!JSON.stringify(rows).includes(g.codigo), 'código em claro no banco');
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);

  const cred = (await provisionar({ codigoTela: codigoDaTela(tela.id), codigoInstalacao: g.codigo })).json;
  const depois = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.equal(depois.instalacao.codigo, null, 'código usado não volta');
  assert.equal(depois.instalacao.estado, 'conectado');
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

// ---------------------------------------------------------------------------
// Admin: Rede → Ponto → Tela (§9 do contrato; ficha simplificada)
// ---------------------------------------------------------------------------
test('admin: tela nasce com código M-xxxx, "Aguardando instalação", sem dado técnico; vira "Conectado"', async () => {
  const pid = await novoPonto();
  const criada = await app.chamar('POST', `/admin/pontos/${pid}/dispositivos`, { corpo: {} });
  assert.equal(criada.status, 201);
  const t = criada.json;
  assert.equal(t.codigo, codigoDaTela(t.id));
  assert.equal(t.nome, t.codigo);
  assert.equal(t.status, 'ativo');
  assert.equal(t.saude, 'aguardando_instalacao');
  assert.deepEqual(t.instalacao, { estado: 'aguardando', conectadoEm: null, codigo: null, expiraEm: null });
  for (const proibido of [
    'identidade',
    'diagnostico',
    'dispositivoId',
    'fingerprint',
    'contrato',
    'rotacao',
    'baseUrl',
  ]) {
    assert.ok(!JSON.stringify(t).includes(`"${proibido}"`), `campo técnico na ficha: ${proibido}`);
  }

  const g = (await gerarCodigo(t.id)).json;
  const aguardando = (await app.chamar('GET', `/admin/dispositivos/${t.id}`)).json;
  assert.equal(aguardando.instalacao.codigo, g.codigo);
  assert.equal(new Date(aguardando.instalacao.expiraEm).toISOString(), new Date(g.expiraEm).toISOString());

  // Código expirado não volta mais na ficha.
  await pool.query(
    `UPDATE tokens_provisionamento SET expira_em = now() - interval '1 second' WHERE dispositivo_id = $1`,
    [t.id],
  );
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${t.id}`)).json.instalacao.codigo, null);

  const novo = (await gerarCodigo(t.id)).json;
  await provisionar({ codigoTela: t.codigo, codigoInstalacao: novo.codigo });
  const conectada = (await app.chamar('GET', `/admin/dispositivos/${t.id}`)).json;
  assert.equal(conectada.instalacao.estado, 'conectado');
  assert.ok(conectada.instalacao.conectadoEm);
  assert.equal(conectada.saude, 'operando', 'a instalação é o primeiro contato');
  assert.ok(conectada.ultimoSinalEm);

  // Margem e estado.
  const m = await app.chamar('PATCH', `/admin/dispositivos/${t.id}`, {
    corpo: { margem_superior: 2, margem_direita: 1.5, margem_inferior: 0, margem_esquerda: 10 },
  });
  assert.equal(m.status, 200);
  assert.deepEqual(m.json.margens, { superior: 2, direita: 1.5, inferior: 0, esquerda: 10 });
  assert.equal(
    (await app.chamar('PATCH', `/admin/dispositivos/${t.id}`, { corpo: { margem_superior: 11 } })).status,
    400,
    'teto de 10 por lado',
  );
  const reparo = await app.chamar('PATCH', `/admin/dispositivos/${t.id}`, { corpo: { status: 'reparo' } });
  assert.equal(reparo.json.saude, 'em_reparo');
  await app.chamar('PATCH', `/admin/dispositivos/${t.id}`, { corpo: { status: 'ativo' } });

  // Revogar → volta a "Aguardando instalação" e aceita código novo.
  const revogada = await app.chamar('POST', `/admin/dispositivos/${t.id}/credencial/revogar`);
  assert.equal(revogada.json.saude, 'aguardando_instalacao');
  assert.equal(revogada.json.instalacao.estado, 'aguardando');
  assert.equal((await gerarCodigo(t.id)).status, 201);
});

test('admin: excluir tela sem histórico (recém-criada, com código pendente, instalada) e bloquear com histórico', async () => {
  const pid = await novoPonto();
  const existe = async (id) => (await pool.query('SELECT 1 FROM dispositivos WHERE id = $1', [id])).rows.length > 0;
  const tokens = async (id) =>
    (await pool.query('SELECT COUNT(*)::int AS n FROM tokens_provisionamento WHERE dispositivo_id = $1', [id])).rows[0]
      .n;

  const recem = await novaTela(pid);
  assert.equal((await app.chamar('DELETE', `/admin/dispositivos/${recem.id}`)).status, 200);
  assert.equal(await existe(recem.id), false);
  assert.equal((await app.chamar('DELETE', `/admin/dispositivos/${recem.id}`)).status, 404, 'exclusão repetida');

  const comCodigo = await novaTela(pid);
  const pendente = (await gerarCodigo(comCodigo.id)).json.codigo;
  assert.equal((await app.chamar('DELETE', `/admin/dispositivos/${comCodigo.id}`)).status, 200);
  assert.equal(await tokens(comCodigo.id), 0, 'nenhum código órfão');
  assert.equal((await provisionar({ codigoTela: codigoDaTela(comCodigo.id), codigoInstalacao: pendente })).status, 401);

  const instalada = await novaTela(pid);
  const cred = await instalarPlayer(instalada.id);
  assert.equal((await app.chamar('DELETE', `/admin/dispositivos/${instalada.id}`)).status, 200);
  assert.equal(
    (await app.chamar('GET', `/player/${cred.dispositivoId}/config`, { chave: cred.chaveAparelho })).status,
    401,
    'credencial some com a tela',
  );
  assert.equal(
    (await pool.query('SELECT COUNT(*)::int AS n FROM tela_eventos WHERE dispositivo_id = $1', [instalada.id])).rows[0]
      .n,
    0,
  );

  // Com proof-of-play: evidência não se apaga.
  const comPop = await novaTela(pid);
  const {
    rows: [conta],
  } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em)
     VALUES ('Excluir Tela MVP', '00000000000191', $1, '16999990000', 'x', now()) RETURNING id`,
    [`excluir-mvp-${Date.now()}-${Math.random().toString(36).slice(2)}@teste.com`],
  );
  try {
    await pool.query(
      `INSERT INTO exibicoes_contador (janela_hora, dispositivo_id, anunciante_id, vezes_programadas, vezes_confirmadas)
       VALUES (date_trunc('hour', now()), $1, $2, 4, 3)`,
      [comPop.id, conta.id],
    );
    const r = await app.chamar('DELETE', `/admin/dispositivos/${comPop.id}`);
    assert.equal(r.status, 409);
    assert.match(r.json.erro, /possui histórico de exibições e não pode ser excluída permanentemente/);
    assert.equal(await existe(comPop.id), true);
    const inativa = await app.chamar('PATCH', `/admin/dispositivos/${comPop.id}`, { corpo: { status: 'inativo' } });
    assert.equal(inativa.json.saude, 'inativa', 'o caminho é inativar');
  } finally {
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [conta.id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
  }
});

test('admin: fluxo antigo de instalação não existe mais (JSON, token longo, histórico técnico)', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  for (const [metodo, caminho] of [
    ['POST', `/admin/dispositivos/${tela.id}/preparar-player`],
    ['POST', `/admin/dispositivos/${tela.id}/provisionamento`],
    ['DELETE', `/admin/dispositivos/${tela.id}/provisionamento`],
    ['GET', `/admin/dispositivos/${tela.id}/eventos`],
  ]) {
    assert.equal((await app.chamar(metodo, caminho)).status, 404, `${metodo} ${caminho}`);
  }
  const velho = await app.chamar('POST', '/player/provisionar', {
    corpo: { tokenProvisionamento: 'tok_qualquer' },
    ip: ipDeTeste(),
  });
  assert.equal(velho.status, 400, 'token longo não é mais aceito');
});

// ---------------------------------------------------------------------------
// Config: margens + horário do ponto + PIN de saída global (§6)
// ---------------------------------------------------------------------------
const versaoDesejada = async (telaId) =>
  (await pool.query('SELECT config_versao_desejada AS v FROM dispositivos WHERE id = $1', [telaId])).rows[0].v;
const configDe = (p) => app.chamar('GET', `/player/${p.dispositivoId}/config`, { chave: p.chaveAparelho });
const SEMANA = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];

test('config: exatamente configVersion, margens, operacao e pinSaida — sem rotação, OTA, URL, PIN por tela', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const r = await configDe(p);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store', 'leva o PIN: nada de cache');
  assert.deepEqual(Object.keys(r.json).sort(), ['configVersion', 'margens', 'operacao', 'pinSaida']);
  assert.equal(r.json.configVersion, await versaoDesejada(tela.id));
  assert.deepEqual(r.json.margens, { superior: 0, direita: 0, inferior: 0, esquerda: 0 });
  assert.deepEqual(Object.keys(r.json.operacao).sort(), ['feriados', 'porDiaDaSemana', 'timezone']);
  assert.equal(r.json.pinSaida, await pinSaida.obter());
  for (const proibido of ['rotacao', 'update', 'baseUrl', 'pinPainel', 'versaoMinima', 'cache', 'regime']) {
    assert.ok(!r.texto.includes(proibido), `config não fala de ${proibido}`);
  }
});

test('config: margem muda a versão e chega na config; campo que não vai na config não muda a versão', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const v0 = await versaoDesejada(tela.id);

  const patch = (corpo) => app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo });
  assert.equal((await patch({ custo_equipamento: 900, meses_amortizacao: 24 })).status, 200);
  assert.equal(await versaoDesejada(tela.id), v0, 'equipamento não é config');
  // Horário, modo e fuso por tela não existem mais: ignorados, sem versão nova.
  await patch({ modo_horario: 'personalizado', horario_semanal: { seg: null }, timezone: 'America/Manaus' });
  assert.equal(await versaoDesejada(tela.id), v0);

  assert.equal((await patch({ margem_superior: 2.5, margem_esquerda: 1 })).status, 200);
  const r = await configDe(p);
  assert.equal(r.json.configVersion, v0 + 1);
  assert.deepEqual(r.json.margens, { superior: 2.5, direita: 0, inferior: 0, esquerda: 1 });
  assert.equal((await patch({ margem_direita: 10.5 })).status, 400, 'teto de 10 vmin por lado');
  assert.equal(await versaoDesejada(tela.id), v0 + 1);
});

test('config: toda tela segue o horário do ponto; mudar o horário sobe a versão de TODAS as telas dele', async () => {
  const semana9a18 = Object.fromEntries(SEMANA.map((d) => [d, { abre: '09:00', fecha: '18:00' }]));
  const pid = await novoPonto({ horario: { ...semana9a18, dom: null } });
  const outroPonto = await novoPonto();
  const [t1, t2, t3] = [await novaTela(pid), await novaTela(pid), await novaTela(outroPonto)];
  const p1 = await instalarPlayer(t1.id);
  const antes = { t1: await versaoDesejada(t1.id), t2: await versaoDesejada(t2.id), t3: await versaoDesejada(t3.id) };

  let r = await configDe(p1);
  assert.deepEqual(r.json.operacao.porDiaDaSemana.seg, [{ inicio: '09:00', fim: '18:00' }]);
  assert.deepEqual(r.json.operacao.porDiaDaSemana.dom, []);

  // Ponto passa a ser 24 h (00:00–24:00).
  const vinte4 = Object.fromEntries([...SEMANA, 'feriados'].map((d) => [d, { abre: '00:00', fecha: '24:00' }]));
  const pontosRepo = require('../src/pontos/repository');
  await pontosRepo.atualizar(pid, { horario_semanal: vinte4 });
  assert.equal(await versaoDesejada(t1.id), antes.t1 + 1);
  assert.equal(await versaoDesejada(t2.id), antes.t2 + 1, 'tela sem Player também');
  assert.equal(await versaoDesejada(t3.id), antes.t3, 'tela de outro ponto não muda');
  r = await configDe(p1);
  assert.equal(r.json.configVersion, antes.t1 + 1);
  for (const dia of SEMANA) assert.deepEqual(r.json.operacao.porDiaDaSemana[dia], [{ inicio: '00:00', fim: '24:00' }]);

  // Salvar o mesmo horário não sobe versão.
  await pontosRepo.atualizar(pid, { horario_semanal: vinte4 });
  assert.equal(await versaoDesejada(t1.id), antes.t1 + 1);

  // Ponto sem horário cadastrado = 24 h todos os dias, sem feriados especiais.
  const p3 = await instalarPlayer(t3.id);
  r = await configDe(p3);
  for (const dia of SEMANA) assert.deepEqual(r.json.operacao.porDiaDaSemana[dia], [{ inicio: '00:00', fim: '24:00' }]);
  assert.deepEqual(r.json.operacao.feriados, {});
});

test('PIN de saída: 4 a 8 dígitos, recusa óbvio; trocar sobe a versão de todas as telas; status nunca traz o número', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const anterior = await pinSaida.obter();
  const logs = [];
  const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a.join(' '));
  try {
    for (const ruim of ['123', '123456789', 'abcd', '12a4', '0000', '1111', '1234', '4321', '7890', 12, null]) {
      const r = await app.chamar('PUT', '/admin/player/pin-saida', { corpo: { pin: ruim } });
      assert.equal(r.status, 400, `PIN ${ruim}`);
    }
    const v0 = await versaoDesejada(tela.id);
    const r = await app.chamar('PUT', '/admin/player/pin-saida', { corpo: { pin: '90517' } });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json).sort(), ['alteradoEm', 'definido']);
    assert.equal(await versaoDesejada(tela.id), v0 + 1, 'PIN novo = config nova em todas as telas');

    const status = await app.chamar('GET', '/admin/player/pin-saida');
    assert.equal(status.json.definido, true);
    assert.ok(!status.texto.includes('90517'), 'status não mostra o PIN');
    const { rows } = await pool.query("SELECT valor FROM configuracoes_site WHERE chave = 'player_pin_saida'");
    assert.ok(!rows[0].valor.includes('90517'), 'nunca em claro no banco');

    const cfg = await configDe(p);
    assert.equal(cfg.json.pinSaida, '90517');
    assert.equal(cfg.json.configVersion, v0 + 1);

    const ver = await app.chamar('POST', '/admin/player/pin-saida/revelar');
    assert.equal(ver.status, 200);
    assert.equal(ver.json.pin, '90517');
    assert.equal(ver.headers.get('cache-control'), 'no-store');
    await require('../src/lib/eventos').aguardarGravacoes();
    const { rows: aud } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM eventos WHERE nome = 'player:pin_saida_revelado' AND criado_em > now() - interval '1 minute'",
    );
    assert.ok(aud[0].n >= 1, 'revelar fica registrado');
    assert.ok(!logs.some((l) => l.includes('90517')), 'PIN nunca no log');
  } finally {
    Object.assign(console, orig);
    await pinSaida.definir(anterior);
  }
});

test('PIN de saída: sem PIN definido, o admin não gera código de instalação (409), e /config manda null', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer((await novaTela(pid)).id);
  const obterReal = pinSaida.obter;
  pinSaida.obter = async () => null; // sem mexer no PIN global que outros arquivos usam
  try {
    const g = await gerarCodigo(tela.id);
    assert.equal(g.status, 409);
    assert.match(g.json.erro, /PIN de saída/);
    const cfg = await configDe(p);
    assert.equal(cfg.json.pinSaida, null, 'nunca um PIN padrão');
  } finally {
    pinSaida.obter = obterReal;
  }
  assert.equal((await gerarCodigo(tela.id)).status, 201);
});

test('PIN por tela não existe mais: rotas antigas somem', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}/pin`)).status, 404);
  assert.equal(
    (await app.chamar('POST', `/admin/dispositivos/${tela.id}/pin`, { corpo: { pin: '4821' } })).status,
    404,
  );
  const dono = await app.chamar('POST', `/anunciantes/1/dispositivos/${tela.id}/pin`, { corpo: { pin: '4821' } });
  assert.equal(dono.status, 404);
});
