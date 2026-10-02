const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// PONTO MÓVEL V2 — hospedagem temporária, saldo de hospedagem em horas e o
// ciclo de vida do ativo (migration 113; src/pontos/hospedagem.js,
// src/pontos/agenda.js, src/player/operacao.js, a camada T3b do gerador).
// Os números (1–67) seguem os grupos do pedido do dono: Origem 1–8,
// Hospedagem 9–19, Benefício 20–30, Operação 31–37, Utilização 38–46,
// Concorrência 47–52, Site 53–59, Painel 60–67; e os E2E §78, §79 e §80.
// Roda o `app` REAL. Cada teste cria as próprias contas e pontos (os
// arquivos rodam em paralelo no mesmo banco).
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-hospedagem';
const app = require('../src/server');
const hospedagem = require('../src/pontos/hospedagem');
const movel = require('../src/pontos/movel');
const dispositivosRepo = require('../src/dispositivos/repository');
const execucoesRepo = require('../src/playlist/execucoes-repository');
const gerador = require('../src/playlist/gerador');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const candidaturasRepo = require('../src/candidaturas/repository');
const operacao = require('../src/player/operacao');
const { montarHoraDeTv } = require('../src/lib/pacing');
const { acessoDoPainel } = require('../src/anunciantes/acesso-painel');
const { instalarPlayer, tirarDoSorteio } = require('./apoio-player');

const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const SENHA = 'Senha12@teste';
const criadas = { contas: [], pontos: [], categorias: [], interesses: [] };
const INICIO_DO_ARQUIVO = new Date();
let base;
let servidor;
let admin;
let percentualOriginal;

function navegador(ip = IP) {
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
        'x-forwarded-for': ip,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const caminhoCookie = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor: resto.join('='), path: caminhoCookie });
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
  percentualOriginal = await hospedagem.percentualAtual();
  // Os testes partem do padrão do dono (20%); o original volta no fim.
  await pool.query(`UPDATE configuracoes_site SET valor = '20' WHERE chave = 'hospedagem_percentual'`);
});

test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  await pool.query(`UPDATE configuracoes_site SET valor = $1 WHERE chave = 'hospedagem_percentual'`, [
    String(percentualOriginal),
  ]);
  await pool.query('DELETE FROM hospedagem_percentual_historico WHERE alterado_em >= $1', [INICIO_DO_ARQUIVO]);
  for (const id of criadas.interesses) {
    await pool.query(`DELETE FROM pendencias WHERE chave = $1`, [`HOSPEDAGEM_INTERESSE:${id}`]);
  }
  for (const id of criadas.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(
      'DELETE FROM saldo_hospedagem_lancamentos WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1)',
      [id],
    );
    await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE ponto_id = $1', [id]);
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query(`DELETE FROM midias_exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM creditos_ledger WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos_enderecos_historico WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pendencias WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM tela_operacao WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  for (const id of criadas.contas) {
    await pool.query('DELETE FROM saldo_hospedagem_lancamentos WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM pendencias WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM hospedagem_interesses WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  for (const id of criadas.interesses) await pool.query('DELETE FROM hospedagem_interesses WHERE id = $1', [id]);
  for (const id of criadas.categorias) await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// ---------- fixtures ----------
async function novaConta({ categoriaId = null, nome = null, propria = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, logradouro, numero, bairro, endereco, cidade, uf, cep,
                              categoria_id, responsavel_nome)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true,
             'Rua das Flores', '10', 'Centro', 'Rua das Flores, 10', 'Matão', 'SP', '15990000', $5, 'Fulana')
     RETURNING *`,
    [
      nome || `Tabacaria ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `hosp-${randomUUID()}@example.com`,
      await gerarHash(SENHA),
      categoriaId,
    ],
  );
  criadas.contas.push(rows[0].id);
  if (propria) await pool.query('UPDATE anunciantes SET conta_propria = true WHERE id = $1', [rows[0].id]);
  return rows[0];
}

async function entrar(conta) {
  const nav = navegador();
  const r = await nav('POST', '/anunciantes/login', { email: conta.contato_email, senha: SENHA });
  assert.strictEqual(r.status, 200, `login da conta ${conta.id}`);
  return nav;
}

async function novaCategoria(prefixo = 'Ramo') {
  const { rows } = await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id`, [
    `${prefixo} ${randomUUID().slice(0, 8)}`,
  ]);
  criadas.categorias.push(rows[0].id);
  return rows[0].id;
}

// Base sem horário (a tela exibe enquanto ligada): a suíte não depende da
// hora em que roda.
const HORARIO_DA_BASE = null;

async function criarMovel({ contaBase = null, extra = {} } = {}) {
  const r = await admin('POST', '/admin/pontos-moveis', {
    base_conta_id: contaBase ? contaBase.id : null,
    base_nome: `Depósito ${randomUUID().slice(0, 8)}`,
    cep: '15990000',
    logradouro: 'Avenida Brasil',
    numero: String(100 + Math.floor(Math.random() * 800)),
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    horario_semanal: HORARIO_DA_BASE,
    ...extra,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  await tirarDoSorteio(r.json.id);
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [r.json.id]);
  return { ...rows[0], telaId: r.json.telaId };
}

const hojeMais = (dias) => {
  const d = new Date(`${movel.hojeEmMatao()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

async function programar(pontoId, conta, extra = {}) {
  const r = await admin('POST', `/admin/pontos/${pontoId}/hospedagens`, {
    conta_id: conta.id,
    data_inicio: hojeMais(0),
    data_fim: hojeMais(2),
    percentual_esperado: await hospedagem.percentualAtual(),
    ...extra,
  });
  return r;
}

async function programarOk(pontoId, conta, extra = {}) {
  const r = await programar(pontoId, conta, extra);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

const acao = (pontoId, hid, nome) => admin('POST', `/admin/pontos/${pontoId}/hospedagens/${hid}/${nome}`);
const linha = async (hid) => (await pool.query('SELECT * FROM pontos_moveis_hospedagens WHERE id = $1', [hid])).rows[0];

// Tempo operacional de teste: intervalos de heartbeat gravados direto.
async function operou(telaId, inicio, fim, origem = 'heartbeat', extra = {}) {
  await pool.query(
    `INSERT INTO tela_operacao (dispositivo_id, ponto_id, origem, inicio, fim, boot_id, seq)
     SELECT $1, ponto_id, $2, $3, $4, $5, $6 FROM dispositivos WHERE id = $1`,
    [telaId, origem, inicio, fim, extra.bootId ?? null, extra.seq ?? null],
  );
}
const minutosAtras = (m) => new Date(Date.now() - m * 60_000);

// Hospedagem ativa que começou há `minutos` (a tela chegou antes; o teste
// recua `iniciada_em` em vez de esperar).
async function hospedagemAtiva(ponto, conta, minutos = 180) {
  const hid = await programarOk(ponto.id, conta);
  assert.strictEqual((await acao(ponto.id, hid, 'iniciar')).status, 200);
  await pool.query('UPDATE pontos_moveis_hospedagens SET iniciada_em = $2 WHERE id = $1', [hid, minutosAtras(minutos)]);
  return hid;
}

async function pecaAprovada(conta, duracao = 15) {
  const c = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'o.mp4',
    arquivo_normalizado_url: `https://exemplo.test/${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: duracao,
  });
  await criativosRepo.atualizar(c.id, { status: 'aprovado' });
  return c;
}

// Conta com saldo de hospedagem (o benefício de uma hospedagem encerrada).
async function contaComSaldo(segundos, opcoes = {}) {
  const conta = await novaConta(opcoes);
  const m = await criarMovel();
  const hid = await hospedagemAtiva(m, conta, 600);
  // 100% de 1 tela → o tempo comprovado vira o benefício (benefício = tempo × 20%).
  await operou(m.telaId, minutosAtras(Math.ceil(segundos / 0.2 / 60) + 1), minutosAtras(0.5));
  await acao(m.id, hid, 'encerrar');
  const s = await hospedagem.saldoDaConta(conta.id);
  assert.ok(s.disponivelSegundos >= segundos, `saldo de ${segundos}s (tem ${s.disponivelSegundos})`);
  return { conta, movelDaHospedagem: m };
}

async function telaComPlayer(pontoId) {
  const { rows } = await pool.query(
    `SELECT id FROM dispositivos WHERE ponto_id = $1 AND status <> 'inativo' ORDER BY id LIMIT 1`,
    [pontoId],
  );
  let telaId = rows[0]?.id;
  if (!telaId) telaId = (await dispositivosRepo.criar(pontoId, {})).id;
  await dispositivosRepo.atualizar(telaId, { status: 'ativo' });
  // A tela foi instalada (ativada) antes do período que os testes simulam:
  // o segmento offline vale pelo estado da tela QUANDO foi exibido.
  await pool.query(
    `UPDATE tela_eventos SET ocorrido_em = ocorrido_em - interval '10 days'
      WHERE dispositivo_id = $1 AND tipo = 'ADMIN_STATE_CHANGED'`,
    [telaId],
  );
  const cred = await instalarPlayer(telaId);
  return { telaId, ...cred };
}

// Ponto fixo aberto 24 h (sem horário): a playlist da hora de teste está
// sempre aberta, a qualquer hora em que a suíte rode.
async function pontoFixo({ categoriaId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, categoria_id)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '16 9', $2) RETURNING *`,
    [`Fixo ${randomUUID().slice(0, 8)}`, categoriaId],
  );
  criadas.pontos.push(rows[0].id);
  await tirarDoSorteio(rows[0].id);
  return rows[0];
}

const horaCheia = () => {
  const h = new Date();
  h.setMinutes(0, 0, 0);
  return h;
};

// =====================================================================
// Origem 1–8
// =====================================================================
test('1 e 2. candidatura sempre gera FIXO; pedir móvel na aprovação é recusado', async () => {
  const conta = await novaConta();
  const nova = (extra = {}) =>
    candidaturasRepo.criar({
      tipo: 'ponto',
      nome: 'Resp',
      contato_telefone: '16988880000',
      nome_comercio: `Loja ${randomUUID().slice(0, 8)}`,
      logradouro: 'Rua A',
      numero: String(Math.floor(Math.random() * 900) + 1),
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
      segmento: 'outro',
      conta_id: conta.id,
      origem: 'painel',
      ...extra,
    });
  const c1 = await nova();
  const r1 = await admin('POST', `/admin/candidaturas/${c1.id}/liberar`, {});
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.json));
  const { rows } = await pool.query('SELECT id, tipo, anunciante_id FROM pontos WHERE candidatura_id = $1', [c1.id]);
  criadas.pontos.push(rows[0].id);
  assert.strictEqual(rows[0].tipo, 'fixo');
  assert.strictEqual(rows[0].anunciante_id, conta.id);
  const c2 = await nova();
  const r2 = await admin('POST', `/admin/candidaturas/${c2.id}/liberar`, { tipo: 'movel' });
  assert.strictEqual(r2.status, 400);
  const nada = await pool.query('SELECT 1 FROM pontos WHERE candidatura_id = $1', [c2.id]);
  assert.strictEqual(nada.rowCount, 0);
});

test('3 e 4. só o Admin cria o móvel; nasce da Mostraí, sem dono, sem candidatura, com a Tela 1', async () => {
  const m = await criarMovel();
  assert.strictEqual(m.tipo, 'movel');
  assert.strictEqual(m.anunciante_id, null);
  assert.strictEqual(m.candidatura_id, null);
  assert.strictEqual(m.base_conta_id, null, 'a conta da base é opcional');
  assert.match(m.nome, /^Mostraí Móvel #\d{2,}$/);
  const { rows: telas } = await pool.query('SELECT status FROM dispositivos WHERE ponto_id = $1', [m.id]);
  assert.strictEqual(telas.length, 1, 'a Tela 1 nasce com o móvel');
  const conta = await novaConta();
  const nav = await entrar(conta);
  for (const quem of [nav, navegador()]) {
    assert.strictEqual((await quem('POST', '/admin/pontos-moveis', { base_nome: 'X' })).status, 401);
  }
  const nomeado = await criarMovel({ extra: { nome: 'Totem da Feira', observacoes: 'nota só do Admin' } });
  assert.strictEqual(nomeado.nome, 'Totem da Feira');
  const semBase = await admin('POST', '/admin/pontos-moveis', { cep: '15990000' });
  assert.strictEqual(semBase.status, 400);
});

test('5 e 6. tipo imutável e móvel nunca recebe dono', async () => {
  const m = await criarMovel();
  const dona = await novaConta();
  assert.strictEqual((await admin('POST', `/admin/pontos/${m.id}/tornar-fixo`)).status, 410);
  await assert.rejects(pool.query(`UPDATE pontos SET tipo = 'fixo' WHERE id = $1`, [m.id]), (e) => e.code === '23514');
  const patch = await admin('PATCH', `/admin/pontos/${m.id}`, { anunciante_id: dona.id });
  assert.strictEqual(patch.status, 400);
  await assert.rejects(
    pool.query('UPDATE pontos SET anunciante_id = $2 WHERE id = $1', [m.id, dona.id]),
    (e) => e.code === '23514',
  );
  // Hospedar não muda nada disso.
  const hid = await hospedagemAtiva(m, dona, 30);
  await acao(m.id, hid, 'encerrar');
  const { rows } = await pool.query('SELECT tipo, anunciante_id FROM pontos WHERE id = $1', [m.id]);
  assert.deepStrictEqual(rows[0], { tipo: 'movel', anunciante_id: null });
});

test('7. 1 ponto móvel = 1 tela: a segunda é recusada; trocar o equipamento passa por deixar a atual Inativa', async () => {
  const m = await criarMovel();
  const segunda = await admin('POST', `/admin/pontos/${m.id}/dispositivos`, {});
  assert.strictEqual(segunda.status, 409);
  assert.match(segunda.json.erro, /uma tela só/);
  assert.strictEqual((await admin('PATCH', `/admin/dispositivos/${m.telaId}`, { status: 'inativo' })).status, 200);
  const nova = await admin('POST', `/admin/pontos/${m.id}/dispositivos`, {});
  assert.strictEqual(nova.status, 201, JSON.stringify(nova.json));
  const reativar = await admin('PATCH', `/admin/dispositivos/${m.telaId}`, { status: 'ativo' });
  assert.strictEqual(reativar.status, 409, 'reativar a antiga daria duas telas');
  // Ponto fixo continua com quantas telas quiser.
  const fixo = await pontoFixo();
  assert.strictEqual((await admin('POST', `/admin/pontos/${fixo.id}/dispositivos`, {})).status, 201);
  assert.strictEqual((await admin('POST', `/admin/pontos/${fixo.id}/dispositivos`, {})).status, 201);
});

test('8. foto do equipamento: só no móvel, só pelo Admin, e a ficha a expõe', async () => {
  const m = await criarMovel();
  const fixo = await pontoFixo();
  const semArquivo = await admin('POST', `/admin/pontos/${m.id}/foto-movel`);
  assert.strictEqual(semArquivo.status, 400);
  const fd = new FormData();
  fd.append('arquivo', new Blob([Buffer.from('x')], { type: 'image/jpeg' }), 'f.jpg');
  const cookie = await (async () => {
    // O navegador do admin guarda o cookie; reaproveita pelo fetch cru.
    const r = await fetch(`${base}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP },
      body: JSON.stringify({ usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD }),
    });
    return r.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
  })();
  const r = await fetch(`${base}/admin/pontos/${fixo.id}/foto-movel`, {
    method: 'POST',
    body: fd,
    headers: { cookie, 'x-forwarded-for': IP },
  });
  assert.strictEqual(r.status, 409, 'ponto fixo não tem foto de equipamento');
  const html = new FormData();
  html.append('arquivo', new Blob([Buffer.from('<script>')], { type: 'text/html' }), 'f.html');
  const naoImagem = await fetch(`${base}/admin/pontos/${m.id}/foto-movel`, {
    method: 'POST',
    body: html,
    headers: { cookie, 'x-forwarded-for': IP },
  });
  assert.strictEqual(naoImagem.status, 400, 'só imagem vai para o bucket público');
  const anon = await fetch(`${base}/admin/pontos/${m.id}/foto-movel`, { method: 'POST', body: fd });
  assert.strictEqual(anon.status, 401);
  await pool.query(`UPDATE pontos SET foto_instalacao_url = 'https://exemplo.test/movel.jpg' WHERE id = $1`, [m.id]);
  const ficha = (await admin('GET', `/admin/pontos/${m.id}/movel`)).json;
  assert.strictEqual(ficha.foto, 'https://exemplo.test/movel.jpg');
  const lista = (await admin('GET', '/admin/pontos-moveis')).json.moveis.find((x) => x.id === m.id);
  assert.strictEqual(lista.foto, 'https://exemplo.test/movel.jpg');
});

// =====================================================================
// Hospedagem 9–19
// =====================================================================
test('9, 10 e 11. confirmar hospedagem: percentual congelado, revisão obrigatória, anfitrião válido', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await programarOk(m.id, anfitria);
  const h = await linha(hid);
  assert.strictEqual(h.estado, 'programada');
  assert.strictEqual(Number(h.percentual), 20, 'congelado no padrão do dono');
  assert.strictEqual(h.local, anfitria.nome_empresa, 'o local nasce com o nome da conta');
  assert.match(h.endereco, /Rua das Flores/);
  assert.strictEqual(h.criado_por_admin, process.env.ADMIN_USER);
  const outro = await criarMovel();
  const divergente = await programar(outro.id, anfitria, { percentual_esperado: 25 });
  assert.strictEqual(divergente.status, 409, 'o percentual revisado não é o que vale');
  const semRevisao = await programar(outro.id, anfitria, { percentual_esperado: '' });
  assert.strictEqual(semRevisao.status, 400);
  // A conta própria é única no banco: usa a que existir (ou cria uma).
  const { rows: jaExiste } = await pool.query('SELECT id FROM anunciantes WHERE conta_propria LIMIT 1');
  const propria = jaExiste[0] || (await novaConta({ propria: true }));
  assert.strictEqual((await programar(outro.id, propria)).status, 400, 'a conta própria não hospeda');
  assert.strictEqual((await programar(outro.id, { id: 999999999 })).status, 400);
  const fixo = await pontoFixo();
  assert.strictEqual((await programar(fixo.id, anfitria)).status, 409, 'hospedagem é só de ponto móvel');
  const passado = await programar(outro.id, anfitria, { data_inicio: hojeMais(-3), data_fim: hojeMais(-1) });
  assert.strictEqual(passado.status, 400);
});

test('12 e 13. agenda única: hospedagem × hospedagem, hospedagem × evento, evento × evento', async () => {
  const m = await criarMovel();
  const a = await novaConta();
  const b = await novaConta();
  await programarOk(m.id, a, { data_inicio: hojeMais(2), data_fim: hojeMais(4) });
  const choque = await programar(m.id, b, { data_inicio: hojeMais(4), data_fim: hojeMais(6) });
  assert.strictEqual(choque.status, 409, 'datas inclusivas: o último dia conta');
  assert.match(choque.json.erro, /hospedado/);
  const evento = await admin('POST', `/admin/pontos/${m.id}/eventos`, {
    nome: 'Feira',
    organizacao: 'Prefeitura',
    local: 'Praça',
    data_inicio: hojeMais(3),
  });
  assert.strictEqual(evento.status, 409);
  const eventoOk = await admin('POST', `/admin/pontos/${m.id}/eventos`, {
    nome: 'Feira',
    organizacao: 'Prefeitura',
    local: 'Praça',
    data_inicio: hojeMais(8),
    data_fim: hojeMais(9),
  });
  assert.strictEqual(eventoOk.status, 201);
  assert.strictEqual((await programar(m.id, b, { data_inicio: hojeMais(9), data_fim: hojeMais(10) })).status, 409);
  const outroEvento = await admin('POST', `/admin/pontos/${m.id}/eventos`, {
    nome: 'Show',
    organizacao: 'X',
    local: 'Y',
    data_inicio: hojeMais(9),
  });
  assert.strictEqual(outroEvento.status, 409);
  // Sem conflito: depois do evento.
  assert.strictEqual((await programar(m.id, b, { data_inicio: hojeMais(10), data_fim: hojeMais(11) })).status, 201);
  // O banco é a última linha de defesa: INSERT direto também é recusado.
  await assert.rejects(
    pool.query(
      `INSERT INTO pontos_moveis_hospedagens (ponto_id, conta_id, local, endereco, data_inicio, data_fim, percentual)
       VALUES ($1, $2, 'x', 'y', $3, $4, 20)`,
      [m.id, b.id, hojeMais(3), hojeMais(3)],
    ),
    (e) => e.code === '23P01',
  );
});

test('14. concorrência: duas confirmações simultâneas no mesmo período — passa uma só', async () => {
  const m = await criarMovel();
  const contas = await Promise.all([novaConta(), novaConta(), novaConta(), novaConta()]);
  const respostas = await Promise.all(
    contas.map((c) => programar(m.id, c, { data_inicio: hojeMais(1), data_fim: hojeMais(2) })),
  );
  const status = respostas.map((r) => r.status).sort();
  assert.deepStrictEqual(status, [201, 409, 409, 409], JSON.stringify(respostas.map((r) => r.json)));
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM pontos_moveis_hospedagens WHERE ponto_id = $1 AND estado = 'programada'`,
    [m.id],
  );
  assert.strictEqual(rows[0].n, 1);
});

test('15. iniciar: só a partir do dia; local atual vira o anfitrião; a TV é avisada', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const futura = await programarOk(m.id, anfitria, { data_inicio: hojeMais(3), data_fim: hojeMais(4) });
  const cedo = await acao(m.id, futura, 'iniciar');
  assert.strictEqual(cedo.status, 409);
  assert.match(cedo.json.erro, /altere o período/);
  const hoje = await programarOk(m.id, await novaConta(), { data_inicio: hojeMais(0), data_fim: hojeMais(1) });
  const versaoAntes = (await pool.query('SELECT config_versao_desejada v FROM dispositivos WHERE id = $1', [m.telaId]))
    .rows[0].v;
  assert.strictEqual((await acao(m.id, hoje, 'iniciar')).status, 200);
  assert.strictEqual((await linha(hoje)).estado, 'ativa');
  const f = (await admin('GET', `/admin/pontos/${m.id}/movel`)).json;
  assert.strictEqual(f.localAtual.origem, 'hospedagem');
  const tela = await dispositivosRepo.buscarComPonto(m.telaId);
  assert.strictEqual(tela.ponto_horario_semanal, null, 'fora da base, a tela exibe enquanto estiver ligada');
  assert.ok(tela.config_versao_desejada > versaoAntes, 'a config da TV muda');
  assert.strictEqual((await acao(m.id, hoje, 'iniciar')).status, 409, 'já em andamento');
});

test('16. cancelar: só antes de começar, sem benefício; depois de começar, o caminho é encerrar', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await programarOk(m.id, anfitria, { data_inicio: hojeMais(1), data_fim: hojeMais(1) });
  assert.strictEqual((await acao(m.id, hid, 'cancelar')).status, 200);
  const h = await linha(hid);
  assert.strictEqual(h.estado, 'cancelada');
  assert.strictEqual(h.beneficio_segundos, null);
  assert.strictEqual(
    (await pool.query('SELECT 1 FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = $1', [hid])).rowCount,
    0,
  );
  const ativa = await hospedagemAtiva(m, anfitria, 10);
  const r = await acao(m.id, ativa, 'cancelar');
  assert.strictEqual(r.status, 409);
  assert.match(r.json.erro, /Encerrar/);
});

test('17. prorrogar: sem conflito, mantendo o percentual; nunca encurta; com conflito é recusado', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 10);
  await admin('POST', `/admin/pontos/${m.id}/eventos`, {
    nome: 'Rodeio',
    organizacao: 'X',
    local: 'Parque',
    data_inicio: hojeMais(6),
    data_fim: hojeMais(7),
  });
  const per = (corpo) => admin('PUT', `/admin/pontos/${m.id}/hospedagens/${hid}/periodo`, corpo);
  assert.strictEqual((await per({ data_fim: hojeMais(4) })).status, 200);
  assert.strictEqual((await linha(hid)).data_fim, hojeMais(4));
  assert.strictEqual((await per({ data_fim: hojeMais(6) })).status, 409, 'bate no evento');
  assert.strictEqual((await per({ data_fim: hojeMais(1) })).status, 400, 'encurtar é Encerrar');
  assert.strictEqual(Number((await linha(hid)).percentual), 20);
  // Programada: muda início e fim.
  const outra = await programarOk(m.id, await novaConta(), { data_inicio: hojeMais(10), data_fim: hojeMais(11) });
  const mudou = await admin('PUT', `/admin/pontos/${m.id}/hospedagens/${outra}/periodo`, {
    data_inicio: hojeMais(12),
    data_fim: hojeMais(13),
  });
  assert.strictEqual(mudou.status, 200);
});

test('18. encerrada não acumula mais nem muda (o banco recusa)', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 120);
  await operou(m.telaId, minutosAtras(100), minutosAtras(40));
  assert.strictEqual((await acao(m.id, hid, 'encerrar')).status, 200);
  const antes = await linha(hid);
  // Operação depois do encerramento não muda nada.
  await operou(m.telaId, minutosAtras(1), new Date());
  await assert.rejects(
    pool.query('UPDATE pontos_moveis_hospedagens SET beneficio_segundos = 999999 WHERE id = $1', [hid]),
    (e) => e.code === '23514',
  );
  await assert.rejects(
    pool.query(`UPDATE pontos_moveis_hospedagens SET estado = 'ativa' WHERE id = $1`, [hid]),
    (e) => e.code === '23514',
  );
  assert.deepStrictEqual(await linha(hid), antes);
  assert.strictEqual((await acao(m.id, hid, 'encerrar')).status, 409);
});

test('19. encerramento automático no fim previsto: ativa encerra com benefício; programada e evento também', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  // Hospedagem que terminou ontem (gravada direto: a rota não aceita passado).
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_hospedagens (ponto_id, conta_id, local, endereco, data_inicio, data_fim, percentual,
                                            estado, iniciada_em)
     VALUES ($1, $2, 'Tabacaria', 'Rua', $3, $4, 20, 'ativa', now() - interval '3 days') RETURNING id`,
    [m.id, anfitria.id, hojeMais(-3), hojeMais(-1)],
  );
  const hid = rows[0].id;
  // Operou 2 h dentro do período e 1 h DEPOIS do fim previsto (não conta).
  const fimPrevisto = new Date(`${hojeMais(0)}T03:00:00Z`); // meia-noite de Matão (UTC−3)
  await operou(m.telaId, new Date(fimPrevisto.getTime() - 2 * 3600e3), fimPrevisto);
  await operou(m.telaId, fimPrevisto, new Date(fimPrevisto.getTime() + 3600e3));
  const programada = await pool.query(
    `INSERT INTO pontos_moveis_hospedagens (ponto_id, conta_id, local, endereco, data_inicio, data_fim, percentual)
     VALUES ($1, $2, 'Outra', 'Rua', $3, $3, 20) RETURNING id`,
    [(await criarMovel()).id, anfitria.id, hojeMais(-2)],
  );
  const m2 = await criarMovel();
  const ev = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, organizacao, local, data_inicio, data_fim, estado, iniciado_em)
     VALUES ($1, 'Feira', 'X', 'Praça', $2, $3, 'em_andamento', now() - interval '2 days') RETURNING id`,
    [m2.id, hojeMais(-2), hojeMais(-1)],
  );
  const r1 = await hospedagem.encerrarVencidas();
  assert.ok(r1.hospedagensEncerradas >= 1 && r1.hospedagensCanceladas >= 1 && r1.eventosEncerrados >= 1);
  const h = await linha(hid);
  assert.strictEqual(h.estado, 'encerrada');
  assert.strictEqual(h.encerramento, 'automatico');
  assert.strictEqual(new Date(h.encerrada_em).getTime(), fimPrevisto.getTime(), 'encerra no fim previsto');
  assert.strictEqual(h.tempo_operacional_segundos, 7200, 'a hora depois do fim previsto não conta');
  assert.strictEqual(h.beneficio_segundos, 1440);
  assert.strictEqual((await linha(programada.rows[0].id)).estado, 'cancelada');
  const evento = (
    await pool.query('SELECT estado, encerramento FROM pontos_moveis_eventos WHERE id = $1', [ev.rows[0].id])
  ).rows[0];
  assert.deepStrictEqual(evento, { estado: 'encerrado', encerramento: 'automatico' });
  // Rodar de novo não repete nada.
  await hospedagem.encerrarVencidas();
  const { rows: lanc } = await pool.query(
    'SELECT COUNT(*)::int n FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = $1',
    [hid],
  );
  assert.strictEqual(lanc[0].n, 1);
});

// =====================================================================
// Benefício 20–30
// =====================================================================
test('20 e 21. percentual: padrão 20%, configurável pelo Admin, validado e auditado', async () => {
  assert.strictEqual(await hospedagem.percentualAtual(), 20);
  const pub = await navegador()('GET', '/hospedagem/condicao');
  assert.strictEqual(pub.json.percentual, 20);
  assert.deepStrictEqual(pub.json.exemplo, { horasDeOperacao: 30, segundosDeMidia: 6 * 3600 });
  for (const ruim of [-1, 101, 'abc', '12,345', '', null]) {
    const r = await admin('PUT', '/admin/hospedagem/percentual', { percentual: ruim });
    assert.strictEqual(r.status, 400, `rejeita ${JSON.stringify(ruim)}`);
  }
  const conta = await novaConta();
  const nav = await entrar(conta);
  assert.strictEqual((await nav('PUT', '/admin/hospedagem/percentual', { percentual: 99 })).status, 401);
  const ok = await admin('PUT', '/admin/hospedagem/percentual', { percentual: '12,5' });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(
    { percentual: ok.json.percentual, anterior: ok.json.anterior, mudou: ok.json.mudou },
    { percentual: 12.5, anterior: 20, mudou: true },
  );
  const hist = (await admin('GET', '/admin/hospedagem/percentual')).json.historico[0];
  assert.deepStrictEqual(
    { anterior: hist.anterior, novo: hist.novo, admin: hist.admin },
    { anterior: 20, novo: 12.5, admin: process.env.ADMIN_USER },
  );
  assert.ok(hist.alteradoEm);
  assert.strictEqual((await navegador()('GET', '/hospedagem/condicao')).json.percentual, 12.5, 'o site lê o real');
  await admin('PUT', '/admin/hospedagem/percentual', { percentual: 20 });
});

test('22 (E2E §79). mudar o percentual não mexe em hospedagem já confirmada: A fica 20%, B nasce 25%', async () => {
  const anfitria = await novaConta();
  const mA = await criarMovel();
  const mB = await criarMovel();
  const a = await hospedagemAtiva(mA, anfitria, 300);
  await admin('PUT', '/admin/hospedagem/percentual', { percentual: 25 });
  try {
    const b = await hospedagemAtiva(mB, anfitria, 300);
    await operou(mA.telaId, minutosAtras(250), minutosAtras(250 - 120));
    await operou(mB.telaId, minutosAtras(250), minutosAtras(250 - 120));
    await acao(mA.id, a, 'encerrar');
    await acao(mB.id, b, 'encerrar');
    const [ha, hb] = [await linha(a), await linha(b)];
    assert.strictEqual(Number(ha.percentual), 20);
    assert.strictEqual(Number(hb.percentual), 25);
    assert.strictEqual(ha.beneficio_segundos, 1440, '2 h × 20%');
    assert.strictEqual(hb.beneficio_segundos, 1800, '2 h × 25%');
  } finally {
    await admin('PUT', '/admin/hospedagem/percentual', { percentual: 20 });
  }
});

test('23. benefício = tempo × percentual, para baixo, em inteiros', () => {
  assert.strictEqual(hospedagem.beneficioDe(30 * 3600, 20), 6 * 3600);
  assert.strictEqual(hospedagem.beneficioDe(1, 20), 0);
  assert.strictEqual(hospedagem.beneficioDe(7, 33.33), 2);
  assert.strictEqual(hospedagem.beneficioDe(3600, 12.5), 450);
  assert.strictEqual(hospedagem.beneficioDe(3600, 0), 0);
  assert.strictEqual(hospedagem.beneficioDe(3600, 100), 3600);
  assert.strictEqual(hospedagem.beneficioDe(-50, 20), 0);
});

test('24, 25 e 28. o benefício nasce uma vez, no encerramento; cancelada não gera nada', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 120);
  await operou(m.telaId, minutosAtras(110), minutosAtras(50));
  assert.strictEqual((await hospedagem.saldoDaConta(anfitria.id)).disponivelSegundos, 0, 'durante: nada ainda');
  // Encerramento manual e o job ao mesmo tempo: um lançamento só.
  const [r1, r2, r3] = await Promise.all([
    acao(m.id, hid, 'encerrar'),
    acao(m.id, hid, 'encerrar'),
    hospedagem.encerrarVencidas(),
  ]);
  assert.deepStrictEqual([r1.status, r2.status].sort(), [200, 409]);
  assert.ok(r3);
  const { rows } = await pool.query(
    'SELECT tipo, segundos, chave FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = $1',
    [hid],
  );
  assert.deepStrictEqual(rows, [{ tipo: 'beneficio', segundos: 720, chave: `hospedagem:${hid}` }]);
  assert.strictEqual((await hospedagem.saldoDaConta(anfitria.id)).disponivelSegundos, 720);
  const notif = await pool.query(
    `SELECT titulo FROM notificacoes WHERE anunciante_id = $1 AND tipo = 'hospedagem_encerrada'`,
    [anfitria.id],
  );
  assert.strictEqual(notif.rowCount, 1);
  assert.match(notif.rows[0].titulo, /12 min/);
  // A chave é única no banco: nem um INSERT direto duplica.
  await assert.rejects(
    pool.query(
      `INSERT INTO saldo_hospedagem_lancamentos (conta_id, tipo, segundos, chave, hospedagem_id) VALUES ($1, 'beneficio', 720, $2, $3)`,
      [anfitria.id, `hospedagem:${hid}`, hid],
    ),
    (e) => e.code === '23505',
  );
});

test('26 e 27. tempo válido = UNIÃO dos intervalos dentro da hospedagem; nunca o calendário', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 240);
  // Heartbeat 200→140 min atrás; Player offline 150→100 (sobrepõe 10 min);
  // um intervalo ANTES do início (300→250) não conta.
  await operou(m.telaId, minutosAtras(200), minutosAtras(140));
  await operou(m.telaId, minutosAtras(150), minutosAtras(100), 'player', { bootId: 'b7', seq: 1 });
  await operou(m.telaId, minutosAtras(300), minutosAtras(250));
  assert.strictEqual((await acao(m.id, hid, 'encerrar')).status, 200);
  const h = await linha(hid);
  assert.ok(Math.abs(h.tempo_operacional_segundos - 100 * 60) <= 2, `100 min (${h.tempo_operacional_segundos}s)`);
  assert.ok(h.tempo_operacional_segundos < 240 * 60, 'menos que as 4 h do calendário');
  assert.strictEqual(h.beneficio_segundos, Math.floor((h.tempo_operacional_segundos * 20) / 100));
});

test('29. ajuste do Admin: + ou −, com motivo e autor; nunca deixa o saldo negativo', async () => {
  const conta = await novaConta();
  const aj = (corpo) => admin('POST', `/admin/anunciantes/${conta.id}/saldo-hospedagem/ajustes`, corpo);
  assert.strictEqual((await aj({ minutos: 30 })).status, 400, 'sem motivo');
  assert.strictEqual((await aj({ minutos: 0, motivo: 'x' })).status, 400);
  assert.strictEqual((await aj({ minutos: 1.5, motivo: 'x' })).status, 400);
  assert.strictEqual((await aj({ minutos: -10, motivo: 'tirar' })).status, 400, 'saldo zero não fica negativo');
  assert.strictEqual((await aj({ minutos: 60, motivo: 'compensação de falha da tela' })).status, 201);
  assert.strictEqual((await aj({ minutos: -15, motivo: 'correção', chave: 'modal-0001' })).status, 201);
  // Retry com a mesma chave: grava uma vez; outro valor na mesma chave: 409.
  assert.strictEqual((await aj({ minutos: -15, motivo: 'correção', chave: 'modal-0001' })).status, 201);
  assert.strictEqual((await aj({ minutos: -20, motivo: 'correção', chave: 'modal-0001' })).status, 409);
  const d = (await admin('GET', `/admin/anunciantes/${conta.id}/saldo-hospedagem`)).json;
  assert.strictEqual(d.saldo.disponivelSegundos, 45 * 60);
  assert.strictEqual(d.extrato.length, 2);
  assert.ok(d.extrato.every((l) => l.admin === process.env.ADMIN_USER && l.motivo));
  const nav = await entrar(conta);
  assert.strictEqual(
    (await nav('POST', `/admin/anunciantes/${conta.id}/saldo-hospedagem/ajustes`, { minutos: 600, motivo: 'x' }))
      .status,
    401,
  );
  const minha = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  assert.strictEqual(minha.extrato, undefined, 'a conta não recebe o extrato (nem a nota e o autor dos ajustes)');
  assert.deepStrictEqual(Object.keys(minha.saldo).sort(), ['disponivelSegundos', 'recebidoSegundos']);
});

test('30. saldo de hospedagem não é crédito, plano nem Básico — e não expira', async () => {
  const { conta } = await contaComSaldo(600);
  const { rows } = await pool.query('SELECT plano_id, data_expiracao FROM anunciantes WHERE id = $1', [conta.id]);
  assert.deepStrictEqual(rows[0], { plano_id: null, data_expiracao: null });
  assert.strictEqual(
    (await pool.query('SELECT 1 FROM creditos_ledger WHERE anunciante_id = $1', [conta.id])).rowCount,
    0,
  );
  assert.strictEqual(
    (await pool.query('SELECT 1 FROM beneficios_basico_ponto WHERE conta_id = $1', [conta.id])).rowCount,
    0,
  );
  // Um lançamento antigo continua valendo.
  await pool.query(
    `UPDATE saldo_hospedagem_lancamentos SET criado_em = now() - interval '3 years' WHERE conta_id = $1`,
    [conta.id],
  );
  assert.ok((await hospedagem.saldoDaConta(conta.id)).disponivelSegundos >= 600);
});

// =====================================================================
// Operação 31–37
// =====================================================================
test('31 e 32. heartbeat exibindo estende o intervalo; sinal perdido abre outro; fora do ar não conta; fixo não grava', async () => {
  const m = await criarMovel();
  const { telaId, chaveAparelho, dispositivoId } = await telaComPlayer(m.id);
  const hb = (estado) =>
    fetch(`${base}/player/${dispositivoId}/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aparelho-key': chaveAparelho, 'x-player-version': '1.3.0+13' },
      body: JSON.stringify({ estado }),
    });
  assert.strictEqual((await hb('PLAYING')).status, 200);
  await new Promise((r) => setTimeout(r, 1100));
  assert.strictEqual((await hb('IDLE')).status, 200);
  let { rows } = await pool.query(
    `SELECT inicio, fim FROM tela_operacao WHERE dispositivo_id = $1 AND origem = 'heartbeat'`,
    [telaId],
  );
  assert.strictEqual(rows.length, 1, 'batidas seguidas estendem o mesmo intervalo');
  assert.ok(new Date(rows[0].fim) - new Date(rows[0].inicio) >= 1000);
  await hb('OUT_OF_SCHEDULE');
  ({ rows } = await pool.query(`SELECT COUNT(*)::int n FROM tela_operacao WHERE dispositivo_id = $1`, [telaId]));
  assert.strictEqual(rows[0].n, 1, 'fora do horário não grava');
  const intervalos = async () =>
    (await pool.query(`SELECT COUNT(*)::int n FROM tela_operacao WHERE dispositivo_id = $1`, [telaId])).rows[0].n;
  const recuar = (minutos) =>
    pool.query(
      `UPDATE tela_operacao SET fim = fim - make_interval(mins => $2), inicio = inicio - make_interval(mins => $2)
        WHERE dispositivo_id = $1`,
      [telaId, minutos],
    );
  // Uma batida fora do ar no meio quebra o intervalo (mesmo sem buraco).
  await hb('PLAYING');
  assert.strictEqual(await intervalos(), 2, 'depois de OUT_OF_SCHEDULE, intervalo novo');
  // O APK bate a cada 5 min: 2 min depois da anterior (exibindo) estende.
  await recuar(2);
  await hb('PLAYING');
  assert.strictEqual(await intervalos(), 2, 'dentro da tolerância de uma batida, estende');
  // Buraco maior que a tolerância (6 min 30 s): intervalo novo.
  await recuar(7);
  await hb('PLAYING');
  assert.strictEqual(await intervalos(), 3, 'batida perdida: intervalo novo');
  const fixo = await pontoFixo();
  const tf = await telaComPlayer(fixo.id);
  await fetch(`${base}/player/${tf.dispositivoId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aparelho-key': tf.chaveAparelho },
    body: JSON.stringify({ estado: 'PLAYING' }),
  });
  ({ rows } = await pool.query(`SELECT COUNT(*)::int n FROM tela_operacao WHERE dispositivo_id = $1`, [tf.telaId]));
  assert.strictEqual(rows[0].n, 0, 'tela de ponto fixo não mede tempo operacional');
});

test('33 a 36. segmentos offline do Player: idempotentes, só estendem, validados, só no móvel, só com credencial', async () => {
  const m = await criarMovel();
  const { telaId, chaveAparelho, dispositivoId } = await telaComPlayer(m.id);
  const enviar = (segmentos, chave = chaveAparelho, disp = dispositivoId) =>
    fetch(`${base}/player/${disp}/operacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(chave ? { 'x-aparelho-key': chave } : {}) },
      body: JSON.stringify({ segmentos }),
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  const seg = (seq, inicioMin, fimMin, bootId = 'b12') => ({
    bootId,
    seq,
    inicio: minutosAtras(inicioMin).toISOString(),
    fim: minutosAtras(fimMin).toISOString(),
  });
  const r1 = await enviar([seg(1, 120, 90)]);
  assert.strictEqual(r1.status, 200);
  assert.deepStrictEqual(r1.json.resultados, [{ bootId: 'b12', seq: 1, status: 'ok' }]);
  await enviar([seg(1, 120, 90)]); // retry
  await enviar([seg(1, 120, 60)]); // o segmento aberto cresceu
  await enviar([seg(1, 110, 80)]); // menor: não encolhe
  const { rows } = await pool.query(
    `SELECT inicio, fim FROM tela_operacao WHERE dispositivo_id = $1 AND origem = 'player'`,
    [telaId],
  );
  assert.strictEqual(rows.length, 1, 'idempotente por (tela, boot, seq)');
  assert.ok(Math.abs(new Date(rows[0].fim) - minutosAtras(60)) < 5000, 'estendeu até o fim maior');
  assert.ok(Math.abs(new Date(rows[0].inicio) - minutosAtras(120)) < 5000);
  const invalidos = await enviar([
    seg(2, 10, 20), // fim antes do início
    seg(3, 400, 10), // mais de 6 h
    { ...seg(4, 1, 0), fim: new Date(Date.now() + 10 * 60_000).toISOString() }, // futuro
    seg(5, 9 * 24 * 60, 9 * 24 * 60 - 5), // mais de 8 dias
    { bootId: 'x y', seq: 6, inicio: 'a', fim: 'b' },
    'lixo',
  ]);
  assert.deepStrictEqual(
    invalidos.json.resultados.map((r) => r.status),
    Array(6).fill('item_invalido'),
  );
  assert.strictEqual((await enviar(Array(201).fill(seg(9, 2, 1)))).status, 400);
  const semLista = await fetch(`${base}/player/${dispositivoId}/operacao`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aparelho-key': chaveAparelho },
    body: JSON.stringify({ segmentos: 'x' }),
  });
  assert.strictEqual(semLista.status, 400);
  assert.strictEqual((await enviar([seg(10, 5, 1)], null)).status, 401, 'sem credencial');
  assert.strictEqual((await enviar([seg(10, 5, 1)], 'chave-errada')).status, 401);
  const fixo = await pontoFixo();
  const tf = await telaComPlayer(fixo.id);
  const ig = await enviar([seg(1, 30, 10)], tf.chaveAparelho, tf.dispositivoId);
  assert.strictEqual(ig.json.resultados[0].status, 'ignorado');
  assert.strictEqual(
    (await pool.query('SELECT 1 FROM tela_operacao WHERE dispositivo_id = $1', [tf.telaId])).rowCount,
    0,
  );
  // A leitura do segmento é pura e testável sozinha.
  assert.strictEqual(operacao.lerSegmento(seg(1, 5, 1), new Date())?.seq, 1);
});

test('37. sem nenhum sinal, o tempo é zero — o servidor nunca inventa horas', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 600);
  assert.strictEqual((await acao(m.id, hid, 'encerrar')).status, 200);
  const h = await linha(hid);
  assert.strictEqual(h.tempo_operacional_segundos, 0);
  assert.strictEqual(h.beneficio_segundos, 0);
  assert.strictEqual(
    (await pool.query('SELECT 1 FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = $1', [hid])).rowCount,
    0,
  );
  const notif = await pool.query(
    `SELECT titulo FROM notificacoes WHERE anunciante_id = $1 AND tipo = 'hospedagem_encerrada'`,
    [anfitria.id],
  );
  assert.match(notif.rows[0].titulo, /terminou/);
});

test('37b. apuração tardia: o tempo offline que chega DEPOIS do encerramento soma, uma vez, só dentro da janela', async () => {
  const m = await criarMovel();
  const { chaveAparelho, dispositivoId } = await telaComPlayer(m.id);
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 300);
  await operou(m.telaId, minutosAtras(290), minutosAtras(190)); // 100 min online
  const r = await acao(m.id, hid, 'encerrar');
  assert.strictEqual(r.status, 200);
  assert.ok(Math.abs(r.json.tempoSegundos - 6000) <= 2);
  // A tela volta à internet depois do encerramento e manda o que exibiu
  // offline: 90 min dentro da janela + 30 min depois do encerramento.
  const enviar = () =>
    fetch(`${base}/player/${dispositivoId}/operacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aparelho-key': chaveAparelho },
      body: JSON.stringify({
        segmentos: [
          { bootId: 'tarde', seq: 1, inicio: minutosAtras(180).toISOString(), fim: minutosAtras(90).toISOString() },
          { bootId: 'tarde', seq: 2, inicio: new Date().toISOString(), fim: new Date().toISOString() },
        ],
      }),
    });
  assert.strictEqual((await enviar()).status, 200);
  assert.strictEqual((await hospedagem.apurarTardias()).apuradas, 1);
  const h = await linha(hid);
  assert.ok(Math.abs(h.tempo_operacional_segundos - 11400) <= 3, `tempo ${h.tempo_operacional_segundos}`);
  assert.strictEqual(h.beneficio_segundos, Math.floor((h.tempo_operacional_segundos * 20) / 100));
  const soma = async () =>
    Number(
      (
        await pool.query(
          `SELECT COALESCE(SUM(segundos), 0) s, COUNT(*)::int n FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = $1`,
          [hid],
        )
      ).rows[0].s,
    );
  assert.strictEqual(await soma(), h.beneficio_segundos, 'o total lançado é o benefício do tempo final');
  // Reenvio e job de novo: nada muda.
  await enviar();
  assert.strictEqual((await hospedagem.apurarTardias()).apuradas, 0);
  assert.strictEqual(await soma(), h.beneficio_segundos);
  assert.strictEqual((await linha(hid)).encerrada_em.getTime(), h.encerrada_em.getTime(), 'a janela não muda');
  // O banco recusa qualquer outra mudança, e recusa diminuir.
  await assert.rejects(pool.query(`UPDATE pontos_moveis_hospedagens SET local = 'x' WHERE id = $1`, [hid]));
  await assert.rejects(
    pool.query(`UPDATE pontos_moveis_hospedagens SET tempo_operacional_segundos = 1 WHERE id = $1`, [hid]),
  );
  const notif = await pool.query(
    `SELECT titulo FROM notificacoes WHERE anunciante_id = $1 AND tipo = 'hospedagem_encerrada' ORDER BY id`,
    [anfitria.id],
  );
  assert.match(notif.rows.at(-1).titulo, /^Mais /);
});

test('37c. vale o estado da tela QUANDO exibiu: offline de quando estava ativa soma mesmo chegando com ela em reparo; o de reparo não; excluir a tela não apaga', async () => {
  const m = await criarMovel();
  const { telaId, chaveAparelho, dispositivoId } = await telaComPlayer(m.id);
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 300);
  await operou(telaId, minutosAtras(290), minutosAtras(230)); // 60 min online
  // O Admin achou que quebrou e pôs em reparo há 150 min (a TV seguia offline).
  await dispositivosRepo.atualizar(telaId, { status: 'reparo' });
  await pool.query(
    `UPDATE tela_eventos SET ocorrido_em = now() - interval '150 minutes'
      WHERE dispositivo_id = $1 AND tipo = 'ADMIN_STATE_CHANGED' AND detalhe->>'para' = 'reparo'`,
    [telaId],
  );
  const hb = await fetch(`${base}/player/${dispositivoId}/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aparelho-key': chaveAparelho },
    body: JSON.stringify({ estado: 'PLAYING' }),
  });
  assert.strictEqual(hb.status, 200);
  const seg = (seq, de, ate) => ({
    bootId: 'rep',
    seq,
    inicio: minutosAtras(de).toISOString(),
    fim: minutosAtras(ate).toISOString(),
  });
  const r1 = await fetch(`${base}/player/${dispositivoId}/operacao`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aparelho-key': chaveAparelho },
    body: JSON.stringify({ segmentos: [seg(1, 200, 170), seg(2, 140, 100), seg(3, 160, 140)] }),
  }).then((r) => r.json());
  assert.deepStrictEqual(
    r1.resultados.map((x) => x.status),
    ['ok', 'ignorado', 'ok'],
    'antes do reparo conta; durante não; o que atravessa é recortado',
  );
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM tela_operacao WHERE dispositivo_id = $1`, [telaId]);
  assert.strictEqual(rows[0].n, 3, 'heartbeat em reparo não grava');
  // Sem FK em ponto_id: o heartbeat (trava a tela) nunca trava o ponto, que
  // as ações do Admin travam antes das telas — ordem oposta = deadlock.
  const { rows: fks } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conrelid = 'tela_operacao'::regclass AND contype = 'f' AND confrelid = 'pontos'::regclass`,
  );
  assert.strictEqual(fks.length, 0);
  // A tela foi excluída: o tempo dela fica com o ponto. 60 + 30 + 10 min.
  await pool.query('DELETE FROM dispositivos WHERE id = $1', [telaId]);
  const r = await acao(m.id, hid, 'encerrar');
  assert.ok(Math.abs(r.json.tempoSegundos - 6000) <= 3, `tempo ${r.json.tempoSegundos}`);
});

// =====================================================================
// Utilização 38–46
// =====================================================================
test('38 e 39. conta SEM plano e com saldo: painel liberado, direito de veicular, sobe peça pela regra do saldo', async () => {
  const { conta } = await contaComSaldo(1200);
  const acesso = await acessoDoPainel(await anunciantesRepo.buscarPorId(conta.id));
  assert.strictEqual(acesso.completo, true);
  assert.strictEqual(acesso.motivo, 'hospedagem');
  assert.strictEqual(acesso.podeVeicular, true);
  const nav = await entrar(conta);
  const me = (await nav('GET', '/anunciantes/me')).json;
  assert.strictEqual(me.acesso_painel.motivo, 'hospedagem');
  const criativos = (await nav('GET', '/anunciantes/me/criativos')).json;
  assert.strictEqual(criativos.temPlano, true, 'não pede "Escolha seu plano"');
  assert.strictEqual(criativos.soSaldoHospedagem, true);
  assert.strictEqual(criativos.limiteCadastro, hospedagem.REGRA_DO_SALDO.limiteCriativos);
  assert.strictEqual(criativos.duracaoMaxima, hospedagem.REGRA_DO_SALDO.duracaoMaximaSegundos);
  const passos = (await nav('GET', '/anunciantes/me/primeiros-passos')).json;
  assert.strictEqual(passos.etapas[0].feito, true);
  assert.match(passos.etapas[0].titulo, /horas de hospedagem/);
  // Controle: sem saldo, o upload continua barrado.
  const semNada = await novaConta();
  const nav2 = await entrar(semNada);
  const up = await fetch(`${base}/anunciantes/${semNada.id}/criativos`, {
    method: 'POST',
    headers: { cookie: '' },
  });
  assert.ok([400, 401].includes(up.status));
  const acesso2 = await acessoDoPainel(await anunciantesRepo.buscarPorId(semNada.id));
  assert.strictEqual(acesso2.completo, false);
  assert.ok(nav2);
});

test('40, 44 e 45. gerador: o saldo entra na rede inteira (camada T3b), com vezes_hospedagem; nunca no próprio móvel do anfitrião', async () => {
  const { conta, movelDaHospedagem } = await contaComSaldo(3000);
  const peca = await pecaAprovada(conta, 15);
  // Um ponto fixo QUALQUER, que a conta nunca escolheu.
  const fixo = await pontoFixo();
  const { telaId } = await telaComPlayer(fixo.id);
  const disp = await dispositivosRepo.buscarComPonto(telaId);
  const hora = new Date();
  const env = await gerador.gerarPlaylistDaHora(disp, hora);
  const daConta = env.itens.filter((i) => i.anuncianteId === conta.id);
  assert.ok(daConta.length >= 1, 'o saldo veicula num ponto que a conta nem escolheu');
  assert.ok(daConta.every((i) => i.criativoId === String(peca.id)));
  const h = new Date(hora);
  h.setMinutes(0, 0, 0);
  const { rows } = await pool.query(
    `SELECT vezes_programadas, vezes_hospedagem, vezes_banco FROM exibicoes_contador
      WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3`,
    [conta.id, telaId, h],
  );
  assert.strictEqual(rows[0].vezes_hospedagem, rows[0].vezes_programadas, 'tudo dela é da camada de hospedagem');
  assert.ok(rows[0].vezes_hospedagem <= Math.floor(hospedagem.REGRA_DO_SALDO.segundosPorHora / 15));
  // Hospedando de novo: no próprio móvel, não ganha veiculação gratuita.
  const hid = await programarOk(movelDaHospedagem.id, conta);
  await acao(movelDaHospedagem.id, hid, 'iniciar');
  const { telaId: telaMovel } = await telaComPlayer(movelDaHospedagem.id);
  const env2 = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(telaMovel), new Date());
  assert.ok(!env2.itens.some((i) => i.anuncianteId === conta.id), 'anfitrião fora do próprio móvel');
});

test('40b. a vaga de saldo reservada na hora toca a hora inteira, mesmo com o saldo todo reservado', async () => {
  const { conta } = await contaComSaldo(600);
  await pecaAprovada(conta, 15);
  const fixo = await pontoFixo();
  const { telaId } = await telaComPlayer(fixo.id);
  const disp = await dispositivosRepo.buscarComPonto(telaId);
  const hora = new Date();
  const primeira = (await gerador.gerarPlaylistDaHora(disp, hora)).itens.filter((i) => i.anuncianteId === conta.id);
  assert.ok(primeira.length >= 1);
  // Todo o resto do saldo some (o que sobrou ficou reservado na grade):
  // a conta já não está em `saldosParaProgramar`.
  const s = await hospedagem.saldoDaConta(conta.id);
  await pool.query(
    `INSERT INTO saldo_hospedagem_lancamentos (conta_id, tipo, segundos, chave, motivo, admin)
     VALUES ($1, 'ajuste', $2, $3, 'teste', 'teste')`,
    [conta.id, -s.paraProgramarSegundos, `ajuste:teste:${randomUUID()}`],
  );
  assert.strictEqual((await hospedagem.saldosParaProgramar())[conta.id], undefined);
  // O Player busca de novo 15 min depois: a vaga continua lá.
  const segunda = (await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(telaId), hora)).itens.filter(
    (i) => i.anuncianteId === conta.id,
  );
  assert.strictEqual(segunda.length, primeira.length, 'a reserva da hora não vira vaga vazia');
});

test('40c. a base guarda o móvel e não perde o próprio saldo nele — só o anfitrião da hospedagem ativa fica de fora', async () => {
  // Com ramo: o móvel na base fica com o ramo da base — e a base não é
  // concorrente de si mesma.
  const ramo = await novaCategoria('Base');
  const { conta } = await contaComSaldo(600, { categoriaId: ramo });
  await pecaAprovada(conta, 15);
  const naBase = await criarMovel({ contaBase: conta });
  const { telaId } = await telaComPlayer(naBase.id);
  const env = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(telaId), new Date());
  assert.ok(
    env.itens.some((i) => i.anuncianteId === conta.id),
    'na base, o saldo da própria base roda',
  );
});

test('41. prioridade: pago > Básico > recuperação > saldo de hospedagem > institucional (o gratuito nunca tira o pago)', () => {
  const cheia = montarHoraDeTv(
    [
      { id: 1, frequenciaBase: 240, duracaoSegundos: 15 }, // 3600 s pagos
      { id: 2, hospedagem: 9, duracaoSegundos: 15 },
    ],
    'semente',
  );
  assert.strictEqual(cheia.programados[1], 240);
  assert.strictEqual(cheia.hospedagemProgramados[2] || 0, 0, 'hora vendida: nada de hospedagem');
  const comBanco = montarHoraDeTv(
    [
      { id: 1, frequenciaBase: 200, banco: 30, duracaoSegundos: 15 }, // 3450 s
      { id: 2, hospedagem: 9, duracaoSegundos: 15 },
    ],
    'semente',
  );
  assert.strictEqual(comBanco.bancoProgramados[1], 30, 'a devolução de atraso pago vem antes');
  assert.strictEqual(comBanco.hospedagemProgramados[2], 9, 'a hospedagem fica com o resto');
  const vazia = montarHoraDeTv([{ id: 2, hospedagem: 9, duracaoSegundos: 15 }], 'semente');
  assert.strictEqual(vazia.hospedagemProgramados[2], 9);
  assert.ok(vazia.qtdInstitucional > 0, 'o que sobra ainda é institucional');
  assert.strictEqual(vazia.segundosHospedagem, 135);
  // Mídia própria (Mostraí) vem DEPOIS do saldo de hospedagem (§31, item 5).
  const comPropria = montarHoraDeTv(
    [
      { id: 1, frequenciaBase: 200, duracaoSegundos: 15 }, // 3000 s pagos
      { id: 'midia:7', propria: 40, duracaoSegundos: 15 }, // quer 600 s
      { id: 2, hospedagem: 9, duracaoSegundos: 15 }, // 135 s
    ],
    'semente',
  );
  assert.strictEqual(comPropria.programados[1], 200, 'a mídia própria nunca tira o pago');
  assert.strictEqual(comPropria.hospedagemProgramados[2], 9, 'o saldo vem antes da mídia própria');
  assert.strictEqual(comPropria.programados['midia:7'], 31, 'a mídia própria fica com o resto (465 s)');
  assert.strictEqual(comPropria.qtdInstitucional, 0);
});

test('42 e 43. Proof-of-Play derruba o saldo; a confirmação conta primeiro para o pago, por último para a hospedagem', async () => {
  const { conta } = await contaComSaldo(1200);
  const fixo = await pontoFixo();
  const { telaId } = await telaComPlayer(fixo.id);
  const h = horaCheia();
  // 2 exibições normais (pagas) + 2 de hospedagem, duração 15 s.
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_hospedagem,
                                     duracao_segundos)
     VALUES ($1, $2, $3, 4, 2, 15)`,
    [conta.id, telaId, h],
  );
  const antes = await hospedagem.saldoDaConta(conta.id);
  assert.strictEqual(antes.reservadoSegundos, 30, 'programado e não confirmado fica reservado');
  assert.strictEqual(antes.entregueSegundos, 0);
  // 3 confirmações (o caminho real do POP, com a hora congelada, é o do
  // E2E §78; aqui o que se mede é a ATRIBUIÇÃO por posição).
  await pool.query(
    'UPDATE exibicoes_contador SET vezes_confirmadas = 3 WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3',
    [conta.id, telaId, h],
  );
  const { rows: partes } = await pool.query(
    `SELECT ${require('../src/lib/partes-da-hora').confirmadasPagasSql('')} AS pagas,
            ${require('../src/lib/partes-da-hora').confirmadasHospedagemSql('')} AS hosp
       FROM exibicoes_contador WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3`,
    [conta.id, telaId, h],
  );
  assert.deepStrictEqual(partes[0], { pagas: 2, hosp: 1 }, 'o pago fica com as primeiras');
  const depois = await hospedagem.saldoDaConta(conta.id);
  assert.strictEqual(depois.entregueSegundos, 15, '3 confirmadas: 2 pagas + 1 da hospedagem');
  assert.strictEqual(depois.disponivelSegundos, antes.disponivelSegundos - 15);
  assert.strictEqual(depois.reservadoSegundos, 15);
  // Passado o prazo do POP offline, o não confirmado volta ao saldo.
  await pool.query(
    `UPDATE exibicoes_contador SET janela_hora = janela_hora - interval '9 days' WHERE anunciante_id = $1 AND dispositivo_id = $2`,
    [conta.id, telaId],
  );
  assert.strictEqual((await hospedagem.saldoDaConta(conta.id)).reservadoSegundos, 0);
});

test('46. hospedar não dá Plano Básico, crédito nem cupom ao anfitrião', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 60);
  await operou(m.telaId, minutosAtras(50), minutosAtras(10));
  await require('../src/pontos/basico').sincronizar({ apenasPontos: [m.id] });
  await require('../src/creditos/ponto').concederCreditosMensais({ apenasPontos: [m.id] });
  await acao(m.id, hid, 'encerrar');
  for (const [sql, nome] of [
    ['SELECT 1 FROM beneficios_basico_ponto WHERE conta_id = $1', 'Básico'],
    ['SELECT 1 FROM creditos_ledger WHERE anunciante_id = $1', 'crédito'],
    ['SELECT 1 FROM cupons_ponto WHERE conta_id = $1', 'cupom'],
  ]) {
    assert.strictEqual((await pool.query(sql, [anfitria.id])).rowCount, 0, `sem ${nome}`);
  }
  const { rows } = await pool.query('SELECT papeis, plano_id FROM anunciantes WHERE id = $1', [anfitria.id]);
  assert.ok(!rows[0].papeis.includes('ponto'));
  assert.strictEqual(rows[0].plano_id, null);
});

// =====================================================================
// Concorrência 47–52
// =====================================================================
test('47 a 52. trava de concorrente pelo contexto comercial: anfitrião, base ou o contexto do evento', async () => {
  const ramoBase = await novaCategoria('Academia');
  const ramoAnfitriao = await novaCategoria('Tabacaria');
  const ramoEvento = await novaCategoria('Bebidas');
  const base = await novaConta({ categoriaId: ramoBase });
  const m = await criarMovel({ contaBase: base });
  const { telaId } = await telaComPlayer(m.id);
  const ctx = async () => {
    const d = await dispositivosRepo.buscarComPonto(telaId);
    return { categoria: d.categoria_id, casa: d.casa_conta_id };
  };
  assert.deepStrictEqual(await ctx(), { categoria: ramoBase, casa: base.id }, '48. na base: ramo e casa da base');
  // Concorrente do anfitrião, com saldo de hospedagem e com plano.
  const anfitria = await novaConta({ categoriaId: ramoAnfitriao });
  const { conta: concorrenteSaldo } = await contaComSaldo(1200, { categoriaId: ramoAnfitriao });
  await pecaAprovada(concorrenteSaldo);
  const hid = await programarOk(m.id, anfitria);
  await acao(m.id, hid, 'iniciar');
  assert.deepStrictEqual(await ctx(), { categoria: ramoAnfitriao, casa: anfitria.id }, '47 e 50. hospedagem');
  const env = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(telaId), new Date());
  assert.ok(!env.itens.some((i) => i.anuncianteId === concorrenteSaldo.id), '51. a trava vale para o saldo também');
  await acao(m.id, hid, 'encerrar');
  assert.deepStrictEqual(await ctx(), { categoria: ramoBase, casa: base.id }, '52. de volta: o da base');
  // Evento com contexto próprio; e evento sem contexto não herda a base.
  const ev = await admin('POST', `/admin/pontos/${m.id}/eventos`, {
    nome: 'Festival',
    organizacao: 'X',
    local: 'Parque',
    data_inicio: hojeMais(0),
    categoria_id: ramoEvento,
  });
  assert.strictEqual(ev.status, 201, JSON.stringify(ev.json));
  await admin('POST', `/admin/pontos/${m.id}/eventos/${ev.json.id}/iniciar`);
  assert.deepStrictEqual(await ctx(), { categoria: ramoEvento, casa: null }, '49. evento: o contexto dele');
  await admin('POST', `/admin/pontos/${m.id}/eventos/${ev.json.id}/encerrar`);
  const semCtx = await admin('POST', `/admin/pontos/${m.id}/eventos`, {
    nome: 'Corrida',
    organizacao: 'X',
    local: 'Rua',
    data_inicio: hojeMais(0),
  });
  await admin('POST', `/admin/pontos/${m.id}/eventos/${semCtx.json.id}/iniciar`);
  assert.deepStrictEqual(
    await ctx(),
    { categoria: null, casa: null },
    '49. sem contexto: sem trava, sem herdar a base',
  );
  await admin('POST', `/admin/pontos/${m.id}/eventos/${semCtx.json.id}/encerrar`);
  const invalida = await admin('POST', `/admin/pontos/${m.id}/eventos`, {
    nome: 'X',
    organizacao: 'X',
    local: 'X',
    data_inicio: hojeMais(20),
    categoria_id: 'abc',
  });
  assert.strictEqual(invalida.status, 400);
});

// =====================================================================
// Site 53–59
// =====================================================================
const INTERESSE = () => ({
  empresa: `Tabacaria ${randomUUID().slice(0, 6)}`,
  responsavel: 'Joana',
  contato_telefone: `(16) 9${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
  contato_email: 'joana@example.com',
  cep: '15990-000',
  logradouro: 'Rua Sete',
  numero: '70',
  bairro: 'Centro',
  cidade: 'Matão',
  uf: 'SP',
  segmento: 'tabacaria',
  observacao: 'tenho espaço na vitrine',
});

async function interessePorTelefone(telefone) {
  const { rows } = await pool.query('SELECT * FROM hospedagem_interesses WHERE contato_telefone = $1', [
    telefone.replace(/\D/g, ''),
  ]);
  for (const r of rows) criadas.interesses.push(r.id);
  return rows;
}

test('53 a 57. interesse público: só manifestação, validado, sem duplicar, robô descartado, Admin avisado', async () => {
  const anon = navegador(`10.9.${Math.floor(Math.random() * 250)}.1`);
  const dados = INTERESSE();
  const r = await anon('POST', '/hospedagem/interesse', dados);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const [i] = await interessePorTelefone(dados.contato_telefone);
  assert.strictEqual(i.status, 'nova');
  assert.strictEqual(i.conta_id, null, 'visitante não ganha conta');
  assert.strictEqual(i.origem, 'publico');
  assert.match(i.endereco, /Rua Sete, 70/);
  const pend = await pool.query(`SELECT 1 FROM pendencias WHERE chave = $1 AND resolvido_em IS NULL`, [
    `HOSPEDAGEM_INTERESSE:${i.id}`,
  ]);
  assert.strictEqual(pend.rowCount, 1, 'o Admin vê na Visão geral');
  assert.strictEqual((await anon('POST', '/hospedagem/interesse', dados)).status, 201);
  assert.strictEqual((await interessePorTelefone(dados.contato_telefone)).length, 1, 'não duplica');
  for (const [campo, valor] of [
    ['contato_telefone', '123'],
    ['empresa', ''],
    ['cep', ''],
    ['contato_email', 'nao-e-email'],
  ]) {
    const ruim = await anon('POST', '/hospedagem/interesse', { ...INTERESSE(), [campo]: valor });
    assert.strictEqual(ruim.status, 400, `${campo} inválido`);
  }
  const robo = INTERESSE();
  assert.strictEqual((await anon('POST', '/hospedagem/interesse', { ...robo, site: 'http://spam' })).status, 201);
  assert.strictEqual((await interessePorTelefone(robo.contato_telefone)).length, 0, 'campo-armadilha: não grava');
  const { rows: hosp } = await pool.query(
    'SELECT COUNT(*)::int n FROM pontos_moveis_hospedagens WHERE interesse_id = $1',
    [i.id],
  );
  assert.strictEqual(hosp[0].n, 0, 'interesse não reserva equipamento');
});

test('58. interesse com sessão: vai com a conta da SESSÃO (nunca a do corpo)', async () => {
  const conta = await novaConta();
  const outra = await novaConta();
  const nav = await entrar(conta);
  const dados = { ...INTERESSE(), conta_id: outra.id };
  assert.strictEqual((await nav('POST', '/hospedagem/interesse', dados)).status, 201);
  const [i] = await interessePorTelefone(dados.contato_telefone);
  assert.strictEqual(i.conta_id, conta.id);
});

test('59. site: página própria, separada de "Tornar-se ponto", percentual lido do servidor, sem "aluguel"', () => {
  const pub = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
  const pagina = pub('hospedar.html');
  const script = pub('hospedar.page.js');
  const home = pub('index.html');
  assert.match(pagina, /Hospede temporariamente um Ponto Móvel Mostraí/);
  assert.match(home, /Hospede temporariamente um Ponto Móvel Mostraí/);
  assert.match(script, /\/hospedagem\/condicao/);
  assert.match(pub('index.page.js'), /\/hospedagem\/condicao/);
  for (const texto of [pagina, home, pub('hospedagem-conta.js')]) {
    assert.doesNotMatch(texto, /alug/i, 'não é aluguel');
    assert.doesNotMatch(texto, /\b20 ?%/, 'nenhum percentual escrito à mão');
  }
  assert.match(script, /\/hospedagem\/interesse/);
  assert.doesNotMatch(script, /candidatura|conta\/modos|anunciantes\/me\/pontos/i, 'não é o fluxo de ser ponto');
  assert.doesNotMatch(pagina, /audiência garantida|garantimos/i);
});

// =====================================================================
// Painel 60–67
// =====================================================================
test('60 a 63. painel do anfitrião: programada, em andamento (estimado) e concluída — só as dele', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const nav = await entrar(anfitria);
  const futura = await programarOk(m.id, anfitria, { data_inicio: hojeMais(5), data_fim: hojeMais(6) });
  let d = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  assert.strictEqual(d.hospedagens[0].estado, 'programada');
  assert.strictEqual(d.hospedagens[0].id, Number(futura));
  assert.strictEqual(d.saldo.disponivelSegundos, 0);
  assert.strictEqual(d.percentual, 20);
  await acao(m.id, futura, 'cancelar');
  const hid = await hospedagemAtiva(m, anfitria, 120);
  await operou(m.telaId, minutosAtras(100), minutosAtras(40));
  d = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  const ativa = d.hospedagens.find((h) => h.id === Number(hid));
  assert.strictEqual(ativa.estado, 'ativa');
  assert.ok(Math.abs(ativa.tempoSegundos - 3600) <= 2);
  assert.strictEqual(ativa.beneficioEstimadoSegundos, Math.floor((ativa.tempoSegundos * 20) / 100));
  assert.ok(!d.hospedagens.some((h) => h.estado === 'cancelada'), 'cancelada não aparece no painel');
  await acao(m.id, hid, 'encerrar');
  d = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  const fim = d.hospedagens.find((h) => h.id === Number(hid));
  assert.strictEqual(fim.estado, 'encerrada');
  assert.strictEqual(fim.beneficioSegundos, 720);
  assert.strictEqual(d.saldo.disponivelSegundos, 720);
  // Outra conta não vê nada disso.
  const outra = await novaConta();
  const navOutra = await entrar(outra);
  const dOutra = (await navOutra('GET', '/anunciantes/me/hospedagem')).json;
  assert.deepStrictEqual(dOutra.hospedagens, []);
  assert.strictEqual(dOutra.saldo.disponivelSegundos, 0);
  assert.strictEqual((await navegador()('GET', '/anunciantes/me/hospedagem')).status, 401);
  assert.strictEqual((await nav('GET', `/admin/anunciantes/${anfitria.id}/saldo-hospedagem`)).status, 401);
});

test('64. "Tenho interesse" pelo painel: dados do cadastro, sem escolher equipamento, período ou percentual', async () => {
  const conta = await novaConta();
  const nav = await entrar(conta);
  const r = await nav('POST', '/anunciantes/me/hospedagem/interesse', {
    observacao: 'pode ser em novembro',
    percentual: 90,
    ponto_id: 1,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual(r.json.jaRecebido, false);
  const { rows } = await pool.query('SELECT * FROM hospedagem_interesses WHERE conta_id = $1', [conta.id]);
  criadas.interesses.push(rows[0].id);
  assert.strictEqual(rows[0].empresa, conta.nome_empresa);
  assert.strictEqual(rows[0].origem, 'painel');
  assert.strictEqual(rows[0].contato_telefone, '16999990000');
  assert.strictEqual(rows[0].observacao, 'pode ser em novembro');
  const de2 = await nav('POST', '/anunciantes/me/hospedagem/interesse', {});
  assert.strictEqual(de2.json.jaRecebido, true);
  const d = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  assert.strictEqual(d.interesseAberto.status, 'nova');
  // Admin: em contato → agenda com a hospedagem → "agendada".
  assert.strictEqual(
    (await admin('PATCH', `/admin/hospedagem/interesses/${rows[0].id}`, { status: 'em_contato' })).status,
    200,
  );
  const m = await criarMovel();
  const hidI = await programarOk(m.id, conta, { interesse_id: rows[0].id });
  const { rows: depois } = await pool.query('SELECT status FROM hospedagem_interesses WHERE id = $1', [rows[0].id]);
  assert.strictEqual(depois[0].status, 'agendada');
  assert.strictEqual(
    (await admin('PATCH', `/admin/hospedagem/interesses/${rows[0].id}`, { status: 'recusada' })).status,
    409,
  );
  // O mesmo interesse não agenda duas hospedagens.
  const outro = await criarMovel();
  assert.strictEqual((await programar(outro.id, conta, { interesse_id: rows[0].id })).status, 409);
  // A hospedagem não aconteceu (cancelada): o interesse volta e agenda de novo.
  assert.strictEqual((await acao(m.id, hidI, 'cancelar')).status, 200);
  const { rows: voltou } = await pool.query('SELECT status FROM hospedagem_interesses WHERE id = $1', [rows[0].id]);
  assert.strictEqual(voltou[0].status, 'em_contato');
  assert.strictEqual((await programar(outro.id, conta, { interesse_id: rows[0].id })).status, 201);
  // Cadastro incompleto (endereço antigo, sem bairro, telefone com +55) não
  // trava o interesse pelo painel — o painel não tem como corrigir.
  const antiga = await novaConta();
  await pool.query(
    `UPDATE anunciantes SET logradouro = NULL, numero = NULL, bairro = NULL, endereco = 'Rua Velha, 10',
            contato_telefone = '+55 (16) 99999-0000' WHERE id = $1`,
    [antiga.id],
  );
  const r2 = await (await entrar(antiga))('POST', '/anunciantes/me/hospedagem/interesse', {});
  assert.strictEqual(r2.status, 201, JSON.stringify(r2.json));
  const { rows: dela } = await pool.query('SELECT * FROM hospedagem_interesses WHERE conta_id = $1', [antiga.id]);
  criadas.interesses.push(dela[0].id);
  assert.strictEqual(dela[0].contato_telefone, '16999990000');
  assert.match(dela[0].endereco, /Rua Velha, 10/);
});

test('65 e 66. card do anunciante: "agora em" o anfitrião, sem conta, percentual, saldo ou histórico', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta({ nome: `Tabacaria Pública ${randomUUID().slice(0, 4)}` });
  const hid = await hospedagemAtiva(m, anfitria, 30);
  const situacao = (await movel.situacaoDosMoveis([m.id])).get(m.id);
  assert.strictEqual(situacao.localAtual.origem, 'hospedagem');
  assert.strictEqual(situacao.localAtual.nome, anfitria.nome_empresa);
  const texto = JSON.stringify(situacao);
  assert.doesNotMatch(texto, /percentual|conta_?id|saldo|beneficio|"conta"/i);
  const chaves = [];
  JSON.parse(texto, (k, v) => {
    chaves.push(k);
    return v;
  });
  assert.ok(!chaves.some((k) => /conta|anfitri/i.test(k)), `chaves: ${chaves.join(',')}`);
  const publico = await navegador()('GET', '/pontos');
  const daLista = publico.json.find((p) => p.id === m.id);
  if (daLista) assert.doesNotMatch(JSON.stringify(daLista), /percentual|hospedagem|saldo/i);
  // Hospedagem futura não aparece no card.
  await acao(m.id, hid, 'encerrar');
  await programarOk(m.id, await novaConta(), { data_inicio: hojeMais(4), data_fim: hojeMais(5) });
  assert.strictEqual((await movel.situacaoDosMoveis([m.id])).get(m.id).localAtual.origem, 'base');
});

test('67. conta não forja nada: rotas do móvel e da hospedagem exigem o Admin', async () => {
  const conta = await novaConta();
  const nav = await entrar(conta);
  const m = await criarMovel();
  for (const [metodo, caminho, corpo] of [
    ['GET', '/admin/pontos-moveis'],
    [
      'POST',
      `/admin/pontos/${m.id}/hospedagens`,
      { conta_id: conta.id, data_inicio: hojeMais(0), data_fim: hojeMais(1) },
    ],
    ['POST', `/admin/pontos/${m.id}/hospedagens/1/encerrar`],
    ['PUT', '/admin/hospedagem/percentual', { percentual: 100 }],
    ['GET', '/admin/hospedagem/interesses'],
    ['POST', `/admin/anunciantes/${conta.id}/saldo-hospedagem/ajustes`, { minutos: 600, motivo: 'eu mesmo' }],
  ]) {
    assert.strictEqual((await nav(metodo, caminho, corpo)).status, 401, `${metodo} ${caminho}`);
  }
  assert.strictEqual((await hospedagem.saldoDaConta(conta.id)).disponivelSegundos, 0);
});

// =====================================================================
// E2E §78 e §80
// =====================================================================
test('E2E §78: Móvel #01 → interesse → hospedagem 20% → operação → encerramento → horas → mídia sem plano → POP → saldo cai', async () => {
  // Admin cria o móvel (tela, base).
  const m = await criarMovel();
  const { telaId, chaveAparelho, dispositivoId } = await telaComPlayer(m.id);
  // Uma tabacaria demonstra interesse pelo site e cria conta.
  const tabacaria = await novaConta({ nome: `Tabacaria E2E ${randomUUID().slice(0, 4)}` });
  const nav = await entrar(tabacaria);
  const dados = INTERESSE();
  assert.strictEqual((await nav('POST', '/hospedagem/interesse', dados)).status, 201);
  const [interesse] = await interessePorTelefone(dados.contato_telefone);
  // Admin agenda 3 dias; percentual congelado em 20%.
  const hid = await programarOk(m.id, tabacaria, {
    data_inicio: hojeMais(0),
    data_fim: hojeMais(2),
    interesse_id: interesse.id,
  });
  assert.strictEqual(Number((await linha(hid)).percentual), 20);
  assert.strictEqual((await acao(m.id, hid, 'iniciar')).status, 200);
  await pool.query('UPDATE pontos_moveis_hospedagens SET iniciada_em = $2 WHERE id = $1', [hid, minutosAtras(400)]);
  // O Player opera: 5 h online (heartbeat) + 1 h offline contada pelo Player.
  await operou(telaId, minutosAtras(390), minutosAtras(90));
  const off = await fetch(`${base}/player/${dispositivoId}/operacao`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-aparelho-key': chaveAparelho },
    body: JSON.stringify({
      segmentos: [
        { bootId: 'e2e', seq: 1, inicio: minutosAtras(80).toISOString(), fim: minutosAtras(20).toISOString() },
      ],
    }),
  });
  assert.strictEqual(off.status, 200);
  // Encerra: volta para a base, benefício calculado, horas na conta.
  const fim = await acao(m.id, hid, 'encerrar');
  assert.strictEqual(fim.status, 200);
  assert.ok(Math.abs(fim.json.tempoSegundos - 6 * 3600) <= 2, `6 h (${fim.json.tempoSegundos}s)`);
  assert.strictEqual(fim.json.beneficioSegundos, Math.floor((fim.json.tempoSegundos * 20) / 100));
  assert.strictEqual((await movel.situacaoDosMoveis([m.id])).get(m.id).localAtual.origem, 'base');
  const saldo = (await nav('GET', '/anunciantes/me/hospedagem')).json.saldo.disponivelSegundos;
  assert.strictEqual(saldo, fim.json.beneficioSegundos);
  // Sem plano, a conta usa as horas: peça aprovada → gerador distribui → POP.
  assert.strictEqual((await nav('GET', '/anunciantes/me')).json.acesso_painel.podeVeicular, true);
  await pecaAprovada(tabacaria, 15);
  const fixo = await pontoFixo();
  const tf = await telaComPlayer(fixo.id);
  const env = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(tf.telaId), new Date());
  const item = env.itens.find((i) => i.anuncianteId === tabacaria.id);
  assert.ok(item, 'a tabacaria entra na playlist da rede');
  const pop = await execucoesRepo.confirmarComDedup(
    tf.telaId,
    {
      execucaoId: randomUUID(),
      janelaId: env.janelaId,
      itemProgramacaoId: item.itemProgramacaoId,
      criativoId: item.criativoId,
      iniciadoEm: new Date().toISOString(),
      terminadoEm: new Date().toISOString(),
    },
    new Date(),
  );
  assert.strictEqual(pop.status, 'contabilizado');
  const depois = (await nav('GET', '/anunciantes/me/hospedagem')).json.saldo.disponivelSegundos;
  assert.strictEqual(depois, saldo - 15, 'o saldo cai pelo que a TV confirmou');
});

test('E2E §80: offline → reconecta → sincroniza duas vezes → sem duplicar → benefício certo', async () => {
  const m = await criarMovel();
  const { chaveAparelho, dispositivoId } = await telaComPlayer(m.id);
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 300);
  const lote = {
    segmentos: [
      { bootId: 'b1', seq: 1, inicio: minutosAtras(290).toISOString(), fim: minutosAtras(230).toISOString() },
      { bootId: 'b1', seq: 2, inicio: minutosAtras(220).toISOString(), fim: minutosAtras(160).toISOString() },
      // Reinício do aparelho: boot novo, seq recomeça.
      { bootId: 'b2', seq: 1, inicio: minutosAtras(150).toISOString(), fim: minutosAtras(90).toISOString() },
    ],
  };
  const enviar = () =>
    fetch(`${base}/player/${dispositivoId}/operacao`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-aparelho-key': chaveAparelho },
      body: JSON.stringify(lote),
    });
  assert.strictEqual((await enviar()).status, 200);
  assert.strictEqual((await enviar()).status, 200, 'retry depois de a resposta se perder');
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM tela_operacao WHERE dispositivo_id = $1`, [m.telaId]);
  assert.strictEqual(rows[0].n, 3);
  const r = await acao(m.id, hid, 'encerrar');
  assert.ok(Math.abs(r.json.tempoSegundos - 3 * 3600) <= 2);
  assert.strictEqual(r.json.beneficioSegundos, Math.floor((r.json.tempoSegundos * 20) / 100));
});
