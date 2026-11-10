const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const apoio = require('./trimundi-apoio');
const email = require('../src/trimundi/email');

// Identidade da Trimundi (pedido do dono, 09/11/2026): marca própria, a logo
// enviada, e nenhum link ou elemento visual que leve à Mostraí.

const PAGINAS = path.join(__dirname, '..', 'src', 'trimundi', 'paginas');

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

test('nenhuma página da Trimundi cita a Mostraí, usa a marca dela ou leva para o site dela', () => {
  for (const arquivo of fs.readdirSync(PAGINAS).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(PAGINAS, arquivo), 'utf8');
    assert.doesNotMatch(html, /mostra[ií]/i, `${arquivo} cita a Mostraí`);
    assert.doesNotMatch(html, /href="\/"/, `${arquivo} tem link para a home da Mostraí`);
    assert.doesNotMatch(html, /src="\/img\//, `${arquivo} usa imagem da Mostraí`);
    assert.match(html, /\/ticket\/img\/trimundi-logo\.webp/, `${arquivo} sem a logo da Trimundi`);
    assert.match(html, /\/ticket\/img\/trimundi-icone\.png/, `${arquivo} sem o ícone da Trimundi`);
  }
});

test('a página servida traz a logo e a marca Trimundi, e as imagens existem', async () => {
  const r = await fetch(`${srv.base}/ticket/recuperar`);
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /Trimundi/);
  assert.doesNotMatch(html, /mostra[ií]/i);
  for (const img of ['trimundi-logo.webp', 'trimundi-logo-256.png', 'trimundi-icone.png']) {
    const i = await fetch(`${srv.base}/ticket/img/${img}`);
    assert.equal(i.status, 200, img);
    await i.arrayBuffer();
  }
});

test('o e-mail sai com a logo e o nome da Trimundi no corpo, e o texto é escapado', () => {
  const corpo = email.html(
    'Olá <script>x</script>\n\nSeus ingressos: https://site.teste.invalid/ticket/pedido/1?t=a&b=c',
  );
  assert.match(corpo, /\/ticket\/img\/trimundi-logo-256\.png/);
  assert.match(corpo, /TRIMUNDI/);
  assert.doesNotMatch(corpo, /<script>/);
  assert.match(corpo, /<a href="https:\/\/site\.teste\.invalid\/ticket\/pedido\/1\?t=a&amp;b=c"/);
  assert.doesNotMatch(corpo, /mostra[ií]/i);
});

test('endereço que não existe em /ticket mostra a página da Trimundi, não a da Mostraí', async () => {
  const r = await fetch(`${srv.base}/ticket/nao/existe/mesmo`);
  assert.equal(r.status, 404);
  const html = await r.text();
  assert.match(html, /Trimundi/);
  assert.doesNotMatch(html, /mostra[ií]/i);
  const api = await fetch(`${srv.base}/ticket/api/nada`);
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { erro: 'não encontrado' });
  const css = await fetch(`${srv.base}/ticket/ticket.css`);
  assert.equal(css.status, 200, 'os arquivos estáticos continuam servidos');
  await css.text();
});
