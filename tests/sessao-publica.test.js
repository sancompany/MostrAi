require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const anunciantesRepo = require('../src/anunciantes/repository');

// Decisão D4 do dono (24/09/2026): a página pública pergunta "tem alguém
// logado?" sem gerar 401 no console do visitante — e sem afrouxar nada: a
// rota privada continua 401 sem sessão, e a pública não devolve dado pessoal.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-sessao', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/conta/routes'));
  app.use(require('../src/anunciantes/routes').router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: async (caminho, conta) => {
      const r = await fetch(base + caminho, { headers: conta ? { 'x-conta': String(conta) } : {} });
      return { status: r.status, cache: r.headers.get('cache-control'), corpo: await r.json().catch(() => null) };
    },
    fechar: () => new Promise((r) => server.close(r)),
  };
}

test('GET /conta/sessao: anônimo é 200 com logado:false; a rota privada segue 401', async () => {
  const app = await subirApp();
  try {
    const s = await app.get('/conta/sessao');
    assert.strictEqual(s.status, 200);
    assert.deepStrictEqual(s.corpo, { logado: false });
    assert.match(s.cache, /no-store/);
    const privada = await app.get('/anunciantes/me');
    assert.strictEqual(privada.status, 401, 'autenticação não pode afrouxar');
  } finally {
    await app.fechar();
  }
});

test('GET /conta/sessao: logado recebe só nome, foto e papéis', async () => {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Sessão ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `sessao-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  const app = await subirApp();
  try {
    const s = await app.get('/conta/sessao', conta.id);
    assert.strictEqual(s.status, 200);
    assert.strictEqual(s.corpo.logado, true);
    assert.deepStrictEqual(Object.keys(s.corpo.conta).sort(), ['foto_url', 'nome_empresa', 'papeis']);
    assert.strictEqual(s.corpo.conta.nome_empresa, conta.nome_empresa);
    // Conta excluída conta como não logada.
    await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [conta.id]);
    assert.deepStrictEqual((await app.get('/conta/sessao', conta.id)).corpo, { logado: false });
  } finally {
    await app.fechar();
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
  }
});
