const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const express = require('express');
const { comSemTransformacao, setHeadersEstaticos } = require('../src/lib/html-sem-transformacao');

// Decisão D6 do dono (24/09/2026): a borda da Cloudflare não pode injetar o
// beacon do Web Analytics no HTML do Mostraí (a CSP recusa, e o console de
// toda página de produção mostrava o erro). `no-transform` no HTML é o que
// impede a injeção; CSS/JS/imagem não precisam dele.

test('comSemTransformacao acrescenta a diretiva uma vez só', () => {
  assert.strictEqual(comSemTransformacao(''), 'no-transform');
  assert.strictEqual(comSemTransformacao('public, max-age=0'), 'public, max-age=0, no-transform');
  assert.strictEqual(comSemTransformacao('no-store, No-Transform'), 'no-store, No-Transform');
});

test('estáticos: HTML sai com no-transform, CSS e JS não', async () => {
  const app = express();
  app.use(express.static(path.join(__dirname, '..', 'public'), { setHeaders: setHeadersEstaticos }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const pagina of ['/', '/planos.html', '/anunciante/cadastro.html']) {
      const r = await fetch(base + pagina);
      assert.strictEqual(r.status, 200, pagina);
      assert.match(r.headers.get('cache-control'), /no-transform/, pagina);
    }
    for (const recurso of ['/style.css', '/layout.js']) {
      const r = await fetch(base + recurso);
      assert.doesNotMatch(r.headers.get('cache-control'), /no-transform/, recurso);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
