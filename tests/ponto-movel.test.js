const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// PONTO FIXO E PONTO MÓVEL (migrations 112 e 113, src/pontos/movel.js). V2
// (02/10/2026): o móvel nasce só pelo Admin (POST /admin/pontos-moveis), com
// a Tela 1; candidatura gera sempre fixo; o tipo não muda. Roda o `app`
// REAL (src/server.js): a guarda do /admin, o login do admin e o do
// anunciante de verdade. Cada teste cria as próprias contas e pontos — os
// arquivos de teste rodam em paralelo no mesmo banco.
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-ponto-movel';
const app = require('../src/server');
const movel = require('../src/pontos/movel');
const basico = require('../src/pontos/basico');
const creditosPonto = require('../src/creditos/ponto');
const dispositivosRepo = require('../src/dispositivos/repository');
const execucoesRepo = require('../src/playlist/execucoes-repository');
const gerador = require('../src/playlist/gerador');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const candidaturasRepo = require('../src/candidaturas/repository');
const { meusPontosDaConta } = require('../src/pontos/meus-pontos');
const { instalarPlayer, tirarDoSorteio } = require('./apoio-player');

const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const SENHA = 'Senha12@teste';
const criadas = { contas: [], pontos: [], categorias: [] };
let base;
let servidor;
let admin;

function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo) {
    const cookie = [...potes.entries()]
      .filter(([, c]) => caminho.startsWith(c.path))
      .map(([nome, c]) => `${nome}=${c.valor}`)
      .join('; ');
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...(cookie ? { cookie } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const path = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor: resto.join('='), path });
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

test.after(async () => {
  // Métrica do login/aprovação ainda gravando: espera antes de apagar a conta.
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criadas.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(
      'DELETE FROM saldo_hospedagem_lancamentos WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1)',
      [id],
    );
    // Termo/equipamento da hospedagem de teste (o aceite é imutável: o
    // gatilho sai só durante a limpeza).
    await pool.query('ALTER TABLE hospedagem_aceites DISABLE TRIGGER hospedagem_aceite_imutavel');
    await pool.query(
      `DELETE FROM hospedagem_aceites WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1)`,
      [id],
    );
    await pool.query('ALTER TABLE hospedagem_aceites ENABLE TRIGGER hospedagem_aceite_imutavel');
    await pool.query(
      `DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1)`,
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
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  for (const id of criadas.contas) {
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
  for (const id of criadas.categorias) await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// ---------- fixtures ----------
async function novaConta({ categoriaId = null, nome = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, logradouro, numero, bairro, endereco, cidade, uf, cep, categoria_id)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true,
             'Rua das Flores', '10', 'Centro', 'Rua das Flores, 10', 'Matão', 'SP', '15990000', $5)
     RETURNING *`,
    [
      nome || `Movel ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `movel-${randomUUID()}@example.com`,
      await gerarHash(SENHA),
      categoriaId,
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

const HORARIO_DA_BASE = {
  seg: { abre: '06:00', fecha: '22:00' },
  ter: { abre: '06:00', fecha: '22:00' },
  qua: { abre: '06:00', fecha: '22:00' },
  qui: { abre: '06:00', fecha: '22:00' },
  sex: { abre: '06:00', fecha: '22:00' },
  sab: { abre: '08:00', fecha: '12:00' },
  dom: null,
};

async function novaCandidatura(conta, extra = {}) {
  return candidaturasRepo.criar({
    tipo: 'ponto',
    nome: 'Responsável Teste',
    contato_telefone: '16988880000',
    nome_comercio: `Academia ${randomUUID().slice(0, 8)}`,
    logradouro: 'Avenida Brasil',
    numero: String(100 + Math.floor(Math.random() * 800)),
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'academia',
    fluxo_estimado_mensal: 600,
    horario_semanal: HORARIO_DA_BASE,
    conta_id: conta.id,
    origem: 'painel',
    ...extra,
  });
}

async function pontoDaCandidatura(candId) {
  const { rows } = await pool.query('SELECT * FROM pontos WHERE candidatura_id = $1', [candId]);
  if (rows[0]) criadas.pontos.push(rows[0].id);
  return rows[0] || null;
}

async function aprovar(conta, corpo) {
  const cand = await novaCandidatura(conta);
  const r = await admin('POST', `/admin/candidaturas/${cand.id}/liberar`, corpo);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return pontoDaCandidatura(cand.id);
}

// O móvel nasce pelo Admin (V2): base com nome, endereço, conta (opcional) e
// horário; a Tela 1 nasce junto.
async function criarMovel(contaBase, extra = {}) {
  const r = await admin('POST', '/admin/pontos-moveis', {
    base_conta_id: contaBase ? contaBase.id : null,
    base_nome: `Academia ${randomUUID().slice(0, 8)}`,
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
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [r.json.id]);
  return { ...rows[0], telaId: r.json.telaId };
}
const aprovarMovel = (conta) => criarMovel(conta);

// Tela instalada: no móvel, a Tela 1 que nasceu com ele (1 móvel = 1 tela);
// no fixo, uma tela nova.
async function telaInstalada(pontoId) {
  const { rows: existente } = await pool.query(
    `UPDATE dispositivos SET status = 'ativo', chave_hash = md5(random()::text) || md5(random()::text)
      WHERE id = (SELECT d.id FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
                   WHERE d.ponto_id = $1 AND p.tipo = 'movel' AND d.status <> 'inativo' ORDER BY d.id LIMIT 1)
      RETURNING id`,
    [pontoId],
  );
  if (existente[0]) return existente[0].id;
  const { rows } = await pool.query(
    `INSERT INTO dispositivos (ponto_id, apelido, status, chave_hash)
     VALUES ($1, 'Tela', 'ativo', md5(random()::text) || md5(random()::text)) RETURNING id`,
    [pontoId],
  );
  return rows[0].id;
}

const hojeMais = (dias) => {
  const d = new Date(`${movel.hojeEmMatao()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

async function cadastrarEvento(pontoId, extra = {}) {
  const r = await admin('POST', `/admin/pontos/${pontoId}/eventos`, {
    nome: 'Campeonato Regional de Jiu-Jitsu',
    organizacao: 'Federação Regional',
    local: 'Ginásio Municipal',
    data_inicio: hojeMais(5),
    data_fim: hojeMais(6),
    publico_estimado: 600,
    ...extra,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

const ficha = async (pontoId) => (await admin('GET', `/admin/pontos/${pontoId}/movel`)).json;
const acaoNoEvento = (pontoId, eventoId, acao) => admin('POST', `/admin/pontos/${pontoId}/eventos/${eventoId}/${acao}`);

// ---------- 1. compatibilidade ----------
test('1. ponto existente (sem tipo informado) continua fixo, sem base', async () => {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '16 9') RETURNING *`,
    [`Ponto Antigo ${randomUUID()}`],
  );
  criadas.pontos.push(rows[0].id);
  assert.strictEqual(rows[0].tipo, 'fixo');
  assert.strictEqual(rows[0].base_conta_id, null);
  assert.strictEqual(rows[0].base_nome, null);
  assert.strictEqual((await ficha(rows[0].id)).tipo, 'fixo');
});

// ---------- 2 e 3. aprovação ----------
test('2. Admin aprova candidatura sem dizer o tipo: nasce FIXO, a conta é a dona (como sempre)', async () => {
  const conta = await novaConta();
  const ponto = await aprovar(conta);
  assert.strictEqual(ponto.tipo, 'fixo');
  assert.strictEqual(ponto.anunciante_id, conta.id);
  assert.strictEqual(ponto.base_conta_id, null);
  const { rows } = await pool.query('SELECT papeis FROM anunciantes WHERE id = $1', [conta.id]);
  assert.ok(rows[0].papeis.includes('ponto'), 'fixo continua ligando o papel de dono');
});

test('2b. tipo explícito "fixo" e tipo inválido', async () => {
  const conta = await novaConta();
  const ponto = await aprovar(conta, { tipo: 'fixo' });
  assert.strictEqual(ponto.tipo, 'fixo');
  const cand = await novaCandidatura(conta);
  const r = await admin('POST', `/admin/candidaturas/${cand.id}/liberar`, { tipo: 'itinerante' });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(await pontoDaCandidatura(cand.id), null, 'nada nasce com tipo inválido');
});

test('3. candidatura nunca vira móvel; o Admin cria o móvel direto — da Mostraí, a conta é só a base', async () => {
  const conta = await novaConta();
  const cand = await novaCandidatura(conta);
  const r = await admin('POST', `/admin/candidaturas/${cand.id}/liberar`, { tipo: 'movel' });
  assert.strictEqual(r.status, 400, 'candidatura sempre gera ponto fixo');
  assert.match(r.json.erro, /sempre gera ponto fixo/);
  assert.strictEqual(await pontoDaCandidatura(cand.id), null);

  const ponto = await criarMovel(conta);
  assert.strictEqual(ponto.tipo, 'movel');
  assert.strictEqual(ponto.anunciante_id, null, 'sem dona');
  assert.strictEqual(ponto.candidatura_id, null, 'não vem de candidatura');
  assert.strictEqual(ponto.base_conta_id, conta.id);
  assert.match(ponto.nome, /^Mostraí Móvel #\d{2,}$/);
  assert.ok(ponto.base_desde, 'base com data');
  assert.ok(ponto.telaId, 'a Tela 1 nasce junto');
  const { rows } = await pool.query('SELECT papeis FROM anunciantes WHERE id = $1', [conta.id]);
  assert.ok(!rows[0].papeis.includes('ponto'), 'a base não ganha o papel de dono');
  const cupom = await pool.query('SELECT 1 FROM cupons_ponto WHERE conta_id = $1', [conta.id]);
  assert.strictEqual(cupom.rowCount, 0, 'criar móvel não cria cupom para a base');
});

// ---------- 4 e 17. segurança ----------
test('4. conta comum (e anônimo) não cria móvel nem mexe em base ou evento', async () => {
  const conta = await novaConta();
  const nav = await entrar(conta);
  const anon = navegador();
  const cand = await novaCandidatura(conta);
  const movelPronto = await aprovarMovel(await novaConta());
  const fixo = await aprovar(await novaConta());
  for (const quem of [nav, anon]) {
    assert.strictEqual((await quem('POST', `/admin/candidaturas/${cand.id}/liberar`, { tipo: 'movel' })).status, 401);
    assert.strictEqual((await quem('POST', '/admin/pontos-moveis', { base_nome: 'X' })).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${fixo.id}/tornar-movel`)).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${movelPronto.id}/tornar-fixo`)).status, 401);
    assert.strictEqual(
      (await quem('PUT', `/admin/pontos/${movelPronto.id}/base`, { base_conta_id: conta.id })).status,
      401,
    );
    assert.strictEqual(
      (await quem('POST', `/admin/pontos/${movelPronto.id}/eventos`, { nome: 'x', organizacao: 'x', local: 'x' }))
        .status,
      401,
    );
    assert.strictEqual((await quem('GET', `/admin/pontos/${movelPronto.id}/movel`)).status, 401);
  }
  assert.strictEqual(await pontoDaCandidatura(cand.id), null, 'a candidatura continua só candidatura');
  const { rows } = await pool.query('SELECT tipo FROM pontos WHERE id = $1', [fixo.id]);
  assert.strictEqual(rows[0].tipo, 'fixo');
});

test('17. propriedade: móvel nunca ganha dono — nem pelo PATCH do admin, nem pelo banco, nem pela base', async () => {
  const contaBase = await novaConta();
  const outra = await novaConta();
  const ponto = await aprovarMovel(contaBase);
  const r = await admin('PATCH', `/admin/pontos/${ponto.id}`, { anunciante_id: outra.id });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.erro, /não tem dono/);
  await assert.rejects(
    pool.query('UPDATE pontos SET anunciante_id = $2 WHERE id = $1', [ponto.id, contaBase.id]),
    (e) => e.code === '23514',
    'o CHECK do banco recusa dono em ponto móvel',
  );
  await assert.rejects(
    pool.query('UPDATE pontos SET base_nome = NULL WHERE id = $1', [ponto.id]),
    (e) => e.code === '23514',
    'móvel sem base também não existe',
  );
  await assert.rejects(
    pool.query('UPDATE pontos SET candidatura_id = (SELECT id FROM candidaturas LIMIT 1) WHERE id = $1', [ponto.id]),
    (e) => e.code === '23514',
    'móvel nunca vem de candidatura',
  );
  // A base não edita o endereço (só o dono edita o do próprio ponto).
  const nav = await entrar(contaBase);
  const end = await nav('PATCH', `/anunciantes/me/pontos/${ponto.id}/endereco`, { numero: '999' });
  assert.strictEqual(end.status, 404);
  // "Meus pontos" da base: o móvel aparece só como base, nunca como ponto dela.
  const meus = await nav('GET', '/anunciantes/me/meus-pontos');
  assert.strictEqual(meus.status, 200);
  assert.strictEqual(meus.json.ehPonto, false);
  const item = meus.json.estabelecimentos.find((e) => e.id === ponto.id);
  assert.strictEqual(item.tipo, 'base_movel');
  assert.strictEqual(item.localAtual.origem, 'base');
  assert.deepStrictEqual(item.telas, []);
  assert.strictEqual(item.beneficio, undefined, 'sem bloco de benefício');
});

// ---------- 5 a 11. base, local atual, eventos ----------
test('5 e 6. móvel tem base; sem evento, o local atual é a base', async () => {
  const contaBase = await novaConta();
  const ponto = await aprovarMovel(contaBase);
  const f = await ficha(ponto.id);
  assert.strictEqual(f.tipo, 'movel');
  assert.strictEqual(f.base.nome, ponto.base_nome);
  assert.strictEqual(f.base.conta.id, contaBase.id);
  assert.deepStrictEqual(f.localAtual, { origem: 'base', nome: ponto.base_nome });
  assert.strictEqual(f.proximoEvento, null);
});

test('7 e 11. evento futuro vira o próximo evento; público estimado é opcional', async () => {
  const ponto = await aprovarMovel(await novaConta());
  const semPublico = await cadastrarEvento(ponto.id, {
    nome: 'Feira do Livro',
    data_inicio: hojeMais(20),
    data_fim: '',
    publico_estimado: '',
  });
  let f = await ficha(ponto.id);
  assert.strictEqual(f.proximoEvento.id, semPublico);
  assert.strictEqual(f.proximoEvento.publicoEstimado, null, 'sem público, sem número inventado');
  assert.strictEqual(f.proximoEvento.dataFim, f.proximoEvento.dataInicio, 'sem fim = evento de um dia');
  const maisCedo = await cadastrarEvento(ponto.id, { data_inicio: hojeMais(3), data_fim: hojeMais(4) });
  f = await ficha(ponto.id);
  assert.strictEqual(f.proximoEvento.id, maisCedo, 'o próximo é o de início mais próximo');
  assert.strictEqual(f.proximoEvento.publicoEstimado, 600);
  assert.strictEqual(f.proximoEvento.local, 'Ginásio Municipal');
  assert.strictEqual(f.localAtual.origem, 'base', 'evento programado não muda o local atual');

  const invalido = await admin('POST', `/admin/pontos/${ponto.id}/eventos`, {
    nome: 'X',
    organizacao: 'Y',
    local: 'Z',
    data_inicio: hojeMais(2),
    publico_estimado: 'muita gente',
  });
  assert.strictEqual(invalido.status, 400);
  assert.strictEqual(invalido.json.campo, 'publico_estimado');
  const passado = await admin('POST', `/admin/pontos/${ponto.id}/eventos`, {
    nome: 'X',
    organizacao: 'Y',
    local: 'Z',
    data_inicio: hojeMais(-3),
    data_fim: hojeMais(-1),
  });
  assert.strictEqual(passado.status, 400, 'evento que já terminou não se cadastra');
  const fimAntes = await admin('POST', `/admin/pontos/${ponto.id}/eventos`, {
    nome: 'X',
    organizacao: 'Y',
    local: 'Z',
    data_inicio: hojeMais(5),
    data_fim: hojeMais(4),
  });
  assert.strictEqual(fimAntes.status, 400);
  const semNome = await admin('POST', `/admin/pontos/${ponto.id}/eventos`, {
    organizacao: 'Y',
    local: 'Z',
    data_inicio: hojeMais(5),
  });
  assert.strictEqual(semNome.status, 400);
  assert.strictEqual(semNome.json.campo, 'nome');
});

test('8 e 9. evento em andamento vira o local atual; encerrado, volta para a base', async () => {
  const ponto = await aprovarMovel(await novaConta());
  const eventoId = await cadastrarEvento(ponto.id, { data_inicio: hojeMais(0), data_fim: hojeMais(1) });
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'iniciar')).status, 200);
  let f = await ficha(ponto.id);
  assert.strictEqual(f.localAtual.origem, 'evento');
  assert.strictEqual(f.localAtual.nome, 'Ginásio Municipal');
  assert.strictEqual(f.localAtual.evento.id, eventoId);
  assert.strictEqual(f.proximoEvento, null, 'em andamento não é "próximo"');
  assert.strictEqual(f.base.nome, ponto.base_nome, 'a base não muda');

  // Um lugar por vez (agenda única, migration 113): datas sobrepostas nem
  // entram; um evento de outra data não começa com este em andamento.
  const sobreposto = await admin('POST', `/admin/pontos/${ponto.id}/eventos`, {
    nome: 'Outro',
    organizacao: 'X',
    local: 'Y',
    data_inicio: hojeMais(0),
  });
  assert.strictEqual(sobreposto.status, 409);
  assert.match(sobreposto.json.erro, /já está no evento/);
  const outro = await cadastrarEvento(ponto.id, { nome: 'Outro', data_inicio: hojeMais(3), data_fim: hojeMais(3) });
  const dois = await acaoNoEvento(ponto.id, outro, 'iniciar');
  assert.strictEqual(dois.status, 409);
  assert.match(dois.json.erro, /já está no evento/);
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'cancelar')).status, 409, 'em andamento não cancela');

  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'encerrar')).status, 200);
  f = await ficha(ponto.id);
  assert.deepStrictEqual(f.localAtual, { origem: 'base', nome: ponto.base_nome });
  const encerrado = f.eventos.find((e) => e.id === eventoId);
  assert.strictEqual(encerrado.estado, 'encerrado');
  assert.ok(encerrado.iniciadoEm && encerrado.encerradoEm);
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'iniciar')).status, 409, 'encerrado não recomeça');
  assert.strictEqual((await acaoNoEvento(ponto.id, outro, 'encerrar')).status, 409, 'programado não encerra');
});

test('10. evento cancelado não é próximo nem local atual, e fica no histórico', async () => {
  const ponto = await aprovarMovel(await novaConta());
  const cedo = await cadastrarEvento(ponto.id, { nome: 'Cedo', data_inicio: hojeMais(2) });
  const tarde = await cadastrarEvento(ponto.id, { nome: 'Tarde', data_inicio: hojeMais(9), data_fim: hojeMais(9) });
  assert.strictEqual((await acaoNoEvento(ponto.id, cedo, 'cancelar')).status, 200);
  const f = await ficha(ponto.id);
  assert.strictEqual(f.proximoEvento.id, tarde);
  assert.strictEqual(f.localAtual.origem, 'base');
  const cancelado = f.eventos.find((e) => e.id === cedo);
  assert.strictEqual(cancelado.estado, 'cancelado', 'auditável');
  assert.ok(cancelado.canceladoEm);
  assert.strictEqual((await acaoNoEvento(ponto.id, cedo, 'iniciar')).status, 409, 'cancelado não começa');
  // Evento de outro ponto não se mexe por este.
  const outroPonto = await aprovarMovel(await novaConta());
  assert.strictEqual((await acaoNoEvento(outroPonto.id, tarde, 'iniciar')).status, 404);
  // Evento que passou da data sem ter começado não começa mais.
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, organizacao, local, data_inicio, data_fim)
     VALUES ($1, 'Velho', 'Org', 'Lugar', $2, $3) RETURNING id`,
    [ponto.id, hojeMais(-5), hojeMais(-4)],
  );
  assert.strictEqual((await acaoNoEvento(ponto.id, rows[0].id, 'iniciar')).status, 409);
  assert.notStrictEqual((await ficha(ponto.id)).proximoEvento.id, Number(rows[0].id), 'passado nunca é próximo');
});

test('evento e base só existem em ponto móvel', async () => {
  const fixo = await aprovar(await novaConta());
  const r = await admin('POST', `/admin/pontos/${fixo.id}/eventos`, {
    nome: 'X',
    organizacao: 'Y',
    local: 'Z',
    data_inicio: hojeMais(3),
  });
  assert.strictEqual(r.status, 409);
  const b = await admin('PUT', `/admin/pontos/${fixo.id}/base`, { base_conta_id: fixo.anunciante_id, base_nome: 'X' });
  assert.strictEqual(b.status, 409);
});

// ---------- 12 a 14. organizador, Plano Básico, crédito ----------
test('12, 13 e 14. organizador não vira dono; evento e móvel não dão Plano Básico nem crédito', async () => {
  const contaBase = await novaConta();
  const ponto = await aprovarMovel(contaBase);
  await telaInstalada(ponto.id);
  const eventoId = await cadastrarEvento(ponto.id, { organizacao: 'Igreja Y', data_inicio: hojeMais(0) });
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'iniciar')).status, 200);

  await basico.sincronizar({ apenasPontos: [ponto.id] });
  await creditosPonto.concederCreditosMensais({ apenasPontos: [ponto.id] });

  const { rows: p } = await pool.query('SELECT anunciante_id, base_conta_id FROM pontos WHERE id = $1', [ponto.id]);
  assert.strictEqual(p[0].anunciante_id, null, 'continua da Mostraí');
  assert.strictEqual(p[0].base_conta_id, contaBase.id, 'a base não muda por causa do evento');
  const igreja = await pool.query(`SELECT 1 FROM anunciantes WHERE nome_empresa = 'Igreja Y'`);
  assert.strictEqual(igreja.rowCount, 0, 'organização é texto do evento, nunca conta');
  const basicoDoPonto = await pool.query('SELECT 1 FROM beneficios_basico_ponto WHERE ponto_id = $1', [ponto.id]);
  assert.strictEqual(basicoDoPonto.rowCount, 0, 'sem Plano Básico pelo móvel');
  const basicoDaBase = await pool.query('SELECT 1 FROM beneficios_basico_ponto WHERE conta_id = $1', [contaBase.id]);
  assert.strictEqual(basicoDaBase.rowCount, 0, 'nem para a base');
  const credito = await pool.query('SELECT 1 FROM creditos_ledger WHERE ponto_id = $1 OR anunciante_id = $2', [
    ponto.id,
    contaBase.id,
  ]);
  assert.strictEqual(credito.rowCount, 0, 'sem crédito mensal');

  // Controle: o mesmo cenário num ponto FIXO dá os dois — o teste acima não
  // passa por acaso.
  const dona = await novaConta();
  const fixo = await aprovar(dona);
  await telaInstalada(fixo.id);
  await basico.sincronizar({ apenasPontos: [fixo.id] });
  await creditosPonto.concederCreditosMensais({ apenasPontos: [fixo.id] });
  assert.strictEqual(
    (await pool.query('SELECT 1 FROM beneficios_basico_ponto WHERE ponto_id = $1', [fixo.id])).rowCount,
    1,
  );
  assert.strictEqual((await pool.query('SELECT 1 FROM creditos_ledger WHERE ponto_id = $1', [fixo.id])).rowCount, 1);
  await pool.query('DELETE FROM beneficios_basico_ponto WHERE ponto_id = $1', [fixo.id]);
});

// ---------- 15. escolha do anunciante ----------
test('15. o anunciante escolhe o PONTO móvel (não a base nem o evento) e vê local, base e próximo evento', async () => {
  const contaBase = await novaConta();
  const ponto = await aprovarMovel(contaBase);
  const eventoId = await cadastrarEvento(ponto.id, { data_inicio: hojeMais(4) });
  const anunciante = await novaConta();
  await anunciantesRepo.atualizar(anunciante.id, { plano_id: 'essencial-1m' });
  const nav = await entrar(anunciante);
  const lista = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(lista.status, 200, JSON.stringify(lista.json));
  const doMovel = lista.json.pontos.filter((p) => p.id === ponto.id);
  assert.strictEqual(doMovel.length, 1, 'o móvel é UM item da lista');
  const item = doMovel[0];
  assert.strictEqual(item.tipo, 'movel');
  assert.strictEqual(item.seuPonto, false);
  assert.deepStrictEqual(item.movel.localAtual, { origem: 'base', nome: ponto.base_nome });
  assert.strictEqual(item.movel.base.nome, ponto.base_nome);
  assert.strictEqual(item.movel.proximoEvento.id, eventoId);
  assert.strictEqual(item.movel.proximoEvento.publicoEstimado, 600);
  assert.strictEqual(item.movel.proximoEvento.organizacao, undefined, 'dado administrativo não vai pro card');
  const fixos = lista.json.pontos.filter((p) => p.tipo === 'fixo');
  assert.ok(
    fixos.every((p) => p.movel === null),
    'fixo não carrega nada de móvel',
  );

  const escolha = await nav('PUT', '/anunciantes/me/pontos', { pontos: [ponto.id] });
  assert.strictEqual(escolha.status, 200, JSON.stringify(escolha.json));
  const { rows } = await pool.query('SELECT ponto_id FROM anunciantes_pontos WHERE anunciante_id = $1', [
    anunciante.id,
  ]);
  assert.deepStrictEqual(
    rows.map((r) => r.ponto_id),
    [ponto.id],
  );

  // A base olhando a lista: o móvel não é "seu ponto" (não é dona).
  await anunciantesRepo.atualizar(contaBase.id, { plano_id: 'essencial-1m' });
  const daBase = await (await entrar(contaBase))('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(daBase.json.pontos.find((p) => p.id === ponto.id).seuPonto, false);
});

// ---------- 16. Proof-of-Play ----------
async function contaComPlanoEPeca(pontoId, categoriaId = null) {
  const conta = await novaConta({ categoriaId });
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [conta.id, pontoId]);
  await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m' });
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: 'https://exemplo.test/normalizado.mp4',
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  return conta;
}

async function confirmarUmaExibicao(dispositivoId, contaId, hora) {
  const janelaId = `${dispositivoId}|${hora.toISOString()}`;
  const execucaoId = randomUUID();
  const r = await execucoesRepo.confirmarComDedup(
    dispositivoId,
    {
      execucaoId,
      janelaId,
      itemProgramacaoId: `${janelaId}|0|${contaId}`,
      criativoId: '1',
      iniciadoEm: new Date().toISOString(),
      terminadoEm: new Date().toISOString(),
    },
    new Date(),
  );
  const { rows } = await pool.query('SELECT status, evento_id FROM execucoes_confirmadas WHERE execucao_id = $1', [
    execucaoId,
  ]);
  return { ...r, eventoId: rows[0].evento_id === null ? null : Number(rows[0].evento_id) };
}

test('16. Proof-of-Play: conta igual, no ponto certo; durante o evento guarda o evento (auditoria)', async () => {
  const ponto = await aprovarMovel(await novaConta());
  const telaId = await telaInstalada(ponto.id);
  const conta = await contaComPlanoEPeca(ponto.id);
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas) VALUES ($1, $2, $3, 3)`,
    [conta.id, telaId, hora],
  );
  await pool.query(
    `INSERT INTO playlist_hora_congelada (dispositivo_id, janela_hora, base, extras) VALUES ($1, $2, $3::jsonb, '[]'::jsonb)`,
    [telaId, hora, JSON.stringify([{ id: conta.id }])],
  );

  const naBase = await confirmarUmaExibicao(telaId, conta.id, hora);
  assert.strictEqual(naBase.status, 'contabilizado');
  assert.strictEqual(naBase.eventoId, null, 'na base, sem evento');

  const eventoId = await cadastrarEvento(ponto.id, { data_inicio: hojeMais(0) });
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'iniciar')).status, 200);
  const noEvento = await confirmarUmaExibicao(telaId, conta.id, hora);
  assert.strictEqual(noEvento.status, 'contabilizado', 'a regra de contabilização não muda');
  assert.strictEqual(noEvento.eventoId, eventoId);

  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'encerrar')).status, 200);
  const deVolta = await confirmarUmaExibicao(telaId, conta.id, hora);
  assert.strictEqual(deVolta.status, 'contabilizado');
  assert.strictEqual(deVolta.eventoId, null);

  const { rows } = await pool.query(
    'SELECT vezes_confirmadas FROM exibicoes_contador WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3',
    [conta.id, telaId, hora],
  );
  assert.strictEqual(rows[0].vezes_confirmadas, 3, 'as três contaram na tela do ponto móvel');
  const doEvento = (await ficha(ponto.id)).eventos.find((e) => e.id === eventoId);
  assert.strictEqual(doEvento.exibicoesConfirmadas, 1, 'a ficha mostra o que tocou durante o evento');
});

// ---------- trava de ramo: a base escolhendo o móvel ----------
test('trava de ramo: o concorrente da base fica fora do móvel; a base, quando escolhe, entra', async () => {
  const { rows: cat } = await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id`, [
    `Academia Teste ${randomUUID().slice(0, 8)}`,
  ]);
  criadas.categorias.push(cat[0].id);
  const contaBase = await novaConta({ categoriaId: cat[0].id });
  const ponto = await aprovarMovel(contaBase);
  await pool.query('UPDATE pontos SET categoria_id = $2 WHERE id = $1', [ponto.id, cat[0].id]);
  await tirarDoSorteio(ponto.id);
  const tela = { id: ponto.telaId };
  await dispositivosRepo.atualizar(tela.id, { status: 'ativo' });
  await instalarPlayer(tela.id);

  // A base também anuncia (mesmo ramo do ponto) e escolheu o móvel; o
  // concorrente (mesmo ramo) também escolheu.
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [
    contaBase.id,
    ponto.id,
  ]);
  await anunciantesRepo.atualizar(contaBase.id, { plano_id: 'essencial-1m' });
  const pecaBase = await criativosRepo.criar({
    anunciante_id: contaBase.id,
    arquivo_original_url: 'o.mp4',
    arquivo_normalizado_url: 'https://exemplo.test/base.mp4',
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await criativosRepo.atualizar(pecaBase.id, { status: 'aprovado' });
  const concorrente = await contaComPlanoEPeca(ponto.id, cat[0].id);

  const dispositivo = await dispositivosRepo.buscarComPonto(tela.id);
  assert.strictEqual(dispositivo.casa_conta_id, contaBase.id);
  assert.strictEqual(dispositivo.dono_conta_id, null);
  const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
  const contas = new Set(envelope.itens.map((i) => i.anuncianteId));
  assert.ok(contas.has(contaBase.id), 'a base escolheu o móvel e não é barrada pela própria trava');
  assert.ok(!contas.has(concorrente.id), 'o concorrente do mesmo ramo continua fora');
});

// ---------- horário: em evento, o da base não vale ----------
test('em evento a tela exibe sem o horário da base; de volta, o horário volta — e a TV é avisada', async () => {
  const ponto = await aprovarMovel(await novaConta());
  const telaId = await telaInstalada(ponto.id);
  const versao = async () =>
    (await pool.query('SELECT config_versao_desejada FROM dispositivos WHERE id = $1', [telaId])).rows[0]
      .config_versao_desejada;
  const antes = await versao();
  const daBase = ponto.horario_semanal;
  assert.ok(daBase, 'a base tem horário');
  assert.deepStrictEqual((await dispositivosRepo.buscarComPonto(telaId)).ponto_horario_semanal, daBase);

  const eventoId = await cadastrarEvento(ponto.id, { data_inicio: hojeMais(0) });
  await acaoNoEvento(ponto.id, eventoId, 'iniciar');
  assert.strictEqual((await dispositivosRepo.buscarComPonto(telaId)).ponto_horario_semanal, null, '24 h no evento');
  assert.ok((await versao()) > antes, 'a config da TV muda ao entrar no evento');

  const noEvento = await versao();
  await acaoNoEvento(ponto.id, eventoId, 'encerrar');
  assert.deepStrictEqual((await dispositivosRepo.buscarComPonto(telaId)).ponto_horario_semanal, daBase);
  assert.ok((await versao()) > noEvento, 'e muda de novo ao voltar');
});

// A régua "no ar" do anunciante lê o MESMO horário em vigor da TV
// (src/lib/contexto-do-ponto.js): no evento fora do horário da base, a tela
// que exibe está "no ar" para o anunciante e "operando" para o Admin.
test('no evento fora do horário da base, anunciante e Admin veem a tela no ar', async () => {
  const ponto = await aprovarMovel(await novaConta());
  // Base fechada a semana toda: sem evento, qualquer hora é fora do horário.
  const fechada = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null };
  await pool.query('UPDATE pontos SET horario_semanal = $2 WHERE id = $1', [ponto.id, JSON.stringify(fechada)]);
  const telaId = await telaInstalada(ponto.id);
  await pool.query(`UPDATE dispositivos SET ultima_vez_online = now(), player_estado = 'PLAYING' WHERE id = $1`, [
    telaId,
  ]);
  const anunciante = await novaConta();
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
     VALUES ($1, $2, date_trunc('hour', now()), 1, 1, 1)`,
    [anunciante.id, telaId],
  );
  const nav = await entrar(anunciante);
  const situacoes = async () => {
    const r = await nav('GET', `/anunciantes/${anunciante.id}/exibicoes`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const telas = (await admin('GET', `/admin/pontos/${ponto.id}/dispositivos`)).json;
    return {
      anunciante: r.json.porPonto.find((p) => p.id === ponto.id)?.situacao,
      admin: telas.find((t) => t.id === telaId)?.saude,
    };
  };
  assert.deepStrictEqual(await situacoes(), { anunciante: 'fora_do_horario', admin: 'fora_do_horario' }, 'na base');

  const eventoId = await cadastrarEvento(ponto.id, { data_inicio: hojeMais(0) });
  await acaoNoEvento(ponto.id, eventoId, 'iniciar');
  assert.deepStrictEqual(await situacoes(), { anunciante: 'no_ar', admin: 'operando' }, 'no evento');

  await acaoNoEvento(ponto.id, eventoId, 'encerrar');
  assert.deepStrictEqual(await situacoes(), { anunciante: 'fora_do_horario', admin: 'fora_do_horario' }, 'de volta');
});

// ---------- base: trocar e histórico ----------
test('alterar a base: período anterior no histórico, endereço e ramo da base nova; a base nova não vira dona', async () => {
  const antiga = await novaConta();
  const { rows: cat } = await pool.query(
    `INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id, nome`,
    [`Barbearia Teste ${randomUUID().slice(0, 8)}`],
  );
  criadas.categorias.push(cat[0].id);
  const nova = await novaConta({ categoriaId: cat[0].id });
  const ponto = await aprovarMovel(antiga);
  const corpo = {
    base_conta_id: nova.id,
    base_nome: 'Barbearia Y',
    cep: '15990-000',
    logradouro: 'Rua Nova',
    numero: '55',
    complemento: '',
    bairro: 'Jardim',
    cidade: 'Matão',
    uf: 'SP',
  };
  const semEndereco = await admin('PUT', `/admin/pontos/${ponto.id}/base`, {
    base_conta_id: nova.id,
    base_nome: 'Barbearia Y',
  });
  assert.strictEqual(semEndereco.status, 400, 'base nova pede o endereço dela');
  const contaInvalida = await admin('PUT', `/admin/pontos/${ponto.id}/base`, { ...corpo, base_conta_id: 'abc' });
  assert.strictEqual(contaInvalida.status, 400);

  const r = await admin('PUT', `/admin/pontos/${ponto.id}/base`, corpo);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.strictEqual(r.json.baseNova, true);
  const { rows: p } = await pool.query('SELECT * FROM pontos WHERE id = $1', [ponto.id]);
  assert.strictEqual(p[0].base_conta_id, nova.id);
  assert.strictEqual(p[0].base_nome, 'Barbearia Y');
  assert.strictEqual(p[0].anunciante_id, null, 'a base nova também não é dona');
  assert.strictEqual(p[0].logradouro, 'Rua Nova');
  assert.strictEqual(p[0].categoria_id, cat[0].id, 'a trava de ramo passa a proteger a base nova');
  const f = await ficha(ponto.id);
  assert.strictEqual(f.basesAnteriores.length, 1);
  assert.strictEqual(f.basesAnteriores[0].conta.id, antiga.id);
  assert.strictEqual(f.basesAnteriores[0].nome, ponto.base_nome);
  assert.match(f.basesAnteriores[0].endereco, /Avenida Brasil/);
  assert.deepStrictEqual(f.localAtual, { origem: 'base', nome: 'Barbearia Y' });
  const hist = await pool.query('SELECT 1 FROM pontos_enderecos_historico WHERE ponto_id = $1', [ponto.id]);
  assert.strictEqual(hist.rowCount, 1, 'o endereço trocado fica no histórico de endereço');

  // Mesma conta e mesmo nome: só correção de endereço, sem período novo.
  const corrigir = await admin('PUT', `/admin/pontos/${ponto.id}/base`, { ...corpo, numero: '57' });
  assert.strictEqual(corrigir.json.baseNova, false);
  assert.strictEqual((await ficha(ponto.id)).basesAnteriores.length, 1);
});

// ---------- tipo imutável (V2) ----------
test('tipo imutável: fixo não vira móvel nem móvel vira fixo — rota 410 e o banco recusa', async () => {
  const dona = await novaConta();
  const fixo = await aprovar(dona);
  const movelPronto = await criarMovel(await novaConta());
  const a = await admin('POST', `/admin/pontos/${fixo.id}/tornar-movel`);
  const b = await admin('POST', `/admin/pontos/${movelPronto.id}/tornar-fixo`);
  assert.strictEqual(a.status, 410);
  assert.strictEqual(b.status, 410);
  await assert.rejects(
    pool.query(`UPDATE pontos SET tipo = 'movel' WHERE id = $1`, [fixo.id]),
    (e) => e.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `UPDATE pontos SET tipo = 'fixo', anunciante_id = base_conta_id, base_conta_id = NULL, base_nome = NULL,
                         base_desde = NULL WHERE id = $1`,
      [movelPronto.id],
    ),
    (e) => e.code === '23514',
  );
  const { rows } = await pool.query('SELECT id, tipo FROM pontos WHERE id = ANY($1::int[]) ORDER BY id', [
    [fixo.id, movelPronto.id],
  ]);
  assert.deepStrictEqual(
    rows.map((r) => r.tipo),
    [fixo.id, movelPronto.id].sort((x, y) => x - y).map((id) => (id === fixo.id ? 'fixo' : 'movel')),
  );
});

// ---------- duplicidade ----------
test('ser base de um móvel não impede o comércio de pedir o PRÓPRIO ponto fixo', async () => {
  const conta = await novaConta();
  const m = await criarMovel(conta);
  const cand = await novaCandidatura(conta, {
    nome_comercio: m.base_nome,
    logradouro: m.logradouro,
    numero: m.numero,
  });
  const r = await admin('POST', `/admin/candidaturas/${cand.id}/liberar`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const fixo = await pontoDaCandidatura(cand.id);
  assert.strictEqual(fixo.tipo, 'fixo');
  assert.strictEqual(fixo.anunciante_id, conta.id);
});

test('situacaoDosMoveis ignora ponto fixo e id inválido', async () => {
  const fixo = await aprovar(await novaConta());
  const mapa = await movel.situacaoDosMoveis([fixo.id, 'abc', -1]);
  assert.strictEqual(mapa.size, 0);
  const meus = await meusPontosDaConta(fixo.anunciante_id);
  assert.ok(meus.every((e) => e.tipo !== 'base_movel'));
});
