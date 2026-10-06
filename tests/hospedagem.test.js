const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// HOSPEDAGEM TEMPORÁRIA DE UMA TELA DA REDE MÓVEL — saldo de hospedagem em
// horas e o ciclo de vida do equipamento (migrations 113 a 115;
// src/pontos/hospedagem.js, src/pontos/hospedagem-equipamento.js,
// src/pontos/agenda.js, src/player/operacao.js, a camada T3b do gerador).
// Desde a 115 o ponto móvel é a REDE MÓVEL de uma cidade (cidade + UF, N
// telas) e a hospedagem é de UMA tela (`dispositivo_id`): a agenda, o
// contexto e o tempo válido são DESSA tela. O termo é FÍSICO (o Admin marca
// "assinado"; o aceite eletrônico saiu) e iniciar exige ele + a entrega.
// O que é só da rede (várias telas, pool da hora, tempo só da tela
// hospedada) mora em tests/rede-movel.test.js.
// Os números (5–67) seguem os grupos do pedido do dono: Origem 5–8,
// Hospedagem 9–19, Benefício 20–30, Operação 31–37, Utilização 38–46,
// Concorrência 47–52, Site 53–59, Painel 60–67; e os E2E §78, §79 e §80.
// Roda o `app` REAL. Cada teste cria as próprias contas e redes, em cidades
// únicas (os arquivos rodam em paralelo no mesmo banco).
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-hospedagem';
const app = require('../src/server');
const hospedagem = require('../src/pontos/hospedagem');
const movel = require('../src/pontos/movel');
const alocacao = require('../src/pontos/alocacao');
const dispositivosRepo = require('../src/dispositivos/repository');
const execucoesRepo = require('../src/playlist/execucoes-repository');
const gerador = require('../src/playlist/gerador');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
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
    await pool.query(
      `DELETE FROM hospedagem_movimentacoes WHERE hospedagem_id IN (SELECT id FROM pontos_moveis_hospedagens WHERE conta_id = $1)`,
      [id],
    );
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

// Cada login com o seu IP: o limite de tentativas das rotas de interesse é
// por IP, e a suíte manda muitos.
async function entrar(conta) {
  const nav = navegador(
    `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`,
  );
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

// A rede móvel de teste (migration 115): cidade única (uma rede por cidade
// + UF) e UMA tela, adicionada como na ficha ("+ Adicionar tela" — a rede
// nasce sem tela). A hospedagem é sempre dessa tela (`telaId`). Sem horário
// na hospedagem = "operar durante todo o período": a suíte não depende da
// hora em que roda.
async function criarMovel() {
  const r = await admin('POST', '/admin/pontos-moveis', {
    nome: 'Mostraí Móvel',
    cidade: `Cidade ${randomUUID().slice(0, 8)}`,
    uf: 'SP',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  criadas.pontos.push(r.json.id);
  await tirarDoSorteio(r.json.id);
  const telaId = await adicionarTela(r.json.id);
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [r.json.id]);
  return { ...rows[0], telaId };
}

async function adicionarTela(pontoId) {
  const r = await admin('POST', `/admin/pontos/${pontoId}/dispositivos`, {});
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.id;
}

// A primeira tela em uso da rede (a `telaId` do `criarMovel`).
async function telaDe(pontoId) {
  const { rows } = await pool.query(
    `SELECT id FROM dispositivos WHERE ponto_id = $1 AND status <> 'inativo' ORDER BY id LIMIT 1`,
    [pontoId],
  );
  return rows[0]?.id;
}

// Evento na tela da rede (endereço obrigatório; sem horário = o período
// inteiro). O corpo do teste completa ou sobrescreve.
async function evento(pontoId, corpo) {
  return admin('POST', `/admin/pontos/${pontoId}/eventos`, {
    organizacao: 'X',
    local: 'Parque',
    endereco: 'Av. das Feiras, 100',
    telas: [await telaDe(pontoId)],
    ...corpo,
  });
}

// "2026-10-05T14:30" de Matão, deslocado em horas a partir de agora.
const paredeMais = (horas) => alocacao.parede(new Date(Date.now() + horas * 3_600_000));

// Dia de Matão deslocado em dias ("2026-10-07") — para os testes que falam
// em dias inteiros (o formato antigo `data_inicio`/`data_fim` continua
// aceito: do 00:00 do primeiro dia ao 00:00 do dia seguinte ao último).
const hojeMais = (dias) => {
  const d = new Date(`${alocacao.dataEmMatao(new Date())}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

// [inicio, fim) de dias inteiros de Matão (para INSERT direto nos testes).
const dias = (de, ate) => {
  const p = alocacao.lerPeriodo({ data_inicio: de, data_fim: ate }, { exigirFuturo: false });
  return [p.inicio, p.fim];
};

// Sem período no `extra`: começou há 1 h e termina em 48 h. Com
// `data_inicio` (dias) ou `inicio`/`fim` (data e hora), vale o do `extra`.
// A tela é a primeira da rede, salvo `dispositivo_id` no `extra`.
async function programar(pontoId, conta, extra = {}) {
  const periodo = extra.data_inicio || extra.inicio ? {} : { inicio: paredeMais(-1), fim: paredeMais(48) };
  const r = await admin('POST', `/admin/pontos/${pontoId}/hospedagens`, {
    dispositivo_id: await telaDe(pontoId),
    conta_id: conta.id,
    ...periodo,
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

const ENTREGA_OK = { itens: { tela: true, suporte: true, player: true, cabos: true }, condicao: 'ok' };
// O Admin marca o termo FÍSICO (assinado em papel) — pré-condição de iniciar.
const marcarTermo = (pontoId, hid, corpo = { assinado: true }) =>
  admin('PUT', `/admin/pontos/${pontoId}/hospedagens/${hid}/termo-fisico`, corpo);
// `iniciar` já marca o termo físico e entrega o equipamento, salvo
// { semTermo } / corpo explícito.
async function acao(pontoId, hid, nome, corpo = undefined, { semTermo = false } = {}) {
  if (nome === 'iniciar' && !semTermo) {
    const { rows } = await pool.query('SELECT estado, termo_assinado FROM pontos_moveis_hospedagens WHERE id = $1', [
      hid,
    ]);
    if (rows[0]?.estado === 'programada' && !rows[0].termo_assinado) await marcarTermo(pontoId, hid);
  }
  const body = corpo ?? (nome === 'iniciar' ? { entrega: ENTREGA_OK } : undefined);
  return admin('POST', `/admin/pontos/${pontoId}/hospedagens/${hid}/${nome}`, body);
}
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
  // O período previsto também recua: o tempo só vale dentro dele.
  await pool.query(`UPDATE pontos_moveis_hospedagens SET iniciada_em = $2, inicio = LEAST(inicio, $2) WHERE id = $1`, [
    hid,
    minutosAtras(minutos),
  ]);
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
async function pontoFixo({ categoriaId = null, dona = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, categoria_id,
                         anunciante_id)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '16 9', $2, $3) RETURNING *`,
    [`Fixo ${randomUUID().slice(0, 8)}`, categoriaId, dona ? dona.id : null],
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
// Origem 5–8 (candidatura → fixo, criação da rede e quem a cria:
// tests/ponto-movel.test.js e tests/rede-movel.test.js)
// =====================================================================
test('5 e 6. tipo imutável e móvel nunca recebe dono — nem hospedando', async () => {
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

// Um JPEG de verdade (2×2, cinza, gerado pelo FFmpeg): a rota confere os
// primeiros bytes (src/lib/imagem.js), não o tipo que o navegador declara.
const JPEG_PEQUENO = Buffer.from(
  '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYwLjMxLjEwMgD/2wBDAAg+Pkk+SVVVVVVVVWRdZGhoaGRkZGRoaGhwcHCDg4NwcHBoaHBwfHyDg4+Tj4eHg4eTk5ubm7q6srLZ2eD/////xABNAAEBAAAAAAAAAAAAAAAAAAAABgEBAQEAAAAAAAAAAAAAAAAAAAYHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAAgACAwESAAISAAMSAP/aAAwDAQACEQMRAD8ArRjouh//2Q==',
  'base64',
);

test('8. foto do ponto (fixo ou rede): só pelo Admin, só imagem de verdade, e a ficha e a lista de pontos a expõem', async () => {
  const m = await criarMovel();
  const fixo = await pontoFixo();
  const semArquivo = await admin('POST', `/admin/pontos/${m.id}/foto`);
  assert.strictEqual(semArquivo.status, 400, 'sem arquivo');
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
  const enviar = async (pontoId, bytes, { tipo = 'image/jpeg', nome = 'f.jpg', comSessao = true } = {}) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob([bytes], { type: tipo }), nome);
    const r = await fetch(`${base}/admin/pontos/${pontoId}/foto`, {
      method: 'POST',
      body: fd,
      headers: { 'x-forwarded-for': IP, ...(comSessao ? { cookie } : {}) },
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  // O upload vai para uma pasta local (STORAGE_CAPTURA, fora de produção) —
  // nunca para o bucket de verdade.
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'mostrai-foto-hosp-'));
  const capturaAntes = process.env.STORAGE_CAPTURA;
  process.env.STORAGE_CAPTURA = pasta;
  try {
    for (const ponto of [fixo, m]) {
      const r = await enviar(ponto.id, JPEG_PEQUENO);
      assert.strictEqual(r.status, 200, `fixo e rede aceitam (${ponto.tipo}): ${JSON.stringify(r.json)}`);
      assert.match(r.json.url, new RegExp(`^/e2e-storage/ponto-${ponto.id}\\.jpg\\?v=\\d+$`));
    }
    const html = await enviar(m.id, Buffer.from('<html><script>alert(1)</script></html>'));
    assert.strictEqual(html.status, 400, 'HTML declarado como image/jpeg não vai para o bucket público');
    const anon = await enviar(m.id, JPEG_PEQUENO, { comSessao: false });
    assert.strictEqual(anon.status, 401);
    const inexistente = await enviar(999999999, JPEG_PEQUENO);
    assert.strictEqual(inexistente.status, 404);
  } finally {
    if (capturaAntes === undefined) delete process.env.STORAGE_CAPTURA;
    else process.env.STORAGE_CAPTURA = capturaAntes;
    fs.rmSync(pasta, { recursive: true, force: true });
  }
  await pool.query(`UPDATE pontos SET foto_instalacao_url = 'https://exemplo.test/movel.jpg' WHERE id = $1`, [m.id]);
  const ficha = (await admin('GET', `/admin/pontos/${m.id}/movel`)).json;
  assert.strictEqual(ficha.foto, 'https://exemplo.test/movel.jpg');
  // A rede aparece no MESMO grid dos fixos (GET /admin/pontos), com a foto
  // em `movel.foto`; o fixo traz a dele na própria linha.
  const pontos = (await admin('GET', '/admin/pontos')).json;
  assert.strictEqual(pontos.find((p) => p.id === m.id).movel.foto, 'https://exemplo.test/movel.jpg');
  assert.match(pontos.find((p) => p.id === fixo.id).foto_instalacao_url, /^\/e2e-storage\/ponto-\d+\.jpg\?v=\d+$/);
  assert.strictEqual(pontos.find((p) => p.id === fixo.id).movel, null);
});

// =====================================================================
// Hospedagem 9–19
// =====================================================================
test('9, 10 e 11. confirmar hospedagem: UMA tela da rede, percentual congelado, revisão obrigatória, anfitrião válido', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await programarOk(m.id, anfitria);
  const h = await linha(hid);
  assert.strictEqual(h.estado, 'programada');
  assert.strictEqual(h.dispositivo_id, m.telaId, 'a hospedagem é de uma tela');
  assert.strictEqual(Number(h.percentual), 20, 'congelado no padrão do dono');
  assert.strictEqual(h.local, anfitria.nome_empresa, 'o local nasce com o nome da conta');
  assert.match(h.endereco, /Rua das Flores/);
  assert.strictEqual(h.horario_operacao, null, 'sem horário: operar durante todo o período');
  assert.strictEqual(h.termo_assinado, false, 'o termo físico nasce Pendente');
  assert.strictEqual(h.criado_por_admin, process.env.ADMIN_USER);
  const outro = await criarMovel();
  const divergente = await programar(outro.id, anfitria, { percentual_esperado: 25 });
  assert.strictEqual(divergente.status, 409, 'o percentual revisado não é o que vale');
  const semRevisao = await programar(outro.id, anfitria, { percentual_esperado: '' });
  assert.strictEqual(semRevisao.status, 400);
  // A tela: obrigatória, desta rede e em uso (não inativa).
  assert.strictEqual((await programar(outro.id, anfitria, { dispositivo_id: null })).status, 400, 'sem tela');
  assert.strictEqual(
    (await programar(outro.id, anfitria, { dispositivo_id: m.telaId })).status,
    400,
    'tela de outra rede',
  );
  const inativa = await adicionarTela(outro.id);
  assert.strictEqual((await admin('PATCH', `/admin/dispositivos/${inativa}`, { status: 'inativo' })).status, 200);
  assert.strictEqual((await programar(outro.id, anfitria, { dispositivo_id: inativa })).status, 400, 'tela inativa');
  // A conta própria é única no banco: usa a que existir (ou cria uma).
  const { rows: jaExiste } = await pool.query('SELECT id FROM anunciantes WHERE conta_propria LIMIT 1');
  const propria = jaExiste[0] || (await novaConta({ propria: true }));
  assert.strictEqual((await programar(outro.id, propria)).status, 400, 'a conta própria não hospeda');
  assert.strictEqual((await programar(outro.id, { id: 999999999 })).status, 400);
  const fixo = await pontoFixo();
  assert.strictEqual((await programar(fixo.id, anfitria)).status, 409, 'hospedagem é só de rede móvel');
  const passado = await programar(outro.id, anfitria, { data_inicio: hojeMais(-3), data_fim: hojeMais(-1) });
  assert.strictEqual(passado.status, 400);
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM pontos_moveis_hospedagens WHERE ponto_id = $1', [
    outro.id,
  ]);
  assert.strictEqual(rows[0].n, 0, 'nada inválido entrou');
});

test('12 e 13. agenda da TELA: hospedagem × hospedagem, hospedagem × evento, evento × evento', async () => {
  const m = await criarMovel();
  const a = await novaConta();
  const b = await novaConta();
  await programarOk(m.id, a, { data_inicio: hojeMais(2), data_fim: hojeMais(4) });
  const choque = await programar(m.id, b, { data_inicio: hojeMais(4), data_fim: hojeMais(6) });
  assert.strictEqual(choque.status, 409, 'datas inclusivas: o último dia conta');
  assert.match(choque.json.erro, /já está hospedada/);
  const ev = await evento(m.id, { nome: 'Feira', organizacao: 'Prefeitura', local: 'Praça', data_inicio: hojeMais(3) });
  assert.strictEqual(ev.status, 409);
  const eventoOk = await evento(m.id, {
    nome: 'Feira',
    organizacao: 'Prefeitura',
    local: 'Praça',
    data_inicio: hojeMais(8),
    data_fim: hojeMais(9),
  });
  assert.strictEqual(eventoOk.status, 201);
  const noEvento = await programar(m.id, b, { data_inicio: hojeMais(9), data_fim: hojeMais(10) });
  assert.strictEqual(noEvento.status, 409);
  assert.match(noEvento.json.erro, /no evento “Feira”/);
  const outroEvento = await evento(m.id, { nome: 'Show', local: 'Y', data_inicio: hojeMais(9) });
  assert.strictEqual(outroEvento.status, 409);
  // Sem conflito: depois do evento.
  assert.strictEqual((await programar(m.id, b, { data_inicio: hojeMais(10), data_fim: hojeMais(11) })).status, 201);
  // O banco é a última linha de defesa: INSERT direto também é recusado.
  const p = alocacao.lerPeriodo({ data_inicio: hojeMais(3) });
  await assert.rejects(
    pool.query(
      `INSERT INTO pontos_moveis_hospedagens
         (ponto_id, conta_id, local, endereco, data_inicio, data_fim, percentual, inicio, fim, dispositivo_id)
       VALUES ($1, $2, 'x', 'y', $3, $3, 20, $4, $5, $6)`,
      [m.id, b.id, hojeMais(3), p.inicio, p.fim, m.telaId],
    ),
    (e) => e.code === '23P01',
  );
});

test('14. concorrência: confirmações simultâneas na mesma tela e período — passa uma só', async () => {
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

test('15. iniciar: só a partir do dia; a tela vira do anfitrião; a TV recebe o horário DA HOSPEDAGEM e é avisada', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const futura = await programarOk(m.id, anfitria, { data_inicio: hojeMais(3), data_fim: hojeMais(4) });
  const cedo = await acao(m.id, futura, 'iniciar');
  assert.strictEqual(cedo.status, 409);
  assert.match(cedo.json.erro, /altere o período/);
  const HORARIO_DA_LOJA = {
    seg: { abre: '08:00', fecha: '18:00' },
    ter: { abre: '08:00', fecha: '18:00' },
    qua: { abre: '08:00', fecha: '18:00' },
    qui: { abre: '08:00', fecha: '18:00' },
    sex: { abre: '08:00', fecha: '18:00' },
    sab: { abre: '08:00', fecha: '12:00' },
    dom: null,
    feriados: null,
  };
  const hoje = await programarOk(m.id, await novaConta(), {
    data_inicio: hojeMais(0),
    data_fim: hojeMais(1),
    horario_operacao: HORARIO_DA_LOJA,
  });
  const versaoAntes = (await pool.query('SELECT config_versao_desejada v FROM dispositivos WHERE id = $1', [m.telaId]))
    .rows[0].v;
  assert.strictEqual((await acao(m.id, hoje, 'iniciar')).status, 200);
  assert.strictEqual((await linha(hoje)).estado, 'ativa');
  const f = (await admin('GET', `/admin/pontos/${m.id}/movel`)).json;
  const naFicha = f.telas.find((t) => t.id === m.telaId);
  assert.strictEqual(naFicha.alocacao.tipo, 'hospedagem');
  assert.strictEqual(naFicha.alocacao.id, hoje);
  assert.strictEqual(naFicha.proximo.id, futura);
  const tela = await dispositivosRepo.buscarComPonto(m.telaId);
  assert.deepStrictEqual(tela.ponto_horario_semanal, HORARIO_DA_LOJA, 'a TV recebe o horário DA HOSPEDAGEM');
  assert.strictEqual(tela.movel_alocado, true);
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

test('43 a 45. termo FÍSICO e equipamento: iniciar exige o termo marcado e a entrega; retirada ao encerrar ou depois', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const nav = await entrar(anfitria);
  const hid = await programarOk(m.id, anfitria, { data_inicio: hojeMais(0), data_fim: hojeMais(2) });
  const termo = (corpo) => marcarTermo(m.id, hid, corpo);
  const iniciar = (corpo) => acao(m.id, hid, 'iniciar', corpo, { semTermo: true });
  // Pendente: não inicia, nem com a entrega (que também não é gravada).
  const semTermo = await iniciar({ entrega: ENTREGA_OK });
  assert.strictEqual(semTermo.status, 409);
  assert.match(semTermo.json.erro, /termo físico/);
  const movs = async () =>
    (
      await pool.query('SELECT tipo, condicao FROM hospedagem_movimentacoes WHERE hospedagem_id = $1 ORDER BY tipo', [
        hid,
      ])
    ).rows;
  assert.deepStrictEqual(await movs(), []);
  // Marcar: assinado true/false; data opcional, nunca no futuro.
  assert.strictEqual((await termo({})).status, 400);
  assert.strictEqual((await termo({ assinado: 'sim' })).status, 400);
  assert.strictEqual((await termo({ assinado: true, assinado_em: '10/10/2026' })).status, 400);
  assert.strictEqual((await termo({ assinado: true, assinado_em: hojeMais(1) })).status, 400, 'não no futuro');
  const ok = await termo({ assinado: true, assinado_em: hojeMais(-1), observacao: 'assinado pela Fulana' });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.json));
  assert.deepStrictEqual(
    { ...ok.json.termo, marcadoEm: Boolean(ok.json.termo.marcadoEm) },
    {
      assinado: true,
      assinadoEm: hojeMais(-1),
      observacao: 'assinado pela Fulana',
      marcadoPor: process.env.ADMIN_USER,
      marcadoEm: true,
    },
  );
  // Programada: desmarcar vale (e limpa data e observação).
  const desmarcado = await termo({ assinado: false });
  assert.strictEqual(desmarcado.status, 200);
  assert.deepStrictEqual(
    [desmarcado.json.termo.assinado, desmarcado.json.termo.assinadoEm, desmarcado.json.termo.observacao],
    [false, null, null],
  );
  assert.strictEqual((await iniciar({ entrega: ENTREGA_OK })).status, 409, 'desmarcado não inicia');
  assert.strictEqual((await termo({ assinado: true })).status, 200);
  // Entrega: obrigatória para iniciar, com a tela; avaria pede observação.
  assert.strictEqual((await iniciar({})).status, 400);
  assert.strictEqual((await iniciar({ entrega: { itens: { suporte: true }, condicao: 'ok' } })).status, 400);
  assert.strictEqual((await iniciar({ entrega: { ...ENTREGA_OK, condicao: 'com_avarias' } })).status, 400);
  assert.strictEqual((await iniciar({ entrega: ENTREGA_OK })).status, 200);
  const ficha = (await admin('GET', `/admin/pontos/${m.id}/movel`)).json;
  const h = ficha.hospedagens.find((x) => x.id === hid);
  assert.strictEqual(h.tela.id, m.telaId);
  assert.strictEqual(h.termo.assinado, true);
  assert.strictEqual(h.entrega.condicao, 'ok');
  assert.strictEqual(h.entrega.admin, process.env.ADMIN_USER);
  // Em andamento: desmarcar é recusado (o termo já valeu para iniciar);
  // corrigir a data e a observação vale.
  assert.strictEqual((await termo({ assinado: false })).status, 409);
  const corrigido = await termo({ assinado: true, assinado_em: hojeMais(0), observacao: 'via na pasta 3' });
  assert.strictEqual(corrigido.status, 200);
  assert.strictEqual(corrigido.json.termo.observacao, 'via na pasta 3');
  // Painel do anfitrião: só "assinado", nada do equipamento.
  const painel = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  assert.strictEqual(painel.hospedagens.find((x) => x.id === hid).termoAssinado, true);
  assert.ok(!JSON.stringify(painel).includes('entrega'));
  // Em andamento, a retirada só vai junto do encerramento (recolher sem
  // encerrar deixaria o tempo seguinte contando para a anfitriã).
  assert.strictEqual((await acao(m.id, hid, 'retirada', ENTREGA_OK)).status, 409);
  // Prorrogar não pede nada de novo ao termo (o papel é com a Mostraí).
  assert.strictEqual(
    (await admin('PUT', `/admin/pontos/${m.id}/hospedagens/${hid}/periodo`, { data_fim: hojeMais(5) })).status,
    200,
  );
  assert.strictEqual((await linha(hid)).termo_assinado, true);
  // Encerrar com retirada; a retirada não se repete; o termo não muda mais.
  const enc = await acao(m.id, hid, 'encerrar', {
    retirada: { itens: { tela: true, suporte: true }, condicao: 'com_avarias', observacao: 'canto da moldura riscado' },
  });
  assert.strictEqual(enc.status, 200);
  assert.strictEqual((await acao(m.id, hid, 'retirada', ENTREGA_OK)).status, 409);
  assert.strictEqual((await termo({ assinado: true })).status, 409, 'encerrada: o termo não muda mais');
  assert.deepStrictEqual(
    (await movs()).map((x) => [x.tipo, x.condicao]),
    [
      ['entrega', 'ok'],
      ['retirada', 'com_avarias'],
    ],
  );
  // Encerrada sem retirada (encerramento automático): registra depois.
  const hid2 = await hospedagemAtiva(m, await novaConta(), 30);
  assert.strictEqual((await acao(m.id, hid2, 'encerrar')).status, 200);
  assert.strictEqual((await acao(m.id, hid2, 'retirada', ENTREGA_OK)).status, 200);
});

test('31c. métricas da Mídia Mostraí: a tela sem alocação não conta; hospedada, conta pelo horário da hospedagem', async () => {
  const m = await criarMovel();
  const { telaId } = await telaComPlayer(m.id);
  await pool.query(`UPDATE dispositivos SET primeiro_sinal_em = now() - interval '40 days' WHERE id = $1`, [telaId]);
  await pool.query(`UPDATE pontos SET status = 'em_operacao' WHERE id = $1`, [m.id]);
  const propria = await anunciantesRepo.ensureContaMostrai();
  const peca = await pecaAprovada(propria);
  const midiasRepo = require('../src/midias/repository');
  const { metricasDasMidias } = require('../src/midias/metricas');
  const midia = await midiasRepo.criar({
    criativoId: peca.id,
    nomeInterno: `Móvel ${randomUUID().slice(0, 6)}`,
    frequenciaHora: 2,
    coberturaTipo: 'pontos',
    pontosIds: [m.id],
  });
  try {
    await pool.query('DELETE FROM midias_proprias_situacoes WHERE midia_id = $1', [midia.id]);
    await pool.query(
      `INSERT INTO midias_proprias_situacoes (midia_id, situacao, desde) VALUES ($1, 'ativa', now() - interval '10 days')`,
      [midia.id],
    );
    const esperadas = async () =>
      (await metricasDasMidias([await midiasRepo.buscarPorId(midia.id)])).get(midia.id).esperadas.d7;
    const parada = await esperadas();
    assert.strictEqual(parada, 0, 'sem alocação: fora do inventário');
    // Hospedada (sem horário próprio = o período inteiro): o gerador e a TV
    // seguem 24 h — o esperado também.
    await hospedagemAtiva(m, await novaConta());
    const hospedado = await esperadas();
    assert.ok(hospedado > 100, `hospedada: horário em vigor (${parada} → ${hospedado})`);
  } finally {
    // A peça é da conta própria (que não é do teste): sai junto da mídia.
    await pool.query('DELETE FROM midias_proprias WHERE id = $1', [midia.id]);
    await pool.query('DELETE FROM criativos WHERE id = $1', [peca.id]);
  }
});

test('31b a 34. conectividade não é operação: sem heartbeat vira "sem comunicação", nunca "desligada"; o anunciante não recebe sinal', async () => {
  const m = await criarMovel();
  const { telaId } = await telaComPlayer(m.id);
  // Só alocada a tela tem "no ar" / "sem comunicação" (fora disso, "sem alocação").
  const hid = await hospedagemAtiva(m, await novaConta(), 10);
  // A Mostraí não fala com a tela há 1 dia (pode estar exibindo offline).
  await pool.query(
    `UPDATE dispositivos SET ultima_vez_online = now() - interval '1 day', primeiro_sinal_em = now() - interval '2 days',
            player_estado = 'PLAYING' WHERE id = $1`,
    [telaId],
  );
  const { rows: pt } = await pool.query('SELECT status FROM pontos WHERE id = $1', [m.id]);
  assert.notStrictEqual(pt[0].status, 'inativo', 'heartbeat sumido não inativa o ponto');
  // Admin (ficha da rede, por tela): os três estados separados.
  const naFicha = (await admin('GET', `/admin/pontos/${m.id}/movel`)).json.telas.find((t) => t.id === telaId);
  assert.strictEqual(naFicha.administrativo, 'ativo');
  assert.strictEqual(naFicha.conectividade, 'sem_comunicacao');
  assert.strictEqual(naFicha.operacao, 'desconhecida', 'sem comunicação, a operação é desconhecida');
  assert.ok(naFicha.ultimoSinal);
  // Anunciante que já teve exibição ali: "sem comunicação", sem o horário
  // do último sinal nem nada da tela.
  const anunciante = await novaConta();
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas,
                                     vezes_confirmadas, duracao_segundos)
     VALUES ($1, $2, date_trunc('hour', now()) - interval '3 hours', 2, 2, 2, 15)`,
    [anunciante.id, telaId],
  );
  const nav = await entrar(anunciante);
  const ex = await nav('GET', `/anunciantes/${anunciante.id}/exibicoes`);
  assert.strictEqual(ex.status, 200);
  const doPonto = ex.json.porPonto.find((p) => p.id === m.id);
  assert.strictEqual(doPonto.situacao, 'sem_comunicacao');
  assert.ok(!('ultima_vez_online' in doPonto), 'nenhum dado de heartbeat para o anunciante');
  assert.doesNotMatch(JSON.stringify(ex.json.porPonto), /ultima_vez|player_estado|heartbeat|fila/);
  // Com comunicação recente e exibindo: no ar.
  await pool.query(`UPDATE dispositivos SET ultima_vez_online = now() WHERE id = $1`, [telaId]);
  const ex2 = await nav('GET', `/anunciantes/${anunciante.id}/exibicoes`);
  assert.strictEqual(ex2.json.porPonto.find((p) => p.id === m.id).situacao, 'no_ar');
  // Tela em reparo (estado do cadastro, não conectividade): fora do ar.
  await dispositivosRepo.atualizar(telaId, { status: 'reparo' });
  const ex3 = await nav('GET', `/anunciantes/${anunciante.id}/exibicoes`);
  assert.strictEqual(ex3.json.porPonto.find((p) => p.id === m.id).situacao, 'fora_do_ar');
  // Fim da hospedagem: sem alocação — nunca "no ar", mesmo ligada e falando.
  await dispositivosRepo.atualizar(telaId, { status: 'ativo' });
  assert.strictEqual((await acao(m.id, hid, 'encerrar')).status, 200);
  const ex4 = await nav('GET', `/anunciantes/${anunciante.id}/exibicoes`);
  assert.strictEqual(ex4.json.porPonto.find((p) => p.id === m.id).situacao, 'sem_alocacao');
  await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [anunciante.id]);
});

test('17. prorrogar: sem conflito na tela, mantendo o percentual; nunca encurta; programada troca até de tela', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta();
  const hid = await hospedagemAtiva(m, anfitria, 10);
  const rodeio = await evento(m.id, { nome: 'Rodeio', data_inicio: hojeMais(6), data_fim: hojeMais(7) });
  assert.strictEqual(rodeio.status, 201, JSON.stringify(rodeio.json));
  const per = (corpo) => admin('PUT', `/admin/pontos/${m.id}/hospedagens/${hid}/periodo`, corpo);
  assert.strictEqual((await per({ data_fim: hojeMais(4) })).status, 200);
  assert.strictEqual((await linha(hid)).data_fim, hojeMais(4));
  assert.strictEqual((await per({ data_fim: hojeMais(6) })).status, 409, 'bate no evento da mesma tela');
  assert.strictEqual((await per({ data_fim: hojeMais(1) })).status, 400, 'encurtar é Encerrar');
  assert.strictEqual(Number((await linha(hid)).percentual), 20);
  // Programada: muda início, fim e a tela (outra da mesma rede, livre).
  const outraTela = await adicionarTela(m.id);
  assert.strictEqual(
    (await per({ data_fim: hojeMais(5), dispositivo_id: outraTela })).status,
    400,
    'em andamento, a tela não muda',
  );
  const outra = await programarOk(m.id, await novaConta(), { data_inicio: hojeMais(10), data_fim: hojeMais(11) });
  const mudou = await admin('PUT', `/admin/pontos/${m.id}/hospedagens/${outra}/periodo`, {
    data_inicio: hojeMais(12),
    data_fim: hojeMais(13),
    dispositivo_id: outraTela,
  });
  assert.strictEqual(mudou.status, 200, JSON.stringify(mudou.json));
  assert.strictEqual((await linha(outra)).dispositivo_id, outraTela);
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
                                            estado, iniciada_em, inicio, fim, dispositivo_id)
     VALUES ($1, $2, 'Tabacaria', 'Rua', $3, $4, 20, 'ativa', now() - interval '3 days', $5, $6, $7) RETURNING id`,
    [m.id, anfitria.id, hojeMais(-3), hojeMais(-1), ...dias(hojeMais(-3), hojeMais(-1)), m.telaId],
  );
  const hid = rows[0].id;
  // Operou 2 h dentro do período e 1 h DEPOIS do fim previsto (não conta).
  const fimPrevisto = new Date(`${hojeMais(0)}T03:00:00Z`); // meia-noite de Matão (UTC−3)
  await operou(m.telaId, new Date(fimPrevisto.getTime() - 2 * 3600e3), fimPrevisto);
  await operou(m.telaId, fimPrevisto, new Date(fimPrevisto.getTime() + 3600e3));
  const m1 = await criarMovel();
  const programada = await pool.query(
    `INSERT INTO pontos_moveis_hospedagens (ponto_id, conta_id, local, endereco, data_inicio, data_fim, percentual,
                                            inicio, fim, dispositivo_id)
     VALUES ($1, $2, 'Outra', 'Rua', $3, $3, 20, $4, $5, $6) RETURNING id`,
    [m1.id, anfitria.id, hojeMais(-2), ...dias(hojeMais(-2), hojeMais(-2)), m1.telaId],
  );
  const m2 = await criarMovel();
  const ev = await pool.query(
    `INSERT INTO pontos_moveis_eventos (ponto_id, nome, local, endereco, data_inicio, data_fim, estado, iniciado_em,
                                        inicio, fim)
     VALUES ($1, 'Feira', 'Praça', 'Praça Central', $2, $3, 'em_andamento', now() - interval '2 days', $4, $5)
     RETURNING id`,
    [m2.id, hojeMais(-2), hojeMais(-1), ...dias(hojeMais(-2), hojeMais(-1))],
  );
  await pool.query('INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id) VALUES ($1, $2)', [
    ev.rows[0].id,
    m2.telaId,
  ]);
  const versaoDaTela = async () =>
    (await pool.query('SELECT config_versao_desejada v FROM dispositivos WHERE id = $1', [m2.telaId])).rows[0].v;
  const versaoAntes = await versaoDaTela();
  const r1 = await hospedagem.encerrarVencidas();
  assert.ok(r1.hospedagensEncerradas >= 1 && r1.hospedagensCanceladas >= 1 && r1.eventosEncerrados >= 1);
  const h = await linha(hid);
  assert.strictEqual(h.estado, 'encerrada');
  assert.strictEqual(h.encerramento, 'automatico');
  assert.strictEqual(new Date(h.encerrada_em).getTime(), fimPrevisto.getTime(), 'encerra no fim previsto');
  assert.strictEqual(h.tempo_operacional_segundos, 7200, 'a hora depois do fim previsto não conta');
  assert.strictEqual(h.beneficio_segundos, 1440);
  assert.strictEqual((await linha(programada.rows[0].id)).estado, 'cancelada');
  const doEvento = (
    await pool.query('SELECT estado, encerramento FROM pontos_moveis_eventos WHERE id = $1', [ev.rows[0].id])
  ).rows[0];
  assert.deepStrictEqual(doEvento, { estado: 'encerrado', encerramento: 'automatico' });
  assert.ok((await versaoDaTela()) > versaoAntes, 'a TV do evento encerrado é avisada');
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
  // O Player bate a cada 15 s; tolerância de 2 min (src/lib/heartbeat.js):
  // 1 min depois da anterior (exibindo) estende.
  await recuar(1);
  await hb('PLAYING');
  assert.strictEqual(await intervalos(), 2, 'dentro da tolerância, estende');
  // Buraco maior que a tolerância (2 min): intervalo novo.
  await recuar(3);
  await hb('PLAYING');
  assert.strictEqual(await intervalos(), 3, 'batida perdida: intervalo novo');
  // Reparo e volta a ativa entre duas batidas (dentro da tolerância): a
  // ponte não atravessa o tempo que o Admin marcou como não operacional.
  await recuar(1);
  await pool.query(
    `INSERT INTO tela_eventos (dispositivo_id, tipo, detalhe, ocorrido_em)
     VALUES ($1, 'ADMIN_STATE_CHANGED', '{"de":"ativo","para":"reparo"}', now() - interval '90 seconds'),
            ($1, 'ADMIN_STATE_CHANGED', '{"de":"reparo","para":"ativo"}', now() - interval '30 seconds')`,
    [telaId],
  );
  await hb('PLAYING');
  assert.strictEqual(await intervalos(), 4, 'mudança do Admin entre as batidas fecha o intervalo');
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

test('37c. vale o estado da tela QUANDO exibiu: offline de quando estava ativa soma mesmo chegando com ela em reparo; o de reparo não; a tela com hospedagem não se exclui', async () => {
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
    ['ok', 'ok', 'ok'],
    'durante o reparo responde ok (o aberto pode voltar maior), mas não grava',
  );
  const { rows } = await pool.query(`SELECT COUNT(*)::int n FROM tela_operacao WHERE dispositivo_id = $1`, [telaId]);
  assert.strictEqual(rows[0].n, 3, 'heartbeat em reparo não grava');
  // Sem FK em ponto_id: o heartbeat (trava a tela) nunca trava o ponto, que
  // as ações do Admin travam antes das telas — ordem oposta = deadlock.
  const { rows: fks } = await pool.query(
    `SELECT 1 FROM pg_constraint WHERE conrelid = 'tela_operacao'::regclass AND contype = 'f' AND confrelid = 'pontos'::regclass`,
  );
  assert.strictEqual(fks.length, 0);
  // A tela com hospedagem registrada não se exclui (a alocação é o registro
  // do benefício): fica Inativa. O tempo é DELA — 60 + 30 + 10 min.
  const exclusao = await admin('DELETE', `/admin/dispositivos/${telaId}`);
  assert.strictEqual(exclusao.status, 409);
  assert.match(exclusao.json.erro, /hospedagem ou evento registrado/);
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
  // Hospedando de novo (desde antes da hora: a tela está no pool da hora e
  // veicula): na própria tela, não ganha veiculação gratuita.
  await hospedagemAtiva(movelDaHospedagem, conta, 90);
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

test('40c. móvel SEM ALOCAÇÃO não é inventário: toca só o institucional — nem saldo, nem plano, nem obrigação', async () => {
  const { conta } = await contaComSaldo(600);
  await pecaAprovada(conta, 15);
  const parado = await criarMovel();
  const { telaId } = await telaComPlayer(parado.id);
  const tela = await dispositivosRepo.buscarComPonto(telaId);
  assert.strictEqual(tela.movel_alocado, false);
  assert.strictEqual(tela.ponto_horario_semanal, null, 'sem horário comercial');
  assert.strictEqual(tela.categoria_id, null, 'sem ramo');
  assert.strictEqual(tela.casa_conta_id, null, 'sem casa');
  const env = await gerador.gerarPlaylistDaHora(tela, new Date());
  assert.ok(env.itens.length > 0);
  assert.ok(
    env.itens.every((i) => i.institucional && !i.contabiliza && !i.anuncianteId),
    'só institucional',
  );
  const { rows } = await pool.query('SELECT COUNT(*)::int n FROM exibicoes_contador WHERE dispositivo_id = $1', [
    telaId,
  ]);
  assert.strictEqual(rows[0].n, 0, 'nenhuma programada nem obrigação');
  const { rows: congelada } = await pool.query(
    'SELECT COUNT(*)::int n FROM playlist_hora_congelada WHERE dispositivo_id = $1',
    [telaId],
  );
  assert.strictEqual(congelada[0].n, 0, 'a hora não congela: a alocação que começar no meio da hora nasce limpa');
  // Alocada desde antes da hora (no pool da hora; hospedagem de outra
  // conta), o saldo da conta passa a rodar nela.
  const hid = await hospedagemAtiva(parado, await novaConta(), 90);
  const alocado = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(telaId), new Date());
  assert.ok(
    alocado.itens.some((i) => i.anuncianteId === conta.id),
    'alocado, o saldo da rede entra',
  );
  await acao(parado.id, hid, 'encerrar');
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
test('47 a 52. trava de concorrente pelo contexto da ALOCAÇÃO: anfitrião, o ramo do evento, ou nenhum', async () => {
  const ramoAnfitriao = await novaCategoria('Tabacaria');
  const ramoEvento = await novaCategoria('Bebidas');
  const ramoEscolhido = await novaCategoria('Padaria');
  const m = await criarMovel();
  const { telaId } = await telaComPlayer(m.id);
  const ctx = async () => {
    const d = await dispositivosRepo.buscarComPonto(telaId);
    return { categoria: d.categoria_id, casa: d.casa_conta_id };
  };
  assert.deepStrictEqual(await ctx(), { categoria: null, casa: null }, '48. sem alocação: sem ramo e sem casa');
  // Concorrente do anfitrião, com saldo de hospedagem.
  const anfitria = await novaConta({ categoriaId: ramoAnfitriao });
  const { conta: concorrenteSaldo } = await contaComSaldo(1200, { categoriaId: ramoAnfitriao });
  await pecaAprovada(concorrenteSaldo);
  // Desde antes da hora: a tela está no pool da hora (veicula de verdade).
  const hid = await hospedagemAtiva(m, anfitria, 90);
  assert.deepStrictEqual(await ctx(), { categoria: ramoAnfitriao, casa: anfitria.id }, '47 e 50. hospedagem');
  // Controle: uma conta com saldo de OUTRO ramo entra (a tela está no pool
  // da hora) — a ausência do concorrente é a trava, não acaso.
  const { conta: outroRamo } = await contaComSaldo(1200);
  await pecaAprovada(outroRamo);
  const env = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(telaId), new Date());
  assert.ok(
    env.itens.some((i) => i.anuncianteId === outroRamo.id),
    'controle: o saldo veicula nesta tela',
  );
  assert.ok(!env.itens.some((i) => i.anuncianteId === concorrenteSaldo.id), '51. a trava vale para o saldo também');
  await acao(m.id, hid, 'encerrar');
  assert.deepStrictEqual(await ctx(), { categoria: null, casa: null }, '52. encerrada: sem alocação de novo');
  // O Admin pode definir o ramo da hospedagem (padrão: o da conta).
  const outra = await programarOk(m.id, anfitria, { categoria_id: ramoEscolhido });
  assert.strictEqual((await linha(outra)).categoria_id, ramoEscolhido);
  assert.strictEqual((await programar(m.id, anfitria, { categoria_id: 'abc' })).status, 400);
  await acao(m.id, outra, 'cancelar');
  // Evento com contexto próprio; e evento sem contexto não tem trava.
  const ev = await evento(m.id, { nome: 'Festival', data_inicio: hojeMais(0), categoria_id: ramoEvento });
  assert.strictEqual(ev.status, 201, JSON.stringify(ev.json));
  await admin('POST', `/admin/pontos/${m.id}/eventos/${ev.json.id}/iniciar`);
  assert.deepStrictEqual(await ctx(), { categoria: ramoEvento, casa: null }, '49. evento: o contexto dele');
  await admin('POST', `/admin/pontos/${m.id}/eventos/${ev.json.id}/encerrar`);
  const semCtx = await evento(m.id, { nome: 'Corrida', local: 'Rua', data_inicio: hojeMais(0) });
  assert.strictEqual(semCtx.status, 201, JSON.stringify(semCtx.json));
  await admin('POST', `/admin/pontos/${m.id}/eventos/${semCtx.json.id}/iniciar`);
  assert.deepStrictEqual(await ctx(), { categoria: null, casa: null }, '49. sem contexto: sem trava');
  await admin('POST', `/admin/pontos/${m.id}/eventos/${semCtx.json.id}/encerrar`);
  const invalida = await evento(m.id, { nome: 'X', data_inicio: hojeMais(20), categoria_id: 'abc' });
  assert.strictEqual(invalida.status, 400);
});

// =====================================================================
// Site 53–59
// =====================================================================
// Conta com DIREITO ATIVO DE VEICULAÇÃO: plano vigente (como o webhook
// grava). `vencido: true` — o mesmo plano, já expirado.
async function contaComPlano({ vencido = false, ...opcoes } = {}) {
  const conta = await novaConta(opcoes);
  await pool.query(
    `UPDATE anunciantes SET plano_id = 'essencial-1m', data_expiracao = now() + $2::interval WHERE id = $1`,
    [conta.id, vencido ? '-2 days' : '20 days'],
  );
  return { ...conta, plano_id: 'essencial-1m' };
}

async function interessesDaConta(contaId) {
  const { rows } = await pool.query('SELECT * FROM hospedagem_interesses WHERE conta_id = $1 ORDER BY id', [contaId]);
  for (const r of rows) criadas.interesses.push(r.id);
  return rows;
}

test('53 a 57. interesse: só conta logada com direito ativo de veiculação; nunca reserva equipamento', async () => {
  const { possuiDireitoAtivoDeVeiculacao } = require('../src/anunciantes/acesso-painel');
  // Anônimo: 401 (o site mostra o login, nunca o formulário).
  const anon = navegador(`10.9.${Math.floor(Math.random() * 250)}.1`);
  const semLogin = await anon('POST', '/hospedagem/interesse', { observacao: 'x' });
  assert.strictEqual(semLogin.status, 401);
  // Só cadastro (sem plano, Básico ou saldo): 403 com o motivo.
  const soCadastro = await novaConta();
  const r403 = await (await entrar(soCadastro))('POST', '/hospedagem/interesse', {});
  assert.strictEqual(r403.status, 403);
  assert.strictEqual(r403.json.motivo, 'sem_direito');
  // Plano vencido: 403.
  const vencida = await contaComPlano({ vencido: true });
  const rVenc = await (await entrar(vencida))('POST', '/hospedagem/interesse', {});
  assert.strictEqual(rVenc.status, 403);
  assert.strictEqual(rVenc.json.motivo, 'plano_vencido');
  // Suspensa (mesmo com plano): 403 — e o login de conta suspensa nem passa.
  const suspensa = await contaComPlano();
  await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [suspensa.id]);
  const dirSusp = await possuiDireitoAtivoDeVeiculacao({ ...suspensa, suspenso: true });
  assert.deepStrictEqual(dirSusp, { possui: false, motivo: 'suspensa' });
  // Com plano vigente: aceita, com os dados DA CONTA.
  const conta = await contaComPlano();
  const nav = await entrar(conta);
  const r = await nav('POST', '/hospedagem/interesse', { observacao: 'tenho espaço na vitrine', empresa: 'Forjada' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const [i] = await interessesDaConta(conta.id);
  assert.strictEqual(i.status, 'nova');
  assert.strictEqual(i.empresa, conta.nome_empresa, 'a empresa vem do cadastro, nunca do corpo');
  assert.strictEqual(i.local_tipo, 'conta');
  assert.match(i.endereco, /Rua das Flores, 10/);
  const pend = await pool.query(`SELECT 1 FROM pendencias WHERE chave = $1 AND resolvido_em IS NULL`, [
    `HOSPEDAGEM_INTERESSE:${i.id}`,
  ]);
  assert.strictEqual(pend.rowCount, 1, 'o Admin vê na Visão geral');
  // Duplo clique / reenvio: não duplica, responde "já recebido".
  const de2 = await nav('POST', '/hospedagem/interesse', {});
  assert.strictEqual(de2.status, 200);
  assert.strictEqual(de2.json.jaRecebido, true);
  assert.strictEqual((await interessesDaConta(conta.id)).length, 1, 'um interesse aberto por conta');
  // Robô (campo-armadilha): responde igual e não grava.
  const outra = await contaComPlano();
  assert.strictEqual(
    (await (await entrar(outra))('POST', '/hospedagem/interesse', { site: 'http://spam' })).status,
    201,
  );
  assert.strictEqual((await interessesDaConta(outra.id)).length, 0, 'campo-armadilha: não grava');
  const { rows: hosp } = await pool.query(
    'SELECT COUNT(*)::int n FROM pontos_moveis_hospedagens WHERE interesse_id = $1',
    [i.id],
  );
  assert.strictEqual(hosp[0].n, 0, 'interesse não reserva equipamento');
  // Outras origens do direito: Básico ativo e saldo de hospedagem.
  const { conta: comSaldo } = await contaComSaldo(300);
  assert.strictEqual((await possuiDireitoAtivoDeVeiculacao(comSaldo)).origem, 'saldo_hospedagem');
  assert.strictEqual((await possuiDireitoAtivoDeVeiculacao(conta)).origem, 'plano');
  assert.strictEqual((await possuiDireitoAtivoDeVeiculacao(soCadastro)).possui, false);
});

test('58. interesse: local pretendido — o da conta, um ponto DELA (nunca de outra) ou outro endereço validado', async () => {
  const conta = await contaComPlano();
  const nav = await entrar(conta);
  // Ponto de OUTRA conta: recusado (IDOR).
  const alheio = await pontoFixo();
  const idor = await nav('POST', '/hospedagem/interesse', { local_tipo: 'ponto', ponto_id: alheio.id });
  assert.strictEqual(idor.status, 400);
  assert.strictEqual((await interessesDaConta(conta.id)).length, 0);
  // Tipo inválido.
  assert.strictEqual((await nav('POST', '/hospedagem/interesse', { local_tipo: 'base' })).status, 400);
  // Outro endereço incompleto: 400; completo: grava o endereço digitado.
  assert.strictEqual(
    (await nav('POST', '/hospedagem/interesse', { local_tipo: 'outro', cep: '15990-000' })).status,
    400,
  );
  const ok = await nav('POST', '/hospedagem/interesse', {
    local_tipo: 'outro',
    local_nome: 'Quiosque da Praça',
    cep: '15990-000',
    logradouro: 'Rua Sete',
    numero: '70',
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    conta_id: 999999,
  });
  assert.strictEqual(ok.status, 201, JSON.stringify(ok.json));
  const [i] = await interessesDaConta(conta.id);
  assert.strictEqual(i.conta_id, conta.id, 'a conta é a da SESSÃO');
  assert.strictEqual(i.local_tipo, 'outro');
  assert.strictEqual(i.local_nome, 'Quiosque da Praça');
  assert.match(i.endereco, /Rua Sete, 70/);
  // Um ponto DELA.
  const dona = await contaComPlano();
  const meu = await pontoFixo({ dona });
  const r = await (await entrar(dona))('POST', '/hospedagem/interesse', { local_tipo: 'ponto', ponto_id: meu.id });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const [doPonto] = await interessesDaConta(dona.id);
  assert.strictEqual(doPonto.ponto_id, meu.id);
  // O painel lista os pontos dela para escolher.
  const painel = (await (await entrar(dona))('GET', '/anunciantes/me/hospedagem')).json;
  assert.ok(painel.pontos.some((p) => p.id === meu.id));
  assert.strictEqual(painel.elegivel.possui, true);
  assert.strictEqual(painel.conta.empresa, dona.nome_empresa);
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
  // V1.1: o formulário (com o POST do interesse) mora no módulo da conta e a
  // página decide o estado pela conta da sessão.
  const modulo = pub('hospedagem-conta.js');
  assert.match(modulo, /\/hospedagem\/interesse/);
  assert.match(script, /\/anunciantes\/me\/hospedagem/);
  assert.match(script, /status === 401/, 'anônimo: explicação e login, sem formulário');
  assert.match(script, /Ver planos/, 'sem direito: o requisito e os planos');
  assert.match(modulo, /Enviar interesse não reserva um equipamento/);
  assert.match(modulo, /Dados da conta/i);
  assert.doesNotMatch(`${pagina}${script}${modulo}`, /ganhe \d|ganhe 20/i, 'nunca "ganhe 20%" solto');
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

test('64. andamento do interesse: recebido → em contato → aprovado → agendado; cancelada volta; recusado fecha', async () => {
  const conta = await contaComPlano();
  const nav = await entrar(conta);
  const r = await nav('POST', '/anunciantes/me/hospedagem/interesse', {
    observacao: 'pode ser em novembro',
    percentual: 90,
    inicio: '2030-01-01T08:00',
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  const [i] = await interessesDaConta(conta.id);
  assert.strictEqual(i.contato_telefone, '16999990000');
  assert.strictEqual(i.observacao, 'pode ser em novembro');
  let d = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  assert.strictEqual(d.interesseAberto.status, 'nova');
  const patch = (corpo) => admin('PATCH', `/admin/hospedagem/interesses/${i.id}`, corpo);
  assert.strictEqual((await patch({ status: 'em_contato' })).status, 200);
  assert.strictEqual((await patch({ status: 'aprovada' })).status, 200);
  assert.strictEqual((await patch({ status: 'agendada' })).status, 400, 'agendada só nasce da hospedagem');
  d = (await nav('GET', '/anunciantes/me/hospedagem')).json;
  assert.strictEqual(d.interesseAberto.status, 'aprovada');
  // A lista do Admin mostra o direito atual da conta e o histórico.
  const lista = (await admin('GET', '/admin/hospedagem/interesses')).json.find((x) => x.id === Number(i.id));
  assert.strictEqual(lista.direito.possui, true);
  assert.strictEqual(lista.direito.origem, 'plano');
  assert.deepStrictEqual(lista.historico, { interessesAnteriores: 0, hospedagens: [] });
  // Agendar a partir do interesse.
  const m = await criarMovel();
  const hidI = await programarOk(m.id, conta, { interesse_id: i.id });
  assert.strictEqual(
    (await pool.query('SELECT status FROM hospedagem_interesses WHERE id = $1', [i.id])).rows[0].status,
    'agendada',
  );
  assert.strictEqual((await patch({ status: 'recusada' })).status, 409);
  const outro = await criarMovel();
  assert.strictEqual((await programar(outro.id, conta, { interesse_id: i.id })).status, 409, 'não agenda duas vezes');
  // Cancelada: o interesse volta para "em contato" e agenda de novo.
  assert.strictEqual((await acao(m.id, hidI, 'cancelar')).status, 200);
  assert.strictEqual(
    (await pool.query('SELECT status FROM hospedagem_interesses WHERE id = $1', [i.id])).rows[0].status,
    'em_contato',
  );
  assert.strictEqual((await programar(outro.id, conta, { interesse_id: i.id })).status, 201);
  // Recusado fecha: a conta pode mandar outro depois.
  const outra = await contaComPlano();
  const navOutra = await entrar(outra);
  await navOutra('POST', '/hospedagem/interesse', {});
  const [j] = await interessesDaConta(outra.id);
  assert.strictEqual(
    (await admin('PATCH', `/admin/hospedagem/interesses/${j.id}`, { status: 'recusada' })).status,
    200,
  );
  assert.strictEqual((await navOutra('POST', '/hospedagem/interesse', {})).status, 201);
  assert.strictEqual((await interessesDaConta(outra.id)).length, 2);
});

test('65 e 66. card do anunciante: a tela "agora em" o anfitrião, sem conta, percentual, saldo ou histórico', async () => {
  const m = await criarMovel();
  const anfitria = await novaConta({ nome: `Tabacaria Pública ${randomUUID().slice(0, 4)}` });
  const hid = await hospedagemAtiva(m, anfitria, 30);
  const situacao = (await movel.situacaoDasRedes([m.id])).get(m.id);
  assert.strictEqual(situacao.telas, 1);
  assert.strictEqual(situacao.emOperacao, 1);
  assert.deepStrictEqual(
    situacao.locaisAgora.map((l) => [l.origem, l.nome]),
    [['hospedagem', anfitria.nome_empresa]],
  );
  const texto = JSON.stringify(situacao);
  assert.doesNotMatch(texto, /percentual|conta_?id|saldo|beneficio|"conta"/i);
  const chaves = [];
  JSON.parse(texto, (k, v) => {
    chaves.push(k);
    return v;
  });
  assert.ok(!chaves.some((k) => /conta|anfitri/i.test(k)), `chaves: ${chaves.join(',')}`);
  // "Onde estamos": a alocação real (o local da hospedagem), nunca a conta.
  const publico = await navegador()('GET', '/pontos');
  const daLista = publico.json.filter((p) => p.id === m.id);
  assert.deepStrictEqual(
    daLista.map((p) => p.local_atual),
    [anfitria.nome_empresa],
  );
  assert.doesNotMatch(JSON.stringify(daLista), /percentual|hospedagem|saldo|conta/i);
  // Hospedagem futura não aparece no card.
  await acao(m.id, hid, 'encerrar');
  await programarOk(m.id, await novaConta(), { data_inicio: hojeMais(4), data_fim: hojeMais(5) });
  assert.deepStrictEqual(
    (await movel.situacaoDasRedes([m.id])).get(m.id).locaisAgora,
    [],
    'sem alocação: nenhum local',
  );
  assert.ok(!(await navegador()('GET', '/pontos')).json.some((p) => p.id === m.id), 'fora do "Onde estamos"');
});

test('67. conta não forja nada: rotas do móvel e da hospedagem exigem o Admin', async () => {
  const conta = await novaConta();
  const nav = await entrar(conta);
  const m = await criarMovel();
  for (const [metodo, caminho, corpo] of [
    ['GET', '/admin/pontos-moveis/agenda'],
    ['POST', `/admin/pontos/${m.id}/foto`],
    [
      'POST',
      `/admin/pontos/${m.id}/hospedagens`,
      { dispositivo_id: m.telaId, conta_id: conta.id, data_inicio: hojeMais(0), data_fim: hojeMais(1) },
    ],
    ['POST', `/admin/pontos/${m.id}/hospedagens/1/encerrar`],
    ['PUT', `/admin/pontos/${m.id}/hospedagens/1/termo-fisico`, { assinado: true }],
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
test('E2E §78: Rede móvel → interesse → hospedagem 20% → operação → encerramento → horas → mídia sem plano → POP → saldo cai', async () => {
  // Admin cria a rede da cidade e adiciona a tela.
  const m = await criarMovel();
  const { telaId, chaveAparelho, dispositivoId } = await telaComPlayer(m.id);
  // Uma tabacaria que já anuncia (plano vigente) demonstra interesse.
  const tabacaria = await contaComPlano({ nome: `Tabacaria E2E ${randomUUID().slice(0, 4)}` });
  const nav = await entrar(tabacaria);
  assert.strictEqual((await nav('POST', '/hospedagem/interesse', { observacao: 'tenho vitrine' })).status, 201);
  const [interesse] = await interessesDaConta(tabacaria.id);
  // Admin agenda 3 dias; percentual congelado em 20%.
  const hid = await programarOk(m.id, tabacaria, {
    data_inicio: hojeMais(0),
    data_fim: hojeMais(2),
    interesse_id: interesse.id,
  });
  assert.strictEqual(Number((await linha(hid)).percentual), 20);
  assert.strictEqual((await acao(m.id, hid, 'iniciar')).status, 200);
  await pool.query('UPDATE pontos_moveis_hospedagens SET iniciada_em = $2, inicio = LEAST(inicio, $2) WHERE id = $1', [
    hid,
    minutosAtras(400),
  ]);
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
  // Encerra: a tela fica sem alocação, benefício calculado, horas na conta.
  const fim = await acao(m.id, hid, 'encerrar');
  assert.strictEqual(fim.status, 200);
  assert.ok(Math.abs(fim.json.tempoSegundos - 6 * 3600) <= 2, `6 h (${fim.json.tempoSegundos}s)`);
  assert.strictEqual(fim.json.beneficioSegundos, Math.floor((fim.json.tempoSegundos * 20) / 100));
  assert.deepStrictEqual(
    (await movel.situacaoDasRedes([m.id])).get(m.id).locaisAgora,
    [],
    'sem alocação: nenhum local',
  );
  assert.ok(!(await navegador()('GET', '/pontos')).json.some((p) => p.id === m.id), 'fora do "Onde estamos"');
  const saldo = (await nav('GET', '/anunciantes/me/hospedagem')).json.saldo.disponivelSegundos;
  assert.strictEqual(saldo, fim.json.beneficioSegundos);
  // O plano dela vence; sem plano, a conta usa as horas: peça aprovada →
  // gerador distribui → POP.
  await pool.query(`UPDATE anunciantes SET data_expiracao = now() - interval '2 days' WHERE id = $1`, [tabacaria.id]);
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
