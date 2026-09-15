// Cabeçalho, rodapé e botão de WhatsApp de todo o site, num lugar só.
//
// Antes esse bloco estava copiado em 17 arquivos HTML: acrescentar um item no
// menu era 17 edições, e já tinha divergido — a página de termos estava sem o
// link de Contato e duas páginas tinham rodapé com 2 links em vez de 4.
//
// A página declara o que quer em <body data-layout="...">:
//   publico   — menu do site (troca pelo menu da conta se já estiver logado)
//   conta     — menu da conta; as abas seguem os papéis (anunciante/ponto/vendedor)
//   minimo    — só o logo e, opcionalmente, data-layout-botao="Texto|/destino"
//   nenhum    — não desenha nada (player, admin)
// Requer /config.js antes.
// Todo link de WhatsApp escrito no HTML carrega `data-wa` com a mensagem. O
// href literal fica no markup pra funcionar sem JS; aqui ele é reescrito a
// partir da constante única de `config.js`, pra que trocar de número seja uma
// edição só. Antes o número estava à mão em 6 arquivos.
(function ajustarWhatsApp() {
  if (!window.linkWhatsApp) return;
  document.querySelectorAll('a[data-wa]').forEach((a) => {
    a.href = window.linkWhatsApp(a.dataset.wa);
  });
})();

(function () {
  const layout = document.body.dataset.layout;
  if (!layout || layout === 'nenhum') return;

  const AQUI = window.location.pathname.replace(/\/index\.html$/, '/');
  const ehAqui = (href) => AQUI === href || (href !== '/' && AQUI.startsWith(href.replace('.html', '')));

  const MENU_PUBLICO = [
    ['/', 'Home'],
    ['/planos.html', 'Planos'],
    ['/pontos.html', 'Onde estamos?'],
    ['/anunciante/cadastro.html', 'Anuncie'],
    ['/seja-um-ponto.html', 'Seja um ponto'],
    ['/seja-um-vendedor.html', 'Seja um vendedor'],
    ['/contato.html', 'Contato'],
  ];

  const link = ([href, texto]) =>
    `<a href="${href}"${ehAqui(href) ? ' aria-current="page"' : ''}>${texto}</a>`;

  function navPublico() {
    return MENU_PUBLICO.map(link).join('')
      + '<a class="btn ghost" href="/anunciante/login.html" data-nav-entrar>Entrar</a>';
  }

  function navMinimo() {
    const botao = document.body.dataset.layoutBotao;
    if (!botao) return '';
    const [texto, href] = botao.split('|');
    return `<a class="btn ghost" href="${href}">${texto}</a>`;
  }

  // Menu da conta — painel único com três modos (v2.1). Os três aparecem
  // sempre; o que a conta não tem papel fica marcado como bloqueado e, ao
  // abrir, mostra o card de ativação (modos.js) em vez do dashboard.
  function navConta() {
    const aba = (href, id, texto) => `<a href="${href}" id="${id}" class="modo-aba"${ehAqui(href) ? ' aria-current="page"' : ''}>${texto}</a>`;
    return `
      ${aba('/anunciante/painel.html', 'navDashboard', 'Anúncios')}
      ${aba('/anunciante/ponto.html', 'navMeuPonto', 'Meu ponto')}
      ${aba('/anunciante/vendedor.html', 'navVendas', 'Vendas')}
      <a href="/planos.html" id="navPlanos"${ehAqui('/planos.html') ? ' aria-current="page"' : ''}>Planos</a>
      <button type="button" class="avatar-btn" id="btnPerfil" aria-label="Meu perfil">
        <img id="avatarFoto" src="" alt="" hidden><span id="avatarInicial"></span>
      </button>`;
  }

  window.aplicarPapeisNoMenu = function aplicarPapeisNoMenu(conta) {
    const papeis = (conta?.papeis) || ['anunciante'];
    const marcar = (id, liberado) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('bloqueado', !liberado);
      el.title = liberado ? '' : 'Modo ainda não ativado — clique pra ativar';
    };
    marcar('navDashboard', papeis.includes('anunciante'));
    marcar('navMeuPonto', papeis.includes('ponto'));
    marcar('navVendas', papeis.includes('vendedor'));
  };

  const NAVS = { publico: navPublico, conta: navConta, minimo: navMinimo };

  // Menu de celular: hambúrguer, como o mercado inteiro faz.
  //
  // Antes os 7 itens do menu público ficavam soltos, quebrados em duas linhas,
  // cada um com 20px de altura de toque — o mínimo usável é 44px. O topo
  // inteiro do celular era menu, e nenhum item dava pra acertar com o dedo.
  document.body.insertAdjacentHTML('afterbegin', `
    <header class="site">
      <div class="wrap">
        <a class="logo" href="/"><img src="/img/logo-mostrai-wordmark.png" alt="Mostraí"></a>
        <button type="button" class="menu-botao" id="btnMenu" aria-expanded="false" aria-controls="navPrincipal" aria-label="Abrir menu">
          <span></span><span></span><span></span>
        </button>
        <nav class="main" id="navPrincipal">${(NAVS[layout] || navMinimo)()}</nav>
      </div>
    </header>`);

  (function menuDeCelular() {
    const botao = document.getElementById('btnMenu');
    const nav = document.getElementById('navPrincipal');
    if (!botao || !nav) return;
    const fechar = () => {
      nav.classList.remove('aberto');
      botao.setAttribute('aria-expanded', 'false');
      botao.setAttribute('aria-label', 'Abrir menu');
    };
    botao.addEventListener('click', () => {
      const abrindo = !nav.classList.contains('aberto');
      nav.classList.toggle('aberto', abrindo);
      botao.setAttribute('aria-expanded', String(abrindo));
      botao.setAttribute('aria-label', abrindo ? 'Fechar menu' : 'Abrir menu');
    });
    // Escolher um item fecha o menu; Esc também. Sem isso o menu fica aberto
    // por cima da página que a pessoa acabou de pedir.
    nav.addEventListener('click', (e) => { if (e.target.closest('a')) fechar(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') fechar(); });
  })();

  document.body.insertAdjacentHTML('beforeend', `
    <footer class="site">
      <div class="wrap">
        <span>© Mostraí — Matão-SP. Parte do ecossistema San &amp; Co.</span>
        <span class="footer-links"><a href="/contato.html">Fale com a gente</a> · <a href="/termos-de-uso.html">Termos de Uso</a> · <a href="/politica-de-privacidade.html">Privacidade</a> · <a href="/comodato.html">Comodato</a> · <a href="/contrato-anunciante.html">Contrato do anunciante</a></span>
        <span><a href="mailto:mostrai@sancocore.com.br">mostrai@sancocore.com.br</a></span>
      </div>
    </footer>
    <a class="whatsapp-fab" href="${window.linkWhatsApp('Olá! Vim pelo site da Mostraí e quero saber mais.')}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.48 1.32 5.03L2 22l5.25-1.38a9.88 9.88 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.8 14.13c-.24.68-1.4 1.32-1.93 1.4-.5.08-1.12.11-1.8-.11-.42-.13-.96-.31-1.65-.6-2.9-1.25-4.79-4.17-4.94-4.36-.14-.2-1.18-1.57-1.18-3 0-1.42.75-2.12 1.02-2.41.27-.29.58-.36.78-.36.2 0 .39 0 .56.01.18.01.42-.07.65.5.24.58.82 2 .89 2.15.07.14.11.31.02.5-.09.19-.14.31-.27.47-.14.16-.29.36-.41.48-.14.14-.28.28-.12.56.16.28.71 1.17 1.53 1.89 1.05.94 1.94 1.23 2.22 1.37.28.14.44.12.6-.07.16-.19.68-.79.87-1.06.19-.28.37-.23.62-.14.26.09 1.65.78 1.93.92.28.14.47.21.53.33.07.11.07.65-.17 1.33z"/></svg>
    </a>`);

  // Conta logada: uma requisição só, compartilhada por quem precisar (o
  // painel usa a mesma promessa em vez de pedir /anunciantes/me de novo).
  window.carregarConta = function carregarConta() {
    if (!window.__conta) {
      window.__conta = fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    }
    return window.__conta;
  };

  // No site público, quem já está logado vê o menu da conta em vez de "Entrar"
  // e do menu de marketing inteiro — as informações dele já estão nas abas da
  // própria conta. (Isso substituiu o antigo nav-auth.js.)
  if (layout === 'publico') {
    window.carregarConta().then((conta) => {
      if (!conta) return;
      const papeis = conta.papeis || ['anunciante'];
      const inicial = (conta.nome_empresa || '?').trim().charAt(0).toUpperCase();
      const casa = papeis.includes('anunciante') ? '/anunciante/painel.html'
        : papeis.includes('ponto') ? '/anunciante/ponto.html' : '/anunciante/vendedor.html';
      // `title` junto do `bloqueado`: no menu das páginas da conta o cadeado tem
      // explicação ("clique pra ativar") e aqui não tinha nenhuma — a mesma aba
      // cinza dizia coisas diferentes conforme a página em que a pessoa estava.
      const aba = (href, papel, texto) => {
        const liberado = papeis.includes(papel);
        return `<a href="${href}" id="nav${papel}" class="modo-aba ${liberado ? '' : 'bloqueado'}"${liberado ? '' : ' title="Modo ainda não ativado — clique pra ativar"'}>${texto}</a>`;
      };
      document.querySelector('header.site nav.main').innerHTML = `
        ${aba('/anunciante/painel.html', 'anunciante', 'Anúncios')}
        ${aba('/anunciante/ponto.html', 'ponto', 'Meu ponto')}
        ${aba('/anunciante/vendedor.html', 'vendedor', 'Vendas')}
        <a href="/planos.html"${ehAqui('/planos.html') ? ' aria-current="page"' : ''}>Planos</a>
        <a class="avatar-btn" href="${casa}" aria-label="Meu perfil">
          ${conta.foto_url ? `<img src="${esc(conta.foto_url)}" alt="">` : `<span>${esc(inicial)}</span>`}
        </a>`;
      document.body.dataset.logado = '1';
    });
  }

  // Páginas da conta: esconde/mostra abas pelos papéis assim que a conta
  // carregar (o painel chama montarPerfil, que já usa a mesma promessa).
  if (document.body.dataset.layout === 'conta') {
    window.carregarConta().then((conta) => { if (conta) window.aplicarPapeisNoMenu(conta); });
  }
})();

// Rótulos de status. Estavam repetidos em 5 arquivos, já com textos diferentes
// pro mesmo status entre uma tela e outra.
window.ROTULOS = {
  anunciante: {
    pendente_aprovacao: 'Pendente de aprovação',
    aprovado: 'Aprovado — escolha um plano',
    ativo: 'Ativo',
    suspenso: 'Suspenso',
  },
  ponto: {
    lead: 'Em análise',
    aguardando_instalacao: 'Aprovado — aguardando instalação',
    ativo: 'Ativo',
    reparo: 'Em reparo',
    inativo: 'Inativo',
  },
  pontoClasse: {
    lead: 'badge-pendente', aguardando_instalacao: 'badge-pendente',
    ativo: 'badge-ok', reparo: 'badge-pendente', inativo: 'badge-err',
  },
  criativo: { pendente: 'Em análise', aprovado: 'Aprovado', reprovado: 'Reprovado' },
  criativoClasse: { pendente: 'badge-pendente', aprovado: 'badge-ok', reprovado: 'badge-err' },
  // So dois estados: o CHECK da migration 019 e ('aprovado','inativo'). O
  // 'pendente_aprovacao' que estava aqui vinha do modelo antigo de afiliado e
  // nao existe no banco — rotulo pra um estado impossivel.
  vendedor: { aprovado: 'Aprovado', inativo: 'Inativo' },
};
