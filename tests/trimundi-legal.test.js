const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const legal = require('../src/trimundi/legal');

// Termos de Uso, Política de Privacidade e proteção contra menores (pedido
// do dono, 10/11/2026): conta só para maiores de 18, aceite obrigatório e
// guardado com versão, IP e navegador; compra para evento com classificação
// declara a idade mínima dos participantes; a portaria lembra o documento.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const SENHA = 'Minha12@senha';

test('cadastro exige maioridade e o aceite dos Termos e da Política; o aceite fica guardado', async () => {
  const c = apoio.cliente(srv);
  const semIdade = await c.post('/ticket/api/conta/cadastro', {
    ...apoio.pessoa('A'),
    senha: SENHA,
    senha_confirmacao: SENHA,
    aceite_termos: true,
  });
  assert.equal(semIdade.status, 400);
  assert.equal(semIdade.json.codigo, 'maioridade');
  const semAceite = await c.post('/ticket/api/conta/cadastro', {
    ...apoio.pessoa('B'),
    senha: SENHA,
    senha_confirmacao: SENHA,
    maioridade: true,
  });
  assert.equal(semAceite.status, 400);
  assert.equal(semAceite.json.codigo, 'aceite_termos');
  const texto = await c.post('/ticket/api/conta/cadastro', {
    ...apoio.pessoa('C'),
    senha: SENHA,
    senha_confirmacao: SENHA,
    maioridade: 'sim',
    aceite_termos: 'sim',
  });
  assert.equal(texto.status, 400, 'só o booleano true vale como aceite');

  const p = apoio.pessoa('D');
  const ok = await c.post(
    '/ticket/api/conta/cadastro',
    { ...p, senha: SENHA, senha_confirmacao: SENHA, maioridade: true, aceite_termos: true },
    { 'user-agent': 'navegador-de-teste' },
  );
  assert.equal(ok.status, 201);
  const { rows } = await consultar(
    'SELECT termos_versao, termos_aceitos_em, maioridade_declarada_em, aceite_ip, aceite_user_agent FROM clientes WHERE email = $1',
    [p.email],
  );
  assert.equal(rows[0].termos_versao, legal.VERSAO);
  assert.ok(rows[0].termos_aceitos_em && rows[0].maioridade_declarada_em);
  assert.equal(rows[0].aceite_ip, c.ip);
  assert.equal(rows[0].aceite_user_agent, 'navegador-de-teste');
});

test('conta sem o aceite da versão atual não compra até aceitar de novo', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = apoio.pessoa('Antiga');
  const conta = await apoio.contaDe(p);
  await consultar("UPDATE clientes SET termos_versao = '0.9' WHERE id = $1", [conta.id]);
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  assert.equal((await c.get('/ticket/api/conta')).json.conta.aceite_pendente, true);
  const corpo = async () => {
    const cot = await c.post('/ticket/api/cotacao', {
      evento: pronta.slugEvento,
      edicao: pronta.slugEdicao,
      itens: apoio.itensDe(pronta.tipo, 1),
    });
    return {
      evento: pronta.slugEvento,
      edicao: pronta.slugEdicao,
      itens: apoio.itensDe(pronta.tipo, 1),
      participantes: [{ conta: true }],
      aceite: { aceito: true, termos: cot.json.termos.map((t) => t.id), idade: true },
      chave: apoio.chave(),
    };
  };
  const recusado = await c.post('/ticket/api/pedidos', await corpo());
  assert.equal(recusado.status, 409);
  assert.equal(recusado.json.codigo, 'aceite_conta');
  assert.equal((await c.post('/ticket/api/conta/aceite', { maioridade: true })).status, 400);
  assert.equal((await c.post('/ticket/api/conta/aceite', { maioridade: true, aceite_termos: true })).status, 200);
  assert.equal((await c.get('/ticket/api/conta')).json.conta.aceite_pendente, false);
  assert.equal((await c.post('/ticket/api/pedidos', await corpo())).status, 201);
});

test('evento com classificação: o pedido exige a declaração de idade e a guarda; evento livre, não', async () => {
  const pronta = await apoio.edicaoPronta(); // classificação 18
  const p = apoio.pessoa('Compra');
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  const corpo = async (ed, idade) => {
    const cot = await c.post('/ticket/api/cotacao', {
      evento: ed.slugEvento,
      edicao: ed.slugEdicao,
      itens: apoio.itensDe(ed.tipo, 1),
    });
    return {
      evento: ed.slugEvento,
      edicao: ed.slugEdicao,
      itens: apoio.itensDe(ed.tipo, 1),
      participantes: [{ conta: true }],
      aceite: { aceito: true, termos: cot.json.termos.map((t) => t.id), ...(idade ? { idade: true } : {}) },
      chave: apoio.chave(),
    };
  };
  const sem = await c.post('/ticket/api/pedidos', await corpo(pronta, false));
  assert.equal(sem.status, 400);
  assert.equal(sem.json.codigo, 'idade');
  assert.match(sem.json.erro, /18 anos/);
  const com = await c.post('/ticket/api/pedidos', await corpo(pronta, true));
  assert.equal(com.status, 201);
  const { rows } = await consultar('SELECT declaracao_idade_em FROM pedidos WHERE id = $1', [com.json.pedido_id]);
  assert.ok(rows[0].declaracao_idade_em);

  const livre = await apoio.edicaoPronta({ publicar: false });
  await require('../src/trimundi/eventos').atualizarEdicao(
    livre.edicao.id,
    { classificacao_etaria: 'livre' },
    apoio.AUTOR,
  );
  await require('../src/trimundi/eventos').mudarStatus(livre.edicao.id, 'publicado', apoio.AUTOR);
  const semNoLivre = await c.post('/ticket/api/pedidos', await corpo(livre, false));
  assert.equal(semNoLivre.status, 201, 'evento livre não pede declaração');
});

test('Termos e Política: páginas próprias, com versão, contato e sem levar à Mostraí', async () => {
  for (const [caminho, titulo] of [
    ['/ticket/termos', /Termos de Uso/],
    ['/ticket/privacidade', /Política de Privacidade/],
  ]) {
    const r = await fetch(`${srv.base}${caminho}`);
    assert.equal(r.status, 200, caminho);
    const html = await r.text();
    assert.match(html, titulo);
    assert.match(html, new RegExp(`Versão ${legal.VERSAO.replace('.', '\\.')}`));
    assert.match(html, /18 anos/);
    assert.doesNotMatch(html, /href="[^"]*mostra[ií]/i, 'nenhum link para a Mostraí');
    assert.doesNotMatch(html, /href="\/"/);
  }
  const termos = await (await fetch(`${srv.base}/ticket/termos`)).text();
  assert.match(termos, /arrependimento/i);
  assert.match(termos, /art\. 49/);
  const politica = await (await fetch(`${srv.base}/ticket/privacidade`)).text();
  assert.match(politica, /enquanto ela existir/);
});

test('a portaria recebe a classificação para lembrar o documento com foto', async () => {
  const pronta = await apoio.edicaoPronta();
  const op = await apoio.operadorLogado(srv);
  const c = apoio.cliente(srv, { cookie: op.cookie });
  const eu = await c.get('/ticket/api/operador');
  const ed = eu.json.edicoes.find((e) => Number(e.id) === Number(pronta.edicao.id));
  assert.equal(ed.classificacao_etaria, '18');
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(ped.pedido_id);
  const { rows } = await consultar('SELECT codigo_curto FROM ingressos WHERE pedido_id = $1', [ped.pedido_id]);
  const r = await c.post('/ticket/api/checkin/consultar', {
    edicao_id: pronta.edicao.id,
    entrada: rows[0].codigo_curto,
  });
  assert.equal(r.json.resultado, 'valido');
  assert.equal(r.json.classificacao_etaria, '18');
});
