// Barra promocional da área logada (reforço visual das promoções,
// 28/09/2026). Área pública VENDE (o bloco grande de public/promocao.js);
// área logada OPERA: aqui a promoção vira uma faixa fina logo abaixo do
// cabeçalho, com um X que a dispensa. Substitui o card largo que ficava no
// topo do painel.
//
// Monta sozinha em qualquer página com `data-layout="conta"` que carregar
// este arquivo — hoje, o painel (o perfil é um modal dele). Mesma fonte de
// sempre: GET /promocoes/vigentes, já filtrada no servidor pela elegibilidade
// comercial da conta. Mostra a primeira promoção não dispensada que, depois da
// disputa de células (`promocoesParaExibir`), ainda baixa o preço de verdade
// (D1). Oferta, "Até" e título saem das mesmas funções do bloco público
// (public/promocao.js, carregado antes deste arquivo).
//
// Dispensa: `localStorage`, por id da promoção (`mostrai:promoDispensada:7`).
// Fechou, não volta — nem ao navegar, nem numa sessão nova; uma promoção
// NOVA (outro id) aparece. Sem backend: é preferência deste navegador. Se o
// armazenamento estiver bloqueado, a barra fecha só nesta página.
(() => {
  if (document.body?.dataset.layout !== 'conta') return;
  const chave = (id) => `mostrai:promoDispensada:${id}`;
  const dispensada = (id) => {
    try {
      return localStorage.getItem(chave(id)) === '1';
    } catch {
      return false;
    }
  };
  const dispensar = (id) => {
    try {
      localStorage.setItem(chave(id), '1');
    } catch {}
  };
  function montar(promo) {
    const header = document.querySelector('header.site');
    if (!header || document.getElementById('barraPromo')) return;
    const util = window.promocaoUtil;
    const oferta = util.ofertaDaPromocao(promo);
    const barra = document.createElement('div');
    barra.id = 'barraPromo';
    barra.className = 'barra-promo';
    barra.setAttribute('role', 'region');
    barra.setAttribute('aria-label', 'Promoção');
    barra.innerHTML = `<div class="wrap barra-promo-wrap">
      <p class="barra-promo-texto">
        ${promo.selo ? `<span class="barra-promo-selo">${window.esc(promo.selo)}</span>` : ''}
        <b class="barra-promo-oferta">${oferta ? util.htmlOfertaCurta(oferta) : window.esc(util.tituloSemSelo(promo.titulo_publico, promo.selo))}</b>
        ${promo.subtitulo ? `<span class="barra-promo-sub">${window.esc(promo.subtitulo)}</span>` : ''}
      </p>
      <a class="barra-promo-cta" href="/planos.html">Ver planos</a>
      <button type="button" class="barra-promo-fechar" aria-label="Fechar aviso da promoção"><span aria-hidden="true">×</span></button>
    </div>`;
    header.insertAdjacentElement('afterend', barra);
    barra.querySelector('.barra-promo-fechar').addEventListener('click', () => {
      dispensar(promo.id);
      barra.remove();
      // O foco estava no X, que sumiu: volta pro começo do conteúdo em vez
      // de cair no <body>.
      const principal = document.querySelector('main');
      if (principal) {
        if (!principal.hasAttribute('tabindex')) principal.setAttribute('tabindex', '-1');
        principal.focus({ preventScroll: true });
      }
    });
  }

  fetch(`${API_BASE_URL}/promocoes/vigentes`)
    .then((r) => (r.ok ? r.json() : []))
    .then((vigentes) => {
      // A MESMA disputa de células do bloco público (promocao.js): cada
      // produto × ciclo é anunciado só pela promoção que dá o preço — as
      // dispensadas entram na disputa (continuam sendo cobradas), só não são
      // mostradas. Sem isto, dispensar a mais nova fazia a barra anunciar o
      // desconto de uma mais antiga numa célula que a cobrança dá à outra
      // (revisão independente, 28/09/2026).
      const promo = window.promocoesParaExibir(vigentes).find((p) => p && !dispensada(p.id));
      if (promo) montar(promo);
    })
    // Sem a barra o painel continua igual: ela nunca bloqueia nada.
    .catch(() => {});
})();
