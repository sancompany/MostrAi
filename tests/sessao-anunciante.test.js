const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// Sessão do anunciante (estação sessão + upload, 27/09/2026).
//
// Causa do "perdi a sessão no meio do uso": admin e conta do cliente
// dividiam UM cookie de sessão, e cada login faz `regenerate` — entrar no
// admin derrubava a conta aberta no mesmo navegador (e vice-versa), e sair de
// um saía dos dois. Reproduzido em curl antes da correção:
//   me 200 → POST /admin/login → me 401.
// Aqui roda o `app` REAL do src/server.js (rotas de login de verdade), com o
// store no Postgres de verdade.

process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-sessao';
const app = require('../src/server');
const { montarSessoes } = require('../src/lib/sessao');

// IP próprio por execução (o server confia em 1 proxy): o limitador de
// tentativas conta por IP+rota, e o contador deste teste não se mistura com
// o de ninguém.
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function ouvir(aplicacao) {
  const server = aplicacao.listen(0);
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    fechar: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

// Pote de cookies de navegador, com o `Path` respeitado: o cookie do admin
// (Path=/admin) só vai nas rotas /admin — igual ao navegador.
function navegador() {
  const potes = new Map(); // nome -> { valor, path }
  return {
    potes,
    async pedir(base, metodo, caminho, corpo) {
      const cookie = [...potes.entries()]
        .filter(([, c]) => caminho.startsWith(c.path))
        .map(([nome, c]) => `${nome}=${c.valor}`)
        .join('; ');
      const r = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': IP,
          ...(cookie ? { cookie } : {}),
        },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      for (const linha of r.headers.getSetCookie()) {
        const [par, ...atributos] = linha.split(';').map((s) => s.trim());
        const [nome, ...resto] = par.split('=');
        const path = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
        potes.set(nome, { valor: resto.join('='), path, atributos });
      }
      return r.status;
    },
  };
}

async function criarConta() {
  const senha = 'Senha12@teste';
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true)
     RETURNING id, contato_email`,
    [
      `Sessao ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `sessao-${randomUUID()}@example.com`,
      await gerarHash(senha),
    ],
  );
  return { ...rows[0], senha };
}

async function limpar(conta) {
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
}

// Rota do admin que não existe: com sessão de admin, passa pelo guarda e cai
// no 404; sem sessão, o guarda responde 401. Mede só a autenticação.
const ADMIN_PROBE = '/admin/sonda-de-sessao-inexistente';

test('entrar no admin não derruba a conta do anunciante, e sair de um não sai do outro', async () => {
  const conta = await criarConta();
  const srv = await ouvir(app);
  const nav = navegador();
  try {
    assert.strictEqual(
      await nav.pedir(srv.base, 'POST', '/anunciantes/login', { email: conta.contato_email, senha: conta.senha }),
      200,
    );
    assert.strictEqual(await nav.pedir(srv.base, 'GET', '/anunciantes/me'), 200);

    // O passo que derrubava o anunciante.
    assert.strictEqual(
      await nav.pedir(srv.base, 'POST', '/admin/login', {
        usuario: process.env.ADMIN_USER,
        senha: process.env.ADMIN_PASSWORD,
      }),
      200,
    );
    assert.strictEqual(await nav.pedir(srv.base, 'GET', '/anunciantes/me'), 200, 'anunciante continua logado');
    assert.strictEqual(await nav.pedir(srv.base, 'GET', ADMIN_PROBE), 404, 'admin logado');

    // Entrar como anunciante de novo não derruba o admin.
    assert.strictEqual(
      await nav.pedir(srv.base, 'POST', '/anunciantes/login', { email: conta.contato_email, senha: conta.senha }),
      200,
    );
    assert.strictEqual(await nav.pedir(srv.base, 'GET', ADMIN_PROBE), 404, 'admin continua logado');

    // Cookies separados: o do admin só viaja pro /admin, os dois httpOnly.
    const admin = nav.potes.get('mostrai.admin');
    const cliente = nav.potes.get('connect.sid');
    assert.ok(admin && cliente, 'dois cookies');
    assert.strictEqual(admin.path, '/admin');
    assert.strictEqual(cliente.path, '/');
    assert.ok(admin.atributos.some((a) => /^httponly$/i.test(a)));
    assert.ok(cliente.atributos.some((a) => /^httponly$/i.test(a)));

    // Sair do admin não sai da conta; sair da conta não sai do admin.
    assert.strictEqual(await nav.pedir(srv.base, 'POST', '/admin/logout'), 200);
    assert.strictEqual(await nav.pedir(srv.base, 'GET', ADMIN_PROBE), 401);
    assert.strictEqual(await nav.pedir(srv.base, 'GET', '/anunciantes/me'), 200);
    assert.strictEqual(await nav.pedir(srv.base, 'POST', '/anunciantes/logout'), 200);
    assert.strictEqual(await nav.pedir(srv.base, 'GET', '/anunciantes/me'), 401, 'sair da conta sai de verdade');
  } finally {
    await srv.fechar();
    await limpar(conta);
  }
});

test('a sessão sobrevive a um restart: outro processo, outro store, mesmo banco', async () => {
  const conta = await criarConta();
  const antes = await ouvir(app);
  const nav = navegador();
  let depois = null;
  let memoria = null;
  try {
    assert.strictEqual(
      await nav.pedir(antes.base, 'POST', '/anunciantes/login', { email: conta.contato_email, senha: conta.senha }),
      200,
    );
    await antes.fechar();

    // "Processo novo": app e store recém-criados, nada em memória do antigo.
    const novo = express();
    novo.set('trust proxy', 1);
    novo.use(express.json());
    montarSessoes(novo, pool);
    novo.use(require('../src/anunciantes/routes').router);
    depois = await ouvir(novo);
    assert.strictEqual(await nav.pedir(depois.base, 'GET', '/anunciantes/me'), 200, 'mesma sessão depois do restart');

    // Controle: com o MemoryStore (o erro de 2026-09), o mesmo cookie num
    // processo novo não vale — o teste de cima pegaria a regressão.
    const comMemoria = express();
    comMemoria.use(session({ secret: process.env.SESSION_SECRET, resave: false, saveUninitialized: false }));
    comMemoria.use(require('../src/anunciantes/routes').router);
    memoria = await ouvir(comMemoria);
    assert.strictEqual(await nav.pedir(memoria.base, 'GET', '/anunciantes/me'), 401);
  } finally {
    await depois?.fechar();
    await memoria?.fechar();
    await limpar(conta);
  }
});

test.after(() => pool.end());
