const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// MOSTRAÍ MÓVEL = REDE MÓVEL DE UMA CIDADE (migration 115). A rede é UM
// ponto (`pontos.tipo = 'movel'`) com N telas físicas; cada tela tem a sua
// agenda e o seu contexto; o anunciante escolhe a rede (1 posição); a
// parcela da rede numa hora se divide entre as telas do pool da hora, sem
// nunca passar da cota. Roda o `app` REAL (src/server.js). Cada teste cria
// as próprias redes, em cidades únicas (uma rede por cidade + UF) — os
// arquivos de teste rodam em paralelo no mesmo banco.
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-rede-movel';
const app = require('../src/server');
const alocacao = require('../src/pontos/alocacao');
const hospedagem = require('../src/pontos/hospedagem');
const dispositivosRepo = require('../src/dispositivos/repository');
const execucoesRepo = require('../src/playlist/execucoes-repository');
const gerador = require('../src/playlist/gerador');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const { parcelaNoPool, pontosDoAnunciante } = require('../src/lib/pacing');

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
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criadas.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    const hosp = 'SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = $1';
    await pool.query(`DELETE FROM saldo_hospedagem_lancamentos WHERE hospedagem_id IN (${hosp})`, [id]);
    await pool.query(`DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (${hosp})`, [id]);
    await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE ponto_id = $1', [id]);
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [id]);
    await pool.query('DELETE FROM pontos_moveis_eventos WHERE ponto_id = $1', [id]);
    await pool.query(`DELETE FROM tela_operacao WHERE dispositivo_id IN (${telas})`, [id]);
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
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  for (const id of criadas.categorias) await pool.query('DELETE FROM categorias WHERE id = $1', [id]);
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// ---------- fixtures ----------
const cidadeUnica = () => `Cidade ${randomUUID().slice(0, 8)}`;

async function criarRede(corpo = {}) {
  const r = await admin('POST', '/admin/pontos-moveis', { cidade: cidadeUnica(), uf: 'SP', ...corpo });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  return r.json;
}

// "+ Adicionar tela" (a mesma rota do ponto fixo), já com Player.
async function adicionarTela(redeId) {
  const r = await admin('POST', `/admin/pontos/${redeId}/dispositivos`, {});
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  await pool.query(
    `UPDATE dispositivos SET chave_hash = md5(random()::text) || md5(random()::text), primeiro_sinal_em = now(),
                             ultima_vez_online = now()
      WHERE id = $1`,
    [r.json.id],
  );
  return r.json.id;
}

async function redeComTelas(n) {
  const rede = await criarRede();
  const telas = [];
  for (let i = 0; i < n; i++) telas.push(await adicionarTela(rede.id));
  // Tirada do sorteio automático das contas de OUTROS testes.
  await pool.query(`UPDATE pontos SET status = 'em_operacao', escolha_bloqueada_em = now() WHERE id = $1`, [rede.id]);
  return { ...rede, telas };
}

async function novaConta({ categoriaId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, logradouro, numero, bairro, endereco, cidade, uf, cep, categoria_id)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true,
             'Rua das Flores', '10', 'Centro', 'Rua das Flores, 10', 'Matão', 'SP', '15990000', $5)
     RETURNING *`,
    [
      `Rede ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `rede-${randomUUID()}@example.com`,
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

async function contaComPlanoEPeca(pontoId) {
  const conta = await novaConta();
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

async function novaCategoria() {
  const { rows } = await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING id`, [
    `Ramo ${randomUUID().slice(0, 8)}`,
  ]);
  criadas.categorias.push(rows[0].id);
  return rows[0].id;
}

const paredeMais = (horas) => alocacao.parede(new Date(Date.now() + horas * 3_600_000));
const horaCheia = (deslocamento = 0) => {
  const h = new Date();
  h.setMinutes(0, 0, 0);
  return new Date(h.getTime() + deslocamento * 3_600_000);
};

function corpoDeEvento(telas, extra = {}) {
  return {
    nome: 'Feira de Negócios',
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

// Evento em andamento com estas telas. `desdeAntesDaHora`: iniciado antes da
// hora cheia (entra no pool desta hora); senão, iniciado agora (meio da hora).
async function eventoEmAndamento(redeId, telas, { desdeAntesDaHora = true, ...extra } = {}) {
  const id = await cadastrarEvento(redeId, telas, { inicio: paredeMais(-2), fim: paredeMais(24), ...extra });
  const r = await admin('POST', `/admin/pontos/${redeId}/eventos/${id}/iniciar`);
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  if (desdeAntesDaHora) {
    await pool.query(`UPDATE pontos_moveis_eventos SET iniciado_em = $2 WHERE id = $1`, [
      id,
      new Date(horaCheia().getTime() - 60_000),
    ]);
  }
  return id;
}

async function confirmarHospedagem(redeId, telaId, conta, extra = {}) {
  const percentual = await hospedagem.percentualAtual();
  return admin('POST', `/admin/pontos/${redeId}/hospedagens`, {
    dispositivo_id: telaId,
    conta_id: conta.id,
    local: 'Padaria Central',
    endereco: 'Rua A, 1',
    inicio: paredeMais(-1),
    fim: paredeMais(24),
    percentual_esperado: percentual,
    ...extra,
  });
}

const ENTREGA = { itens: { tela: true, suporte: true }, condicao: 'ok' };
const ficha = async (redeId) => (await admin('GET', `/admin/pontos/${redeId}/movel`)).json;

// ---------- a rede ----------
test('rede: cidade e UF obrigatórias, nome padrão "Mostraí Móvel — {Cidade}", nasce SEM tela, uma por cidade', async () => {
  assert.strictEqual((await admin('POST', '/admin/pontos-moveis', { uf: 'SP' })).status, 400, 'sem cidade');
  assert.strictEqual((await admin('POST', '/admin/pontos-moveis', { cidade: cidadeUnica() })).status, 400, 'sem UF');
  assert.strictEqual(
    (await admin('POST', '/admin/pontos-moveis', { cidade: cidadeUnica(), uf: 'XX' })).status,
    400,
    'UF inválida',
  );
  const cidade = cidadeUnica();
  const rede = await criarRede({ cidade });
  assert.strictEqual(rede.nome, `Mostraí Móvel — ${cidade}`);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM dispositivos WHERE ponto_id = $1', [rede.id]);
  assert.strictEqual(rows[0].n, 0, 'nenhuma Tela 1 automática');
  const dup = await admin('POST', '/admin/pontos-moveis', { cidade: ` ${cidade.toUpperCase()} `, uf: 'SP' });
  assert.strictEqual(dup.status, 409, 'mesma cidade + UF (sem diferença de caixa/espaço)');
  assert.match(dup.json.erro, /Já existe uma rede móvel/);
  const outraUf = await criarRede({ cidade, uf: 'MG', nome: 'Rede de teste' });
  assert.strictEqual(outraUf.nome, 'Rede de teste', 'mesma cidade em outra UF é outra rede; nome informado vale');
  // O banco também barra (índice único).
  await assert.rejects(
    pool.query(
      `INSERT INTO pontos (nome, cidade, uf, segmento, responsavel_nome, responsavel_contato, tipo, movel_numero)
       VALUES ('x', $1, 'SP', 'outro', 'M', '', 'movel', nextval('pontos_movel_numero_seq'))`,
      [cidade],
    ),
    (e) => e.code === '23505',
  );
});

test('rede: várias telas; Player/credencial da primeira continuam ao adicionar outra; custo/amortização não existem', async () => {
  const rede = await criarRede();
  const a = await adicionarTela(rede.id);
  const { rows: antes } = await pool.query('SELECT chave_hash FROM dispositivos WHERE id = $1', [a]);
  const b = await adicionarTela(rede.id);
  const c = await adicionarTela(rede.id);
  const { rows: depois } = await pool.query('SELECT chave_hash FROM dispositivos WHERE id = $1', [a]);
  assert.strictEqual(depois[0].chave_hash, antes[0].chave_hash, 'a credencial da tela A não muda');
  const f = await ficha(rede.id);
  assert.deepStrictEqual(
    f.telas.map((t) => t.id),
    [a, b, c],
  );
  assert.deepStrictEqual(f.resumo, { telas: 3, emOperacao: 0, comCompromissoFuturo: 0, disponiveis: 3 });
  assert.strictEqual(f.disponivelParaAnunciantes, true);
  const tela = (await admin('GET', `/admin/dispositivos/${a}`)).json;
  assert.strictEqual(tela.custoEquipamento, undefined);
  assert.strictEqual(tela.mesesAmortizacao, undefined);
  const patch = await admin('PATCH', `/admin/dispositivos/${a}`, { custo_equipamento: 900, meses_amortizacao: 24 });
  assert.strictEqual(patch.status, 200, 'campos antigos são ignorados');
  const { rows: colunas } = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'dispositivos' AND column_name IN ('custo_equipamento', 'meses_amortizacao')`,
  );
  assert.strictEqual(colunas.length, 0, 'as colunas saíram');
  const resumo = (await admin('GET', '/admin/resumo')).json;
  assert.strictEqual(resumo.financeiro.amortizacaoMensal, undefined);
});

// ---------- agenda por tela ----------
test('agenda: telas diferentes da rede ao mesmo tempo (evento e hospedagem); a MESMA tela nunca', async () => {
  const rede = await redeComTelas(3);
  const [a, b, c] = rede.telas;
  const conta = await novaConta();
  const inicio = paredeMais(48);
  const fim = paredeMais(72);
  const h = await confirmarHospedagem(rede.id, a, conta, { inicio, fim });
  assert.strictEqual(h.status, 201, JSON.stringify(h.json));
  // Evento com B e C no MESMO período: entra.
  const ev = await cadastrarEvento(rede.id, [b, c], { inicio, fim });
  assert.ok(ev);
  // Evento com A no período da hospedagem: 409 com o motivo.
  const conflito = await admin('POST', `/admin/pontos/${rede.id}/eventos`, corpoDeEvento([a], { inicio, fim }));
  assert.strictEqual(conflito.status, 409);
  assert.match(conflito.json.erro, /já está hospedada/);
  // Hospedagem em B (ocupada pelo evento): 409.
  const outra = await confirmarHospedagem(rede.id, b, await novaConta(), { inicio, fim });
  assert.strictEqual(outra.status, 409);
  assert.match(outra.json.erro, /no evento/);
  // Tela de outra rede: 400.
  const outraRede = await redeComTelas(1);
  const estranha = await admin('POST', `/admin/pontos/${rede.id}/eventos`, corpoDeEvento([outraRede.telas[0]]));
  assert.strictEqual(estranha.status, 400);
  // Sem tela: 400.
  assert.strictEqual((await admin('POST', `/admin/pontos/${rede.id}/eventos`, corpoDeEvento([]))).status, 400);
  // O banco é a última linha: inserir B direto num evento sobreposto falha.
  const { rows: e2 } = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, local, data_inicio, data_fim, inicio, fim)
     VALUES ($1, 'x', 'y', current_date, current_date, $2, $3) RETURNING id`,
    [rede.id, new Date(Date.now() + 50 * 3_600_000), new Date(Date.now() + 60 * 3_600_000)],
  );
  await assert.rejects(
    pool.query('INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id) VALUES ($1, $2)', [e2[0].id, b]),
    (e) => e.code === '23P01',
  );
  await pool.query('DELETE FROM pontos_moveis_eventos WHERE id = $1', [e2[0].id]);
  // Disponibilidade das telas no período.
  const livres = await admin(
    'GET',
    `/admin/pontos/${rede.id}/telas-livres?inicio=${encodeURIComponent(inicio)}&fim=${encodeURIComponent(fim)}`,
  );
  assert.strictEqual(livres.status, 200, JSON.stringify(livres.json));
  assert.deepStrictEqual(
    livres.json.telas.map((t) => t.livre),
    [false, false, false],
  );
  const f = await ficha(rede.id);
  assert.strictEqual(f.agenda.length, 2, 'agenda consolidada: a hospedagem e o evento');
  assert.deepStrictEqual(
    f.agenda.find((x) => x.tipo === 'evento').telas.map((t) => t.id),
    [b, c],
  );
  assert.strictEqual(f.resumo.comCompromissoFuturo, 3);
});

// ---------- contexto por tela ----------
test('contexto por tela: evento numa, hospedagem noutra, a terceira sem alocação (institucional)', async () => {
  const rede = await redeComTelas(3);
  const [a, b, c] = rede.telas;
  const ramoEvento = await novaCategoria();
  const ramoAnfitriao = await novaCategoria();
  const anfitriao = await novaConta({ categoriaId: ramoAnfitriao });
  await eventoEmAndamento(rede.id, [a], { categoria_id: ramoEvento });
  const h = await confirmarHospedagem(rede.id, b, anfitriao);
  assert.strictEqual(h.status, 201, JSON.stringify(h.json));
  const semTermo = await admin('POST', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/iniciar`, {});
  assert.strictEqual(semTermo.status, 409, 'termo físico pendente');
  assert.match(semTermo.json.erro, /termo físico/);
  const termo = await admin('PUT', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/termo-fisico`, {
    assinado: true,
    observacao: 'assinado na entrega',
  });
  assert.strictEqual(termo.status, 200, JSON.stringify(termo.json));
  assert.strictEqual(termo.json.termo.assinado, true);
  const semEntrega = await admin('POST', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/iniciar`, {});
  assert.strictEqual(semEntrega.status, 400, 'entrega obrigatória');
  const ok = await admin('POST', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/iniciar`, { entrega: ENTREGA });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));

  const [da, db, dc] = await Promise.all([a, b, c].map((id) => dispositivosRepo.buscarComPonto(id)));
  assert.strictEqual(da.movel_alocado, true);
  assert.strictEqual(da.categoria_id, ramoEvento, 'tela A: categoria do evento');
  assert.strictEqual(da.casa_conta_id, null, 'evento não tem casa');
  assert.strictEqual(da.ponto_horario_semanal, null, 'operar durante todo o período');
  assert.strictEqual(db.movel_alocado, true);
  assert.strictEqual(db.categoria_id, ramoAnfitriao, 'tela B: categoria do anfitrião');
  assert.strictEqual(db.casa_conta_id, anfitriao.id);
  assert.strictEqual(db.anfitria_conta_id, anfitriao.id);
  assert.strictEqual(dc.movel_alocado, false, 'tela C sem alocação');
  assert.strictEqual(dc.categoria_id, null);
  const envelope = await gerador.gerarPlaylistDaHora(dc, new Date());
  assert.ok(envelope.itens.every((i) => i.institucional === true && i.contabiliza === false));

  const f = await ficha(rede.id);
  assert.deepStrictEqual(f.resumo, { telas: 3, emOperacao: 2, comCompromissoFuturo: 0, disponiveis: 1 });
  assert.strictEqual(f.telas.find((t) => t.id === a).alocacao.tipo, 'evento');
  assert.strictEqual(f.telas.find((t) => t.id === b).alocacao.tipo, 'hospedagem');
  assert.strictEqual(f.telas.find((t) => t.id === c).alocacao, null);

  // "Onde estamos": as alocações reais, nunca um pino da rede.
  const publicos = (await navegador()('GET', '/pontos')).json.filter((p) => p.id === rede.id);
  assert.deepStrictEqual(publicos.map((p) => p.local_atual).sort(), ['Padaria Central', 'Parque de Exposições']);

  // Encerrar a hospedagem de B não mexe no evento de A.
  const fim = await admin('POST', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/encerrar`, {});
  assert.strictEqual(fim.status, 200, JSON.stringify(fim.json));
  assert.strictEqual((await dispositivosRepo.buscarComPonto(b)).movel_alocado, false);
  assert.strictEqual((await dispositivosRepo.buscarComPonto(a)).movel_alocado, true);
});

// ---------- hospedagem ----------
test('hospedagem: o benefício vem só do tempo da TELA hospedada (as outras telas da rede não somam)', async () => {
  const rede = await redeComTelas(2);
  const [a, b] = rede.telas;
  const conta = await novaConta();
  const h = await confirmarHospedagem(rede.id, a, conta, { inicio: paredeMais(-3) });
  assert.strictEqual(h.status, 201, JSON.stringify(h.json));
  await admin('PUT', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/termo-fisico`, { assinado: true });
  const ini = await admin('POST', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/iniciar`, { entrega: ENTREGA });
  assert.strictEqual(ini.status, 200, JSON.stringify(ini.json));
  await pool.query(`UPDATE pontos_moveis_hospedagens SET iniciada_em = now() - interval '2 hours' WHERE id = $1`, [
    h.json.id,
  ]);
  for (const tela of [a, b]) {
    await pool.query(
      `INSERT INTO tela_operacao (dispositivo_id, ponto_id, origem, inicio, fim)
       VALUES ($1, $2, 'heartbeat', now() - interval '90 minutes', now() - interval '30 minutes')`,
      [tela, rede.id],
    );
  }
  const fim = await admin('POST', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/encerrar`, {});
  assert.strictEqual(fim.status, 200, JSON.stringify(fim.json));
  const { rows } = await pool.query(
    'SELECT tempo_operacional_segundos, beneficio_segundos, percentual FROM pontos_moveis_hospedagens WHERE id = $1',
    [h.json.id],
  );
  assert.strictEqual(Number(rows[0].tempo_operacional_segundos), 3600, 'só a hora da tela A');
  assert.strictEqual(Number(rows[0].beneficio_segundos), hospedagem.beneficioDe(3600, rows[0].percentual));
  // Termo não muda depois de encerrada; desmarcar na ativa é recusado (testado aqui pela encerrada).
  const depois = await admin('PUT', `/admin/pontos/${rede.id}/hospedagens/${h.json.id}/termo-fisico`, {
    assinado: false,
  });
  assert.strictEqual(depois.status, 409);
  // Termo eletrônico saiu.
  assert.strictEqual((await admin('GET', '/admin/hospedagem/termos')).status, 410);
  const anfitriao = await entrar(conta);
  assert.strictEqual((await anfitriao('GET', `/anunciantes/me/hospedagens/${h.json.id}/termo`)).status, 410);
  const painel = await anfitriao('GET', '/anunciantes/me/hospedagem');
  assert.strictEqual(painel.json.hospedagens[0].termoAssinado, true);
  const { rows: tabelas } = await pool.query(
    `SELECT to_regclass('hospedagem_aceites') AS a, to_regclass('hospedagem_termos') AS t`,
  );
  assert.deepStrictEqual(tabelas[0], { a: null, t: null });
});

// ---------- evento ----------
test('evento: uma ou várias telas; operar todo o período por padrão; público só informativo; POP guarda o evento', async () => {
  const rede = await redeComTelas(3);
  const [a, b, c] = rede.telas;
  const semEndereco = await admin('POST', `/admin/pontos/${rede.id}/eventos`, corpoDeEvento([a], { endereco: '' }));
  assert.strictEqual(semEndereco.status, 400, 'endereço obrigatório');
  const semOrganizacao = await cadastrarEvento(rede.id, [a], { organizacao: '' });
  assert.ok(semOrganizacao, 'organização opcional');
  const horarioProprio = await cadastrarEvento(rede.id, [b], {
    inicio: paredeMais(30 * 24),
    fim: paredeMais(31 * 24),
    horario_operacao: { seg: { abre: '08:00', fecha: '18:00' }, feriados: { abre: '10:00', fecha: '14:00' } },
  });
  const f = await ficha(rede.id);
  assert.strictEqual(f.eventos.find((e) => e.id === semOrganizacao).horario, null, 'todo o período');
  assert.ok(f.eventos.find((e) => e.id === horarioProprio).horario, 'horário personalizado');

  const ev = await eventoEmAndamento(rede.id, [b, c], { publico_estimado: 5000, inicio: paredeMais(-1) });
  for (const tela of [b, c]) assert.strictEqual((await dispositivosRepo.buscarComPonto(tela)).movel_alocado, true);
  assert.strictEqual((await dispositivosRepo.buscarComPonto(a)).movel_alocado, false);
  // O POP da tela B durante o evento guarda o evento; o da tela A, nenhum.
  const conta = await contaComPlanoEPeca(rede.id);
  const hora = horaCheia();
  for (const [tela, esperado] of [
    [b, ev],
    [a, null],
  ]) {
    // A hora programada para a conta (senão o comprovante não contabiliza).
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas) VALUES ($1, $2, $3, 3)`,
      [conta.id, tela, hora],
    );
    await pool.query(
      `INSERT INTO playlist_hora_congelada (dispositivo_id, janela_hora, base, extras) VALUES ($1, $2, $3::jsonb, '[]'::jsonb)`,
      [tela, hora, JSON.stringify([{ id: conta.id }])],
    );
    const janelaId = `${tela}|${hora.toISOString()}`;
    const execucaoId = randomUUID();
    await execucoesRepo.confirmarComDedup(
      tela,
      {
        execucaoId,
        janelaId,
        itemProgramacaoId: `${janelaId}|0|${conta.id}`,
        criativoId: '1',
        iniciadoEm: new Date().toISOString(),
        terminadoEm: new Date().toISOString(),
      },
      new Date(),
    );
    const { rows } = await pool.query('SELECT status, evento_id FROM execucoes_confirmadas WHERE execucao_id = $1', [
      execucaoId,
    ]);
    assert.strictEqual(rows[0].status, 'contabilizado');
    assert.strictEqual(rows[0].evento_id === null ? null : Number(rows[0].evento_id), esperado);
  }
  const enc = await admin('POST', `/admin/pontos/${rede.id}/eventos/${ev}/encerrar`);
  assert.strictEqual(enc.status, 200);
  for (const tela of [b, c]) assert.strictEqual((await dispositivosRepo.buscarComPonto(tela)).movel_alocado, false);
});

// ---------- cobertura: 1 posição ----------
test('cobertura: a rede é UMA posição — com 4 telas aparece uma vez; sem tela no pool sai e volta sozinha', async () => {
  const rede = await redeComTelas(4);
  const hora = horaCheia();
  let ids = await gerador.pontosEmOperacao(hora);
  assert.ok(!ids.includes(rede.id), '0 tela alocada: a rede não está no ar nesta hora');
  // Escolheu SÓ a rede (plano de 1 ponto) com 0 tela: a distribuição
  // automática continua nos pontos no ar.
  const fatia = pontosDoAnunciante({ id: 1, pontosIncluidos: 1, escolhidos: [rede.id] }, ids, []);
  assert.ok(!fatia.includes(rede.id));
  assert.strictEqual(fatia.length, Math.min(1, ids.length));
  await eventoEmAndamento(rede.id, rede.telas);
  ids = await gerador.pontosEmOperacao(hora);
  assert.strictEqual(ids.filter((id) => id === rede.id).length, 1, '4 telas, a rede conta uma vez');
  assert.deepStrictEqual(
    pontosDoAnunciante({ id: 1, pontosIncluidos: 1, escolhidos: [rede.id] }, ids, []),
    [rede.id],
    'volta sozinha quando há tela',
  );
});

test('cobertura: o anunciante vê a rede com 0 tela em operação e a escolhe (1 posição); recarregar mantém', async () => {
  const rede = await redeComTelas(4);
  // Sem a trava de escolha que `redeComTelas` põe (0 tela no ar: nenhuma
  // conta de outro teste cai aqui pelo sorteio).
  await pool.query('UPDATE pontos SET escolha_bloqueada_em = NULL WHERE id = $1', [rede.id]);
  const conta = await novaConta();
  await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m' });
  const nav = await entrar(conta);
  const lista = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.strictEqual(lista.status, 200, JSON.stringify(lista.json));
  const card = lista.json.pontos.find((p) => p.id === rede.id);
  assert.ok(card, 'a rede aparece sempre');
  assert.strictEqual(card.tipo, 'movel');
  assert.strictEqual(card.inventario, false);
  assert.strictEqual(card.movel.telas, 4);
  assert.strictEqual(card.movel.emOperacao, 0);
  const escolha = await nav('PUT', '/anunciantes/me/pontos', { pontos: [rede.id] });
  assert.strictEqual(escolha.status, 200, JSON.stringify(escolha.json));
  const depois = await nav('GET', '/anunciantes/me/pontos-disponiveis');
  assert.deepStrictEqual(depois.json.escolhidos, [rede.id], 'uma posição, mantida ao recarregar');
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM anunciantes_pontos WHERE anunciante_id = $1', [
    conta.id,
  ]);
  assert.strictEqual(rows[0].n, 1);
});

test('parcelaNoPool: divisão inteira exata — a soma das telas é sempre a cota, nunca mais', () => {
  for (const n of [0, 1, 2, 3, 7, 10, 13]) {
    for (const k of [1, 2, 3, 4]) {
      const partes = Array.from({ length: k }, (_, i) => parcelaNoPool(n, k, i));
      assert.strictEqual(
        partes.reduce((t, x) => t + x, 0),
        n,
        `n=${n} k=${k}`,
      );
      assert.ok(Math.max(...partes) - Math.min(...partes) <= 1);
    }
  }
  assert.strictEqual(parcelaNoPool(5, 2, 2), 0, 'fora do pool não recebe');
  assert.strictEqual(parcelaNoPool(5, 2, -1), 0);
});

test('scheduler: entrada no meio da hora espera a próxima; duas telas no pool dividem a MESMA cota', async () => {
  const rede = await redeComTelas(2);
  const [a, b] = rede.telas;
  const conta = await contaComPlanoEPeca(rede.id);
  // A alocada antes da hora cheia (no pool desta hora); B entra AGORA.
  await eventoEmAndamento(rede.id, [a]);
  await eventoEmAndamento(rede.id, [b], { desdeAntesDaHora: false });
  const H = horaCheia();
  const H1 = horaCheia(1);
  const obrigacao = async (tela, hora) => {
    const { rows } = await pool.query(
      `SELECT segundos_obrigacao FROM exibicoes_contador
        WHERE dispositivo_id = $1 AND anunciante_id = $2 AND janela_hora = $3`,
      [tela, conta.id, hora],
    );
    return rows[0] ? Number(rows[0].segundos_obrigacao) : 0;
  };
  const [da, db] = await Promise.all([a, b].map((id) => dispositivosRepo.buscarComPonto(id)));
  // Hora H: só A está no pool — leva a cota inteira; B (entrou no meio) só
  // institucional, sem gravar nada.
  await gerador.gerarPlaylistDaHora(da, H);
  const envB = await gerador.gerarPlaylistDaHora(db, H);
  assert.ok(
    envB.itens.every((i) => i.institucional === true),
    'B espera a próxima hora',
  );
  const cota = await obrigacao(a, H);
  assert.ok(cota > 0, 'a rede tem obrigação nesta hora');
  assert.strictEqual(await obrigacao(b, H), 0);
  // Hora H+1: A e B no pool — dividem a MESMA cota (nunca 2 posições).
  await gerador.gerarPlaylistDaHora(da, H1);
  await gerador.gerarPlaylistDaHora(db, H1);
  const [oa, ob] = [await obrigacao(a, H1), await obrigacao(b, H1)];
  assert.ok(oa > 0 && ob > 0, `as duas telas recebem (${oa}, ${ob})`);
  assert.strictEqual(oa + ob, cota, 'a soma das telas é a cota da rede');
  // A sai no meio da hora: a geração seguinte dela é só institucional e B
  // não ganha a parte de A (nunca passa da cota).
  const { rows: evA } = await pool.query(
    `SELECT e.id FROM pontos_moveis_eventos e JOIN pontos_moveis_evento_telas et ON et.evento_id = e.id
      WHERE et.dispositivo_id = $1 AND e.estado = 'em_andamento'`,
    [a],
  );
  assert.strictEqual((await admin('POST', `/admin/pontos/${rede.id}/eventos/${evA[0].id}/encerrar`)).status, 200);
  const daDepois = await dispositivosRepo.buscarComPonto(a);
  const envA = await gerador.gerarPlaylistDaHora(daDepois, H);
  assert.ok(envA.itens.every((i) => i.institucional === true));
  await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(b), H1);
  assert.strictEqual(await obrigacao(b, H1), ob, 'B continua com a parcela dela');
});

test('scheduler: o pool da hora fica congelado — tela que muda de status no meio da hora não dá 1,5× a cota', async () => {
  // Revisão do PR #118 (Codex P1): A e B no pool; B gera primeiro (metade);
  // B vai para reparo; A gera em seguida e NÃO pode levar a cota inteira.
  const rede = await redeComTelas(2);
  const [a, b] = rede.telas;
  const conta = await contaComPlanoEPeca(rede.id);
  await eventoEmAndamento(rede.id, [a, b]);
  const H = horaCheia();
  const obrigacao = async (tela) => {
    const { rows } = await pool.query(
      `SELECT segundos_obrigacao FROM exibicoes_contador
        WHERE dispositivo_id = $1 AND anunciante_id = $2 AND janela_hora = $3`,
      [tela, conta.id, H],
    );
    return rows[0] ? Number(rows[0].segundos_obrigacao) : 0;
  };
  await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(b), H);
  const ob = await obrigacao(b);
  assert.ok(ob > 0, 'B recebeu a parcela dela');
  await pool.query(`UPDATE dispositivos SET status = 'reparo' WHERE id = $1`, [b]);
  await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(a), H);
  const oa = await obrigacao(a);
  assert.ok(oa > 0 && Math.abs(oa - ob) <= 1, `A fica com a metade dela, não com a cota inteira (${oa}, ${ob})`);
  const { rows } = await pool.query('SELECT telas FROM rede_movel_pool_hora WHERE ponto_id = $1 AND hora = $2', [
    rede.id,
    H,
  ]);
  assert.deepStrictEqual(
    rows[0].telas,
    [a, b].sort((x, y) => x - y),
    'pool congelado na primeira geração da hora',
  );
  await pool.query(`UPDATE dispositivos SET status = 'ativo' WHERE id = $1`, [b]);
});
