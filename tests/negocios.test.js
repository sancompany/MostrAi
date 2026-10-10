require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const ffmpeg = require('../src/lib/ffmpeg');
const gerador = require('../src/playlist/gerador');
const dispositivosRepo = require('../src/dispositivos/repository');
const pontosRepo = require('../src/pontos/repository');
const negocios = require('../src/anunciantes/negocios');
const obrigacaoDoCiclo = require('../src/bancohoras/obrigacao-do-ciclo');
const { instalarPlayer, tirarDoSorteio } = require('./apoio-player');

// Negócio ou marca por criativo (migration 121, estação de 10/10/2026).
//
// A CONTA contrata e paga (um plano, um saldo, um limite de peças); o
// NEGÓCIO é quem aparece na peça, com a categoria que a Mostraí validou — e
// é ela que a proteção contra concorrentes compara, peça por peça. Os
// números entre colchetes são os itens da lista de testes obrigatórios do
// pedido.
//
// FFmpeg falso, como em upload-criativo.test.js: o CI não tem FFmpeg, e o
// que se testa aqui é a regra, não o vídeo.

ffmpeg.probeMidia = async () => ({ width: 1080, height: 1920, duracao_segundos: 10, ehImagem: false });
ffmpeg.normalizar = async (_caminho, criativoId) => ({
  arquivo_normalizado_url: `https://storage.teste/${criativoId}.mp4`,
  thumbnail_url: `https://storage.teste/${criativoId}-thumb.jpg`,
  duracao_segundos: 10,
  conteudo_sha256: 'b'.repeat(64),
  conteudo_bytes: 1234,
  tempos: {},
});

// ---------------------------------------------------------------------------
// App com as rotas reais; sessão por cabeçalho (cliente e Admin)
// ---------------------------------------------------------------------------
let base;
let servidor;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-negocios', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    if (req.headers['x-admin']) req.session.adminUsuario = req.headers['x-admin'];
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/admin/routes'));
  app.use(require('../src/categorias/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
});

test.after(async () => {
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  const contas = criados.contas;
  const telas = criados.telas.map((t) => t.dispositivo.id);
  for (const tabela of ['execucoes_confirmadas', 'exibicoes_contador', 'playlist_hora_congelada']) {
    await pool.query(`DELETE FROM ${tabela} WHERE dispositivo_id = ANY($1::int[])`, [telas]);
  }
  for (const tabela of ['anunciantes_pontos', 'exibicoes_contador', 'notificacoes', 'eventos', 'email_outbox']) {
    await pool.query(`DELETE FROM ${tabela} WHERE anunciante_id = ANY($1::int[])`, [contas]);
  }
  await pool.query('DELETE FROM indisponibilidade_cliente WHERE anunciante_id = ANY($1::int[])', [contas]);
  for (const t of criados.telas) await dispositivosRepo.deletar(t.dispositivo.id);
  await pool.query('DELETE FROM pontos WHERE id = ANY($1::int[])', [criados.telas.map((t) => t.ponto.id)]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = ANY($1::int[])', [contas]);
  await pool.query('DELETE FROM anunciantes WHERE id = ANY($1::int[])', [contas]);
  if (criados.categorias.length) {
    await pool.query('DELETE FROM categorias WHERE id = ANY($1::int[])', [criados.categorias]);
  }
});

async function chamar(metodo, caminho, { conta, admin, corpo } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (conta) headers['x-conta'] = String(conta.id ?? conta);
  if (admin) {
    headers['x-admin'] = admin;
    headers['cf-access-authenticated-user-email'] = `${admin}@mostrai.test`;
  }
  const r = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers,
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// Envio do cliente pelo formulário real (multipart), com os campos do
// "Quem este anúncio divulga?".
async function enviar(conta, campos = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
  form.append('arquivo', new Blob([Buffer.from('video')], { type: 'video/mp4' }), 'peca.mp4');
  const r = await fetch(`${base}/anunciantes/${conta.id}/criativos`, {
    method: 'POST',
    headers: { 'x-conta': String(conta.id) },
    body: form,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}

// ---------------------------------------------------------------------------
// Dados (limpos no fim)
// ---------------------------------------------------------------------------
const criados = { contas: [], telas: [], categorias: [] };

async function idDaCategoria(nome) {
  const { rows } = await pool.query('SELECT id FROM categorias WHERE nome = $1', [nome]);
  if (!rows[0]) throw new Error(`categoria "${nome}" não existe`);
  return rows[0].id;
}

async function novaConta({ plano = 'maximo-1m', categoria = null, nome } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, plano_id, data_inicio_cobertura, data_expiracao, categoria_id)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante'], true, $4, now(), now() + interval '20 days', $5)
     RETURNING *`,
    [
      nome || `Academia ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `neg-${randomUUID()}@example.com`,
      plano,
      categoria,
    ],
  );
  criados.contas.push(rows[0].id);
  return rows[0];
}

async function telaNoPonto(categoriaId) {
  const ponto = await pontosRepo.criar({
    nome: `Ponto Neg ${randomUUID()}`,
    endereco: 'Rua Y, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'Teste',
    responsavel_nome: 'Fulano',
    responsavel_contato: '16999990000',
    categoria_id: categoriaId,
  });
  await tirarDoSorteio(ponto.id);
  const criado = await dispositivosRepo.criar(ponto.id, { apelido: `Neg ${randomUUID()}` });
  await dispositivosRepo.atualizar(criado.id, { status: 'ativo' });
  await instalarPlayer(criado.id);
  const tela = { ponto, dispositivo: await dispositivosRepo.buscarComPonto(criado.id) };
  criados.telas.push(tela);
  return tela;
}

const escolherPonto = (conta, ponto) =>
  pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [
    conta.id,
    ponto.id,
  ]);

// Peça aprovada pela fila do Admin (valida o negócio com o operador).
async function aprovar(criativoId, extra = {}) {
  return chamar('PATCH', `/admin/criativos/${criativoId}`, {
    admin: 'operador-teste',
    corpo: { status: 'aprovado', ...extra },
  });
}

async function criativosNaPlaylist(dispositivo) {
  const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
  // O item leva o id da peça como texto (contrato do Player).
  return envelope.itens.filter((i) => i.anuncianteId).map((i) => Number(i.criativoId));
}

const linha = async (tabela, id) => (await pool.query(`SELECT * FROM ${tabela} WHERE id = $1`, [id])).rows[0];

// ---------------------------------------------------------------------------
// Migração e negócio principal
// ---------------------------------------------------------------------------

test('[1][2] conta ganha o negócio principal com o próprio nome e categoria; criativo sem negócio fica nele', async () => {
  const restaurante = await idDaCategoria('Restaurante');
  const conta = await novaConta({ categoria: restaurante, nome: `Academia da Boêmia ${randomUUID().slice(0, 6)}` });
  const principalId = await negocios.principalDaConta(conta.id);
  const principal = await linha('negocios', principalId);
  assert.strictEqual(principal.nome, conta.nome_empresa);
  assert.strictEqual(principal.categoria_id, restaurante);
  assert.strictEqual(principal.principal, true);
  assert.strictEqual(principal.validado_em, null, 'conta nova: a categoria ainda é só a palavra do cliente');
  // Criativo gravado sem dizer o negócio (caminho antigo, script): principal.
  const { rows } = await pool.query(
    `INSERT INTO criativos (anunciante_id, arquivo_original_url) VALUES ($1, 'antigo.mp4') RETURNING negocio_id`,
    [conta.id],
  );
  assert.strictEqual(rows[0].negocio_id, principalId);
  // Uma vez só: o principal não duplica.
  assert.strictEqual(await negocios.principalDaConta(conta.id), principalId);
});

test('[1] principal ainda não validado acompanha o cadastro; validado, não muda pelo perfil', async () => {
  const conta = await novaConta({ categoria: await idDaCategoria('Restaurante') });
  const principalId = await negocios.principalDaConta(conta.id);
  const pizzaria = await idDaCategoria('Pizzaria');
  await pool.query('UPDATE anunciantes SET categoria_id = $2 WHERE id = $1', [conta.id, pizzaria]);
  assert.strictEqual((await linha('negocios', principalId)).categoria_id, pizzaria);
  const env = await enviar(conta);
  assert.strictEqual((await aprovar(env.json.id)).status, 200);
  const academia = await idDaCategoria('Academia');
  // [25] O cliente muda a categoria pelo perfil: o negócio validado não muda.
  const r = await chamar('PATCH', '/anunciantes/me', { conta, corpo: { categoria_id: academia } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await linha('negocios', principalId)).categoria_id, pizzaria);
});

// ---------------------------------------------------------------------------
// Envio: uma marca, várias marcas, limite da conta
// ---------------------------------------------------------------------------

test('[3][30] conta de um negócio só: lista tem só o principal, envio sem negócio vai pra ele e veicula como antes', async () => {
  const academia = await idDaCategoria('Academia');
  const conta = await novaConta({ plano: 'essencial-1m', categoria: academia });
  const tela = await telaNoPonto(await idDaCategoria('Cafeteria'));
  await escolherPonto(conta, tela.ponto);
  const lista = await chamar('GET', '/anunciantes/me/negocios', { conta });
  assert.strictEqual(lista.status, 200);
  assert.strictEqual(lista.json.negocios.length, 1);
  assert.strictEqual(lista.json.negocios[0].principal, true);
  const env = await enviar(conta);
  assert.strictEqual(env.status, 201);
  assert.strictEqual(env.json.negocio_id, lista.json.negocios[0].id);
  assert.strictEqual((await aprovar(env.json.id)).status, 200);
  assert.ok((await criativosNaPlaylist(tela.dispositivo)).includes(env.json.id));
});

test('[4][5][6][7][8] negócio novo nasce no envio, na mesma conta, sem assinatura, saldo ou obrigação', async () => {
  const conta = await novaConta({ categoria: await idDaCategoria('Restaurante') });
  const contar = async () => {
    const q = async (sql) => (await pool.query(sql, [conta.id])).rows[0].n;
    return {
      assinaturas: await q('SELECT count(*)::int AS n FROM assinaturas WHERE anunciante_id = $1'),
      obrigacoes: await q('SELECT count(*)::int AS n FROM obrigacoes_veiculacao WHERE anunciante_id = $1'),
      cobrancas: await q('SELECT count(*)::int AS n FROM cobrancas_confirmadas WHERE anunciante_id = $1'),
      saldoHospedagem: await q('SELECT count(*)::int AS n FROM saldo_hospedagem_lancamentos WHERE conta_id = $1'),
      // Nenhuma conta nova com o nome do negócio (contar a tabela inteira
      // quebrava com os outros arquivos de teste criando contas em paralelo).
      contas: (await pool.query(`SELECT count(*)::int AS n FROM anunciantes WHERE nome_empresa ILIKE 'Academia Pizza'`))
        .rows[0].n,
    };
  };
  const antes = await contar();
  const pizzaria = await idDaCategoria('Pizzaria');
  const env = await enviar(conta, {
    negocio_nome: 'Academia Pizza',
    negocio_categoria_id: pizzaria,
    negocio_mesmo_grupo: '1',
  });
  assert.strictEqual(env.status, 201, JSON.stringify(env.json));
  const negocio = await linha('negocios', env.json.negocio_id);
  assert.strictEqual(negocio.anunciante_id, conta.id);
  assert.strictEqual(negocio.nome, 'Academia Pizza');
  assert.strictEqual(negocio.categoria_id, pizzaria);
  assert.strictEqual(negocio.principal, false);
  assert.ok(negocio.mesmo_grupo_declarado_em, 'a declaração do cliente fica registrada');
  assert.strictEqual(negocio.validado_em, null);
  const depois = await contar();
  assert.deepStrictEqual(depois, antes);
  assert.strictEqual(depois.contas, 0);
  // Sem a declaração de mesmo responsável/grupo, não nasce.
  const sem = await enviar(conta, { negocio_nome: 'Outra Marca', negocio_categoria_id: pizzaria });
  assert.strictEqual(sem.status, 400);
  assert.match(sem.json.erro, /mesmo responsável ou grupo/);
});

test('[9][11][12][27] Prime: 3 criativos ativos no TOTAL, com 1 ou 3 negócios; o 4º é recusado', async () => {
  const conta = await novaConta({ plano: 'maximo-1m', categoria: await idDaCategoria('Restaurante') });
  const pizza = await enviar(conta, {
    negocio_nome: 'Academia Pizza',
    negocio_categoria_id: await idDaCategoria('Pizzaria'),
    negocio_mesmo_grupo: '1',
  });
  const burger = await enviar(conta, {
    negocio_nome: 'Academia Burger',
    negocio_categoria_id: await idDaCategoria('Lanchonete / Hamburgueria'),
    negocio_mesmo_grupo: '1',
  });
  // [11] O mesmo negócio pode ter mais de uma peça, dentro do limite.
  const pizza2 = await enviar(conta, { negocio_id: pizza.json.negocio_id });
  assert.deepStrictEqual([pizza.status, burger.status, pizza2.status], [201, 201, 201]);
  assert.strictEqual(pizza2.json.negocio_id, pizza.json.negocio_id);
  const quarto = await enviar(conta, {
    negocio_nome: 'Academia Sorvete',
    negocio_categoria_id: await idDaCategoria('Sorveteria'),
    negocio_mesmo_grupo: '1',
  });
  // Recusado pelo teto da conta (3 cadastrados) — o mesmo número do plano.
  assert.strictEqual(quarto.status, 400);
  assert.match(quarto.json.erro, /3 criativo/);
  // [12] Uma conta, um plano: nada de plano por marca.
  const { rows } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [conta.id]);
  assert.strictEqual(rows[0].plano_id, 'maximo-1m');
  // Envio recusado não deixa negócio novo pra trás.
  const { rows: sorvete } = await pool.query(
    "SELECT 1 FROM negocios WHERE anunciante_id = $1 AND nome = 'Academia Sorvete'",
    [conta.id],
  );
  assert.strictEqual(sorvete.length, 0);
});

test('[10] três marcas no Prime não triplicam as inserções da conta na tela', async () => {
  const academia = await idDaCategoria('Academia');
  const tela = await telaNoPonto(await idDaCategoria('Cafeteria'));
  const umaMarca = await novaConta({ plano: 'maximo-1m', categoria: academia });
  const tresMarcas = await novaConta({ plano: 'maximo-1m', categoria: academia });
  for (const conta of [umaMarca, tresMarcas]) await escolherPonto(conta, tela.ponto);
  for (let i = 0; i < 3; i++) {
    const a = await enviar(umaMarca);
    await aprovar(a.json.id);
    const b = await enviar(tresMarcas, {
      negocio_nome: `Marca ${i}`,
      negocio_categoria_id: academia,
      negocio_mesmo_grupo: '1',
    });
    await aprovar(b.json.id);
  }
  const envelope = await gerador.gerarPlaylistDaHora(tela.dispositivo, new Date());
  const de = (conta) => envelope.itens.filter((x) => x.anuncianteId === conta.id).length;
  assert.ok(de(umaMarca) > 0);
  assert.strictEqual(de(tresMarcas), de(umaMarca), 'o plano compra segundos da CONTA, não por marca');
});

test('[23][24] negócio de outra conta: recusado no envio, no reenvio e pelo próprio banco', async () => {
  const dona = await novaConta();
  const intrusa = await novaConta();
  const env = await enviar(dona, {
    negocio_nome: 'Marca da Dona',
    negocio_categoria_id: await idDaCategoria('Pizzaria'),
    negocio_mesmo_grupo: '1',
  });
  const alheio = env.json.negocio_id;
  const r = await enviar(intrusa, { negocio_id: alheio });
  assert.strictEqual(r.status, 404);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM criativos WHERE anunciante_id = $1', [intrusa.id]);
  assert.strictEqual(rows[0].n, 0, 'nada foi criado');
  await assert.rejects(
    pool.query(`INSERT INTO criativos (anunciante_id, arquivo_original_url, negocio_id) VALUES ($1, 'x.mp4', $2)`, [
      intrusa.id,
      alheio,
    ]),
    /criativos_negocio_da_conta/,
  );
  // Reenvio de peça em correção apontando pro negócio alheio.
  const propria = await enviar(intrusa);
  await chamar('PATCH', `/admin/criativos/${propria.json.id}`, {
    admin: 'op',
    corpo: { status: 'correcao', motivo_reprovacao: 'categoria errada' },
  });
  const re = await chamar('POST', `/anunciantes/me/criativos/${propria.json.id}/reenviar`, {
    conta: intrusa,
    corpo: { negocio_id: alheio },
  });
  assert.strictEqual(re.status, 404);
  assert.strictEqual((await linha('criativos', propria.json.id)).status, 'correcao');
  // Editar o negócio de outra conta também não.
  const ed = await chamar('PATCH', `/anunciantes/me/negocios/${alheio}`, { conta: intrusa, corpo: { nome: 'Minha' } });
  assert.strictEqual(ed.status, 404);
});

// ---------------------------------------------------------------------------
// Aprovação no Admin
// ---------------------------------------------------------------------------

test('[13] a fila do Admin mostra conta, negócio e categoria declarada', async () => {
  const conta = await novaConta();
  const env = await enviar(conta, {
    negocio_nome: 'Academia Pizza',
    negocio_categoria_id: await idDaCategoria('Pizzaria'),
    negocio_mesmo_grupo: '1',
  });
  const fila = await chamar('GET', '/admin/criativos?status=pendente', { admin: 'op' });
  const item = fila.json.find((c) => c.id === env.json.id);
  assert.strictEqual(item.anunciante_id, conta.id);
  assert.strictEqual(item.negocio_nome, 'Academia Pizza');
  assert.strictEqual(item.negocio_categoria_nome, 'Pizzaria');
  assert.strictEqual(item.negocio_validado_em, null);
});

test('[15][16] correção necessária: pede com mensagem, o cliente corrige e a peça volta pra análise', async () => {
  const conta = await novaConta({ categoria: await idDaCategoria('Restaurante') });
  const env = await enviar(conta, {
    negocio_nome: 'Academia Pizza',
    negocio_categoria_id: await idDaCategoria('Restaurante'),
    negocio_mesmo_grupo: '1',
  });
  const semMotivo = await chamar('PATCH', `/admin/criativos/${env.json.id}`, {
    admin: 'op',
    corpo: { status: 'correcao' },
  });
  assert.strictEqual(semMotivo.status, 400);
  const motivo = 'A categoria informada não corresponde ao negócio anunciado.';
  const r = await chamar('PATCH', `/admin/criativos/${env.json.id}`, {
    admin: 'op',
    corpo: { status: 'correcao', motivo_reprovacao: motivo },
  });
  assert.strictEqual(r.status, 200);
  const lista = await chamar('GET', '/anunciantes/me/criativos', { conta });
  const peca = lista.json.criativos.find((c) => c.id === env.json.id);
  assert.strictEqual(peca.situacao, 'correcao_necessaria');
  assert.strictEqual(peca.motivoCorrecao, motivo);
  assert.strictEqual(peca.negocio.nome, 'Academia Pizza');
  // Ocupa a vaga do plano, como a peça em análise.
  assert.strictEqual(lista.json.emUso, 1);
  // O cliente corrige a categoria do negócio (ainda não validado) e reenvia.
  const pizzaria = await idDaCategoria('Pizzaria');
  const ed = await chamar('PATCH', `/anunciantes/me/negocios/${env.json.negocio_id}`, {
    conta,
    corpo: { categoria_id: pizzaria },
  });
  assert.strictEqual(ed.status, 200);
  const re = await chamar('POST', `/anunciantes/me/criativos/${env.json.id}/reenviar`, { conta, corpo: {} });
  assert.strictEqual(re.status, 200);
  const depois = await linha('criativos', env.json.id);
  assert.strictEqual(depois.status, 'pendente');
  assert.strictEqual(depois.motivo_reprovacao, null);
  assert.strictEqual((await linha('negocios', env.json.negocio_id)).categoria_id, pizzaria);
  // Peça aprovada não volta pra correção.
  await aprovar(env.json.id);
  const tarde = await chamar('PATCH', `/admin/criativos/${env.json.id}`, {
    admin: 'op',
    corpo: { status: 'correcao', motivo_reprovacao: 'x' },
  });
  assert.strictEqual(tarde.status, 409);
});

test('correção necessária é responsabilidade do cliente na obrigação (decisão do dono)', async () => {
  const conta = await novaConta();
  const env = await enviar(conta);
  assert.strictEqual(await obrigacaoDoCiclo.motivoDeIndisponibilidadeDoCliente(conta.id), null, 'em análise');
  await chamar('PATCH', `/admin/criativos/${env.json.id}`, {
    admin: 'op',
    corpo: { status: 'correcao', motivo_reprovacao: 'categoria errada' },
  });
  assert.strictEqual(await obrigacaoDoCiclo.motivoDeIndisponibilidadeDoCliente(conta.id), 'sem_criativo_disponivel');
});

test('[17] reprovar guarda o motivo', async () => {
  const conta = await novaConta();
  const env = await enviar(conta);
  const r = await chamar('PATCH', `/admin/criativos/${env.json.id}`, {
    admin: 'op',
    corpo: { status: 'reprovado', motivo_reprovacao: 'peça de outra empresa' },
  });
  assert.strictEqual(r.status, 200);
  const c = await linha('criativos', env.json.id);
  assert.strictEqual(c.status, 'reprovado');
  assert.strictEqual(c.motivo_reprovacao, 'peça de outra empresa');
});

test('[18] "alterar categoria e aprovar": auditoria com declarada, final, operador, quando e motivo', async () => {
  const conta = await novaConta();
  const restaurante = await idDaCategoria('Restaurante');
  const pizzaria = await idDaCategoria('Pizzaria');
  const env = await enviar(conta, {
    negocio_nome: 'Academia Pizza',
    negocio_categoria_id: restaurante,
    negocio_mesmo_grupo: '1',
  });
  const semMotivo = await aprovar(env.json.id, { categoria_id: pizzaria });
  assert.strictEqual(semMotivo.status, 400);
  assert.strictEqual((await linha('criativos', env.json.id)).status, 'pendente', 'nada mudou');
  const r = await aprovar(env.json.id, { categoria_id: pizzaria, motivo_categoria: 'a peça divulga uma pizzaria' });
  assert.strictEqual(r.status, 200);
  const negocio = await linha('negocios', env.json.negocio_id);
  assert.strictEqual(negocio.categoria_id, pizzaria);
  assert.ok(negocio.validado_em);
  assert.strictEqual(negocio.validado_por, 'operador-teste');
  const { rows } = await pool.query('SELECT * FROM negocios_validacoes WHERE negocio_id = $1', [negocio.id]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].acao, 'categoria_corrigida');
  assert.strictEqual(rows[0].categoria_antes_nome, 'Restaurante');
  assert.strictEqual(rows[0].categoria_depois_nome, 'Pizzaria');
  assert.strictEqual(rows[0].operador, 'operador-teste');
  assert.strictEqual(rows[0].operador_access, 'operador-teste@mostrai.test');
  assert.strictEqual(rows[0].motivo, 'a peça divulga uma pizzaria');
  assert.strictEqual(rows[0].criativo_id, env.json.id);
  assert.ok(rows[0].criado_em);
});

test('negócio sem categoria (o cliente não achou a dele) só é aprovado com a categoria escolhida pela Mostraí', async () => {
  const conta = await novaConta();
  const env = await enviar(conta, {
    negocio_nome: 'Academia Coisas',
    negocio_categoria_livre: 'loja de coisas',
    negocio_mesmo_grupo: '1',
  });
  assert.strictEqual(env.status, 201);
  const r = await aprovar(env.json.id);
  assert.strictEqual(r.status, 400);
  assert.match(r.json.erro, /categoria/);
  const ok = await aprovar(env.json.id, {
    categoria_id: await idDaCategoria('Utilidades domésticas'),
    motivo_categoria: 'classificada pela Mostraí',
  });
  assert.strictEqual(ok.status, 200);
  const negocio = await linha('negocios', env.json.negocio_id);
  assert.strictEqual(negocio.categoria_livre, null);
  assert.ok(negocio.validado_em);
});

// Revisão do PR #133 (Codex): o upload do operador valida o negócio mesmo
// sem categoria; a peça seguinte do cliente, pela fila, não pode pegar
// carona nessa validação e entrar no ar sem categoria nenhuma.
test('negócio validado sem categoria: peça nova do cliente ainda exige a categoria; recolocar no ar não', async () => {
  const conta = await novaConta();
  const form = new FormData();
  form.append('arquivo', new Blob([Buffer.from('video')], { type: 'video/mp4' }), 'peca.mp4');
  const r = await fetch(`${base}/admin/anunciantes/${conta.id}/criativos`, {
    method: 'POST',
    headers: { 'x-admin': 'operador-teste' },
    body: form,
  });
  const doOperador = await r.json();
  assert.strictEqual(r.status, 201);
  const principal = await linha('negocios', doOperador.negocio_id);
  assert.ok(principal.validado_em, 'o upload do operador valida o negócio');
  assert.strictEqual(principal.categoria_id, null);
  // Peça do operador retirada e recolocada: não é aprovação nova.
  await chamar('PATCH', `/admin/criativos/${doOperador.id}`, { admin: 'op', corpo: { status: 'retirado' } });
  const recolocada = await aprovar(doOperador.id);
  assert.strictEqual(recolocada.status, 200);
  // Peça nova do cliente, mesmo negócio: só com a categoria.
  const env = await enviar(conta);
  assert.strictEqual(env.json.negocio_id, doOperador.negocio_id);
  const semCategoria = await aprovar(env.json.id);
  assert.strictEqual(semCategoria.status, 400);
  assert.match(semCategoria.json.erro, /categoria/);
  assert.strictEqual((await linha('criativos', env.json.id)).status, 'pendente');
  const ok = await aprovar(env.json.id, {
    categoria_id: await idDaCategoria('Academia'),
    motivo_categoria: 'classificada pela Mostraí',
  });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await linha('negocios', doOperador.negocio_id)).categoria_id, await idDaCategoria('Academia'));
});

// Revisão do PR #133 (Codex): conta nova ainda sem o principal criado manda
// um negócio "adicional" com o nome da própria empresa. Sem criar o
// principal antes, o adicional ocupava o nome e o principal nunca mais
// nascia (o GET da lista quebrava).
test('negócio adicional com o nome da conta, antes de existir o principal: recusado; a lista segue de pé', async () => {
  const conta = await novaConta({ categoria: await idDaCategoria('Academia') });
  assert.strictEqual(
    (await pool.query('SELECT count(*)::int AS n FROM negocios WHERE anunciante_id = $1', [conta.id])).rows[0].n,
    0,
    'conta nova: o principal ainda não existe',
  );
  const env = await enviar(conta, {
    negocio_nome: conta.nome_empresa,
    negocio_categoria_id: await idDaCategoria('Pizzaria'),
    negocio_mesmo_grupo: '1',
  });
  assert.strictEqual(env.status, 409);
  const lista = await chamar('GET', '/anunciantes/me/negocios', { conta });
  assert.strictEqual(lista.status, 200);
  assert.deepStrictEqual(
    lista.json.negocios.map((n) => [n.nome, n.principal]),
    [[conta.nome_empresa, true]],
  );
});

// Revisão do PR #133 (Codex): o Admin escolhe, no upload pela ficha, qual
// negócio da conta a peça divulga; e a validação do negócio só fica se a
// peça ficar aprovada (mesma transação).
test('upload do Admin: peça no negócio escolhido; falhou a aprovação, o negócio não fica validado', async () => {
  const conta = await novaConta({ categoria: await idDaCategoria('Academia') });
  const env = await enviar(conta, {
    negocio_nome: 'Academia Pizza',
    negocio_categoria_id: await idDaCategoria('Pizzaria'),
    negocio_mesmo_grupo: '1',
  });
  assert.strictEqual(env.status, 201);
  const uploadDoAdmin = async (campos = {}) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(campos)) form.append(k, String(v));
    form.append('arquivo', new Blob([Buffer.from('video')], { type: 'video/mp4' }), 'peca.mp4');
    const r = await fetch(`${base}/admin/anunciantes/${conta.id}/criativos`, {
      method: 'POST',
      headers: { 'x-admin': 'operador-teste' },
      body: form,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  // A aprovação final falha: nada da validação fica.
  const criativosRepo = require('../src/anunciantes/criativos-repository');
  const atualizar = criativosRepo.atualizar;
  criativosRepo.atualizar = async (id, dados, db) => {
    if (dados.status === 'aprovado') throw new Error('falha simulada na aprovação');
    return atualizar(id, dados, db);
  };
  let falhou;
  try {
    falhou = await uploadDoAdmin({ negocio_id: env.json.negocio_id });
  } finally {
    criativosRepo.atualizar = atualizar;
  }
  assert.strictEqual(falhou.status, 400);
  assert.strictEqual((await linha('negocios', env.json.negocio_id)).validado_em, null);
  const auditoria = await pool.query('SELECT count(*)::int AS n FROM negocios_validacoes WHERE negocio_id = $1', [
    env.json.negocio_id,
  ]);
  assert.strictEqual(auditoria.rows[0].n, 0);
  // Sem falha: a peça do Admin vai pro negócio escolhido, aprovada e validada.
  const ok = await uploadDoAdmin({ negocio_id: env.json.negocio_id });
  assert.strictEqual(ok.status, 201);
  assert.strictEqual(ok.json.negocio_id, env.json.negocio_id);
  assert.strictEqual(ok.json.status, 'aprovado');
  assert.ok((await linha('negocios', env.json.negocio_id)).validado_em);
});

// Revisão do PR #133 (Codex): a substituta herda o negócio da peça que ela
// troca — não há negócio nem categoria pro cliente corrigir. Em "correção",
// ela sumiria de toda checagem de "substituta em análise" e a conta poderia
// mandar outra; se não serve, o Admin recusa.
test('substituta não vai para correção', async () => {
  const conta = await novaConta({ categoria: await idDaCategoria('Academia') });
  const original = await enviar(conta);
  await aprovar(original.json.id);
  const substituta = await enviar(conta, { substitui: original.json.id });
  assert.strictEqual(substituta.status, 201);
  const r = await chamar('PATCH', `/admin/criativos/${substituta.json.id}`, {
    admin: 'op',
    corpo: { status: 'correcao', motivo_reprovacao: 'categoria errada' },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await linha('criativos', substituta.json.id)).status, 'pendente');
});

// ---------------------------------------------------------------------------
// Proteção contra concorrentes por negócio
// ---------------------------------------------------------------------------

test('[14][19][20][21][22] a trava é por peça, com a categoria VALIDADA do negócio', async () => {
  const pizzaria = await idDaCategoria('Pizzaria');
  const academia = await idDaCategoria('Academia');
  const burger = await idDaCategoria('Lanchonete / Hamburgueria');
  const tela = await telaNoPonto(pizzaria);
  // [22] A conta em si é de pizzaria — e isso não decide nada: o negócio da
  // peça é que decide (sem cair na categoria geral da conta).
  const conta = await novaConta({ plano: 'maximo-1m', categoria: pizzaria });
  await escolherPonto(conta, tela.ponto);
  const deAcademia = await enviar(conta, {
    negocio_nome: 'Academia Fit',
    negocio_categoria_id: academia,
    negocio_mesmo_grupo: '1',
  });
  const dePizza = await enviar(conta, {
    negocio_nome: 'Academia Pizza',
    negocio_categoria_id: pizzaria,
    negocio_mesmo_grupo: '1',
  });
  const deBurger = await enviar(conta, {
    negocio_nome: 'Academia Burger',
    negocio_categoria_id: burger,
    negocio_mesmo_grupo: '1',
  });
  // [14] Nada aprovado: nenhuma peça desta conta veicula. (A tela não fica
  // vazia: o saldo de hospedagem de outras contas da suíte roda na rede
  // inteira.)
  const nossas = [deAcademia, dePizza, deBurger].map((c) => c.json.id);
  const antes = await criativosNaPlaylist(tela.dispositivo);
  assert.ok(!antes.some((id) => nossas.includes(id)));
  for (const c of [deAcademia, dePizza, deBurger]) assert.strictEqual((await aprovar(c.json.id)).status, 200);
  const naTela = new Set(await criativosNaPlaylist(tela.dispositivo));
  assert.ok(naTela.has(deAcademia.json.id), '[21] a peça de outro ramo, da mesma conta, entra');
  assert.ok(!naTela.has(dePizza.json.id), '[20] pizzaria não veicula na pizzaria');
  assert.ok(!naTela.has(deBurger.json.id), 'hamburgueria é concorrente direta cadastrada da pizzaria');
  // A previsão do painel concorda com o gerador, peça por peça.
  const lista = await chamar('GET', '/anunciantes/me/criativos', { conta });
  const situacao = (id) => lista.json.criativos.find((c) => c.id === id);
  assert.strictEqual(situacao(dePizza.json.id).entrada.motivo, 'sem_ponto_no_ar_na_cobertura');
  assert.notStrictEqual(situacao(deAcademia.json.id).situacao, 'aprovado');
});

test('[22] conta de outro ramo com negócio de pizzaria validado: barrada na pizzaria', async () => {
  const pizzaria = await idDaCategoria('Pizzaria');
  const tela = await telaNoPonto(pizzaria);
  const conta = await novaConta({ plano: 'essencial-1m', categoria: await idDaCategoria('Academia') });
  await escolherPonto(conta, tela.ponto);
  const env = await enviar(conta, {
    negocio_nome: 'Pizza da Academia',
    negocio_categoria_id: pizzaria,
    negocio_mesmo_grupo: '1',
  });
  await aprovar(env.json.id);
  assert.ok(!(await criativosNaPlaylist(tela.dispositivo)).includes(env.json.id));
});

test('[19] categoria declarada e ainda não validada nunca decide a trava (cliente não escapa declarando outra)', async () => {
  const pizzaria = await idDaCategoria('Pizzaria');
  const tela = await telaNoPonto(pizzaria);
  const conta = await novaConta({ plano: 'essencial-1m', categoria: await idDaCategoria('Academia') });
  await escolherPonto(conta, tela.ponto);
  // Declarou "Academia" para uma peça de pizzaria; a Mostraí corrige e aprova.
  const env = await enviar(conta, {
    negocio_nome: 'Pizza Escondida',
    negocio_categoria_id: await idDaCategoria('Academia'),
    negocio_mesmo_grupo: '1',
  });
  await aprovar(env.json.id, { categoria_id: pizzaria, motivo_categoria: 'a peça é de pizzaria' });
  assert.ok(!(await criativosNaPlaylist(tela.dispositivo)).includes(env.json.id));
  // [25] Depois de validado, o cliente não muda: a correção fica com a Mostraí.
  const r = await chamar('PATCH', `/anunciantes/me/negocios/${env.json.negocio_id}`, {
    conta,
    corpo: { categoria_id: await idDaCategoria('Academia') },
  });
  assert.strictEqual(r.status, 409);
  assert.strictEqual((await linha('negocios', env.json.negocio_id)).categoria_id, pizzaria);
});

test('o Admin altera um negócio validado com motivo (auditado) e a trava segue a nova categoria', async () => {
  const pizzaria = await idDaCategoria('Pizzaria');
  const tela = await telaNoPonto(pizzaria);
  const conta = await novaConta({ plano: 'essencial-1m' });
  await escolherPonto(conta, tela.ponto);
  const env = await enviar(conta, {
    negocio_nome: 'Academia Fit',
    negocio_categoria_id: await idDaCategoria('Academia'),
    negocio_mesmo_grupo: '1',
  });
  await aprovar(env.json.id);
  assert.ok((await criativosNaPlaylist(tela.dispositivo)).includes(env.json.id));
  const semMotivo = await chamar('PATCH', `/admin/negocios/${env.json.negocio_id}`, {
    admin: 'op',
    corpo: { categoria_id: pizzaria },
  });
  assert.strictEqual(semMotivo.status, 400);
  const idInvalido = await chamar('PATCH', '/admin/negocios/abc', {
    admin: 'op',
    corpo: { categoria_id: pizzaria, motivo: 'x' },
  });
  assert.strictEqual(idInvalido.status, 404);
  const r = await chamar('PATCH', `/admin/negocios/${env.json.negocio_id}`, {
    admin: 'op',
    corpo: { categoria_id: pizzaria, motivo: 'a academia virou pizzaria' },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(!(await criativosNaPlaylist(tela.dispositivo)).includes(env.json.id));
  const ficha = await chamar('GET', `/admin/anunciantes/${conta.id}/negocios`, { admin: 'op' });
  const n = ficha.json.negocios.find((x) => x.id === env.json.negocio_id);
  assert.strictEqual(n.historico[0].acao, 'editado_pelo_admin');
  assert.strictEqual(n.historico[0].categoria_antes_nome, 'Academia');
  assert.strictEqual(n.historico[0].categoria_depois_nome, 'Pizzaria');
});

// ---------------------------------------------------------------------------
// Exclusão, mesclagem e o principal na ficha
// ---------------------------------------------------------------------------

test('[26] negócio com criativo não se apaga (não há rota, e o banco recusa)', async () => {
  const conta = await novaConta();
  const env = await enviar(conta, {
    negocio_nome: 'Academia Burger',
    negocio_categoria_id: await idDaCategoria('Lanchonete / Hamburgueria'),
    negocio_mesmo_grupo: '1',
  });
  const r = await chamar('DELETE', `/anunciantes/me/negocios/${env.json.negocio_id}`, { conta });
  assert.strictEqual(r.status, 404);
  await assert.rejects(
    pool.query('DELETE FROM negocios WHERE id = $1', [env.json.negocio_id]),
    /criativos_negocio_da_conta/,
  );
});

test('mesclar categorias leva os negócios junto (a trava não perde o concorrente)', async () => {
  const { rows: cats } = await pool.query(
    "INSERT INTO categorias (nome, grupo, aliases) VALUES ($1, 'Teste negócios', '{}'), ($2, 'Teste negócios', '{}') RETURNING id",
    [`Neg Origem ${randomUUID()}`, `Neg Destino ${randomUUID()}`],
  );
  const [origem, destino] = cats.map((c) => c.id);
  criados.categorias.push(origem, destino);
  const conta = await novaConta();
  const env = await enviar(conta, { negocio_nome: 'Marca X', negocio_categoria_id: origem, negocio_mesmo_grupo: '1' });
  await aprovar(env.json.id);
  const r = await chamar('POST', `/admin/categorias/${origem}/mesclar`, {
    admin: 'op',
    corpo: { destino_id: destino },
  });
  assert.strictEqual(r.status, 200);
  assert.ok(r.json.negocios_movidos >= 1);
  const negocio = await linha('negocios', env.json.negocio_id);
  assert.strictEqual(negocio.categoria_id, destino);
  assert.ok(negocio.validado_em, 'mesmo negócio, outro nome: continua validado');
});

test('Admin reclassifica a conta: o principal já validado vai junto, auditado', async () => {
  const conta = await novaConta({ categoria: await idDaCategoria('Restaurante') });
  const env = await enviar(conta);
  await aprovar(env.json.id);
  const pizzaria = await idDaCategoria('Pizzaria');
  const r = await chamar('PATCH', `/admin/anunciantes/${conta.id}`, {
    admin: 'op',
    corpo: { categoria_id: pizzaria, categoria_livre: null },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const principal = await linha('negocios', env.json.negocio_id);
  assert.strictEqual(principal.categoria_id, pizzaria);
  const { rows } = await pool.query(
    "SELECT * FROM negocios_validacoes WHERE negocio_id = $1 AND acao = 'editado_pelo_admin'",
    [principal.id],
  );
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].categoria_antes_nome, 'Restaurante');
});
