const test = require('node:test');
const assert = require('node:assert');

// Trimundi DESLIGADA (RN-T31): sem banco próprio configurado, a Mostraí sobe
// e funciona exatamente como antes — /ticket/* responde 503, o Admin da
// Trimundi também, e o login da Mostraí não procura operador. Este arquivo
// roda no próprio processo, sem o apoio da Trimundi (que liga o módulo).
// Variável vazia: o dotenv não sobrescreve (o .env local pode ter a URL).
process.env.TRIMUNDI_DATABASE_URL = '';
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-trimundi-desligada';

const app = require('../src/server');
const config = require('../src/trimundi/config');

let srv;
test.before(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  srv = { server, base: `http://127.0.0.1:${server.address().port}` };
});
test.after(async () => {
  srv.server.closeAllConnections();
  await new Promise((r) => srv.server.close(r));
  await require('../src/db/pool').end();
});

const ip = `198.20.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
const pedir = (caminho, init = {}) =>
  fetch(`${srv.base}${caminho}`, {
    redirect: 'manual',
    ...init,
    headers: { 'x-forwarded-for': ip, ...(init.headers || {}) },
  });

test('sem banco próprio, o módulo está desligado', () => {
  assert.equal(config.configurada(), false);
});

test('API e páginas de /ticket respondem 503, sem tocar em banco nenhum', async () => {
  const api = await pedir('/ticket/api/edicoes/treemundo/ed01');
  assert.equal(api.status, 503);
  assert.match((await api.json()).erro, /não está configurada/);

  const pagina = await pedir('/ticket/treemundo/ed01', { headers: { accept: 'text/html' } });
  assert.equal(pagina.status, 503);
  assert.match(pagina.headers.get('content-type'), /text\/html/);

  for (const caminho of ['/ticket/checkin', '/ticket/ativar']) {
    assert.equal((await pedir(caminho)).status, 503, caminho);
  }
  const webhook = await pedir('/ticket/api/checkout/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(webhook.status, 503);
});

test('o Admin da Trimundi responde 503 com sessão e 401 sem', async () => {
  assert.equal((await pedir('/admin/trimundi/estado')).status, 401);
  const login = await pedir('/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const r = await pedir('/admin/trimundi/estado', { headers: { cookie } });
  assert.equal(r.status, 503);
});

test('o login da Mostraí segue igual: e-mail desconhecido é 401, não 503', async () => {
  const r = await pedir('/anunciantes/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `ninguem.${Date.now()}@exemplo.com`, senha: 'Qualquer12@' }),
  });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { erro: 'e-mail ou senha inválidos' });
  assert.equal((await pedir('/health')).status, 200);
});
