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
const contasCriadas = [];
test.after(async () => {
  await app.fechar();
  await limparPontos();
  for (const id of contasCriadas) {
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM banco_horas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
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

// ---------------------------------------------------------------------------
// Heartbeat a cada 15 s (§5)
// ---------------------------------------------------------------------------
const bater = (p, corpo = {}, extra = {}) =>
  app.chamar('POST', `/player/${p.dispositivoId}/heartbeat`, { chave: p.chaveAparelho, corpo, ...extra });
const linhaDaTela = async (id) => (await pool.query('SELECT * FROM dispositivos WHERE id = $1', [id])).rows[0];

test('heartbeat: resposta é só {configVersion, playlist.atualizar}; corpo {} vale; não-objeto é 400', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const r = await bater(p, {});
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['configVersion', 'playlist']);
  assert.deepEqual(Object.keys(r.json.playlist), ['atualizar']);
  assert.equal(typeof r.json.playlist.atualizar, 'boolean');
  assert.equal(r.json.configVersion, await versaoDesejada(tela.id));
  for (const proibido of ['margens', 'novaChave', 'update', 'servidorAgora', 'ok']) {
    assert.ok(!(proibido in r.json), `sem ${proibido}`);
  }
  assert.equal((await bater(p, undefined, { cru: '[1,2]' })).status, 400);
  assert.equal((await bater(p, undefined, { cru: '"texto"' })).status, 400);
  assert.equal((await bater(p, undefined, { cru: '{quebrado' })).status, 400);
  assert.equal((await bater({ ...p, chaveAparelho: 'x'.repeat(43) })).status, 401);
});

test('heartbeat: snapshot do estado, fila, erro e config aplicada; versão só pelo header; tipo errado ignorado', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const desejada = await versaoDesejada(tela.id);

  await bater(
    p,
    {
      estado: 'PLAYING',
      configVersionAplicada: desejada,
      criativoId: '123',
      erro: null,
      fila: { pendentes: 4, maisAntigoEm: new Date(Date.now() - 60000).toISOString() },
      versaoApp: '9.9.9',
      buildNumber: 999,
    },
    { versao: '1.4.0+21' },
  );
  let t = await linhaDaTela(tela.id);
  assert.equal(t.player_estado, 'PLAYING');
  assert.equal(t.criativo_atual, '123');
  assert.equal(t.fila_pendentes, 4);
  assert.equal(t.config_versao_aplicada, desejada);
  assert.equal(t.player_versao, '1.4.0', 'versão vem do header, não do corpo');
  assert.equal(t.player_build, 21);
  assert.equal(await eventosDe(tela.id, 'CONFIG_APPLIED'), 1);

  // Mesma config de novo: nenhuma transição nova.
  await bater(p, { estado: 'PLAYING', configVersionAplicada: desejada });
  assert.equal(await eventosDe(tela.id, 'CONFIG_APPLIED'), 1);

  // Tipos errados: ignorados um a um, o resto vale.
  const r = await bater(p, { estado: 42, configVersionAplicada: 'sete', fila: { pendentes: -1 }, erro: 'texto' });
  assert.equal(r.status, 200);
  t = await linhaDaTela(tela.id);
  assert.equal(t.player_estado, null, 'estado inválido = não informado');
  assert.equal(t.config_versao_aplicada, desejada, 'versão inválida não mexe');
  assert.equal(t.fila_pendentes, 4, 'fila inválida não mexe');
  assert.equal(t.ultimo_erro_codigo, null, 'erro que não é objeto é ignorado');

  // Erro começa, muda de código e termina: uma transição por mudança.
  await bater(p, { estado: 'PLAYBACK_ERROR', erro: { codigo: 'PLAYBACK_FALHOU', mensagem: 'x\u0007y' } });
  t = await linhaDaTela(tela.id);
  assert.equal(t.ultimo_erro, 'x y', 'caractere de controle sai');
  await bater(p, { estado: 'PLAYBACK_ERROR', erro: { codigo: 'PLAYBACK_FALHOU', mensagem: 'x' } });
  assert.equal(await eventosDe(tela.id, 'ERROR_STARTED'), 1, 'mesmo código = mesma transição');
  const admin = await app.chamar('GET', `/admin/dispositivos/${tela.id}`);
  assert.equal(admin.json.saude, 'erro_do_player');
  await bater(p, { estado: 'PLAYING', erro: null });
  assert.equal(await eventosDe(tela.id, 'ERROR_RESOLVED'), 1);
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json.saude, 'operando');

  await bater(p, { estado: 'OUT_OF_SCHEDULE' });
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json.saude, 'fora_do_horario');
});

test('heartbeat: tela em reparo continua batendo (nunca 403); "Sem sinal" depois de 2 min', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { status: 'reparo' } });
  assert.equal((await bater(p, { estado: 'IDLE' })).status, 200);
  assert.equal((await app.chamar('GET', `/player/${p.dispositivoId}/config`, { chave: p.chaveAparelho })).status, 200);
  await app.chamar('PATCH', `/admin/dispositivos/${tela.id}`, { corpo: { status: 'ativo' } });

  await pool.query("UPDATE dispositivos SET ultima_vez_online = now() - interval '90 seconds' WHERE id = $1", [
    tela.id,
  ]);
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json.saude, 'operando');
  await pool.query("UPDATE dispositivos SET ultima_vez_online = now() - interval '3 minutes' WHERE id = $1", [tela.id]);
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json.saude, 'sem_sinal');
  await bater(p, { estado: 'PLAYING' });
  assert.equal(await eventosDe(tela.id, 'OFFLINE'), 1);
  assert.equal(await eventosDe(tela.id, 'ONLINE'), 1);
  assert.equal((await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json.saude, 'operando');
});

test('heartbeat: playlist.atualizar vem UMA vez por mudança', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  await bater(p); // consome qualquer marca da instalação
  await pool.query('UPDATE dispositivos SET playlist_desatualizada_em = now() WHERE id = $1', [tela.id]);
  assert.equal((await bater(p)).json.playlist.atualizar, true);
  assert.equal((await bater(p)).json.playlist.atualizar, false);
});

test('heartbeat: 15 s não esbarra em limite — 40 batidas seguidas da mesma origem, todas 200', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const ip = ipDeTeste();
  for (let i = 0; i < 40; i++) {
    const r = await bater(p, { estado: 'PLAYING' }, { ip });
    assert.equal(r.status, 200, `batida ${i + 1}`);
  }
  // Nenhuma linha de histórico por batida (só transições).
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM tela_eventos WHERE dispositivo_id = $1', [tela.id]);
  assert.ok(rows[0].n <= 5, `histórico só de transições (${rows[0].n})`);
});

for (const quantas of [1, 10, 50]) {
  test(`heartbeat: ${quantas} tela(s) batendo juntas por 1 minuto simulado (4 rodadas)`, async () => {
    const pid = await novoPonto();
    const players = [];
    for (let i = 0; i < quantas; i++) {
      const tela = await novaTela(pid);
      players.push({ ...(await instalarPlayer(tela.id)), telaId: tela.id, ip: ipDeTeste() });
    }
    const tempos = [];
    for (let rodada = 0; rodada < 4; rodada++) {
      const respostas = await Promise.all(
        players.map(async (p) => {
          const inicio = performance.now();
          const r = await bater(
            p,
            {
              estado: 'PLAYING',
              configVersionAplicada: await versaoDesejada(p.telaId),
              criativoId: String(rodada),
              erro: null,
              fila: { pendentes: rodada, maisAntigoEm: null },
            },
            { ip: p.ip },
          );
          tempos.push(performance.now() - inicio);
          return r.status;
        }),
      );
      assert.deepEqual([...new Set(respostas)], [200], `rodada ${rodada + 1}`);
    }
    tempos.sort((a, b) => a - b);
    const p95 = tempos[Math.floor(tempos.length * 0.95) - 1] ?? tempos[0];
    // Folga generosa para CI: o que se mede é "não trava nem enfileira".
    assert.ok(p95 < 2000, `p95 ${Math.round(p95)} ms`);
    const { rows } = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE ultima_vez_online > now() - interval '1 minute')::int AS vivas,
              COUNT(*) FILTER (WHERE fila_pendentes = 3 AND criativo_atual = '3')::int AS ultima_rodada
         FROM dispositivos WHERE ponto_id = $1`,
      [pid],
    );
    assert.equal(rows[0].vivas, quantas);
    assert.equal(rows[0].ultima_rodada, quantas, 'o snapshot é o da última batida');
  });
}

// ---------------------------------------------------------------------------
// Proof-of-play offline: até 7 dias depois do fim da janela (§8)
// ---------------------------------------------------------------------------
const { randomUUID } = require('node:crypto');
const gerador = require('../src/playlist/gerador');

async function novaConta() {
  const anunciantesRepo = require('../src/anunciantes/repository');
  const conta = await anunciantesRepo.criar({
    nome_empresa: `PMVP POP ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `pmvp-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  contasCriadas.push(conta.id);
  return conta.id;
}

const horaCheia = (ms) => new Date(Math.floor(ms / 3_600_000) * 3_600_000);

// Hora servida à tela: linha do contador (o que foi prometido) + playlist
// congelada (quem estava nela). É o que o gerador grava de verdade.
async function horaServida(telaId, contaId, hora, { programadas = 3, banco = 0, confirmadas = 0 } = {}) {
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco, vezes_confirmadas)
     VALUES ($1, $2, $3, $4::int, $4::int - $5::int, $5::int, $6::int)`,
    [contaId, telaId, hora, programadas, banco, confirmadas],
  );
  await pool.query(
    `INSERT INTO playlist_hora_congelada (dispositivo_id, janela_hora, base, extras)
     VALUES ($1, $2, $3::jsonb, '[]'::jsonb)
     ON CONFLICT (dispositivo_id, janela_hora) DO UPDATE SET base = playlist_hora_congelada.base || EXCLUDED.base`,
    [telaId, hora, JSON.stringify([{ id: contaId }])],
  );
  const janelaId = `${telaId}|${hora.toISOString()}`;
  return { janelaId, item: (indice = 0, tipo = contaId) => `${janelaId}|${indice}|${tipo}` };
}

const evento = (janelaId, itemProgramacaoId, extra = {}) => ({
  execucaoId: randomUUID(),
  janelaId,
  itemProgramacaoId,
  criativoId: '1',
  iniciadoEm: new Date().toISOString(),
  terminadoEm: new Date().toISOString(),
  ...extra,
});
const enviar = (p, eventos, extra = {}) =>
  app.chamar('POST', `/player/${p.dispositivoId}/played`, { chave: p.chaveAparelho, corpo: { eventos }, ...extra });
const confirmadas = async (telaId, hora, contaId) =>
  (
    await pool.query(
      'SELECT vezes_confirmadas AS n FROM exibicoes_contador WHERE dispositivo_id = $1 AND janela_hora = $2 AND anunciante_id = $3',
      [telaId, hora, contaId],
    )
  ).rows[0].n;

test('POP: atraso desde o fim da janela — imediato até 7 dias conta; passou de 7 dias expira', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const conta = await novaConta();
  const MIN = 60_000;
  const casos = [
    ['imediato', 0, 'contabilizado'],
    ['30 min', 30 * MIN, 'contabilizado'],
    ['74 min', 74 * MIN, 'contabilizado'],
    ['2 h', 120 * MIN, 'contabilizado'],
    ['8 h', 8 * 60 * MIN, 'contabilizado'],
    ['24 h', 24 * 60 * MIN, 'contabilizado'],
    ['6 dias', 6 * 1440 * MIN, 'contabilizado'],
    ['> 7 dias', 7 * 1440 * MIN + 60 * MIN, 'janela_expirada'],
    ['30 dias', 30 * 1440 * MIN, 'janela_expirada'],
  ];
  for (const [nome, atraso, esperado] of casos) {
    // Janela que TERMINOU há `atraso` (hora cheia anterior a isso). Conta
    // própria por caso: dois atrasos podem cair na mesma hora cheia.
    const contaDoCaso = await novaConta();
    const hora = horaCheia(Date.now() - atraso - 60 * MIN);
    const h = await horaServida(tela.id, contaDoCaso, hora);
    const r = await enviar(p, [evento(h.janelaId, h.item())]);
    assert.equal(r.status, 200, nome);
    assert.equal(r.json.resultados[0].status, esperado, nome);
    assert.equal(await confirmadas(tela.id, hora, contaDoCaso), esperado === 'contabilizado' ? 1 : 0, nome);
  }
  // Limite: a última hora do 7º dia ainda vale.
  const limite = horaCheia(Date.now() - 7 * 1440 * MIN);
  const h = await horaServida(tela.id, conta, limite);
  assert.equal((await enviar(p, [evento(h.janelaId, h.item())])).json.resultados[0].status, 'contabilizado', '7 dias');
  // Janela futura = relógio adulterado.
  const futura = horaCheia(Date.now() + 2 * 60 * MIN);
  const f = await horaServida(tela.id, conta, futura);
  assert.equal((await enviar(p, [evento(f.janelaId, f.item())])).json.resultados[0].status, 'janela_expirada');
});

test('POP: virada de dia, de mês e de ano não muda nada — só o tempo desde o fim da janela', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const conta = await novaConta();
  const casos = [
    ['virada de dia', '2026-03-10T23:00:00-03:00', '2026-03-11T00:20:00-03:00', 'contabilizado'],
    ['virada de mês', '2026-01-31T23:00:00-03:00', '2026-02-06T10:00:00-03:00', 'contabilizado'],
    ['virada de ano, 7 dias menos 30 min', '2026-12-31T23:00:00-03:00', '2027-01-07T23:30:00-03:00', 'contabilizado'],
    ['virada de ano, 7 dias e 1 min', '2026-12-31T23:00:00-03:00', '2027-01-08T00:01:00-03:00', 'janela_expirada'],
  ];
  for (const [nome, inicio, chegada, esperado] of casos) {
    const hora = new Date(inicio);
    await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1 AND janela_hora = $2', [tela.id, hora]);
    const h = await horaServida(tela.id, conta, hora);
    const status = await gerador.confirmarExecucao(tela.id, h.item(), h.janelaId, new Date(chegada));
    assert.equal(status, esperado, nome);
  }
});

test('POP: duplicata, UUID repetido em outra tela, outra tela, item fora da hora congelada, outra janela, teto', async () => {
  const pid = await novoPonto();
  const [ta, tb] = [await novaTela(pid), await novaTela(pid)];
  const [pa, pb] = [await instalarPlayer(ta.id), await instalarPlayer(tb.id)];
  const conta = await novaConta();
  const outraConta = await novaConta();
  const hora = horaCheia(Date.now() - 3 * 3_600_000);
  const ha = await horaServida(ta.id, conta, hora, { programadas: 2 });
  const hb = await horaServida(tb.id, conta, hora, { programadas: 2 });

  // Mesmo execucaoId: retentativa noutro lote e repetido no mesmo lote.
  const e1 = evento(ha.janelaId, ha.item(0));
  let r = await enviar(pa, [e1, { ...e1 }]);
  assert.deepEqual(
    r.json.resultados.map((x) => x.status),
    ['contabilizado', 'duplicado'],
  );
  r = await enviar(pa, [e1]);
  assert.equal(r.json.resultados[0].status, 'duplicado');
  assert.equal(await confirmadas(ta.id, hora, conta), 1);

  // UUID repetido vindo de OUTRA tela (com item válido dela): não conta.
  r = await enviar(pb, [{ ...evento(hb.janelaId, hb.item(0)), execucaoId: e1.execucaoId }]);
  assert.equal(r.json.resultados[0].status, 'duplicado');
  assert.equal(await confirmadas(tb.id, hora, conta), 0);

  // Janela/item de outra tela mandado pela tela A.
  r = await enviar(pa, [evento(hb.janelaId, hb.item(0))]);
  assert.equal(r.json.resultados[0].status, 'janela_desconhecida');
  assert.equal(await confirmadas(tb.id, hora, conta), 0);

  // Anunciante que não estava na hora congelada (mesmo com linha no contador).
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas) VALUES ($1, $2, $3, 5)`,
    [outraConta, ta.id, hora],
  );
  r = await enviar(pa, [evento(ha.janelaId, ha.item(1, outraConta)), evento(ha.janelaId, ha.item(1, 2147480000))]);
  assert.deepEqual(
    r.json.resultados.map((x) => x.status),
    ['janela_desconhecida', 'janela_desconhecida'],
  );

  // Hora sem playlist servida (nunca congelou) e item de outra janela.
  const semPlaylist = horaCheia(Date.now() - 5 * 3_600_000);
  const jSem = `${ta.id}|${semPlaylist.toISOString()}`;
  const outraHora = horaCheia(Date.now() - 4 * 3_600_000).toISOString();
  r = await enviar(pa, [evento(jSem, `${jSem}|0|${conta}`), evento(ha.janelaId, `${ta.id}|${outraHora}|0|${conta}`)]);
  assert.deepEqual(
    r.json.resultados.map((x) => x.status),
    ['janela_desconhecida', 'item_invalido'],
  );

  // Teto: 2 programadas; a 2ª conta, a 3ª não.
  r = await enviar(pa, [evento(ha.janelaId, ha.item(2)), evento(ha.janelaId, ha.item(3))]);
  assert.deepEqual(
    r.json.resultados.map((x) => x.status),
    ['contabilizado', 'teto_atingido'],
  );
  assert.equal(await confirmadas(ta.id, hora, conta), 2);
});

test('POP: payload adulterado vira item_invalido, um a um, sem derrubar o lote', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const conta = await novaConta();
  const hora = horaCheia(Date.now() - 2 * 3_600_000);
  const h = await horaServida(tela.id, conta, hora, { programadas: 10 });
  const iso = hora.toISOString();
  const semMs = iso.replace('.000Z', 'Z');
  const meiaHora = new Date(hora.getTime() + 30 * 60_000).toISOString();
  const adulterados = [
    evento(h.janelaId, `${h.janelaId}|0|inst`),
    evento(h.janelaId, `${h.janelaId}|0|dono`),
    evento(h.janelaId, `${h.janelaId}|0|midia:3`),
    evento(h.janelaId, `${h.janelaId}|-1|${conta}`),
    evento(h.janelaId, `${h.janelaId}|x|${conta}`),
    evento(h.janelaId, `${h.janelaId}|0|${conta}|extra`),
    evento(h.janelaId, `${h.janelaId}|0|99999999999`),
    evento(h.janelaId, `${h.janelaId}|0|0`),
    evento(`${tela.id}|${semMs}`, `${tela.id}|${semMs}|0|${conta}`),
    evento(`${tela.id}|${meiaHora}`, `${tela.id}|${meiaHora}|0|${conta}`),
    evento(`${tela.id}|lixo`, `${tela.id}|lixo|0|${conta}`),
    evento(h.janelaId, `${h.janelaId}|0|${conta}`, { janelaId: `${h.janelaId} ` }),
    evento(h.janelaId, ''),
    evento('', h.item()),
    evento(h.janelaId, 42),
    evento(h.janelaId, h.item(), { janelaId: ['x'] }),
    evento(h.janelaId, h.item(), { execucaoId: 'a\u0000b' }),
    evento(h.janelaId, h.item(), { execucaoId: 'x'.repeat(101) }),
    evento(h.janelaId, h.item(), { execucaoId: 'com espaço' }),
    evento(h.janelaId, h.item(), { itemProgramacaoId: 'y'.repeat(201) }),
  ];
  const valido = evento(h.janelaId, h.item(5));
  const r = await enviar(p, [...adulterados, valido]);
  assert.equal(r.status, 200);
  const status = r.json.resultados.map((x) => x.status);
  assert.equal(status.length, adulterados.length + 1, 'um resultado por evento com execucaoId');
  assert.deepEqual(status.slice(0, -1), Array(adulterados.length).fill('item_invalido'));
  assert.equal(status.at(-1), 'contabilizado', 'o evento bom do mesmo lote conta');
  assert.equal(await confirmadas(tela.id, hora, conta), 1);
});

test('POP: /played inválido nunca é 500 — lote malformado é 400, grande demais 413, sem execucaoId fica sem resposta', async () => {
  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const played = (extra) =>
    app.chamar('POST', `/player/${p.dispositivoId}/played`, { chave: p.chaveAparelho, ...extra });
  for (const cru of [
    '[]',
    '"x"',
    '1',
    'null',
    '{quebrado',
    '{"eventos":"x"}',
    '{"eventos":{}}',
    '{"anuncianteId":1}',
    '{}',
  ]) {
    const r = await played({ cru });
    assert.equal(r.status, 400, `corpo ${cru}`);
  }
  const muitos = Array.from({ length: 501 }, () => ({ execucaoId: 'a' }));
  assert.equal((await played({ corpo: { eventos: muitos } })).status, 400, 'mais de 500');
  const grande = [{ execucaoId: randomUUID(), janelaId: 'j'.repeat(150_000), itemProgramacaoId: 'x' }];
  assert.equal((await played({ corpo: { eventos: grande } })).status, 413, 'corpo > 100 KB');

  const semId = [
    null,
    1,
    'x',
    [],
    {},
    { execucaoId: '' },
    { execucaoId: '   ' },
    { execucaoId: 7 },
    { execucaoId: null },
  ];
  const r = await played({ corpo: { eventos: semId } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.resultados, [], 'sem execucaoId não há como responder');
  const vazio = await played({ corpo: { eventos: [] } });
  assert.deepEqual(vazio.json, { resultados: [] });
});

test('POP x banco de horas: hora que ainda aceita POP não liquida; hora liquidada não aceita mais POP', async () => {
  const apuracao = require('../src/bancohoras/apuracao');
  assert.equal(apuracao.MINUTOS_ATE_A_HORA_FECHAR, gerador.PRAZO_PROOF_OF_PLAY_MIN, 'mesmo prazo');
  assert.equal(gerador.PRAZO_PROOF_OF_PLAY_MIN, 60 + 7 * 24 * 60);

  const pid = await novoPonto();
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  const conta = await novaConta();
  const bancoHorasRepo = require('../src/bancohoras/repository');
  const mesPassado = new Date();
  mesPassado.setMonth(mesPassado.getMonth() - 1, 1);
  await bancoHorasRepo.registrarDeficit({
    anuncianteId: conta,
    mesReferencia: mesPassado.toISOString().slice(0, 10),
    exibicoesPedidas: 10,
    exibicoesEntregues: 0,
  });

  // Hora de 6 dias atrás: 2 programadas, as 2 do banco, nenhuma confirmada.
  const seisDias = horaCheia(Date.now() - 6 * 24 * 3_600_000);
  const h6 = await horaServida(tela.id, conta, seisDias, { programadas: 2, banco: 2 });
  let liq = await apuracao.liquidarBancoConfirmado({ apenasContas: [conta] });
  assert.equal(liq.linhas, 0, 'ainda dentro do prazo do POP: não liquida');
  assert.equal(await bancoHorasRepo.saldoAtivoDoAnunciante(conta), 10);

  // A TV volta e manda os dois POPs atrasados: contam.
  const r = await enviar(p, [evento(h6.janelaId, h6.item(0)), evento(h6.janelaId, h6.item(1))]);
  assert.deepEqual(
    r.json.resultados.map((x) => x.status),
    ['contabilizado', 'contabilizado'],
  );

  // Hora de 8 dias atrás: prazo vencido — liquida uma vez e não aceita POP.
  const oitoDias = horaCheia(Date.now() - 8 * 24 * 3_600_000);
  const h8 = await horaServida(tela.id, conta, oitoDias, { programadas: 2, banco: 2, confirmadas: 1 });
  liq = await apuracao.liquidarBancoConfirmado({ apenasContas: [conta] });
  assert.equal(liq.linhas, 1);
  assert.equal(liq.exibicoesAbatidas, 1);
  assert.equal(await bancoHorasRepo.saldoAtivoDoAnunciante(conta), 9);
  const tarde = await enviar(p, [evento(h8.janelaId, h8.item(1))]);
  assert.equal(tarde.json.resultados[0].status, 'janela_expirada');
  assert.equal(await confirmadas(tela.id, oitoDias, conta), 1, 'hora liquidada não muda');
  assert.equal(
    (await apuracao.liquidarBancoConfirmado({ apenasContas: [conta] })).linhas,
    0,
    'nada liquida duas vezes',
  );
  assert.equal(await bancoHorasRepo.saldoAtivoDoAnunciante(conta), 9);
});
