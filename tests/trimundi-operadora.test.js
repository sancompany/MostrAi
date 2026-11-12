const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const apoio = require('./trimundi-apoio');
const legal = require('../src/trimundi/legal');
const { consultar } = require('../src/trimundi/db/conexao');

// Identificação da operadora da TICK (pedido do dono, 11/11/2026): o MEI
// "68.949.029 BRUNO HENRIQUE SANCHES", CNPJ 68.949.029/0001-58, no lugar do
// nome pessoal isolado — rodapé das páginas, Termos e Política (v1.3), e-mails
// e exportação de dados do titular. A marca continua TICK; comprador, titular
// do ingresso e organizador do evento não mudam.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const NOME = '68.949.029 BRUNO HENRIQUE SANCHES';
const CNPJ = '68.949.029/0001-58';

test('os dados da operadora são os informados pelo dono, e nada além deles', () => {
  assert.deepEqual(
    { ...legal.OPERADORA },
    {
      nome_empresarial: NOME,
      cnpj: CNPJ,
      natureza: 'Empresário Individual — MEI',
      titular: 'Bruno Henrique Sanches',
    },
  );
  assert.equal(legal.linhaDaOperadora(), `TICK é uma plataforma de ${NOME} · CNPJ: ${CNPJ}`);
});

test('rodapé de todas as páginas públicas da TICK: nome empresarial e CNPJ, e a marca segue TICK', async () => {
  const pronta = await apoio.edicaoPronta();
  const caminhos = [
    '/tic/eventos',
    `/ticket/${pronta.slugEvento}/${pronta.slugEdicao}`,
    '/ticket/conta',
    '/ticket/conta/esqueci',
    '/ticket/termos',
    '/ticket/privacidade',
    '/ticket/recuperar',
    '/ticket/entrar',
    '/ticket/ativar',
    '/ticket/pedido/00000000-0000-0000-0000-000000000000',
    '/ticket/nao-existe',
  ];
  for (const caminho of caminhos) {
    const html = await (await fetch(`${srv.base}${caminho}`)).text();
    const rodape = html.slice(html.indexOf('<footer class="rodape">'), html.indexOf('</footer>'));
    assert.ok(rodape.length > 0, `${caminho}: tem rodapé`);
    assert.match(rodape, new RegExp(`${NOME.replace(/\./g, '\\.')} · CNPJ: ${CNPJ.replace(/[./]/g, '\\$&')}`), caminho);
    assert.doesNotMatch(html, /\{\{operadora\}\}/, `${caminho}: sem marcador sobrando`);
    assert.match(html, /<title>[^<]*TICK/, `${caminho}: a marca continua TICK`);
  }
});

test('Termos e Política v1.3: identificam o MEI e o titular; sem o CPF; a v1.2 fica guardada', async () => {
  for (const caminho of ['/ticket/termos', '/ticket/privacidade']) {
    const html = await (await fetch(`${srv.base}${caminho}`)).text();
    const texto = html.replace(/<[^>]+>/g, '');
    assert.match(texto, /Versão 1\.3/);
    assert.ok(
      texto.includes(
        `${NOME}, CNPJ: ${CNPJ}, Empresário Individual — MEI, titular e responsável legal Bruno Henrique Sanches`,
      ),
      caminho,
    );
    assert.equal(texto.includes('552.085.198-01'), false, `${caminho}: sem CPF`);
    assert.equal(/operada por Bruno Henrique Sanches/.test(texto), false);
  }
  // Fora a identificação e o número da versão, o texto é o mesmo da 1.2.
  const pasta = path.join(__dirname, '..', 'docs', 'trimundi', 'legal');
  for (const nome of ['termos-de-uso', 'politica-de-privacidade']) {
    const v12 = fs.readFileSync(path.join(pasta, `${nome}-v1.2.txt`), 'utf8').split('\n');
    const v13 = fs.readFileSync(path.join(pasta, `${nome}-v1.3.txt`), 'utf8').split('\n');
    assert.equal(v12.length, v13.length);
    const diferentes = v12.map((l, i) => (l === v13[i] ? null : i + 1)).filter(Boolean);
    assert.deepEqual(diferentes, [2, 5], `${nome}: só a versão e a identificação mudam`);
  }
});

test('quem aceitou a 1.2 precisa aceitar a 1.3 antes de comprar; o aceite antigo fica', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = apoio.pessoa('Antiga');
  const conta = await apoio.contaDe(p);
  await consultar("UPDATE clientes SET termos_versao = '1.2' WHERE id = $1", [conta.id]);
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  assert.equal((await c.get('/ticket/api/conta')).json.conta.aceite_pendente, true);
  const cot = await c.post('/ticket/api/cotacao', {
    evento: pronta.slugEvento,
    edicao: pronta.slugEdicao,
    itens: apoio.itensDe(pronta.tipo, 1),
  });
  const pedido = () =>
    c.post('/ticket/api/pedidos', {
      evento: pronta.slugEvento,
      edicao: pronta.slugEdicao,
      itens: apoio.itensDe(pronta.tipo, 1),
      aceite: { aceito: true, termos: cot.json.termos.map((t) => t.id), idade: true },
      chave: apoio.chave(),
    });
  assert.equal((await pedido()).json.codigo, 'aceite_conta');
  const aceite = await c.post('/ticket/api/conta/aceite', {
    maioridade: true,
    aceite_termos: true,
    versao_termos: '1.3',
  });
  assert.equal(aceite.status, 200);
  assert.equal((await pedido()).status, 201);
  const { rows } = await consultar('SELECT versao, origem FROM aceites_conta WHERE cliente_id = $1 ORDER BY id', [
    conta.id,
  ]);
  assert.deepEqual(rows.at(-1), { versao: '1.3', origem: 'reaceite' });
});

test('o ingresso continua no nome do comprador, nunca no nome empresarial', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = apoio.pessoa('Compradora');
  const conta = await apoio.contaDe(p);
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: p,
    participantes: [{ conta: true }],
  });
  await apoio.pagar(ped.pedido_id);
  const c = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
  const d = (await c.get('/ticket/api/conta')).json;
  const ing = d.edicoes.flatMap((g) => g.pedidos).flatMap((x) => x.ingressos);
  assert.equal(ing.length, 1);
  assert.equal(ing[0].participante, conta.nome);
  assert.equal(JSON.stringify(d).includes(NOME), false);
  assert.equal(JSON.stringify(d).includes(CNPJ), false);
});

test('e-mails da TICK terminam com a identificação da operadora (texto e HTML)', () => {
  const email = require('../src/trimundi/email');
  const texto = 'Seus ingressos estão prontos.';
  assert.equal(email.textoComRodape(texto), `${texto}\n\n—\nTICK é uma plataforma de ${NOME} · CNPJ: ${CNPJ}`);
  const html = email.html(texto);
  assert.ok(html.includes(`TICK é uma plataforma de ${NOME} · CNPJ: ${CNPJ}`));
  assert.ok(html.indexOf(texto) < html.indexOf(CNPJ), 'o rodapé vem depois do texto');
});

test('exportação de dados do titular (LGPD) nomeia o MEI como controlador', async () => {
  const p = apoio.pessoa('Titular');
  await apoio.contaDe(p);
  const r = await require('../src/trimundi/titular').exportar(p.cpf);
  assert.equal(
    r.controlador,
    `TICK — ${NOME}, CNPJ: ${CNPJ} (Empresário Individual — MEI; titular e responsável legal: Bruno Henrique Sanches)`,
  );
});
