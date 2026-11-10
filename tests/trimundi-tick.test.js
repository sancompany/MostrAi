const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const apoio = require('./trimundi-apoio');
const eventos = require('../src/trimundi/eventos');
const { termoDeBusca } = require('../src/trimundi/vitrine');
const poolMostrai = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// TICK — experiência pública própria (pedido do dono, 10/11/2026): a home em
// /tic/eventos lista os eventos do mesmo cadastro do Admin; a página de venda
// segue em /ticket/<evento>/<edição>; a conta TICK tem cookie próprio e não
// se mistura com a da Mostraí; o menu público da Mostraí leva a /tic/eventos.

let srv;
const contasMostrai = [];
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  if (contasMostrai.length) {
    await poolMostrai.query('DELETE FROM anunciantes WHERE id = ANY($1::bigint[])', [contasMostrai]);
  }
  await srv.fechar();
  await apoio.encerrar();
});

const pegar = async (caminho, opcoes = {}) => {
  const r = await fetch(`${srv.base}${caminho}`, { redirect: 'manual', ...opcoes });
  const texto = await r.text();
  return { status: r.status, texto, headers: r.headers };
};

test('/tic leva à home /tic/eventos, com a marca TICK e sem nada da Mostraí', async () => {
  const raiz = await pegar('/tic');
  assert.equal(raiz.status, 302);
  assert.equal(raiz.headers.get('location'), '/tic/eventos');
  const home = await pegar('/tic/eventos');
  assert.equal(home.status, 200);
  assert.match(home.texto, /<title>Eventos · TICK<\/title>/);
  assert.match(home.texto, /eventos\.page\.js/);
  assert.match(home.texto, /href="\/ticket\/conta"/, 'conta TICK, não a da Mostraí');
  assert.doesNotMatch(home.texto, /mostra[ií]/i);
  assert.doesNotMatch(home.texto, /href="\/"|\/anunciante\//);
  const nada = await pegar('/tic/nao-existe');
  assert.equal(nada.status, 404);
  assert.match(nada.texto, /TICK/);
  // O prefixo /tic não engole /ticket.
  assert.equal((await pegar('/ticket/conta')).status, 200);
});

test('a home lista só eventos publicados (ou pausados) ainda por vir, do cadastro do Admin', async () => {
  const publicada = await apoio.edicaoPronta();
  const rascunho = await apoio.edicaoPronta({ publicar: false });
  const pausada = await apoio.edicaoPronta();
  await eventos.mudarStatus(pausada.edicao.id, 'pausado', apoio.AUTOR);
  const passada = await apoio.edicaoPronta({ publicar: false });
  await eventos.atualizarEdicao(
    passada.edicao.id,
    {
      inicio_em: new Date(Date.now() - 3 * 86400000).toISOString(),
      fim_em: new Date(Date.now() - 2 * 86400000).toISOString(),
    },
    apoio.AUTOR,
  );
  await eventos.mudarStatus(passada.edicao.id, 'publicado', apoio.AUTOR);
  // Cada um procurado pelo nome (o banco de teste tem centenas de edições).
  const achar = async (p) =>
    (await apoio.cliente(srv).get(`/ticket/api/vitrine?q=${encodeURIComponent(p.edicao.evento.nome)}`)).json.eventos;
  const de = (p) => `/ticket/${p.slugEvento}/${p.slugEdicao}`;
  assert.deepEqual(
    (await achar(publicada)).map((e) => e.endereco),
    [de(publicada)],
    'publicada aparece',
  );
  const [item] = await achar(pausada);
  assert.equal(item?.endereco, de(pausada), 'pausada aparece (com aviso)');
  assert.equal(item.vendas_pausadas, true);
  assert.equal(item.classificacao_etaria, '18');
  assert.deepEqual(await achar(rascunho), [], 'rascunho não aparece');
  assert.deepEqual(await achar(passada), [], 'evento que já terminou não aparece');
  // O card leva à página de venda de sempre.
  assert.equal((await pegar(de(publicada))).status, 200);
});

test('busca: por nome do evento; curinga digitado vale como texto; o card traz o local do Admin', async () => {
  const pronta = await apoio.edicaoPronta({ publicar: false });
  await eventos.atualizarEdicao(
    pronta.edicao.id,
    { local: { nome: 'Galpão 7', cidade: 'Matão', uf: 'SP' } },
    apoio.AUTOR,
  );
  await eventos.mudarStatus(pronta.edicao.id, 'publicado', apoio.AUTOR);
  const nome = pronta.edicao.evento.nome;
  const r = await apoio.cliente(srv).get(`/ticket/api/vitrine?q=${encodeURIComponent(nome)}`);
  assert.deepEqual(
    r.json.eventos.map((e) => e.evento),
    [nome],
  );
  assert.equal(r.json.eventos[0].local, 'Galpão 7 · Matão/SP');
  const porCidade = await apoio.cliente(srv).get(`/ticket/api/vitrine?q=${encodeURIComponent('Galpão 7')}`);
  assert.ok(
    porCidade.json.eventos.some((e) => e.evento === nome),
    'busca também pelo local',
  );
  const nada = await apoio.cliente(srv).get('/ticket/api/vitrine?q=nao-existe-evento-assim');
  assert.deepEqual(nada.json.eventos, []);
  assert.equal(termoDeBusca('50%_off'), '%50\\%\\_off%');
  assert.equal(termoDeBusca('   '), null);
});

test('conta TICK e conta Mostraí não se misturam: cookies próprios, um login não derruba o outro', async () => {
  // Conta da Mostraí (anunciante), entrando pela tela dela.
  const email = `anunciante.${apoio.sufixo()}@exemplo.com`;
  const { rows } = await poolMostrai.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true) RETURNING id`,
    [`Loja ${apoio.sufixo()}`, apoio.cpf(), email, await gerarHash('Conta12@teste')],
  );
  contasMostrai.push(rows[0].id);
  const ip = apoio.novoIp();
  const mostrai = await fetch(`${srv.base}/anunciantes/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email, senha: 'Conta12@teste' }),
  });
  assert.equal(mostrai.status, 200);
  await mostrai.json();
  const cookieMostrai = mostrai.headers.getSetCookie().find((c) => c.startsWith('connect.sid='));
  assert.ok(cookieMostrai, 'a Mostraí usa o cookie dela');

  // Conta TICK, entrando pela tela da TICK.
  const p = apoio.pessoa('Comprador');
  await apoio.contaDe(p);
  const tick = await fetch(`${srv.base}/ticket/api/conta/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email: p.email, senha: apoio.SENHA_CONTA }),
  });
  assert.equal(tick.status, 200);
  await tick.json();
  const cookieTick = tick.headers.getSetCookie().find((c) => c.startsWith('tick.sid='));
  assert.ok(cookieTick, 'a TICK tem cookie próprio');
  assert.match(cookieTick, /Path=\/ticket/, 'o cookie da TICK só viaja para /ticket');
  assert.ok(
    !tick.headers.getSetCookie().some((c) => c.startsWith('connect.sid=')),
    'o login TICK não mexe no da Mostraí',
  );

  // O navegador manda os dois para /ticket (o da Mostraí tem Path=/): cada
  // lado lê só o seu, e os dois seguem logados.
  const jar = [cookieMostrai, cookieTick].map((c) => c.split(';')[0]).join('; ');
  const naMostrai = await fetch(`${srv.base}/anunciantes/me`, { headers: { cookie: cookieMostrai.split(';')[0] } });
  assert.equal(naMostrai.status, 200, 'a conta da Mostraí continua logada depois do login TICK');
  await naMostrai.text();
  const naTick = await fetch(`${srv.base}/ticket/api/conta/sessao`, { headers: { cookie: jar } });
  assert.deepEqual((await naTick.json()).logado, true);
  // A sessão da Mostraí sozinha não abre a conta TICK.
  const soMostrai = await fetch(`${srv.base}/ticket/api/conta/sessao`, {
    headers: { cookie: cookieMostrai.split(';')[0] },
  });
  assert.equal((await soMostrai.json()).logado, false);
  // E a TICK sair não derruba a Mostraí.
  const sair = await fetch(`${srv.base}/ticket/api/conta/sair`, {
    method: 'POST',
    headers: { cookie: jar, 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(sair.status, 200);
  await sair.text();
  const depois = await fetch(`${srv.base}/anunciantes/me`, { headers: { cookie: cookieMostrai.split(';')[0] } });
  assert.equal(depois.status, 200);
  await depois.text();
});

test('o menu público da Mostraí tem "Eventos", que leva a /tic/eventos', () => {
  const layout = fs.readFileSync(path.join(__dirname, '..', 'public', 'layout.js'), 'utf8');
  assert.match(layout, /\['\/tic\/eventos', 'Eventos'\]/);
});
