// Aponta pra API certa em dev (Express local) vs produção (Render).
// ponytail: sem build step, então isso é JS puro incluído antes dos outros
// scripts — não precisa de bundler pra trocar a URL por ambiente.
// Localhost E IP de rede local: quando a TV do ponto abre o player pelo IP do
// computador (ex.: http://192.168.0.10:3000/player.html), o hostname não é
// "localhost" — antes disso cair aqui, ela ia tentar falar com a API de
// produção e o player ficava eternamente em "offline, tocando o cache" sem
// dizer o porquê. Como o próprio Express serve o site, mesma origem resolve
// os dois casos (e leva a porta junto).
const REDE_LOCAL = /^(localhost|127\.0\.0\.1|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// Sem build step, `const` no topo de um <script> clássico vai pro escopo global
// e é assim que as outras páginas leem esta constante. O lint só enxerga este
// arquivo e não vê uso nenhum — daí a supressão, que é sobre isso e nada mais.
// biome-ignore lint/correctness/noUnusedVariables: lida pelos scripts das páginas, não por este arquivo
const API_BASE_URL = REDE_LOCAL.test(window.location.hostname)
  ? window.location.origin
  // Produção: a API é servida pelo mesmo serviço que serve o site (Northflank),
  // então mesma origem vale lá também. Se um dia a API for pra outro host,
  // troque aqui — é o único lugar.
  : window.location.origin;

// ---------------------------------------------------------------------------
// Utilitários compartilhados. Ficam aqui porque o config.js é o único script
// carregado por toda página que tem JS — sem build step, é o lugar honesto.
// Vão em window.* (e não em `const`) de propósito: página que já declara a
// própria `fmt` continuaria funcionando, um `const fmt` aqui quebraria ela.
// ---------------------------------------------------------------------------

// Escapa dado que veio do servidor antes de entrar em innerHTML. Nome de
// empresa e de ponto são digitados em formulário PÚBLICO, sem autenticação, e
// depois renderizados na sessão de outra pessoa (o vendedor vê o nome da
// empresa que o anunciante digitou; o anunciante vê o nome do ponto). Sem
// isso, um cadastro com <img src=x onerror=...> roda script na conta alheia.
const ESCAPES_HTML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
window.esc = function esc(v) {
  return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, (c) => ESCAPES_HTML[c]);
};

// WhatsApp do Mostraí, num lugar só. Estava escrito à mão em 6 arquivos: mudar
// de número significava caçar string, e a mensagem pré-preenchida já tinha
// divergido entre as páginas. O formato é o oficial (wa.me): país + DDD +
// número, só dígitos — `+`, zeros e parênteses quebram no WhatsApp Web.
window.WHATSAPP = '5516994635946';

// Monta o link com a mensagem pronta. Mensagem por página é recomendação da
// referência de mercado: a conversa começa sabendo de onde a pessoa veio, em
// vez de um "oi" solto que o dono precisa decifrar.
window.linkWhatsApp = function linkWhatsApp(mensagem) {
  return `https://wa.me/${window.WHATSAPP}?text=${encodeURIComponent(mensagem)}`;
};

window.fmtBRL = function fmtBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
};

// Trava de duplo clique em qualquer formulário do site. Antes, dois cliques
// no botão de cadastro criavam duas contas / dois pontos / duas mensagens —
// e no caso do plano, duas cobranças. Libera quando não há mais requisição em
// voo, com um teto de 15s caso o handler não faça nenhuma.
(function travarDuploEnvio() {
  let emVoo = 0;
  const travados = new Set();
  const fetchOriginal = window.fetch;

  function liberar() {
    travados.forEach((btn) => { btn.disabled = false; });
    travados.clear();
  }

  window.fetch = function (...args) {
    emVoo += 1;
    return fetchOriginal.apply(this, args).finally(() => {
      emVoo = Math.max(0, emVoo - 1);
      if (emVoo === 0) liberar();
    });
  };

  document.addEventListener('submit', (e) => {
    const btn = e.target.querySelector('button[type="submit"], button:not([type])');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    travados.add(btn);
    setTimeout(liberar, 15000);
  }, true);
})();

// Barras de gráfico: a altura/largura é proporcional ao dado, então não cabe
// numa classe. Antes ia como style="width:${...}%" dentro do innerHTML — e é
// exatamente isso que obriga a CSP a liberar style-src 'unsafe-inline', porque
// atributo style vindo de markup é bloqueado, enquanto atribuir via CSSOM não
// é. O template escreve data-pct; quem aplica é este observador, que pega
// também o que for renderizado depois (todo painel monta a tela por innerHTML).
window.aplicarBarras = function aplicarBarras(raiz) {
  const alvos = (raiz || document).querySelectorAll('[data-pct]:not([data-pct-ok])');
  alvos.forEach((el) => {
    const pct = Math.max(0, Math.min(100, Number(el.dataset.pct) || 0));
    // .bar cresce de baixo pra cima (altura); .fill cresce pro lado (largura).
    el.style[el.classList.contains('bar') ? 'height' : 'width'] = pct + '%';
    el.setAttribute('data-pct-ok', '');
  });
};

new MutationObserver(() => window.aplicarBarras(document)).observe(
  document.documentElement, { childList: true, subtree: true },
);
document.addEventListener('DOMContentLoaded', () => window.aplicarBarras(document));
