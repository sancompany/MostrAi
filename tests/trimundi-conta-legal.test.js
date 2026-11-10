const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const apoio = require('./trimundi-apoio');
const legal = require('../src/trimundi/legal');
const { consultar } = require('../src/trimundi/db/conexao');

// Telas públicas e documentos legais (pedido do dono, 10/11/2026): textos
// oficiais sem nenhuma palavra mudada, versão exigida no aceite, histórico de
// aceites que não se apaga, "Minha conta" por evento e pedido, e "Indique e
// acompanhe" com acessos únicos, contas criadas e compras confirmadas.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const SENHA = 'Minha12@senha';
const OFICIAL = path.join(__dirname, '..', 'docs', 'trimundi', 'legal');
const ENTIDADES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

// O texto da página, um bloco por linha (o que a pessoa lê, sem as tags).
function textoDaPagina(html) {
  const main = html.slice(html.indexOf('<main'), html.indexOf('</main>'));
  return main
    .replace(/<main[^>]*>/, '')
    .replace(/<\/(h1|h2|p|li)>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENTIDADES[e])
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}
const linhasOficiais = (arquivo) =>
  fs
    .readFileSync(path.join(OFICIAL, arquivo), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

test('Termos e Política: a página diz exatamente o texto oficial (v1.2), sem uma palavra a mais ou a menos', async () => {
  assert.equal(legal.VERSAO, '1.2');
  for (const [caminho, arquivo] of [
    ['/ticket/termos', 'termos-de-uso-v1.2.txt'],
    ['/ticket/privacidade', 'politica-de-privacidade-v1.2.txt'],
  ]) {
    const r = await fetch(`${srv.base}${caminho}`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.deepEqual(textoDaPagina(html), linhasOficiais(arquivo), caminho);
    assert.doesNotMatch(html, /\{\{/, 'sem marcador sobrando');
    assert.match(html, /href="\/ticket\/termos"/);
    assert.match(html, /href="\/ticket\/privacidade"/);
  }
  // Os documentos estão no rodapé das páginas públicas da TICK.
  for (const caminho of ['/tic/eventos', '/ticket/conta', '/ticket/conta/esqueci']) {
    const html = await (await fetch(`${srv.base}${caminho}`)).text();
    assert.match(html, /href="\/ticket\/termos">Termos de Uso</, caminho);
    assert.match(html, /href="\/ticket\/privacidade">Política de Privacidade</, caminho);
  }
  // A página da conta diz qual versão o aceite vai mandar.
  const conta = await (await fetch(`${srv.base}/ticket/conta`)).text();
  assert.match(conta, /<meta name="tick-termos" content="1\.2">/);
});

test('aceite: só vale a versão apresentada; cada aceite fica no histórico, que não muda nem se apaga', async () => {
  const c = apoio.cliente(srv);
  const p = apoio.pessoa('Hist');
  const base = { ...p, senha: SENHA, senha_confirmacao: SENHA, maioridade: true, aceite_termos: true };
  const velha = await c.post('/ticket/api/conta/cadastro', { ...base, versao_termos: '1.1' });
  assert.equal(velha.status, 409, 'versão que não é a vigente não vale');
  assert.equal(velha.json.codigo, 'versao_termos');
  assert.equal((await c.post('/ticket/api/conta/cadastro', base)).status, 409, 'sem dizer a versão, também não');
  assert.equal((await consultar('SELECT 1 FROM clientes WHERE email = $1', [p.email])).rows.length, 0, 'nada criado');

  const ok = await c.post(
    '/ticket/api/conta/cadastro',
    { ...base, versao_termos: '1.2' },
    { 'user-agent': 'ua-teste' },
  );
  assert.equal(ok.status, 201, ok.texto);
  const { rows: conta } = await consultar('SELECT id FROM clientes WHERE email = $1', [p.email]);
  const historico = async () =>
    (await consultar('SELECT * FROM aceites_conta WHERE cliente_id = $1 ORDER BY aceito_em, id', [conta[0].id])).rows;
  let h = await historico();
  assert.equal(h.length, 1);
  assert.deepEqual(
    [h[0].versao, h[0].origem, h[0].maioridade_declarada, h[0].user_agent],
    ['1.2', 'cadastro', true, 'ua-teste'],
  );
  assert.equal(h[0].documentos_hash, legal.hashDocumentos(), 'guarda o hash do texto apresentado');
  const esperado = crypto.createHash('sha256');
  for (const n of ['termos.html', 'privacidade.html'])
    esperado.update(fs.readFileSync(path.join(__dirname, '..', 'src', 'trimundi', 'paginas', n)));
  assert.equal(h[0].documentos_hash, esperado.digest('hex'));

  // Versão antiga na conta: aceite de novo — o primeiro aceite fica.
  await consultar("UPDATE clientes SET termos_versao = '1.1', email_confirmado_em = now() WHERE id = $1", [
    conta[0].id,
  ]);
  const entrada = await c.post('/ticket/api/conta/entrar', { email: p.email, senha: SENHA });
  assert.equal(entrada.status, 200, entrada.texto);
  const logado = apoio.cliente(srv, { cookie: entrada.cookies });
  assert.equal((await logado.get('/ticket/api/conta')).json.conta.aceite_pendente, true);
  assert.equal(
    (await logado.post('/ticket/api/conta/aceite', { maioridade: true, aceite_termos: true, versao_termos: '1.1' }))
      .status,
    409,
  );
  assert.equal(
    (await logado.post('/ticket/api/conta/aceite', { maioridade: true, aceite_termos: true, versao_termos: '1.2' }))
      .status,
    200,
  );
  h = await historico();
  assert.deepEqual(
    h.map((x) => x.origem),
    ['cadastro', 'reaceite'],
  );
  assert.equal((await logado.get('/ticket/api/conta')).json.conta.aceite_pendente, false);
  await assert.rejects(consultar('UPDATE aceites_conta SET versao = $2 WHERE id = $1', [h[0].id, '9.9']), /histórico/);
  await assert.rejects(consultar('DELETE FROM aceites_conta WHERE id = $1', [h[0].id]), /histórico/);
});

// --------------------------------------------------------------- indicação
const visitar = (c, codigo, visitante) => c.post('/ticket/api/indicacao/visita', { codigo, visitante });
const numerosDe = async (p) => {
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  return (await c.get('/ticket/api/conta')).json.indicacao;
};

test('Indique e acompanhe: link permanente; acessos únicos não contam visita repetida nem a própria', async () => {
  const ana = apoio.pessoa('Ana');
  const ind = await numerosDe(ana);
  assert.match(ind.link_geral, new RegExp(`/tic/eventos\\?ind=${ind.codigo}$`));
  assert.equal((await numerosDe(ana)).link_geral, ind.link_geral, 'o mesmo link a cada acesso');
  assert.equal(ind.link_geral.includes(ana.cpf) || ind.link_geral.includes(ana.email), false);

  const anonimo = apoio.cliente(srv);
  const v1 = crypto.randomUUID().replace(/-/g, '');
  const v2 = crypto.randomUUID().replace(/-/g, '');
  const r = await visitar(anonimo, ind.codigo, v1);
  assert.deepEqual(r.json.indicacao, { nome: ana.nome, tipo: 'comprador' });
  await visitar(anonimo, ind.codigo, v1);
  await visitar(anonimo, ind.codigo, v1);
  await visitar(anonimo, ind.codigo, v2);
  // A própria Ana pelo próprio link: não conta.
  const ela = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  await visitar(ela, ind.codigo, crypto.randomUUID().replace(/-/g, ''));
  const n = (await numerosDe(ana)).numeros;
  assert.equal(n.acessos, 2, 'dois navegadores, cada um uma vez');
  assert.equal(n.contas_criadas, 0);
  assert.equal(n.pessoas, 0);
  // A página de venda também conta (e uma vez só por navegador e link).
  const pronta = await apoio.edicaoPronta();
  await anonimo.post(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}/indicacao`, {
    codigo: ind.codigo,
    visitante: v1,
  });
  assert.equal((await numerosDe(ana)).numeros.acessos, 2);
  const { rows } = await consultar(
    'SELECT v.visitante FROM indicacao_visitas v JOIN indicadores i ON i.id = v.indicador_id WHERE i.codigo = $1',
    [ind.codigo],
  );
  assert.ok(
    rows.every((x) => /^[0-9a-f]{64}$/.test(x.visitante) && x.visitante !== v1),
    'só o hash do visitante',
  );
});

test('Indique e acompanhe: conta criada depois da visita conta; compra só quando confirmada', async () => {
  const ana = apoio.pessoa('Ana');
  const { codigo } = await numerosDe(ana);
  const pronta = await apoio.edicaoPronta();
  // Bia chega pelo link, sem conta; depois cria a conta e volta logada.
  const bia = apoio.pessoa('Bia');
  const vBia = crypto.randomUUID().replace(/-/g, '');
  await visitar(apoio.cliente(srv), codigo, vBia);
  const biaLogada = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, bia) });
  await biaLogada.post(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}/indicacao`, {
    codigo,
    visitante: vBia,
  });
  // Caio já tinha conta ANTES de visitar: entra, mas não conta como "criou conta".
  const caio = apoio.pessoa('Caio');
  await apoio.contaDe(caio);
  await new Promise((r) => setTimeout(r, 10));
  await consultar("UPDATE clientes SET criado_em = now() - interval '1 day' WHERE cpf = $1", [caio.cpf]);
  const caioLogado = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, caio) });
  await visitar(caioLogado, codigo, crypto.randomUUID().replace(/-/g, ''));

  let n = (await numerosDe(ana)).numeros;
  assert.deepEqual([n.acessos, n.contas_criadas, n.pessoas], [2, 1, 0]);
  // Bia compra 3 ingressos e paga; Caio fica aguardando pagamento.
  const pedBia = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 3), { comprador: bia, indicacao: codigo });
  await apoio.pagar(pedBia.pedido_id);
  await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), { comprador: caio, indicacao: codigo });
  n = (await numerosDe(ana)).numeros;
  assert.deepEqual([n.pessoas, n.compras, n.ingressos], [1, 1, 3], 'só a compra confirmada; 1 pessoa, 3 ingressos');
  const tela = JSON.stringify(await numerosDe(ana));
  for (const dado of [bia.nome, bia.email, bia.cpf, caio.nome, caio.email]) {
    assert.equal(tela.includes(dado), false, 'nenhum dado de quem visitou ou comprou');
  }
});

test('o link geral de operador vale sem edição; ninguém de fora vê os números de outra conta', async () => {
  const op = await apoio.operadorLogado(srv);
  const codigoOp = (await apoio.cliente(srv, { cookie: op.cookie }).get('/ticket/api/operador')).json.indicacao.codigo;
  const r = await visitar(apoio.cliente(srv), codigoOp, crypto.randomUUID().replace(/-/g, ''));
  assert.equal(r.json.indicacao.tipo, 'operador');
  assert.equal((await visitar(apoio.cliente(srv), 'ZZZZZZZZ', crypto.randomUUID())).json.indicacao, null);
  assert.equal((await apoio.cliente(srv).get('/ticket/api/conta')).status, 401);
});

// --------------------------------------------------------------- ingressos
test('Minha conta: um grupo por evento, um cartão por pedido; QR só de ingresso pago, válido e não usado', async () => {
  const ana = apoio.pessoa('Ana');
  const um = await apoio.edicaoPronta();
  const dois = await apoio.edicaoPronta();
  const pago = await apoio.novoPedido(um, apoio.itensDe(um.tipo, 2), { comprador: ana });
  await apoio.pagar(pago.pedido_id);
  const pendente = await apoio.novoPedido(dois, apoio.itensDe(dois.tipo, 1), { comprador: ana });
  // Um dos dois ingressos pagos já entrou.
  const { rows: ings } = await consultar('SELECT id FROM ingressos WHERE pedido_id = $1 ORDER BY id', [pago.pedido_id]);
  const op = await apoio.operadorLogado(srv, [um.edicao.id]);
  await apoio
    .cliente(srv, { cookie: op.cookie })
    .post('/ticket/api/checkin/confirmar', { edicao_id: um.edicao.id, ingresso_id: ings[0].id });

  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const d = (await c.get('/ticket/api/conta')).json;
  const doEvento = (pronta) => d.edicoes.find((g) => g.evento === pronta.edicao.evento.nome);
  const g1 = doEvento(um);
  const g2 = doEvento(dois);
  assert.ok(g1 && g2, 'cada evento no seu grupo');
  assert.equal(g1.pedidos.length, 1);
  assert.equal(g2.pedidos.length, 1);
  assert.deepEqual([g1.pedidos[0].status, g1.pedidos[0].situacao], ['pago', 'Confirmado']);
  assert.equal(g1.pedidos[0].ingressos.length, 2);
  const [usado, livre] = g1.pedidos[0].ingressos.sort((a, b) => Boolean(b.utilizado_em) - Boolean(a.utilizado_em));
  assert.ok(usado.utilizado_em);
  assert.equal(usado.qr, null, 'usado: sem QR');
  assert.match(livre.qr, /^data:image\/png;base64,/);
  assert.deepEqual([g2.pedidos[0].status, g2.pedidos[0].situacao], ['aguardando_pagamento', 'Aguardando pagamento']);
  assert.equal(g2.pedidos[0].ingressos.length, 0, 'pendente ainda não tem ingresso nem QR');
  assert.ok(g2.pedidos[0].reserva_expira_em);
  assert.match(g2.pedidos[0].itens[0].descricao, /Pista/);

  // "Continuar pagamento": só do próprio pedido, e só se ainda aguarda.
  const link = await c.post(`/ticket/api/conta/pedidos/${pendente.pedido_id}/link`, {});
  assert.equal(link.status, 200);
  assert.match(link.json.url, new RegExp(`^/ticket/pedido/${pendente.pedido_id}\\?t=`));
  assert.equal((await c.post(`/ticket/api/conta/pedidos/${pago.pedido_id}/link`, {})).status, 404, 'pago: não');
  const outra = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, apoio.pessoa('Outra')) });
  assert.equal(
    (await outra.post(`/ticket/api/conta/pedidos/${pendente.pedido_id}/link`, {})).status,
    404,
    'de outra conta: não',
  );
  const deOutra = (await outra.get('/ticket/api/conta')).json;
  assert.equal(JSON.stringify(deOutra).includes(ana.nome), false, 'nenhum ingresso de outra pessoa');
});
