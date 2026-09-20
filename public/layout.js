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
//               (à direita) e/ou data-layout-botao-esq="Texto|/destino"
//               (à esquerda do logo, ex.: um "Voltar" de checkout)
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

  // Seja um ponto/Seja um vendedor saíram do menu em 18/09/2026: os dois
  // deixaram de ter porta de entrada própria (candidatura sem conta foi
  // aposentada — ver src/candidaturas/routes.js). Ponto se pede de dentro do
  // painel depois de criar conta; vendedor só por contato direto. Sobra
  // "Anuncie", que agora é a própria ação de criar conta.
  const MENU_PUBLICO = [
    ['/', 'Home'],
    ['/planos.html', 'Planos'],
    ['/pontos.html', 'Onde estamos?'],
    ['/contato.html', 'Contato'],
  ];

  const link = ([href, texto]) => `<a href="${href}"${ehAqui(href) ? ' aria-current="page"' : ''}>${texto}</a>`;

  function navPublico() {
    return (
      MENU_PUBLICO.map(link).join('') +
      `<a class="btn ghost" href="/anunciante/cadastro.html">Criar conta</a>` +
      '<a class="btn ghost" href="/anunciante/login.html" data-nav-entrar>Entrar</a>'
    );
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
  // "Meu ponto" e "Vendas" saíram do topo (19/09/2026, pedido do dono): ponto
  // vira card de candidatura no fim do próprio Painel (ver painel.page.js) e
  // vendedor deixou de ser algo que se busca no público — quem tem o papel
  // continua tendo, só não tem mais aba própria aqui em cima. As duas páginas
  // (`ponto.html`, `vendedor.html`) continuam existindo pra quem já tem o
  // papel, só não tem mais link direto no menu.
  function navConta() {
    const aba = (href, id, texto) =>
      `<a href="${href}" id="${id}" class="modo-aba"${ehAqui(href) ? ' aria-current="page"' : ''}>${texto}</a>`;
    return `
      ${aba('/anunciante/painel.html', 'navDashboard', 'Painel')}
      <a href="/planos.html" id="navPlanos"${ehAqui('/planos.html') ? ' aria-current="page"' : ''}>Planos</a>
      <button type="button" class="avatar-btn" id="btnPerfil" aria-label="Meu perfil">
        <img id="avatarFoto" alt="" hidden><span id="avatarInicial"></span>
      </button>`;
  }

  window.aplicarPapeisNoMenu = function aplicarPapeisNoMenu(conta) {
    const papeis = conta?.papeis || ['anunciante'];
    const marcar = (id, liberado) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('bloqueado', !liberado);
      el.title = liberado ? '' : 'Modo ainda não ativado, clique pra ativar';
    };
    marcar('navDashboard', papeis.includes('anunciante'));
  };

  const NAVS = { publico: navPublico, conta: navConta, minimo: navMinimo };

  // Menu de celular: hambúrguer, como o mercado inteiro faz.
  //
  // Antes os 7 itens do menu público ficavam soltos, quebrados em duas linhas,
  // cada um com 20px de altura de toque — o mínimo usável é 44px. O topo
  // inteiro do celular era menu, e nenhum item dava pra acertar com o dedo.
  // Botão à esquerda do logo (ex.: "Voltar" no checkout, pra não duplicar
  // uma ação que a própria tela já oferece mais abaixo) — mesmo formato
  // "Texto|destino" de data-layout-botao, só que do outro lado.
  const botaoEsqDado = document.body.dataset.layoutBotaoEsq;
  const botaoEsq = botaoEsqDado
    ? (([texto, href]) => `<a class="btn ghost btn-voltar" href="${href}">${texto}</a>`)(botaoEsqDado.split('|'))
    : '';

  document.body.insertAdjacentHTML(
    'afterbegin',
    `
    <header class="site">
      <div class="wrap">
        <div class="header-left">
          ${botaoEsq}
          <a class="logo" href="/"><img src="/img/logo-mostrai-wordmark.png" alt="Mostraí"></a>
        </div>
        <button type="button" class="menu-botao" id="btnMenu" aria-expanded="false" aria-controls="navPrincipal" aria-label="Abrir menu">
          <span></span><span></span><span></span>
        </button>
        <nav class="main" id="navPrincipal">${(NAVS[layout] || navMinimo)()}</nav>
      </div>
    </header>`,
  );

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
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) fechar();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') fechar();
    });
  })();

  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <footer class="site">
      <div class="wrap">
        <span>© Mostraí, Matão-SP. Parte do ecossistema San &amp; Co.</span>
        <span class="footer-links"><a href="/contato.html">Fale com a gente</a> · <a href="/termos-de-uso.html">Termos de Uso</a> · <a href="/politica-de-privacidade.html">Privacidade</a> · <a href="/comodato.html">Comodato</a> · <a href="/contrato-anunciante.html">Contrato do anunciante</a></span>
        <span><a href="mailto:mostrai@sancocore.com.br">mostrai@sancocore.com.br</a></span>
      </div>
    </footer>
    <a class="whatsapp-fab" href="${window.linkWhatsApp('Olá! Vim pelo site da Mostraí e quero saber mais.')}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.48 1.32 5.03L2 22l5.25-1.38a9.88 9.88 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.8 14.13c-.24.68-1.4 1.32-1.93 1.4-.5.08-1.12.11-1.8-.11-.42-.13-.96-.31-1.65-.6-2.9-1.25-4.79-4.17-4.94-4.36-.14-.2-1.18-1.57-1.18-3 0-1.42.75-2.12 1.02-2.41.27-.29.58-.36.78-.36.2 0 .39 0 .56.01.18.01.42-.07.65.5.24.58.82 2 .89 2.15.07.14.11.31.02.5-.09.19-.14.31-.27.47-.14.16-.29.36-.41.48-.14.14-.28.28-.12.56.16.28.71 1.17 1.53 1.89 1.05.94 1.94 1.23 2.22 1.37.28.14.44.12.6-.07.16-.19.68-.79.87-1.06.19-.28.37-.23.62-.14.26.09 1.65.78 1.93.92.28.14.47.21.53.33.07.11.07.65-.17 1.33z"/></svg>
    </a>`,
  );

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
      const casa = papeis.includes('anunciante')
        ? '/anunciante/painel.html'
        : papeis.includes('ponto')
          ? '/anunciante/ponto.html'
          : '/anunciante/vendedor.html';
      // Pedido do dono, 19/09/2026: quem já está logado e cai na home vai
      // direto pro dashboard — a home é porta de entrada pra quem ainda não
      // tem conta, não faz sentido mostrar ela de novo pra quem já entrou.
      // Só a home (`/`); as outras páginas públicas (Planos, Onde estamos,
      // Contato) continuam abrindo normalmente pra quem já está logado.
      if (AQUI === '/') {
        window.location.replace(casa);
        return;
      }
      // `title` junto do `bloqueado`: no menu das páginas da conta o cadeado tem
      // explicação ("clique pra ativar") e aqui não tinha nenhuma — a mesma aba
      // cinza dizia coisas diferentes conforme a página em que a pessoa estava.
      const aba = (href, papel, texto) => {
        const liberado = papeis.includes(papel);
        return `<a href="${href}" id="nav${papel}" class="modo-aba ${liberado ? '' : 'bloqueado'}"${liberado ? '' : ' title="Modo ainda não ativado, clique pra ativar"'}>${texto}</a>`;
      };
      document.querySelector('header.site nav.main').innerHTML = `
        ${aba('/anunciante/painel.html', 'anunciante', 'Painel')}
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
    window.carregarConta().then((conta) => {
      if (conta) window.aplicarPapeisNoMenu(conta);
      // E-mail não confirmado (migration 061): pop-up obrigatório em toda
      // página de conta — a pessoa pode entrar direto por ponto.html ou
      // vendedor.html sem nunca passar pelo painel de anúncios. Pedido do
      // dono, 19/09/2026: virou trava de verdade, não só aviso — antes era
      // uma barra que dava pra ignorar e continuar navegando.
      if (conta && !conta.email_confirmado) mostrarModalEmailNaoConfirmado(conta);
    });
  }

  function mostrarModalEmailNaoConfirmado(conta) {
    // Mesma validade do código no servidor (VALIDADE_CODIGO_EMAIL_MS, em
    // src/anunciantes/routes.js) — só pra contar aqui, o servidor é quem
    // decide de verdade se o código ainda vale.
    const VALIDADE_CODIGO_S = 120;
    const COOLDOWN_REENVIO_S = 30;

    document.body.style.overflow = 'hidden';
    const el = document.createElement('div');
    el.className = 'modal-email';
    el.innerHTML = `
      <div class="caixa">
        <h2>Confirme seu e-mail</h2>
        <p>Mandamos um código pra <b>${window.esc(conta.contato_email || '')}</b>. Digite ele aqui pra continuar.</p>
        <p class="expira" id="expiraEmail"></p>
        <form id="formConfirmarEmail">
          <input id="codigoConfirmarEmail" inputmode="numeric" maxlength="6" placeholder="000000" autocomplete="one-time-code" required autofocus>
          <button type="submit" class="btn primary">Confirmar</button>
        </form>
        <button type="button" class="reenviar" id="btnReenviarCodigoEmail">Reenviar código</button>
        <p class="msg" id="msgConfirmarEmail"></p>
      </div>`;
    document.body.appendChild(el);

    const msg = el.querySelector('#msgConfirmarEmail');
    const expiraEl = el.querySelector('#expiraEmail');
    const btnReenviar = el.querySelector('#btnReenviarCodigoEmail');

    // Cronômetro do código atual (topo da caixa, acima do campo). Reinicia a
    // cada código novo — o de agora, ou qualquer reenvio.
    let timerExpira = null;
    function contarExpiracao() {
      clearInterval(timerExpira);
      let restante = VALIDADE_CODIGO_S;
      const atualizar = () => {
        const m = Math.floor(restante / 60);
        const s = String(restante % 60).padStart(2, '0');
        expiraEl.textContent = restante > 0 ? `Expira em ${m}:${s}` : 'Código expirado — peça um novo';
        expiraEl.classList.toggle('expirado', restante <= 0);
      };
      atualizar();
      timerExpira = setInterval(() => {
        restante--;
        atualizar();
        if (restante <= 0) clearInterval(timerExpira);
      }, 1000);
    }
    contarExpiracao();

    // Trava de reenvio: a primeira vez é livre (nada bloqueando ainda); a
    // cada reenvio depois dessa, o botão fica 30s desabilitado antes do
    // próximo — impede clicar em Reenviar 10x seguidas e lotar a caixa da
    // pessoa de código.
    function iniciarCooldownReenvio() {
      let restante = COOLDOWN_REENVIO_S;
      btnReenviar.disabled = true;
      const atualizar = () => {
        btnReenviar.textContent = `Reenviar código (${restante}s)`;
      };
      atualizar();
      const iv = setInterval(() => {
        restante--;
        if (restante <= 0) {
          clearInterval(iv);
          btnReenviar.disabled = false;
          btnReenviar.textContent = 'Reenviar código';
          return;
        }
        atualizar();
      }, 1000);
    }

    el.querySelector('#formConfirmarEmail').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      msg.textContent = '';
      msg.className = 'msg';
      const codigo = el.querySelector('#codigoConfirmarEmail').value.trim();
      try {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/confirmar-email`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codigo }),
        });
        const d = await r.json();
        if (!r.ok) {
          msg.textContent = d.erro || 'não deu pra confirmar';
          msg.className = 'msg err';
          return;
        }
        clearInterval(timerExpira);
        document.body.style.overflow = '';
        el.remove();
      } catch {
        msg.textContent = 'sem conexão com o servidor';
        msg.className = 'msg err';
      }
    });
    btnReenviar.addEventListener('click', async () => {
      msg.className = 'msg';
      msg.textContent = 'enviando...';
      try {
        await fetch(`${API_BASE_URL}/anunciantes/me/reenviar-codigo-email`, { method: 'POST', credentials: 'include' });
        msg.className = 'msg ok';
        msg.textContent = 'código reenviado, confere seu e-mail';
        contarExpiracao();
        iniciarCooldownReenvio();
      } catch {
        msg.className = 'msg err';
        msg.textContent = 'sem conexão com o servidor';
      }
    });
  }
})();

// Rótulos de status. Estavam repetidos em 5 arquivos, já com textos diferentes
// pro mesmo status entre uma tela e outra.
window.ROTULOS = {
  // `status` deixou de ser estado operacional (16/09/2026) — só distingue
  // comum de parceiro (substitui o antigo "fundador"). O que bloqueia
  // login/veiculação é `suspenso`, mostrado à parte por quem usa isso.
  anunciante: { comum: 'Comum', parceiro: 'Parceiro' },
  // Dois estados desde 17/09/2026 (migration 045): o ponto existe na rede ou
  // ainda não. Se a TELA dele quebrou, quem diz é `dispositivos.status`.
  ponto: {
    a_instalar: 'Aguardando instalação',
    em_operacao: 'Em operação',
  },
  pontoClasse: {
    a_instalar: 'badge-pendente',
    em_operacao: 'badge-ok',
  },
  criativo: { pendente: 'Em análise', aprovado: 'Aprovado', reprovado: 'Reprovado' },
  criativoClasse: { pendente: 'badge-pendente', aprovado: 'badge-ok', reprovado: 'badge-err' },
  // So dois estados: o CHECK da migration 019 e ('aprovado','inativo'). O
  // 'pendente_aprovacao' que estava aqui vinha do modelo antigo de afiliado e
  // nao existe no banco — rotulo pra um estado impossivel.
  vendedor: { aprovado: 'Aprovado', inativo: 'Inativo' },
};
