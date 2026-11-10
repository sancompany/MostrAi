const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const operadores = require('../src/trimundi/operadores');
const emissao = require('../src/trimundi/emissao');
const participantes = require('../src/trimundi/participantes');
const { conteudoDoQr } = require('../src/trimundi/lib/qr');
const poolMostrai = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// Trimundi, Etapa 6 — operador de check-in (RN-T24 a RN-T28): criado só pelo
// Admin, entra pelo login PRÓPRIO da Trimundi (/ticket/entrar, decisão do
// dono de 09/11/2026) e vai para /ticket/checkin; a sessão dele só abre
// /ticket; desativar ou gerar código novo derruba a sessão na hora. O login
// da Mostraí não conhece operador. Check-in: o servidor decide (assinatura,
// edição, status) e a entrada é única por ingresso, mesmo com leituras
// simultâneas.

let srv;
const contasMostrai = [];
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  if (contasMostrai.length)
    await poolMostrai.query('DELETE FROM anunciantes WHERE id = ANY($1::bigint[])', [contasMostrai]);
  await srv.fechar();
  await apoio.encerrar();
});

const SENHA = 'Portaria12@teste';
const emailNovo = () => `operador.${apoio.sufixo()}@exemplo.com`;

async function operadorAtivo(edicoes = 'todas', { senha = SENHA } = {}) {
  const email = emailNovo();
  const { operador, codigo } = await operadores.criar(
    { nome: `Operador ${apoio.sufixo()}`, email, edicoes },
    apoio.AUTOR,
  );
  const r = await apoio.cliente(srv).post('/ticket/api/ativar', { email, codigo, senha });
  assert.equal(r.status, 200, r.texto);
  return { ...operador, email, senha };
}

async function entrar(email, senha) {
  const c = apoio.cliente(srv);
  const r = await c.post('/ticket/api/operador/entrar', { email, senha });
  return { ...r, sessao: apoio.cliente(srv, { cookie: r.cookies }) };
}

async function contaMostrai(email, senha) {
  const { rows } = await poolMostrai.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true) RETURNING id`,
    [`Trimundi ${randomUUID().slice(0, 8)}`, apoio.cpf(), email, await gerarHash(senha)],
  );
  contasMostrai.push(rows[0].id);
  return rows[0].id;
}

// Ingresso pago, com o texto do QR e o código curto.
async function ingressoPago(pronta) {
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(p.pedido_id);
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, i.codigo_curto, ed.codigo_publico FROM ingressos i JOIN edicoes ed ON ed.id = i.edicao_id
      WHERE i.pedido_id = $1`,
    [p.pedido_id],
  );
  return { ...rows[0], qr: conteudoDoQr(rows[0].codigo_publico, rows[0].codigo), pedido: p };
}

test('o login da Mostraí não abre operador, e o da Trimundi não abre conta da Mostraí', async () => {
  const op = await operadorAtivo();
  const naMostrai = await apoio.cliente(srv).post('/anunciantes/login', { email: op.email, senha: op.senha });
  assert.equal(naMostrai.status, 401, 'a tela da Mostraí segue só dela');
  assert.equal(naMostrai.json.operador, undefined);
  const email = emailNovo();
  await contaMostrai(email, 'Conta12@teste');
  assert.equal((await entrar(email, 'Conta12@teste')).status, 401, 'conta da Mostraí não é operador');
  // E-mail igual nos dois lados não se mistura: cada login olha o seu.
  const { operador } = await operadores.criar({ nome: 'Mesmo e-mail', email, edicoes: 'todas' }, apoio.AUTOR);
  assert.ok(operador.id);
});

test('ativação: mesma resposta para e-mail desconhecido e código errado; 5 erros travam; vencido é 410', async () => {
  const email = emailNovo();
  const { codigo } = await operadores.criar({ nome: 'Portaria', email, edicoes: 'todas' }, apoio.AUTOR);
  assert.match(codigo, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const c = apoio.cliente(srv);
  const errado = await c.post('/ticket/api/ativar', { email, codigo: 'AAAA-AAAA', senha: SENHA });
  const desconhecido = await apoio
    .cliente(srv)
    .post('/ticket/api/ativar', { email: emailNovo(), codigo, senha: SENHA });
  assert.equal(errado.status, 400);
  assert.deepEqual(errado.json, desconhecido.json);
  assert.deepEqual(errado.json, { erro: 'E-mail ou código inválido.' });
  const fraca = await c.post('/ticket/api/ativar', { email, codigo, senha: '123' });
  assert.equal(fraca.status, 400);

  for (let i = 0; i < 4; i++) await c.post('/ticket/api/ativar', { email, codigo: 'BBBB-BBBB', senha: SENHA });
  const travado = await c.post('/ticket/api/ativar', { email, codigo, senha: SENHA });
  assert.equal(travado.status, 400, 'depois de 5 erros, nem o código certo serve');

  const { codigo: novo } = await operadores.novoCodigo(
    (await consultar('SELECT id FROM operadores WHERE email_normalizado = $1', [email])).rows[0].id,
    apoio.AUTOR,
  );
  await consultar("UPDATE operadores SET codigo_expira_em = now() - interval '1 minute' WHERE email_normalizado = $1", [
    email,
  ]);
  const vencido = await apoio.cliente(srv).post('/ticket/api/ativar', { email, codigo: novo, senha: SENHA });
  assert.equal(vencido.status, 410);
  await consultar("UPDATE operadores SET codigo_expira_em = now() + interval '1 hour' WHERE email_normalizado = $1", [
    email,
  ]);
  const ok = await apoio
    .cliente(srv)
    .post('/ticket/api/ativar', { email, codigo: novo.toLowerCase().replace('-', ' '), senha: SENHA });
  assert.equal(ok.status, 200, 'o código digitado em minúscula e sem hífen serve');
  const { rows } = await consultar(
    'SELECT status, codigo_hash, senha_hash FROM operadores WHERE email_normalizado = $1',
    [email],
  );
  assert.equal(rows[0].status, 'ativo');
  assert.equal(rows[0].codigo_hash, null, 'o código é de uso único');
  assert.ok(rows[0].senha_hash && !rows[0].senha_hash.includes(SENHA), 'só o hash da senha');
});

test('login próprio: o operador vai para /ticket/checkin e a sessão só abre /ticket', async () => {
  const op = await operadorAtivo();
  const errado = await entrar(op.email, 'Errada12@teste');
  const ninguem = await entrar(emailNovo(), 'Errada12@teste');
  assert.equal(errado.status, 401);
  assert.deepEqual(errado.json, ninguem.json, 'mesma resposta com ou sem operador');

  const pagina0 = await apoio.cliente(srv).get('/ticket/entrar');
  assert.equal(pagina0.status, 200);
  assert.doesNotMatch(pagina0.texto, /mostra[ií]/i);

  const { status, json, sessao } = await entrar(op.email.toUpperCase(), op.senha);
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, destino: '/ticket/checkin' });

  const pagina = await sessao.get('/ticket/checkin');
  assert.equal(pagina.status, 200);
  assert.match(pagina.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.equal(pagina.headers.get('cache-control').includes('no-store'), true);
  const eu = await sessao.get('/ticket/api/operador');
  assert.equal(eu.status, 200);
  assert.equal(eu.json.nome, op.nome);
  assert.equal(eu.json.indicacao, null, 'sem indicação habilitada pelo Admin, sem link');

  assert.equal((await sessao.get('/anunciantes/me')).status, 401, 'operador não é conta da Mostraí');
  assert.equal((await sessao.get('/admin/trimundi/estado')).status, 401, 'operador não entra no Admin');

  const anonimo = await apoio.cliente(srv).get('/ticket/checkin');
  assert.equal(anonimo.status, 302);
  assert.equal(anonimo.headers.get('location'), '/ticket/entrar');
  assert.equal((await apoio.cliente(srv).get('/ticket/api/operador')).status, 401);

  assert.equal((await sessao.post('/ticket/api/sair')).status, 200);
  assert.equal((await sessao.get('/ticket/api/operador')).status, 401);
});

test('desativar derruba a sessão na hora; o login avisa; reativar devolve o acesso', async () => {
  const op = await operadorAtivo();
  const { sessao } = await entrar(op.email, op.senha);
  assert.equal((await sessao.get('/ticket/api/operador')).status, 200);
  await operadores.desativar(op.id, apoio.AUTOR);
  assert.equal((await sessao.get('/ticket/api/operador')).status, 401, 'revogação imediata');
  assert.equal((await sessao.get('/ticket/checkin')).status, 302);
  const bloqueado = await entrar(op.email, op.senha);
  assert.equal(bloqueado.status, 403);
  assert.match(bloqueado.json.erro, /desativado/);
  // Senha errada de operador desativado não revela que ele existe.
  assert.equal((await entrar(op.email, 'Errada12@teste')).status, 401);
  await operadores.reativar(op.id, apoio.AUTOR);
  assert.equal((await entrar(op.email, op.senha)).status, 200);
});

test('código novo derruba a sessão e apaga a senha antiga', async () => {
  const op = await operadorAtivo();
  const { sessao } = await entrar(op.email, op.senha);
  await operadores.novoCodigo(op.id, apoio.AUTOR);
  assert.equal((await sessao.get('/ticket/api/operador')).status, 401);
  assert.equal((await entrar(op.email, op.senha)).status, 401);
});

test('check-in pelo QR: válido, entra; a segunda leitura diz já utilizado, com hora e operador', async () => {
  const pronta = await apoio.edicaoPronta();
  const ing = await ingressoPago(pronta);
  const op = await operadorAtivo([pronta.edicao.id]);
  const { sessao } = await entrar(op.email, op.senha);
  const edicaoId = pronta.edicao.id;

  const lido = await sessao.post('/ticket/api/checkin/consultar', { edicao_id: edicaoId, entrada: ing.qr });
  assert.equal(lido.status, 200);
  assert.equal(lido.json.resultado, 'valido');
  assert.equal(lido.json.ingresso.participante, ing.pedido.corpo.participantes[0].nome);
  assert.equal(lido.json.ingresso.categoria, 'Pista');
  assert.equal(lido.texto.includes(ing.pedido.corpo.participantes[0].cpf), false, 'a portaria não vê CPF');

  const entrou = await sessao.post('/ticket/api/checkin/confirmar', {
    edicao_id: edicaoId,
    ingresso_id: lido.json.ingresso.id,
  });
  assert.equal(entrou.json.resultado, 'entrada_registrada');
  const de_novo = await sessao.post('/ticket/api/checkin/consultar', { edicao_id: edicaoId, entrada: ing.qr });
  assert.equal(de_novo.json.resultado, 'ja_utilizado');
  assert.ok(de_novo.json.ingresso.utilizado_em);
  assert.equal(de_novo.json.ingresso.utilizado_por, op.nome);
  const confirmarDeNovo = await sessao.post('/ticket/api/checkin/confirmar', {
    edicao_id: edicaoId,
    ingresso_id: lido.json.ingresso.id,
  });
  assert.equal(confirmarDeNovo.json.resultado, 'ja_utilizado');

  const contador = await sessao.get(`/ticket/api/checkin/contador?edicao=${edicaoId}`);
  assert.deepEqual(contador.json, { entradas: 1, ingressos: 1 });
  const { rows } = await consultar('SELECT resultado FROM checkins WHERE ingresso_id = $1 ORDER BY id', [ing.id]);
  assert.deepEqual(
    rows.map((r) => r.resultado),
    ['aceito', 'recusado'],
    'a tentativa repetida também fica registrada',
  );
  const lista = await participantes.listar(edicaoId, { filtro: 'utilizados' });
  assert.equal(lista.total, 1);
  assert.equal(lista.itens[0].checkin.operador, op.nome);
});

test('leituras simultâneas do mesmo ingresso: uma entrada só', async () => {
  const pronta = await apoio.edicaoPronta();
  const ing = await ingressoPago(pronta);
  const sessoes = [];
  for (let i = 0; i < 3; i++) {
    const op = await operadorAtivo([pronta.edicao.id]);
    sessoes.push((await entrar(op.email, op.senha)).sessao);
  }
  const respostas = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      sessoes[i % 3].post('/ticket/api/checkin/confirmar', { edicao_id: pronta.edicao.id, ingresso_id: ing.id }),
    ),
  );
  const resultados = respostas.map((r) => r.json.resultado).sort();
  assert.deepEqual(resultados, [
    'entrada_registrada',
    'ja_utilizado',
    'ja_utilizado',
    'ja_utilizado',
    'ja_utilizado',
    'ja_utilizado',
  ]);
  const { rows } = await consultar(
    "SELECT count(*)::int AS n FROM checkins WHERE ingresso_id = $1 AND resultado = 'aceito'",
    [ing.id],
  );
  assert.equal(rows[0].n, 1);
});

test('QR forjado, de outra edição, cancelado e bloqueado são recusados; código digitado funciona', async () => {
  const pronta = await apoio.edicaoPronta();
  const outra = await apoio.edicaoPronta();
  const op = await operadorAtivo('todas');
  const { sessao } = await entrar(op.email, op.senha);
  const consultarEntrada = async (entrada, edicaoId = pronta.edicao.id) =>
    (await sessao.post('/ticket/api/checkin/consultar', { edicao_id: edicaoId, entrada })).json.resultado;

  const ing = await ingressoPago(pronta);
  const partes = ing.qr.split('.');
  partes[3] = `${partes[3].slice(0, 10)}${partes[3][10] === 'A' ? 'B' : 'A'}${partes[3].slice(11)}`;
  assert.equal(await consultarEntrada(partes.join('.')), 'invalido', 'assinatura alterada');
  assert.equal(await consultarEntrada(`TM1.${apoio.chave()}.${'A'.repeat(22)}.${'B'.repeat(86)}`), 'invalido');
  assert.equal(await consultarEntrada('qualquer coisa'), 'invalido');
  assert.equal(await consultarEntrada(''), 'invalido');

  const daOutra = await ingressoPago(outra);
  assert.equal(await consultarEntrada(daOutra.qr), 'outra_edicao');
  assert.equal(await consultarEntrada(daOutra.codigo_curto), 'invalido', 'código curto de outra edição não é achado');

  assert.equal(await consultarEntrada(ing.codigo_curto.toLowerCase().replace('-', '')), 'valido', 'digitado sem hífen');

  const cortesia = await emissao.emitirCortesia(
    pronta.edicao.id,
    { ...apoio.pessoa('Convidado'), categoria_id: pronta.tipo.id, classificacao: 'convidado', chave: apoio.chave() },
    apoio.AUTOR,
  );
  const { rows } = await consultar('SELECT codigo_curto FROM ingressos WHERE id = $1', [cortesia.ingresso_id]);
  const leitura = await sessao.post('/ticket/api/checkin/consultar', {
    edicao_id: pronta.edicao.id,
    entrada: rows[0].codigo_curto,
  });
  assert.equal(leitura.json.resultado, 'valido');
  assert.equal(leitura.json.ingresso.cortesia, true);
  await emissao.cancelarCortesia(cortesia.ingresso_id, 'emitida por engano', apoio.AUTOR);
  assert.equal(await consultarEntrada(rows[0].codigo_curto), 'cancelado');
  const tentativa = await sessao.post('/ticket/api/checkin/confirmar', {
    edicao_id: pronta.edicao.id,
    ingresso_id: cortesia.ingresso_id,
  });
  assert.equal(tentativa.json.resultado, 'cancelado', 'cancelado não entra nem confirmando direto');

  await apoio.aplicarAviso({ ...(await apoio.aviso(ing.pedido.pedido_id, 'chargeback')) });
  assert.equal(await consultarEntrada(ing.qr), 'bloqueado');
});

test('permissão por edição: o operador só vê e só consulta as edições dele', async () => {
  const a = await apoio.edicaoPronta();
  const b = await apoio.edicaoPronta();
  const rascunho = await apoio.edicaoPronta({ publicar: false });
  const op = await operadorAtivo([a.edicao.id, rascunho.edicao.id]);
  const { sessao } = await entrar(op.email, op.senha);
  const eu = await sessao.get('/ticket/api/operador');
  assert.deepEqual(
    eu.json.edicoes.map((e) => e.id),
    [a.edicao.id],
    'rascunho não aparece; a outra edição também não',
  );
  const ingB = await ingressoPago(b);
  const negado = await sessao.post('/ticket/api/checkin/consultar', { edicao_id: b.edicao.id, entrada: ingB.qr });
  assert.equal(negado.status, 403);
  const negadoConfirmar = await sessao.post('/ticket/api/checkin/confirmar', {
    edicao_id: b.edicao.id,
    ingresso_id: ingB.id,
  });
  assert.equal(negadoConfirmar.status, 403);
  assert.equal(
    (await consultar('SELECT count(*)::int AS n FROM checkins WHERE ingresso_id = $1', [ingB.id])).rows[0].n,
    0,
  );

  // O Admin tira a edição: vale na requisição seguinte.
  await operadores.atualizar(op.id, { edicoes: [b.edicao.id] }, apoio.AUTOR);
  const agora = await sessao.post('/ticket/api/checkin/consultar', { edicao_id: b.edicao.id, entrada: ingB.qr });
  assert.equal(agora.json.resultado, 'valido');
});
