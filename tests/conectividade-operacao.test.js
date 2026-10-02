const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');
const app = require('../src/server');
const { meusPontosDaConta } = require('../src/pontos/meus-pontos');
const { sincronizarStatusPonto } = require('../src/pontos/repository');
const { situacaoComercialDoPonto, estadoDaTela } = require('../src/lib/status-tela');
const { instalarPlayer } = require('./apoio-player');

// CONECTIVIDADE NÃO É OPERAÇÃO (02/10/2026, Ponto Móvel). Heartbeat vencido
// diz só "sem comunicação"; a operação de agora fica DESCONHECIDA — nunca
// desligada, fora do ar, erro nem inativa. Cada perfil lê o que é seu:
// anunciante só o comercial, dono um aviso neutro, Admin os eixos separados
// e o que a TV contou que operou offline (sessões operacionais).

const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const SENHA = 'Senha12@teste';
const criadas = { contas: [], pontos: [] };
let base;
let servidor;
let admin;

function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo, headers = {}) {
    const cookie = [...potes.entries()]
      .filter(([, c]) => caminho.startsWith(c.path))
      .map(([nome, c]) => `${nome}=${c.valor}`)
      .join('; ');
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': IP,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const path = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor: resto.join('='), path });
    }
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { status: r.status, json, texto };
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
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criadas.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  for (const id of criadas.contas) {
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.query("DELETE FROM tentativas_acesso WHERE chave LIKE '10.%'");
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// ---------- fixtures ----------
async function novaConta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, logradouro, numero, bairro, endereco, cidade, uf, cep)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true,
             'Rua das Flores', '10', 'Centro', 'Rua das Flores, 10', 'Matão', 'SP', '15990000')
     RETURNING *`,
    [
      `Conect ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `conect-${randomUUID()}@example.com`,
      await gerarHash(SENHA),
    ],
  );
  criadas.contas.push(rows[0].id);
  return rows[0];
}

async function entrar(conta) {
  const nav = navegador();
  const r = await nav('POST', '/anunciantes/login', { email: conta.contato_email, senha: SENHA });
  assert.strictEqual(r.status, 200, `login da conta ${conta.id}`);
  return nav;
}

// Ponto do dono, sem horário (deveria operar a qualquer hora), uma tela
// instalada pelo caminho da TV, e um anunciante que já passou nela.
async function cenario() {
  const dono = await novaConta();
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2) RETURNING id`,
    [`Conect ${randomUUID().slice(0, 8)}`, dono.id],
  );
  const pontoId = rows[0].id;
  criadas.pontos.push(pontoId);
  // Fora do sorteio automático: outros arquivos de teste rodam em paralelo.
  await pool.query('UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = $1', [pontoId]);
  const { rows: telas } = await pool.query(
    `INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela', 'ativo') RETURNING id`,
    [pontoId],
  );
  const telaId = telas[0].id;
  const player = await instalarPlayer(telaId);
  const anunciante = await novaConta();
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
     VALUES ($1, $2, date_trunc('hour', now()) - interval '1 hour', 1, 1, 1)`,
    [anunciante.id, telaId],
  );
  const doPlayer = navegador();
  const tela = {
    pontoId,
    telaId,
    dono,
    anunciante,
    player,
    // Requisição como a TV.
    chamar: (metodo, rota, corpo) =>
      doPlayer(metodo, `/player/${player.dispositivoId}/${rota}`, corpo, {
        'x-aparelho-key': player.chaveAparelho,
        'x-player-version': '2.1.0+5',
      }),
  };
  const r = await tela.chamar('POST', 'heartbeat', { estado: 'PLAYING' });
  assert.strictEqual(r.status, 200, r.texto);
  await sincronizarStatusPonto(pontoId);
  return tela;
}

const silenciar = (telaId, intervalo = '3 hours') =>
  pool.query(`UPDATE dispositivos SET ultima_vez_online = now() - $2::interval WHERE id = $1`, [telaId, intervalo]);
const fichaAdmin = async (telaId) => (await admin('GET', `/admin/dispositivos/${telaId}`)).json;
async function situacaoDoAnunciante(c) {
  const nav = await entrar(c.anunciante);
  const r = await nav('GET', `/anunciantes/${c.anunciante.id}/exibicoes`);
  assert.strictEqual(r.status, 200, r.texto);
  return r.json.porPonto.find((p) => p.id === c.pontoId);
}
async function telaDoDono(c) {
  const estab = (await meusPontosDaConta(c.dono.id)).find((e) => e.tipo === 'ponto' && e.id === c.pontoId);
  return { estab, tela: estab.telas[0] };
}

// Sessão operacional como o Player manda (app OperacaoJson.corpo).
function sessao({ id = randomUUID(), inicio, fim, encerrada = true, motivo = 'parou', boot = 7, uptime0 = 1000 }) {
  const duracao = fim.getTime() - inicio.getTime();
  return {
    sessaoId: id,
    bootCount: boot,
    inicioUptimeMs: uptime0,
    fimUptimeMs: uptime0 + duracao,
    duracaoMs: duracao,
    inicioEm: inicio.toISOString(),
    fimEm: fim.toISOString(),
    inicioServidorEm: inicio.toISOString(),
    fimServidorEm: fim.toISOString(),
    encerrada,
    motivo: encerrada ? motivo : null,
  };
}
const horasAtras = (h) => new Date(Date.now() - h * 3600 * 1000);

// ---------------------------------------------------------------------------

test('heartbeat recente + operando: conectada e operando para o Admin, no ar para o anunciante', async () => {
  const c = await cenario();
  const t = await fichaAdmin(c.telaId);
  assert.strictEqual(t.saude, 'operando');
  assert.strictEqual(t.conectividade, 'conectada');
  assert.strictEqual(t.operacao, 'operando');
  assert.deepStrictEqual(t.alertas, []);
  assert.strictEqual((await situacaoDoAnunciante(c)).situacao, 'no_ar');
  assert.strictEqual((await telaDoDono(c)).tela.situacao, 'operando');
});

test('heartbeat vencido com a TV exibindo offline: sem comunicação, operação desconhecida, segue no ar', async () => {
  const c = await cenario();
  // A TV mandou a sessão aberta (checkpoint) e depois perdeu a internet: o
  // pacote offline dela segue válido e ela continua exibindo.
  const aberta = sessao({ inicio: horasAtras(4), fim: horasAtras(3), encerrada: false });
  assert.strictEqual((await c.chamar('POST', 'operacao', { sessoes: [aberta] })).status, 200);
  await silenciar(c.telaId);

  const t = await fichaAdmin(c.telaId);
  assert.strictEqual(t.conectividade, 'sem_comunicacao');
  assert.strictEqual(t.operacao, 'desconhecida', 'sem comunicação o servidor não sabe a operação — não é "parada"');
  assert.strictEqual(t.saude, 'sem_comunicacao');
  assert.ok(t.operacaoConhecida.ultimaEm, 'última operação conhecida = o último checkpoint');
  assert.strictEqual((await situacaoDoAnunciante(c)).situacao, 'no_ar', 'a tela segue exibindo a programação guardada');
});

test('heartbeat vencido não é desligada: estado administrativo e cadastro intactos', async () => {
  const c = await cenario();
  await silenciar(c.telaId, '5 days');
  const { rows } = await pool.query('SELECT status FROM dispositivos WHERE id = $1', [c.telaId]);
  assert.strictEqual(rows[0].status, 'ativo');
  const t = await fichaAdmin(c.telaId);
  assert.notStrictEqual(t.saude, 'inativa');
  assert.strictEqual(t.status, 'ativo');
  const e = estadoDaTela({ status: 'ativo', chave_hash: 'h', ultima_vez_online: horasAtras(120) }, null);
  assert.deepStrictEqual(e, {
    administrativo: 'ativa',
    instalacao: 'instalada',
    conectividade: 'sem_comunicacao',
    operacao: 'desconhecida',
  });
});

test('heartbeat vencido não tira o ponto da rede (pontos.status não muda por sinal)', async () => {
  const c = await cenario();
  const statusDoPonto = async () =>
    (await pool.query('SELECT status FROM pontos WHERE id = $1', [c.pontoId])).rows[0].status;
  assert.strictEqual(await statusDoPonto(), 'em_operacao');
  await silenciar(c.telaId, '10 days');
  await sincronizarStatusPonto(c.pontoId);
  assert.strictEqual(await statusDoPonto(), 'em_operacao', 'sem comunicação não é inativo');
});

test('anunciante não recebe estado técnico: nem sinal, nem comunicação, nem erro', async () => {
  const c = await cenario();
  await silenciar(c.telaId);
  await pool.query(`UPDATE dispositivos SET ultimo_erro = 'stack trace cru', ultimo_erro_codigo = 'X' WHERE id = $1`, [
    c.telaId,
  ]);
  const nav = await entrar(c.anunciante);
  const r = await nav('GET', `/anunciantes/${c.anunciante.id}/exibicoes`);
  const ponto = r.json.porPonto.find((p) => p.id === c.pontoId);
  assert.deepStrictEqual(Object.keys(ponto).sort(), ['cidade', 'confirmadas', 'id', 'nome', 'programadas', 'situacao']);
  for (const proibido of ['ultima_vez_online', 'sem_comunicacao', 'heartbeat', 'stack trace', 'desconhecida']) {
    assert.ok(!r.texto.includes(proibido), `vazou para o anunciante: ${proibido}`);
  }
  assert.strictEqual(ponto.situacao, 'no_ar', 'erro antigo sem comunicação não descreve o agora');
});

test('dono não recebe falso "fora do ar": aviso neutro, sem alerta', async () => {
  const c = await cenario();
  await silenciar(c.telaId);
  const { estab, tela } = await telaDoDono(c);
  assert.strictEqual(tela.situacao, 'sem_comunicacao');
  assert.strictEqual(tela.nivel, 'neutro');
  assert.strictEqual(tela.alerta, false);
  assert.strictEqual(estab.alertas, 0);
  assert.strictEqual(estab.estado, 'ativo', 'o estabelecimento continua ativo');
  assert.match(tela.situacaoTexto, /^Sem comunicação com a Mostraí/);
  assert.doesNotMatch(tela.situacaoTexto, /fora do ar|desligad|parad|problema|erro/i);
});

test('Admin vê "sem comunicação" como atenção, separado de erro', async () => {
  const c = await cenario();
  await silenciar(c.telaId);
  const t = await fichaAdmin(c.telaId);
  assert.deepStrictEqual(t.alertas, [{ codigo: 'SEM_COMUNICACAO', nivel: 'atencao' }]);
  const resumo = (await admin('GET', '/admin/resumo')).json;
  assert.ok(resumo.filas.telasSemComunicacao >= 1);
  assert.strictEqual('offline' in resumo.filas, false, 'a fila única "offline" misturava comunicação e operação');
  const telas = (await admin('GET', `/admin/pontos/${c.pontoId}/dispositivos`)).json;
  assert.strictEqual(telas.find((x) => x.id === c.telaId).conectividade, 'sem_comunicacao');
});

test('reconexão traz as sessões operacionais que comprovam a operação offline', async () => {
  const c = await cenario();
  // A TV ficou 10 h sem internet exibindo; reiniciou no meio (sessão
  // interrompida, outro boot) e só agora reconectou.
  const antes = sessao({ inicio: horasAtras(12), fim: horasAtras(7), motivo: 'interrompida', boot: 7 });
  const depois = sessao({ inicio: horasAtras(7), fim: horasAtras(2), motivo: 'parou', boot: 8, uptime0: 30_000 });
  await silenciar(c.telaId, '12 hours');
  assert.strictEqual((await fichaAdmin(c.telaId)).operacao, 'desconhecida');

  const r = await c.chamar('POST', 'operacao', { sessoes: [antes, depois] });
  assert.strictEqual(r.status, 200, r.texto);
  assert.deepStrictEqual(
    r.json.resultados.map((x) => x.status),
    ['registrada', 'registrada'],
  );
  await c.chamar('POST', 'heartbeat', { estado: 'PLAYING' });

  const t = await fichaAdmin(c.telaId);
  assert.strictEqual(t.conectividade, 'conectada');
  assert.strictEqual(new Date(t.operacaoConhecida.ultimaEm).getTime(), new Date(depois.fimEm).getTime());
  assert.ok(
    Math.abs(t.operacaoConhecida.sincronizadaDepoisMs7d - 10 * 3600 * 1000) < 2000,
    `10 h operadas offline: ${t.operacaoConhecida.sincronizadaDepoisMs7d}`,
  );

  // Reenvio (ACK perdido) é idempotente: nada dobra.
  await c.chamar('POST', 'operacao', { sessoes: [antes, depois] });
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM sessoes_operacionais WHERE dispositivo_id = $1', [
    c.telaId,
  ]);
  assert.strictEqual(rows[0].n, 2);
});

test('sessão operacional só estende: checkpoint velho não encurta, encerrada não reabre, outro boot não sobrescreve', async () => {
  const c = await cenario();
  const id = randomUUID();
  const inicio = horasAtras(5);
  const curta = sessao({ id, inicio, fim: horasAtras(4), encerrada: false });
  const longa = sessao({ id, inicio, fim: horasAtras(3), encerrada: false });
  const fechada = sessao({ id, inicio, fim: horasAtras(2), encerrada: true });
  const duracao = async () =>
    (await pool.query('SELECT duracao_ms, encerrada FROM sessoes_operacionais WHERE sessao_id = $1', [id])).rows[0];

  await c.chamar('POST', 'operacao', { sessoes: [longa] });
  await c.chamar('POST', 'operacao', { sessoes: [curta] });
  assert.strictEqual(Number((await duracao()).duracao_ms), longa.duracaoMs, 'checkpoint atrasado não encurta');
  await c.chamar('POST', 'operacao', { sessoes: [fechada] });
  assert.deepStrictEqual(await duracao(), { duracao_ms: String(fechada.duracaoMs), encerrada: true });
  const reaberta = sessao({ id, inicio, fim: horasAtras(1), encerrada: false });
  await c.chamar('POST', 'operacao', { sessoes: [reaberta] });
  assert.strictEqual((await duracao()).encerrada, true, 'encerrada não reabre');
  const outroBoot = { ...sessao({ id, inicio, fim: horasAtras(0.5), encerrada: true }), bootCount: 99 };
  await c.chamar('POST', 'operacao', { sessoes: [outroBoot] });
  assert.strictEqual(Number((await duracao()).duracao_ms), fechada.duracaoMs);
});

test('rota de sessões: inválida responde por sessão, lote ruim é 400, sem chave é 401', async () => {
  const c = await cenario();
  const boa = sessao({ inicio: horasAtras(2), fim: horasAtras(1) });
  const incoerente = { ...sessao({ inicio: horasAtras(2), fim: horasAtras(1) }), duracaoMs: 5 };
  const negativa = { ...sessao({ inicio: horasAtras(2), fim: horasAtras(1) }), fimUptimeMs: 0 };
  const idRuim = { ...sessao({ inicio: horasAtras(2), fim: horasAtras(1) }), sessaoId: 'x y\u0000' };
  const r = await c.chamar('POST', 'operacao', { sessoes: [boa, incoerente, negativa, idRuim, { semId: true }] });
  assert.strictEqual(r.status, 200, r.texto);
  assert.deepStrictEqual(
    r.json.resultados.map((x) => x.status),
    ['registrada', 'invalida', 'invalida', 'invalida'],
  );
  assert.strictEqual((await c.chamar('POST', 'operacao', { sessoes: 'x' })).status, 400);
  assert.strictEqual((await c.chamar('POST', 'operacao', { sessoes: Array(101).fill(boa) })).status, 400);
  const semChave = await navegador()('POST', `/player/${c.player.dispositivoId}/operacao`, { sessoes: [boa] });
  assert.strictEqual(semChave.status, 401);
});

test('TV desligada de verdade: sem comunicação, sem causa inventada', async () => {
  const c = await cenario();
  // Nenhuma sessão, nenhum erro: só silêncio.
  await silenciar(c.telaId, '2 days');
  const t = await fichaAdmin(c.telaId);
  assert.strictEqual(t.saude, 'sem_comunicacao');
  assert.strictEqual(t.operacao, 'desconhecida');
  assert.strictEqual(t.suporte.erro, null, 'nenhum erro inventado');
  assert.deepStrictEqual(
    t.alertas.map((a) => a.codigo),
    ['SEM_COMUNICACAO'],
  );
  assert.strictEqual(t.operacaoConhecida.ultimaEm, null, 'nenhuma operação inventada');
});

test('erro explícito do Player continua erro', async () => {
  const c = await cenario();
  const r = await c.chamar('POST', 'heartbeat', {
    estado: 'PLAYBACK_ERROR',
    erro: { codigo: 'PLAYBACK_FALHOU', mensagem: 'decoder', ocorreuEm: new Date().toISOString() },
  });
  assert.strictEqual(r.status, 200, r.texto);
  const t = await fichaAdmin(c.telaId);
  assert.strictEqual(t.saude, 'erro_do_player');
  assert.strictEqual(t.conectividade, 'conectada');
  assert.strictEqual(t.operacao, 'erro');
  assert.ok(t.alertas.some((a) => a.codigo === 'ERRO_PLAYER' && a.nivel === 'alerta'));
  assert.ok((await admin('GET', '/admin/resumo')).json.filas.telasComErro >= 1);
  assert.strictEqual((await telaDoDono(c)).tela.alerta, true, 'erro relatado avisa o dono');
});

test('inativo administrativo continua inativo, com ou sem comunicação', async () => {
  const c = await cenario();
  await admin('PATCH', `/admin/dispositivos/${c.telaId}`, { status: 'inativo' });
  const conectada = await fichaAdmin(c.telaId);
  assert.strictEqual(conectada.saude, 'inativa');
  await silenciar(c.telaId);
  const silenciosa = await fichaAdmin(c.telaId);
  assert.strictEqual(silenciosa.saude, 'inativa');
  assert.strictEqual(silenciosa.conectividade, 'sem_comunicacao', 'os eixos seguem separados');
  assert.strictEqual(silenciosa.operacao, null);
  assert.deepStrictEqual(silenciosa.alertas, []);
  assert.strictEqual((await situacaoDoAnunciante(c)).situacao, 'fora_do_ar');
});

test('situação comercial: sem comunicação segue no ar; erro relatado e reparo não', () => {
  const agora = new Date();
  const recente = new Date(agora.getTime() - 30_000).toISOString();
  const vencido = new Date(agora.getTime() - 3 * 3600 * 1000).toISOString();
  const tela = (extra) => ({ status: 'ativo', chave_hash: 'h', ultima_vez_online: recente, ...extra });
  assert.strictEqual(situacaoComercialDoPonto([tela({ ultima_vez_online: vencido })], agora), 'no_ar');
  assert.strictEqual(situacaoComercialDoPonto([tela({ player_estado: 'PLAYBACK_ERROR' })], agora), 'fora_do_ar');
  assert.strictEqual(situacaoComercialDoPonto([tela({ status: 'reparo' })], agora), 'fora_do_ar');
  assert.strictEqual(situacaoComercialDoPonto([tela({ chave_hash: null })], agora), 'fora_do_ar');
  assert.strictEqual(situacaoComercialDoPonto([], agora), 'fora_do_ar');
});
