const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// MOSTRAÍ MÓVEL NO PONTO AGUARDANDO INSTALAÇÃO + AGENDA (ADR-047, 14/10/2026;
// migration 123). Aqui, a parte do Móvel:
//   · o MOTIVO da alocação (hospedagem e evento, rotas nova e antiga);
//   · o VÍNCULO da hospedagem com o ponto fixo da conta (local_ponto_id),
//     conferido no servidor também pela rota antiga;
//   · o CANCELAMENTO auditável (motivo obrigatório depois dos 409 de estado,
//     quem cancelou/encerrou);
//   · a aba "Aguardando instalação" da Agenda móvel (?aguardando=1), com a
//     alocação vinculada — padrão e ?historico=1 iguais a antes;
//   · as passagens do Móvel na ficha do ponto fixo;
//   · o HISTÓRICO na agenda do cliente (encerradas, período real, nunca
//     canceladas) e o aviso "instalação fixa concluída — encerre a alocação";
//   · a regressão do dono: o estabelecimento aguardando nunca vira posição.
// Itens do dono cobertos: 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 18, 23 (o
// 15 junto; 20 e 21 seguem em tests/rede-movel.test.js e
// tests/obrigacao-do-ciclo.test.js, sem mudança).
// Roda o `app` REAL (guarda do /admin, logins de verdade). Cada teste cria as
// próprias contas, redes e pontos — os arquivos rodam em paralelo no mesmo
// banco, então toda lista global é filtrada pelos ids daqui.
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-movel-agenda-instalacao';
process.env.NODE_ENV = 'test';
const app = require('../src/server');
const alocacao = require('../src/pontos/alocacao');
const hospedagem = require('../src/pontos/hospedagem');
const { formatarCodigoTela } = require('../src/lib/codigo-tela');
const { instalarPlayer } = require('./apoio-player');

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

// Tudo o que um ponto (rede ou fixo) deste arquivo deixou, na ordem das
// chaves estrangeiras. A passagem do Móvel sai pela rede (ponto_id) ou pelo
// estabelecimento (local_ponto_id, sem ON DELETE — a 123).
async function apagarPonto(id) {
  const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
  await pool.query(
    `DELETE FROM eventos WHERE anunciante_id IS NULL
        AND (propriedades->>'ponto_id' = $1::int::text
             OR propriedades->>'dispositivo_id' IN (SELECT id::text FROM dispositivos WHERE ponto_id = $1::int))`,
    [id],
  );
  const hosp = 'SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1 OR local_ponto_id = $1';
  await pool.query(`DELETE FROM saldo_hospedagem_lancamentos WHERE hospedagem_id IN (${hosp})`, [id]);
  await pool.query(`DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (${hosp})`, [id]);
  await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE ponto_id = $1 OR local_ponto_id = $1', [id]);
  await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query('DELETE FROM pontos_moveis_eventos WHERE ponto_id = $1', [id]);
  await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query(`DELETE FROM midias_exibicoes_contador WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [id]);
  await pool.query('DELETE FROM tela_operacao WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM creditos_ledger WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM beneficios_basico_ponto WHERE ponto_id = $1', [id]);
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
    for (const t of [
      'banco_horas',
      'exibicoes_contador',
      'anunciantes_pontos',
      'pendencias',
      'notificacoes',
      'email_outbox',
      'creditos_ledger',
      'criativos',
      'eventos',
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]);
    }
    await pool.query('DELETE FROM beneficios_basico_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
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
// "2026-10-14T14:30" de Matão (o que o formulário do Admin manda),
// deslocado em horas a partir de agora.
const paredeMais = (horas) => alocacao.parede(new Date(Date.now() + horas * 3_600_000));
const ENDERECO_EXTERNO = {
  cep: '15990-000',
  logradouro: 'Avenida das Feiras',
  numero: '100',
  complemento: '',
  bairro: 'Parque',
  cidade: 'Matão',
  uf: 'SP',
};
const ENTREGA = { itens: { tela: true, suporte: true }, condicao: 'ok' };
const MOTIVO_INVALIDO = { erro: 'motivo da alocação inválido' };
const PONTO_DE_OUTRA_CONTA = { erro: 'esse ponto não é um estabelecimento desta conta' };
const SEM_MOTIVO = { erro: 'informe o motivo do cancelamento (até 300 caracteres)' };
// O compromisso visto pelo cliente: SÓ estas chaves.
const CHAVES_PUBLICAS = ['fim', 'inicio', 'local', 'nome', 'tipo'];
// Uma linha da Agenda móvel do Admin (padrão e ?historico=1): as de antes da
// ADR-047 mais o planejamento que só o Admin vê (motivo da alocação e, na
// cancelada, o porquê e quem) — a mesma forma de lista, filtro e ordem.
const CHAVES_DA_AGENDA = [
  'cidade',
  'conta',
  'emCurso',
  'encerradoPor',
  'encerramento',
  'estado',
  'fim',
  'id',
  'inicio',
  'local',
  'motivoAlocacao',
  'motivoCancelamento',
  'nome',
  'rede',
  'redeId',
  'telas',
  'tipo',
  'uf',
];

async function novaConta({ nome = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, logradouro, numero, bairro, endereco, cidade, uf, cep,
                              responsavel_nome)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true,
             'Rua das Flores', '10', 'Centro', 'Rua das Flores, 10', 'Matão', 'SP', '15990000', 'Fulana')
     RETURNING *`,
    [
      nome || `Móvel Agenda ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `movel-agenda-${randomUUID()}@example.com`,
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

async function novaCategoria() {
  const { rows } = await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id, nome`, [
    `Ramo ${randomUUID().slice(0, 8)}`,
  ]);
  criadas.categorias.push(rows[0].id);
  return rows[0];
}

async function criarRede() {
  const r = await admin('POST', '/admin/pontos-moveis', { nome: 'Mostraí Móvel', cidade: cidadeUnica(), uf: 'SP' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  return r.json;
}

// "+ Adicionar tela" (a mesma rota do fixo e da rede). A tela nasce ativa,
// sem Player.
async function adicionarTela(pontoId) {
  const r = await admin('POST', `/admin/pontos/${pontoId}/dispositivos`, {});
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

// Rede com `n` telas, fora do sorteio automático das contas de outros
// arquivos.
async function redeComTelas(n) {
  const rede = await criarRede();
  const telas = [];
  for (let i = 0; i < n; i++) telas.push(await adicionarTela(rede.id));
  await pool.query('UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = $1', [rede.id]);
  return { ...rede, telas };
}

// O ESTABELECIMENTO: ponto fixo de uma conta (ou sem dono), fora do sorteio.
// Nasce como o aprovado de hoje — a_instalar e sem tela: aguardando
// instalação.
async function estabelecimento(
  conta,
  { nome = null, status = 'a_instalar', prevista = null, categoriaId = null } = {},
) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, logradouro, numero, bairro, cidade, uf, cep, segmento, responsavel_nome,
                         responsavel_contato, status, anunciante_id, categoria_id, escolha_bloqueada_em,
                         instalacao_prevista_em)
     VALUES ($1, 'Rua do Ponto, 55', 'Rua do Ponto', '55', 'Vila Nova', 'Matão', 'SP', '15990-000', 'outro', 'R',
             '16 9', $2, $3, $4, now(), $5) RETURNING *`,
    [nome || `Loja ${randomUUID().slice(0, 8)}`, status, conta ? conta.id : null, categoriaId, prevista],
  );
  criadas.pontos.push(rows[0].id);
  return rows[0];
}

async function arquivar(pontoId) {
  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste' WHERE id = $1`,
    [pontoId],
  );
}

// POST do compromisso; na conta, revisa o percentual se outro arquivo o
// mudou no meio (tests/hospedagem.test.js) — como o Admin faria.
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

// A rota ANTIGA da hospedagem (chega direto em hospedagem.criar).
async function hospedagemAntiga(redeId, tela, conta, extra = {}) {
  let r;
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    r = await admin('POST', `/admin/pontos/${redeId}/hospedagens`, {
      dispositivo_id: tela,
      conta_id: conta.id,
      local: 'Padaria Central',
      endereco: 'Rua A, 1',
      inicio: paredeMais(48),
      fim: paredeMais(72),
      percentual_esperado: await hospedagem.percentualAtual(),
      ...extra,
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

// O evento pela rota ANTIGA (POST /admin/pontos/:id/eventos).
const corpoDeEventoAntigo = (telas, extra = {}) => ({
  nome: 'Rodeio',
  local: 'Recinto',
  endereco: 'Av. do Recinto, 1',
  inicio: paredeMais(7 * 24),
  fim: paredeMais(8 * 24),
  telas,
  ...extra,
});

const linhaHospedagem = async (ref) =>
  (await pool.query('SELECT * FROM pontos_moveis_hospedagens WHERE id = $1', [String(ref).replace(/^h/, '')])).rows[0];
const linhaEvento = async (ref) =>
  (await pool.query('SELECT * FROM pontos_moveis_eventos WHERE id = $1', [String(ref).replace(/^e/, '')])).rows[0];
const agir = (redeId, ref, acao, corpo) => admin('POST', `/admin/pontos/${redeId}/compromissos/${ref}/${acao}`, corpo);

// "A tela chegou": termo físico assinado + entrega, pela porta do compromisso.
async function iniciarNaConta(redeId, ref) {
  const termo = await admin('PUT', `/admin/pontos/${redeId}/hospedagens/${ref.slice(1)}/termo-fisico`, {
    assinado: true,
  });
  assert.strictEqual(termo.status, 200, JSON.stringify(termo.json));
  const r = await agir(redeId, ref, 'iniciar', { entrega: ENTREGA });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
}

async function listaAguardando() {
  const r = await admin('GET', '/admin/pontos-moveis/agenda?aguardando=1');
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  assert.deepStrictEqual(Object.keys(r.json), ['aguardando']);
  return r.json.aguardando;
}

async function compromissosDe(pontoId) {
  const r = await admin('GET', `/admin/pontos/${pontoId}/compromissos`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

const agendaPublica = async (nav, redeId) => {
  const r = await nav('GET', `/anunciantes/me/redes-moveis/${redeId}/agenda`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json;
};

// ---------- 1. Motivo da alocação ----------
test('motivo da alocação: grava na hospedagem e no evento (rotas nova e antiga); fora da lista = 400; a edição troca, mantém se ausente e limpa', async () => {
  const rede = await redeComTelas(4);
  const [t1, t2, t3, t4] = rede.telas;
  const conta = await novaConta();

  const h = await postarCompromisso(rede.id, corpoConta(conta, t1, { motivo: 'teste_ponto' }));
  assert.strictEqual(h.status, 201, JSON.stringify(h.json));
  assert.strictEqual((await linhaHospedagem(h.json.ref)).motivo_alocacao, 'teste_ponto');
  const e = await postarCompromisso(rede.id, corpoExterno([t2], { motivo: 'evento' }));
  assert.strictEqual(e.status, 201, JSON.stringify(e.json));
  assert.strictEqual((await linhaEvento(e.json.ref)).motivo_alocacao, 'evento');
  // Sem motivo (e a opção vazia do select): nulo, como as linhas antigas.
  const semMotivo = await postarCompromisso(
    rede.id,
    corpoExterno([t3], { motivo: '', inicio: paredeMais(10 * 24), fim: paredeMais(11 * 24) }),
  );
  assert.strictEqual(semMotivo.status, 201, JSON.stringify(semMotivo.json));
  assert.strictEqual((await linhaEvento(semMotivo.json.ref)).motivo_alocacao, null);

  // Fora da lista: 400, pelas duas portas e pelas rotas antigas — nada gravado.
  for (const motivo of ['rascunho', 'AGUARDANDO_INSTALACAO', 5, ['evento']]) {
    const r = await postarCompromisso(rede.id, corpoConta(conta, t4, { motivo }));
    assert.strictEqual(r.status, 400, `conta, motivo ${JSON.stringify(motivo)}: ${JSON.stringify(r.json)}`);
    assert.deepStrictEqual(r.json, MOTIVO_INVALIDO);
  }
  const externoInvalido = await postarCompromisso(rede.id, corpoExterno([t4], { motivo: 'rascunho' }));
  assert.strictEqual(externoInvalido.status, 400, JSON.stringify(externoInvalido.json));
  assert.deepStrictEqual(externoInvalido.json, MOTIVO_INVALIDO);
  const eventoAntigoInvalido = await admin(
    'POST',
    `/admin/pontos/${rede.id}/eventos`,
    corpoDeEventoAntigo([t4], { motivo: 'rascunho' }),
  );
  assert.strictEqual(eventoAntigoInvalido.status, 400, JSON.stringify(eventoAntigoInvalido.json));
  assert.deepStrictEqual(eventoAntigoInvalido.json, MOTIVO_INVALIDO);
  const hospAntigaInvalida = await hospedagemAntiga(rede.id, t4, conta, { motivo: 'rascunho' });
  assert.strictEqual(hospAntigaInvalida.status, 400, JSON.stringify(hospAntigaInvalida.json));
  assert.deepStrictEqual(hospAntigaInvalida.json, MOTIVO_INVALIDO);
  const naT4 = await pool.query(
    `SELECT (SELECT COUNT(*)::int FROM pontos_moveis_hospedagens WHERE dispositivo_id = $1)
          + (SELECT COUNT(*)::int FROM pontos_moveis_evento_telas WHERE dispositivo_id = $1) AS n`,
    [t4],
  );
  assert.strictEqual(naT4.rows[0].n, 0, 'motivo inválido não grava nada');

  // Rotas antigas com motivo válido: gravam.
  const hAntiga = await hospedagemAntiga(rede.id, t4, conta, {
    motivo: 'ativacao_comercial',
    inicio: paredeMais(20 * 24),
    fim: paredeMais(21 * 24),
  });
  assert.strictEqual(hAntiga.status, 201, JSON.stringify(hAntiga.json));
  assert.strictEqual((await linhaHospedagem(hAntiga.json.id)).motivo_alocacao, 'ativacao_comercial');
  const eAntigo = await admin(
    'POST',
    `/admin/pontos/${rede.id}/eventos`,
    corpoDeEventoAntigo([t4], { motivo: 'outro' }),
  );
  assert.strictEqual(eAntigo.status, 201, JSON.stringify(eAntigo.json));
  assert.strictEqual((await linhaEvento(eAntigo.json.id)).motivo_alocacao, 'outro');

  // Edição (programado): troca; sem a chave, mantém (o formulário antigo não
  // a manda); inválido = 400 e nada muda; null limpa.
  const editarH = (extra) =>
    admin(
      'PATCH',
      `/admin/pontos/${rede.id}/compromissos/${h.json.ref}`,
      corpoConta(conta, t1, { endereco_origem: 'atual', ...extra }),
    );
  const motivoH = async () => (await linhaHospedagem(h.json.ref)).motivo_alocacao;
  assert.strictEqual((await editarH({ motivo: 'outro' })).status, 200);
  assert.strictEqual(await motivoH(), 'outro');
  assert.strictEqual((await editarH({})).status, 200);
  assert.strictEqual(await motivoH(), 'outro', 'sem a chave: mantém');
  const hInvalido = await editarH({ motivo: 'rascunho' });
  assert.strictEqual(hInvalido.status, 400, JSON.stringify(hInvalido.json));
  assert.deepStrictEqual(hInvalido.json, MOTIVO_INVALIDO);
  assert.strictEqual(await motivoH(), 'outro');
  assert.strictEqual((await editarH({ motivo: null })).status, 200);
  assert.strictEqual(await motivoH(), null, 'null limpa');
  const editarE = (extra) =>
    admin(
      'PATCH',
      `/admin/pontos/${rede.id}/compromissos/${e.json.ref}`,
      corpoExterno([t2], { endereco_origem: 'atual', ...extra }),
    );
  const motivoE = async () => (await linhaEvento(e.json.ref)).motivo_alocacao;
  assert.strictEqual((await editarE({ motivo: 'teste_ponto' })).status, 200);
  assert.strictEqual(await motivoE(), 'teste_ponto');
  assert.strictEqual((await editarE({})).status, 200);
  assert.strictEqual(await motivoE(), 'teste_ponto', 'sem a chave: mantém');
  const eInvalido = await editarE({ motivo: 'rascunho' });
  assert.strictEqual(eInvalido.status, 400, JSON.stringify(eInvalido.json));
  assert.deepStrictEqual(eInvalido.json, MOTIVO_INVALIDO);
  assert.strictEqual((await editarE({ motivo: '' })).status, 200);
  assert.strictEqual(await motivoE(), null);

  // A lista do Admin (formato unificado) mostra o motivo.
  const lista = await compromissosDe(rede.id);
  const porRef = new Map(lista.proximos.map((c) => [c.ref, c]));
  assert.strictEqual(porRef.get(`h${hAntiga.json.id}`).motivoAlocacao, 'ativacao_comercial');
  assert.strictEqual(porRef.get(`e${eAntigo.json.id}`).motivoAlocacao, 'outro');
  assert.strictEqual(porRef.get(h.json.ref).motivoAlocacao, null);
});

// ---------- 2. Vínculo com o ponto fixo ----------
test('vínculo: origem "ponto" grava local_ponto_id; ponto de outra conta, móvel ou arquivado = 400 (também na rota antiga); a edição troca, mantém e limpa', async () => {
  const rede = await redeComTelas(3);
  const [t1, t2, t3] = rede.telas;
  const conta = await novaConta();
  const outra = await novaConta();
  const loja = await estabelecimento(conta);
  const filial = await estabelecimento(conta);
  const alheio = await estabelecimento(outra);
  const arquivado = await estabelecimento(conta);
  await arquivar(arquivado.id);

  const r = await postarCompromisso(rede.id, corpoConta(conta, t1, { endereco_origem: 'ponto', ponto_id: loja.id }));
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  assert.strictEqual((await linhaHospedagem(r.json.ref)).local_ponto_id, loja.id);
  // Pelo formulário: só os pontos fixos não arquivados DESTA conta.
  for (const id of [alheio.id, arquivado.id, rede.id]) {
    const x = await postarCompromisso(rede.id, corpoConta(conta, t2, { endereco_origem: 'ponto', ponto_id: id }));
    assert.strictEqual(x.status, 400, `ponto ${id}: ${JSON.stringify(x.json)}`);
    assert.strictEqual(x.json.campo, 'ponto_id');
  }
  // Pela rota antiga (chega direto): o servidor confere de novo — também o 0
  // (é número, mas não é ponto: 400, nunca o 500 da chave estrangeira).
  for (const id of [alheio.id, arquivado.id, rede.id, 'abc', 999999999, 0, '0', '000']) {
    const x = await hospedagemAntiga(rede.id, t2, conta, { local_ponto_id: id });
    assert.strictEqual(x.status, 400, `ponto ${id}: ${JSON.stringify(x.json)}`);
    assert.deepStrictEqual(x.json, PONTO_DE_OUTRA_CONTA);
  }
  const naT2 = await pool.query('SELECT COUNT(*)::int AS n FROM pontos_moveis_hospedagens WHERE dispositivo_id = $1', [
    t2,
  ]);
  assert.strictEqual(naT2.rows[0].n, 0, 'recusada não grava');
  const antiga = await hospedagemAntiga(rede.id, t2, conta, { local_ponto_id: filial.id });
  assert.strictEqual(antiga.status, 201, JSON.stringify(antiga.json));
  assert.strictEqual((await linhaHospedagem(antiga.json.id)).local_ponto_id, filial.id);
  // Endereço da conta: sem vínculo.
  const semVinculo = await postarCompromisso(rede.id, corpoConta(conta, t3));
  assert.strictEqual(semVinculo.status, 201, JSON.stringify(semVinculo.json));
  assert.strictEqual((await linhaHospedagem(semVinculo.json.ref)).local_ponto_id, null);

  // Edição: "ponto" grava o novo; manter o local mantém; conta/outro limpa.
  const editar = async (extra) => {
    const x = await admin('PATCH', `/admin/pontos/${rede.id}/compromissos/${r.json.ref}`, corpoConta(conta, t1, extra));
    assert.strictEqual(x.status, 200, JSON.stringify(x.json));
    return (await linhaHospedagem(r.json.ref)).local_ponto_id;
  };
  assert.strictEqual(await editar({ endereco_origem: 'ponto', ponto_id: filial.id }), filial.id);
  assert.strictEqual(await editar({ endereco_origem: 'atual' }), filial.id, 'manter o local mantém o vínculo');
  assert.strictEqual(await editar({ endereco_origem: 'conta' }), null);
  assert.strictEqual(await editar({ endereco_origem: 'ponto', ponto_id: loja.id }), loja.id);
  assert.strictEqual(await editar({ endereco_origem: 'outro', endereco_partes: ENDERECO_EXTERNO }), null);
  assert.strictEqual(await editar({ endereco_origem: 'ponto', ponto_id: loja.id }), loja.id);
  // A rota antiga de alteração confere o ponto e aceita null.
  const periodo = (extra) =>
    admin('PUT', `/admin/pontos/${rede.id}/hospedagens/${r.json.ref.slice(1)}/periodo`, {
      inicio: paredeMais(48),
      fim: paredeMais(72),
      ...extra,
    });
  for (const id of [alheio.id, 0, '0']) {
    const recusada = await periodo({ local_ponto_id: id });
    assert.strictEqual(recusada.status, 400, `ponto ${id}: ${JSON.stringify(recusada.json)}`);
    assert.deepStrictEqual(recusada.json, PONTO_DE_OUTRA_CONTA);
  }
  assert.strictEqual((await linhaHospedagem(r.json.ref)).local_ponto_id, loja.id, 'recusada não muda');
  assert.strictEqual((await periodo({ local_ponto_id: null })).status, 200);
  assert.strictEqual((await linhaHospedagem(r.json.ref)).local_ponto_id, null);

  // O Admin vê o vínculo no formato unificado.
  assert.strictEqual(await editar({ endereco_origem: 'ponto', ponto_id: loja.id }), loja.id);
  const lista = await compromissosDe(rede.id);
  const c = lista.proximos.find((x) => x.ref === r.json.ref);
  assert.deepStrictEqual([c.localPontoId, c.pontoInstalado, c.avisoEncerrar], [loja.id, false, false]);
});

// ---------- 2b. Em curso: só o fim muda ----------
test('hospedagem em curso: pedir motivo ou vínculo = 400, como local e endereço (rotas nova e antiga) — nada muda; prorrogar segue', async () => {
  const rede = await redeComTelas(1);
  const conta = await novaConta();
  const loja = await estabelecimento(conta);
  const filial = await estabelecimento(conta);
  const r = await postarCompromisso(
    rede.id,
    corpoConta(conta, rede.telas[0], {
      endereco_origem: 'ponto',
      ponto_id: loja.id,
      motivo: 'teste_ponto',
      inicio: paredeMais(-1),
      fim: paredeMais(24),
    }),
  );
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  await iniciarNaConta(rede.id, r.json.ref);
  const JA_COMECOU = { erro: 'A hospedagem já começou — só o fim pode mudar (prorrogar)', campo: 'fim' };
  const planejamento = async () => {
    const l = await linhaHospedagem(r.json.ref);
    return [l.motivo_alocacao, l.local_ponto_id, new Date(l.fim).getTime()];
  };
  const antes = await planejamento();
  assert.deepStrictEqual(antes.slice(0, 2), ['teste_ponto', loja.id]);

  // Rota nova (PATCH do compromisso): o motivo (válido ou não) e a troca de
  // local — que leva o vínculo junto — não são descartados calados.
  const fim = paredeMais(48);
  for (const extra of [
    { motivo: 'outro' },
    { motivo: 'rascunho' },
    { motivo: null },
    { endereco_origem: 'ponto', ponto_id: filial.id },
    { endereco_origem: 'conta' },
  ]) {
    const x = await admin('PATCH', `/admin/pontos/${rede.id}/compromissos/${r.json.ref}`, { fim, ...extra });
    assert.strictEqual(x.status, 400, `${JSON.stringify(extra)}: ${JSON.stringify(x.json)}`);
    assert.deepStrictEqual(x.json, JA_COMECOU);
  }
  // Rota antiga (PUT /periodo): a mesma regra de local, endereço e horário.
  const hid = r.json.ref.slice(1);
  for (const extra of [
    { motivo: 'outro' },
    { motivo: 'nao_existe' },
    { local_ponto_id: filial.id },
    { local_ponto_id: null },
  ]) {
    const x = await admin('PUT', `/admin/pontos/${rede.id}/hospedagens/${hid}/periodo`, { fim, ...extra });
    assert.strictEqual(x.status, 400, `${JSON.stringify(extra)}: ${JSON.stringify(x.json)}`);
    assert.deepStrictEqual(x.json, JA_COMECOU);
  }
  assert.deepStrictEqual(await planejamento(), antes, 'recusado não muda nada (nem o fim)');

  // Prorrogar (só o fim; "manter o local" também) continua valendo e mantém
  // o motivo e o vínculo.
  const p = await admin('PATCH', `/admin/pontos/${rede.id}/compromissos/${r.json.ref}`, {
    fim,
    endereco_origem: 'atual',
  });
  assert.strictEqual(p.status, 200, JSON.stringify(p.json));
  const depois = await planejamento();
  assert.deepStrictEqual(depois.slice(0, 2), ['teste_ponto', loja.id]);
  assert.ok(depois[2] > antes[2], 'prorrogou');
});

// ---------- 3. Cancelamento auditável ----------
test('cancelar à mão: 409 de estado primeiro; sem motivo = 400; com motivo grava o porquê e quem (hospedagem e evento); encerrar evento grava quem', async () => {
  const rede = await redeComTelas(3);
  const [t1, t2, t3] = rede.telas;
  const conta = await novaConta();

  const h = await postarCompromisso(rede.id, corpoConta(conta, t1));
  assert.strictEqual(h.status, 201, JSON.stringify(h.json));
  for (const corpo of [
    undefined,
    {},
    { motivo: '' },
    { motivo: '    ' },
    { motivo: 'x'.repeat(301) },
    { motivo: 42 },
  ]) {
    const x = await agir(rede.id, h.json.ref, 'cancelar', corpo);
    assert.strictEqual(x.status, 400, `${JSON.stringify(corpo)}: ${JSON.stringify(x.json)}`);
    assert.deepStrictEqual(x.json, SEM_MOTIVO);
  }
  assert.strictEqual((await linhaHospedagem(h.json.ref)).estado, 'programada', 'sem motivo, nada muda');
  const ok = await agir(rede.id, h.json.ref, 'cancelar', { motivo: '  o comércio fechou para reforma  ' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  let linha = await linhaHospedagem(h.json.ref);
  assert.deepStrictEqual(
    [linha.estado, linha.motivo_cancelamento, linha.encerrado_por_admin, linha.encerramento],
    ['cancelada', 'o comércio fechou para reforma', process.env.ADMIN_USER, 'manual'],
  );
  // Já cancelada: o 409 de sempre vem antes da falta de motivo.
  const deNovo = await agir(rede.id, h.json.ref, 'cancelar');
  assert.strictEqual(deNovo.status, 409, JSON.stringify(deNovo.json));
  assert.match(deNovo.json.erro, /cancelada/);
  // Em andamento: "use Encerrar", com ou sem motivo.
  const ativa = await postarCompromisso(
    rede.id,
    corpoConta(conta, t2, { inicio: paredeMais(-1), fim: paredeMais(24) }),
  );
  assert.strictEqual(ativa.status, 201, JSON.stringify(ativa.json));
  await iniciarNaConta(rede.id, ativa.json.ref);
  const naAtiva = await agir(rede.id, ativa.json.ref, 'cancelar');
  assert.strictEqual(naAtiva.status, 409, JSON.stringify(naAtiva.json));
  assert.match(naAtiva.json.erro, /Encerrar/);
  // Rota antiga da hospedagem: a mesma regra. 300 caracteres cabem, contados
  // como o banco (um emoji é um caractere).
  const h2 = await postarCompromisso(rede.id, corpoConta(conta, t3));
  assert.strictEqual(h2.status, 201, JSON.stringify(h2.json));
  const cancelarAntiga = (corpo) =>
    admin('POST', `/admin/pontos/${rede.id}/hospedagens/${h2.json.ref.slice(1)}/cancelar`, corpo);
  const semCorpo = await cancelarAntiga();
  assert.strictEqual(semCorpo.status, 400, JSON.stringify(semCorpo.json));
  assert.deepStrictEqual(semCorpo.json, SEM_MOTIVO);
  const longo = '🚚'.repeat(300);
  assert.strictEqual((await cancelarAntiga({ motivo: longo })).status, 200);
  linha = await linhaHospedagem(h2.json.ref);
  assert.deepStrictEqual(
    [linha.estado, linha.motivo_cancelamento, linha.encerrado_por_admin],
    ['cancelada', longo, process.env.ADMIN_USER],
  );

  // Evento programado: sem motivo = 400 (rota antiga também); com motivo,
  // grava o porquê e quem.
  const ev = await postarCompromisso(rede.id, corpoExterno([t1]));
  assert.strictEqual(ev.status, 201, JSON.stringify(ev.json));
  const evAntigo = await admin('POST', `/admin/pontos/${rede.id}/eventos/${ev.json.ref.slice(1)}/cancelar`);
  assert.strictEqual(evAntigo.status, 400, JSON.stringify(evAntigo.json));
  assert.deepStrictEqual(evAntigo.json, SEM_MOTIVO);
  const evOk = await agir(rede.id, ev.json.ref, 'cancelar', { motivo: 'organizador desistiu' });
  assert.strictEqual(evOk.status, 200, JSON.stringify(evOk.json));
  const linhaEv = await linhaEvento(ev.json.ref);
  assert.deepStrictEqual(
    [linhaEv.estado, linhaEv.motivo_cancelamento, linhaEv.encerrado_por_admin, linhaEv.encerramento],
    ['cancelado', 'organizador desistiu', process.env.ADMIN_USER, 'manual'],
  );
  // Evento em andamento: 409 antes do motivo; encerrar (rota antiga) grava quem.
  const andamento = await postarCompromisso(
    rede.id,
    corpoExterno([t3], { inicio: paredeMais(-2), fim: paredeMais(24) }),
  );
  assert.strictEqual(andamento.status, 201, JSON.stringify(andamento.json));
  assert.strictEqual((await agir(rede.id, andamento.json.ref, 'iniciar')).status, 200);
  const cancelarAndamento = await agir(rede.id, andamento.json.ref, 'cancelar');
  assert.strictEqual(cancelarAndamento.status, 409, JSON.stringify(cancelarAndamento.json));
  assert.match(cancelarAndamento.json.erro, /Encerrar/);
  const encerrar = await admin('POST', `/admin/pontos/${rede.id}/eventos/${andamento.json.ref.slice(1)}/encerrar`);
  assert.strictEqual(encerrar.status, 200, JSON.stringify(encerrar.json));
  const linhaAnd = await linhaEvento(andamento.json.ref);
  assert.deepStrictEqual(
    [linhaAnd.estado, linhaAnd.encerrado_por_admin, linhaAnd.motivo_cancelamento, linhaAnd.encerramento],
    ['encerrado', process.env.ADMIN_USER, null, 'manual'],
  );

  // O Admin vê o porquê e quem no formato unificado.
  const lista = await compromissosDe(rede.id);
  const historico = new Map(lista.historico.map((c) => [c.ref, c]));
  assert.deepStrictEqual(
    [h.json.ref, ev.json.ref, andamento.json.ref].map((ref) => {
      const c = historico.get(ref);
      return [c.estado, c.motivoCancelamento, c.encerradoPor];
    }),
    [
      ['cancelado', 'o comércio fechou para reforma', process.env.ADMIN_USER],
      ['cancelado', 'organizador desistiu', process.env.ADMIN_USER],
      ['encerrado', null, process.env.ADMIN_USER],
    ],
  );
  // O job (encerrarVencidas, conjunto protegido) não muda e segue coberto
  // por tests/hospedagem.test.js: chamá-lo daqui disputaria as linhas
  // vencidas daquele arquivo, que roda em paralelo e confere as contagens.
});

// ---------- 4. Agenda do Admin: "Aguardando instalação" ----------
test('agenda ?aguardando=1: só os aguardando, pela data prevista (sem data por último), com a alocação vinculada; padrão e ?historico=1 como antes', async () => {
  const rede = await redeComTelas(3);
  const [t1, t2, t3] = rede.telas;
  const dono = await novaConta();
  const categoria = await novaCategoria();
  const prefixo = `Aguarda ${randomUUID().slice(0, 6)}`;
  const novembro = await estabelecimento(dono, { nome: `${prefixo} Y novembro`, prevista: '2026-11-15' });
  const dezembro = await estabelecimento(dono, {
    nome: `${prefixo} Z dezembro`,
    prevista: '2026-12-20',
    categoriaId: categoria.id,
  });
  const semDonoSemData = await estabelecimento(null, { nome: `${prefixo} A sem data` });
  const semData = await estabelecimento(dono, { nome: `${prefixo} B sem data` });
  // Tela cadastrada sem Player não prova instalação: continua aguardando.
  const telaSemPlayer = await estabelecimento(dono, { nome: `${prefixo} C tela sem Player` });
  await adicionarTela(telaSemPlayer.id);
  // Fora: instalado (1º sinal real), instalado que foi para reparo, inativo,
  // arquivado — e a própria rede.
  const instalado = await estabelecimento(dono, { nome: `${prefixo} D instalado`, prevista: '2026-11-01' });
  await instalarPlayer(await adicionarTela(instalado.id));
  const reparo = await estabelecimento(dono, { nome: `${prefixo} E reparo` });
  await pool.query(
    `UPDATE dispositivos SET status = 'reparo', primeiro_sinal_em = now() - interval '10 days' WHERE id = $1`,
    [await adicionarTela(reparo.id)],
  );
  await pool.query(`UPDATE pontos SET status = 'em_reparo' WHERE id = $1`, [reparo.id]);
  const inativo = await estabelecimento(dono, { nome: `${prefixo} F inativo`, status: 'inativo' });
  const arquivado = await estabelecimento(dono, { nome: `${prefixo} G arquivado` });
  await arquivar(arquivado.id);

  const noPonto = async (ponto, tela, extra) => {
    const r = await postarCompromisso(
      rede.id,
      corpoConta(dono, tela, { endereco_origem: 'ponto', ponto_id: ponto.id, ...extra }),
    );
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    return r.json.ref;
  };
  // Novembro: duas programadas — a alocação é a que começa primeiro.
  await noPonto(novembro, t1, { inicio: paredeMais(10 * 24), fim: paredeMais(11 * 24) });
  const novembroProxima = await noPonto(novembro, t2, {
    inicio: paredeMais(3 * 24),
    fim: paredeMais(4 * 24),
    motivo: 'aguardando_instalacao',
  });
  // Dezembro: ativa + uma programada depois — a alocação é a ativa.
  const dezembroAtiva = await noPonto(dezembro, t3, {
    inicio: paredeMais(-1),
    fim: paredeMais(48),
    motivo: 'aguardando_instalacao',
  });
  await iniciarNaConta(rede.id, dezembroAtiva);
  await noPonto(dezembro, t1, { inicio: paredeMais(20 * 24), fim: paredeMais(21 * 24) });
  // Sem data: só uma cancelada — sem alocação.
  const cancelada = await noPonto(semData, t2, { inicio: paredeMais(30 * 24), fim: paredeMais(31 * 24) });
  assert.strictEqual((await agir(rede.id, cancelada, 'cancelar', { motivo: 'remarcar' })).status, 200);
  // O instalado com uma programada continua fora da lista.
  await noPonto(instalado, t2, { inicio: paredeMais(40 * 24), fim: paredeMais(41 * 24) });

  const lista = await listaAguardando();
  const nossos = new Set(
    [novembro, dezembro, semDonoSemData, semData, telaSemPlayer, instalado, reparo, inativo, arquivado].map(
      (p) => p.id,
    ),
  );
  const meus = lista.filter((p) => nossos.has(p.pontoId));
  assert.deepStrictEqual(
    meus.map((p) => p.nome),
    [novembro, dezembro, semDonoSemData, semData, telaSemPlayer].map((p) => p.nome),
    'pela data prevista; sem data por último, por nome; instalado/reparo instalado/inativo/arquivado fora',
  );
  assert.ok(!lista.some((p) => p.pontoId === rede.id), 'a rede móvel não está aguardando instalação');
  for (const p of meus) {
    assert.deepStrictEqual(Object.keys(p).sort(), [
      'alocacao',
      'categoria',
      'cidade',
      'conta',
      'contaId',
      'instalacaoPrevistaEm',
      'nome',
      'pontoId',
      'segmento',
      'uf',
    ]);
  }
  const [linhaNov, linhaDez, linhaSemDono, linhaSemData, linhaTela] = meus;
  const hAtiva = await linhaHospedagem(dezembroAtiva);
  assert.deepStrictEqual(linhaDez, {
    pontoId: dezembro.id,
    nome: dezembro.nome,
    cidade: 'Matão',
    uf: 'SP',
    categoria: { id: categoria.id, nome: categoria.nome },
    segmento: categoria.nome,
    contaId: dono.id,
    conta: dono.nome_empresa,
    instalacaoPrevistaEm: '2026-12-20',
    alocacao: {
      ref: dezembroAtiva,
      id: Number(hAtiva.id),
      redeId: rede.id,
      rede: 'Mostraí Móvel',
      estado: 'ativa',
      inicio: hAtiva.inicio.toISOString(),
      fim: hAtiva.fim.toISOString(),
      motivoAlocacao: 'aguardando_instalacao',
      tela: { id: t3, codigo: formatarCodigoTela(t3) },
      avisoEncerrar: false,
    },
  });
  // Sem categoria: o ramo como a grade mostra (o segmento da candidatura),
  // nunca "—" quando o ponto tem um.
  assert.strictEqual(linhaSemDono.segmento, 'outro');
  assert.deepStrictEqual(
    [linhaNov.instalacaoPrevistaEm, linhaNov.alocacao.ref, linhaNov.alocacao.estado, linhaNov.alocacao.tela.id],
    ['2026-11-15', novembroProxima, 'programada', t2],
    'sem ativa: a programada que começa primeiro',
  );
  assert.deepStrictEqual(
    [linhaSemDono.contaId, linhaSemDono.conta, linhaSemDono.instalacaoPrevistaEm, linhaSemDono.alocacao],
    [null, null, null, null],
  );
  assert.strictEqual(linhaSemData.alocacao, null, 'cancelada não é alocação');
  assert.strictEqual(linhaTela.alocacao, null);

  // Sem o parâmetro e com ?historico=1: a mesma agenda de antes (lista de
  // compromissos, mesmo filtro e ordem), com o planejamento do Admin.
  const padrao = await admin('GET', '/admin/pontos-moveis/agenda');
  assert.strictEqual(padrao.status, 200, JSON.stringify(padrao.json));
  assert.ok(Array.isArray(padrao.json));
  const daRede = padrao.json.filter((c) => c.redeId === rede.id);
  assert.strictEqual(daRede.length, 5, 'as 5 alocações vivas da rede (a cancelada fica no histórico)');
  for (const c of daRede) assert.deepStrictEqual(Object.keys(c).sort(), CHAVES_DA_AGENDA);
  assert.deepStrictEqual(
    daRede.map((c) => [c.tipo, c.estado]).slice(0, 1),
    [['hospedagem', 'ativa']],
    'por início: a ativa primeiro',
  );
  const historico = await admin('GET', '/admin/pontos-moveis/agenda?historico=1');
  assert.strictEqual(historico.status, 200, JSON.stringify(historico.json));
  assert.ok(Array.isArray(historico.json));
  const histDaRede = historico.json.filter((c) => c.redeId === rede.id);
  assert.deepStrictEqual(
    histDaRede.map((c) => [`h${c.id}`, c.estado]),
    [[cancelada, 'cancelada']],
  );
  for (const c of histDaRede) assert.deepStrictEqual(Object.keys(c).sort(), CHAVES_DA_AGENDA);
  assert.deepStrictEqual(
    [histDaRede[0].motivoCancelamento, histDaRede[0].encerradoPor, histDaRede[0].encerramento],
    ['remarcar', process.env.ADMIN_USER, 'manual'],
    'a cancelada à mão diz por quê e quem',
  );

  // Só o Admin.
  const nav = await entrar(dono);
  assert.strictEqual((await nav('GET', '/admin/pontos-moveis/agenda?aguardando=1')).status, 401);
  assert.strictEqual((await navegador()('GET', '/admin/pontos-moveis/agenda?aguardando=1')).status, 401);
});

// ---------- 5. Ficha do ponto fixo: as passagens do Móvel ----------
test('GET /admin/pontos/:fixo/compromissos: as passagens vinculadas ao ponto (agora, próximos, histórico), de qualquer rede, no mesmo formato da rede', async () => {
  const redeA = await redeComTelas(2);
  const redeB = await redeComTelas(1);
  const dono = await novaConta();
  const loja = await estabelecimento(dono);
  const vizinha = await estabelecimento(dono);
  const naLoja = async (rede, tela, extra) => {
    const r = await postarCompromisso(
      rede.id,
      corpoConta(dono, tela, { endereco_origem: 'ponto', ponto_id: loja.id, ...extra }),
    );
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
    return r.json.ref;
  };
  const passada = await naLoja(redeA, redeA.telas[0], {
    inicio: paredeMais(-1),
    fim: paredeMais(24),
    motivo: 'aguardando_instalacao',
  });
  await iniciarNaConta(redeA.id, passada);
  assert.strictEqual((await agir(redeA.id, passada, 'encerrar', {})).status, 200);
  const cancelada = await naLoja(redeA, redeA.telas[1], { inicio: paredeMais(5 * 24), fim: paredeMais(6 * 24) });
  assert.strictEqual((await agir(redeA.id, cancelada, 'cancelar', { motivo: 'remarcada' })).status, 200);
  const agora = await naLoja(redeB, redeB.telas[0], { inicio: paredeMais(-1), fim: paredeMais(48) });
  await iniciarNaConta(redeB.id, agora);
  const proxima = await naLoja(redeA, redeA.telas[0], {
    inicio: paredeMais(10 * 24),
    fim: paredeMais(11 * 24),
    motivo: 'teste_ponto',
  });
  // Fora: na vizinha, e na conta sem vínculo.
  for (const [rede, tela, extra] of [
    [redeA, redeA.telas[1], { endereco_origem: 'ponto', ponto_id: vizinha.id }],
    [redeB, redeB.telas[0], {}],
  ]) {
    const r = await postarCompromisso(
      rede.id,
      corpoConta(dono, tela, { inicio: paredeMais(20 * 24), fim: paredeMais(21 * 24), ...extra }),
    );
    assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  }

  const doPonto = await compromissosDe(loja.id);
  assert.deepStrictEqual(Object.keys(doPonto).sort(), ['agora', 'historico', 'proximos']);
  assert.deepStrictEqual(
    doPonto.agora.map((c) => c.ref),
    [agora],
  );
  assert.deepStrictEqual(
    doPonto.proximos.map((c) => c.ref),
    [proxima],
  );
  assert.deepStrictEqual(
    doPonto.historico.map((c) => [c.ref, c.estado]),
    [
      [cancelada, 'cancelado'],
      [passada, 'encerrado'],
    ],
    'histórico do mais recente para trás',
  );
  const todos = [...doPonto.agora, ...doPonto.proximos, ...doPonto.historico];
  for (const c of todos) {
    assert.deepStrictEqual(
      [c.contexto, c.localPontoId, c.pontoInstalado, c.avisoEncerrar],
      ['conta', loja.id, false, false],
      'o ponto ainda não foi instalado: sem aviso',
    );
  }
  const porRef = new Map(todos.map((c) => [c.ref, c]));
  assert.strictEqual(porRef.get(proxima).motivoAlocacao, 'teste_ponto');
  assert.deepStrictEqual(
    [porRef.get(passada).motivoAlocacao, porRef.get(passada).encerradoPor],
    ['aguardando_instalacao', process.env.ADMIN_USER],
  );
  assert.deepStrictEqual(
    [porRef.get(cancelada).motivoCancelamento, porRef.get(cancelada).encerradoPor],
    ['remarcada', process.env.ADMIN_USER],
  );
  // O mesmo compromisso, igual nas duas fichas (o formato é um só).
  const daRede = await compromissosDe(redeA.id);
  assert.deepStrictEqual(
    daRede.proximos.find((c) => c.ref === proxima),
    porRef.get(proxima),
  );
  // Ponto que não existe: 404. Conta do anunciante não lê.
  assert.strictEqual((await admin('GET', '/admin/pontos/999999999/compromissos')).status, 404);
  assert.strictEqual((await (await entrar(dono))('GET', `/admin/pontos/${loja.id}/compromissos`)).status, 401);
});

// ---------- 6. Agenda do cliente: histórico ----------
test('agenda do cliente: histórico com até 10 encerradas, da mais recente para trás, período real, só as chaves públicas; cancelada nunca', async () => {
  const rede = await redeComTelas(2);
  const [t1, t2] = rede.telas;
  const anfitria = await novaConta({ nome: `Conta Sigilosa ${randomUUID().slice(0, 4)}` });
  const nav = await entrar(await novaConta());
  // 11 passagens encerradas, alternando hospedagem (t1) e evento (t2).
  const encerradas = [];
  for (let i = 0; i < 11; i++) {
    if (i % 2 === 0) {
      const r = await postarCompromisso(
        rede.id,
        corpoConta(anfitria, t1, {
          local: `Comércio ${i}`,
          motivo: 'teste_ponto',
          inicio: paredeMais(-1),
          fim: paredeMais(24),
          observacao: 'nota interna',
        }),
      );
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      await iniciarNaConta(rede.id, r.json.ref);
      assert.strictEqual((await agir(rede.id, r.json.ref, 'encerrar', {})).status, 200);
      encerradas.push(r.json.ref);
    } else {
      const r = await postarCompromisso(
        rede.id,
        corpoExterno([t2], { nome: `Evento ${i}`, local: `Praça ${i}`, motivo: 'evento', inicio: paredeMais(48) }),
      );
      assert.strictEqual(r.status, 201, JSON.stringify(r.json));
      assert.strictEqual((await agir(rede.id, r.json.ref, 'iniciar')).status, 200);
      assert.strictEqual((await agir(rede.id, r.json.ref, 'encerrar')).status, 200);
      encerradas.push(r.json.ref);
    }
  }
  // Cancelada (com motivo) e programada: nunca no histórico.
  const cancelada = await postarCompromisso(rede.id, corpoExterno([t2], { nome: 'Show Cancelado' }));
  assert.strictEqual(cancelada.status, 201, JSON.stringify(cancelada.json));
  assert.strictEqual(
    (await agir(rede.id, cancelada.json.ref, 'cancelar', { motivo: 'motivo interno do cancelamento' })).status,
    200,
  );

  const ag = await agendaPublica(nav, rede.id);
  assert.deepStrictEqual(Object.keys(ag).sort(), ['agora', 'historico', 'proximos', 'rede']);
  assert.strictEqual(ag.historico.length, 10, 'no máximo 10');
  // Da mais recente para trás: a última encerrada primeiro; a 1ª ficou de fora.
  const esperadas = [];
  for (const ref of [...encerradas].reverse().slice(0, 10)) {
    if (ref.startsWith('h')) {
      const l = await linhaHospedagem(ref);
      esperadas.push({
        tipo: 'hospedagem',
        nome: l.local,
        local: null,
        inicio: l.iniciada_em.toISOString(),
        fim: l.encerrada_em.toISOString(),
      });
    } else {
      const l = await linhaEvento(ref);
      esperadas.push({
        tipo: 'evento',
        nome: l.nome,
        local: l.local,
        inicio: l.iniciado_em.toISOString(),
        fim: l.encerrado_em.toISOString(),
      });
    }
  }
  assert.deepStrictEqual(ag.historico, esperadas, 'período REAL (chegada e saída), só as chaves públicas');
  for (const item of ag.historico) assert.deepStrictEqual(Object.keys(item).sort(), CHAVES_PUBLICAS);
  assert.ok(!ag.historico.some((x) => x.nome === 'Comércio 0'), 'a 11ª mais antiga ficou de fora');
  const texto = JSON.stringify(ag);
  assert.doesNotMatch(texto, /Cancelado|motivo interno|Sigilosa|nota interna|teste_ponto/);
  assert.doesNotMatch(texto, /"(conta|contaId|percentual|motivo\w*|encerrado\w*|localPontoId|avisoEncerrar|telas?)"/);
});

// ---------- 7. Regressão do dono: a seleção do anunciante ----------
// Depende do predicado único da escolha (fixoVendavelSql em GET
// /anunciantes/me/pontos-disponiveis — a fatia BACK-1 desta estação).
test('regressão do dono: Móvel hospedado num ponto aguardando — o anunciante vê a rede como UMA posição e nunca o estabelecimento', async () => {
  const rede = await redeComTelas(1);
  const dono = await novaConta();
  const loja = await estabelecimento(dono, { prevista: '2026-11-30' });
  const semData = await estabelecimento(dono);
  const r = await postarCompromisso(
    rede.id,
    corpoConta(dono, rede.telas[0], {
      endereco_origem: 'ponto',
      ponto_id: loja.id,
      motivo: 'aguardando_instalacao',
      inicio: paredeMais(-1),
      fim: paredeMais(30 * 24),
    }),
  );
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  await iniciarNaConta(rede.id, r.json.ref);

  const cliente = await novaConta();
  await pool.query(`UPDATE anunciantes SET plano_id = 'essencial-1m' WHERE id = $1`, [cliente.id]);
  const nav = await entrar(cliente);
  const disp = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(disp.status, 200, JSON.stringify(disp.json));
  const ids = disp.json.pontos.map((p) => p.id);
  assert.strictEqual(ids.filter((id) => id === rede.id).length, 1, 'a rede é UMA posição, com a passagem que tiver');
  assert.ok(!ids.includes(loja.id), 'o estabelecimento que hospeda o Móvel não vira selecionável');
  assert.ok(!ids.includes(semData.id), 'o ponto sem data prevista também não');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM pontos WHERE anunciante_id = $1', [dono.id]);
  assert.strictEqual(rows[0].n, 2, 'a passagem não cria ponto comercial novo');
});

// ---------- 8. Regressão do dono: da alocação ao histórico ----------
test('regressão do dono: a passagem confirmada em Próximas/Agora; a instalação fixa tira o ponto de "aguardando", não encerra nada e avisa o Admin; encerrada, fica no histórico do cliente e do ponto', async () => {
  const rede = await redeComTelas(1);
  const [tela] = rede.telas;
  const dono = await novaConta({ nome: `Padaria Interna ${randomUUID().slice(0, 4)}` });
  const loja = await estabelecimento(dono, { prevista: '2026-11-30' });
  const semData = await estabelecimento(dono);
  const nav = await entrar(await novaConta());

  // 6/7. Aguardando é elegível; com e sem data, só no Admin.
  let lista = await listaAguardando();
  assert.deepStrictEqual(
    lista.filter((p) => p.pontoId === loja.id || p.pontoId === semData.id).map((p) => [p.pontoId, p.alocacao]),
    [
      [loja.id, null],
      [semData.id, null],
    ],
  );
  // [Alocar Móvel]: hospedagem na conta do dono, no ponto, motivo "aguardando
  // instalação"; começou há 1 h, a tela chega hoje.
  const c = await postarCompromisso(
    rede.id,
    corpoConta(dono, tela, {
      endereco_origem: 'ponto',
      ponto_id: loja.id,
      motivo: 'aguardando_instalacao',
      inicio: paredeMais(-1),
      fim: paredeMais(30 * 24),
    }),
  );
  assert.strictEqual(c.status, 201, JSON.stringify(c.json));
  lista = await listaAguardando();
  const daLoja = lista.find((p) => p.pontoId === loja.id);
  assert.deepStrictEqual([daLoja.alocacao.ref, daLoja.alocacao.estado], [c.json.ref, 'programada']);

  // 9/11. Confirmada (programada): em Próximas, só o público. 8/23. Nada do
  // planejamento interno: nem o ponto sem data, nem a data prevista, motivo
  // ou o nome da conta.
  let ag = await agendaPublica(nav, rede.id);
  assert.deepStrictEqual(
    [ag.agora, ag.proximos.map((x) => [x.tipo, x.nome, x.local]), ag.historico],
    [[], [['hospedagem', loja.nome, null]], []],
  );
  const semPlanejamento = (json) => {
    const texto = JSON.stringify(json);
    assert.doesNotMatch(texto, /aguardando|2026-11-30|Padaria Interna|"motivo\w*"|"avisoEncerrar"|"pontoInstalado"/);
    assert.ok(!texto.includes(semData.nome), 'o ponto sem data não aparece para o cliente');
  };
  semPlanejamento(ag);
  // 10. A tela chegou: em Agora.
  await iniciarNaConta(rede.id, c.json.ref);
  ag = await agendaPublica(nav, rede.id);
  assert.deepStrictEqual(
    [ag.agora.map((x) => [x.tipo, x.nome, x.local]), ag.proximos, ag.historico],
    [[['hospedagem', loja.nome, null]], [], []],
  );

  // 15. Instalação fixa: o ponto recebe tela própria e o Player dá o 1º sinal.
  await instalarPlayer(await adicionarTela(loja.id));
  lista = await listaAguardando();
  assert.ok(!lista.some((p) => p.pontoId === loja.id), 'instalado: sai de "aguardando instalação"');
  assert.ok(
    lista.some((p) => p.pontoId === semData.id),
    'o outro ponto continua aguardando',
  );
  // 16. Nada encerra sozinho.
  assert.strictEqual((await linhaHospedagem(c.json.ref)).estado, 'ativa');
  // 17. O Admin é avisado: na lista da rede, na ficha da rede e na do ponto.
  const aviso = (x) => [x.ref, x.estado, x.localPontoId, x.pontoInstalado, x.avisoEncerrar];
  const esperado = [c.json.ref, 'em_curso', loja.id, true, true];
  assert.deepStrictEqual(aviso((await compromissosDe(rede.id)).agora[0]), esperado);
  const ficha = await admin('GET', `/admin/pontos/${rede.id}/movel`);
  assert.deepStrictEqual(aviso(ficha.json.compromissos.agora[0]), esperado);
  assert.deepStrictEqual(aviso((await compromissosDe(loja.id)).agora[0]), esperado);
  // O cliente continua vendo a passagem em Agora, sem o aviso.
  ag = await agendaPublica(nav, rede.id);
  assert.deepStrictEqual(
    ag.agora.map((x) => x.nome),
    [loja.nome],
  );
  semPlanejamento(ag);

  // 12/14. Encerrada: histórico do cliente (período real) e do ponto — a
  // instalação fixa não apagou nada.
  assert.strictEqual((await agir(rede.id, c.json.ref, 'encerrar', {})).status, 200);
  const linha = await linhaHospedagem(c.json.ref);
  ag = await agendaPublica(nav, rede.id);
  assert.deepStrictEqual(ag.historico, [
    {
      tipo: 'hospedagem',
      nome: loja.nome,
      local: null,
      inicio: linha.iniciada_em.toISOString(),
      fim: linha.encerrada_em.toISOString(),
    },
  ]);
  assert.deepStrictEqual([ag.agora, ag.proximos], [[], []]);
  const doPonto = await compromissosDe(loja.id);
  assert.deepStrictEqual(
    doPonto.historico.map((x) => [x.ref, x.estado, x.avisoEncerrar]),
    [[c.json.ref, 'encerrado', false]],
  );

  // 13. Cancelada não aparece como próxima (nem no histórico).
  const outra = await postarCompromisso(
    rede.id,
    corpoConta(dono, tela, {
      endereco_origem: 'ponto',
      ponto_id: semData.id,
      inicio: paredeMais(5 * 24),
      fim: paredeMais(6 * 24),
    }),
  );
  assert.strictEqual(outra.status, 201, JSON.stringify(outra.json));
  assert.deepStrictEqual(
    (await agendaPublica(nav, rede.id)).proximos.map((x) => x.nome),
    [semData.nome],
  );
  assert.strictEqual((await agir(rede.id, outra.json.ref, 'cancelar', { motivo: 'remarcada' })).status, 200);
  ag = await agendaPublica(nav, rede.id);
  assert.deepStrictEqual(ag.proximos, []);
  assert.deepStrictEqual(
    ag.historico.map((x) => x.nome),
    [loja.nome],
  );
  assert.ok(!JSON.stringify(ag).includes(semData.nome));
});
