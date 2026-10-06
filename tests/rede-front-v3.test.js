const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');
const { estadoDaTela, situacaoPublica, TOLERANCIA_SEM_SINAL_MS } = require('../src/lib/status-tela');
const { DIAS } = require('../src/lib/horario-semanal');
const { linhaEndereco } = require('../src/lib/endereco');

// REDE FRONT V3 (06/10/2026): o estado canônico da tela (src/lib/status-tela.js
// — sem comunicação NÃO é problema; tela móvel sem compromisso está SEM
// ALOCAÇÃO, nunca "24 h") e o COMPROMISSO unificado do Admin
// (src/pontos/compromissos.js — conta anfitriã = hospedagem, local externo =
// evento; horário sempre explícito). Roda o `app` REAL; cada teste cria as
// próprias contas e redes (os arquivos rodam em paralelo no mesmo banco).
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-rede-front-v3';
process.env.NODE_ENV = 'test';
const app = require('../src/server');
const alocacao = require('../src/pontos/alocacao');
const hospedagem = require('../src/pontos/hospedagem');
const dispositivosRepo = require('../src/dispositivos/repository');

const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const SENHA = 'Senha12@teste';
const criadas = { contas: [], pontos: [], categorias: [] };
const sessoes = new Set();
let base;
let servidor;
let admin;

function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo) {
    const cookie = [...potes.entries()].map(([nome, valor]) => `${nome}=${valor}`).join('; ');
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...(cookie ? { cookie } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par] = linha.split(';');
      const [nome, ...resto] = par.trim().split('=');
      const valor = resto.join('=');
      potes.set(nome, valor);
      const sid = /^s:([^.]+)\./.exec(decodeURIComponent(valor))?.[1];
      if (sid) sessoes.add(sid);
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

async function apagarPonto(id) {
  const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
  await pool.query(
    `DELETE FROM eventos WHERE anunciante_id IS NULL
        AND (propriedades->>'ponto_id' = $1::int::text
             OR propriedades->>'dispositivo_id' IN (SELECT id::text FROM dispositivos WHERE ponto_id = $1::int))`,
    [id],
  );
  const hosp = 'SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1';
  await pool.query(`DELETE FROM saldo_hospedagem_lancamentos WHERE hospedagem_id IN (${hosp})`, [id]);
  await pool.query(`DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (${hosp})`, [id]);
  await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE ponto_id = $1', [id]);
  await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query('DELETE FROM pontos_moveis_eventos WHERE ponto_id = $1', [id]);
  await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query(`DELETE FROM midias_exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query('DELETE FROM tela_operacao WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM creditos_ledger WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM pontos_enderecos_historico WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM pendencias WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
}

test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criadas.pontos) await apagarPonto(id);
  for (const id of criadas.contas) {
    const { rows } = await pool.query('SELECT id FROM pontos WHERE anunciante_id = $1', [id]);
    for (const p of rows) await apagarPonto(p.id);
    await pool.query('DELETE FROM saldo_hospedagem_lancamentos WHERE conta_id = $1', [id]);
    await pool.query(
      `DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE conta_id = $1)`,
      [id],
    );
    await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM pendencias WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  for (const id of criadas.categorias) await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
  await pool.query('DELETE FROM session WHERE sid = ANY($1::text[])', [[...sessoes]]);
  await pool.query('DELETE FROM tentativas_acesso WHERE chave LIKE $1', [`${IP}:%`]);
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// ---------- fixtures ----------
const cidadeUnica = () => `Cidade ${randomUUID().slice(0, 8)}`;
const paredeMais = (horas) => alocacao.parede(new Date(Date.now() + horas * 3_600_000));
const fechadoTodos = () => Object.fromEntries(DIAS.map((d) => [d, null]));

const HORARIO_COMERCIAL = {
  seg: { abre: '08:00', fecha: '18:00' },
  ter: { abre: '08:00', fecha: '18:00' },
  qua: { abre: '08:00', fecha: '18:00' },
  qui: { abre: '08:00', fecha: '18:00' },
  sex: { abre: '08:00', fecha: '18:00' },
  sab: { abre: '08:00', fecha: '12:00' },
  dom: null,
  feriados: null,
};

const ENDERECO_EXTERNO = {
  cep: '15990-000',
  logradouro: 'Avenida das Feiras',
  numero: '100',
  complemento: '',
  bairro: 'Parque',
  cidade: 'Matão',
  uf: 'SP',
};

async function novaConta({ categoriaId = null, nome = null, cidade = 'Matão' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, logradouro, numero, bairro, endereco, cidade, uf, cep,
                              categoria_id, responsavel_nome)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true,
             'Rua das Flores', '10', 'Centro', 'Rua das Flores, 10', $6, 'SP', '15990000', $5, 'Fulana')
     RETURNING *`,
    [
      nome || `Front V3 ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `front-v3-${randomUUID()}@example.com`,
      await gerarHash(SENHA),
      categoriaId,
      cidade,
    ],
  );
  criadas.contas.push(rows[0].id);
  return rows[0];
}

async function novaCategoria() {
  const { rows } = await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id, nome`, [
    `Ramo ${randomUUID().slice(0, 8)}`,
  ]);
  criadas.categorias.push(rows[0].id);
  return rows[0];
}

// Ponto fixo da conta (fora do sorteio), com horário e categoria.
async function pontoDaConta(conta, { horario = HORARIO_COMERCIAL, categoriaId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, logradouro, numero, bairro, cidade, uf, cep, segmento, responsavel_nome,
                         responsavel_contato, status, anunciante_id, horario_semanal, categoria_id, escolha_bloqueada_em)
     VALUES ($1, 'Rua do Ponto, 55', 'Rua do Ponto', '55', 'Vila Nova', 'Matão', 'SP', '15990-000', 'outro', 'R',
             '16 9', 'em_operacao', $2, $3, $4, now()) RETURNING *`,
    [`Loja ${randomUUID().slice(0, 8)}`, conta.id, horario ? JSON.stringify(horario) : null, categoriaId],
  );
  return rows[0];
}

// Ponto fixo sem dona, sem horário (ponto antigo), fora do sorteio.
async function pontoFixoSemHorario() {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status,
                         escolha_bloqueada_em)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '16 9', 'em_operacao', now()) RETURNING *`,
    [`Fixo ${randomUUID().slice(0, 8)}`],
  );
  criadas.pontos.push(rows[0].id);
  return rows[0];
}

async function criarRede() {
  const r = await admin('POST', '/admin/pontos-moveis', { nome: 'Mostraí Móvel', cidade: cidadeUnica(), uf: 'SP' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  return r.json;
}

async function adicionarTela(pontoId) {
  const r = await admin('POST', `/admin/pontos/${pontoId}/dispositivos`, {});
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

// Rede com `n` telas próprias (as que a criação já trouxe saem do caminho).
async function redeComTelas(n) {
  const rede = await criarRede();
  await pool.query(`UPDATE dispositivos SET status = 'inativo' WHERE ponto_id = $1`, [rede.id]);
  const telas = [];
  for (let i = 0; i < n; i++) telas.push(await adicionarTela(rede.id));
  await pool.query('UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = $1', [rede.id]);
  return { ...rede, telas };
}

// Player instalado e o último sinal `segundos` atrás (null = nunca bateu).
async function sinal(telaId, segundos, extra = '') {
  await pool.query(
    `UPDATE dispositivos SET chave_hash = md5(random()::text) || md5(random()::text),
            primeiro_sinal_em = now() - interval '3 days',
            ultima_vez_online = CASE WHEN $2::int IS NULL THEN NULL ELSE now() - make_interval(secs => $2::int) END
            ${extra}
      WHERE id = $1`,
    [telaId, segundos],
  );
}

const telaNoAdmin = async (id) => {
  const r = await admin('GET', `/admin/dispositivos/${id}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json;
};

// POST do compromisso; na conta, revisa o percentual se outro arquivo o
// mudou no meio (409 em percentual_esperado), como o Admin faria.
async function postarCompromisso(redeId, corpo) {
  let r;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    r = await admin('POST', `/admin/pontos/${redeId}/compromissos`, {
      ...(corpo.contexto === 'conta' ? { percentual_esperado: await hospedagem.percentualAtual() } : {}),
      ...corpo,
    });
    if (!(r.status === 409 && r.json?.campo === 'percentual_esperado')) break;
  }
  return r;
}

const corpoConta = (conta, tela, extra = {}) => ({
  contexto: 'conta',
  conta_id: conta.id,
  endereco_origem: 'conta',
  inicio: paredeMais(48),
  fim: paredeMais(72),
  horario_modo: 'periodo',
  telas: [tela],
  ...extra,
});

const corpoExterno = (telas, extra = {}) => ({
  contexto: 'externo',
  nome: 'Feira de Negócios',
  organizacao: 'Associação Comercial',
  local: 'Parque de Exposições',
  endereco_partes: ENDERECO_EXTERNO,
  inicio: paredeMais(5 * 24),
  fim: paredeMais(6 * 24),
  horario_modo: 'periodo',
  telas,
  ...extra,
});

const linhaHospedagem = async (ref) =>
  (await pool.query('SELECT * FROM pontos_moveis_hospedagens WHERE id = $1', [ref.slice(1)])).rows[0];
const linhaEvento = async (ref) =>
  (await pool.query('SELECT * FROM pontos_moveis_eventos WHERE id = $1', [ref.slice(1)])).rows[0];

// ===========================================================================
// a) Estado da tela — regressões (puro, `agora` fixo)
// ===========================================================================
// 2026-09-23 é uma quarta-feira; meio-dia de Matão.
const AGORA = new Date('2026-09-23T12:00:00-03:00');
const RECENTE = new Date(AGORA.getTime() - 30 * 1000).toISOString();
const VENCIDO = new Date(AGORA.getTime() - TOLERANCIA_SEM_SINAL_MS - 60 * 1000).toISOString();
const QUARTA_9_18 = { ...fechadoTodos(), qua: { abre: '09:00', fecha: '18:00' } };
const tela = (extra = {}) => ({
  status: 'ativo',
  chave_hash: 'h',
  primeiro_sinal_em: RECENTE,
  ultima_vez_online: RECENTE,
  created_at: RECENTE,
  ...extra,
});
const movelLivre = (extra = {}) => tela({ ponto_tipo: 'movel', movel_alocado: false, ...extra });
const movelAlocada = (extra = {}) => tela({ ponto_tipo: 'movel', movel_alocado: true, ...extra });

test('a1. móvel sem compromisso + heartbeat vencido: sem comunicação, sem alocação, nunca problema', () => {
  const e = estadoDaTela(movelLivre({ ultima_vez_online: VENCIDO }), null, AGORA);
  assert.strictEqual(e.conectividade, 'sem_comunicacao');
  assert.strictEqual(e.operacao, 'sem_alocacao');
  assert.strictEqual(e.esperadaAgora, false, 'sem alocação nada é esperado — nunca 24 h');
  assert.strictEqual(e.resumo, 'sem_comunicacao');
  assert.strictEqual(e.problema, null);
  assert.strictEqual(e.atencao, null, 'fora de compromisso, calada não é atenção');
  assert.strictEqual(situacaoPublica(e), 'sem_alocacao');
  // Nem um horário 24 h no lugar muda: sem compromisso, não opera.
  const h24 = Object.fromEntries(DIAS.map((d) => [d, { abre: '00:00', fecha: '24:00' }]));
  assert.strictEqual(estadoDaTela(movelLivre({ ultima_vez_online: VENCIDO }), h24, AGORA).esperadaAgora, false);
});

test('a2. móvel sem compromisso + heartbeat recente: comunicando, resumo sem_alocacao', () => {
  const e = estadoDaTela(movelLivre(), null, AGORA);
  assert.strictEqual(e.conectividade, 'comunicando');
  assert.strictEqual(e.operacao, 'sem_alocacao');
  assert.strictEqual(e.resumo, 'sem_alocacao');
  assert.strictEqual(e.esperadaAgora, false);
  assert.deepStrictEqual(e.alertas, []);
});

test('a3. compromisso fora do horário + sem heartbeat: operação fora_do_horario, sem problema nem atenção', () => {
  const e = estadoDaTela(movelAlocada({ ultima_vez_online: null }), { ...fechadoTodos(), seg: QUARTA_9_18.qua }, AGORA);
  assert.strictEqual(e.conectividade, 'sem_comunicacao');
  assert.strictEqual(e.operacao, 'fora_do_horario');
  assert.strictEqual(e.esperadaAgora, false);
  assert.strictEqual(e.problema, null);
  assert.strictEqual(e.atencao, null);
  assert.strictEqual(e.resumo, 'sem_comunicacao');
  assert.strictEqual(e.ultimoSinal, null);
  assert.strictEqual(situacaoPublica(e), 'fora_do_horario');
});

test('a4. compromisso dentro do horário + sem heartbeat: sem comunicação com atenção no horário', () => {
  const e = estadoDaTela(movelAlocada({ ultima_vez_online: VENCIDO }), QUARTA_9_18, AGORA);
  assert.strictEqual(e.conectividade, 'sem_comunicacao');
  assert.strictEqual(e.esperadaAgora, true);
  assert.strictEqual(e.problema, null);
  assert.strictEqual(e.atencao.codigo, 'SEM_COMUNICACAO_NO_HORARIO');
  assert.strictEqual(e.atencao.nivel, 'atencao');
  assert.strictEqual(e.resumo, 'sem_comunicacao');
  assert.strictEqual(situacaoPublica(e), 'sem_comunicacao');
});

test('a5. heartbeat recente + PLAYBACK_ERROR: com_problema, motivo "Falha de reprodução"', () => {
  for (const extra of [{ player_estado: 'PLAYBACK_ERROR' }, { ultimo_erro_codigo: 'PLAYBACK_ERROR' }]) {
    const e = estadoDaTela(tela(extra), QUARTA_9_18, AGORA);
    assert.strictEqual(e.resumo, 'com_problema', JSON.stringify(extra));
    assert.strictEqual(e.operacao, 'erro');
    assert.strictEqual(e.problema.codigo, 'ERRO_PLAYER');
    assert.strictEqual(e.problema.nivel, 'alerta');
    assert.strictEqual(e.problema.motivo, 'Falha de reprodução');
    assert.strictEqual(situacaoPublica(e), 'com_problema');
  }
  // O mesmo erro numa tela calada é dado velho: não é problema.
  const calada = estadoDaTela(tela({ player_estado: 'PLAYBACK_ERROR', ultima_vez_online: VENCIDO }), null, AGORA);
  assert.strictEqual(calada.problema, null);
  assert.strictEqual(calada.resumo, 'sem_comunicacao');
});

test('a6. fila crítica é problema (FILA_CRITICA); fila alta é só atenção', () => {
  const critica = estadoDaTela(tela({ fila_pendentes: 10001 }), QUARTA_9_18, AGORA);
  assert.strictEqual(critica.problema?.codigo, 'FILA_CRITICA');
  assert.strictEqual(critica.resumo, 'com_problema');
  const alta = estadoDaTela(tela({ fila_pendentes: 2001 }), QUARTA_9_18, AGORA);
  assert.strictEqual(alta.problema, null);
  assert.strictEqual(alta.atencao?.codigo, 'FILA_ALTA');
  assert.strictEqual(alta.resumo, 'operando');
});

test('a7. em reparo: resumo em_reparo, sem alerta nenhum (nem com erro, fila e sinal vencido)', () => {
  const e = estadoDaTela(
    tela({ status: 'reparo', ultima_vez_online: VENCIDO, ultimo_erro: 'x', fila_pendentes: 99999 }),
    QUARTA_9_18,
    AGORA,
  );
  assert.strictEqual(e.administrativo, 'em_reparo');
  assert.strictEqual(e.resumo, 'em_reparo');
  assert.deepStrictEqual(e.alertas, []);
  assert.strictEqual(e.problema, null);
  assert.strictEqual(e.atencao, null);
  assert.strictEqual(e.esperadaAgora, false);
});

test('a8. ponto fixo sem horário (null) + sinal vencido: continua esperada o dia inteiro (compatibilidade)', () => {
  const madrugada = new Date('2026-09-23T03:00:00-03:00');
  const vencido = new Date(madrugada.getTime() - TOLERANCIA_SEM_SINAL_MS - 60 * 1000).toISOString();
  for (const fixo of [tela({ ultima_vez_online: VENCIDO }), tela({ ponto_tipo: 'fixo', ultima_vez_online: VENCIDO })]) {
    const e = estadoDaTela(fixo, null, AGORA);
    assert.strictEqual(e.esperadaAgora, true);
    assert.strictEqual(e.atencao?.codigo, 'SEM_COMUNICACAO_NO_HORARIO');
    assert.strictEqual(e.problema, null);
  }
  assert.strictEqual(estadoDaTela(tela({ ultima_vez_online: vencido }), null, madrugada).esperadaAgora, true);
});

// ===========================================================================
// b) Integração: Admin, Visão geral e grade da Rede
// ===========================================================================
test('b1. tela móvel sem alocação e calada: "sem comunicação" (aviso), nunca problema, em todo lugar do Admin', async () => {
  const rede = await redeComTelas(2);
  const [calada, comErro] = rede.telas;
  await sinal(calada, 3600);
  // A outra está alocada? Não — mas comunica e relata erro: problema real.
  await sinal(comErro, 5, `, player_estado = 'PLAYBACK_ERROR'`);

  const t = await telaNoAdmin(calada);
  assert.strictEqual(t.saude, 'sem_comunicacao');
  assert.strictEqual(t.pontoTipo, 'movel');
  assert.strictEqual(t.estado.conectividade, 'sem_comunicacao');
  assert.strictEqual(t.estado.operacao, 'sem_alocacao');
  assert.strictEqual(t.estado.esperadaAgora, false);
  assert.strictEqual(t.estado.problema, null);
  assert.deepStrictEqual(t.alertas, []);
  const daRede = (await admin('GET', `/admin/pontos/${rede.id}/dispositivos`)).json;
  assert.strictEqual(daRede.find((x) => x.id === calada).saude, 'sem_comunicacao');
  assert.strictEqual(daRede.find((x) => x.id === comErro).saude, 'com_problema');

  // Visão geral: as duas listas separadas.
  const atencao = await dispositivosRepo.telasComAtencao();
  const ids = (lista) => lista.map((x) => x.id);
  assert.ok(!ids(atencao.comProblema).includes(calada), 'calada não é problema');
  assert.ok(ids(atencao.semComunicacao).includes(calada));
  assert.ok(ids(atencao.comProblema).includes(comErro));
  assert.ok(!ids(atencao.semComunicacao).includes(comErro));
  const resumo = await admin('GET', '/admin/resumo');
  assert.strictEqual(resumo.status, 200, JSON.stringify(resumo.json));
  const { filas } = resumo.json;
  assert.strictEqual(filas.offline, filas.telasComProblema, '`offline` = telas com problema real');
  assert.ok(filas.telasComProblema >= 1);
  assert.ok(filas.telasSemComunicacao >= 1);

  // Grade da Rede: o resumo das telas já classificado pelo servidor.
  await pool.query(`UPDATE dispositivos SET status = 'inativo' WHERE id = $1`, [comErro]);
  const pontos = await admin('GET', '/admin/pontos');
  assert.strictEqual(pontos.status, 200);
  const doCard = pontos.json.find((p) => p.id === rede.id);
  assert.strictEqual(doCard.estadoTelas.semComunicacao, 1);
  assert.strictEqual(doCard.estadoTelas.comProblema, 0);
  assert.strictEqual(doCard.estadoTelas.semAlocacao, 0, 'calada conta em sem comunicação, não em sem alocação');
  assert.deepStrictEqual(doCard.estadoTelas.filtros, ['sem_comunicacao']);
  assert.ok(doCard.codigosTelas.includes(t.codigo));
});

test('b2. tela móvel sem alocação mas comunicando: "sem alocação" na grade, sem filtro de aviso', async () => {
  const rede = await redeComTelas(1);
  await sinal(rede.telas[0], 5);
  const t = await telaNoAdmin(rede.telas[0]);
  assert.strictEqual(t.saude, 'sem_alocacao');
  const doCard = (await admin('GET', '/admin/pontos')).json.find((p) => p.id === rede.id);
  assert.strictEqual(doCard.estadoTelas.semAlocacao, 1);
  assert.deepStrictEqual(doCard.estadoTelas.filtros, []);
});

// ===========================================================================
// c) Horário: o do ponto fixo, o do compromisso, e a cópia do modo "local"
// ===========================================================================
test('c1. ponto fixo sem horário mantém o dia inteiro: calado = sem comunicação no horário', async () => {
  const p = await pontoFixoSemHorario();
  const id = await adicionarTela(p.id);
  await sinal(id, 3600);
  const t = await telaNoAdmin(id);
  assert.strictEqual(t.saude, 'sem_comunicacao');
  assert.strictEqual(t.estado.esperadaAgora, true);
  assert.strictEqual(t.estado.atencao?.codigo, 'SEM_COMUNICACAO_NO_HORARIO');
  assert.strictEqual(t.estado.problema, null);
});

test('c2. tela móvel com compromisso em curso segue o horário DELE', async () => {
  const rede = await redeComTelas(2);
  const [fechada, continua] = rede.telas;
  // Grade do compromisso com HOJE fechado (só um dia daqui a três abre).
  const DIA_UTC = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
  const hojeMatao = new Date(Date.now() - 3 * 3_600_000).getUTCDay();
  const outroDia = DIA_UTC[(hojeMatao + 3) % 7];
  const grade = { ...fechadoTodos(), [outroDia]: { abre: '08:00', fecha: '09:00' } };
  for (const [telaId, extra] of [
    [fechada, { horario_modo: 'personalizado', horario_operacao: grade }],
    [continua, { horario_modo: 'periodo' }],
  ]) {
    const r = await postarCompromisso(
      rede.id,
      corpoExterno([telaId], { inicio: paredeMais(-2), fim: paredeMais(24), ...extra }),
    );
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    const ini = await admin('POST', `/admin/pontos/${rede.id}/compromissos/${r.json.ref}/iniciar`);
    assert.strictEqual(ini.status, 200, JSON.stringify(ini.json));
    await sinal(telaId, 3600);
  }
  const a = await telaNoAdmin(fechada);
  assert.strictEqual(a.estado.operacao, 'fora_do_horario');
  assert.strictEqual(a.estado.esperadaAgora, false);
  assert.strictEqual(a.estado.atencao, null);
  const b = await telaNoAdmin(continua);
  assert.strictEqual(b.estado.operacao, 'desconhecida');
  assert.strictEqual(b.estado.esperadaAgora, true, '"durante todo o período" = esperada agora');
  assert.strictEqual(b.estado.atencao?.codigo, 'SEM_COMUNICACAO_NO_HORARIO');
  // A ficha da rede usa a mesma régua.
  const ficha = (await admin('GET', `/admin/pontos/${rede.id}/movel`)).json;
  assert.strictEqual(ficha.telas.find((t) => t.id === fechada).estado.operacao, 'fora_do_horario');
  assert.strictEqual(ficha.telas.find((t) => t.id === continua).estado.esperadaAgora, true);
});

test('c3. horário "do local": CÓPIA do horário do ponto, que não muda se o ponto mudar depois', async () => {
  const rede = await redeComTelas(1);
  const conta = await novaConta();
  const ponto = await pontoDaConta(conta);
  const r = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[0], { endereco_origem: 'ponto', ponto_id: ponto.id, horario_modo: 'local' }),
  );
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.contexto, 'conta');
  assert.match(r.json.ref, /^h\d+$/);
  assert.deepStrictEqual((await linhaHospedagem(r.json.ref)).horario_operacao, HORARIO_COMERCIAL);
  await pool.query('UPDATE pontos SET horario_semanal = $2 WHERE id = $1', [
    ponto.id,
    JSON.stringify({ ...HORARIO_COMERCIAL, dom: { abre: '10:00', fecha: '14:00' } }),
  ]);
  assert.deepStrictEqual(
    (await linhaHospedagem(r.json.ref)).horario_operacao,
    HORARIO_COMERCIAL,
    'o comércio mudou o horário; o compromisso já programado não',
  );
});

test('c4. horário personalizado (com feriados e madrugada), "todo o período" = null, e nunca 24 h implícito', async () => {
  const rede = await redeComTelas(4);
  const conta = await novaConta();
  const balada = {
    ...fechadoTodos(),
    sex: { abre: '20:00', fecha: '02:00' },
    sab: { abre: '20:00', fecha: '02:00' },
    feriados: { abre: '18:00', fecha: '23:00' },
  };
  const p = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[0], { horario_modo: 'personalizado', horario_operacao: balada }),
  );
  assert.strictEqual(p.status, 201, JSON.stringify(p.json));
  assert.deepStrictEqual((await linhaHospedagem(p.json.ref)).horario_operacao, balada);

  const periodo = await postarCompromisso(rede.id, corpoConta(conta, rede.telas[1], { horario_modo: 'periodo' }));
  assert.strictEqual(periodo.status, 201, JSON.stringify(periodo.json));
  assert.strictEqual((await linhaHospedagem(periodo.json.ref)).horario_operacao, null);
  const ext = await postarCompromisso(rede.id, corpoExterno([rede.telas[2]], { horario_modo: 'periodo' }));
  assert.strictEqual(ext.status, 201, JSON.stringify(ext.json));
  assert.strictEqual((await linhaEvento(ext.json.ref)).horario_operacao, null);

  const semModo = corpoConta(conta, rede.telas[3]);
  delete semModo.horario_modo;
  for (const corpo of [semModo, { ...corpoExterno([rede.telas[3]]), horario_modo: undefined }]) {
    const r = await postarCompromisso(rede.id, corpo);
    assert.strictEqual(r.status, 400, JSON.stringify(r.json));
    assert.strictEqual(r.json.campo, 'horario_modo');
  }
  // "Do local" com o endereço da CONTA (que não tem horário): recusado.
  const semHorario = await postarCompromisso(rede.id, corpoConta(conta, rede.telas[3], { horario_modo: 'local' }));
  assert.strictEqual(semHorario.status, 400, JSON.stringify(semHorario.json));
  assert.strictEqual(semHorario.json.campo, 'horario_modo');
  // Personalizado sem grade também não vira 24 h.
  const semGrade = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[3], { horario_modo: 'personalizado' }),
  );
  assert.strictEqual(semGrade.status, 400, JSON.stringify(semGrade.json));
  assert.strictEqual(semGrade.json.campo, 'horario_operacao');
});

// ===========================================================================
// d) Compromisso na conta anfitriã (hospedagem)
// ===========================================================================
test('d1. busca de conta: por parte do nome, sem conta própria nem excluída, homônimos pela cidade', async () => {
  const marca = randomUUID().slice(0, 8);
  const matao = await novaConta({ nome: `Padaria Central ${marca}`, cidade: 'Matão' });
  const araraquara = await novaConta({ nome: `Padaria Central ${marca}`, cidade: 'Araraquara' });
  const excluida = await novaConta({ nome: `Padaria Central ${marca} velha` });
  await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [excluida.id]);

  const r = await admin('GET', `/admin/compromissos/contas?q=${encodeURIComponent(`central ${marca}`)}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(
    r.json.map((c) => c.id).sort((a, b) => a - b),
    [matao.id, araraquara.id].sort((a, b) => a - b),
  );
  const cidades = Object.fromEntries(r.json.map((c) => [c.id, c.cidade]));
  assert.strictEqual(cidades[matao.id], 'Matão');
  assert.strictEqual(cidades[araraquara.id], 'Araraquara');
  assert.ok(
    r.json.every((c) => 'email' in c && 'pontos' in c),
    'contato e pontos para distinguir',
  );

  const {
    rows: [propria],
  } = await pool.query('SELECT id, nome_empresa FROM anunciantes WHERE conta_propria');
  if (propria) {
    const p = await admin('GET', `/admin/compromissos/contas?q=${encodeURIComponent(propria.nome_empresa)}`);
    assert.ok(!p.json.some((c) => c.id === propria.id), 'conta própria não hospeda');
    assert.strictEqual((await admin('GET', `/admin/compromissos/contas/${propria.id}/locais`)).status, 404);
  }
  assert.strictEqual((await admin('GET', `/admin/compromissos/contas/${excluida.id}/locais`)).status, 404);
});

test('d2. locais da conta: o endereço dela e os pontos fixos (com horário e categoria)', async () => {
  const cat = await novaCategoria();
  const conta = await novaConta();
  const ponto = await pontoDaConta(conta, { categoriaId: cat.id });
  const r = await admin('GET', `/admin/compromissos/contas/${conta.id}/locais`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.conta.id, conta.id);
  assert.strictEqual(r.json.conta.endereco, linhaEndereco(conta, { comCidade: true }));
  assert.strictEqual(r.json.conta.partes.numero, '10');
  assert.strictEqual(r.json.pontos.length, 1);
  assert.strictEqual(r.json.pontos[0].id, ponto.id);
  assert.deepStrictEqual(r.json.pontos[0].horario, HORARIO_COMERCIAL);
  assert.deepStrictEqual(r.json.pontos[0].categoria, { id: cat.id, nome: cat.nome });
});

test('d3. endereço da conta, de um ponto ou digitado; categoria herdada ou nenhuma; benefício congelado, termo pendente', async () => {
  const catConta = await novaCategoria();
  const catPonto = await novaCategoria();
  const rede = await redeComTelas(4);
  const conta = await novaConta({ categoriaId: catConta.id });
  const ponto = await pontoDaConta(conta, { categoriaId: catPonto.id });

  // Endereço da conta; categoria ausente = a da conta.
  const a = await postarCompromisso(rede.id, corpoConta(conta, rede.telas[0]));
  assert.strictEqual(a.status, 201, JSON.stringify(a.json));
  assert.deepStrictEqual(a.json.telas, [rede.telas[0]]);
  assert.strictEqual(a.json.contaId, conta.id);
  let h = await linhaHospedagem(a.json.ref);
  assert.strictEqual(h.endereco, linhaEndereco(conta, { comCidade: true }));
  assert.strictEqual(h.local, conta.nome_empresa);
  assert.strictEqual(h.categoria_id, catConta.id);
  assert.strictEqual(Number(h.percentual), Number(a.json.percentual), 'percentual congelado na hospedagem');
  assert.strictEqual(h.termo_assinado, false, 'nasce com o termo físico pendente');
  assert.strictEqual(h.estado, 'programada');

  // Ponto da conta; categoria ausente = a do ponto.
  const b = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[1], { endereco_origem: 'ponto', ponto_id: ponto.id }),
  );
  assert.strictEqual(b.status, 201, JSON.stringify(b.json));
  h = await linhaHospedagem(b.json.ref);
  assert.strictEqual(h.endereco, linhaEndereco(ponto, { comCidade: true }));
  assert.strictEqual(h.local, ponto.nome);
  assert.strictEqual(h.categoria_id, catPonto.id);

  // Outro endereço, em partes; '' = "Nenhuma restrição" de propósito.
  const c = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[2], {
      endereco_origem: 'outro',
      endereco_partes: ENDERECO_EXTERNO,
      local: 'Quiosque da praça',
      categoria_id: '',
    }),
  );
  assert.strictEqual(c.status, 201, JSON.stringify(c.json));
  h = await linhaHospedagem(c.json.ref);
  assert.strictEqual(h.endereco, linhaEndereco(ENDERECO_EXTERNO, { comCidade: true }));
  assert.strictEqual(h.local, 'Quiosque da praça');
  assert.strictEqual(h.categoria_id, null);

  // Partes incompletas: aponta o campo.
  const semNumero = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[3], {
      endereco_origem: 'outro',
      endereco_partes: { ...ENDERECO_EXTERNO, numero: '' },
    }),
  );
  assert.strictEqual(semNumero.status, 400, JSON.stringify(semNumero.json));
  assert.strictEqual(semNumero.json.campo, 'numero');
  // Ponto de OUTRA conta não serve.
  const outraConta = await novaConta();
  const alheio = await pontoDaConta(outraConta);
  const r = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[3], { endereco_origem: 'ponto', ponto_id: alheio.id }),
  );
  assert.strictEqual(r.status, 400, JSON.stringify(r.json));
  assert.strictEqual(r.json.campo, 'ponto_id');
});

test('d4. conta: uma tela só, conflito por tela = 409, e a lista unificada mostra o compromisso', async () => {
  const rede = await redeComTelas(2);
  const conta = await novaConta();
  const duas = await postarCompromisso(rede.id, corpoConta(conta, rede.telas[0], { telas: rede.telas }));
  assert.strictEqual(duas.status, 400, JSON.stringify(duas.json));
  assert.strictEqual(duas.json.campo, 'telas');

  const ok = await postarCompromisso(rede.id, corpoConta(conta, rede.telas[0]));
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  const choque = await postarCompromisso(
    rede.id,
    corpoConta(await novaConta(), rede.telas[0], { inicio: paredeMais(60), fim: paredeMais(90) }),
  );
  assert.strictEqual(choque.status, 409, JSON.stringify(choque.json));
  assert.strictEqual(choque.json.campo, 'telas');
  // Externo na mesma tela, sobreposto: o mesmo 409.
  const choqueExterno = await postarCompromisso(
    rede.id,
    corpoExterno([rede.telas[1], rede.telas[0]], { inicio: paredeMais(50), fim: paredeMais(55) }),
  );
  assert.strictEqual(choqueExterno.status, 409, JSON.stringify(choqueExterno.json));
  assert.strictEqual(choqueExterno.json.campo, 'telas');

  const lista = await admin('GET', `/admin/pontos/${rede.id}/compromissos`);
  assert.strictEqual(lista.status, 200, JSON.stringify(lista.json));
  assert.deepStrictEqual(Object.keys(lista.json).sort(), ['agora', 'historico', 'proximos']);
  assert.strictEqual(lista.json.agora.length, 0);
  const c = lista.json.proximos.find((x) => x.ref === ok.json.ref);
  assert.ok(c, 'em próximos');
  assert.strictEqual(c.contexto, 'conta');
  assert.strictEqual(c.estado, 'programado');
  assert.strictEqual(c.conta.id, conta.id);
  assert.ok(c.hospedagem, 'benefício, termo e equipamento só na conta');
  assert.strictEqual(typeof c.hospedagem.percentual, 'number');
  assert.deepStrictEqual(
    c.telas.map((t) => t.id),
    [rede.telas[0]],
  );
  // A ficha da rede traz o mesmo formato.
  const ficha = (await admin('GET', `/admin/pontos/${rede.id}/movel`)).json;
  assert.ok(ficha.compromissos.proximos.some((x) => x.ref === ok.json.ref));
  // Ponto fixo não tem compromisso.
  const fixo = await pontoFixoSemHorario();
  assert.strictEqual((await admin('GET', `/admin/pontos/${fixo.id}/compromissos`)).status, 409);
});

test('d5. conta: iniciar sem o termo físico assinado = 409', async () => {
  const rede = await redeComTelas(1);
  const conta = await novaConta();
  const r = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[0], { inicio: paredeMais(-1), fim: paredeMais(24) }),
  );
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const ini = await admin('POST', `/admin/pontos/${rede.id}/compromissos/${r.json.ref}/iniciar`, {
    entrega: { itens: { tela: true, suporte: true }, condicao: 'ok' },
  });
  assert.strictEqual(ini.status, 409, JSON.stringify(ini.json));
  assert.strictEqual(ini.json.campo, 'termo');
  assert.strictEqual((await linhaHospedagem(r.json.ref)).estado, 'programada');
  // Ação desconhecida e ref inválida: 404.
  assert.strictEqual((await admin('POST', `/admin/pontos/${rede.id}/compromissos/${r.json.ref}/explodir`)).status, 404);
  assert.strictEqual((await admin('POST', `/admin/pontos/${rede.id}/compromissos/x9/iniciar`)).status, 404);
});

// ===========================================================================
// e) Compromisso em local externo (evento)
// ===========================================================================
test('e1. externo: sem conta, endereço em partes obrigatório, várias telas, sem benefício', async () => {
  const rede = await redeComTelas(3);
  const semEndereco = await postarCompromisso(rede.id, {
    ...corpoExterno([rede.telas[0]]),
    endereco_partes: undefined,
  });
  assert.strictEqual(semEndereco.status, 400, JSON.stringify(semEndereco.json));
  assert.strictEqual(semEndereco.json.campo, 'cep');
  const semRua = await postarCompromisso(
    rede.id,
    corpoExterno([rede.telas[0]], { endereco_partes: { ...ENDERECO_EXTERNO, logradouro: '' } }),
  );
  assert.strictEqual(semRua.status, 400, JSON.stringify(semRua.json));
  assert.strictEqual(semRua.json.campo, 'logradouro');

  const r = await postarCompromisso(rede.id, corpoExterno([rede.telas[0], rede.telas[1]]));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.contexto, 'externo');
  assert.strictEqual(r.json.contaId, null);
  assert.match(r.json.ref, /^e\d+$/);
  assert.deepStrictEqual(r.json.telas, [rede.telas[0], rede.telas[1]]);
  const ev = await linhaEvento(r.json.ref);
  assert.strictEqual(ev.endereco, linhaEndereco(ENDERECO_EXTERNO, { comCidade: true }));
  assert.strictEqual(ev.categoria_id, null);

  const lista = (await admin('GET', `/admin/pontos/${rede.id}/compromissos`)).json;
  const c = lista.proximos.find((x) => x.ref === r.json.ref);
  assert.strictEqual(c.contexto, 'externo');
  assert.strictEqual(c.hospedagem, null, 'sem benefício nem termo');
  assert.strictEqual(c.conta, null);
  assert.strictEqual(
    (await pool.query('SELECT COUNT(*)::int AS n FROM pontos_moveis_hospedagens WHERE ponto_id = $1', [rede.id]))
      .rows[0].n,
    0,
    'nenhuma hospedagem nasce do externo',
  );

  // Conflito por tela.
  const choque = await postarCompromisso(rede.id, corpoExterno([rede.telas[2], rede.telas[1]]));
  assert.strictEqual(choque.status, 409, JSON.stringify(choque.json));
  assert.strictEqual(choque.json.campo, 'telas');
});

test('e2. externo: editar o programado (fim, telas, endereço atual), conflito sem contar a si mesmo', async () => {
  const rede = await redeComTelas(3);
  const [t1, t2, t3] = rede.telas;
  const r = await postarCompromisso(rede.id, corpoExterno([t1]));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const ref = r.json.ref;
  const antes = await linhaEvento(ref);
  const editar = (corpo) => admin('PATCH', `/admin/pontos/${rede.id}/compromissos/${ref}`, corpo);

  // O mesmo período (sobrepõe a si mesmo), uma tela a mais e o fim adiante.
  const novoFim = paredeMais(7 * 24);
  const e = await editar(corpoExterno([t1, t2], { fim: novoFim }));
  assert.strictEqual(e.status, 200, JSON.stringify(e.json));
  assert.strictEqual(e.json.ref, ref);
  let ev = await linhaEvento(ref);
  assert.strictEqual(
    new Date(ev.fim).getTime(),
    alocacao.lerPeriodo({ inicio: paredeMais(1), fim: novoFim }).fim.getTime(),
  );
  const telasDoEvento = async () =>
    (
      await pool.query(
        'SELECT dispositivo_id FROM pontos_moveis_evento_telas WHERE evento_id = $1 ORDER BY dispositivo_id',
        [ev.id],
      )
    ).rows.map((x) => x.dispositivo_id);
  assert.deepStrictEqual(await telasDoEvento(), [t1, t2]);

  // Endereço "atual": mantém o gravado, sem as partes.
  const atual = await editar({
    endereco_origem: 'atual',
    nome: 'Feira (2ª edição)',
    local: antes.local,
    inicio: paredeMais(5 * 24),
    fim: novoFim,
    horario_modo: 'periodo',
    telas: [t1],
  });
  assert.strictEqual(atual.status, 200, JSON.stringify(atual.json));
  ev = await linhaEvento(ref);
  assert.strictEqual(ev.endereco, antes.endereco);
  assert.strictEqual(ev.nome, 'Feira (2ª edição)');
  assert.deepStrictEqual(await telasDoEvento(), [t1]);

  // Outro compromisso na t3; trazer a t3 para o mesmo período = 409.
  const outro = await postarCompromisso(rede.id, corpoExterno([t3], { nome: 'Rodeio' }));
  assert.strictEqual(outro.status, 201, JSON.stringify(outro.json));
  const choque = await editar(corpoExterno([t1, t3], { fim: novoFim }));
  assert.strictEqual(choque.status, 409, JSON.stringify(choque.json));
  assert.strictEqual(choque.json.campo, 'telas');
  assert.deepStrictEqual(await telasDoEvento(), [t1], 'conflito não mexe em nada');
});

test('e3. externo: iniciar o em curso e cancelar o programado pela mesma porta; editar começado = 409', async () => {
  const rede = await redeComTelas(2);
  const agora = await postarCompromisso(
    rede.id,
    corpoExterno([rede.telas[0]], { inicio: paredeMais(-2), fim: paredeMais(24) }),
  );
  assert.strictEqual(agora.status, 201, JSON.stringify(agora.json));
  const depois = await postarCompromisso(rede.id, corpoExterno([rede.telas[1]]));
  assert.strictEqual(depois.status, 201, JSON.stringify(depois.json));

  const acao = (ref, a) => admin('POST', `/admin/pontos/${rede.id}/compromissos/${ref}/${a}`);
  const ini = await acao(agora.json.ref, 'iniciar');
  assert.strictEqual(ini.status, 200, JSON.stringify(ini.json));
  assert.strictEqual((await linhaEvento(agora.json.ref)).estado, 'em_andamento');
  const can = await acao(depois.json.ref, 'cancelar');
  assert.strictEqual(can.status, 200, JSON.stringify(can.json));
  assert.strictEqual((await linhaEvento(depois.json.ref)).estado, 'cancelado');

  const lista = (await admin('GET', `/admin/pontos/${rede.id}/compromissos`)).json;
  assert.deepStrictEqual(
    lista.agora.map((c) => [c.ref, c.estado]),
    [[agora.json.ref, 'em_curso']],
  );
  assert.ok(lista.historico.some((c) => c.ref === depois.json.ref && c.estado === 'cancelado'));
  assert.strictEqual(lista.proximos.length, 0);

  const editar = await admin(
    'PATCH',
    `/admin/pontos/${rede.id}/compromissos/${agora.json.ref}`,
    corpoExterno([rede.telas[0]], { inicio: paredeMais(-2), fim: paredeMais(48) }),
  );
  assert.strictEqual(editar.status, 409, JSON.stringify(editar.json));
  // Nenhum saldo de hospedagem sai de evento.
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM saldo_hospedagem_lancamentos
      WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1)`,
    [rede.id],
  );
  assert.strictEqual(rows[0].n, 0);
});

// ===========================================================================
// f) Validações do formulário
// ===========================================================================
test('f. validações: contexto, conta, local e período', async () => {
  const rede = await redeComTelas(1);
  const conta = await novaConta();
  const casos = [
    [{ ...corpoExterno([rede.telas[0]]), contexto: undefined }, 400, 'contexto'],
    [{ ...corpoExterno([rede.telas[0]]), contexto: 'qualquer' }, 400, 'contexto'],
    [{ ...corpoConta(conta, rede.telas[0]), conta_id: undefined }, 400, 'conta_id'],
    [{ ...corpoConta(conta, rede.telas[0]), conta_id: 999999999 }, 400, 'conta_id'],
    [{ ...corpoConta(conta, rede.telas[0]), endereco_origem: undefined }, 400, 'endereco_origem'],
    [{ ...corpoExterno([rede.telas[0]]), local: '' }, 400, 'local'],
    [{ ...corpoExterno([rede.telas[0]]), local: undefined }, 400, 'local'],
    [corpoExterno([rede.telas[0]], { inicio: paredeMais(30), fim: paredeMais(30) }), 400, 'fim'],
    [corpoExterno([rede.telas[0]], { inicio: paredeMais(30), fim: paredeMais(20) }), 400, 'fim'],
    [corpoConta(conta, rede.telas[0], { inicio: paredeMais(30), fim: paredeMais(29) }), 400, 'fim'],
    [corpoExterno([]), 400, 'telas'],
  ];
  for (const [corpo, status, campo] of casos) {
    const r = await postarCompromisso(rede.id, corpo);
    assert.strictEqual(r.status, status, `${campo}: ${JSON.stringify(r.json)}`);
    assert.strictEqual(r.json.campo, campo, JSON.stringify(r.json));
  }
  const { rows } = await pool.query(
    `SELECT (SELECT COUNT(*) FROM pontos_moveis_hospedagens WHERE ponto_id = $1)::int
          + (SELECT COUNT(*) FROM pontos_moveis_eventos WHERE ponto_id = $1)::int AS n`,
    [rede.id],
  );
  assert.strictEqual(rows[0].n, 0, 'nada gravado');
});
