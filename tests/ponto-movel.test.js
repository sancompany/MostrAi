const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// PONTO FIXO E REDE MÓVEL (migrations 112 a 115, src/pontos/movel.js). O
// ponto móvel (`pontos.tipo = 'movel'`) é a REDE MÓVEL de uma cidade
// (migration 115): nasce só pelo Admin (POST /admin/pontos-moveis, nome +
// cidade + UF, uma por cidade), sem dona e SEM tela — as telas entram por "+ Adicionar
// tela", quantas forem. Candidatura gera sempre fixo; o tipo não muda. Cada
// TELA só tem local, horário, ramo e lugar no inventário enquanto está
// ALOCADA (hospedagem ativa ou evento em andamento com ela); o evento é da
// rede, com uma ou várias telas. Aqui: o fixo intocado, a propriedade, o
// ciclo do evento, o contexto que o evento dá às telas DELE (horário na TV,
// trava de ramo, POP) e o card do anunciante. Várias telas ao mesmo tempo, o
// pool da hora e a hospedagem: tests/rede-movel.test.js e
// tests/hospedagem.test.js. Roda o `app` REAL (src/server.js): a guarda do
// /admin, o login do admin e o do anunciante de verdade. Cada teste cria as
// próprias contas e redes (em cidades únicas) — os arquivos de teste rodam
// em paralelo no mesmo banco.
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
const criadas = { contas: [], pontos: [], categorias: [], aprovacoes: 0 };
const INICIO_DO_ARQUIVO = new Date();
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
    // As métricas anônimas que citam a rede, o ponto ou a tela de teste.
    await pool.query(
      `DELETE FROM eventos WHERE anunciante_id IS NULL
          AND (propriedades->>'ponto_id' = $1::int::text
               OR propriedades->>'dispositivo_id' IN (SELECT id::text FROM dispositivos WHERE ponto_id = $1::int))`,
      [id],
    );
    const hosp = 'SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1';
    await pool.query(`DELETE FROM saldo_hospedagem_lancamentos WHERE hospedagem_id IN (${hosp})`, [id]);
    await pool.query(`DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (${hosp})`, [id]);
    // Hospedagem e evento (com as telas dele, em cascata) saem antes das
    // telas que eles referenciam.
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
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  for (const id of criadas.contas) {
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    // O e-mail "ponto aprovado" de cada aprovação (src/conta/modos.js).
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  for (const id of criadas.categorias) await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
  // A métrica anônima de cada aprovação deste arquivo (não cita o ponto).
  await pool.query(
    `DELETE FROM eventos WHERE id IN (
       SELECT id FROM eventos
        WHERE nome = 'ponto:candidatura_aprova' AND anunciante_id IS NULL AND criado_em >= $1
          AND propriedades @> '{"ramo": "academia", "cidade": "Matão", "ponto_tipo": "fixo"}'
        ORDER BY id DESC LIMIT $2)`,
    [INICIO_DO_ARQUIVO, criadas.aprovacoes],
  );
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

// Horário de funcionamento do ponto fixo (candidatura) e de evento com
// horário próprio. O formato é o de `pontos.horario_semanal` já normalizado
// (com `feriados`), para comparar com o que a TV recebe.
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
  criadas.aprovacoes += 1;
  return pontoDaCandidatura(cand.id);
}

const cidadeUnica = () => `Cidade ${randomUUID().slice(0, 8)}`;

// A rede nasce pelo Admin (nome obrigatório, cidade única + UF; nota
// interna opcional), sem tela; `telas` telas entram em seguida pela rota da
// ficha ("+ Adicionar tela"). Nasce sem alocação.
async function criarMovel(corpo = {}, { telas = 1 } = {}) {
  const r = await admin('POST', '/admin/pontos-moveis', {
    nome: 'Mostraí Móvel',
    cidade: cidadeUnica(),
    uf: 'SP',
    ...corpo,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  const ids = [];
  for (let i = 0; i < telas; i++) {
    const t = await admin('POST', `/admin/pontos/${r.json.id}/dispositivos`, {});
    assert.strictEqual(t.status, 201, JSON.stringify(t.json));
    ids.push(t.json.id);
  }
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [r.json.id]);
  return { ...rows[0], telaId: ids[0], telas: ids };
}

// Tela instalada: na rede, a primeira tela dela; no fixo, uma tela nova.
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

// Evento padrão nas `telas`: daqui a 5 dias, por um dia, operando o período
// inteiro (sem horário). Com `data_inicio` (formato antigo, só datas) ou
// `inicio`, o período vem do `extra`.
function corpoDeEvento(telas, extra = {}) {
  const periodo = extra.data_inicio || extra.inicio ? {} : { inicio: paredeMais(5 * 24), fim: paredeMais(6 * 24) };
  return {
    nome: 'Campeonato Regional de Jiu-Jitsu',
    organizacao: 'Federação Regional',
    local: 'Ginásio Municipal',
    endereco: 'Rua do Ginásio, 50',
    ...periodo,
    publico_estimado: 600,
    telas,
    ...extra,
  };
}

// Na primeira tela da rede, salvo `telas` no `extra`.
async function cadastrarEvento(ponto, extra = {}) {
  const r = await admin('POST', `/admin/pontos/${ponto.id}/eventos`, corpoDeEvento([ponto.telaId], extra));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

// Evento que cobre agora (começou há 1 h, acaba amanhã), já iniciado — e
// iniciado ANTES da hora cheia: as telas dele estão no pool da hora
// (`rede_movel_pool`) e o gerador veicula nelas já nesta hora.
async function eventoEmAndamento(ponto, extra = {}) {
  const id = await cadastrarEvento(ponto, { inicio: paredeMais(-1), fim: paredeMais(24), ...extra });
  const r = await acaoNoEvento(ponto.id, id, 'iniciar');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  await pool.query(
    `UPDATE pontos_moveis_eventos SET iniciado_em = date_trunc('hour', now()) - interval '1 minute' WHERE id = $1`,
    [id],
  );
  return id;
}

const ficha = async (pontoId) => (await admin('GET', `/admin/pontos/${pontoId}/movel`)).json;
const telaNaFicha = (f, telaId) => f.telas.find((t) => t.id === telaId);
const acaoNoEvento = (pontoId, eventoId, acao) => admin('POST', `/admin/pontos/${pontoId}/eventos/${eventoId}/${acao}`);
// A rede vista pelo grid do Admin e pelo card (src/pontos/movel.js
// #situacaoDasRedes) e os compromissos dela na Agenda móvel do Admin
// (#agendaDasRedes: um por compromisso, evento com várias telas é UM).
const situacao = async (pontoId) => (await movel.situacaoDasRedes([pontoId])).get(pontoId);
const naAgenda = async (pontoId, opcoes) => (await movel.agendaDasRedes(opcoes)).filter((c) => c.redeId === pontoId);
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

test('3. candidatura nunca vira rede móvel; o Admin cria a rede da cidade — sem dona, base, endereço, horário, ramo nem tela', async () => {
  const conta = await novaConta();
  const cand = await novaCandidatura(conta);
  const r = await admin('POST', `/admin/candidaturas/${cand.id}/liberar`, { tipo: 'movel' });
  assert.strictEqual(r.status, 400, 'candidatura sempre gera ponto fixo');
  assert.match(r.json.erro, /sempre gera ponto fixo/);
  assert.strictEqual(await pontoDaCandidatura(cand.id), null);

  // O nome é obrigatório e independente da cidade (estação Rede/Admin V2):
  // o sistema não compõe mais "Mostraí Móvel — {Cidade}" sozinho.
  for (const nome of [undefined, '', '   ']) {
    const semNome = await admin('POST', '/admin/pontos-moveis', { nome, cidade: cidadeUnica(), uf: 'SP' });
    assert.strictEqual(semNome.status, 400, `nome ${JSON.stringify(nome)}`);
    assert.strictEqual(semNome.json.campo, 'nome');
  }

  // Campos do modelo antigo (base, endereço, horário) são ignorados.
  const cidade = cidadeUnica();
  const ponto = await criarMovel(
    {
      cidade,
      base_conta_id: conta.id,
      base_nome: 'Academia X',
      logradouro: 'Avenida Brasil',
      horario_semanal: HORARIO_COMERCIAL,
      observacoes: 'caixa 3 no depósito',
    },
    { telas: 0 },
  );
  assert.strictEqual(ponto.tipo, 'movel');
  assert.strictEqual(ponto.nome, 'Mostraí Móvel', 'o nome que o Admin digitou, sem a cidade');
  assert.deepStrictEqual([ponto.cidade, ponto.uf], [cidade, 'SP']);
  assert.strictEqual(ponto.origem, 'movel', 'origem auditável (migration 116)');
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
  const { rows: telas } = await pool.query('SELECT 1 FROM dispositivos WHERE ponto_id = $1', [ponto.id]);
  assert.strictEqual(telas.length, 0, 'nenhuma tela nasce junto');
  const { rows } = await pool.query('SELECT papeis FROM anunciantes WHERE id = $1', [conta.id]);
  assert.ok(!rows[0].papeis.includes('ponto'), 'ninguém ganha o papel de dono');
  const cupom = await pool.query('SELECT 1 FROM cupons_ponto WHERE conta_id = $1', [conta.id]);
  assert.strictEqual(cupom.rowCount, 0, 'criar a rede não cria cupom para ninguém');

  // Nome informado vale (espaços normalizados); comprido demais é recusado.
  const nomeado = await criarMovel({ nome: '  Totem   da Feira ' }, { telas: 0 });
  assert.strictEqual(nomeado.nome, 'Totem da Feira');
  assert.ok(nomeado.movel_numero > ponto.movel_numero, 'o número continua sequencial');
  const longo = await admin('POST', '/admin/pontos-moveis', { cidade: cidadeUnica(), uf: 'SP', nome: 'x'.repeat(121) });
  assert.strictEqual(longo.status, 400);
  assert.strictEqual(longo.json.campo, 'nome');
});

// ---------- 4 e 17. segurança e propriedade ----------
test('4. conta comum (e anônimo) não cria rede nem mexe em rede, tela livre ou evento', async () => {
  const conta = await novaConta();
  const nav = await entrar(conta);
  const anon = navegador();
  const cand = await novaCandidatura(conta);
  const movelPronto = await criarMovel();
  const fixo = await aprovar(await novaConta());
  for (const quem of [nav, anon]) {
    assert.strictEqual((await quem('POST', `/admin/candidaturas/${cand.id}/liberar`, { tipo: 'movel' })).status, 401);
    assert.strictEqual((await quem('POST', '/admin/pontos-moveis', { cidade: cidadeUnica(), uf: 'SP' })).status, 401);
    assert.strictEqual((await quem('GET', '/admin/pontos-moveis/agenda')).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${movelPronto.id}/foto`)).status, 401);
    assert.strictEqual((await quem('PATCH', `/admin/pontos/${movelPronto.id}/movel`, { nome: 'X' })).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${movelPronto.id}/dispositivos`, {})).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${fixo.id}/tornar-movel`)).status, 401);
    assert.strictEqual((await quem('POST', `/admin/pontos/${movelPronto.id}/tornar-fixo`)).status, 401);
    assert.strictEqual((await quem('PUT', `/admin/pontos/${movelPronto.id}/base`, {})).status, 401);
    assert.strictEqual(
      (
        await quem(
          'POST',
          `/admin/pontos/${movelPronto.id}/eventos`,
          corpoDeEvento([movelPronto.telaId], { inicio: paredeMais(2), fim: paredeMais(5) }),
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
  const telas = await pool.query('SELECT 1 FROM dispositivos WHERE ponto_id = $1', [movelPronto.id]);
  assert.strictEqual(telas.rowCount, 1, 'só a tela que o Admin adicionou');
});

test('17. propriedade: a rede nunca ganha dono — nem pelo PATCH do admin, nem pelo banco, nem pela escolha', async () => {
  const conta = await novaConta();
  const ponto = await criarMovel({}, { telas: 0 });
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
    'rede móvel nunca vem de candidatura',
  );
  await assert.rejects(
    pool.query('UPDATE pontos SET movel_numero = NULL WHERE id = $1', [ponto.id]),
    (e) => e.code === '23514',
    'rede móvel sempre tem número',
  );
  // Quem escolhe a rede (escolhível mesmo sem tela em operação) não vira
  // dona: não edita o endereço e não a vê em "Meus pontos".
  await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m' });
  const nav = await entrar(conta);
  assert.strictEqual((await nav('PUT', '/anunciantes/me/pontos', { pontos: [ponto.id] })).status, 200);
  const end = await nav('PATCH', `/anunciantes/me/pontos/${ponto.id}/endereco`, { numero: '999' });
  assert.strictEqual(end.status, 404);
  const meus = await nav('GET', '/anunciantes/me/meus-pontos');
  assert.strictEqual(meus.status, 200);
  assert.strictEqual(meus.json.ehPonto, false);
  assert.ok(!meus.json.estabelecimentos.some((e) => e.id === ponto.id), 'a rede não aparece como dela');
  assert.strictEqual(
    (await pool.query('SELECT anunciante_id FROM pontos WHERE id = $1', [ponto.id])).rows[0].anunciante_id,
    null,
  );
});

// ---------- 5 a 11. eventos ----------
test('5 a 9. evento em andamento aloca SÓ as telas dele (local, inventário, "Onde estamos"); encerrado, voltam a sem alocação', async () => {
  const ponto = await criarMovel({}, { telas: 2 });
  const [a, b] = ponto.telas;
  await tirarDoSorteio(ponto.id);
  // Sem alocação: nenhum local, nada na agenda, fora do inventário — e em
  // "Onde estamos" como UM card sem localização (a rede não tem base nem
  // pino próprio).
  let f = await ficha(ponto.id);
  assert.strictEqual(f.tipo, 'movel');
  assert.deepStrictEqual(f.agenda, []);
  assert.deepStrictEqual(f.basesAnteriores, []);
  assert.strictEqual(f.base, undefined, 'a ficha não tem base');
  assert.ok(f.telas.every((t) => t.alocacao === null && t.proximo === null));
  assert.strictEqual(await noInventario(ponto.id), false, 'fora do inventário (pontosEmOperacao/telasNaRede)');
  assert.deepStrictEqual(
    (await publicos()).filter((p) => p.id === ponto.id).map((p) => p.movel.agora),
    [[]],
    '"Onde estamos": a rede, sem localização',
  );

  const eventoId = await eventoEmAndamento(ponto, { nome: 'Copa de Judô', telas: [a] });
  f = await ficha(ponto.id);
  const ta = telaNaFicha(f, a);
  assert.deepStrictEqual(
    [ta.alocacao.tipo, ta.alocacao.id, ta.alocacao.local, ta.alocacao.endereco, ta.operando],
    ['evento', eventoId, 'Ginásio Municipal', 'Rua do Ginásio, 50', true],
  );
  assert.strictEqual(telaNaFicha(f, b).alocacao, null, 'a outra tela da rede continua sem alocação');
  assert.strictEqual(f.resumo.emOperacao, 1);
  assert.deepStrictEqual(
    f.agenda.map((x) => [x.tipo, x.id, x.estado, x.telas.map((t) => t.id)]),
    [['evento', eventoId, 'em_andamento', [a]]],
  );
  // O grid do Admin e o card: onde a rede está agora (o local do evento),
  // quantas telas e quantas em operação.
  const naSituacao = await situacao(ponto.id);
  assert.deepStrictEqual(
    [naSituacao.telas, naSituacao.emOperacao, naSituacao.locaisAgora],
    [2, 1, [{ origem: 'evento', nome: 'Ginásio Municipal', endereco: 'Rua do Ginásio, 50', evento: 'Copa de Judô' }]],
  );
  // A Agenda móvel do Admin: o evento em curso, com SÓ a tela dele.
  assert.deepStrictEqual(
    (await naAgenda(ponto.id)).map((x) => [x.tipo, x.id, x.emCurso, x.telas.map((t) => t.id)]),
    [['evento', eventoId, true, [a]]],
  );
  assert.strictEqual(await noInventario(ponto.id), true, 'uma tela alocada: a rede é inventário');
  const publico = (await publicos()).filter((p) => p.id === ponto.id);
  assert.strictEqual(publico.length, 1, 'uma linha: a rede');
  assert.strictEqual(publico[0].tipo, 'movel');
  assert.deepStrictEqual(publico[0].movel.agora, [
    { nome: 'Ginásio Municipal', endereco: 'Rua do Ginásio, 50', evento: 'Copa de Judô' },
  ]);
  assert.strictEqual(publico[0].endereco, null, 'sem endereço-base');
  assert.strictEqual(publico[0].base_nome, undefined);

  // A tela A está num lugar só: período cruzando nem entra; um evento de
  // outra data com ela não começa com este em andamento.
  const sobreposto = await admin(
    'POST',
    `/admin/pontos/${ponto.id}/eventos`,
    corpoDeEvento([a], { nome: 'Outro', inicio: paredeMais(2), fim: paredeMais(5) }),
  );
  assert.strictEqual(sobreposto.status, 409);
  assert.match(sobreposto.json.erro, /já está no evento “Copa de Judô”/);
  const outro = await cadastrarEvento(ponto, {
    nome: 'Outro',
    inicio: paredeMais(72),
    fim: paredeMais(80),
    telas: [a],
  });
  const dois = await acaoNoEvento(ponto.id, outro, 'iniciar');
  assert.strictEqual(dois.status, 409);
  assert.match(dois.json.erro, /já está no evento/);
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'cancelar')).status, 409, 'em andamento não cancela');

  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'encerrar')).status, 200);
  f = await ficha(ponto.id);
  assert.strictEqual(telaNaFicha(f, a).alocacao, null, 'encerrado: sem alocação de novo');
  assert.strictEqual(telaNaFicha(f, a).proximo.id, outro);
  assert.deepStrictEqual((await situacao(ponto.id)).locaisAgora, [], 'encerrado: a rede não está em lugar nenhum');
  assert.deepStrictEqual(
    (await naAgenda(ponto.id)).map((x) => x.id),
    [outro],
    'a Agenda móvel fica só com o futuro',
  );
  assert.ok(
    (await naAgenda(ponto.id, { historico: true })).some((x) => x.id === eventoId && x.estado === 'encerrado'),
    'o encerrado vai para o histórico',
  );
  const encerrado = f.eventos.find((e) => e.id === eventoId);
  assert.strictEqual(encerrado.estado, 'encerrado');
  assert.strictEqual(encerrado.encerramento, 'manual');
  assert.ok(encerrado.iniciadoEm && encerrado.encerradoEm);
  assert.strictEqual(await noInventario(ponto.id), false);
  const depois = (await publicos()).find((p) => p.id === ponto.id);
  assert.deepStrictEqual(depois.movel.agora, [], 'encerrado: "Onde estamos" sem localização');
  assert.strictEqual(depois.movel.proximo.nome, 'Outro', 'o próximo é o programado, nunca o encerrado');
  assert.strictEqual((await acaoNoEvento(ponto.id, eventoId, 'iniciar')).status, 409, 'encerrado não recomeça');
  assert.strictEqual((await acaoNoEvento(ponto.id, outro, 'encerrar')).status, 409, 'programado não encerra');
  assert.strictEqual((await acaoNoEvento(ponto.id, outro, 'pausar')).status, 404, 'ação desconhecida');
});

test('7 e 11. evento futuro é o próximo compromisso da tela; sem horário opera o período inteiro; público opcional', async () => {
  const ponto = await criarMovel();
  // Formato antigo (só datas) continua aceito: o dia inteiro em Matão.
  const semPublico = await cadastrarEvento(ponto, {
    nome: 'Feira do Livro',
    data_inicio: diaMais(20),
    data_fim: '',
    publico_estimado: '',
  });
  let f = await ficha(ponto.id);
  const feira = f.eventos.find((e) => e.id === semPublico);
  assert.strictEqual(feira.publicoEstimado, null, 'sem público, sem número inventado');
  assert.strictEqual(feira.dataFim, feira.dataInicio, 'sem fim = evento de um dia');
  assert.strictEqual(feira.inicioLocal, `${diaMais(20)}T00:00`);
  assert.strictEqual(feira.fimLocal, `${diaMais(21)}T00:00`);
  assert.strictEqual(feira.horarioOperacao, null, 'sem horário: operar durante todo o período');
  assert.strictEqual(feira.horario, null);
  assert.strictEqual(telaNaFicha(f, ponto.telaId).proximo.id, semPublico);

  const inicio = `${diaMais(3)}T08:00`;
  const fim = `${diaMais(4)}T18:30`;
  const maisCedo = await cadastrarEvento(ponto, { inicio, fim, horario_operacao: '24h' });
  f = await ficha(ponto.id);
  const tela = telaNaFicha(f, ponto.telaId);
  assert.strictEqual(tela.proximo.id, maisCedo, 'o próximo é o de início mais próximo');
  assert.strictEqual(tela.alocacao, null, 'evento programado não aloca a tela');
  assert.strictEqual(f.resumo.comCompromissoFuturo, 1);
  assert.deepStrictEqual(
    f.agenda.map((x) => x.id),
    [maisCedo, semPublico],
    'a agenda vem por início',
  );
  const ev = f.eventos.find((e) => e.id === maisCedo);
  assert.strictEqual(ev.publicoEstimado, 600);
  assert.strictEqual(ev.local, 'Ginásio Municipal');
  assert.strictEqual(ev.endereco, 'Rua do Ginásio, 50');
  assert.strictEqual(ev.dataInicio, diaMais(3));
  assert.strictEqual(ev.dataFim, diaMais(4));
  assert.strictEqual(ev.inicioLocal, inicio, 'a hora digitada é a de Matão');
  assert.strictEqual(ev.fimLocal, fim);
  assert.deepStrictEqual(ev.horarioOperacao, alocacao.HORARIO_24H, "'24h' é escolha explícita");
  assert.deepStrictEqual(
    ev.telas.map((t) => t.id),
    [ponto.telaId],
  );
  // O próximo compromisso da REDE (grid do Admin e card), no formato
  // público: tipo, nome, local do evento e período — sem id, tela ou público.
  const { proximo } = await situacao(ponto.id);
  assert.deepStrictEqual(
    { ...proximo, inicio: new Date(proximo.inicio).toISOString(), fim: new Date(proximo.fim).toISOString() },
    {
      tipo: 'evento',
      nome: 'Campeonato Regional de Jiu-Jitsu',
      local: 'Ginásio Municipal',
      inicio: ev.inicio,
      fim: ev.fim,
    },
  );
  // A Agenda móvel do Admin: os dois, por início, cada um com a tela.
  assert.deepStrictEqual(
    (await naAgenda(ponto.id)).map((x) => [x.id, x.emCurso, x.telas.map((t) => t.id)]),
    [
      [maisCedo, false, [ponto.telaId]],
      [semPublico, false, [ponto.telaId]],
    ],
  );

  const tentar = (extra) => admin('POST', `/admin/pontos/${ponto.id}/eventos`, corpoDeEvento([ponto.telaId], extra));
  const horarioVazio = await tentar({
    horario_operacao: { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null },
    inicio: paredeMais(30 * 24),
    fim: paredeMais(31 * 24),
  });
  assert.strictEqual(horarioVazio.status, 400, 'horário próprio: pelo menos um dia aberto');
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

test('evento com hora: dois no mesmo dia na mesma tela, sem se cruzar, entram; cruzando, 409', async () => {
  const ponto = await criarMovel();
  const dia = diaMais(7);
  const manha = await cadastrarEvento(ponto, { nome: 'Manhã', inicio: `${dia}T08:00`, fim: `${dia}T12:00` });
  const tarde = await cadastrarEvento(ponto, { nome: 'Tarde', inicio: `${dia}T12:00`, fim: `${dia}T18:00` });
  assert.ok(manha && tarde, '[08:00, 12:00) e [12:00, 18:00) não colidem');
  const tentar = (extra) => admin('POST', `/admin/pontos/${ponto.id}/eventos`, corpoDeEvento([ponto.telaId], extra));
  const cruzando = await tentar({ nome: 'Almoço', inicio: `${dia}T11:00`, fim: `${dia}T13:00` });
  assert.strictEqual(cruzando.status, 409);
  assert.match(cruzando.json.erro, /já está no evento “Manhã”/);
  const dentro = await tentar({ nome: 'Dentro', inicio: `${dia}T13:00`, fim: `${dia}T14:00` });
  assert.strictEqual(dentro.status, 409);
  assert.match(dentro.json.erro, /“Tarde”/);
  const noite = await cadastrarEvento(ponto, { nome: 'Noite', inicio: `${dia}T18:00`, fim: `${dia}T23:00` });
  assert.ok(noite);
  // Cancelado libera a agenda da tela.
  assert.strictEqual((await acaoNoEvento(ponto.id, manha, 'cancelar')).status, 200);
  await cadastrarEvento(ponto, { nome: 'Almoço', inicio: `${dia}T11:00`, fim: `${dia}T12:00` });
  // O banco é a última linha de defesa: a tela não entra num evento que
  // cruza outro dela.
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, local, data_inicio, data_fim, inicio, fim)
     VALUES ($1, 'X', 'Z', $2, $2, $3::timestamptz, $4::timestamptz) RETURNING id`,
    [ponto.id, dia, `${dia}T15:00:00-03:00`, `${dia}T16:00:00-03:00`],
  );
  await assert.rejects(
    pool.query('INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id) VALUES ($1, $2)', [
      rows[0].id,
      ponto.telaId,
    ]),
    (e) => e.code === '23P01',
  );
});

test('10. evento cancelado não é próximo nem alocação, e fica no histórico', async () => {
  const ponto = await criarMovel();
  const cedo = await cadastrarEvento(ponto, { nome: 'Cedo', inicio: paredeMais(48), fim: paredeMais(56) });
  const tarde = await cadastrarEvento(ponto, {
    nome: 'Tarde',
    inicio: paredeMais(9 * 24),
    fim: paredeMais(10 * 24),
  });
  assert.strictEqual((await acaoNoEvento(ponto.id, cedo, 'cancelar')).status, 200);
  const f = await ficha(ponto.id);
  assert.strictEqual(telaNaFicha(f, ponto.telaId).proximo.id, tarde);
  assert.strictEqual(telaNaFicha(f, ponto.telaId).alocacao, null);
  const cancelado = f.eventos.find((e) => e.id === cedo);
  assert.strictEqual(cancelado.estado, 'cancelado', 'auditável');
  assert.ok(cancelado.canceladoEm);
  assert.ok(!f.agenda.some((a) => a.id === cedo), 'cancelado sai da agenda');
  assert.strictEqual((await acaoNoEvento(ponto.id, cedo, 'iniciar')).status, 409, 'cancelado não começa');
  // Evento de outra rede não se mexe por esta.
  const outroPonto = await criarMovel({}, { telas: 0 });
  assert.strictEqual((await acaoNoEvento(outroPonto.id, tarde, 'iniciar')).status, 404);
  // Evento que passou do horário sem ter começado não começa mais.
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, local, data_inicio, data_fim, inicio, fim)
     VALUES ($1, 'Velho', 'Lugar', $2, $2, now() - interval '5 hours', now() - interval '1 hour') RETURNING id`,
    [ponto.id, diaMais(0)],
  );
  await pool.query('INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id) VALUES ($1, $2)', [
    rows[0].id,
    ponto.telaId,
  ]);
  const velho = await acaoNoEvento(ponto.id, rows[0].id, 'iniciar');
  assert.strictEqual(velho.status, 409);
  assert.match(velho.json.erro, /já terminou/);
  assert.strictEqual(telaNaFicha(await ficha(ponto.id), ponto.telaId).proximo.id, tarde, 'passado nunca é próximo');
});

test('evento só existe na rede móvel; base não existe mais (410)', async () => {
  const fixo = await aprovar(await novaConta());
  const tela = await telaInstalada(fixo.id);
  const r = await admin(
    'POST',
    `/admin/pontos/${fixo.id}/eventos`,
    corpoDeEvento([tela], { inicio: paredeMais(72), fim: paredeMais(80) }),
  );
  assert.strictEqual(r.status, 409);
  const m = await criarMovel({}, { telas: 0 });
  for (const id of [fixo.id, m.id]) {
    const b = await admin('PUT', `/admin/pontos/${id}/base`, { base_conta_id: fixo.anunciante_id, base_nome: 'X' });
    assert.strictEqual(b.status, 410);
    assert.match(b.json.erro, /não tem base/);
  }
  const { rows } = await pool.query('SELECT base_conta_id, base_nome FROM pontos WHERE id = $1', [m.id]);
  assert.deepStrictEqual(rows[0], { base_conta_id: null, base_nome: null });
});

test('a rede não tem horário, ramo nem endereço próprios; nome, cidade, UF e nota se editam na ficha', async () => {
  const ponto = await criarMovel({}, { telas: 0 });
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
  // O que é da rede continua editável.
  const nota = await admin('PATCH', `/admin/pontos/${ponto.id}`, { observacoes: 'lacre 123' });
  assert.strictEqual(nota.status, 200, JSON.stringify(nota.json));
  const cidade = cidadeUnica();
  // Nome vazio é recusado (não volta mais a um padrão da cidade) e nada muda.
  for (const nome of ['', '   ']) {
    const vazio = await admin('PATCH', `/admin/pontos/${ponto.id}/movel`, { cidade, uf: 'MG', nome });
    assert.strictEqual(vazio.status, 400, `nome ${JSON.stringify(nome)}`);
    assert.strictEqual(vazio.json.campo, 'nome');
  }
  const intacta = (await pool.query('SELECT nome, cidade, uf FROM pontos WHERE id = $1', [ponto.id])).rows[0];
  assert.deepStrictEqual(intacta, { nome: ponto.nome, cidade: ponto.cidade, uf: ponto.uf });
  // Mudar a cidade NÃO muda o nome: são campos independentes.
  const editada = await admin('PATCH', `/admin/pontos/${ponto.id}/movel`, { cidade, uf: 'MG' });
  assert.strictEqual(editada.status, 200, JSON.stringify(editada.json));
  const { id, nome, uf } = editada.json;
  assert.deepStrictEqual(
    { id, nome, cidade: editada.json.cidade, uf },
    { id: ponto.id, nome: 'Mostraí Móvel', cidade, uf: 'MG' },
    'a cidade mudou; o nome continua o que o Admin escolheu',
  );
  // E o nome muda sozinho, sem tocar na cidade.
  const renomeada = await admin('PATCH', `/admin/pontos/${ponto.id}/movel`, { nome: '  Rede   do Centro ' });
  assert.strictEqual(renomeada.status, 200, JSON.stringify(renomeada.json));
  assert.deepStrictEqual((await pool.query('SELECT nome, cidade, uf FROM pontos WHERE id = $1', [ponto.id])).rows[0], {
    nome: 'Rede do Centro',
    cidade,
    uf: 'MG',
  });
  const outra = await criarMovel({}, { telas: 0 });
  const dup = await admin('PATCH', `/admin/pontos/${outra.id}/movel`, {
    cidade: ` ${cidade.toUpperCase()} `,
    uf: 'MG',
  });
  assert.strictEqual(dup.status, 409, 'uma rede por cidade + UF');
  assert.strictEqual((await admin('PATCH', `/admin/pontos/${outra.id}/movel`, { uf: 'XX' })).status, 400);
  const fixo = await aprovar(await novaConta());
  assert.strictEqual((await admin('PATCH', `/admin/pontos/${fixo.id}/movel`, { nome: 'X' })).status, 409);
});

// ---------- 12 a 14. organizador, Plano Básico, crédito ----------
test('12, 13 e 14. organizador não vira dono; evento e rede não dão Plano Básico nem crédito', async () => {
  const ponto = await criarMovel();
  await telaInstalada(ponto.id);
  await eventoEmAndamento(ponto, { organizacao: 'Igreja Y' });

  await basico.sincronizar({ apenasPontos: [ponto.id] });
  await creditosPonto.concederCreditosMensais({ apenasPontos: [ponto.id] });

  const { rows: p } = await pool.query('SELECT anunciante_id, base_conta_id FROM pontos WHERE id = $1', [ponto.id]);
  assert.strictEqual(p[0].anunciante_id, null, 'continua da Mostraí');
  assert.strictEqual(p[0].base_conta_id, null, 'o evento não cria base');
  const igreja = await pool.query(`SELECT 1 FROM anunciantes WHERE nome_empresa = 'Igreja Y'`);
  assert.strictEqual(igreja.rowCount, 0, 'organização é texto do evento, nunca conta');
  const basicoDoPonto = await pool.query('SELECT 1 FROM beneficios_basico_ponto WHERE ponto_id = $1', [ponto.id]);
  assert.strictEqual(basicoDoPonto.rowCount, 0, 'sem Plano Básico pela rede');
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

// ---------- 15. card do anunciante ----------
test('15. o anunciante vê a REDE: cidade, foto, onde está agora e o próximo — nada técnico nem administrativo', async () => {
  const ponto = await criarMovel({}, { telas: 2 });
  await tirarDoSorteio(ponto.id);
  await eventoEmAndamento(ponto, {
    local: 'Parque de Exposições',
    organizacao: 'Sindicato Rural',
    telas: [ponto.telaId],
  });
  const anunciante = await novaConta();
  await anunciantesRepo.atualizar(anunciante.id, { plano_id: 'essencial-1m' });
  const nav = await entrar(anunciante);
  const lista = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(lista.status, 200, JSON.stringify(lista.json));
  const daRede = lista.json.pontos.filter((p) => p.id === ponto.id);
  assert.strictEqual(daRede.length, 1, 'a rede é UM item da lista, com 2 telas');
  const item = daRede[0];
  assert.strictEqual(item.tipo, 'movel');
  assert.strictEqual(item.uf, 'SP');
  assert.strictEqual(item.inventario, true);
  assert.strictEqual(item.seuPonto, false);
  // O card (estação Rede/Admin V2): só cidade, foto, onde está AGORA (um
  // local: o nome dele) e o próximo compromisso — nada de telas, operação,
  // endereço ou base.
  assert.deepStrictEqual(item.movel, {
    cidade: ponto.cidade,
    uf: 'SP',
    foto: null,
    agora: { quantidade: 1, nome: 'Parque de Exposições' },
    proximo: null,
  });
  for (const chave of ['telas', 'emOperacao', 'locaisAgora', 'base']) {
    assert.ok(!(chave in item.movel), `o card não leva "${chave}"`);
  }
  assert.doesNotMatch(
    JSON.stringify(item),
    /Sindicato Rural|organizacao|publico|Rua do Ginásio/i,
    'dado administrativo não vai pro card',
  );
  assert.ok(
    lista.json.pontos.filter((p) => p.tipo === 'fixo').every((p) => p.movel === null),
    'fixo não carrega nada de móvel',
  );
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

test('16. Proof-of-Play: conta igual na tela; durante o evento dela guarda o evento (auditoria)', async () => {
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

  const eventoId = await eventoEmAndamento(ponto);
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
  assert.strictEqual(rows[0].vezes_confirmadas, 3, 'as três contaram na tela da rede');
  const doEvento = (await ficha(ponto.id)).eventos.find((e) => e.id === eventoId);
  assert.strictEqual(doEvento.exibicoesConfirmadas, 1, 'a ficha mostra o que tocou durante o evento');
});

// ---------- trava de ramo: o contexto é o do evento da tela ----------
test('trava de ramo no evento: o ramo é o do evento da tela (não há base); sem ramo no evento, ninguém é barrado', async () => {
  const categoriaId = await novaCategoria('Academia Teste');
  const ponto = await criarMovel();
  await tirarDoSorteio(ponto.id);
  await dispositivosRepo.atualizar(ponto.telaId, { status: 'ativo' });
  await instalarPlayer(ponto.telaId);

  // Um concorrente do ramo do evento e uma conta sem ramo escolheram a rede.
  const concorrente = await contaComPlanoEPeca(ponto.id, categoriaId);
  const neutra = await contaComPlanoEPeca(ponto.id);

  const eventoId = await eventoEmAndamento(ponto, { categoria_id: categoriaId });
  const dispositivo = await dispositivosRepo.buscarComPonto(ponto.telaId);
  assert.strictEqual(dispositivo.movel_alocado, true);
  assert.strictEqual(dispositivo.categoria_id, categoriaId, 'o ramo em vigor é o do evento');
  assert.strictEqual(dispositivo.casa_conta_id, null, 'evento não tem casa');
  assert.strictEqual(dispositivo.dono_conta_id, null);
  const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
  const contas = new Set(envelope.itens.map((i) => i.anuncianteId));
  assert.ok(contas.has(neutra.id), 'quem não é do ramo entra');
  assert.ok(!contas.has(concorrente.id), 'o concorrente do ramo do evento fica fora');
  assert.strictEqual((await ficha(ponto.id)).eventos.find((e) => e.id === eventoId).categoria.id, categoriaId);

  // Outra rede, evento sem ramo: o mesmo concorrente entra.
  const livre = await criarMovel();
  await tirarDoSorteio(livre.id);
  await dispositivosRepo.atualizar(livre.telaId, { status: 'ativo' });
  await instalarPlayer(livre.telaId);
  const concorrenteLivre = await contaComPlanoEPeca(livre.id, categoriaId);
  await eventoEmAndamento(livre);
  const dispLivre = await dispositivosRepo.buscarComPonto(livre.telaId);
  assert.strictEqual(dispLivre.categoria_id, null);
  const envLivre = await gerador.gerarPlaylistDaHora(dispLivre, new Date());
  assert.ok(
    envLivre.itens.some((i) => i.anuncianteId === concorrenteLivre.id),
    'evento sem ramo não barra ninguém',
  );
});

// ---------- horário: o do evento vai para a TV das telas DELE ----------
test('em evento a TV recebe o horário DO EVENTO; ao encerrar, fica sem horário — e só as telas do evento são avisadas', async () => {
  const ponto = await criarMovel({}, { telas: 2 });
  const [a, b] = ponto.telas;
  const versao = async (telaId) =>
    (await pool.query('SELECT config_versao_desejada FROM dispositivos WHERE id = $1', [telaId])).rows[0]
      .config_versao_desejada;
  const [antesA, antesB] = [await versao(a), await versao(b)];
  assert.strictEqual((await dispositivosRepo.buscarComPonto(a)).ponto_horario_semanal, null, 'sem alocação');

  const horarioDoEvento = { ...HORARIO_COMERCIAL, dom: { abre: '09:00', fecha: '17:00' } };
  const eventoId = await eventoEmAndamento(ponto, { horario_operacao: horarioDoEvento, telas: [a] });
  assert.deepStrictEqual((await dispositivosRepo.buscarComPonto(a)).ponto_horario_semanal, horarioDoEvento);
  assert.strictEqual((await dispositivosRepo.buscarComPonto(b)).ponto_horario_semanal, null, 'a outra tela não muda');
  assert.ok((await versao(a)) > antesA, 'a config da TV muda ao entrar no evento');
  assert.strictEqual(await versao(b), antesB, 'a TV que não está no evento não é avisada');
  assert.deepStrictEqual(
    (await ficha(ponto.id)).eventos.find((e) => e.id === eventoId).horarioOperacao,
    horarioDoEvento,
  );

  const noEvento = await versao(a);
  await acaoNoEvento(ponto.id, eventoId, 'encerrar');
  assert.strictEqual((await dispositivosRepo.buscarComPonto(a)).ponto_horario_semanal, null);
  assert.ok((await versao(a)) > noEvento, 'e muda de novo ao sair');
  assert.strictEqual(await versao(b), antesB);
});

// A régua "no ar" do anunciante lê o MESMO horário em vigor da TV
// (src/lib/contexto-do-ponto.js): sem tela alocada, "sem alocação"; no
// evento, o horário do evento decide entre "no ar" e "fora do horário".
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
  const fechado = await eventoEmAndamento(ponto, { horario_operacao: fechadoHoje });
  assert.deepStrictEqual(
    await situacoes(),
    { anunciante: 'fora_do_horario', admin: 'fora_do_horario' },
    'fora do horário do evento',
  );
  assert.strictEqual((await acaoNoEvento(ponto.id, fechado, 'encerrar')).status, 200);

  const aberto = await eventoEmAndamento(ponto);
  assert.deepStrictEqual(await situacoes(), { anunciante: 'no_ar', admin: 'operando' }, 'no evento, o período inteiro');

  await acaoNoEvento(ponto.id, aberto, 'encerrar');
  assert.strictEqual((await situacoes()).anunciante, 'sem_alocacao', 'de volta a sem alocação');
});

// ---------- tipo imutável (V2) ----------
test('tipo imutável: fixo não vira móvel nem móvel vira fixo — rota 410 e o banco recusa', async () => {
  const dona = await novaConta();
  const fixo = await aprovar(dona);
  const movelPronto = await criarMovel({}, { telas: 0 });
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

test('situacaoDasRedes ignora ponto fixo e id inválido; "Meus pontos" não tem rede móvel', async () => {
  const fixo = await aprovar(await novaConta());
  const mapa = await movel.situacaoDasRedes([fixo.id, 'abc', -1]);
  assert.strictEqual(mapa.size, 0);
  const meus = await meusPontosDaConta(fixo.anunciante_id);
  assert.ok(meus.every((e) => e.tipo !== 'base_movel'));
  const m = await criarMovel({}, { telas: 2 });
  const { rows } = await pool.query('SELECT status FROM pontos WHERE id = $1', [m.id]);
  assert.deepStrictEqual((await movel.situacaoDasRedes([m.id, fixo.id])).get(m.id), {
    nome: m.nome,
    cidade: m.cidade,
    uf: 'SP',
    status: rows[0].status,
    foto: null,
    telas: 2,
    emOperacao: 0,
    locaisAgora: [],
    proximo: null,
  });
});

// ---------- "Onde estamos" (site público): UM card por rede móvel ----------
// Estação "Onde estamos" (08/10/2026): a rede móvel é inventário real mesmo
// entre duas alocações — aparece sempre (salvo arquivada), uma linha por
// rede (nunca por tela ou por alocação), sem endereço-base nem status técnico;
// "agora" só com compromisso EM CURSO, "próximo" só o futuro ainda não
// iniciado, encerrado em lugar nenhum. Mesma fonte do Admin e do anunciante
// (src/pontos/movel.js#situacaoDasRedes).
const daRede = async (id) => (await publicos()).filter((p) => p.id === id);
const TECNICO = /heartbeat|player|versao|online|erro|telas|emOperacao|percentual|saldo|conta/i;

test('Onde estamos: o fixo segue igual; a rede sem compromisso aparece UMA vez, sem local, sem próximo e sem base', async () => {
  const fixo = await aprovar(await novaConta());
  const m = await criarMovel({}, { telas: 3 });
  const lista = await publicos();
  const f = lista.find((p) => p.id === fixo.id);
  assert.ok(f, 'o ponto fixo aparece');
  assert.strictEqual(f.tipo, 'fixo');
  assert.ok(f.endereco && f.status, 'o fixo mantém endereço e status');
  assert.strictEqual(f.movel, undefined, 'o fixo não ganha bloco móvel');
  const rede = lista.filter((p) => p.id === m.id);
  assert.strictEqual(rede.length, 1, 'UMA linha para a rede de 3 telas');
  assert.deepStrictEqual(
    [rede[0].nome, rede[0].cidade, rede[0].uf, rede[0].tipo],
    ['Mostraí Móvel', m.cidade, 'SP', 'movel'],
  );
  assert.deepStrictEqual(rede[0].movel, { foto: null, agora: [], proximo: null });
  assert.deepStrictEqual(
    [rede[0].endereco, rede[0].bairro, rede[0].status, rede[0].categoria_nome],
    [null, null, null, null],
    'sem endereço-base, sem status técnico, sem ramo',
  );
  assert.doesNotMatch(JSON.stringify(rede[0]), TECNICO);
  // Tela parada (reparo, sem comunicação) não tira a rede do site.
  await pool.query(`UPDATE dispositivos SET status = 'reparo' WHERE ponto_id = $1`, [m.id]);
  assert.strictEqual((await daRede(m.id)).length, 1, 'tela parada não some com a rede');
  // Arquivada sai.
  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste' WHERE id = $1`,
    [m.id],
  );
  assert.strictEqual((await daRede(m.id)).length, 0, 'rede arquivada não aparece');
});

test('Onde estamos: a foto do card é a da própria rede', async () => {
  const m = await criarMovel({}, { telas: 2 });
  await pool.query(`UPDATE pontos SET foto_instalacao_url = 'https://exemplo.test/rede-movel.jpg' WHERE id = $1`, [
    m.id,
  ]);
  const [r] = await daRede(m.id);
  assert.strictEqual(r.movel.foto, 'https://exemplo.test/rede-movel.jpg');
});

test('Onde estamos: compromisso só futuro (ou que ainda não começou) é o "Próximo", nunca o local atual', async () => {
  const m = await criarMovel();
  await cadastrarEvento(m, { nome: 'Feira do Livro', inicio: paredeMais(48), fim: paredeMais(52) });
  let [r] = await daRede(m.id);
  assert.deepStrictEqual(r.movel.agora, [], 'sem localização antes do início');
  assert.deepStrictEqual([r.movel.proximo.nome, r.movel.proximo.local], ['Feira do Livro', 'Ginásio Municipal']);
  assert.ok(r.movel.proximo.inicio);
  assert.doesNotMatch(JSON.stringify(r.movel.proximo), /tipo|publico|organizacao|tela/i, 'próximo só com dado público');
  // A hora chegou, mas o compromisso não foi iniciado: continua "Próximo".
  const outra = await criarMovel();
  await cadastrarEvento(outra, { nome: 'Ainda não começou', inicio: paredeMais(-1), fim: paredeMais(3) });
  [r] = await daRede(outra.id);
  assert.deepStrictEqual(r.movel.agora, []);
  assert.strictEqual(r.movel.proximo.nome, 'Ainda não começou');
});

test('Onde estamos: compromisso em curso é o local atual (com endereço real); encerrado sai de "agora" e não volta como "Próximo"', async () => {
  const m = await criarMovel({}, { telas: 2 });
  const [a] = m.telas;
  const ev = await eventoEmAndamento(m, { nome: 'Copa', telas: [a] });
  let [r] = await daRede(m.id);
  assert.deepStrictEqual(r.movel.agora, [
    { nome: 'Ginásio Municipal', endereco: 'Rua do Ginásio, 50', evento: 'Copa' },
  ]);
  assert.strictEqual(r.movel.proximo, null);
  assert.strictEqual(r.status, 'em_operacao', 'com local atual, a rede conta como no ar');
  assert.strictEqual((await acaoNoEvento(m.id, ev, 'encerrar')).status, 200);
  [r] = await daRede(m.id);
  assert.deepStrictEqual(r.movel, { foto: null, agora: [], proximo: null }, 'encerrado: sem local e sem próximo');
  assert.strictEqual(r.status, null, 'sem local, nenhum status');
});

test('Onde estamos: várias telas em vários locais continuam UM card da rede, com um local por compromisso', async () => {
  const m = await criarMovel({}, { telas: 3 });
  const [a, b, c] = m.telas;
  await eventoEmAndamento(m, { nome: 'Copa', telas: [a, b] });
  await eventoEmAndamento(m, { nome: 'Feira', local: 'Praça Central', endereco: 'Praça da Matriz, 1', telas: [c] });
  const rede = await daRede(m.id);
  assert.strictEqual(rede.length, 1, 'uma linha, não uma por tela nem por local');
  assert.deepStrictEqual(rede[0].movel.agora.map((l) => [l.evento, l.nome]).sort(), [
    ['Copa', 'Ginásio Municipal'],
    ['Feira', 'Praça Central'],
  ]);
});
