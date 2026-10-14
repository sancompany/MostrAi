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
//     quem cancelou/encerrou).
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

async function compromissosDe(pontoId) {
  const r = await admin('GET', `/admin/pontos/${pontoId}/compromissos`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return r.json;
}

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
  // Pela rota antiga (chega direto): o servidor confere de novo.
  for (const id of [alheio.id, arquivado.id, rede.id, 'abc', 999999999]) {
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
  const recusada = await periodo({ local_ponto_id: alheio.id });
  assert.strictEqual(recusada.status, 400, JSON.stringify(recusada.json));
  assert.deepStrictEqual(recusada.json, PONTO_DE_OUTRA_CONTA);
  assert.strictEqual((await linhaHospedagem(r.json.ref)).local_ponto_id, loja.id, 'recusada não muda');
  assert.strictEqual((await periodo({ local_ponto_id: null })).status, 200);
  assert.strictEqual((await linhaHospedagem(r.json.ref)).local_ponto_id, null);

  // O Admin vê o vínculo no formato unificado.
  assert.strictEqual(await editar({ endereco_origem: 'ponto', ponto_id: loja.id }), loja.id);
  const lista = await compromissosDe(rede.id);
  const c = lista.proximos.find((x) => x.ref === r.json.ref);
  assert.deepStrictEqual([c.localPontoId, c.pontoInstalado, c.avisoEncerrar], [loja.id, false, false]);
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
