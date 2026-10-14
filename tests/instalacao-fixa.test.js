require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const anunciantesRepo = require('../src/anunciantes/repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const movel = require('../src/pontos/movel');
const credencial = require('../src/player/credencial');
const { formatarCodigoTela } = require('../src/lib/codigo-tela');
const { instalarPlayer } = require('./apoio-player');

// PONTO FIXO VENDÁVEL × AGUARDANDO INSTALAÇÃO (ADR-047, 14/10/2026). Aprovar
// o estabelecimento não é ter inventário no lugar: o fixo só entra na escolha
// do anunciante, no site e na contagem comercial depois que alguma tela dele
// deu o 1º sinal real do Player (D1). O instalado que depois ficou offline,
// em reparo ou com o Player revogado continua vendável. O Admin recebe a
// instalação e a disponibilidade já decididas, a data prevista e a passagem
// do Mostraí Móvel vinculada ao ponto. A regra é uma só
// (src/pontos/repository.js: fixoVendavelSql / aguardandoInstalacaoSql).
//
// Os 7 casos de cada ponto saem pelos caminhos reais (tela criada pelo
// repositório, Player instalado pela troca do código, revogado, tela em
// reparo ou inativa) — o status é o que o sincronizar decide, nunca forçado.
// Os arquivos de teste rodam em paralelo no mesmo banco: toda asserção sobre
// listas globais olha só os ids criados aqui.

process.env.SESSION_SECRET ||= 'teste-instalacao-fixa';

let app;
test.before(async () => {
  const a = express();
  a.use(express.json());
  a.use(session({ secret: 'teste-instalacao-fixa', resave: false, saveUninitialized: false }));
  a.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    // As rotas /admin deste roteador são montadas atrás da sessão do Admin
    // em server.js; aqui o roteador vem direto (como pontos-exclusao.test.js).
    req.session.adminUsuario = 'teste';
    proximo();
  });
  a.use(require('../src/anunciantes/routes').router);
  a.use(require('../src/pontos/routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = a.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, { conta, corpo } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (conta) headers['x-conta'] = String(conta);
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { status: r.status, json, texto };
  };
  app = { chamar, fechar: () => new Promise((r) => server.close(r)) };
});

// ---------------------------------------------------------------------------
// Dados de teste (limpos no fim)
// ---------------------------------------------------------------------------
const criados = { contas: [], pontos: [], redes: [] };

async function novaConta({ plano = 'essencial-1m' } = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Instalação ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `instalacao-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criados.contas.push(conta.id);
  if (plano) await pool.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [conta.id, plano]);
  return conta.id;
}

async function pontoFixo({ dono = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '1', $2, 'a_instalar') RETURNING id`,
    [`Instalação ${randomUUID().slice(0, 8)}`, dono],
  );
  criados.pontos.push(rows[0].id);
  return rows[0].id;
}

// Os 7 casos da prova do predicado (commit a474994), pelos caminhos reais:
//   A nunca instalado, sem tela             → aguardando
//   B tela cadastrada, sem Player           → aguardando
//   C tela em reparo que nunca operou       → aguardando (em_reparo)
//   D Player revogado depois de operar      → vendável (a_instalar)
//   E em operação                           → vendável
//   F tela em reparo depois de operar       → vendável (em_reparo)
//   G inativo (telas desligadas pelo Admin) → nem um nem outro
async function montar(caso, { dono = null } = {}) {
  const id = await pontoFixo({ dono });
  if (caso === 'A') return id;
  const tela = await dispositivosRepo.criar(id, caso === 'C' ? { status: 'reparo' } : {});
  if (caso === 'B' || caso === 'C') return id;
  await instalarPlayer(tela.id);
  if (caso === 'D') await credencial.revogar(tela.id);
  if (caso === 'F') await dispositivosRepo.atualizar(tela.id, { status: 'reparo' });
  if (caso === 'G') await dispositivosRepo.atualizar(tela.id, { status: 'inativo' });
  return id;
}

// Instalado e OFFLINE: em operação, sem sinal há 3 dias. Offline é alerta,
// não estado do ponto — continua vendável.
async function instaladoOffline() {
  const id = await montar('E');
  await pool.query(`UPDATE dispositivos SET ultima_vez_online = now() - interval '3 days' WHERE ponto_id = $1`, [id]);
  return id;
}

const statusDe = async (id) => (await pool.query('SELECT status FROM pontos WHERE id = $1', [id])).rows[0].status;

async function todosOsCasos() {
  const c = {};
  for (const caso of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) c[caso] = await montar(caso);
  c.Eoff = await instaladoOffline();
  // Os status vieram do sincronizar real — o mesmo cenário da prova.
  assert.deepStrictEqual(await Promise.all(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'Eoff'].map((k) => statusDe(c[k]))), [
    'a_instalar',
    'a_instalar',
    'em_reparo',
    'a_instalar',
    'em_operacao',
    'em_reparo',
    'inativo',
    'em_operacao',
  ]);
  return c;
}

// Rede móvel de uma cidade única (uma por cidade), pelo caminho do Admin, com
// `telas` telas cadastradas.
async function novaRede({ telas = 1 } = {}) {
  const rede = await movel.criarRedeMovel({ nome: 'Mostraí Móvel', cidade: `Instalação ${randomUUID()}`, uf: 'SP' });
  criados.redes.push(rede.id);
  const ids = [];
  for (let i = 0; i < telas; i++) ids.push((await dispositivosRepo.criar(rede.id, {})).id);
  return { id: rede.id, nome: rede.nome, telas: ids };
}

// Passagem do Mostraí Móvel gravada direto no banco, já com o vínculo da
// migration 123 (local_ponto_id = o ponto fixo). A rota que grava o vínculo
// é de outra fatia; aqui importa o que a ficha do Admin e a exclusão leem.
// `de`/`ate`: horas a partir de agora.
async function passagem({ rede, tela, conta, ponto, estado = 'programada', de = 24, ate = 48 }) {
  const quando = (horas) => new Date(Date.now() + horas * 3_600_000);
  const inicio = quando(de);
  const fim = quando(ate);
  const final = {
    programada: {},
    ativa: { iniciada: inicio },
    cancelada: { cancelada: new Date() },
    encerrada: { iniciada: inicio, encerrada: fim, encerramento: 'manual', tempo: 0, beneficio: 0 },
  }[estado];
  const { rows } = await pool.query(
    `INSERT INTO pontos_moveis_hospedagens
       (ponto_id, dispositivo_id, conta_id, local_ponto_id, local, endereco, data_inicio, data_fim, percentual,
        inicio, fim, estado, motivo_alocacao, iniciada_em, encerrada_em, cancelada_em, encerramento,
        tempo_operacional_segundos, beneficio_segundos)
     VALUES ($1, $2, $3, $4, 'Loja do ponto', 'Rua X, 1',
             ($5::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date,
             ($6::timestamptz AT TIME ZONE 'America/Sao_Paulo')::date, 20,
             $5, $6, $7, 'aguardando_instalacao', $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      rede,
      tela,
      conta,
      ponto,
      inicio,
      fim,
      estado,
      final.iniciada ?? null,
      final.encerrada ?? null,
      final.cancelada ?? null,
      final.encerramento ?? null,
      final.tempo ?? null,
      final.beneficio ?? null,
    ],
  );
  return Number(rows[0].id);
}

const ERRO_EM_INSTALACAO = 'Esse ponto ainda está em instalação e ainda não pode ser escolhido.';
const ERRO_FORA_DA_REDE = 'um dos pontos escolhidos não existe na rede';

const disponiveis = async (conta) => {
  const r = await app.chamar('GET', '/anunciantes/me/pontos-disponiveis', { conta });
  assert.strictEqual(r.status, 200, r.texto);
  return r.json;
};
const idsDisponiveis = async (conta) => new Set((await disponiveis(conta)).pontos.map((p) => p.id));
const escolher = (conta, pontos) => app.chamar('PUT', '/anunciantes/me/pontos', { conta, corpo: { pontos } });
const escolhasNoBanco = async (conta) =>
  (
    await pool.query('SELECT ponto_id FROM anunciantes_pontos WHERE anunciante_id = $1 ORDER BY escolhido_em', [conta])
  ).rows.map((r) => r.ponto_id);
const idsDoSite = async () => {
  const r = await app.chamar('GET', '/pontos');
  assert.strictEqual(r.status, 200, r.texto);
  return new Set(r.json.map((p) => p.id));
};
const naFichaDoAdmin = async (ids) => {
  const r = await app.chamar('GET', '/admin/pontos');
  assert.strictEqual(r.status, 200, r.texto);
  return new Map(r.json.filter((p) => ids.includes(p.id)).map((p) => [p.id, p]));
};

test.after(async () => {
  await app.fechar();
  // Métrica anônima da criação da rede ainda gravando: espera antes de limpar.
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criados.redes) await pool.query('DELETE FROM pontos_moveis_hospedagens WHERE ponto_id = $1', [id]);
  for (const id of [...criados.pontos, ...criados.redes]) {
    await pool.query(
      `DELETE FROM eventos WHERE anunciante_id IS NULL
          AND (propriedades->>'ponto_id' = $1::int::text
               OR propriedades->>'dispositivo_id' IN (SELECT id::text FROM dispositivos WHERE ponto_id = $1::int))`,
      [id],
    );
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  }
  for (const id of criados.contas) {
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM obrigacoes_veiculacao WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

// ===========================================================================
// Escolha do anunciante e site (itens 1, 2, 3, 4 e 19 do dono)
// ===========================================================================
test('itens 1, 3 e 4: a lista de escolha só traz o fixo instalado (mesmo offline, em reparo ou revogado) e a rede', async () => {
  const conta = await novaConta();
  const c = await todosOsCasos();
  const proprio = await montar('A', { dono: conta });
  const rede = await novaRede();
  const ids = await idsDisponiveis(conta);
  for (const k of ['D', 'E', 'Eoff', 'F']) assert.ok(ids.has(c[k]), `instalado (${k}) continua escolhível`);
  assert.ok(ids.has(rede.id), 'a rede móvel aparece como hoje');
  for (const k of ['A', 'B', 'C', 'G']) assert.ok(!ids.has(c[k]), `${k} não aparece para o cliente`);
  assert.ok(!ids.has(proprio), 'o próprio ponto da conta aguardando instalação também sai');
});

test('item 2: o PUT recusa o ponto em instalação com o motivo; aceita o instalado fora do ar; mantém o 400 de limite e o 409', async () => {
  const conta = await novaConta(); // essencial: 3 pontos
  const c = await todosOsCasos();
  const proprio = await montar('A', { dono: conta });
  const rede = await novaRede();
  for (const id of [c.A, c.B, c.C, proprio]) {
    const r = await escolher(conta, [id]);
    assert.strictEqual(r.status, 400, r.texto);
    assert.deepStrictEqual(r.json, { erro: ERRO_EM_INSTALACAO });
  }
  assert.deepStrictEqual(await escolhasNoBanco(conta), [], 'nada salvo');
  // Inexistente, inativo e arquivado: o 400 de antes.
  const arquivado = await pontoFixo();
  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste' WHERE id = $1`,
    [arquivado],
  );
  for (const id of [2147483000, c.G, arquivado]) {
    const r = await escolher(conta, [id]);
    assert.strictEqual(r.status, 400, r.texto);
    assert.deepStrictEqual(r.json, { erro: ERRO_FORA_DA_REDE });
  }
  // O limite do plano continua vindo antes de tudo.
  const limite = await escolher(conta, [c.A, c.B, c.C, c.D]);
  assert.strictEqual(limite.status, 400);
  assert.match(limite.json.erro, /cobre 3 ponto\(s\) e você marcou 4/);
  // Instalado fora do ar agora (revogado, em reparo, offline): escolha válida.
  const ok = await escolher(conta, [c.D, c.F, c.Eoff]);
  assert.strictEqual(ok.status, 200, ok.texto);
  assert.deepStrictEqual(await escolhasNoBanco(conta), [c.D, c.F, c.Eoff]);
  assert.strictEqual((await escolher(conta, [rede.id])).status, 200, 'a rede como hoje');
  // O 409 de ocupação continua, e depois da validade do ponto.
  await pool.query('UPDATE pontos SET escolha_bloqueada_em = now() WHERE id = $1', [c.E]);
  const cheio = await escolher(conta, [c.E]);
  assert.strictEqual(cheio.status, 409, cheio.texto);
  assert.deepStrictEqual(cheio.json.pontosBloqueados, [c.E]);
  const misto = await escolher(conta, [c.A, c.E]);
  assert.strictEqual(misto.status, 400);
  assert.deepStrictEqual(misto.json, { erro: ERRO_EM_INSTALACAO });
});

test('item 3: o site e a contagem comercial (GET /pontos) só trazem o fixo instalado e a rede', async () => {
  const c = await todosOsCasos();
  const rede = await novaRede();
  const site = await idsDoSite();
  for (const k of ['D', 'E', 'Eoff', 'F']) assert.ok(site.has(c[k]), `instalado (${k}) aparece no site`);
  assert.ok(site.has(rede.id), 'a rede aparece como hoje');
  for (const k of ['A', 'B', 'C', 'G']) assert.ok(!site.has(c[k]), `${k} não aparece no site nem conta como ponto`);
});

test('item 19: o Móvel parado num ponto aguardando não torna o estabelecimento escolhível — a posição é a rede', async () => {
  const dono = await novaConta();
  const cliente = await novaConta();
  const ponto = await montar('A', { dono });
  const rede = await novaRede();
  await passagem({ rede: rede.id, tela: rede.telas[0], conta: dono, ponto, estado: 'ativa', de: -1, ate: 24 });
  const ids = await idsDisponiveis(cliente);
  assert.ok(ids.has(rede.id), 'a rede é a posição do plano');
  assert.ok(!ids.has(ponto), 'o estabelecimento não vira ponto selecionável');
  assert.ok(!(await idsDoSite()).has(ponto), 'nem aparece no site');
  const r = await escolher(cliente, [ponto]);
  assert.strictEqual(r.status, 400);
  assert.deepStrictEqual(r.json, { erro: ERRO_EM_INSTALACAO });
  assert.strictEqual((await escolher(cliente, [rede.id])).status, 200);
});

// ===========================================================================
// Ficha do ponto no Admin (itens 5 e 15; contrato BACK-1, 4 e 5)
// ===========================================================================
const projecao = (p) => ({
  ja_instalado: p.ja_instalado,
  aguardando_instalacao: p.aguardando_instalacao,
  disponibilidade: p.disponibilidade,
  instalacao_prevista_em: p.instalacao_prevista_em,
  alocacao_movel: p.alocacao_movel,
  movel_a_encerrar: p.movel_a_encerrar,
});
const fixoSemMovel = (ja, aguardando, disponibilidade) => ({
  ja_instalado: ja,
  aguardando_instalacao: aguardando,
  disponibilidade,
  instalacao_prevista_em: null,
  alocacao_movel: null,
  movel_a_encerrar: false,
});

test('item 5: GET /admin/pontos decide instalação e disponibilidade nos 7 casos (a rede fica de fora dos dois)', async () => {
  const c = await todosOsCasos();
  const rede = await novaRede();
  const ficha = await naFichaDoAdmin([...Object.values(c), rede.id]);
  const esperado = {
    A: fixoSemMovel(false, true, 'nao_disponivel'),
    B: fixoSemMovel(false, true, 'nao_disponivel'),
    C: fixoSemMovel(false, true, 'nao_disponivel'),
    D: fixoSemMovel(true, false, 'temporariamente_indisponivel'),
    E: fixoSemMovel(true, false, 'ativa'),
    Eoff: fixoSemMovel(true, false, 'ativa'),
    F: fixoSemMovel(true, false, 'temporariamente_indisponivel'),
    G: fixoSemMovel(true, false, 'nao_disponivel'),
  };
  for (const [k, e] of Object.entries(esperado)) assert.deepStrictEqual(projecao(ficha.get(c[k])), e, `caso ${k}`);
  assert.deepStrictEqual(projecao(ficha.get(rede.id)), {
    ja_instalado: null,
    aguardando_instalacao: false,
    disponibilidade: null,
    instalacao_prevista_em: null,
    alocacao_movel: null,
    movel_a_encerrar: false,
  });
});

test('item 15: a instalação fixa (1º sinal) tira o ponto de "aguardando" e o põe na escolha e no site', async () => {
  const conta = await novaConta();
  const ponto = await montar('A');
  assert.strictEqual((await naFichaDoAdmin([ponto])).get(ponto).aguardando_instalacao, true);
  await instalarPlayer((await dispositivosRepo.criar(ponto, {})).id);
  assert.deepStrictEqual(projecao((await naFichaDoAdmin([ponto])).get(ponto)), fixoSemMovel(true, false, 'ativa'));
  assert.ok((await idsDisponiveis(conta)).has(ponto), 'entra na escolha');
  assert.ok((await idsDoSite()).has(ponto), 'entra no site');
  assert.strictEqual((await escolher(conta, [ponto])).status, 200);
});

test('alocação do Móvel na ficha: a ativa, senão a programada mais próxima que não terminou; instalado com passagem = avisar, nunca encerrar', async () => {
  const dono = await novaConta();
  const ponto = await montar('A', { dono });
  const rede = await novaRede({ telas: 4 });
  const [t1, t2, t3, t4] = rede.telas;
  const alocacao = async () => projecao((await naFichaDoAdmin([ponto])).get(ponto));
  // Passagens que já acabaram (encerrada, cancelada) e a programada cujo fim
  // já passou (o job está tirando) não são a alocação de agora.
  await passagem({ rede: rede.id, tela: t1, conta: dono, ponto, estado: 'encerrada', de: -96, ate: -72 });
  await passagem({ rede: rede.id, tela: t1, conta: dono, ponto, estado: 'cancelada', de: 200, ate: 220 });
  await passagem({ rede: rede.id, tela: t4, conta: dono, ponto, estado: 'programada', de: -48, ate: -24 });
  assert.strictEqual((await alocacao()).alocacao_movel, null);
  await passagem({ rede: rede.id, tela: t1, conta: dono, ponto, estado: 'programada', de: 72, ate: 96 });
  const proxima = await passagem({
    rede: rede.id,
    tela: t2,
    conta: dono,
    ponto,
    estado: 'programada',
    de: 24,
    ate: 48,
  });
  let a = await alocacao();
  assert.strictEqual(a.aguardando_instalacao, true);
  assert.strictEqual(a.movel_a_encerrar, false, 'não instalado: nada a avisar');
  const { rows } = await pool.query('SELECT inicio, fim FROM pontos_moveis_hospedagens WHERE id = $1', [proxima]);
  assert.deepStrictEqual(a.alocacao_movel, {
    ref: `h${proxima}`,
    id: proxima,
    redeId: rede.id,
    rede: rede.nome,
    estado: 'programada',
    inicio: rows[0].inicio.toISOString(),
    fim: rows[0].fim.toISOString(),
    motivoAlocacao: 'aguardando_instalacao',
    tela: { id: t2, codigo: formatarCodigoTela(t2) },
  });
  const ativa = await passagem({ rede: rede.id, tela: t3, conta: dono, ponto, estado: 'ativa', de: -1, ate: 24 });
  a = await alocacao();
  assert.deepStrictEqual([a.alocacao_movel.ref, a.alocacao_movel.estado], [`h${ativa}`, 'ativa'], 'a ativa vem antes');
  // Instalação fixa concluída: o Admin é avisado; a passagem continua ativa.
  await instalarPlayer((await dispositivosRepo.criar(ponto, {})).id);
  a = await alocacao();
  assert.deepStrictEqual(
    [a.ja_instalado, a.aguardando_instalacao, a.movel_a_encerrar, a.alocacao_movel.ref],
    [true, false, true, `h${ativa}`],
  );
  const { rows: depois } = await pool.query('SELECT estado FROM pontos_moveis_hospedagens WHERE id = $1', [ativa]);
  assert.strictEqual(depois[0].estado, 'ativa', 'nada encerra sozinho');
});

test('PATCH /admin/pontos/:id: data prevista de instalação (válida, vazia → null, inválida 400) sem mexer em status nem playlist', async () => {
  const ponto = await montar('B'); // aguardando, com uma tela cadastrada
  await pool.query('UPDATE dispositivos SET playlist_desatualizada_em = NULL WHERE ponto_id = $1', [ponto]);
  const patch = (valor) => app.chamar('PATCH', `/admin/pontos/${ponto}`, { corpo: { instalacao_prevista_em: valor } });
  const noBanco = async () =>
    (await pool.query('SELECT instalacao_prevista_em AS d, status FROM pontos WHERE id = $1', [ponto])).rows[0];

  let r = await patch('2026-11-20');
  assert.strictEqual(r.status, 200, r.texto);
  assert.strictEqual(r.json.instalacao_prevista_em, '2026-11-20');
  assert.deepStrictEqual(await noBanco(), { d: '2026-11-20', status: 'a_instalar' });
  assert.strictEqual((await naFichaDoAdmin([ponto])).get(ponto).instalacao_prevista_em, '2026-11-20');
  assert.strictEqual((await patch('2028-02-29')).status, 200, 'dia 29 de ano bissexto existe');

  for (const invalida of [
    '2026-02-30',
    '2027-02-29',
    '2026-13-01',
    '20-11-2026',
    '2026-11-20T10:00',
    '2019-12-31',
    '2101-01-01',
    'amanhã',
    20261120,
  ]) {
    r = await patch(invalida);
    assert.strictEqual(r.status, 400, `${invalida}: ${r.texto}`);
    assert.deepStrictEqual(r.json, { erro: 'data prevista de instalação inválida (use AAAA-MM-DD)' });
  }
  assert.strictEqual((await noBanco()).d, '2028-02-29', 'inválida não grava nada');

  r = await patch('');
  assert.strictEqual(r.status, 200, r.texto);
  assert.strictEqual(r.json.instalacao_prevista_em, null, 'vazio = "Sem data definida"');
  await patch('2026-12-01');
  assert.strictEqual((await patch(null)).json.instalacao_prevista_em, null, 'null também limpa');

  assert.strictEqual((await noBanco()).status, 'a_instalar', 'a data não muda o status');
  assert.strictEqual((await naFichaDoAdmin([ponto])).get(ponto).aguardando_instalacao, true, 'nem a instalação');
  const { rows } = await pool.query('SELECT playlist_desatualizada_em FROM dispositivos WHERE ponto_id = $1', [ponto]);
  assert.strictEqual(rows[0].playlist_desatualizada_em, null, 'nem marca a playlist');
  // Nem o livro global de mudanças (migration 117): o gatilho de pontos não
  // olha esta coluna. Na mesma transação a marca dele fica visível.
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('UPDATE pontos SET instalacao_prevista_em = $2 WHERE id = $1', [ponto, '2027-01-15']);
    const { rows: marca } = await c.query(`SELECT current_setting('mostrai.playlist_mudou', true) AS sim`);
    assert.notStrictEqual(marca[0].sim, 'sim');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
});

// ===========================================================================
// Correção D2: escolha gravada em ponto nunca instalado (itens 2 e 22)
// ===========================================================================
// O que a conta tem de dinheiro e de entrega, linha a linha: a correção só
// pode tirar a escolha e pôr a notificação.
const TABELAS_DA_CONTA = ['assinaturas', 'cobrancas_confirmadas', 'ciclos_contratados', 'obrigacoes_veiculacao'];
async function retratoDaConta(conta) {
  const retrato = {};
  for (const t of [...TABELAS_DA_CONTA, 'creditos_ledger', 'anunciantes']) {
    const coluna = t === 'anunciantes' ? 'id' : 'anunciante_id';
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n, md5(COALESCE(string_agg(x::text, '|' ORDER BY x::text), '')) AS h
         FROM ${t} x WHERE x.${coluna} = $1`,
      [conta],
    );
    retrato[t] = rows[0];
  }
  return retrato;
}

async function contaPagante() {
  const conta = await novaConta();
  const assinatura = `teste-d2-${randomUUID()}`;
  await pool.query(
    `INSERT INTO assinaturas (id, anunciante_id, plano_id, status) VALUES ($1, $2, 'essencial-1m', 'ativa')`,
    [assinatura, conta],
  );
  const { rows: cobranca } = await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES ($1, 'essencial-1m', 99.9) RETURNING id`,
    [conta],
  );
  const { rows: ciclo } = await pool.query(
    `INSERT INTO ciclos_contratados (anunciante_id, plano_id, assinatura_id, cobranca_confirmada_id, origem, ciclo_meses,
                                     valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
     VALUES ($1, 'essencial-1m', $2, $3, 'compra', 1, 99.9, 100, 100) RETURNING id`,
    [conta, assinatura, cobranca[0].id],
  );
  await pool.query(
    `INSERT INTO obrigacoes_veiculacao (anunciante_id, tipo, chave, segundos, plano_id, ciclo_contratado_id, inicio, fim, motivo)
     VALUES ($1, 'ciclo', 'teste-d2:' || gen_random_uuid(), 3600, 'essencial-1m', $2, now(), now() + interval '30 days',
             'teste: ciclo da correção D2')`,
    [conta, ciclo[0].id],
  );
  await pool.query(
    `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, concedido_por, observacao)
     VALUES ($1, 'concessao_admin', 2, 'teste', 'teste: correção D2')`,
    [conta],
  );
  return conta;
}

// Escolha antiga, gravada quando o ponto aprovado ainda contava como vaga
// (RN-49): direto no banco, como está em produção.
async function escolhaAntiga(conta, pontos) {
  for (const ponto of pontos) {
    await pool.query(
      'INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, clock_timestamp())',
      [conta, ponto],
    );
  }
}

const parOrdenado = (a, b) => a.anunciante_id - b.anunciante_id || a.ponto_id - b.ponto_id;
const avisosLiberados = async (contas) =>
  (
    await pool.query(
      `SELECT anunciante_id, tipo, titulo, descricao, entidade_tipo, entidade_id, link FROM notificacoes
        WHERE anunciante_id = ANY($1::int[]) AND tipo = 'ESCOLHA_LIBERADA' ORDER BY anunciante_id, entidade_id`,
      [contas],
    )
  ).rows;

test('correção D2: sem --aplicar só lista; com --aplicar libera só a escolha em ponto nunca instalado, avisa a conta e não toca no dinheiro', async () => {
  const { liberarEscolhasSemInstalacao } = require('../src/pontos/repository');
  const c = await todosOsCasos();
  const rede = await novaRede();
  const x = await contaPagante(); // A (nunca instalado), D (revogado) e a rede
  const y = await contaPagante(); // B (tela sem Player), F (reparo) e E offline
  const z = await novaConta(); // o próprio ponto, aguardando instalação
  const proprio = await montar('A', { dono: z });
  await escolhaAntiga(x, [c.A, c.D, rede.id]);
  await escolhaAntiga(y, [c.B, c.F, c.Eoff]);
  await escolhaAntiga(z, [proprio]);
  const apenasPontos = [...Object.values(c), rede.id, proprio];
  const contas = [x, y, z];
  const antes = { x: await retratoDaConta(x), y: await retratoDaConta(y) };
  const liberaveis = [
    { anunciante_id: x, ponto_id: c.A },
    { anunciante_id: y, ponto_id: c.B },
    { anunciante_id: z, ponto_id: proprio },
  ].sort(parOrdenado);

  // Sem --aplicar: lista e desfaz.
  const ensaio = await liberarEscolhasSemInstalacao({ apenasPontos });
  assert.deepStrictEqual(
    { ...ensaio, escolhas: [...ensaio.escolhas].sort(parOrdenado) },
    { aplicado: false, total: 3, contas: 3, escolhas: liberaveis },
  );
  assert.doesNotMatch(JSON.stringify(ensaio), /Instalação|@/, 'só ids e contagens');
  assert.deepStrictEqual(await escolhasNoBanco(x), [c.A, c.D, rede.id], 'o ensaio não apaga nada');
  assert.deepStrictEqual(await avisosLiberados(contas), [], 'nem avisa ninguém');

  // Com --aplicar: só as três escolhas em ponto nunca instalado saem.
  const r = await liberarEscolhasSemInstalacao({ aplicar: true, apenasPontos });
  assert.deepStrictEqual([r.aplicado, r.total, r.contas], [true, 3, 3]);
  assert.deepStrictEqual(await escolhasNoBanco(x), [c.D, rede.id], 'revogado e rede ficam');
  assert.deepStrictEqual(await escolhasNoBanco(y), [c.F, c.Eoff], 'reparo e offline ficam');
  assert.deepStrictEqual(await escolhasNoBanco(z), []);
  const nomes = new Map(
    (await pool.query('SELECT id, nome FROM pontos WHERE id = ANY($1::int[])', [[c.A, c.B, proprio]])).rows.map((p) => [
      p.id,
      p.nome,
    ]),
  );
  assert.deepStrictEqual(
    await avisosLiberados(contas),
    liberaveis.map((e) => ({
      anunciante_id: e.anunciante_id,
      tipo: 'ESCOLHA_LIBERADA',
      titulo: 'Um ponto que você escolheu ainda está em instalação',
      descricao: `${nomes.get(e.ponto_id)} ainda não está instalado e deixou de ocupar uma das posições do seu plano. Você já pode escolher outro ponto; quando ele estiver no ar, poderá escolhê-lo de novo.`,
      entidade_tipo: 'ponto',
      entidade_id: e.ponto_id,
      link: '/anunciante/painel.html#painelPontos',
    })),
  );
  // Obrigação, cobrança, ciclo, assinatura, crédito e a própria conta: iguais.
  assert.deepStrictEqual(await retratoDaConta(x), antes.x);
  assert.deepStrictEqual(await retratoDaConta(y), antes.y);
  for (const t of [...TABELAS_DA_CONTA, 'creditos_ledger']) assert.strictEqual(antes.x[t].n, 1, `${t} tinha linha`);

  // Idempotente: a segunda execução não encontra nada nem avisa de novo.
  const denovo = await liberarEscolhasSemInstalacao({ aplicar: true, apenasPontos });
  assert.deepStrictEqual(denovo, { aplicado: true, total: 0, contas: 0, escolhas: [] });
  assert.strictEqual((await avisosLiberados(contas)).length, 3);

  // A posição do plano voltou: a conta escolhe um ponto instalado no lugar.
  const novo = await montar('E');
  assert.deepStrictEqual((await disponiveis(x)).escolhidos, [c.D, rede.id]);
  const put = await escolher(x, [c.D, rede.id, novo]);
  assert.strictEqual(put.status, 200, put.texto);
  assert.deepStrictEqual(await escolhasNoBanco(x), [c.D, rede.id, novo]);
});

test('script da correção D2: sem --aplicar não grava e imprime só ids; argumento desconhecido sai com 2', async () => {
  const { execFile } = require('node:child_process');
  const path = require('node:path');
  const rodar = (args) =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [path.join(__dirname, '..', 'scripts', 'liberar-escolhas-sem-instalacao.js'), ...args],
        { cwd: path.join(__dirname, '..'), env: process.env },
        (err, stdout, stderr) => resolve({ codigo: err ? err.code : 0, stdout, stderr }),
      );
    });
  const conta = await novaConta();
  const ponto = await montar('A');
  await escolhaAntiga(conta, [ponto]);

  const ensaio = await rodar([]);
  assert.strictEqual(ensaio.codigo, 0, ensaio.stderr);
  const saida = JSON.parse(ensaio.stdout);
  assert.strictEqual(saida.aplicado, false);
  assert.ok(
    saida.escolhas.some((e) => e.anunciante_id === conta && e.ponto_id === ponto),
    'lista a escolha em ponto nunca instalado',
  );
  assert.doesNotMatch(ensaio.stdout, /Instalação|@/, 'nenhum nome nem e-mail na saída');
  assert.deepStrictEqual(await escolhasNoBanco(conta), [ponto], 'sem --aplicar nada sai');
  assert.deepStrictEqual(await avisosLiberados([conta]), []);

  const errado = await rodar(['--aplica']);
  assert.strictEqual(errado.codigo, 2);
  assert.strictEqual(errado.stdout, '');
  assert.deepStrictEqual(await escolhasNoBanco(conta), [ponto]);
});
