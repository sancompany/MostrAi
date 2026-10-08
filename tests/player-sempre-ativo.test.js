const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const gerador = require('../src/playlist/gerador');
const { montarConfig } = require('../src/player/config');
const {
  subirApp,
  novoPonto,
  novaTela,
  instalarPlayer,
  tirarDoSorteio,
  garantirPinSaida,
  limparPontos,
} = require('./apoio-player');

// PLAYER SEMPRE ATIVO (08/10/2026, decisão do dono): TV ligada + Player
// saudável = reprodução contínua. O APK apagava fora do `config.operacao` (o
// horário do ponto, ou o do compromisso da tela móvel). Agora a config vai
// sempre com o dia inteiro; o horário segue no backend só como informação
// operacional/comercial — fora dele a TV toca (bônus), sem obrigação, sem
// "programada" e sem mexer no saldo.

const SEMANA = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
const DIA_INTEIRO = [{ inicio: '00:00', fim: '24:00' }];
const H = 3_600_000;
// Das 09:00 às 22:00 todos os dias, feriado igual (o dia da semana do CI não
// importa).
const NOVE_AS_22 = Object.fromEntries([...SEMANA, 'feriados'].map((d) => [d, { abre: '09:00', fecha: '22:00' }]));
// Fechado todos os dias, feriado também: "agora" está sempre fora do horário.
const SEMPRE_FECHADO = Object.fromEntries([...SEMANA, 'feriados'].map((d) => [d, null]));

let app;
const contas = [];

test.before(async () => {
  app = await subirApp();
  await garantirPinSaida();
});

test.after(async () => {
  await app.fechar();
  for (const id of contas) {
    await pool.query('DELETE FROM execucoes_confirmadas WHERE execucao_id LIKE $1', [`sempre-ativo-${id}-%`]);
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await limparPontos();
  await pool.end();
});

const configDe = (p) => app.chamar('GET', `/player/${p.dispositivoId}/config`, { chave: p.chaveAparelho });
const playlistDe = (p) => app.chamar('GET', `/playlist/${p.dispositivoId}`, { chave: p.chaveAparelho });
const tipoDoItem = (item) => item.itemProgramacaoId.split('|')[3];
const soFallback = (itens) => itens.every((i) => tipoDoItem(i) === 'inst' || tipoDoItem(i).startsWith('midia:'));

function assertDiaInteiro(operacao, rotulo) {
  for (const dia of SEMANA) assert.deepStrictEqual(operacao.porDiaDaSemana[dia], DIA_INTEIRO, `${rotulo}: ${dia}`);
  assert.deepStrictEqual(operacao.feriados, {}, `${rotulo}: feriados`);
}

// Hora `h` (local, Matão) de ONTEM — no passado, dentro do prazo do POP.
function ontemAs(h) {
  const hoje = new Date(Date.now() - 3 * H); // relógio de Matão (UTC−3)
  return new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate() - 1, h + 3));
}

// Conta com plano e peça aprovada, escolhendo SÓ este ponto (fora do sorteio).
async function contaNoPonto(pontoId) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Sempre ativo ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `sempre-ativo-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  contas.push(conta.id);
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [conta.id, pontoId]);
  await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m' });
  const c = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/sempre-ativo-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await criativosRepo.atualizar(c.id, { status: 'aprovado' });
  return conta.id;
}

async function telaInstalada(horario) {
  const pid = await novoPonto({ horario });
  await tirarDoSorteio(pid);
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  return { pid, tela, p };
}

test('config: com horário 09–22 (ou fechado o tempo todo) a TV recebe sempre o dia inteiro', async () => {
  for (const [rotulo, horario] of [
    ['09–22', NOVE_AS_22],
    ['sempre fechado', SEMPRE_FECHADO],
    ['sem horário', null],
  ]) {
    const { p } = await telaInstalada(horario);
    const r = await configDe(p);
    assert.strictEqual(r.status, 200, rotulo);
    assertDiaInteiro(r.json.operacao, rotulo);
  }
});

test('config: tela móvel com compromisso de horário restrito também recebe o dia inteiro', () => {
  // `ponto_horario_semanal` da tela móvel alocada é o horário do compromisso
  // (src/lib/contexto-do-ponto.js) — a config ignora, como no ponto fixo.
  const compromisso = Object.fromEntries(SEMANA.map((d) => [d, { abre: '18:00', fecha: '23:00' }]));
  const c = montarConfig({ config_versao_desejada: 3, ponto_horario_semanal: compromisso, ponto_tipo: 'movel' }, null);
  assert.strictEqual(c.configVersion, 3);
  assertDiaInteiro(c.operacao, 'compromisso 18–23');
});

test('antes, dentro e depois do horário: a playlist tem a campanha; só dentro dela nasce obrigação/programada', async () => {
  const { pid, tela } = await telaInstalada(NOVE_AS_22);
  const conta = await contaNoPonto(pid);
  const dispositivo = await dispositivosRepo.buscarComPonto(tela.id);
  for (const [rotulo, h, aberta] of [
    ['antes da abertura (06:00)', 6, false],
    ['dentro do horário (12:00)', 12, true],
    ['depois do fechamento (23:00)', 23, false],
  ]) {
    const hora = ontemAs(h);
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, hora, new Date(hora.getTime() + 5 * 60_000));
    assert.ok(envelope.itens.length > 0, `${rotulo}: há conteúdo`);
    assert.ok(
      envelope.itens.some((i) => i.anuncianteId === conta),
      `${rotulo}: a campanha elegível toca normalmente`,
    );
    const { rows } = await pool.query(
      'SELECT vezes_programadas FROM exibicoes_contador WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3',
      [conta, tela.id, hora],
    );
    if (aberta) assert.ok(rows[0]?.vezes_programadas > 0, `${rotulo}: hora aberta programa (obrigação normal)`);
    else assert.strictEqual(rows.length, 0, `${rotulo}: fora do horário é bônus — sem programada nem obrigação`);
  }
});

test('POP: dentro do horário contabiliza uma vez (idempotente); fora do horário não credita nada e não é erro', async () => {
  const { pid, tela, p } = await telaInstalada(NOVE_AS_22);
  const conta = await contaNoPonto(pid);
  const dispositivo = await dispositivosRepo.buscarComPonto(tela.id);
  const enviar = (eventos) =>
    app.chamar('POST', `/player/${p.dispositivoId}/played`, { chave: p.chaveAparelho, corpo: { eventos } });
  const evento = (envelope, execucaoId) => {
    const item = envelope.itens.find((i) => i.anuncianteId === conta);
    return {
      execucaoId,
      janelaId: envelope.janelaId,
      itemProgramacaoId: item.itemProgramacaoId,
      criativoId: String(item.criativoId),
      iniciadoEm: new Date().toISOString(),
      terminadoEm: new Date().toISOString(),
    };
  };

  const meioDia = ontemAs(12);
  const aberta = await gerador.gerarPlaylistDaHora(dispositivo, meioDia, new Date(meioDia.getTime() + 60_000));
  const e1 = evento(aberta, `sempre-ativo-${conta}-1`);
  let r = await enviar([e1]);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.resultados[0].status, 'contabilizado');
  r = await enviar([e1]);
  assert.strictEqual(r.json.resultados[0].status, 'duplicado', 'o mesmo POP duas vezes conta uma');

  const noite = ontemAs(23);
  const fechada = await gerador.gerarPlaylistDaHora(dispositivo, noite, new Date(noite.getTime() + 60_000));
  r = await enviar([evento(fechada, `sempre-ativo-${conta}-2`)]);
  assert.strictEqual(r.status, 200, 'POP fora do horário nunca é erro');
  assert.notStrictEqual(r.json.resultados[0].status, 'contabilizado', 'fora do horário não credita');
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(vezes_confirmadas), 0)::int AS n FROM exibicoes_contador WHERE anunciante_id = $1 AND janela_hora = $2',
    [conta, noite],
  );
  assert.strictEqual(rows[0].n, 0, 'nada confirmado na hora fechada');
});

test('sem mídia comercial elegível: a playlist tem conteúdo, todo de fallback (institucional/Mostraí)', async () => {
  const { p } = await telaInstalada(SEMPRE_FECHADO);
  const r = await playlistDe(p);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.versaoContrato, 2);
  assert.ok(r.json.itens.length > 0, 'a TV ligada sempre tem o que tocar');
  assert.ok(soFallback(r.json.itens), 'sem anunciante: só institucional/mídia Mostraí');
});

test('tela móvel sem compromisso: config do dia inteiro e playlist só institucional (sem local comercial falso)', async () => {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, cidade, uf, segmento, responsavel_nome, responsavel_contato, tipo, movel_numero)
     VALUES ('Mostraí Móvel', $1, 'SP', 'outro', 'Mostraí', '', 'movel', nextval('pontos_movel_numero_seq'))
     RETURNING id`,
    [`Cidade ${randomUUID().slice(0, 8)}`],
  );
  const pid = rows[0].id;
  const tela = await novaTela(pid);
  const p = await instalarPlayer(tela.id);
  try {
    assertDiaInteiro((await configDe(p)).json.operacao, 'móvel sem compromisso');
    const r = await playlistDe(p);
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.itens.length > 0);
    assert.ok(
      r.json.itens.every((i) => i.institucional && i.contabiliza === false && i.anuncianteId == null),
      'só institucional, nada contabiliza',
    );
  } finally {
    await pool.query('DELETE FROM execucoes_confirmadas WHERE dispositivo_id = $1', [tela.id]);
    await pool.query('DELETE FROM dispositivos WHERE id = $1', [tela.id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pid]);
  }
});

test('heartbeat fora do horário: 200, tela comunicando, "fora do horário" informativo — nunca problema', async () => {
  const { tela, p } = await telaInstalada(SEMPRE_FECHADO);
  const r = await app.chamar('POST', `/player/${p.dispositivoId}/heartbeat`, {
    chave: p.chaveAparelho,
    corpo: { estado: 'PLAYING' },
  });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.json).sort(), ['configVersion', 'playlist']);
  const ficha = (await app.chamar('GET', `/admin/dispositivos/${tela.id}`)).json;
  assert.strictEqual(ficha.saude, 'fora_do_horario', 'informação, não erro');
  assert.notStrictEqual(ficha.saude, 'com_problema');
  // A playlist continua saindo para a tela ligada fora do horário.
  const playlist = await playlistDe(p);
  assert.strictEqual(playlist.status, 200);
  assert.ok(playlist.json.itens.length > 0);
});
