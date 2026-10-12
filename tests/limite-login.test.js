const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { MAX } = require('../src/lib/limite-tentativas');

// Limitador de tentativas na rota HTTP de verdade (auditoria Review-Master,
// ciclo 1, grupo A-limitador — AUD-002). O unit de `decidir()` em
// tests/seguranca.test.js prova a regra; aqui é o BALDE que está em jogo, e
// ele só existe com o app real: a grafia do caminho que o Express aceita.

process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-limite';
const app = require('../src/server');

// Rede própria por execução: o banco de teste é compartilhado, e cada arquivo
// limpa só as próprias chaves (o servidor confia em 1 proxy, X-Forwarded-For).
// 198.18.0.0/15 (faixa de benchmark) e não 10.x: outros arquivos apagam
// `10.%` no after (player-mvp, distribuicao), e `npm test` roda em paralelo —
// a limpeza deles no meio do laço daqui zerava o balde e o 429 não vinha.
const REDE = `198.${18 + Math.floor(Math.random() * 2)}.${Math.floor(Math.random() * 250)}`;
const ip = (n) => `${REDE}.${n}`;

let srv;
test.before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  srv = {
    base: `http://127.0.0.1:${server.address().port}`,
    fechar: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
});

test.after(async () => {
  await srv.fechar();
  await pool.query('DELETE FROM tentativas_acesso WHERE chave LIKE $1', [`${REDE}.%`]);
  await pool.end();
});

async function post(caminho, corpo, cabecalhos) {
  const r = await fetch(`${srv.base}${caminho}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...cabecalhos },
    body: JSON.stringify(corpo),
    redirect: 'manual',
  });
  await r.arrayBuffer();
  return r.status;
}

// Um e-mail sem conta, novo a cada chamada.
const semConta = () => ({ email: `ninguem-${randomUUID()}@limite.test`, senha: 'Errada12@' });

// AUD-002: a chave era `${req.ip}:${req.path}` com o caminho CRU. Sem `case
// sensitive routing`/`strict routing`, `/Anunciantes/login` e
// `/anunciantes/login/` caem no MESMO handler, e cada grafia ganhava um balde
// novo de 10 — força bruta sem teto trocando uma letra.
test('estourado o balde do login, qualquer grafia do mesmo caminho responde 429', async () => {
  const origem = { 'x-forwarded-for': ip(2) };
  for (let i = 1; i <= MAX; i++) {
    assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 401, `tentativa ${i} dentro do limite`);
  }
  assert.strictEqual(await post('/anunciantes/login', semConta(), origem), 429, 'a 11ª estoura');
  assert.strictEqual(await post('/Anunciantes/login', semConta(), origem), 429, 'caixa alta na primeira letra');
  assert.strictEqual(await post('/anunciantes/login/', semConta(), origem), 429, 'barra final');
  assert.strictEqual(await post('/ANUNCIANTES/LOGIN', semConta(), origem), 429, 'tudo maiúsculo');

  // Mesma regra no login do admin.
  const admin = () => ({ usuario: `ninguem-${randomUUID()}`, senha: 'errada' });
  for (let i = 1; i <= MAX; i++) assert.strictEqual(await post('/admin/login', admin(), origem), 401);
  assert.strictEqual(await post('/admin/login', admin(), origem), 429);
  assert.strictEqual(await post('/ADMIN/login', admin(), origem), 429, 'caixa alta no admin');
});
