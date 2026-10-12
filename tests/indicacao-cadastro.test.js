require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const anunciantesRepo = require('../src/anunciantes/repository');
const indicacoesRepo = require('../src/indicacoes/repository');

// "Indicado por" no cadastro (29/09/2026): o nome que a página mostra vem de
// GET /indicacoes/:codigo e precisa ser o da conta que o POST do cadastro
// associa — as duas rotas usam `indicadorDoCupom`. Aqui: só o nome sai, o
// inválido não mostra nada, e o cadastro grava exatamente o indicador exibido.

const criadas = [];
test.after(async () => {
  for (const id of criadas) {
    for (const t of ['notificacoes', 'codigos_confirmacao_email', 'eventos', 'emails_saida']) {
      await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]).catch(() => {});
    }
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

async function subirApp() {
  const app = express();
  app.set('trust proxy', 1); // como src/server.js: o limite de tentativas conta por IP
  app.use(express.json());
  app.use(session({ secret: 'teste-indicacao', resave: false, saveUninitialized: false }));
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/indicacoes/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null), cache: r.headers.get('cache-control') };
  };
  return { base, chamar, fechar: () => new Promise((r) => server.close(r)) };
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

async function pontoIndicador(nome = `Padaria Shot ${randomUUID().slice(0, 6)}`) {
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
  const cupom = await indicacoesRepo.garantirCupom(conta.id, nome);
  return { conta, nome, codigo: cupom.codigo };
}

const cadastro = (extra = {}) => ({
  nome_empresa: `Novo ${randomUUID().slice(0, 8)}`,
  cpf_cnpj: cpfValido(),
  contato_email: `indicado-${randomUUID()}@example.com`,
  contato_telefone: '16999990000',
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

test('GET /indicacoes/:codigo: indicação válida devolve SÓ o nome do negócio, sem cache', async () => {
  const app = await subirApp();
  try {
    const { nome, codigo } = await pontoIndicador();
    const r = await app.chamar('GET', `/indicacoes/${codigo}`);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(r.corpo, { nome }, 'nada além do nome: sem código, id, contato ou documento');
    assert.match(r.cache || '', /no-store/);
    // Minúsculas valem igual — a mesma régua do cadastro.
    assert.deepStrictEqual((await app.chamar('GET', `/indicacoes/${codigo.toLowerCase()}`)).corpo, { nome });
  } finally {
    await app.fechar();
  }
});

test('GET /indicacoes/:codigo: inexistente, fora do formato ou de conta excluída é 404 sem nome', async () => {
  const app = await subirApp();
  try {
    const excluida = await pontoIndicador();
    await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [excluida.conta.id]);
    for (const codigo of ['PT-NAOEXISTE999', 'qualquer-coisa', 'VD-123', excluida.codigo]) {
      const r = await app.chamar('GET', `/indicacoes/${encodeURIComponent(codigo)}`);
      assert.strictEqual(r.status, 404, codigo);
      assert.ok(!r.corpo || !('nome' in r.corpo), `${codigo}: nenhum nome`);
    }
  } finally {
    await app.fechar();
  }
});

test('cadastro pelo link: a conta fica associada ao MESMO indicador que a página mostrou', async () => {
  const app = await subirApp();
  try {
    const indicador = await pontoIndicador('Padaria Shot com um nome de comércio bem comprido pra quebrar linha');
    const ref = indicador.codigo.toLowerCase(); // como veio no link, sem confiar na caixa
    const mostrado = (await app.chamar('GET', `/indicacoes/${ref}`)).corpo.nome;
    const r = await app.chamar('POST', '/anunciantes/cadastro', cadastro({ indicado_por_cupom: ref }));
    assert.strictEqual(r.status, 201, JSON.stringify(r.corpo));
    criadas.push(r.corpo.id);
    const { rows } = await pool.query('SELECT indicado_por_cupom FROM anunciantes WHERE id = $1', [r.corpo.id]);
    assert.strictEqual(rows[0].indicado_por_cupom, indicador.codigo, 'grava o cupom canônico');
    const associado = await indicacoesRepo.buscarPontoPorCupom(rows[0].indicado_por_cupom);
    assert.strictEqual(associado.conta_id, indicador.conta.id, 'associado ao indicador do link');
    assert.strictEqual(associado.nome, mostrado, 'o nome mostrado é o do indicador associado');
  } finally {
    await app.fechar();
  }
});

test('cadastro com indicação inválida: recusa só o cupom (campo), e sem ele a conta nasce sem indicação', async () => {
  const app = await subirApp();
  try {
    const dados = cadastro({ indicado_por_cupom: 'PT-NAOEXISTE999' });
    const recusado = await app.chamar('POST', '/anunciantes/cadastro', dados);
    assert.strictEqual(recusado.status, 400);
    assert.strictEqual(recusado.corpo.campo, 'indicado_por_cupom');
    delete dados.indicado_por_cupom;
    const ok = await app.chamar('POST', '/anunciantes/cadastro', dados);
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.corpo));
    criadas.push(ok.corpo.id);
    const { rows } = await pool.query('SELECT indicado_por_cupom FROM anunciantes WHERE id = $1', [ok.corpo.id]);
    assert.strictEqual(rows[0].indicado_por_cupom, null);
  } finally {
    await app.fechar();
  }
});

// AUD-001 (auditoria V1, ciclo 1): o cadastro por convite de candidatura lia
// a candidatura pelo POOL dentro da transação que já segura uma conexão — com
// o pool cheio, a 2ª conexão nunca vinha e o cadastro pendurava. Com o pool
// reduzido a UMA conexão livre, o cadastro termina e o ponto nasce.
test('cadastro por convite de candidatura termina com uma conexão livre só no pool (AUD-001)', {
  timeout: 15000,
}, async () => {
  const candidaturasRepo = require('../src/candidaturas/repository');
  const convitesRepo = require('../src/convites/repository');
  const ip = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
  const cand = await candidaturasRepo.criar({
    tipo: 'ponto',
    nome: 'Fulana Convite',
    contato_telefone: '16988880000',
    nome_comercio: `Bar Convite ${randomUUID().slice(0, 6)}`,
    endereco: `Rua Convite, ${Math.floor(Math.random() * 9000) + 100}`,
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'bar',
  });
  const convite = await convitesRepo.criar({ papeis: ['ponto'], candidaturaId: cand.id });
  const app = await subirApp();
  const presas = await Promise.all(Array.from({ length: pool.options.max - 1 }, () => pool.connect()));
  let contaId;
  try {
    let tid;
    const estouro = new Promise((_, rejeitar) => {
      tid = setTimeout(() => rejeitar(new Error('sem resposta em 5000 ms — pool travado')), 5000);
    });
    const r = await Promise.race([
      fetch(`${app.base}/anunciantes/cadastro`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify(cadastro({ convite: convite.token })),
      }).then(async (resp) => ({ status: resp.status, corpo: await resp.json().catch(() => null) })),
      estouro,
    ]).finally(() => clearTimeout(tid));
    assert.strictEqual(r.status, 201, JSON.stringify(r.corpo));
    contaId = r.corpo.id;
    criadas.push(contaId);
    for (const presa of presas.splice(0)) presa.release();
    const { rows } = await pool.query('SELECT anunciante_id FROM pontos WHERE candidatura_id = $1', [cand.id]);
    assert.strictEqual(rows[0]?.anunciante_id, contaId, 'o ponto da candidatura nasce ligado à conta nova');
  } finally {
    for (const presa of presas) presa.release();
    await app.fechar();
    await pool.query('DELETE FROM pontos WHERE candidatura_id = $1', [cand.id]);
    await pool.query('DELETE FROM convites WHERE id = $1', [convite.id]);
    await pool.query('DELETE FROM candidaturas WHERE id = $1', [cand.id]);
    await pool.query('DELETE FROM tentativas_acesso WHERE chave LIKE $1', [`${ip}:%`]);
  }
});
