require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const dispositivosRepo = require('../src/dispositivos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const planosRepo = require('../src/financeiro/planos-repository');
const midiasRepo = require('../src/midias/repository');
const { pontosDoAnunciante } = require('../src/lib/pacing');
const { entradaNoArDasPecas, ESTADOS } = require('../src/anunciantes/entrada-no-ar');
const filaEntrada = require('../src/anunciantes/fila-entrada');
const { metricasDasMidias } = require('../src/midias/metricas');
const { instalarPlayer } = require('./apoio-player');

// Estação de distribuição real (27/09/2026):
//   1–9   escolha de pontos (targeting) e o próprio ponto;
//   10–17 primeira entrada no ar (aprovado ≠ no ar);
//   18–31 Mídia Mostraí: programadas × confirmadas, esperadas e estado.
// Toda conta daqui ESCOLHE os pontos dela (nunca modo automático com peça
// aprovada): sem isso ela cairia na cobertura automática dos pontos de
// outros arquivos rodando em paralelo.

process.env.SESSION_SECRET ||= 'teste-distribuicao';
process.env.SAN_CHECKOUT_KEY ||= 'chave-de-teste';

const HORA = 3_600_000;
const horaCheia = (ms) => new Date(Math.floor(ms / HORA) * HORA);
const DIAS_UTEIS = { abre: '08:00', fecha: '18:00' };
// Seg–sex 08–18 em Matão; fim de semana fechado. Sem chave `feriados`: o
// dia da semana vale sempre (resultado determinístico).
const HORARIO_COMERCIAL = {
  seg: DIAS_UTEIS,
  ter: DIAS_UTEIS,
  qua: DIAS_UTEIS,
  qui: DIAS_UTEIS,
  sex: DIAS_UTEIS,
  sab: null,
  dom: null,
};
const H24 = { abre: '00:00', fecha: '24:00' };
const HORARIO_24H = { seg: H24, ter: H24, qua: H24, qui: H24, sex: H24, sab: H24, dom: H24 };

// ---------------------------------------------------------------------------
// App: rotas reais, sessão por cabeçalho (como conta-experiencia.test.js)
// ---------------------------------------------------------------------------
let app;
test.before(async () => {
  const a = express();
  a.set('trust proxy', true);
  a.use(express.json());
  a.use(session({ secret: 'teste-distribuicao', resave: false, saveUninitialized: false }));
  a.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  a.use(require('../src/player/routes'));
  a.use(require('../src/anunciantes/routes').router);
  a.use(require('../src/admin/routes'));
  a.use(require('../src/midias/routes'));
  a.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = a.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, { conta, corpo, chave, ip } = {}) => {
    const headers = { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' };
    if (conta) headers['x-conta'] = String(conta);
    if (chave) headers['X-Aparelho-Key'] = chave;
    headers['X-Forwarded-For'] = ip || `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
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
const criados = { contas: [], pontos: [], midias: [], criativos: [] };

async function categoria() {
  const { rows } = await pool.query('SELECT id FROM categorias WHERE ativo AND NOT legado ORDER BY id LIMIT 1');
  return rows[0].id;
}

async function novaConta({ plano = 'essencial-1m', categoriaId = null, cortesia = false } = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Distribuição ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `distribuicao-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
    categoria_id: categoriaId,
  });
  criados.contas.push(conta.id);
  if (plano) {
    await pool.query('UPDATE anunciantes SET plano_id = $2, plano_cortesia = $3 WHERE id = $1', [
      conta.id,
      plano,
      cortesia,
    ]);
  }
  return anunciantesRepo.buscarPorId(conta.id);
}

async function novoPonto({ horario = HORARIO_24H, dono = null, categoriaId = null, comTela = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                         horario_semanal, anunciante_id, categoria_id)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2, $3, $4) RETURNING id`,
    [`Dist ${randomUUID().slice(0, 8)}`, horario ? JSON.stringify(horario) : null, dono, categoriaId],
  );
  const pontoId = rows[0].id;
  criados.pontos.push(pontoId);
  if (!comTela) return { pontoId };
  const tela = await dispositivosRepo.criar(pontoId, {});
  const player = await instalarPlayer(tela.id);
  // Primeiro sinal no passado: a tela conta no "esperado" de 40 dias pra trás.
  await pool.query(`UPDATE dispositivos SET primeiro_sinal_em = now() - interval '40 days' WHERE id = $1`, [tela.id]);
  return { pontoId, telaId: tela.id, player };
}

async function criativoAprovado(contaId, { url = 'https://exemplo.test/peca.mp4' } = {}) {
  const c = await criativosRepo.criar({
    anunciante_id: contaId,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: url,
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  criados.criativos.push(c.id);
  return criativosRepo.atualizar(c.id, { status: 'aprovado' });
}

async function escolher(contaId, pontos) {
  for (const pontoId of pontos) {
    await pool.query(
      'INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, clock_timestamp())',
      [contaId, pontoId],
    );
  }
}

const tela = (telaId) => dispositivosRepo.buscarComPonto(telaId);

// Segunda (terceira…) tela no mesmo ponto, instalada e com sinal antigo.
async function outraTela(pontoId) {
  const t = await dispositivosRepo.criar(pontoId, {});
  const player = await instalarPlayer(t.id);
  await pool.query(`UPDATE dispositivos SET primeiro_sinal_em = now() - interval '40 days' WHERE id = $1`, [t.id]);
  return { telaId: t.id, player };
}

async function playlistAgora(telaId) {
  return gerador.gerarPlaylistDaHora(await tela(telaId), new Date());
}

const idsDeAnunciante = (pl) => new Set(pl.itens.map((i) => i.anuncianteId).filter(Boolean));

async function novaMidia({ pontos = [], frequencia = 2, periodoInicio = null, periodoFim = null, rede = false } = {}) {
  const propria = await anunciantesRepo.ensureContaMostrai();
  const criativo = await criativoAprovado(propria.id, { url: `https://exemplo.test/midia-${randomUUID()}.mp4` });
  const midia = await midiasRepo.criar({
    criativoId: criativo.id,
    nomeInterno: `Mídia teste ${randomUUID().slice(0, 6)}`,
    frequenciaHora: frequencia,
    coberturaTipo: rede ? 'rede' : 'pontos',
    pontosIds: rede ? [] : pontos,
    periodoInicio,
    periodoFim,
  });
  criados.midias.push(midia.id);
  return midia;
}

const evento = (item, extra = {}) => ({
  execucaoId: randomUUID(),
  janelaId: item.itemProgramacaoId.split('|').slice(0, 2).join('|'),
  itemProgramacaoId: item.itemProgramacaoId,
  criativoId: item.criativoId,
  iniciadoEm: new Date().toISOString(),
  terminadoEm: new Date().toISOString(),
  ...extra,
});

const enviarPop = (player, eventos) =>
  app.chamar('POST', `/player/${player.dispositivoId}/played`, { chave: player.chaveAparelho, corpo: { eventos } });

test.after(async () => {
  await app.fechar();
  for (const id of criados.midias) await pool.query('DELETE FROM midias_proprias WHERE id = $1', [id]);
  for (const pontoId of criados.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM midias_exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [pontoId]);
  }
  for (const id of criados.contas) {
    await pool.query('UPDATE criativos SET substitui_criativo_id = NULL WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  }
  for (const id of criados.criativos) await pool.query('DELETE FROM criativos WHERE id = $1', [id]);
  for (const pontoId of criados.pontos) {
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
  for (const id of criados.contas) await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  await pool.query("DELETE FROM tentativas_acesso WHERE chave LIKE '10.77.%'");
  await pool.end();
});

// ===========================================================================
// 25. Targeting (1–9)
// ===========================================================================
test('1. plano permite N pontos (N = pontos_incluidos do plano, não um número fixo)', async () => {
  const conta = await novaConta(); // essencial: 3
  const pontos = [];
  for (let i = 0; i < 3; i++) pontos.push((await novoPonto({ comTela: false })).pontoId);
  const lista = await app.chamar('GET', '/anunciantes/me/pontos-disponiveis', { conta: conta.id });
  assert.equal(lista.json.limite, 3, 'o limite vem do plano');
  const put = await app.chamar('PUT', '/anunciantes/me/pontos', { conta: conta.id, corpo: { pontos } });
  assert.equal(put.status, 200, put.texto);
  assert.equal(put.json.limite, 3);
  const prime = await novaConta({ plano: 'maximo-1m' });
  assert.equal((await app.chamar('GET', '/anunciantes/me/pontos-disponiveis', { conta: prime.id })).json.limite, 10);
});

test('2. N+1 é recusado', async () => {
  const conta = await novaConta();
  const pontos = [];
  for (let i = 0; i < 4; i++) pontos.push((await novoPonto({ comTela: false })).pontoId);
  const put = await app.chamar('PUT', '/anunciantes/me/pontos', { conta: conta.id, corpo: { pontos } });
  assert.equal(put.status, 400);
  assert.match(put.json.erro, /cobre 3 ponto\(s\) e você marcou 4/);
  const { rows } = await pool.query('SELECT 1 FROM anunciantes_pontos WHERE anunciante_id = $1', [conta.id]);
  assert.equal(rows.length, 0, 'nada salvo pela metade');
});

test('3. ponto selecionado recebe elegibilidade (entra na playlist dele)', async () => {
  const conta = await novaConta();
  const escolhido = await novoPonto();
  await escolher(conta.id, [escolhido.pontoId]);
  await criativoAprovado(conta.id);
  const pl = await playlistAgora(escolhido.telaId);
  assert.ok(idsDeAnunciante(pl).has(conta.id));
  assert.equal(pl.itens.find((i) => i.anuncianteId === conta.id).contabiliza, true);
});

test('4. não selecionado não recebe no modo manual', async () => {
  const conta = await novaConta();
  const escolhido = await novoPonto();
  const outro = await novoPonto();
  await escolher(conta.id, [escolhido.pontoId]);
  await criativoAprovado(conta.id);
  assert.ok(!idsDeAnunciante(await playlistAgora(outro.telaId)).has(conta.id));
});

test('5. modo automático sem seleção continua funcionando (fatia estável dentro do plano)', async () => {
  const conta = await novaConta();
  await novoPonto();
  const r = await app.chamar('GET', '/anunciantes/me/pontos-disponiveis', { conta: conta.id });
  assert.equal(r.json.modoAutomatico, true);
  assert.deepEqual(r.json.escolhidos, []);
  const noAr = r.json.pontos.filter((p) => p.status === 'em_operacao' && !p.bloqueado).length;
  assert.equal(r.json.pontos.filter((p) => p.naCobertura).length, Math.min(3, noAr), 'respeita pontos_incluidos');
  assert.ok(r.json.cobertura.veiculando > 0, 'sem escolha, a campanha roda em pontos no ar');
  // A mesma função do gerador: sem escolha, sorteio estável; com escolha, só
  // os escolhidos em operação.
  const pontos = [11, 12, 13, 14, 15];
  const auto1 = pontosDoAnunciante({ id: 42, pontosIncluidos: 2, escolhidos: [] }, pontos);
  assert.deepEqual(auto1, pontosDoAnunciante({ id: 42, pontosIncluidos: 2, escolhidos: [] }, pontos), 'estável');
  assert.equal(auto1.length, 2);
  assert.deepEqual(pontosDoAnunciante({ id: 42, pontosIncluidos: 2, escolhidos: [13, 99] }, pontos), [13]);
});

test('6. próprio ponto aparece — destacado, primeiro da lista, com estado/horário/ocupação, NUNCA pré-selecionado', async () => {
  const conta = await novaConta();
  const proprio = await novoPonto({ dono: conta.id, horario: HORARIO_COMERCIAL });
  const outro = await novoPonto();
  const r = await app.chamar('GET', '/anunciantes/me/pontos-disponiveis', { conta: conta.id });
  assert.equal(r.status, 200, r.texto);
  const meu = r.json.pontos.find((p) => p.id === proprio.pontoId);
  assert.equal(meu.seuPonto, true);
  assert.equal(meu.escolhido, false, 'ser dono não seleciona');
  assert.equal(r.json.pontos.find((p) => p.id === outro.pontoId).seuPonto, false);
  assert.equal(r.json.pontos[0].id, proprio.pontoId, 'encabeça a lista');
  for (const campo of ['nome', 'cidade', 'status', 'horario', 'ocupacao', 'escolhido', 'naCobertura']) {
    assert.ok(campo in meu, `campo ${campo}`);
  }
  assert.match(meu.horario, /08:00/);
  const { rows } = await pool.query('SELECT 1 FROM anunciantes_pontos WHERE anunciante_id = $1', [conta.id]);
  assert.equal(rows.length, 0, 'listar não grava escolha');
});

test('7. próprio ponto pode ser escolhido — e veicula nele mesmo no mesmo ramo (achado de produção); vale pro benefício', async () => {
  const cat = await categoria();
  const dono = await novaConta({ plano: 'maximo-1m', cortesia: true, categoriaId: cat });
  const proprio = await novoPonto({ dono: dono.id, categoriaId: cat });
  const put = await app.chamar('PUT', '/anunciantes/me/pontos', {
    conta: dono.id,
    corpo: { pontos: [proprio.pontoId] },
  });
  assert.equal(put.status, 200, 'conta de benefício escolhe pontos');
  const lista = await app.chamar('GET', '/anunciantes/me/pontos-disponiveis', { conta: dono.id });
  assert.equal(lista.json.pontos.find((p) => p.id === proprio.pontoId).escolhido, true);
  assert.equal(lista.json.modoAutomatico, false);
  await criativoAprovado(dono.id);
  assert.ok(idsDeAnunciante(await playlistAgora(proprio.telaId)).has(dono.id), 'a trava de ramo não barra o dono');
});

test('8. próprio ponto pode ficar de fora (e o concorrente do mesmo ramo continua barrado)', async () => {
  const cat = await categoria();
  const dono = await novaConta({ categoriaId: cat });
  const concorrente = await novaConta({ categoriaId: cat });
  const proprio = await novoPonto({ dono: dono.id, categoriaId: cat });
  const outro = await novoPonto();
  await escolher(dono.id, [outro.pontoId]); // anuncia só em outros pontos
  await escolher(concorrente.id, [proprio.pontoId]);
  await criativoAprovado(dono.id);
  await criativoAprovado(concorrente.id);
  const ids = idsDeAnunciante(await playlistAgora(proprio.telaId));
  assert.ok(!ids.has(dono.id), 'dono que não escolheu o próprio ponto não entra nele');
  assert.ok(!ids.has(concorrente.id), 'concorrente do mesmo ramo não entra');
  assert.ok(idsDeAnunciante(await playlistAgora(outro.telaId)).has(dono.id), 'roda onde escolheu');
});

test('9. próprio ponto conta no limite; salvar de novo preserva a ordem da escolha', async () => {
  const conta = await novaConta();
  const proprio = await novoPonto({ dono: conta.id, comTela: false });
  const outros = [];
  for (let i = 0; i < 3; i++) outros.push((await novoPonto({ comTela: false })).pontoId);
  const quatro = await app.chamar('PUT', '/anunciantes/me/pontos', {
    conta: conta.id,
    corpo: { pontos: [proprio.pontoId, ...outros] },
  });
  assert.equal(quatro.status, 400, 'próprio + 3 = 4 > 3');
  const [a, b, c] = outros;
  await app.chamar('PUT', '/anunciantes/me/pontos', { conta: conta.id, corpo: { pontos: [proprio.pontoId, a] } });
  // Em texto: a ordem é por microssegundo (clock_timestamp), e Date do JS
  // perde a parte abaixo do milissegundo.
  const ler = async () =>
    (
      await pool.query(
        'SELECT ponto_id, escolhido_em::text AS em FROM anunciantes_pontos WHERE anunciante_id = $1 ORDER BY escolhido_em',
        [conta.id],
      )
    ).rows;
  const antes = await ler();
  assert.deepEqual(
    antes.map((r) => r.ponto_id),
    [proprio.pontoId, a],
    'ordem da lista = ordem de escolha',
  );
  await new Promise((r) => setTimeout(r, 15));
  const tres = await app.chamar('PUT', '/anunciantes/me/pontos', {
    conta: conta.id,
    corpo: { pontos: [proprio.pontoId, b, c] },
  });
  assert.equal(tres.status, 200, 'próprio + 2 = 3 cabe');
  const depois = await ler();
  assert.deepEqual(
    depois.map((r) => r.ponto_id),
    [proprio.pontoId, b, c],
  );
  assert.equal(depois[0].em, antes[0].em, 'quem ficou mantém o escolhido_em');
});

// ===========================================================================
// 26. Primeira entrada (10–17)
// ===========================================================================
async function contaNoPonto(horario = HORARIO_24H) {
  const conta = await novaConta();
  const ponto = await novoPonto({ horario });
  await escolher(conta.id, [ponto.pontoId]);
  return { conta, ponto };
}

async function entradaDe(conta, criativos, agora) {
  const plano = await planosRepo.buscarPorId(conta.plano_id);
  return entradaNoArDasPecas({ conta, plano, contaVeicula: true, criativos, agora });
}

const peca = (c, extra = {}) => ({ ...c, em_rodizio: true, ...extra });

test('10. aprovação não vira No ar (o banco carimba aprovado_em; a rota não diz "no ar"; o aviso não diz "já está no ar")', async () => {
  const { conta } = await contaNoPonto();
  const c = await criativoAprovado(conta.id);
  const primeira = (await criativosRepo.buscarPorId(c.id)).aprovado_em;
  assert.ok(primeira, 'carimbado na aprovação');
  const r = await app.chamar('GET', '/anunciantes/me/criativos', { conta: conta.id });
  const minha = r.json.criativos.find((x) => x.id === c.id);
  assert.notEqual(minha.situacao, 'no_ar');
  assert.ok(minha.entrada, 'toda peça aprovada tem entrada calculada — sem limbo');
  // Reaprovar depois de retirar recomeça o contexto.
  await criativosRepo.atualizar(c.id, { status: 'retirado' });
  await new Promise((res) => setTimeout(res, 15));
  await criativosRepo.atualizar(c.id, { status: 'aprovado' });
  assert.ok(new Date((await criativosRepo.buscarPorId(c.id)).aprovado_em) > new Date(primeira));
  const n = await pool.query('SELECT descricao FROM notificacoes WHERE anunciante_id = $1', [conta.id]);
  assert.ok(!n.rows.some((x) => /Já está no ar/.test(x.descricao)));
});

test('11. primeira janela é calculada: próxima hora cheia em que um ponto da cobertura funciona a hora inteira', async () => {
  const { conta: c24 } = await contaNoPonto(HORARIO_24H);
  const a = await criativoAprovado(c24.id);
  const e24 = (
    await entradaDe(c24, [peca(a, { aprovado_em: new Date('2026-09-28T13:20:00Z') })], new Date('2026-09-28T13:25:00Z'))
  ).get(a.id);
  assert.equal(e24.primeiraJanelaPrevista, '2026-09-28T14:00:00.000Z', 'meio da hora → próxima hora cheia');
  // 1 peça, 1 inserção/hora (pior caso sem hora programada): 1 hora + 10 min.
  assert.equal(e24.prazoPrimeiraExibicao, '2026-09-28T15:10:00.000Z');

  const { conta } = await contaNoPonto(HORARIO_COMERCIAL);
  const c = await criativoAprovado(conta.id);
  // Seg 28/09 20:20 em Matão (23:20Z) → ter 08:00 (11:00Z).
  const e = (
    await entradaDe(
      conta,
      [peca(c, { aprovado_em: new Date('2026-09-28T23:20:00Z') })],
      new Date('2026-09-28T23:30:00Z'),
    )
  ).get(c.id);
  assert.equal(e.primeiraJanelaPrevista, '2026-09-29T11:00:00.000Z', 'fechado → próxima hora aberta');
  // Sex 02/10 17:30 (20:30Z) → pula sáb/dom → seg 05/10 08:00 (11:00Z).
  const f = (
    await entradaDe(
      conta,
      [peca(c, { aprovado_em: new Date('2026-10-02T20:30:00Z') })],
      new Date('2026-10-02T20:31:00Z'),
    )
  ).get(c.id);
  assert.equal(f.primeiraJanelaPrevista, '2026-10-05T11:00:00.000Z', 'fim de semana fechado');
  // Tolerância: 3 peças no rodízio, 1 inserção/hora → 3 horas ABERTAS + 10 min.
  const g = (
    await entradaDe(
      conta,
      [peca(c, { aprovado_em: new Date('2026-09-28T23:20:00Z') }), peca({ ...c, id: -1 }), peca({ ...c, id: -2 })],
      new Date('2026-09-28T23:30:00Z'),
    )
  ).get(c.id);
  assert.equal(g.prazoPrimeiraExibicao, '2026-09-29T14:10:00.000Z');
});

test('12. antes da janela = Programado', async () => {
  const { conta } = await contaNoPonto(HORARIO_24H);
  const c = await criativoAprovado(conta.id);
  const e = (
    await entradaDe(
      conta,
      [peca(c, { aprovado_em: new Date('2026-09-28T13:20:00Z') })],
      new Date('2026-09-28T13:59:00Z'),
    )
  ).get(c.id);
  assert.equal(e.estado, ESTADOS.PROGRAMADO);
  const r = await app.chamar('GET', '/anunciantes/me/criativos', { conta: conta.id });
  const minha = r.json.criativos.find((x) => x.id === c.id);
  assert.equal(minha.situacao, 'programado', 'recém-aprovada: programada pra próxima hora');
  assert.ok(new Date(minha.entrada.primeiraJanelaPrevista) > new Date(), 'a janela vem pronta do servidor');
});

test('13. janela chegou sem POP = aguardando (a conta está na playlist servida)', async () => {
  const { conta, ponto } = await contaNoPonto(HORARIO_24H);
  const c = await criativoAprovado(conta.id);
  const agora = new Date();
  const janela = horaCheia(agora.getTime());
  const aprovadoEm = new Date(janela.getTime() - 10 * 60_000);
  let e = (await entradaDe(conta, [peca(c, { aprovado_em: aprovadoEm })], agora)).get(c.id);
  assert.equal(e.estado, ESTADOS.PROGRAMADO, 'hora começou, a TV ainda não pediu');
  await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), agora);
  e = (await entradaDe(conta, [peca(c, { aprovado_em: aprovadoEm })], agora)).get(c.id);
  assert.equal(e.estado, ESTADOS.AGUARDANDO);
  assert.equal(e.primeiraJanelaPrevista, janela.toISOString());
});

test('14. passou tolerância = atrasado (e aparece na fila do admin)', async () => {
  const { conta } = await contaNoPonto(HORARIO_24H);
  const c = await criativoAprovado(conta.id);
  await pool.query(`UPDATE criativos SET aprovado_em = now() - interval '3 hours' WHERE id = $1`, [c.id]);
  const e = (await entradaDe(conta, [peca(await criativosRepo.buscarPorId(c.id))], new Date())).get(c.id);
  assert.equal(e.estado, ESTADOS.ATRASADO);
  const lista = await app.chamar('GET', '/admin/criativos/entrada');
  const meu = lista.json.find((i) => i.criativoId === c.id);
  assert.equal(meu.estado, 'ATRASADO');
  assert.equal(meu.contaId, conta.id);
  assert.ok(filaEntrada.contarEntrada(lista.json).atrasados >= 1);
  const r = await app.chamar('GET', '/anunciantes/me/criativos', { conta: conta.id });
  assert.equal(r.json.criativos.find((x) => x.id === c.id).situacao, 'atrasado');
});

test('15. primeiro POP válido = No ar (rota real do Player, peça marcada)', async () => {
  const { conta, ponto } = await contaNoPonto(HORARIO_24H);
  const c = await criativoAprovado(conta.id);
  const pl = await playlistAgora(ponto.telaId);
  const item = pl.itens.find((i) => i.anuncianteId === conta.id);
  assert.ok(item);
  const pop = await enviarPop(ponto.player, [evento(item)]);
  assert.equal(pop.json.resultados[0].status, 'contabilizado');
  const linha = await criativosRepo.buscarPorId(c.id);
  assert.ok(linha.primeira_exibicao_em && linha.ultima_exibicao_em);
  const r = await app.chamar('GET', '/anunciantes/me/criativos', { conta: conta.id });
  const depois = r.json.criativos.find((x) => x.id === c.id);
  assert.equal(depois.situacao, 'no_ar');
  assert.ok(depois.entrada.ultimaExibicaoEm);
});

test('16. POP duplicado não altera incorretamente (mesmo execucaoId: duplicado, nada muda)', async () => {
  const { conta, ponto } = await contaNoPonto(HORARIO_24H);
  const c = await criativoAprovado(conta.id);
  const pl = await playlistAgora(ponto.telaId);
  const ev = evento(pl.itens.find((i) => i.anuncianteId === conta.id));
  assert.equal((await enviarPop(ponto.player, [ev])).json.resultados[0].status, 'contabilizado');
  const antes = await criativosRepo.buscarPorId(c.id);
  const somar = async () =>
    (
      await pool.query('SELECT SUM(vezes_confirmadas)::int AS n FROM exibicoes_contador WHERE anunciante_id = $1', [
        conta.id,
      ])
    ).rows[0].n;
  const confirmadas = await somar();
  await new Promise((r) => setTimeout(r, 10));
  const rep = await enviarPop(ponto.player, [{ ...ev, iniciadoEm: new Date().toISOString() }, ev]);
  assert.deepEqual(
    rep.json.resultados.map((x) => x.status),
    ['duplicado', 'duplicado'],
  );
  assert.equal(await somar(), confirmadas, 'não conta de novo');
  const depois = await criativosRepo.buscarPorId(c.id);
  assert.equal(depois.primeira_exibicao_em.getTime(), antes.primeira_exibicao_em.getTime());
  assert.equal(depois.ultima_exibicao_em.getTime(), antes.ultima_exibicao_em.getTime(), 'duplicado não mexe na última');
  const e = (await entradaDe(conta, [peca(depois)], new Date())).get(c.id);
  assert.equal(e.estado, ESTADOS.NO_AR);
});

test('17. criativo sem ponto elegível não vira No ar (diz o motivo); comprovante antigo não vale; "atualizar telas" só sinaliza', async () => {
  // A conta escolheu só um ponto do MESMO ramo dela (e não é a dona): a
  // trava de ramo tira o ponto da cobertura — nenhum ponto elegível. (Escolher
  // só ponto fora de operação não serve: aí a conta volta pro modo automático,
  // regra de `pontosDoAnunciante`.)
  const cat = await categoria();
  const conta = await novaConta({ categoriaId: cat });
  const doRamo = await novoPonto({ categoriaId: cat });
  await escolher(conta.id, [doRamo.pontoId]);
  const c = await criativoAprovado(conta.id);
  assert.ok(!idsDeAnunciante(await playlistAgora(doRamo.telaId)).has(conta.id), 'o gerador concorda: não entra');
  const e = (await entradaDe(conta, [peca(await criativosRepo.buscarPorId(c.id))], new Date())).get(c.id);
  assert.equal(e.estado, ESTADOS.APROVADO);
  assert.equal(e.motivo, 'sem_ponto_no_ar_na_cobertura');
  const r = await app.chamar('GET', '/anunciantes/me/criativos', { conta: conta.id });
  assert.equal(r.json.criativos.find((x) => x.id === c.id).situacao, 'aprovado');
  // Fora do limite de peças e conta sem plano: motivo próprio, nunca "no ar".
  assert.equal(
    (await entradaDe(conta, [peca(c, { em_rodizio: false })], new Date())).get(c.id).motivo,
    'fora_do_limite_de_pecas',
  );
  const plano = await planosRepo.buscarPorId(conta.plano_id);
  const semPlano = await entradaNoArDasPecas({
    conta,
    plano,
    contaVeicula: false,
    criativos: [peca(c, { em_rodizio: false })],
  });
  assert.equal(semPlano.get(c.id).motivo, 'sem_plano_vigente');
  // Comprovante de ANTES do contexto atual (reaprovada) não põe no ar.
  const { conta: outra, ponto } = await contaNoPonto(HORARIO_24H);
  const d = await criativoAprovado(outra.id);
  await pool.query(
    `UPDATE criativos SET primeira_exibicao_em = now() - interval '2 days', ultima_exibicao_em = now() - interval '2 days',
            aprovado_em = now() - interval '5 minutes' WHERE id = $1`,
    [d.id],
  );
  assert.notEqual(
    (await entradaDe(outra, [peca(await criativosRepo.buscarPorId(d.id))], new Date())).get(d.id).estado,
    ESTADOS.NO_AR,
  );
  // Ferramenta segura do admin: marca a playlist como desatualizada; não reinicia nada.
  await pool.query('UPDATE dispositivos SET playlist_desatualizada_em = NULL WHERE id = $1', [ponto.telaId]);
  const at = await app.chamar('POST', `/admin/criativos/${d.id}/atualizar-telas`);
  assert.equal(at.status, 200);
  assert.ok(at.json.telas >= 1);
  const { rows } = await pool.query('SELECT playlist_desatualizada_em FROM dispositivos WHERE id = $1', [ponto.telaId]);
  assert.ok(rows[0].playlist_desatualizada_em);
  assert.equal((await app.chamar('POST', '/admin/criativos/abc/atualizar-telas')).status, 400);
});

test('16.1 relógio da TV errado (legível, fora da hora): vale a chegada — a peça aprovada no meio da hora entra no ar', async () => {
  const { conta, ponto } = await contaNoPonto(HORARIO_24H);
  const c = await criativoAprovado(conta.id);
  const pl = await playlistAgora(ponto.telaId);
  const item = pl.itens.find((i) => i.anuncianteId === conta.id);
  const pop = await enviarPop(ponto.player, [evento(item, { iniciadoEm: '2020-01-01T00:00:00.000Z' })]);
  assert.equal(pop.json.resultados[0].status, 'contabilizado');
  const linha = await criativosRepo.buscarPorId(c.id);
  assert.ok(linha.primeira_exibicao_em >= linha.aprovado_em, 'o instante não fica antes da aprovação');
  const e = (await entradaDe(conta, [peca(linha)], new Date())).get(c.id);
  assert.equal(e.estado, ESTADOS.NO_AR);
});

test('16.2 reaprovar recomeça a primeira exibição: a do contexto antigo não é mostrada nem mantida', async () => {
  const { conta, ponto } = await contaNoPonto(HORARIO_24H);
  const c = await criativoAprovado(conta.id);
  const antiga = new Date(Date.now() - 2 * 24 * HORA);
  await pool.query('UPDATE criativos SET primeira_exibicao_em = $2, ultima_exibicao_em = $2 WHERE id = $1', [
    c.id,
    antiga,
  ]);
  await criativosRepo.atualizar(c.id, { status: 'retirado' });
  await criativosRepo.atualizar(c.id, { status: 'aprovado' });
  let e = (await entradaDe(conta, [peca(await criativosRepo.buscarPorId(c.id))], new Date())).get(c.id);
  assert.equal(e.primeiraExibicaoEm, null, 'a primeira do contexto antigo não é a deste');
  const pl = await playlistAgora(ponto.telaId);
  await enviarPop(ponto.player, [evento(pl.itens.find((i) => i.anuncianteId === conta.id))]);
  const linha = await criativosRepo.buscarPorId(c.id);
  assert.ok(linha.primeira_exibicao_em >= linha.aprovado_em, 'a primeira passa a ser a do contexto novo');
  e = (await entradaDe(conta, [peca(linha)], new Date())).get(c.id);
  assert.equal(e.estado, ESTADOS.NO_AR);
  assert.equal(
    e.primeiraExibicaoEm.getTime?.() ?? new Date(e.primeiraExibicaoEm).getTime(),
    linha.primeira_exibicao_em.getTime(),
  );
});

// ===========================================================================
// 27. Mídia Mostraí (18–31)
// ===========================================================================
async function midiaNaTela({ horario = HORARIO_24H, frequencia = 2 } = {}) {
  const ponto = await novoPonto({ horario });
  const midia = await novaMidia({ pontos: [ponto.pontoId], frequencia });
  return { ponto, midia, tipo: `midia:${midia.id}` };
}

const itensDa = (pl, tipo) => pl.itens.filter((i) => i.itemProgramacaoId.endsWith(`|${tipo}`));

const contador = async (midiaId, telaId) =>
  (
    await pool.query(
      'SELECT * FROM midias_exibicoes_contador WHERE midia_id = $1 AND dispositivo_id = $2 ORDER BY janela_hora',
      [midiaId, telaId],
    )
  ).rows;

// Métricas com relógio fixo: seg 28/09/2026 12:00 em Matão (15:00Z).
const AGORA = new Date('2026-09-28T15:00:00Z');

async function midiaAntiga({ horario = HORARIO_COMERCIAL, frequencia = 2, historico = null } = {}) {
  const { ponto, midia } = await midiaNaTela({ horario, frequencia });
  await pool.query('DELETE FROM midias_proprias_situacoes WHERE midia_id = $1', [midia.id]);
  for (const [situacao, horasAtras] of historico || [['ativa', 40 * 24]]) {
    await pool.query('INSERT INTO midias_proprias_situacoes (midia_id, situacao, desde) VALUES ($1, $2, $3)', [
      midia.id,
      situacao,
      new Date(AGORA.getTime() - horasAtras * HORA),
    ]);
  }
  await pool.query('UPDATE midias_proprias SET created_at = $2 WHERE id = $1', [
    midia.id,
    new Date(AGORA.getTime() - 40 * 24 * HORA),
  ]);
  await pool.query('UPDATE dispositivos SET primeiro_sinal_em = $2 WHERE ponto_id = $1', [
    ponto.pontoId,
    new Date(AGORA.getTime() - 60 * 24 * HORA),
  ]);
  return { ponto, midia };
}

async function hora(midiaId, telaId, pontoId, janela, programadas, confirmadas, ultima = null) {
  await pool.query(
    `INSERT INTO midias_exibicoes_contador (midia_id, dispositivo_id, ponto_id, janela_hora, vezes_programadas, vezes_confirmadas,
                                           primeira_confirmacao_em, ultima_confirmacao_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$7)`,
    [midiaId, telaId, pontoId, janela, programadas, confirmadas, confirmadas ? ultima || janela : null],
  );
}

const metricas = async (midiaId, opcoes = {}) =>
  (await metricasDasMidias([await midiasRepo.buscarPorId(midiaId)], { agora: AGORA, ...opcoes })).get(midiaId);

test('18. toda rede: a mídia de cobertura "rede" entra em todas as telas', async () => {
  const a = await novoPonto();
  const b = await novoPonto();
  const midia = await novaMidia({ rede: true, frequencia: 1 });
  const tipo = `midia:${midia.id}`;
  assert.equal(itensDa(await playlistAgora(a.telaId), tipo).length, 1);
  assert.equal(itensDa(await playlistAgora(b.telaId), tipo).length, 1);
  const m = (await metricasDasMidias([await midiasRepo.buscarPorId(midia.id)], { detalhe: true })).get(midia.id);
  const telas = m.porTela.map((t) => t.dispositivoId);
  assert.ok(telas.includes(a.telaId) && telas.includes(b.telaId), 'o esperado da rede inclui todas as telas');
  // Sai já (é da rede toda): não fica ocupando a hora dos outros arquivos.
  await pool.query(`UPDATE midias_proprias SET situacao = 'encerrada' WHERE id = $1`, [midia.id]);
});

test('19. pontos específicos: só na cobertura dela, independente da escolha dos anunciantes', async () => {
  const conta = await novaConta();
  const a = await novoPonto();
  const b = await novoPonto();
  await escolher(conta.id, [a.pontoId]);
  await criativoAprovado(conta.id);
  const midia = await novaMidia({ pontos: [b.pontoId] });
  const tipo = `midia:${midia.id}`;
  const plA = await playlistAgora(a.telaId);
  const plB = await playlistAgora(b.telaId);
  assert.equal(itensDa(plA, tipo).length, 0, 'a mídia não segue o anunciante');
  assert.ok(itensDa(plB, tipo).length > 0, 'toca na cobertura dela');
  assert.ok(!idsDeAnunciante(plB).has(conta.id), 'e o anunciante não segue a mídia');
});

test('20. frequência por hora: N itens contabilizáveis, N programadas no contador dela; hora fechada não programa', async () => {
  const { ponto, midia, tipo } = await midiaNaTela({ frequencia: 3 });
  const itens = itensDa(await playlistAgora(ponto.telaId), tipo);
  assert.equal(itens.length, 3);
  for (const i of itens) {
    assert.equal(i.contabiliza, true, 'o Player só gera comprovante com contabiliza=true');
    assert.equal(i.anuncianteId, null, 'não é anunciante');
  }
  const [linha] = await contador(midia.id, ponto.telaId);
  assert.equal(linha.vezes_programadas, 3);
  assert.equal(linha.vezes_confirmadas, 0);
  const fechado = { seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null };
  const f = await midiaNaTela({ horario: fechado });
  await playlistAgora(f.ponto.telaId);
  assert.equal((await contador(f.midia.id, f.ponto.telaId)).length, 0, 'TV apagada: nada programado');
});

test('21. mídia criada no meio da hora: entra no fim da hora já congelada, e o esperado conta só da criação', async () => {
  const ponto = await novoPonto();
  const antes = await playlistAgora(ponto.telaId); // congela a hora sem ela
  const midia = await novaMidia({ pontos: [ponto.pontoId], frequencia: 1 });
  const depois = await playlistAgora(ponto.telaId);
  const itens = itensDa(depois, `midia:${midia.id}`);
  assert.equal(itens.length, 1);
  const indice = Number(itens[0].itemProgramacaoId.split('|')[2]);
  assert.ok(indice >= antes.itens.length, 'entra depois de quem já tinha vaga');
  assert.equal((await contador(midia.id, ponto.telaId))[0].vezes_programadas, 1);
  // Esperado: ativa há 30 min em AGORA (24 h), menos os 10 min do comprovante.
  const velha = await midiaAntiga({ horario: HORARIO_24H, frequencia: 2, historico: [['ativa', 0.5]] });
  const m = await metricas(velha.midia.id);
  assert.equal(m.esperadas.hoje, Math.round((20 / 60) * 2 * 10) / 10);
});

test('22. mídia pausada: sai da playlist, o esperado para, o estado vira PAUSADA e o histórico guarda', async () => {
  const { ponto, midia, tipo } = await midiaNaTela();
  assert.equal(itensDa(await playlistAgora(ponto.telaId), tipo).length, 2);
  const programadas = (await contador(midia.id, ponto.telaId))[0].vezes_programadas;
  await midiasRepo.definirSituacao(midia.id, 'pausada');
  assert.equal(itensDa(await playlistAgora(ponto.telaId), tipo).length, 0, 'pausada não toca');
  assert.equal((await contador(midia.id, ponto.telaId))[0].vezes_programadas, programadas, 'o programado da hora fica');
  const m = (await metricasDasMidias([await midiasRepo.buscarPorId(midia.id)])).get(midia.id);
  assert.equal(m.estado, 'PAUSADA');
  const { rows } = await pool.query('SELECT situacao FROM midias_proprias_situacoes WHERE midia_id = $1 ORDER BY id', [
    midia.id,
  ]);
  assert.deepEqual(
    rows.map((r) => r.situacao),
    ['ativa', 'pausada'],
  );
});

test('23. mídia retomada: volta à playlist e o esperado exclui só o tempo pausado', async () => {
  const { ponto, midia, tipo } = await midiaNaTela();
  await midiasRepo.definirSituacao(midia.id, 'pausada');
  await midiasRepo.definirSituacao(midia.id, 'ativa');
  assert.equal(itensDa(await playlistAgora(ponto.telaId), tipo).length, 2, 'retomada toca de novo');
  // Ativa há 40 dias, pausada de −72 h a −24 h (24 h).
  const velha = await midiaAntiga({
    horario: HORARIO_24H,
    frequencia: 1,
    historico: [
      ['ativa', 40 * 24],
      ['pausada', 3 * 24],
      ['ativa', 24],
    ],
  });
  const m = await metricas(velha.midia.id);
  assert.equal(m.esperadas.d7, Math.round((168 - 48 - 1 / 6) * 10) / 10);
});

test('24. período agendado: nada esperado, estado AGENDADA, fora da playlist', async () => {
  const ponto = await novoPonto();
  const futuro = new Date(Date.now() + 2 * 24 * HORA).toISOString();
  const midia = await novaMidia({ pontos: [ponto.pontoId], periodoInicio: futuro });
  assert.equal(itensDa(await playlistAgora(ponto.telaId), `midia:${midia.id}`).length, 0);
  const m = (await metricasDasMidias([await midiasRepo.buscarPorId(midia.id)])).get(midia.id);
  assert.equal(m.estado, 'AGENDADA');
  assert.equal(m.esperadas.d30, 0);
});

test('25. período encerrado: o esperado para no fim do período e o estado é ENCERRADA', async () => {
  const { midia } = await midiaAntiga({ horario: HORARIO_24H, frequencia: 1 });
  await pool.query('UPDATE midias_proprias SET periodo_fim = $2 WHERE id = $1', [
    midia.id,
    new Date(AGORA.getTime() - 48 * HORA),
  ]);
  const m = await metricas(midia.id);
  assert.equal(m.estado, 'ENCERRADA');
  assert.equal(m.esperadas.d7, 120, '7 dias até o fim do período = 120 h × 1');
  assert.equal(m.esperadas.hoje, 0);
});

test('26. ponto offline: fora de operação ou tela sem sinal não entram no esperado; tela muda deixa a entrega atrasada', async () => {
  const { ponto, midia } = await midiaAntiga({ horario: HORARIO_24H, frequencia: 1 });
  assert.ok((await metricas(midia.id)).esperadas.d7 > 0);
  await pool.query(`UPDATE pontos SET status = 'em_reparo' WHERE id = $1`, [ponto.pontoId]);
  assert.equal((await metricas(midia.id)).esperadas.d7, 0, 'ponto em reparo');
  await pool.query(`UPDATE pontos SET status = 'em_operacao' WHERE id = $1`, [ponto.pontoId]);
  await pool.query('UPDATE dispositivos SET primeiro_sinal_em = NULL, provisionado_em = NULL WHERE id = $1', [
    ponto.telaId,
  ]);
  assert.equal((await metricas(midia.id)).esperadas.d7, 0, 'tela que nunca deu sinal');
  await pool.query('UPDATE dispositivos SET primeiro_sinal_em = $2 WHERE id = $1', [
    ponto.telaId,
    new Date(AGORA.getTime() - 24 * HORA),
  ]);
  assert.equal((await metricas(midia.id)).esperadas.d7, Math.round((24 - 1 / 6) * 10) / 10, 'só desde o sinal');
  // Tela ligada que não manda comprovante: a última hora fechada sem nada.
  const m = await metricas(midia.id);
  assert.equal(m.confirmadas.d7, 0);
  assert.equal(m.estado, 'ATIVA_ENTREGA_ATRASADA');
});

test('27. mais de uma tela: cada tela tem a frequência dela (esperado e programado por tela)', async () => {
  const { ponto, midia } = await midiaAntiga({ horario: HORARIO_24H, frequencia: 1 });
  const umaTela = (await metricas(midia.id)).esperadas.d7;
  const segunda = await outraTela(ponto.pontoId);
  await pool.query('UPDATE dispositivos SET primeiro_sinal_em = $2 WHERE id = $1', [
    segunda.telaId,
    new Date(AGORA.getTime() - 60 * 24 * HORA),
  ]);
  const m = await metricas(midia.id, { detalhe: true });
  assert.ok(Math.abs(m.esperadas.d7 - umaTela * 2) <= 0.1, `${m.esperadas.d7} ≈ 2 × ${umaTela}`);
  assert.equal(m.porTela.length, 2);
  assert.equal(m.porPonto.length, 1, 'as duas telas somam no ponto');
  assert.ok(Math.abs(m.porPonto[0].esperadas30d - (m.porTela[0].esperadas30d + m.porTela[1].esperadas30d)) <= 0.1);
  const tipo = `midia:${midia.id}`;
  assert.equal(itensDa(await playlistAgora(ponto.telaId), tipo).length, 1);
  assert.equal(itensDa(await playlistAgora(segunda.telaId), tipo).length, 1);
});

test('28. POP duplicado: mesmo execucaoId conta uma vez; teto e janela desconhecida; entrega comercial intocada', async () => {
  const { ponto, midia, tipo } = await midiaNaTela({ frequencia: 1 });
  const pl = await playlistAgora(ponto.telaId);
  const item = itensDa(pl, tipo)[0];
  const ev = evento(item);
  const comercial = async () =>
    (
      await pool.query(
        'SELECT COALESCE(SUM(vezes_confirmadas), 0)::int AS n FROM exibicoes_contador WHERE dispositivo_id = $1',
        [ponto.telaId],
      )
    ).rows[0].n;
  const comercialAntes = await comercial();
  assert.equal((await enviarPop(ponto.player, [ev])).json.resultados[0].status, 'contabilizado');
  assert.equal((await enviarPop(ponto.player, [ev])).json.resultados[0].status, 'duplicado');
  assert.equal((await enviarPop(ponto.player, [ev, ev])).json.resultados[0].status, 'duplicado');
  assert.equal((await contador(midia.id, ponto.telaId))[0].vezes_confirmadas, 1);
  assert.equal((await enviarPop(ponto.player, [evento(item)])).json.resultados[0].status, 'teto_atingido');
  const outra = await midiaNaTela();
  const r = await enviarPop(ponto.player, [
    evento({ itemProgramacaoId: `${pl.janelaId}|0|midia:${outra.midia.id}`, criativoId: '1' }),
    evento({ itemProgramacaoId: `${pl.janelaId}|0|midia:0`, criativoId: '1' }),
  ]);
  assert.deepEqual(
    r.json.resultados.map((x) => x.status),
    ['janela_desconhecida', 'item_invalido'],
  );
  assert.equal(await comercial(), comercialAntes, 'exibicoes_contador intocado');
  // Sem anunciante falso: nenhuma linha de entrega comercial desta tela em
  // nome de conta nenhuma que não seja anunciante de verdade (a conta
  // própria da Mostraí nunca aparece). Contar a tabela `anunciantes` inteira
  // não serve: outros arquivos de teste criam contas em paralelo.
  const propria = await anunciantesRepo.ensureContaMostrai();
  const { rows: falsos } = await pool.query(
    `SELECT e.anunciante_id FROM exibicoes_contador e JOIN anunciantes a ON a.id = e.anunciante_id
      WHERE e.dispositivo_id = $1 AND (a.conta_propria OR a.id = $2)`,
    [ponto.telaId, propria.id],
  );
  assert.equal(falsos.length, 0, 'sem anunciante falso');
});

test('29. percentual esperado × confirmado (e programadas × confirmadas por período)', async () => {
  const { ponto, midia } = await midiaAntiga({ horario: HORARIO_24H, frequencia: 1 });
  const t = (h) => horaCheia(AGORA.getTime() - h * HORA);
  await hora(midia.id, ponto.telaId, ponto.pontoId, t(24), 90, 84);
  await hora(midia.id, ponto.telaId, ponto.pontoId, t(20 * 24), 10, 10);
  const m = await metricas(midia.id);
  // 7 dias × 24 h × 1/h − 10 min = 167,8 esperadas; 84 confirmadas → 50%.
  assert.equal(m.esperadas.d7, Math.round((168 - 1 / 6) * 10) / 10);
  assert.equal(m.confirmadas.d7, 84);
  assert.equal(m.programadas.d7, 90);
  assert.equal(m.entregaPct.d7, Math.round((84 / (168 - 1 / 6)) * 100));
  assert.equal(m.entregaPct.d30, Math.round((94 / (720 - 1 / 6)) * 100));
  assert.ok(m.esperadas.d7 < 7 * 24 * 2, 'nunca frequência × 24 × tudo');
  // Horário real: seg–sex 08–18 → 49h50 abertas nos 7 dias até AGORA − 10 min.
  const comercial = await midiaAntiga({ horario: HORARIO_COMERCIAL, frequencia: 2 });
  assert.equal((await metricas(comercial.midia.id)).esperadas.d7, Math.round((6 + 40 + 3 + 50 / 60) * 2 * 10) / 10);
});

test('30. última exibição (e primeira): do comprovante; estado aguardando → reproduzindo → atrasada', async () => {
  const { ponto, midia } = await midiaAntiga({ horario: HORARIO_24H, historico: [['ativa', 0.5]] });
  let m = await metricas(midia.id);
  assert.equal(m.ultimaExibicaoEm, null);
  assert.equal(m.estado, 'ATIVA_AGUARDANDO_PRIMEIRA_EXIBICAO');
  assert.equal(m.primeiraJanelaPrevista, '2026-09-28T15:00:00.000Z');
  m = await metricas(midia.id, { agora: new Date('2026-09-28T16:30:00Z') });
  assert.equal(m.estado, 'ATIVA_ENTREGA_ATRASADA', 'prazo passou sem comprovante');
  await hora(
    midia.id,
    ponto.telaId,
    ponto.pontoId,
    new Date('2026-09-28T15:00:00Z'),
    2,
    2,
    new Date('2026-09-28T15:20:00Z'),
  );
  await hora(
    midia.id,
    ponto.telaId,
    ponto.pontoId,
    new Date('2026-09-28T16:00:00Z'),
    2,
    1,
    new Date('2026-09-28T16:05:00Z'),
  );
  m = await metricas(midia.id, { agora: new Date('2026-09-28T17:30:00Z') });
  assert.equal(m.estado, 'ATIVA_REPRODUZINDO');
  assert.equal(m.ultimaExibicaoEm, '2026-09-28T16:05:00.000Z');
  assert.equal(m.primeiraExibicaoEm, '2026-09-28T15:20:00.000Z');
  m = await metricas(midia.id, { agora: new Date('2026-09-28T18:30:00Z') });
  assert.equal(m.estado, 'ATIVA_ENTREGA_ATRASADA', 'a hora seguinte fechou sem nada');
});

test('31. métricas por ponto (e por tela) na ficha do admin; o card traz o resumo', async () => {
  const { ponto, midia } = await midiaAntiga({ horario: HORARIO_24H, frequencia: 1 });
  const agora = Date.now();
  await hora(midia.id, ponto.telaId, ponto.pontoId, horaCheia(agora - 2 * HORA), 1, 1, new Date(agora - 90 * 60_000));
  const lista = await app.chamar('GET', '/admin/midias-proprias');
  assert.equal(lista.status, 200, lista.texto);
  const card = lista.json.find((x) => x.id === midia.id).metricas;
  assert.equal(card.confirmadas.total, 1);
  assert.ok(card.ultimaExibicaoEm);
  assert.equal(typeof card.entregaPct.d30, 'number');
  assert.ok(card.estado);
  const ficha = await app.chamar('GET', `/admin/midias-proprias/${midia.id}`);
  const d = ficha.json.metricas;
  assert.equal(d.porPonto.length, 1);
  assert.equal(d.porPonto[0].pontoId, ponto.pontoId);
  assert.equal(d.porPonto[0].confirmadas30d, 1);
  assert.ok(d.porPonto[0].esperadas30d > 0);
  assert.equal(d.porTela[0].dispositivoId, ponto.telaId);
  assert.ok(d.entregaPct.d30 >= 0 && d.entregaPct.d30 <= 100);
});
