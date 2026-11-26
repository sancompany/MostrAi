// Marketplace de Lojas — peças comuns das páginas da vitrine (/marketplace,
// /loja/<slug>) e do painel da loja (/anunciante/minha-loja). Sem bundler:
// tudo pendurado em `window.VITRINE`, como o resto do site faz com config.js.
// Texto vindo do banco passa SEMPRE por esc() antes de virar HTML.
(() => {
  const esc = (v) => window.esc(v ?? '');

  const TIPOS = {
    tela_indoor: 'Tela indoor',
    painel_led: 'Painel de LED',
    totem: 'Totem',
    outdoor: 'Outdoor',
    empena: 'Empena',
    outro: 'Outro',
  };
  const PERIODO = { dia: 'dia', semana: 'semana', mes: 'mês' };

  const precoTexto = (e) =>
    e.preco === null || e.preco === undefined || e.preco === ''
      ? 'Sob consulta'
      : `${Number(e.preco).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} por ${PERIODO[e.periodo_preco] || e.periodo_preco}`;

  const onde = (e) =>
    [e.endereco, e.bairro, e.cidade && e.uf ? `${e.cidade}/${e.uf}` : e.cidade].filter(Boolean).join(', ');

  // Mapa: link para o Google Maps (a CSP do site não carrega mapa de fora em
  // página nenhuma além do embed de Matão). Coordenada, quando há, é mais
  // precisa que o endereço.
  function linkDoMapa(e) {
    const alvo =
      e.latitude !== null && e.latitude !== undefined && e.longitude !== null && e.longitude !== undefined
        ? `${e.latitude},${e.longitude}`
        : onde(e);
    if (!alvo) return '';
    return `<a class="mapa-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(alvo)}" target="_blank" rel="noopener">📍 Ver no mapa</a>`;
  }

  // Mesmo placeholder dos cards de ponto (public/pontos.page.js).
  function foto(url, nome) {
    if (url) return `<img src="${esc(url)}" alt="${esc(nome || '')}" loading="lazy">`;
    return `<div class="ponto-foto-placeholder" role="img" aria-label="${esc(nome ? `${nome}, sem foto` : 'Espaço sem foto')}">
      <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
        <rect x="3" y="4" width="18" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6"/>
        <path d="M12 16v4M8 20h8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
      </svg>
    </div>`;
  }

  // Card de espaço da vitrine. `loja`: mostra de qual loja é (página geral).
  // `acao`: HTML extra no pé do card (botão de interesse na página da loja).
  function cartao(e, { loja = false, acao = '' } = {}) {
    const fluxo = e.fluxo_estimado_mensal
      ? `<span>${Number(e.fluxo_estimado_mensal).toLocaleString('pt-BR')} pessoas/mês (estimativa)</span>`
      : '';
    return `<article class="ponto-card espaco-card">
      <div class="ponto-card-media">${foto(e.foto_url, e.nome)}</div>
      <span class="badge badge-info">${esc(TIPOS[e.tipo] || e.tipo)}</span>
      <h4>${esc(e.nome)}</h4>
      <p>${esc(onde(e))}</p>
      ${e.descricao ? `<p class="espaco-descricao u-dim">${esc(e.descricao)}</p>` : ''}
      <p class="espaco-detalhes">${e.medidas ? `<span>${esc(e.medidas)}</span>` : ''}${fluxo}</p>
      <p class="espaco-preco"><b>${esc(precoTexto(e))}</b></p>
      ${loja && e.loja_slug ? `<p class="espaco-loja">por <a href="/loja/${encodeURIComponent(e.loja_slug)}">${esc(e.loja_nome)}</a></p>` : ''}
      <div class="espaco-acoes">${linkDoMapa(e)}${acao}</div>
    </article>`;
  }

  // Cor da marca da loja: via CSSOM (a CSP proíbe style= inline). Só #RRGGBB.
  // O texto sobre ela (botão) é branco ou quase preto, o que der mais
  // contraste — a loja pode escolher azul-escuro ou amarelo-claro.
  function aplicarCor(cor, alvo = document.documentElement) {
    if (typeof cor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(cor)) return;
    const canal = (i) => {
      const c = Number.parseInt(cor.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const luz = 0.2126 * canal(1) + 0.7152 * canal(3) + 0.0722 * canal(5);
    const contrasteBranco = 1.05 / (luz + 0.05);
    const contrasteEscuro = (luz + 0.05) / 0.0545; // #1a0f00 ≈ luminância 0,0045
    alvo.style.setProperty('--loja-cor', cor);
    alvo.style.setProperty('--loja-sobre', contrasteBranco >= contrasteEscuro ? '#ffffff' : '#1a0f00');
  }

  // Telefone com DDD como (16) 99999-0000; o que não for 10/11 dígitos fica como veio.
  function telefoneBR(v) {
    const d = String(v || '').replace(/\D/g, '');
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return String(v || '');
  }

  window.VITRINE = { TIPOS, PERIODO, precoTexto, onde, linkDoMapa, foto, cartao, aplicarCor, telefoneBR };
})();
