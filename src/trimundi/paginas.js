const fs = require('node:fs');
const path = require('node:path');
const { comSemTransformacao } = require('../lib/html-sem-transformacao');

// Páginas da Trimundi servidas por rota (não por public/): o servidor da
// Mostraí redireciona /x para /x.html em todo HTML de public/, e estes
// endereços precisam ser exatamente /ticket/ativar, /ticket/checkin e
// /ticket/<evento>/<edição>. Os scripts e estilos ficam em public/ticket/.

const PASTA = path.join(__dirname, 'paginas');
const cache = new Map();

function modelo(nome) {
  if (!cache.has(nome) || process.env.NODE_ENV !== 'production') {
    cache.set(nome, fs.readFileSync(path.join(PASTA, `${nome}.html`), 'utf8'));
  }
  return cache.get(nome);
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

// `{{chave}}` no modelo vira o valor escapado.
function enviar(res, nome, valores = {}, { status = 200, cache: politica = 'no-cache' } = {}) {
  const html = modelo(nome).replace(/\{\{(\w+)\}\}/g, (_, k) => esc(valores[k] ?? ''));
  res.status(status);
  res.set('Cache-Control', comSemTransformacao(politica));
  res.type('html').send(html);
}

module.exports = { enviar, esc };
