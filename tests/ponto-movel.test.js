const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// PONTO FIXO E PONTO MÓVEL (migrations 112, 113 e 114, src/pontos/movel.js).
// V2 (02/10/2026): o móvel nasce só pelo Admin (POST /admin/pontos-moveis),
// com a Tela 1; candidatura gera sempre fixo; o tipo não muda. V1.1
// (05/10/2026, migration 114): o móvel NÃO TEM BASE — é equipamento, e só
// tem local, horário, ramo e lugar no inventário enquanto está ALOCADO
// (hospedagem ativa ou evento em andamento). Roda o `app` REAL
// (src/server.js): a guarda do /admin, o login do admin e o do anunciante de
// verdade. Cada teste cria as próprias contas e pontos — os arquivos de teste
// rodam em paralelo no mesmo banco.
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-ponto-movel';
const app = require('../src/server');
const movel = require('../src/pontos/movel');
const alocacao = require('../src/pontos/alocacao');
const basico = require('../src/pontos/basico');
const creditosPonto = require('../src/creditos/ponto');
const dispositivosRepo = require('../src/dispositivos/repository');
const execucoesRepo = require('../src/playlist/execucoes-repository');
const gerador = require('../src/playlist/gerador');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const candidaturasRepo = require('../src/candidaturas/repository');
const { inventarioSql } = require('../src/lib/contexto-do-ponto');
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

async function novaCategoria(prefixo) {
  const { rows } = await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id`, [
    `${prefixo} ${randomUUID().slice(0, 8)}`,
  ]);
  criadas.categorias.push(rows[0].id);
  return rows[0].id;
}

// Horário de funcionamento do ponto fixo (candidatura) e do evento padrão. O
// formato é o de `pontos.horario_semanal` já normalizado (com `feriados`),
// para comparar com o que a TV recebe.
const HORARIO_COMERCIAL = {
  seg: { abre: '06:00', fecha: '22:00' },
  ter: { abre: '06:00', fecha: '22:00' },
  qua: { abre: '06:00', fecha: '22:00' },
  qui: { abre: '06:00', fecha: '22:00' },
  sex: { abre: '06:00', fecha: '22:00' },
  sab: { abre: '08:00', fecha: '12:00' },
  dom: null,
  feriados: null,
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
    horario_semanal: HORARIO_COMERCIAL,
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

// O móvel nasce pelo Admin: só o EQUIPAMENTO (nome opcional e nota interna);
// a Tela 1 nasce junto. Nasce sem alocação.
async function criarMovel(corpo = {}) {
  const r = await admin('POST', '/admin/pontos-moveis', corpo);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [r.json.id]);
  return { ...rows[0], telaId: r.json.telaId };
}

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

// Tempo relativo a agora, no relógio de Matão ("YYYY-MM-DDTHH:MM" — o que o
// formulário do Admin manda).
const paredeMais = (horas) => alocacao.parede(new Date(Date.now() + horas * 3_600_000));
// Só o dia ("YYYY-MM-DD") em Matão, daqui a N dias.
const diaMais = (dias) => paredeMais(dias * 24).slice(0, 10);
// A chave do dia da semana ('seg'…'dom') de um dia "YYYY-MM-DD".
const DIA_DA_SEMANA = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const diaDaSemana = (dia) => {
  const [a, m, d] = dia.split('-').map(Number);
  return DIA_DA_SEMANA[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
};

// Evento padrão: daqui a 5 dias, por um dia, horário comercial. Com
// `data_inicio` (formato antigo, só datas), o período vem dele.
async function cadastrarEvento(pontoId, extra = {}) {
  const r = await admin('POST', `/admin/pontos/${pontoId}/eventos`, corpoDeEvento(extra));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

function corpoDeEvento(extra = {}) {
  const periodo = extra.data_inicio || extra.inicio ? {} : { inicio: paredeMais(5 * 24), fim: paredeMais(6 * 24) };
  return {
    nome: 'Campeonato Regional de Jiu-Jitsu',
    organizacao: 'Federação Regional',
    local: 'Ginásio Municipal',
    ...periodo,
    horario_operacao: HORARIO_COMERCIAL,
    publico_estimado: 600,
    ...extra,
  };
}

// Evento que cobre agora (começou há 1 h, acaba amanhã), já iniciado.
async function eventoEmAndamento(pontoId, extra = {}) {
  const id = await cadastrarEvento(pontoId, { inicio: paredeMais(-1), fim: paredeMais(24), ...extra });
  const r = await acaoNoEvento(pontoId, id, 'iniciar');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return id;
}

const ficha = async (pontoId) => (await admin('GET', `/admin/pontos/${pontoId}/movel`)).json;
const acaoNoEvento = (pontoId, eventoId, acao) => admin('POST', `/admin/pontos/${pontoId}/eventos/${eventoId}/${acao}`);
const daLista = async (pontoId) => (await movel.listarMoveis()).find((m) => m.id === pontoId);
const publicos = async () => (await navegador()('GET', '/pontos')).json;
const noInventario = async (pontoId) =>
  (await pool.query(`SELECT ${inventarioSql('p')} AS sim FROM pontos p WHERE p.id = $1`, [pontoId])).rows[0].sim;

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
  // O fixo continua com endereço obrigatório (CHECK da 114).
  await assert.rejects(
    pool.query('UPDATE pontos SET endereco = NULL WHERE id = $1', [rows[0].id]),
    (e) => e.code === '23514',
  );
});

// ---------- 2 e 3. aprovação e criação ----------
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

test('3. candidatura nunca vira móvel; o Admin cria o móvel só com o equipamento — sem base, endereço, horário ou ramo', async () => {
  const conta = await novaConta();
  const cand = await novaCandidatura(conta);
  const r = await admin('POST', `/admin/candidaturas/${cand.id}/liberar`, { tipo: 'movel' });
  assert.strictEqual(r.status, 400, 'candidatura sempre gera ponto fixo');
  assert.match(r.json.erro, /sempre gera ponto fixo/);
  assert.strictEqual(await pontoDaCandidatura(cand.id), null);

  // Campos do modelo antigo (base, endereço, horário) são ignorados.
  const ponto = await criarMovel({
    base_conta_id: conta.id,
    base_nome: 'Academia X',
    logradouro: 'Avenida Brasil',
    horario_semanal: HORARIO_COMERCIAL,
    observacoes: 'caixa 3 no depósito',
  });
  assert.strictEqual(ponto.tipo, 'movel');
  assert.strictEqual(ponto.anunciante_id, null, 'sem dona');
  assert.strictEqual(ponto.candidatura_id, null, 'não vem de candidatura');
  assert.strictEqual(ponto.base_conta_id, null, 'sem base');
  assert.strictEqual(ponto.base_nome, null);
  assert.strictEqual(ponto.base_desde, null);
  assert.strictEqual(ponto.endereco, null, 'sem endereço próprio');
  assert.strictEqual(ponto.logradouro, null);
  assert.strictEqual(ponto.horario_semanal, null, 'sem horário próprio');
  assert.strictEqual(ponto.categoria_id, null, 'sem ramo próprio');
  assert.strictEqual(ponto.observacoes, 'caixa 3 no depósito', 'nota interna');
  assert.match(ponto.nome, /^Mostraí Móvel #\d{2,}$/);
  assert.ok(ponto.telaId, 'a Tela 1 nasce junto');
  const { rows } = await pool.query('SELECT papeis FROM anunciantes WHERE id = $1', [conta.id]);
  assert.ok(!rows[0].papeis.includes('ponto'), 'ninguém ganha o papel de dono');
  const cupom = await pool.query('SELECT 1 FROM cupons_ponto WHERE conta_id = $1', [conta.id]);
  assert.strictEqual(cupom.rowCount, 0, 'criar móvel não cria cupom para ninguém');

  // Nome informado vale; comprido demais é recusado.
  const nomeado = await criarMovel({ nome: '  Totem   da Feira ' });
  assert.strictEqual(nomeado.nome, 'Totem da Feira');
  assert.ok(nomeado.movel_numero > ponto.movel_numero, 'o número continua sequencial');
  const longo = await admin('POST', '/admin/pontos-moveis', { nome: 'x'.repeat(121) });
  assert.strictEqual(longo.status, 400);
  assert.strictEqual(longo.json.campo, 'nome');

  // 1 móvel = 1 tela: a segunda não entra (gatilho da 113).
  await assert.rejects(
    pool.query(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela 2', 'pendente')`, [ponto.id]),
    (e) => e.code === '23505',
  );
});

// ---------- 4 e 17. segurança e propriedade ----------
test('4. conta comum (e anônimo) não cria móvel nem mexe em evento', async () => {
  const conta = await novaConta();
  const nav = await entrar(conta);
  const anon = navegador();
  const cand = await novaCandidatura(conta);
  const movelPronto = await criarMovel();
  const fixo = await aprovar(await novaConta());
  for (const quem of [nav, anon]) {
    assert.strictEqual((await quem('POST', `/admin/candidaturas/${cand.id}/liberar`, { tipo: 'movel' })).status, 401);
    assert.strictEqual((await quem('POST', '/admin/pontos-moveis', { nome: 'X' })).status, 401);
    assert.strictEqual((await quem('GET', '/admin/pontos-moveis')).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${fixo.id}/tornar-movel`)).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${movelPronto.id}/tornar-fixo`)).status, 401);
    assert.strictEqual((await quem('PUT', `/admin/pontos/${movelPronto.id}/base`, {})).status, 401);
    assert.strictEqual(
      (
        await quem(
          'POST',
          `/admin/pontos/${movelPronto.id}/eventos`,
          corpoDeEvento({ inicio: paredeMais(2), fim: paredeMais(5) }),
        )
      ).status,
      401,
    );
    assert.strictEqual((await quem('GET', `/admin/pontos/${movelPronto.id}/movel`)).status, 401);
  }
  assert.strictEqual(await pontoDaCandidatura(cand.id), null, 'a candidatura continua só candidatura');
  const { rows } = await pool.query('SELECT tipo FROM pontos WHERE id = $1', [fixo.id]);
  assert.strictEqual(rows[0].tipo, 'fixo');
  const eventos = await pool.query('SELECT 1 FROM pontos_moveis_eventos WHERE ponto_id = $1', [movelPronto.id]);
  assert.strictEqual(eventos.rowCount, 0);
});

test('17. propriedade: móvel nunca ganha dono — nem pelo PATCH do admin, nem pelo banco, nem pela escolha', async () => {
  const conta = await novaConta();
  const ponto = await criarMovel();
  const r = await admin('PATCH', `/admin/pontos/${ponto.id}`, { anunciante_id: conta.id });
  assert.strictEqual(r.status, 400);
  assert.match(r.json.erro, /não tem dono/);
  await assert.rejects(
    pool.query('UPDATE pontos SET anunciante_id = $2 WHERE id = $1', [ponto.id, conta.id]),
    (e) => e.code === '23514',
    'o CHECK do banco recusa dono em ponto móvel',
  );
  await assert.rejects(
    pool.query('UPDATE pontos SET candidatura_id = (SELECT id FROM candidaturas LIMIT 1) WHERE id = $1', [ponto.id]),
    (e) => e.code === '23514',
    'móvel nunca vem de candidatura',
  );
  await assert.rejects(
    pool.query('UPDATE pontos SET movel_numero = NULL WHERE id = $1', [ponto.id]),
    (e) => e.code === '23514',
    'móvel sempre tem número',
  );
  // A unidade nunca é escolhida (a escolha é a opção Mostraí Móvel, migration
  // 115), e quem escolhe a opção durante um evento não vira dona: não edita
  // o endereço e não vê o móvel em "Meus pontos".
  await eventoEmAndamento(ponto.id);
  await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m' });
  const nav = await entrar(conta);
  assert.strictEqual((await nav('PUT', '/anunciantes/me/pontos', { pontos: [ponto.id] })).status, 400);
  assert.strictEqual((await nav('PUT', '/anunciantes/me/pontos', { pontos: ['mostrai_movel'] })).status, 200);
  const end = await nav('PATCH', `/anunciantes/me/pontos/${ponto.id}/endereco`, { numero: '999' });
  assert.strictEqual(end.status, 404);
  const meus = await nav('GET', '/anunciantes/me/meus-pontos');
  assert.strictEqual(meus.status, 200);
  assert.strictEqual(meus.json.ehPonto, false);
  assert.ok(!meus.json.estabelecimentos.some((e) => e.id === ponto.id), 'o móvel não aparece como dela');
  assert.strictEqual(
    (await pool.query('SELECT anunciante_id FROM pontos WHERE id = $1', [ponto.id])).rows[0].anunciante_id,
    null,
  );
});

// ---------- 5 e 6. sem alocação ----------
test('5 e 6. sem alocação: nenhum local, fora de "Onde estamos", da escolha e do inventário; a tela só toca o institucional', async () => {
  const ponto = await criarMovel();
  const telaId = await telaInstalada(ponto.id);
  // Mesmo "em operação" (tela ligada), sem alocação não é inventário.
  await tirarDoSorteio(ponto.id);
  await pool.query(`UPDATE pontos SET status = 'em_operacao' WHERE id = $1`, [ponto.id]);

  const f = await ficha(ponto.id);
  assert.strictEqual(f.tipo, 'movel');
  assert.strictEqual(f.localAtual, null, 'sem alocação, nenhum local');
  assert.strictEqual(f.proximoEvento, null);
  assert.strictEqual(f.alocado, false);
  assert.strictEqual(f.agora, null);
  assert.strictEqual(f.proximo, null);
  assert.deepStrictEqual(f.agenda, []);
  assert.deepStrictEqual(f.basesAnteriores, []);
  assert.strictEqual(f.tela.id, ponto.telaId);
  assert.strictEqual(f.base, undefined, 'a ficha não tem base');
  const naLista = await daLista(ponto.id);
  assert.strictEqual(naLista.alocado, false);
  assert.strictEqual(naLista.agora, null);
  assert.strictEqual(naLista.tela.id, telaId);

  assert.ok(!(await publicos()).some((p) => p.id === ponto.id), 'fora de "Onde estamos"');
  assert.strictEqual(await noInventario(ponto.id), false, 'fora do inventário (pontosEmOperacao/telasNaRede)');

  const anunciante = await novaConta();
  await anunciantesRepo.atualizar(anunciante.id, { plano_id: 'essencial-1m' });
  const nav = await entrar(anunciante);
  const lista = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(lista.status, 200, JSON.stringify(lista.json));
  assert.ok(!lista.json.pontos.some((p) => p.id === ponto.id), 'fora da escolha');
  const escolha = await nav('PUT', '/anunciantes/me/pontos', { pontos: [ponto.id] });
  assert.strictEqual(escolha.status, 400, 'a unidade nunca é escolha');
  assert.match(escolha.json.erro, /Mostraí Móvel/);

  // A tela ligada toca só o institucional — mesmo com conta que escolheu a
  // opção Mostraí Móvel e tem peça aprovada: sem alocação não é pool.
  await contaComPlanoEPeca(ponto.id);
  const dispositivo = await dispositivosRepo.buscarComPonto(telaId);
  assert.strictEqual(dispositivo.movel_alocado, false);
  assert.strictEqual(dispositivo.ponto_horario_semanal, null, 'sem horário comercial');
  assert.strictEqual(dispositivo.categoria_id, null, 'sem ramo');
  assert.strictEqual(dispositivo.casa_conta_id, null, 'sem casa');
  const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
  assert.ok(envelope.itens.length > 0);
  assert.ok(
    envelope.itens.every((i) => i.institucional === true && i.contabiliza === false && i.anuncianteId === null),
    JSON.stringify(envelope.itens.slice(0, 3)),
  );
  const contador = await pool.query('SELECT 1 FROM exibicoes_contador WHERE dispositivo_id = $1', [telaId]);
  assert.strictEqual(contador.rowCount, 0, 'nada programado para ninguém');
});

// ---------- 7 a 11. eventos ----------
test('7 e 11. evento futuro vira o próximo evento; horário de funcionamento obrigatório; público opcional', async () => {
  const ponto = await criarMovel();
  // Formato antigo (só datas) continua aceito: o dia inteiro em Matão.
  const semPublico = await cadastrarEvento(ponto.id, {
    nome: 'Feira do Livro',
    data_inicio: diaMais(20),
    data_fim: '',
    publico_estimado: '',
  });
  let f = await ficha(ponto.id);
  assert.strictEqual(f.proximoEvento.id, semPublico);
  assert.strictEqual(f.proximoEvento.publicoEstimado, null, 'sem público, sem número inventado');
  assert.strictEqual(f.proximoEvento.dataFim, f.proximoEvento.dataInicio, 'sem fim = evento de um dia');
  const feira = f.eventos.find((e) => e.id === semPublico);
  assert.strictEqual(feira.inicioLocal, `${diaMais(20)}T00:00`);
  assert.strictEqual(feira.fimLocal, `${diaMais(21)}T00:00`);

  const inicio = `${diaMais(3)}T08:00`;
  const fim = `${diaMais(4)}T18:30`;
  const maisCedo = await cadastrarEvento(ponto.id, { inicio, fim, horario_operacao: '24h' });
  f = await ficha(ponto.id);
  assert.strictEqual(f.proximoEvento.id, maisCedo, 'o próximo é o de início mais próximo');
  assert.strictEqual(f.proximoEvento.publicoEstimado, 600);
  assert.strictEqual(f.proximoEvento.local, 'Ginásio Municipal');
  assert.strictEqual(f.proximoEvento.dataInicio, diaMais(3));
  assert.strictEqual(f.proximoEvento.dataFim, diaMais(4));
  assert.strictEqual(f.localAtual, null, 'evento programado não aloca o móvel');
  assert.strictEqual(f.alocado, false);
  assert.strictEqual(f.proximo.tipo, 'evento');
  assert.strictEqual(f.proximo.id, maisCedo);
  assert.deepStrictEqual(
    f.agenda.map((a) => a.id),
    [maisCedo, semPublico],
    'a agenda vem por início',
  );
  const ev = f.eventos.find((e) => e.id === maisCedo);
  assert.strictEqual(ev.inicioLocal, inicio, 'a hora digitada é a de Matão');
  assert.strictEqual(ev.fimLocal, fim);
  assert.deepStrictEqual(ev.horarioOperacao, alocacao.HORARIO_24H, "'24h' é escolha explícita");
  assert.strictEqual((await daLista(ponto.id)).proximo.id, maisCedo);

  const tentar = (extra) => admin('POST', `/admin/pontos/${ponto.id}/eventos`, corpoDeEvento(extra));
  const semHorario = await tentar({
    horario_operacao: undefined,
    inicio: paredeMais(30 * 24),
    fim: paredeMais(31 * 24),
  });
  assert.strictEqual(semHorario.status, 400, 'sem horário de funcionamento, nada de 24 h automático');
  assert.strictEqual(semHorario.json.campo, 'horario_operacao');
  const horarioVazio = await tentar({
    horario_operacao: { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null },
    inicio: paredeMais(30 * 24),
    fim: paredeMais(31 * 24),
  });
  assert.strictEqual(horarioVazio.status, 400, 'pelo menos um dia aberto');
  assert.strictEqual(horarioVazio.json.campo, 'horario_operacao');
  const horarioInvalido = await tentar({
    horario_operacao: { seg: { abre: '25:00', fecha: '10:00' } },
    inicio: paredeMais(30 * 24),
    fim: paredeMais(31 * 24),
  });
  assert.strictEqual(horarioInvalido.status, 400);
  assert.strictEqual(horarioInvalido.json.campo, 'horario_operacao');
  const semFim = await tentar({ inicio: paredeMais(30 * 24) });
  assert.strictEqual(semFim.status, 400, 'período com início E fim');
  assert.strictEqual(semFim.json.campo, 'fim');
  const invalido = await tentar({
    inicio: paredeMais(40 * 24),
    fim: paredeMais(41 * 24),
    publico_estimado: 'muita gente',
  });
  assert.strictEqual(invalido.status, 400);
  assert.strictEqual(invalido.json.campo, 'publico_estimado');
  const passado = await tentar({ inicio: paredeMais(-72), fim: paredeMais(-24) });
  assert.strictEqual(passado.status, 400, 'evento que já terminou não se cadastra');
  const fimAntes = await tentar({ inicio: paredeMais(50 * 24), fim: paredeMais(50 * 24 - 2) });
  assert.strictEqual(fimAntes.status, 400);
  assert.strictEqual(fimAntes.json.campo, 'fim');
  const semNome = await tentar({ nome: undefined, inicio: paredeMais(60 * 24), fim: paredeMais(61 * 24) });
  assert.strictEqual(semNome.status, 400);
  assert.strictEqual(semNome.json.campo, 'nome');
  const categoriaInexistente = await tentar({
    inicio: paredeMais(70 * 24),
    fim: paredeMais(71 * 24),
    categoria_id: 2e9,
  });
  assert.strictEqual(categoriaInexistente.status, 400);
  assert.strictEqual(categoriaInexistente.json.campo, 'categoria_id');
  assert.strictEqual((await ficha(ponto.id)).eventos.length, 2, 'nada inválido entrou');
});

test('evento com hora: dois no mesmo dia em horários que não se cruzam entram; cruzando, 409', async () => {
  const ponto = await criarMovel();
  const dia = diaMais(7);
  const manha = await cadastrarEvento(ponto.id, { nome: 'Manhã', inicio: `${dia}T08:00`, fim: `${dia}T12:00` });
  const tarde = await cadastrarEvento(ponto.id, { nome: 'Tarde', inicio: `${dia}T12:00`, fim: `${dia}T18:00` });
  assert.ok(manha && tarde, '[08:00, 12:00) e [12:00, 18:00) não colidem');
  const cruzando = await admin(
    'POST',
    `/admin/pontos/${ponto.id}/eventos`,
    corpoDeEvento({ nome: 'Almoço', inicio: `${dia}T11:00`, fim: `${dia}T13:00` }),
  );
  assert.strictEqual(cruzando.status, 409);
  assert.match(cruzando.json.erro, /já está no evento “Manhã”/);
  const dentro = await admin(
    'POST',
    `/admin/pontos/${ponto.id}/eventos`,
    corpoDeEvento({ nome: 'Dentro', inicio: `${dia}T13:00`, fim: `${dia}T14:00` }),
  );
  assert.strictEqual(dentro.status, 409);
  assert.match(dentro.json.erro, /“Tarde”/);
  const noite = await cadastrarEvento(ponto.id, { nome: 'Noite', inicio: `${dia}T18:00`, fim: `${dia}T23:00` });
  assert.ok(noite);
  // Cancelado libera a agenda.
  assert.strictEqual((await acaoNoEvento(ponto.id, manha, 'cancelar')).status, 200);
  await cadastrarEvento(ponto.id, { nome: 'Almoço', inicio: `${dia}T11:00`, fim: `${dia}T12:00` });
  // O banco é a última linha de defesa: o gatilho recusa a sobreposição.
  await assert.rejects(
    pool.query(
      `INSERT INTO pontos_moveis_eventos (ponto_id, nome, organizacao, local, data_inicio, data_fim, inicio, fim)
       VALUES ($1, 'X', 'Y', 'Z', $2, $2, $3::timestamptz, $4::timestamptz)`,
      [ponto.id, dia, `${dia}T15:00:00-03:00`, `${dia}T16:00:00-03:00`],
    ),
    (e) => e.code === '23P01',
  );
});

test('8 e 9. evento em andamento aloca o móvel (local, inventário, "Onde estamos"); encerrado, volta a sem alocação', async () => {
  const ponto = await criarMovel();
  const eventoId = await eventoEmAndamento(ponto.id, { local: 'Ginásio Municipal', nome: 'Copa de Judô' });
  let f = await ficha(ponto.id);
  assert.strictEqual(f.localAtual.origem, 'evento');
  assert.strictEqual(f.localAtual.nome, 'Ginásio Municipal');
  assert.strictEqual(f.localAtual.endereco, 'Ginásio Municipal');
  assert.strictEqual(f.localAtual.evento.id, eventoId);
  assert.strictEqual(f.localAtual.evento.nome, 'Copa de Judô');
  assert.strictEqual(f.localAtual.evento.dataInicio, diaMais(0));
  assert.ok(f.localAtual.evento.inicio && f.localAtual.evento.fim);
  assert.strictEqual(f.proximoEvento, null, 'em andamento não é "próximo"');
  assert.strictEqual(f.alocado, true);
  assert.strictEqual(f.agora.tipo, 'evento');
  assert.strictEqual(f.agora.id, eventoId);
  const naLista = await daLista(ponto.id);
  assert.strictEqual(naLista.alocado, true);
  assert.strictEqual(naLista.agora.id, eventoId);
  assert.strictEqual(await noInventario(ponto.id), true, 'alocado, é inventário');
  const publico = (await publicos()).find((p) => p.id === ponto.id);
  assert.ok(publico, 'alocado, aparece em "Onde estamos"');
  assert.strictEqual(publico.tipo, 'movel');
  assert.strictEqual(publico.local_atual, 'Ginásio Municipal');
  assert.strictEqual(publico.evento_nome, 'Copa de Judô');
  assert.strictEqual(publico.base_nome, undefined);

  // Um lugar por vez (agenda única): período cruzando nem entra; um evento
  // de outra data não começa com este em andamento.
  const sobreposto = await admin(
    'POST',
    `/admin/pontos/${ponto.id}/eventos`,
    corpoDeEvento({ nome: 'Outro', inicio: paredeMais(2), fim: paredeMais(5) }),
  );
  assert.strictEqual(sobreposto.status, 409);
  assert.match(sobreposto.json.erro, /já está no evento/);
  const outro = await cadastrarEvento(ponto.id, { nome: 'Outro', inicio: paredeMais(72), fim: paredeMais(80) });
  const dois = await acaoNoEvento(ponto.id, outro, 'iniciar');
  assert.strictEqual(dois.status, 409);
  assert.match(dois.json.erro, /já está no evento/);
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'cancelar')).status, 409, 'em andamento não cancela');

  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'encerrar')).status, 200);
  f = await ficha(ponto.id);
  assert.strictEqual(f.localAtual, null, 'encerrado: sem alocação de novo');
  assert.strictEqual(f.alocado, false);
  assert.strictEqual(f.proximoEvento.id, outro);
  const encerrado = f.eventos.find((e) => e.id === eventoId);
  assert.strictEqual(encerrado.estado, 'encerrado');
  assert.strictEqual(encerrado.encerramento, 'manual');
  assert.ok(encerrado.iniciadoEm && encerrado.encerradoEm);
  assert.strictEqual(await noInventario(ponto.id), false);
  assert.ok(!(await publicos()).some((p) => p.id === ponto.id), 'some de "Onde estamos"');
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'iniciar')).status, 409, 'encerrado não recomeça');
  assert.strictEqual((await acaoNoEvento(ponto.id, outro, 'encerrar')).status, 409, 'programado não encerra');
  assert.strictEqual((await acaoNoEvento(ponto.id, outro, 'pausar')).status, 404, 'ação desconhecida');
});

test('10. evento cancelado não é próximo nem local atual, e fica no histórico', async () => {
  const ponto = await criarMovel();
  const cedo = await cadastrarEvento(ponto.id, { nome: 'Cedo', inicio: paredeMais(48), fim: paredeMais(56) });
  const tarde = await cadastrarEvento(ponto.id, {
    nome: 'Tarde',
    inicio: paredeMais(9 * 24),
    fim: paredeMais(10 * 24),
  });
  assert.strictEqual((await acaoNoEvento(ponto.id, cedo, 'cancelar')).status, 200);
  const f = await ficha(ponto.id);
  assert.strictEqual(f.proximoEvento.id, tarde);
  assert.strictEqual(f.localAtual, null);
  const cancelado = f.eventos.find((e) => e.id === cedo);
  assert.strictEqual(cancelado.estado, 'cancelado', 'auditável');
  assert.ok(cancelado.canceladoEm);
  assert.ok(!f.agenda.some((a) => a.id === cedo), 'cancelado sai da agenda');
  assert.strictEqual((await acaoNoEvento(ponto.id, cedo, 'iniciar')).status, 409, 'cancelado não começa');
  // Evento de outro ponto não se mexe por este.
  const outroPonto = await criarMovel();
  assert.strictEqual((await acaoNoEvento(outroPonto.id, tarde, 'iniciar')).status, 404);
  // Evento que passou do horário sem ter começado não começa mais.
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, organizacao, local, data_inicio, data_fim, inicio, fim)
     VALUES ($1, 'Velho', 'Org', 'Lugar', $2, $2, now() - interval '5 hours', now() - interval '1 hour') RETURNING id`,
    [ponto.id, diaMais(0)],
  );
  const velho = await acaoNoEvento(ponto.id, rows[0].id, 'iniciar');
  assert.strictEqual(velho.status, 409);
  assert.match(velho.json.erro, /já terminou/);
  assert.notStrictEqual((await ficha(ponto.id)).proximoEvento.id, Number(rows[0].id), 'passado nunca é próximo');
});

test('evento só existe em ponto móvel; base não existe mais (410)', async () => {
  const fixo = await aprovar(await novaConta());
  const r = await admin(
    'POST',
    `/admin/pontos/${fixo.id}/eventos`,
    corpoDeEvento({ inicio: paredeMais(72), fim: paredeMais(80) }),
  );
  assert.strictEqual(r.status, 409);
  const m = await criarMovel();
  for (const id of [fixo.id, m.id]) {
    const b = await admin('PUT', `/admin/pontos/${id}/base`, { base_conta_id: fixo.anunciante_id, base_nome: 'X' });
    assert.strictEqual(b.status, 410);
    assert.match(b.json.erro, /não tem base/);
  }
  const { rows } = await pool.query('SELECT base_conta_id, base_nome FROM pontos WHERE id = $1', [m.id]);
  assert.deepStrictEqual(rows[0], { base_conta_id: null, base_nome: null });
});

test('o móvel não tem horário, ramo nem endereço próprios: PATCH recusa', async () => {
  const ponto = await criarMovel();
  const categoriaId = await novaCategoria('Ramo Teste');
  const horario = await admin('PATCH', `/admin/pontos/${ponto.id}`, { horario_semanal: HORARIO_COMERCIAL });
  assert.strictEqual(horario.status, 400);
  assert.match(horario.json.erro, /hospedagem ou evento/);
  const ramo = await admin('PATCH', `/admin/pontos/${ponto.id}`, { categoria_id: categoriaId });
  assert.strictEqual(ramo.status, 400);
  const endereco = await admin('PATCH', `/admin/pontos/${ponto.id}/endereco`, {
    cep: '15990-000',
    logradouro: 'Rua Nova',
    numero: '55',
    bairro: 'Jardim',
    cidade: 'Matão',
    uf: 'SP',
  });
  assert.strictEqual(endereco.status, 409);
  assert.match(endereco.json.erro, /não tem endereço próprio/);
  const { rows } = await pool.query('SELECT horario_semanal, categoria_id, logradouro FROM pontos WHERE id = $1', [
    ponto.id,
  ]);
  assert.deepStrictEqual(rows[0], { horario_semanal: null, categoria_id: null, logradouro: null });
  // O que é do equipamento continua editável.
  const nota = await admin('PATCH', `/admin/pontos/${ponto.id}`, { observacoes: 'lacre 123' });
  assert.strictEqual(nota.status, 200, JSON.stringify(nota.json));
});

// ---------- 12 a 14. organizador, Plano Básico, crédito ----------
test('12, 13 e 14. organizador não vira dono; evento e móvel não dão Plano Básico nem crédito', async () => {
  const ponto = await criarMovel();
  await telaInstalada(ponto.id);
  await eventoEmAndamento(ponto.id, { organizacao: 'Igreja Y' });

  await basico.sincronizar({ apenasPontos: [ponto.id] });
  await creditosPonto.concederCreditosMensais({ apenasPontos: [ponto.id] });

  const { rows: p } = await pool.query('SELECT anunciante_id, base_conta_id FROM pontos WHERE id = $1', [ponto.id]);
  assert.strictEqual(p[0].anunciante_id, null, 'continua da Mostraí');
  assert.strictEqual(p[0].base_conta_id, null, 'o evento não cria base');
  const igreja = await pool.query(`SELECT 1 FROM anunciantes WHERE nome_empresa = 'Igreja Y'`);
  assert.strictEqual(igreja.rowCount, 0, 'organização é texto do evento, nunca conta');
  const basicoDoPonto = await pool.query('SELECT 1 FROM beneficios_basico_ponto WHERE ponto_id = $1', [ponto.id]);
  assert.strictEqual(basicoDoPonto.rowCount, 0, 'sem Plano Básico pelo móvel');
  const credito = await pool.query('SELECT 1 FROM creditos_ledger WHERE ponto_id = $1', [ponto.id]);
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
// Ponto fixo na rede, em operação e aberto a escolha nova — quem o usa tira
// do sorteio automático (`tirarDoSorteio`) logo depois de escolher, para não
// cair na fatia de contas de outros arquivos de teste.
async function pontoFixo() {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ($1, 'Rua Um, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '1', 'em_operacao') RETURNING id`,
    [`Fixo ${randomUUID().slice(0, 8)}`],
  );
  criadas.pontos.push(rows[0].id);
  return rows[0].id;
}

// ---------- 15. MOSTRAÍ MÓVEL como opção de seleção (migration 115) ----------
test('15. Mostraí Móvel: opção sempre no catálogo, 1 posição do plano, nunca a unidade; escolha salva e removível', async () => {
  const unidade = await criarMovel();
  await tirarDoSorteio(unidade.id);
  const [f1, f2, f3] = [await pontoFixo(), await pontoFixo(), await pontoFixo()];
  const anunciante = await novaConta();
  await anunciantesRepo.atualizar(anunciante.id, { plano_id: 'essencial-1m' });
  const nav = await entrar(anunciante);

  // Unidade sem alocação: a opção existe mesmo assim, e a unidade nunca é item.
  const antes = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(antes.status, 200, JSON.stringify(antes.json));
  assert.strictEqual(antes.json.mostraiMovel.escolhido, false);
  assert.strictEqual(typeof antes.json.mostraiMovel.unidadesEmOperacao, 'number');
  assert.ok(!antes.json.pontos.some((p) => p.id === unidade.id), 'unidade fora da lista');
  assert.ok(
    antes.json.pontos.every((p) => p.tipo === undefined && p.movel === undefined),
    'nada de unidade no item',
  );

  // Alocada e em operação: continua não sendo item (a escolha é a opção).
  const evento = await eventoEmAndamento(unidade.id, { horario_operacao: '24h' });
  await pool.query(`UPDATE pontos SET status = 'em_operacao' WHERE id = $1`, [unidade.id]);
  const alocada = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.ok(!alocada.json.pontos.some((p) => p.id === unidade.id));
  assert.ok(alocada.json.mostraiMovel.unidadesEmOperacao >= 1, 'a unidade alocada conta como em operação');
  const unidadeDireta = await nav('PUT', '/anunciantes/me/pontos', { pontos: [unidade.id] });
  assert.strictEqual(unidadeDireta.status, 400, 'equipamento individual não é escolha');

  // 3 fixos + a opção = 4 escolhas num plano de 3: recusado.
  const demais = await nav('PUT', '/anunciantes/me/pontos', { pontos: [f1, f2, f3, 'mostrai_movel'] });
  assert.strictEqual(demais.status, 400);
  assert.match(demais.json.erro, /cobre 3 ponto\(s\) e você marcou 4/);
  // 2 fixos + a opção = 3 de 3.
  const ok = await nav('PUT', '/anunciantes/me/pontos', { pontos: [f1, f2, 'mostrai_movel'] });
  for (const id of [f1, f2, f3]) await tirarDoSorteio(id);
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.deepStrictEqual(ok.json.escolhidos, [f1, f2, 'mostrai_movel']);
  const depois = (await nav('GET', '/anunciantes/me/pontos-disponiveis')).json;
  assert.strictEqual(depois.mostraiMovel.escolhido, true);
  assert.strictEqual(depois.modoAutomatico, false);
  assert.strictEqual(depois.cobertura.veiculando, 3, 'pool móvel = 1 posição no ar');
  assert.ok(depois.cobertura.pontosNoAr >= 3, 'os locais físicos contam um a um');
  const { rows } = await pool.query(
    `SELECT (SELECT array_agg(ponto_id ORDER BY ponto_id) FROM anunciantes_pontos WHERE anunciante_id = $1) AS pontos,
            mostrai_movel_escolhido_em IS NOT NULL AS movel
       FROM anunciantes WHERE id = $1`,
    [anunciante.id],
  );
  assert.deepStrictEqual(rows[0], { pontos: [f1, f2].sort((a, b) => a - b), movel: true }, 'nunca grava a unidade');

  // Encerrada a alocação, a escolha continua (preferência), e não há
  // unidade no ar: a posição volta para os fixos (2 posições no ar).
  assert.strictEqual((await acaoNoEvento(unidade.id, evento, 'encerrar')).status, 200);
  const semUnidade = (await nav('GET', '/anunciantes/me/pontos-disponiveis')).json;
  assert.strictEqual(semUnidade.mostraiMovel.escolhido, true, 'a escolha não some sem unidade');
  assert.strictEqual(semUnidade.cobertura.veiculando, 2);
  assert.strictEqual(semUnidade.cobertura.compensando, true, 'o tempo da posição móvel volta para os fixos');

  // Tirar a opção.
  assert.strictEqual((await nav('PUT', '/anunciantes/me/pontos', { pontos: [f1] })).status, 200);
  assert.strictEqual(
    (await pool.query('SELECT mostrai_movel_escolhido_em FROM anunciantes WHERE id = $1', [anunciante.id])).rows[0]
      .mostrai_movel_escolhido_em,
    null,
  );
});

test('Mostraí Móvel: o pool é resolvido a cada hora — alocação entra, fim da alocação sai, sem editar a campanha', async () => {
  const [a, b] = [await criarMovel(), await criarMovel()];
  for (const u of [a, b]) {
    await tirarDoSorteio(u.id);
    await dispositivosRepo.atualizar(u.telaId, { status: 'ativo' });
    await instalarPlayer(u.telaId);
    await pool.query(`UPDATE pontos SET status = 'em_operacao' WHERE id = $1`, [u.id]);
  }
  const conta = await contaComPlanoEPeca(a.id);
  const contasNa = async (u) => {
    const envelope = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(u.telaId), new Date());
    return new Set(envelope.itens.map((i) => i.anuncianteId));
  };
  // Sem alocação: ninguém.
  assert.ok(!(await contasNa(a)).has(conta.id), 'unidade sem alocação não recebe comercial');
  // A entra numa alocação: a campanha passa a poder tocar nela.
  const evA = await eventoEmAndamento(a.id, { horario_operacao: '24h' });
  assert.ok((await contasNa(a)).has(conta.id), 'alocada e dentro do horário: recebe');
  // Fim da alocação de A, B começa outra: A sai do pool, B entra.
  assert.strictEqual((await acaoNoEvento(a.id, evA, 'encerrar')).status, 200);
  await eventoEmAndamento(b.id, { horario_operacao: '24h' });
  assert.ok(!(await contasNa(a)).has(conta.id), 'fim da alocação tira a unidade do pool');
  assert.ok((await contasNa(b)).has(conta.id), 'a nova alocação entra sozinha');
  assert.strictEqual(
    (await pool.query('SELECT COUNT(*)::int AS n FROM anunciantes_pontos WHERE anunciante_id = $1', [conta.id])).rows[0]
      .n,
    0,
    'a escolha nunca foi uma unidade',
  );
});

test('Mostraí Móvel: unidade alocada fora do horário da alocação não deve nada nesta hora', async () => {
  const u = await criarMovel();
  await tirarDoSorteio(u.id);
  await dispositivosRepo.atualizar(u.telaId, { status: 'ativo' });
  await instalarPlayer(u.telaId);
  await pool.query(`UPDATE pontos SET status = 'em_operacao' WHERE id = $1`, [u.id]);
  const conta = await contaComPlanoEPeca(u.id);
  const fechadoHoje = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null };
  fechadoHoje[diaDaSemana(diaMais(3))] = { abre: '10:00', fecha: '11:00' };
  await eventoEmAndamento(u.id, { horario_operacao: fechadoHoje });
  const dispositivo = await dispositivosRepo.buscarComPonto(u.telaId);
  await gerador.gerarPlaylistDaHora(dispositivo, new Date());
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(segundos_obrigacao), 0)::int AS devido FROM exibicoes_contador
      WHERE dispositivo_id = $1 AND anunciante_id = $2`,
    [u.telaId, conta.id],
  );
  assert.strictEqual(rows[0].devido, 0, 'fora do horário: nenhuma obrigação, a TV fica apagada');
});

// ---------- 16. Proof-of-Play ----------
// Conta com plano e peça que escolheu a opção MOSTRAÍ MÓVEL (migration 115) —
// nunca a unidade: `_pontoId` é só a unidade que o teste observa.
async function contaComPlanoEPeca(_pontoId, categoriaId = null) {
  const conta = await novaConta({ categoriaId });
  await pool.query('UPDATE anunciantes SET mostrai_movel_escolhido_em = now() WHERE id = $1', [conta.id]);
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
  const ponto = await criarMovel();
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

  const antes = await confirmarUmaExibicao(telaId, conta.id, hora);
  assert.strictEqual(antes.status, 'contabilizado');
  assert.strictEqual(antes.eventoId, null, 'fora de evento, sem evento');

  const eventoId = await eventoEmAndamento(ponto.id);
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

// ---------- trava de ramo: o contexto é o do evento ----------
test('trava de ramo no evento: o ramo é o do evento (não há base); sem ramo no evento, ninguém é barrado', async () => {
  const categoriaId = await novaCategoria('Academia Teste');
  const ponto = await criarMovel();
  await tirarDoSorteio(ponto.id);
  const tela = { id: ponto.telaId };
  await dispositivosRepo.atualizar(tela.id, { status: 'ativo' });
  await instalarPlayer(tela.id);

  // Um concorrente do ramo do evento e uma conta sem ramo escolheram o móvel.
  const concorrente = await contaComPlanoEPeca(ponto.id, categoriaId);
  const neutra = await contaComPlanoEPeca(ponto.id);

  const eventoId = await eventoEmAndamento(ponto.id, { categoria_id: categoriaId, horario_operacao: '24h' });
  const dispositivo = await dispositivosRepo.buscarComPonto(tela.id);
  assert.strictEqual(dispositivo.movel_alocado, true);
  assert.strictEqual(dispositivo.categoria_id, categoriaId, 'o ramo em vigor é o do evento');
  assert.strictEqual(dispositivo.casa_conta_id, null, 'evento não tem casa');
  assert.strictEqual(dispositivo.dono_conta_id, null);
  const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
  const contas = new Set(envelope.itens.map((i) => i.anuncianteId));
  assert.ok(contas.has(neutra.id), 'quem não é do ramo entra');
  assert.ok(!contas.has(concorrente.id), 'o concorrente do ramo do evento fica fora');
  assert.strictEqual((await ficha(ponto.id)).eventos.find((e) => e.id === eventoId).categoria.id, categoriaId);

  // Outro móvel, evento sem ramo: o mesmo concorrente entra.
  const livre = await criarMovel();
  await tirarDoSorteio(livre.id);
  await dispositivosRepo.atualizar(livre.telaId, { status: 'ativo' });
  await instalarPlayer(livre.telaId);
  const concorrenteLivre = await contaComPlanoEPeca(livre.id, categoriaId);
  await eventoEmAndamento(livre.id, { horario_operacao: '24h' });
  const dispLivre = await dispositivosRepo.buscarComPonto(livre.telaId);
  assert.strictEqual(dispLivre.categoria_id, null);
  const envLivre = await gerador.gerarPlaylistDaHora(dispLivre, new Date());
  assert.ok(
    envLivre.itens.some((i) => i.anuncianteId === concorrenteLivre.id),
    'evento sem ramo não barra ninguém',
  );
});

// ---------- horário: o do evento vai para a TV ----------
test('em evento a TV recebe o horário DO EVENTO; ao encerrar, fica sem horário — e a TV é avisada', async () => {
  const ponto = await criarMovel();
  const telaId = await telaInstalada(ponto.id);
  const versao = async () =>
    (await pool.query('SELECT config_versao_desejada FROM dispositivos WHERE id = $1', [telaId])).rows[0]
      .config_versao_desejada;
  const antes = await versao();
  assert.strictEqual((await dispositivosRepo.buscarComPonto(telaId)).ponto_horario_semanal, null, 'sem alocação');

  const horarioDoEvento = { ...HORARIO_COMERCIAL, dom: { abre: '09:00', fecha: '17:00' } };
  const eventoId = await eventoEmAndamento(ponto.id, { horario_operacao: horarioDoEvento });
  assert.deepStrictEqual((await dispositivosRepo.buscarComPonto(telaId)).ponto_horario_semanal, horarioDoEvento);
  assert.ok((await versao()) > antes, 'a config da TV muda ao entrar no evento');
  assert.deepStrictEqual(
    (await ficha(ponto.id)).eventos.find((e) => e.id === eventoId).horarioOperacao,
    horarioDoEvento,
  );

  const noEvento = await versao();
  await acaoNoEvento(ponto.id, eventoId, 'encerrar');
  assert.strictEqual((await dispositivosRepo.buscarComPonto(telaId)).ponto_horario_semanal, null);
  assert.ok((await versao()) > noEvento, 'e muda de novo ao sair');
});

// A régua "no ar" do anunciante lê o MESMO horário em vigor da TV
// (src/lib/contexto-do-ponto.js): sem alocação, "sem alocação"; no evento, o
// horário do evento decide entre "no ar" e "fora do horário".
test('situação da tela para o anunciante e o Admin: sem alocação, fora do horário do evento, no ar', async () => {
  const ponto = await criarMovel();
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
  assert.strictEqual((await situacoes()).anunciante, 'sem_alocacao', 'sem alocação nunca é "no ar"');

  // Evento que cobre agora, mas aberto só num outro dia da semana.
  const outroDia = diaDaSemana(diaMais(3));
  const fechadoHoje = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null };
  fechadoHoje[outroDia] = { abre: '10:00', fecha: '11:00' };
  const fechado = await eventoEmAndamento(ponto.id, { horario_operacao: fechadoHoje });
  assert.deepStrictEqual(
    await situacoes(),
    { anunciante: 'fora_do_horario', admin: 'fora_do_horario' },
    'fora do horário do evento',
  );
  assert.strictEqual((await acaoNoEvento(ponto.id, fechado, 'encerrar')).status, 200);

  const aberto = await eventoEmAndamento(ponto.id, { horario_operacao: '24h' });
  assert.deepStrictEqual(await situacoes(), { anunciante: 'no_ar', admin: 'operando' }, 'no evento 24 h');

  await acaoNoEvento(ponto.id, aberto, 'encerrar');
  assert.strictEqual((await situacoes()).anunciante, 'sem_alocacao', 'de volta a sem alocação');
});

// ---------- tipo imutável (V2) ----------
test('tipo imutável: fixo não vira móvel nem móvel vira fixo — rota 410 e o banco recusa', async () => {
  const dona = await novaConta();
  const fixo = await aprovar(dona);
  const movelPronto = await criarMovel();
  const a = await admin('POST', `/admin/pontos/${fixo.id}/tornar-movel`);
  const b = await admin('POST', `/admin/pontos/${movelPronto.id}/tornar-fixo`);
  assert.strictEqual(a.status, 410);
  assert.strictEqual(b.status, 410);
  await assert.rejects(
    pool.query(`UPDATE pontos SET tipo = 'movel', anunciante_id = NULL, movel_numero = 999999 WHERE id = $1`, [
      fixo.id,
    ]),
    (e) => e.code === '23514',
  );
  await assert.rejects(
    pool.query(
      `UPDATE pontos SET tipo = 'fixo', anunciante_id = $2, endereco = 'Rua X, 1', cidade = 'Matão', uf = 'SP',
                         cep = '15990000' WHERE id = $1`,
      [movelPronto.id, dona.id],
    ),
    (e) => e.code === '23514',
  );
  const { rows } = await pool.query('SELECT id, tipo FROM pontos WHERE id = ANY($1::int[])', [
    [fixo.id, movelPronto.id],
  ]);
  assert.strictEqual(rows.find((r) => r.id === fixo.id).tipo, 'fixo');
  assert.strictEqual(rows.find((r) => r.id === movelPronto.id).tipo, 'movel');
});

test('situacaoDosMoveis ignora ponto fixo e id inválido; "Meus pontos" não tem mais móvel', async () => {
  const fixo = await aprovar(await novaConta());
  const mapa = await movel.situacaoDosMoveis([fixo.id, 'abc', -1]);
  assert.strictEqual(mapa.size, 0);
  const meus = await meusPontosDaConta(fixo.anunciante_id);
  assert.ok(meus.every((e) => e.tipo !== 'base_movel'));
  const m = await criarMovel();
  assert.deepStrictEqual((await movel.situacaoDosMoveis([m.id, fixo.id])).get(m.id), {
    localAtual: null,
    proximoEvento: null,
  });
});
