const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// REDE / ADMIN V2 (estação de 06/10/2026, migration 116 — continuação da
// rede móvel da 115, tests/rede-movel.test.js). Aqui:
//   1. a AGENDA MÓVEL do Admin (GET /admin/pontos-moveis/agenda): agora +
//      futuro por padrão, histórico com `?historico=1`, um item por
//      compromisso (evento com várias telas é UM);
//   2. a AGENDA PÚBLICA da rede ("Ver agenda" do card do anunciante): só
//      presente e futuro, só tipo/nome/local/período;
//   3. o CARD do Mostraí Móvel em "pontos disponíveis": cidade, foto, onde
//      está agora e o próximo — e a rede sem localização continua escolhível;
//   4. a CAPACIDADE da hora: 3600 s × telas ativas na rede (mínimo 1);
//   5. o NOME da rede, obrigatório e independente da cidade (e a regra de
//      renomear da 116);
//   6. a FOTO de qualquer ponto pelo Admin (POST /admin/pontos/:id/foto);
//   7. o Admin CRIANDO um ponto fixo na ficha da conta, sem candidatura
//      (POST /admin/anunciantes/:id/pontos), e a origem auditável.
// Roda o `app` REAL (src/server.js): a guarda do /admin, o login do admin e o
// do anunciante de verdade. Cada teste cria as próprias contas e redes (em
// cidades únicas) — os arquivos de teste rodam em paralelo no mesmo banco.
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-rede-admin-v2';
// A foto vai para uma pasta local (src/lib/ffmpeg.js#subirParaStorage: com
// STORAGE_CAPTURA e fora de produção), nunca para o bucket de verdade.
process.env.NODE_ENV = 'test';
const PASTA_FOTOS = fs.mkdtempSync(path.join(os.tmpdir(), 'mostrai-rede-admin-v2-'));
process.env.STORAGE_CAPTURA = PASTA_FOTOS;
const app = require('../src/server');
const alocacao = require('../src/pontos/alocacao');
const hospedagem = require('../src/pontos/hospedagem');
const pontosRepo = require('../src/pontos/repository');
const candidaturasRepo = require('../src/candidaturas/repository');

const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const SENHA = 'Senha12@teste';
const criadas = { contas: [], pontos: [], categorias: [], planos: [], cidadesAprovadas: [] };
// As sessões abertas por este arquivo (admin e contas) saem no fim.
const sessoes = new Set();
let base;
let servidor;
let admin;

// O corpo vai como JSON; um FormData vai como multipart (o fetch monta o
// cabeçalho com o boundary).
function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo) {
    const cookie = [...potes.entries()]
      .filter(([, c]) => caminho.startsWith(c.path))
      .map(([nome, c]) => `${nome}=${c.valor}`)
      .join('; ');
    const multipart = corpo instanceof FormData;
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: {
        ...(multipart ? {} : { 'content-type': 'application/json' }),
        'x-forwarded-for': IP,
        ...(cookie ? { cookie } : {}),
      },
      body: corpo === undefined ? undefined : multipart ? corpo : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const valor = resto.join('=');
      const caminhoCookie = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor, path: caminhoCookie });
      // Cookie assinado do express-session: "s:<sid>.<assinatura>".
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

// Tudo o que um ponto (fixo ou rede) deste arquivo deixou, na ordem das
// chaves estrangeiras.
async function apagarPonto(id) {
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
  // A hospedagem e o evento (com as telas dele, em cascata) saem antes das
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
  await pool.query('DELETE FROM pendencias WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
}

test.after(async () => {
  // Métrica do login/criação ainda gravando: espera antes de apagar a conta.
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criadas.pontos) await apagarPonto(id);
  for (const id of criadas.contas) {
    // O ponto que o Admin criou na conta, ou que nasceu da candidatura dela.
    const { rows } = await pool.query('SELECT id FROM pontos WHERE anunciante_id = $1', [id]);
    for (const p of rows) await apagarPonto(p.id);
    await pool.query('DELETE FROM saldo_hospedagem_lancamentos WHERE conta_id = $1', [id]);
    await pool.query(
      `DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE conta_id = $1)`,
      [id],
    );
    await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM pendencias WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  // A métrica anônima de cada aprovação deste arquivo (cita só a cidade,
  // única por aprovação).
  await pool.query(
    `DELETE FROM eventos WHERE nome = 'ponto:candidatura_aprova' AND anunciante_id IS NULL
        AND propriedades->>'cidade' = ANY($1::text[])`,
    [criadas.cidadesAprovadas],
  );
  for (const id of criadas.planos) await pool.query('DELETE FROM planos WHERE id = $1', [id]);
  for (const id of criadas.categorias) await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
  await pool.query('DELETE FROM session WHERE sid = ANY($1::text[])', [[...sessoes]]);
  await pool.query('DELETE FROM tentativas_acesso WHERE chave LIKE $1', [`${IP}:%`]);
  fs.rmSync(PASTA_FOTOS, { recursive: true, force: true });
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// ---------- fixtures ----------
const cidadeUnica = () => `Cidade ${randomUUID().slice(0, 8)}`;
// "2026-10-06T14:30" de Matão (o que o formulário do Admin manda),
// deslocado em horas a partir de agora.
const paredeMais = (horas) => alocacao.parede(new Date(Date.now() + horas * 3_600_000));

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

// Conta com endereço completo e responsável (o "+ Criar ponto" do Admin
// pré-preenche com eles).
async function novaConta({ categoriaId = null, nome = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, logradouro, numero, bairro, endereco, cidade, uf, cep,
                              categoria_id, responsavel_nome)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true,
             'Rua das Flores', '10', 'Centro', 'Rua das Flores, 10', 'Matão', 'SP', '15990000', $5, 'Fulana')
     RETURNING *`,
    [
      nome || `Rede V2 ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `rede-v2-${randomUUID()}@example.com`,
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

async function novaCategoria() {
  const { rows } = await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id, nome`, [
    `Ramo ${randomUUID().slice(0, 8)}`,
  ]);
  criadas.categorias.push(rows[0].id);
  return rows[0];
}

// Plano de teste INATIVO (não aparece em vitrine nenhuma) com os segundos
// por hora pedidos — é o que a régua de ocupação soma.
async function novoPlano(segundosPorHora) {
  const id = `plano-teste-rede-v2-${randomUUID()}`;
  await pool.query(
    `INSERT INTO planos (id, tier, nome, valor_mensal, compromisso_meses, frequencia_hora, cobertura, segundos_por_hora,
                         pontos_incluidos, duracao_maxima_segundos, limite_criativos, ativo)
     VALUES ($1, 'essencial', 'Teste Rede/Admin V2', 100, 1, 0, 'todos_pontos', $2, 1, 30, 3, false)`,
    [id, segundosPorHora],
  );
  criadas.planos.push(id);
  return id;
}

async function criarRede(corpo = {}) {
  const r = await admin('POST', '/admin/pontos-moveis', {
    nome: 'Mostraí Móvel',
    cidade: cidadeUnica(),
    uf: 'SP',
    ...corpo,
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  return r.json;
}

// "+ Adicionar tela" (a mesma rota do ponto fixo). A tela nasce ativa.
async function adicionarTela(redeId) {
  const r = await admin('POST', `/admin/pontos/${redeId}/dispositivos`, {});
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

// Rede com `n` telas, tirada do sorteio automático das contas de OUTROS
// arquivos (alocada, ela vira inventário).
async function redeComTelas(n) {
  const rede = await criarRede();
  const telas = [];
  for (let i = 0; i < n; i++) telas.push(await adicionarTela(rede.id));
  await pool.query('UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = $1', [rede.id]);
  return { ...rede, telas };
}

// Ponto fixo sem dona, também fora do sorteio.
async function pontoFixo({ status = 'a_instalar', nome = null, cidade = 'Matão' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status,
                         escolha_bloqueada_em)
     VALUES ($1, 'Rua X, 1', $2, 'SP', '15990000', 'outro', 'R', '16 9', $3, now()) RETURNING *`,
    [nome || `Fixo ${randomUUID().slice(0, 8)}`, cidade, status],
  );
  criadas.pontos.push(rows[0].id);
  return rows[0];
}

function corpoDeEvento(telas, extra = {}) {
  return {
    nome: 'Feira de Negócios',
    organizacao: 'Associação Comercial',
    local: 'Parque de Exposições',
    endereco: 'Av. das Feiras, 100',
    inicio: paredeMais(5 * 24),
    fim: paredeMais(6 * 24),
    telas,
    ...extra,
  };
}

async function cadastrarEvento(redeId, telas, extra = {}) {
  const r = await admin('POST', `/admin/pontos/${redeId}/eventos`, corpoDeEvento(telas, extra));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

async function acaoNoEvento(redeId, eventoId, acao) {
  const r = await admin('POST', `/admin/pontos/${redeId}/eventos/${eventoId}/${acao}`);
  assert.strictEqual(r.status, 200, `${acao}: ${JSON.stringify(r.json)}`);
}

// Evento que cobre agora (começou há 2 h, acaba amanhã), já iniciado.
async function eventoEmAndamento(redeId, telas, extra = {}) {
  const id = await cadastrarEvento(redeId, telas, { inicio: paredeMais(-2), fim: paredeMais(24), ...extra });
  await acaoNoEvento(redeId, id, 'iniciar');
  return id;
}

// Evento programado que TERMINOU sem nunca ter começado (o formulário não
// cadastra no passado: vai direto no banco, com a tela).
async function eventoPassado(redeId, telaId, nome = 'Evento Velho') {
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, local, data_inicio, data_fim, inicio, fim)
     VALUES ($1, $2, 'Lugar Antigo', $3, $3, now() - interval '6 hours', now() - interval '3 hours') RETURNING id`,
    [redeId, nome, paredeMais(-6).slice(0, 10)],
  );
  await pool.query('INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id) VALUES ($1, $2)', [
    rows[0].id,
    telaId,
  ]);
  return Number(rows[0].id);
}

// Hospedagem programada de uma tela (o Admin revisa o percentual vigente).
// Se outro arquivo mudar o percentual no meio (tests/hospedagem.test.js), a
// confirmação volta 409 — revisa e confirma de novo, como o Admin faria.
async function programarHospedagem(redeId, telaId, conta, extra = {}) {
  let r;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    r = await admin('POST', `/admin/pontos/${redeId}/hospedagens`, {
      dispositivo_id: telaId,
      conta_id: conta.id,
      local: 'Padaria Central',
      endereco: 'Rua A, 1',
      inicio: paredeMais(-1),
      fim: paredeMais(24),
      percentual_esperado: await hospedagem.percentualAtual(),
      ...extra,
    });
    if (!(r.status === 409 && r.json?.campo === 'percentual_esperado')) break;
  }
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

const ENTREGA = { itens: { tela: true, suporte: true }, condicao: 'ok' };

// Hospedagem em andamento: programada, termo físico marcado, iniciada com a
// entrega do equipamento.
async function hospedagemAtiva(redeId, telaId, conta, extra = {}) {
  const hid = await programarHospedagem(redeId, telaId, conta, extra);
  const termo = await admin('PUT', `/admin/pontos/${redeId}/hospedagens/${hid}/termo-fisico`, { assinado: true });
  assert.strictEqual(termo.status, 200, JSON.stringify(termo.json));
  const ini = await admin('POST', `/admin/pontos/${redeId}/hospedagens/${hid}/iniciar`, { entrega: ENTREGA });
  assert.strictEqual(ini.status, 200, JSON.stringify(ini.json));
  return hid;
}

async function encerrarHospedagem(redeId, hid) {
  const r = await admin('POST', `/admin/pontos/${redeId}/hospedagens/${hid}/encerrar`, {});
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
}

// A Agenda móvel do Admin, só com os compromissos desta rede.
async function agendaAdmin(redeId, { historico = false } = {}) {
  const r = await admin('GET', `/admin/pontos-moveis/agenda${historico ? '?historico=1' : ''}`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json.filter((c) => c.redeId === redeId);
}

const agendaPublica = (nav, redeId) => nav('GET', `/anunciantes/me/redes-moveis/${redeId}/agenda`);
// O compromisso visto de fora: SÓ estas chaves.
const CHAVES_PUBLICAS = ['fim', 'inicio', 'local', 'nome', 'tipo'];

// Um JPEG de verdade (2×2, cinza, gerado pelo FFmpeg) e um PNG de verdade
// (1×1): a rota confere os primeiros bytes (src/lib/imagem.js).
const JPEG_PEQUENO = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAg+Pkk+SVVVVVVVVWRdZGhoaGRkZGRoaGhwcHCDg4NwcHBoaHBwfHyDg4+Tj4eHg4eTk5ubm7q6srLZ2eD/////xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAAgACAwESAAISAAMSAP/aAAwDAQACEQMRAD8ArRjouh//2Q==',
  'base64',
);
const PNG_PEQUENO = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

function comArquivo(bytes, tipo = 'image/jpeg', nome = 'foto.jpg') {
  const fd = new FormData();
  fd.append('arquivo', new Blob([bytes], { type: tipo }), nome);
  return fd;
}

// ---------- 1. Agenda móvel do Admin ----------
test('1. Agenda móvel do Admin: agora + futuro por padrão, um item por compromisso; histórico com encerrados e cancelados', async () => {
  const rede = await redeComTelas(3);
  const [a, b, c] = rede.telas;
  const anfitria = await novaConta();
  // Em curso: hospedagem ativa na tela A.
  const ativa = await hospedagemAtiva(rede.id, a, anfitria, { local: 'Padaria Central' });
  // Futuro: evento com DUAS telas (B e C).
  const feira = await cadastrarEvento(rede.id, [b, c]);
  // Passado que nunca começou: fora do padrão.
  const velho = await eventoPassado(rede.id, c);
  // Histórico: hospedagem encerrada (tela C), evento encerrado (C), evento
  // cancelado (B).
  const encerrada = await hospedagemAtiva(rede.id, c, await novaConta(), { local: 'Mercado Bom' });
  await encerrarHospedagem(rede.id, encerrada);
  const encerrado = await cadastrarEvento(rede.id, [c], {
    nome: 'Show Encerrado',
    inicio: paredeMais(30),
    fim: paredeMais(40),
  });
  await acaoNoEvento(rede.id, encerrado, 'iniciar');
  await acaoNoEvento(rede.id, encerrado, 'encerrar');
  const cancelado = await cadastrarEvento(rede.id, [b], {
    nome: 'Rodeio Cancelado',
    inicio: paredeMais(100),
    fim: paredeMais(110),
  });
  await acaoNoEvento(rede.id, cancelado, 'cancelar');

  const padrao = await agendaAdmin(rede.id);
  assert.deepStrictEqual(
    padrao.map((x) => [x.tipo, x.id, x.estado, x.emCurso, x.telas.map((t) => t.id)]),
    [
      ['hospedagem', ativa, 'ativa', true, [a]],
      ['evento', feira, 'programado', false, [b, c].sort((x, y) => x - y)],
    ],
    'em curso e futuro, por início; o evento de 2 telas é UMA linha',
  );
  const [linhaHosp, linhaEvento] = padrao;
  assert.deepStrictEqual(
    [linhaHosp.rede, linhaHosp.cidade, linhaHosp.uf, linhaHosp.nome, linhaHosp.local, linhaHosp.conta],
    ['Mostraí Móvel', rede.cidade, 'SP', 'Padaria Central', null, anfitria.nome_empresa],
    'hospedagem: o comércio e a conta anfitriã (é a visão do Admin)',
  );
  assert.deepStrictEqual(
    [linhaEvento.nome, linhaEvento.local, linhaEvento.conta],
    ['Feira de Negócios', 'Parque de Exposições', null],
  );
  assert.ok(
    linhaEvento.telas.every((t) => typeof t.codigo === 'string' && t.codigo),
    'cada tela com o código dela',
  );
  assert.ok(!padrao.some((x) => x.tipo === 'evento' && x.id === velho), 'o que já terminou não está na agenda');

  // Histórico: encerrados e cancelados, do mais recente para trás. (O
  // programado vencido pode ter sido encerrado pelo job de outro arquivo —
  // fica fora da comparação.)
  const historico = (await agendaAdmin(rede.id, { historico: true })).filter(
    (x) => !(x.tipo === 'evento' && x.id === velho),
  );
  assert.deepStrictEqual(
    historico.map((x) => [x.tipo, x.id, x.estado, x.emCurso]),
    [
      ['evento', cancelado, 'cancelado', false],
      ['evento', encerrado, 'encerrado', false],
      ['hospedagem', encerrada, 'encerrada', false],
    ],
  );
  assert.ok(!historico.some((x) => x.estado === 'ativa' || x.estado === 'programado'), 'nada em curso no histórico');

  // Só o Admin: conta logada e anônimo não leem.
  const conta = await entrar(anfitria);
  assert.strictEqual((await conta('GET', '/admin/pontos-moveis/agenda')).status, 401);
  assert.strictEqual((await navegador()('GET', '/admin/pontos-moveis/agenda?historico=1')).status, 401);
  // A central antiga saiu: a rota agora é só /agenda.
  assert.strictEqual((await admin('GET', '/admin/pontos-moveis')).status, 404);
});

// ---------- 2. Agenda pública da rede ----------
test('2. agenda pública da rede ("Ver agenda"): só agora e futuro, só tipo/nome/local/período; qualquer conta logada lê', async () => {
  // Uma conta sem plano e sem escolha nenhuma: não precisa ter escolhido a rede.
  const leitora = await novaConta();
  const nav = await entrar(leitora);

  const vazia = await criarRede();
  const semNada = await agendaPublica(nav, vazia.id);
  assert.strictEqual(semNada.status, 200, JSON.stringify(semNada.json));
  assert.deepStrictEqual(semNada.json, {
    rede: { id: vazia.id, nome: 'Mostraí Móvel', cidade: vazia.cidade, uf: 'SP' },
    agora: [],
    proximos: [],
  });

  const rede = await redeComTelas(3);
  const [a, b, c] = rede.telas;
  const anfitria = await novaConta({ nome: `Tabacaria Sigilosa ${randomUUID().slice(0, 4)}` });
  const outraAnfitria = await novaConta({ nome: `Mercearia Sigilosa ${randomUUID().slice(0, 4)}` });
  // AGORA: hospedagem ativa (A) e evento em andamento (B).
  await hospedagemAtiva(rede.id, a, anfitria, {
    local: 'Padaria Central',
    endereco: 'Rua Secreta, 77',
    observacao: 'chave com o gerente',
  });
  await eventoEmAndamento(rede.id, [b], {
    nome: 'Show na Praça',
    local: 'Praça Central',
    organizacao: 'Prefeitura Sigilosa',
    publico_estimado: 4321,
    observacao: 'nota interna do evento',
  });
  // FUTURO: dois eventos e uma hospedagem programada, fora de ordem.
  await cadastrarEvento(rede.id, [b, c], { publico_estimado: 5000 });
  await cadastrarEvento(rede.id, [c], {
    nome: 'Rodeio',
    local: 'Recinto',
    inicio: paredeMais(2 * 24),
    fim: paredeMais(3 * 24),
  });
  await programarHospedagem(rede.id, a, outraAnfitria, {
    local: 'Mercado Bom',
    inicio: paredeMais(10 * 24),
    fim: paredeMais(11 * 24),
  });
  // PASSADO e fora: encerrado, cancelado e programado que já terminou.
  const encerrado = await cadastrarEvento(rede.id, [c], {
    nome: 'Show Encerrado',
    inicio: paredeMais(30 * 24),
    fim: paredeMais(31 * 24),
  });
  await acaoNoEvento(rede.id, encerrado, 'iniciar');
  await acaoNoEvento(rede.id, encerrado, 'encerrar');
  const cancelado = await cadastrarEvento(rede.id, [b], {
    nome: 'Rodeio Cancelado',
    inicio: paredeMais(40 * 24),
    fim: paredeMais(41 * 24),
  });
  await acaoNoEvento(rede.id, cancelado, 'cancelar');
  await eventoPassado(rede.id, c, 'Evento Velho');

  const r = await agendaPublica(nav, rede.id);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(Object.keys(r.json).sort(), ['agora', 'proximos', 'rede']);
  assert.deepStrictEqual(r.json.rede, { id: rede.id, nome: 'Mostraí Móvel', cidade: rede.cidade, uf: 'SP' });
  assert.deepStrictEqual(
    r.json.agora.map((x) => [x.tipo, x.nome, x.local]),
    [
      ['evento', 'Show na Praça', 'Praça Central'],
      ['hospedagem', 'Padaria Central', null],
    ],
    'agora: o que está acontecendo, por início; hospedagem sem local de evento',
  );
  assert.deepStrictEqual(
    r.json.proximos.map((x) => [x.tipo, x.nome, x.local]),
    [
      ['evento', 'Rodeio', 'Recinto'],
      ['evento', 'Feira de Negócios', 'Parque de Exposições'],
      ['hospedagem', 'Mercado Bom', null],
    ],
    'próximos: por início; encerrado, cancelado e vencido nunca aparecem',
  );
  for (const lista of [r.json.agora, r.json.proximos]) {
    const inicios = lista.map((x) => new Date(x.inicio).getTime());
    assert.deepStrictEqual(
      inicios,
      [...inicios].sort((x, y) => x - y),
      'ordenado por início',
    );
  }
  for (const item of [...r.json.agora, ...r.json.proximos]) {
    assert.deepStrictEqual(Object.keys(item).sort(), CHAVES_PUBLICAS, `só o público: ${JSON.stringify(item)}`);
    assert.ok(new Date(item.fim).getTime() > Date.now(), 'nada do passado');
  }
  const texto = JSON.stringify(r.json);
  assert.doesNotMatch(
    texto,
    /Sigilosa|4321|5000|nota interna|chave com o gerente|Rua Secreta|Av\. das Feiras|Encerrado|Cancelado|Velho/,
    'nenhum dado administrativo, interno ou do passado',
  );
  assert.doesNotMatch(
    texto,
    /"(conta|telas?|endereco|percentual|termo\w*|publico\w*|observacao|organizacao|estado)"/,
    'nenhuma chave interna',
  );

  // 404: ponto fixo, rede inexistente, id que não é número, rede arquivada.
  const fixo = await pontoFixo();
  for (const id of [fixo.id, 999999999, 'abc']) {
    assert.strictEqual((await agendaPublica(nav, id)).status, 404, `id ${id}`);
  }
  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste' WHERE id = $1`,
    [vazia.id],
  );
  assert.strictEqual((await agendaPublica(nav, vazia.id)).status, 404, 'rede arquivada');
  // Anônimo: 401.
  assert.strictEqual((await agendaPublica(navegador(), rede.id)).status, 401);
});

// ---------- 3. Card em "pontos disponíveis" ----------
test('3. card do Mostraí Móvel: sem localização aparece aberto e escolhível; "agora" conta locais (nome só com um)', async () => {
  // Rede com 1 tela, 0 alocação, 0 evento.
  const rede = await criarRede();
  await adicionarTela(rede.id);
  const conta = await novaConta();
  await pool.query(`UPDATE anunciantes SET plano_id = 'essencial-1m' WHERE id = $1`, [conta.id]);
  const nav = await entrar(conta);
  const lista = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(lista.status, 200, JSON.stringify(lista.json));
  const card = lista.json.pontos.find((p) => p.id === rede.id);
  assert.ok(card, 'a rede aparece mesmo sem tela alocada e sem evento');
  assert.strictEqual(card.tipo, 'movel');
  assert.strictEqual(card.inventario, false);
  assert.strictEqual(card.bloqueado, false, 'nunca fechada por falta de operação');
  assert.deepStrictEqual(card.movel, {
    cidade: rede.cidade,
    uf: 'SP',
    foto: null,
    agora: { quantidade: 0, nome: null },
    proximo: null,
  });
  for (const chave of ['telas', 'emOperacao', 'locaisAgora', 'status']) {
    assert.ok(!(chave in card.movel), `o card não leva "${chave}"`);
  }
  // Escolher funciona (1 posição) e recarregar mantém.
  const escolha = await nav('PUT', '/anunciantes/me/pontos', { pontos: [rede.id] });
  assert.strictEqual(escolha.status, 200, JSON.stringify(escolha.json));
  const depois = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.deepStrictEqual(depois.json.escolhidos, [rede.id]);
  assert.strictEqual(depois.json.pontos.find((p) => p.id === rede.id).escolhido, true);

  // Outra rede, 3 telas: um evento com DUAS telas é UM local (com o nome).
  const cheia = await redeComTelas(3);
  const [a, b, c] = cheia.telas;
  await eventoEmAndamento(cheia.id, [a, b], { local: 'Parque de Exposições' });
  await cadastrarEvento(cheia.id, [a], {
    nome: 'Rodeio',
    local: 'Recinto',
    inicio: paredeMais(3 * 24),
    fim: paredeMais(4 * 24),
  });
  const cardDaCheia = async () =>
    (await nav('GET', '/anunciantes/me/pontos-disponiveis')).json.pontos.find((p) => p.id === cheia.id).movel;
  let m = await cardDaCheia();
  assert.deepStrictEqual(m.agora, { quantidade: 1, nome: 'Parque de Exposições' });
  assert.deepStrictEqual(Object.keys(m.proximo).sort(), CHAVES_PUBLICAS);
  assert.deepStrictEqual([m.proximo.tipo, m.proximo.nome, m.proximo.local], ['evento', 'Rodeio', 'Recinto']);
  // Dois locais ao mesmo tempo: só a quantidade.
  await hospedagemAtiva(cheia.id, c, await novaConta(), { local: 'Padaria Central' });
  m = await cardDaCheia();
  assert.deepStrictEqual(m.agora, { quantidade: 2, nome: null });
});

// ---------- 4. Capacidade da hora ----------
test('4. capacidade da hora: 3600 s × telas ativas na rede (no mínimo 1); 3600 s no fixo', async () => {
  const plano3000 = await novoPlano(3000); // 83% de 1 hora; 42% de 2 horas
  const plano2000 = await novoPlano(2000); // 56% de 1 hora
  const rede = await criarRede();
  await adicionarTela(rede.id);
  const t2 = await adicionarTela(rede.id);
  const semTela = await criarRede();
  const fixo = await pontoFixo();
  const ids = [rede.id, semTela.id, fixo.id];
  const vender = async (pontoId, planoId) => {
    const conta = await novaConta();
    await pool.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [conta.id, planoId]);
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [conta.id, pontoId]);
  };
  await vender(rede.id, plano3000);
  await vender(fixo.id, plano3000);
  await vender(semTela.id, plano2000);
  const bloqueadaEm = async (id) =>
    (await pool.query('SELECT escolha_bloqueada_em FROM pontos WHERE id = $1', [id])).rows[0].escolha_bloqueada_em;
  try {
    // Só `em_operacao` entra na régua; a avaliação vem logo em seguida.
    await pool.query(
      `UPDATE pontos SET status = 'em_operacao', escolha_bloqueada_em = NULL WHERE id = ANY($1::int[])`,
      [ids],
    );
    const bloqueados = await pontosRepo.avaliarBloqueios();
    assert.ok(bloqueados.includes(fixo.id), 'fixo: 3000 s ≥ 80% de 3600 s');
    assert.ok(!bloqueados.includes(rede.id), 'rede com 2 telas ativas: 3000 s < 80% de 7200 s');
    assert.ok(!bloqueados.includes(semTela.id), 'rede sem tela vale 1 hora (nunca 0): 2000 s < 80% de 3600 s');
    assert.ok(await bloqueadaEm(fixo.id));
    assert.strictEqual(await bloqueadaEm(rede.id), null);
    assert.strictEqual(await bloqueadaEm(semTela.id), null);
    assert.strictEqual(await pontosRepo.liberarEscolha(fixo.id), false, 'fixo: 3600 − 900 < 3000');

    // Só telas ATIVAS contam: com uma em reparo, a rede vale 1 hora e fecha.
    await pool.query(`UPDATE dispositivos SET status = 'reparo' WHERE id = $1`, [t2]);
    assert.ok((await pontosRepo.avaliarBloqueios()).includes(rede.id), '1 tela ativa: 3000 s ≥ 2880 s');
    assert.strictEqual(await pontosRepo.liberarEscolha(rede.id), false, '3600 − 900 < 3000');
    await pool.query(`UPDATE dispositivos SET status = 'ativo' WHERE id = $1`, [t2]);
    assert.strictEqual(await pontosRepo.liberarEscolha(rede.id), true, '2 telas: 7200 − 900 ≥ 3000');
    assert.strictEqual(await bloqueadaEm(rede.id), null);
  } finally {
    // Fora do sorteio das contas de outros arquivos até o fim da suíte (a
    // linha sai no test.after).
    await pool.query('UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = ANY($1::int[])', [ids]);
  }
});

// ---------- 5. Nome da rede ----------
test('5. nome da rede: obrigatório e independente da cidade; a 116 só desfaz o nome composto "Mostraí Móvel — {Cidade}"', async () => {
  const semNome = await admin('POST', '/admin/pontos-moveis', { cidade: cidadeUnica(), uf: 'SP' });
  assert.strictEqual(semNome.status, 400);
  assert.strictEqual(semNome.json.campo, 'nome');
  const cidade = cidadeUnica();
  const rede = await criarRede({ nome: 'Mostraí Móvel', cidade });
  assert.deepStrictEqual([rede.nome, rede.cidade, rede.uf], ['Mostraí Móvel', cidade, 'SP']);
  // Mudar a cidade não muda o nome.
  const novaCidade = cidadeUnica();
  const editada = await admin('PATCH', `/admin/pontos/${rede.id}/movel`, { cidade: novaCidade });
  assert.strictEqual(editada.status, 200, JSON.stringify(editada.json));
  assert.deepStrictEqual(editada.json, { id: rede.id, nome: 'Mostraí Móvel', cidade: novaCidade, uf: 'SP' });
  // Nome vazio é recusado e nada muda.
  const vazio = await admin('PATCH', `/admin/pontos/${rede.id}/movel`, { nome: '', cidade: cidadeUnica() });
  assert.strictEqual(vazio.status, 400);
  assert.strictEqual(vazio.json.campo, 'nome');
  assert.deepStrictEqual(
    (await pool.query('SELECT nome, cidade, origem FROM pontos WHERE id = $1', [rede.id])).rows[0],
    { nome: 'Mostraí Móvel', cidade: novaCidade, origem: 'movel' },
  );

  // A regra da migration 116, lida do próprio arquivo e aplicada só às
  // linhas deste teste (redes "antigas", sem origem, gravadas direto).
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/116_rede_admin_v2.sql'), 'utf8');
  const renomear = /UPDATE pontos SET nome = 'Mostraí Móvel'[^;]*;/.exec(sql)?.[0];
  const origemMovel = /UPDATE pontos SET origem = 'movel'[^;]*;/.exec(sql)?.[0];
  assert.ok(renomear && origemMovel, 'a 116 tem a regra de renomear e a de origem');
  const redeAntiga = async (nome, cidadeDaRede) => {
    const { rows } = await pool.query(
      `INSERT INTO pontos (nome, cidade, uf, segmento, responsavel_nome, responsavel_contato, tipo, movel_numero,
                           escolha_bloqueada_em)
       VALUES ($1, $2, 'SP', 'outro', 'Mostraí', '', 'movel', nextval('pontos_movel_numero_seq'), now())
       RETURNING id`,
      [nome, cidadeDaRede],
    );
    criadas.pontos.push(rows[0].id);
    return rows[0].id;
  };
  const c1 = cidadeUnica();
  const composta = await redeAntiga(`Mostraí Móvel — ${c1}`, c1);
  const deOutraCidade = await redeAntiga('Mostraí Móvel — Araraquara', cidadeUnica());
  const escolhida = await redeAntiga('Totem da Feira', cidadeUnica());
  const c4 = cidadeUnica();
  const fixo = (await pontoFixo({ nome: `Mostraí Móvel — ${c4}`, cidade: c4 })).id;
  const ids = [composta, deOutraCidade, escolhida, fixo];
  const soNestas = (comando) => pool.query(`${comando.trim().replace(/;$/, '')} AND id = ANY($1::int[])`, [ids]);
  for (let vez = 0; vez < 2; vez++) {
    // Duas vezes: a regra é idempotente.
    await soNestas(renomear);
    await soNestas(origemMovel);
  }
  const { rows } = await pool.query('SELECT id, nome, origem FROM pontos WHERE id = ANY($1::int[]) ORDER BY id', [ids]);
  const porId = Object.fromEntries(rows.map((r) => [r.id, [r.nome, r.origem]]));
  assert.deepStrictEqual(porId[composta], ['Mostraí Móvel', 'movel'], 'o nome composto com a própria cidade volta');
  assert.deepStrictEqual(porId[deOutraCidade], ['Mostraí Móvel — Araraquara', 'movel'], 'outra cidade: intocado');
  assert.deepStrictEqual(porId[escolhida], ['Totem da Feira', 'movel'], 'nome escolhido à mão: intocado');
  assert.deepStrictEqual(porId[fixo], [`Mostraí Móvel — ${c4}`, null], 'ponto fixo: nem nome nem origem mudam');
});

// ---------- 6. Foto de qualquer ponto ----------
test('6. foto de qualquer ponto pelo Admin: JPEG ou PNG pelos primeiros bytes, `?v=` na URL; a foto antiga fica até trocar', async () => {
  const fixo = await pontoFixo();
  const rede = await criarRede();
  const ANTIGA = 'https://exemplo.test/foto-antiga.jpg';
  await pool.query('UPDATE pontos SET foto_instalacao_url = $2 WHERE id = ANY($1::int[])', [
    [fixo.id, rede.id],
    ANTIGA,
  ]);
  const naLista = async () => {
    const pontos = (await admin('GET', '/admin/pontos')).json;
    return {
      fixo: pontos.find((p) => p.id === fixo.id).foto_instalacao_url,
      rede: pontos.find((p) => p.id === rede.id).movel.foto,
    };
  };
  assert.deepStrictEqual(await naLista(), { fixo: ANTIGA, rede: ANTIGA }, 'a foto já gravada continua aparecendo');

  // Recusas — nenhuma mexe na foto.
  const enviar = (id, corpo, quem = admin) => quem('POST', `/admin/pontos/${id}/foto`, corpo);
  assert.strictEqual((await enviar(rede.id, new FormData())).status, 400, 'sem arquivo');
  const texto = await enviar(rede.id, comArquivo(Buffer.from('isto é texto, não imagem'), 'image/jpeg', 'foto.jpg'));
  assert.strictEqual(texto.status, 400, 'o tipo declarado não basta: vale o conteúdo');
  assert.strictEqual((await enviar(999999999, comArquivo(JPEG_PEQUENO))).status, 404, 'ponto inexistente');
  assert.strictEqual((await enviar('abc', comArquivo(JPEG_PEQUENO))).status, 404);
  assert.strictEqual((await enviar(rede.id, comArquivo(JPEG_PEQUENO), navegador())).status, 401, 'anônimo');
  const conta = await entrar(await novaConta());
  assert.strictEqual((await enviar(rede.id, comArquivo(JPEG_PEQUENO), conta)).status, 401, 'conta comum');
  assert.deepStrictEqual(await naLista(), { fixo: ANTIGA, rede: ANTIGA }, 'recusa não troca a foto');

  // JPEG: no fixo e na rede, pela mesma rota.
  const urls = {};
  for (const [chave, ponto] of [
    ['fixo', fixo],
    ['rede', rede],
  ]) {
    const r = await enviar(ponto.id, comArquivo(JPEG_PEQUENO));
    assert.strictEqual(r.status, 200, `${chave}: ${JSON.stringify(r.json)}`);
    assert.match(r.json.url, new RegExp(`^/e2e-storage/ponto-${ponto.id}\\.jpg\\?v=\\d+$`));
    const { rows } = await pool.query('SELECT foto_instalacao_url FROM pontos WHERE id = $1', [ponto.id]);
    assert.strictEqual(rows[0].foto_instalacao_url, r.json.url, 'gravada com o `?v=`');
    assert.ok(fs.readFileSync(path.join(PASTA_FOTOS, `ponto-${ponto.id}.jpg`)).equals(JPEG_PEQUENO));
    urls[chave] = r.json.url;
  }
  assert.deepStrictEqual(await naLista(), urls);
  assert.strictEqual((await admin('GET', `/admin/pontos/${rede.id}/movel`)).json.foto, urls.rede, 'a ficha da rede');

  // PNG declarado como JPEG: vale o conteúdo (sai .png).
  const png = await enviar(rede.id, comArquivo(PNG_PEQUENO, 'image/jpeg', 'capa.jpg'));
  assert.strictEqual(png.status, 200, JSON.stringify(png.json));
  assert.match(png.json.url, new RegExp(`^/e2e-storage/ponto-${rede.id}\\.png\\?v=\\d+$`));
  assert.ok(fs.readFileSync(path.join(PASTA_FOTOS, `ponto-${rede.id}.png`)).equals(PNG_PEQUENO));
  assert.strictEqual((await naLista()).rede, png.json.url);
});

// ---------- 7. Admin cria ponto pela conta ----------
test('7. Admin cria ponto FIXO na ficha da conta: sem candidatura, origem "admin", papel e cupom; repetido e pedido aberto são 409', async () => {
  const ramoDaConta = await novaCategoria();
  const ramo = await novaCategoria();
  const conta = await novaConta({ categoriaId: ramoDaConta.id });
  const numero = String(100 + Math.floor(Math.random() * 800));
  const corpo = {
    nome: 'Padaria do Zé',
    cep: '15990-000',
    logradouro: 'Avenida Brasil',
    numero,
    complemento: 'Loja 2',
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    responsavel_nome: 'José',
    responsavel_contato: '16 99999-0000',
    categoria_id: ramo.id,
    fluxo_estimado_mensal: 1200,
    horario_semanal: HORARIO_COMERCIAL,
    observacoes: 'Cliente pediu ajuda para cadastrar',
  };
  const criar = (contaId, dados) => admin('POST', `/admin/anunciantes/${contaId}/pontos`, dados);
  const r = await criar(conta.id, corpo);
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.deepStrictEqual(r.json, { id: r.json.id, nome: 'Padaria do Zé', status: 'a_instalar' });
  const {
    rows: [p],
  } = await pool.query('SELECT * FROM pontos WHERE id = $1', [r.json.id]);
  assert.deepStrictEqual(
    {
      tipo: p.tipo,
      anunciante_id: p.anunciante_id,
      status: p.status,
      origem: p.origem,
      criado_por: p.criado_por,
      candidatura_id: p.candidatura_id,
      endereco: p.endereco,
      complemento: p.complemento,
      bairro: p.bairro,
      cidade: p.cidade,
      uf: p.uf,
      cep: p.cep,
      categoria_id: p.categoria_id,
      segmento: p.segmento,
      responsavel_nome: p.responsavel_nome,
      responsavel_contato: p.responsavel_contato,
      fluxo_estimado_mensal: p.fluxo_estimado_mensal,
      observacoes: p.observacoes,
    },
    {
      tipo: 'fixo',
      anunciante_id: conta.id,
      status: 'a_instalar',
      origem: 'admin',
      criado_por: process.env.ADMIN_USER,
      candidatura_id: null,
      endereco: `Avenida Brasil, ${numero}`,
      complemento: 'Loja 2',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990-000',
      categoria_id: ramo.id,
      segmento: ramo.nome,
      responsavel_nome: 'José',
      responsavel_contato: '16 99999-0000',
      fluxo_estimado_mensal: 1200,
      observacoes: 'Cliente pediu ajuda para cadastrar',
    },
  );
  assert.ok(p.horario_semanal?.seg, 'horário de funcionamento gravado');
  const telas = await pool.query('SELECT 1 FROM dispositivos WHERE ponto_id = $1', [p.id]);
  assert.strictEqual(telas.rowCount, 0, 'sem tela: nasce a instalar');
  const { rows: contaDepois } = await pool.query('SELECT papeis FROM anunciantes WHERE id = $1', [conta.id]);
  assert.ok(contaDepois[0].papeis.includes('ponto'), 'a conta ganha o papel de ponto');
  assert.ok(contaDepois[0].papeis.includes('anunciante'), 'sem perder o de anunciante');
  const pedidos = await pool.query('SELECT 1 FROM candidaturas WHERE conta_id = $1', [conta.id]);
  assert.strictEqual(pedidos.rowCount, 0, 'nenhuma candidatura falsa');
  const cupom = await pool.query('SELECT codigo FROM cupons_ponto WHERE conta_id = $1', [conta.id]);
  assert.strictEqual(cupom.rowCount, 1, 'o cupom de indicação da conta');
  await require('../src/lib/eventos').aguardarGravacoes();
  const { rows: auditoria } = await pool.query(
    `SELECT propriedades FROM eventos WHERE nome = 'ponto:criado_admin' AND anunciante_id = $1`,
    [conta.id],
  );
  assert.deepStrictEqual(
    auditoria.map((e) => e.propriedades),
    [{ ponto_id: p.id, admin: process.env.ADMIN_USER }],
  );
  const naRede = (await admin('GET', '/admin/pontos')).json.find((x) => x.id === p.id);
  assert.strictEqual(naRede.origem, 'admin', 'a origem aparece no grid do Admin');

  // Mesmo nome e endereço na mesma conta: 409, nada novo.
  const repetido = await criar(conta.id, corpo);
  assert.strictEqual(repetido.status, 409, JSON.stringify(repetido.json));
  assert.match(repetido.json.erro, /já é um ponto da sua conta/);
  // Outro comércio no mesmo endereço é outro ponto (endereço igual não é o
  // mesmo estabelecimento); sem ramo no corpo, vale o da conta (a mesma
  // régua da candidatura aprovada). Cupom não duplica.
  const vizinho = await criar(conta.id, { ...corpo, nome: 'Sorveteria do Zé', categoria_id: undefined });
  assert.strictEqual(vizinho.status, 201, JSON.stringify(vizinho.json));
  const { rows: v } = await pool.query('SELECT categoria_id, segmento, origem FROM pontos WHERE id = $1', [
    vizinho.json.id,
  ]);
  assert.deepStrictEqual(v[0], { categoria_id: ramoDaConta.id, segmento: ramoDaConta.nome, origem: 'admin' });
  assert.strictEqual((await pool.query('SELECT 1 FROM cupons_ponto WHERE conta_id = $1', [conta.id])).rowCount, 1);

  // Pedido em análise no mesmo endereço (de outra conta): 409, e nada muda
  // nela — nem o papel.
  const comPedido = await novaConta();
  const numeroDoPedido = String(1000 + Math.floor(Math.random() * 8000));
  await candidaturasRepo.criar({
    tipo: 'ponto',
    nome: 'Responsável',
    contato_telefone: '16988880000',
    nome_comercio: 'Açougue Pedido',
    logradouro: 'Rua do Pedido',
    numero: numeroDoPedido,
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'outro',
    conta_id: comPedido.id,
    origem: 'painel',
  });
  const pedidoAberto = await criar(comPedido.id, {
    ...corpo,
    nome: 'Açougue do Admin',
    logradouro: 'Rua do Pedido',
    numero: numeroDoPedido,
    complemento: undefined,
  });
  assert.strictEqual(pedidoAberto.status, 409, JSON.stringify(pedidoAberto.json));
  assert.match(pedidoAberto.json.erro, /solicitação em análise/);
  const { rows: semPonto } = await pool.query(
    'SELECT (SELECT COUNT(*)::int FROM pontos WHERE anunciante_id = $1) AS pontos, papeis FROM anunciantes WHERE id = $1',
    [comPedido.id],
  );
  assert.deepStrictEqual(semPonto[0], { pontos: 0, papeis: ['anunciante'] }, 'a transação volta inteira');

  // Corpo inválido: 400 com o campo; nada nasce.
  const sem = (campo) => ({ ...corpo, nome: `Outro ${randomUUID().slice(0, 6)}`, [campo]: undefined });
  for (const [dados, campo, motivo] of [
    [sem('nome'), 'nome', 'sem nome'],
    [{ ...corpo, nome: '   ' }, 'nome', 'nome em branco'],
    [{ ...sem('nome'), nome: 'X', cep: '1234' }, 'cep', 'CEP com 4 dígitos'],
    [{ ...sem('nome'), nome: 'X', uf: 'S1' }, 'uf', 'UF que não são 2 letras'],
    [{ ...sem('nome'), nome: 'X', categoria_id: 999999999 }, 'categoria_id', 'categoria inexistente'],
    [{ ...sem('nome'), nome: 'X', categoria_id: 'abc' }, 'categoria_id', 'categoria que não é número'],
    [sem('responsavel_nome'), 'responsavel_nome', 'sem responsável'],
    [sem('responsavel_contato'), 'responsavel_contato', 'sem telefone do responsável'],
    [{ ...sem('nome'), nome: 'X', fluxo_estimado_mensal: -5 }, 'fluxo_estimado_mensal', 'movimento negativo'],
  ]) {
    const invalido = await criar(conta.id, dados);
    assert.strictEqual(invalido.status, 400, `${motivo}: ${JSON.stringify(invalido.json)}`);
    assert.strictEqual(invalido.json.campo, campo, motivo);
  }
  // Sem número: 400 que diz o que falta.
  const semNumero = await criar(conta.id, sem('numero'));
  assert.strictEqual(semNumero.status, 400, JSON.stringify(semNumero.json));
  assert.match(semNumero.json.erro, /número/);
  assert.ok(semNumero.json.campo, 'aponta um campo do endereço');
  // Categoria desativada também não serve.
  await pool.query('UPDATE categorias SET ativo = false WHERE id = $1', [ramo.id]);
  const inativa = await criar(conta.id, { ...corpo, nome: 'Com ramo desativado' });
  assert.strictEqual(inativa.status, 400);
  assert.strictEqual(inativa.json.campo, 'categoria_id');
  // Horário inválido: 400 (validado no INSERT).
  const horario = await criar(conta.id, {
    ...corpo,
    nome: 'Horário Quebrado',
    categoria_id: undefined,
    horario_semanal: { seg: { abre: '25:00', fecha: '10:00' } },
  });
  assert.strictEqual(horario.status, 400, JSON.stringify(horario.json));
  const { rows: total } = await pool.query('SELECT COUNT(*)::int AS n FROM pontos WHERE anunciante_id = $1', [
    conta.id,
  ]);
  assert.strictEqual(total[0].n, 2, 'só os dois válidos');

  // Conta inexistente ou excluída: 404. Conta própria da Mostraí: 409.
  for (const id of [999999999, 'abc']) assert.strictEqual((await criar(id, corpo)).status, 404, `conta ${id}`);
  const excluida = await novaConta();
  await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [excluida.id]);
  assert.strictEqual((await criar(excluida.id, corpo)).status, 404, 'conta excluída');
  const { rows: propria } = await pool.query('SELECT id FROM anunciantes WHERE conta_propria LIMIT 1');
  const propriaId = propria[0]?.id ?? (await novaConta()).id;
  if (!propria[0]) await pool.query('UPDATE anunciantes SET conta_propria = true WHERE id = $1', [propriaId]);
  const antes = (await pool.query('SELECT COUNT(*)::int AS n FROM pontos WHERE anunciante_id = $1', [propriaId]))
    .rows[0].n;
  assert.strictEqual((await criar(propriaId, { ...corpo, nome: 'Ponto da Mostraí' })).status, 409, 'conta própria');
  assert.strictEqual(
    (await pool.query('SELECT COUNT(*)::int AS n FROM pontos WHERE anunciante_id = $1', [propriaId])).rows[0].n,
    antes,
  );
  // Só o Admin: conta logada e anônimo recebem 401.
  const logada = await entrar(conta);
  for (const quem of [logada, navegador()]) {
    const tentativa = await quem('POST', `/admin/anunciantes/${conta.id}/pontos`, { ...corpo, nome: 'Forjado' });
    assert.strictEqual(tentativa.status, 401);
  }

  // A candidatura aprovada grava a origem "candidatura" (e nenhum autor).
  const candidata = await novaConta();
  const cidadeDoPedido = cidadeUnica();
  criadas.cidadesAprovadas.push(cidadeDoPedido);
  const cand = await candidaturasRepo.criar({
    tipo: 'ponto',
    nome: 'Responsável',
    contato_telefone: '16988880000',
    nome_comercio: `Academia ${randomUUID().slice(0, 8)}`,
    logradouro: 'Avenida Brasil',
    numero: String(100 + Math.floor(Math.random() * 800)),
    bairro: 'Centro',
    cidade: cidadeDoPedido,
    uf: 'SP',
    cep: '15990000',
    segmento: 'academia',
    conta_id: candidata.id,
    origem: 'painel',
  });
  const aprovada = await admin('POST', `/admin/candidaturas/${cand.id}/liberar`);
  assert.strictEqual(aprovada.status, 200, JSON.stringify(aprovada.json));
  const { rows: daCandidatura } = await pool.query(
    'SELECT tipo, anunciante_id, origem, criado_por FROM pontos WHERE candidatura_id = $1',
    [cand.id],
  );
  assert.deepStrictEqual(daCandidatura, [
    { tipo: 'fixo', anunciante_id: candidata.id, origem: 'candidatura', criado_por: null },
  ]);
});
