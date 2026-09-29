require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const jsQR = require('jsqr');
const pool = require('../src/db/pool');

// Painel do usuário (29/09/2026, pedido do dono): o card "Indicações" do
// ponto ganha o QR Code do MESMO link e o histórico de quem se cadastrou por
// ele — sem livro próprio: cadastro (indicado_por_cupom), ciclos pagos e o
// ledger de créditos. Casos do pedido:
//   A sem ref → ninguém indica · B ref válido → o nome certo · C ref inválido
//   → nenhuma indicação · D cadastro entra no histórico do ponto certo ·
//   E sem pagamento → 0 crédito · F primeiro pagamento → +1 · G renovação →
//   +1, uma vez · H reprocessar a mesma cobrança não soma.
// E o QR: decodificado por um leitor independente (jsqr), aponta pro link à
// vista, com o cupom do ponto, e o cadastro por ele indica o mesmo ponto.

process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-de-teste';
// Endereço público fixo, como em produção: é o que vai dentro do QR.
process.env.SITE_URL = 'https://mostrai.test';

const anunciantesRepo = require('../src/anunciantes/repository');
const indicacoesRepo = require('../src/indicacoes/repository');
const creditosRepo = require('../src/creditos/repository');
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');

// IP próprio por execução: o limitador de cadastro conta por IP e é o mesmo
// banco pros arquivos de teste rodando em paralelo.
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

const criadas = [];
test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const id of criadas) {
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1 OR origem_conta_id = $1', [id]);
    for (const t of [
      'ciclos_contratados',
      'notificacoes',
      'planos_administrativos',
      'eventos',
      'emails_saida',
      'codigos_confirmacao_email',
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]).catch(() => {});
    }
    await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

async function subirApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use(session({ secret: 'teste-indicacoes-painel', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/indicacoes/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, { conta, corpo } = {}) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        'x-forwarded-for': IP,
        ...(conta ? { 'x-conta': String(conta) } : {}),
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return {
      status: r.status,
      corpo: json,
      texto,
      tipo: r.headers.get('content-type'),
      cache: r.headers.get('cache-control'),
    };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

// CPF com dígitos verificadores válidos (o cadastro confere).
function cpfValido() {
  const base = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (new Set(base).size === 1) base[0] = (base[0] + 1) % 10;
  const digito = (nums) => {
    const soma = nums.reduce((s, n, i) => s + n * (nums.length + 1 - i), 0);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = digito(base);
  const d2 = digito([...base, d1]);
  return [...base, d1, d2].join('');
}

// Conta dona de um ponto da rede (a única que tem indicação) e o cupom dela.
async function pontoIndicador(nome = `Padaria Painel ${randomUUID().slice(0, 6)}`) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: nome,
    cpf_cnpj: cpfValido(),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `indicador-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criadas.push(conta.id);
  await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'R', '16 9', $2)`,
    [nome, conta.id],
  );
  const cupom = await indicacoesRepo.garantirCupom(conta.id, nome);
  return { conta, nome, codigo: cupom.codigo };
}

const dadosCadastro = (extra = {}) => ({
  nome_empresa: `Indicado ${randomUUID().slice(0, 8)}`,
  cpf_cnpj: cpfValido(),
  contato_email: `indicado-${randomUUID()}@example.com`,
  contato_telefone: '16988887777',
  senha: 'Senha@forte1',
  aceitou_termos: true,
  categoria_livre: 'teste',
  cep: '15997-078',
  logradouro: 'Avenida 28 de Agosto',
  numero: '10',
  bairro: 'Alto',
  cidade: 'Matão',
  uf: 'SP',
  ...extra,
});

async function cadastrar(app, extra) {
  const dados = dadosCadastro(extra);
  const r = await app.chamar('POST', '/anunciantes/cadastro', { corpo: dados });
  if (r.status === 201) criadas.push(r.corpo.id);
  return { r, dados };
}

// Um ciclo pago pelo caminho real (aplicarCicloPago): cobrança, snapshot do
// ciclo e — na mesma transação — o crédito de indicação.
async function pagarCiclo(contaId, assinaturaId = null) {
  const id =
    assinaturaId ||
    (await assinaturasRepo.criar({ anuncianteId: contaId, planoId: 'essencial-1m', status: 'ativa' })).id;
  await sc.aplicarCicloPago(await assinaturasRepo.buscarPorId(id), `teste-indicacoes-painel-${randomUUID()}`);
  return id;
}

const hoje = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());

// Leitor independente do SVG (mesmo de tests/qr-institucional.test.js):
// refaz a grade de módulos a partir do `path` escuro e entrega pro jsqr.
function lerSvg(svg) {
  const n = Number(svg.match(/viewBox="0 0 (\d+) \1"/)[1]);
  const d = svg.match(/<path stroke="[^"]+" d="([^"]+)"/)[1];
  const escuro = Array.from({ length: n }, () => new Array(n).fill(false));
  let x = 0;
  let y = 0;
  for (const [, cmd, args] of d.matchAll(/([Mmh])([^Mmh]*)/g)) {
    const nums = args
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (cmd === 'M') [x, y] = nums;
    else if (cmd === 'm') x += nums[0];
    else {
      for (let i = 0; i < nums[0]; i++) escuro[Math.floor(y)][x + i] = true;
      x += nums[0];
    }
  }
  const px = 8;
  const lado = n * px;
  const rgba = new Uint8ClampedArray(lado * lado * 4).fill(255);
  for (let i = 0; i < lado; i++) {
    for (let j = 0; j < lado; j++) {
      if (!escuro[Math.floor(i / px)][Math.floor(j / px)]) continue;
      const p = (i * lado + j) * 4;
      rgba[p] = 0;
      rgba[p + 1] = 0;
      rgba[p + 2] = 0;
    }
  }
  const codigo = jsQR(rgba, lado, lado);
  return codigo ? codigo.data : null;
}

test('A, B e C: sem ref ninguém indica; ref válido mostra o nome certo; inválido não indica ninguém', async () => {
  const app = await subirApp();
  try {
    const { nome, codigo } = await pontoIndicador();
    // B: o nome que a página mostra é o do dono do cupom — e só ele.
    const quem = await app.chamar('GET', `/indicacoes/${codigo}`);
    assert.strictEqual(quem.status, 200);
    assert.deepStrictEqual(quem.corpo, { nome });
    // A: cadastro sem ref não tem indicação.
    const semRef = await cadastrar(app, {});
    assert.strictEqual(semRef.r.status, 201);
    assert.strictEqual((await anunciantesRepo.buscarPorId(semRef.r.corpo.id)).indicado_por_cupom, null);
    // C: ref inexistente não mostra nome e não é gravado (o cadastro recusa
    // o cupom; a página tira e envia de novo, sem indicação).
    assert.strictEqual((await app.chamar('GET', '/indicacoes/PT-NAOHA999')).status, 404);
    const invalido = await cadastrar(app, { indicado_por_cupom: 'PT-NAOHA999' });
    assert.strictEqual(invalido.r.status, 400);
    assert.strictEqual(invalido.r.corpo.campo, 'indicado_por_cupom');
  } finally {
    await app.fechar();
  }
});

test('D e E: o cadastro pelo link entra no histórico do ponto certo, e só dele; sem pagamento, 0 crédito', async () => {
  const app = await subirApp();
  try {
    const p1 = await pontoIndicador();
    const p2 = await pontoIndicador();
    const { r, dados } = await cadastrar(app, { indicado_por_cupom: p1.codigo.toLowerCase() });
    assert.strictEqual(r.status, 201);
    const h1 = await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: p1.conta.id });
    assert.strictEqual(h1.status, 200);
    assert.strictEqual(h1.cache, 'private, no-store');
    assert.deepStrictEqual(h1.corpo.indicados, [
      { nome: dados.nome_empresa, cadastroEm: hoje(), plano: null, pagamentos: 0, creditos: 0, creditosEm: [] },
    ]);
    assert.deepStrictEqual(h1.corpo.resumo, { contas: 1, contrataram: 0, creditos: 0 });
    const h2 = await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: p2.conta.id });
    assert.deepStrictEqual(h2.corpo.indicados, [], 'o cadastro não aparece no histórico de outro ponto');
  } finally {
    await app.fechar();
  }
});

test('F, G e H: primeiro pagamento +1; renovação +1, uma vez; reprocessar a mesma cobrança não soma', async () => {
  const app = await subirApp();
  try {
    const p = await pontoIndicador();
    const { r, dados } = await cadastrar(app, { indicado_por_cupom: p.codigo });
    const indicado = r.corpo.id;
    const historico = async () => (await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: p.conta.id })).corpo;

    // F: primeiro pagamento confirmado → +1 crédito, "primeiro pagamento".
    const assinatura = await pagarCiclo(indicado);
    let h = await historico();
    assert.strictEqual(h.indicados.length, 1);
    assert.strictEqual(h.indicados[0].nome, dados.nome_empresa);
    assert.strictEqual(h.indicados[0].plano, 'Essencial · Mensal');
    assert.strictEqual(h.indicados[0].pagamentos, 1);
    assert.strictEqual(h.indicados[0].creditos, 1);
    assert.deepStrictEqual(h.indicados[0].creditosEm, [{ data: hoje(), tipo: 'primeiro_pagamento' }]);
    assert.deepStrictEqual(h.resumo, { contas: 1, contrataram: 1, creditos: 1 });

    // G: renovação paga → +1, como renovação — o total vai a 2, não a 3.
    await pagarCiclo(indicado, assinatura);
    h = await historico();
    assert.strictEqual(h.indicados[0].pagamentos, 2);
    assert.strictEqual(h.indicados[0].creditos, 2);
    assert.deepStrictEqual(
      h.indicados[0].creditosEm.map((c) => c.tipo),
      ['primeiro_pagamento', 'renovacao'],
    );

    // H: a mesma cobrança de novo (webhook duplicado, conciliação) — o ledger
    // recusa pela chave da cobrança; histórico e resumo não mudam.
    const { rows } = await pool.query(
      'SELECT id FROM cobrancas_confirmadas WHERE anunciante_id = $1 ORDER BY id DESC LIMIT 1',
      [indicado],
    );
    assert.strictEqual(await creditosRepo.registrarCreditoIndicacao(p.conta.id, indicado, rows[0].id), null);
    const depois = await historico();
    assert.deepStrictEqual(depois, h);
    const { rows: linhas } = await pool.query(
      `SELECT count(*)::int AS n FROM creditos_ledger WHERE anunciante_id = $1 AND origem_conta_id = $2`,
      [p.conta.id, indicado],
    );
    assert.strictEqual(linhas[0].n, 2);
    // O saldo do ponto é a soma do ledger: os mesmos 2 créditos.
    assert.strictEqual(await creditosRepo.saldo(p.conta.id), 2);
  } finally {
    await app.fechar();
  }
});

test('histórico mostra só o que o ponto pode ver: nada de contato, documento, endereço, id ou valor', async () => {
  const app = await subirApp();
  try {
    const p = await pontoIndicador();
    const { r, dados } = await cadastrar(app, { indicado_por_cupom: p.codigo });
    await pagarCiclo(r.corpo.id);
    const h = await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: p.conta.id });
    assert.deepStrictEqual(Object.keys(h.corpo).sort(), ['codigo', 'indicados', 'link', 'nome', 'resumo']);
    assert.deepStrictEqual(Object.keys(h.corpo.indicados[0]).sort(), [
      'cadastroEm',
      'creditos',
      'creditosEm',
      'nome',
      'pagamentos',
      'plano',
    ]);
    // Texto longo e único da conta indicada: não pode aparecer em lugar
    // nenhum da resposta.
    for (const proibido of [
      dados.contato_email,
      dados.contato_telefone,
      dados.cpf_cnpj,
      dados.logradouro,
      dados.bairro,
    ]) {
      assert.ok(!h.texto.includes(proibido), `o histórico não pode conter ${proibido}`);
    }
    // Número curto (id da conta, valor pago) confere por campo — como texto
    // solto, "99" ou o id podiam coincidir com o número do cupom.
    const campos = [];
    JSON.parse(h.texto, (chave, valor) => {
      campos.push([chave, valor]);
      return valor;
    });
    assert.ok(
      !campos.some(([chave]) => /id$|valor|email|telefone|cpf|cnpj|endereco|logradouro|token|senha/i.test(chave)),
    );
    assert.ok(!campos.some(([, valor]) => valor === r.corpo.id || valor === 99 || valor === '99.00'));
  } finally {
    await app.fechar();
  }
});

test('indicação é só do ponto: conta sem ponto e conta própria recebem 404 no histórico e no QR', async () => {
  const app = await subirApp();
  try {
    const { r } = await cadastrar(app, {});
    for (const caminho of ['/anunciantes/me/indicacoes', '/anunciantes/me/indicacoes/qr.svg']) {
      assert.strictEqual((await app.chamar('GET', caminho, { conta: r.corpo.id })).status, 404);
      assert.strictEqual((await app.chamar('GET', caminho)).status, 401, 'sem sessão');
    }
    const { rows } = await pool.query('SELECT id FROM anunciantes WHERE conta_propria LIMIT 1');
    if (rows[0]) {
      assert.strictEqual((await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: rows[0].id })).status, 404);
    }
  } finally {
    await app.fechar();
  }
});

test('QR Code: decodifica o MESMO link à vista, com o cupom do ponto, e o cadastro por ele indica o mesmo ponto', async () => {
  const app = await subirApp();
  try {
    const p = await pontoIndicador();
    const h = await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: p.conta.id });
    const esperado = `https://mostrai.test/anunciante/cadastro.html?ref=${p.codigo}`;
    assert.strictEqual(h.corpo.link, esperado);
    assert.strictEqual(h.corpo.nome, p.nome);

    const qr = await app.chamar('GET', '/anunciantes/me/indicacoes/qr.svg', { conta: p.conta.id });
    assert.strictEqual(qr.status, 200);
    assert.match(qr.tipo, /^image\/svg\+xml/);
    assert.strictEqual(qr.cache, 'private, no-store');
    const conteudo = lerSvg(qr.texto);
    assert.strictEqual(conteudo, h.corpo.link, 'o QR aponta pro link à vista');
    // Só o endereço público de cadastro e o cupom — nenhum id, sessão ou dado.
    const url = new URL(conteudo);
    assert.strictEqual(url.origin + url.pathname, 'https://mostrai.test/anunciante/cadastro.html');
    assert.deepStrictEqual([...url.searchParams.keys()], ['ref']);
    assert.ok(!conteudo.includes(String(p.conta.id)));

    // Quem escaneia e se cadastra fica indicado por ESTE ponto.
    const { r } = await cadastrar(app, { indicado_por_cupom: url.searchParams.get('ref') });
    assert.strictEqual(r.status, 201);
    assert.strictEqual((await anunciantesRepo.buscarPorId(r.corpo.id)).indicado_por_cupom, p.codigo);
    const depois = await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: p.conta.id });
    assert.strictEqual(depois.corpo.indicados.length, 1);
  } finally {
    await app.fechar();
  }
});

test('sem SITE_URL: link nulo e QR 503 — nunca um endereço relativo dentro do QR', async () => {
  const app = await subirApp();
  const antes = process.env.SITE_URL;
  try {
    const p = await pontoIndicador();
    delete process.env.SITE_URL;
    const h = await app.chamar('GET', '/anunciantes/me/indicacoes', { conta: p.conta.id });
    assert.strictEqual(h.status, 200);
    assert.strictEqual(h.corpo.link, null);
    assert.strictEqual(
      (await app.chamar('GET', '/anunciantes/me/indicacoes/qr.svg', { conta: p.conta.id })).status,
      503,
    );
  } finally {
    process.env.SITE_URL = antes;
    await app.fechar();
  }
});
