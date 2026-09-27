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

  // Os dois botões de conta ficam num grupo: no desktop o grupo some
  // (`display: contents`) e eles seguem lado a lado na barra como sempre; no
  // menu de celular o grupo vira uma linha de duas colunas — "Criar conta" e
  // "Entrar" empilhados eram 116px de menu, e com o celular deitado os dois
  // ficavam fora da tela ou atrás do botão do WhatsApp.
  function navPublico() {
    return (
      MENU_PUBLICO.map(link).join('') +
      '<div class="nav-acoes">' +
      `<a class="btn ghost" href="/anunciante/cadastro.html">Criar conta</a>` +
      '<a class="btn ghost" href="/anunciante/login.html">Entrar</a>' +
      '</div>'
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
  // "Meu ponto" e "Vendas" saíram do topo (19/09/2026, pedido do dono), e as
  // duas páginas saíram do ar: vendedor com o programa (23/09/2026), ponto
  // com o painel único (Fatia 6) — hoje as duas redirecionam pro Painel.
  // Sino de atualizações (Fase 4, 23/09/2026) — histórico de eventos da
  // conta (criativo aprovado, candidatura decidida, pagamento, créditos,
  // benefício, suspensão). Marcação fica aqui porque é parte do cabeçalho
  // compartilhado; o comportamento mora em public/notificacoes.js (mesma
  // divisão que avatar-btn/dlgPerfil têm entre layout.js e perfil.js).
  function navConta() {
    const aba = (href, id, texto) =>
      `<a href="${href}" id="${id}" class="modo-aba"${ehAqui(href) ? ' aria-current="page"' : ''}>${texto}</a>`;
    return `
      ${aba('/anunciante/painel.html', 'navDashboard', 'Painel')}
      <a href="/planos.html" id="navPlanos"${ehAqui('/planos.html') ? ' aria-current="page"' : ''}>Planos</a>
      <div class="sino-wrap">
        <button type="button" class="sino-btn" id="btnSino" aria-label="Atualizações" aria-haspopup="true" aria-expanded="false">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2a6 6 0 0 0-6 6v3.09c0 .53-.21 1.04-.59 1.41L4 14v1h16v-1l-1.41-1.5a2 2 0 0 1-.59-1.41V8a6 6 0 0 0-6-6zm0 20a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 12 22z"/></svg>
          <span class="sino-badge" id="sinoBadge" hidden>0</span>
        </button>
        <div class="central-notif" id="centralNotif" hidden>
          <div class="central-notif-topo">
            <h3>Atualizações</h3>
            <button type="button" class="link-sutil" id="btnMarcarTodasLidas">Marcar todas como lidas</button>
          </div>
          <div class="central-notif-lista" id="centralNotifLista"><p class="texto-vazio">Carregando...</p></div>
        </div>
      </div>
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
    // O Painel serve toda conta desde a Fatia 6 (dono de ponto que não
    // anuncia também mora nele): a aba nunca fica "bloqueada".
    marcar('navDashboard', papeis.length > 0);
  };

  const NAVS = { publico: navPublico, conta: navConta, minimo: navMinimo };

  // Menu de celular: hambúrguer, como o mercado inteiro faz.
  //
  // Antes os 7 itens do menu público ficavam soltos, quebrados em duas linhas,
  // cada um com 20px de altura de toque — o mínimo usável é 44px. O topo
  // inteiro do celular era menu, e nenhum item dava pra acertar com o dedo.
  //
  // Botão à esquerda do logo (ex.: "Voltar" no checkout, pra não duplicar
  // uma ação que a própria tela já oferece mais abaixo) — mesmo formato
  // "Texto|destino" de data-layout-botao, só que do outro lado.
  const botaoEsqDado = document.body.dataset.layoutBotaoEsq;
  const botaoEsq = botaoEsqDado
    ? (([texto, href]) => `<a class="btn ghost btn-voltar" href="${href}">${texto}</a>`)(botaoEsqDado.split('|'))
    : '';

  // Hambúrguer só onde há menu de verdade (site público e conta). No layout
  // mínimo a barra tem no máximo UM botão — "Voltar ao site", "Já tenho
  // conta", "Entrar" — e escondê-lo atrás de um hambúrguer era pior que
  // mostrar; no login e no cadastro, sem botão nenhum, o hambúrguer abria um
  // menu vazio. A exceção é marcada (`nav-simples`), não a regra: colapsar
  // continua sendo o padrão do CSS, então um `layout.js` antigo servido junto
  // com o `style.css` novo (o serviço roda em 2 instâncias, e no deploy cada
  // arquivo pode vir de uma) cai no menu de antes, e não num menu aberto que
  // empurra a página 256px pro lado — visto em produção em 24/09/2026.
  const colapsa = layout === 'publico' || layout === 'conta';

  document.body.insertAdjacentHTML(
    'afterbegin',
    `
    <header class="site">
      <div class="wrap">
        <div class="header-left">
          ${botaoEsq}
          <a class="logo" href="/"><img src="/img/logo-mostrai-wordmark.png" alt="Mostraí" width="124" height="28"></a>
        </div>
        ${
          colapsa
            ? `<button type="button" class="menu-botao" id="btnMenu" aria-expanded="false" aria-controls="navPrincipal" aria-label="Abrir menu">
          <span></span><span></span><span></span>
        </button>`
            : ''
        }
        <nav class="main${colapsa ? '' : ' nav-simples'}" id="navPrincipal" aria-label="Principal">${(NAVS[layout] || navMinimo)()}</nav>
      </div>
    </header>
    ${colapsa ? '<div class="menu-veu" id="menuVeu" hidden></div>' : ''}`,
  );

  (function menuDeCelular() {
    const botao = document.getElementById('btnMenu');
    const nav = document.getElementById('navPrincipal');
    const veu = document.getElementById('menuVeu');
    const header = document.querySelector('header.site');
    if (!botao || !nav || !veu) return;
    const aberto = () => nav.classList.contains('aberto');
    function alternar(abrir) {
      nav.classList.toggle('aberto', abrir);
      veu.hidden = !abrir;
      // A classe no body é o que tira o botão do WhatsApp da frente do menu
      // (ele fica por cima de tudo, e com o celular deitado cobria "Entrar").
      document.body.classList.toggle('menu-aberto', abrir);
      botao.setAttribute('aria-expanded', String(abrir));
      botao.setAttribute('aria-label', abrir ? 'Fechar menu' : 'Abrir menu');
    }
    botao.addEventListener('click', () => alternar(!aberto()));
    // Fecha: ao escolher um item, ao tocar fora (o véu escurecido pega o
    // toque — sem ele, o toque "fora" caía num link da página por baixo), com
    // Esc (devolvendo o foco ao botão) e quando o foco do teclado sai do
    // cabeçalho. A rolagem da página não é travada: o menu é curto e o
    // cabeçalho é fixo, então rolar com ele aberto não perde nada.
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) alternar(false);
    });
    veu.addEventListener('click', () => alternar(false));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && aberto()) {
        alternar(false);
        botao.focus();
      }
    });
    header.addEventListener('focusout', (e) => {
      if (aberto() && e.relatedTarget && !header.contains(e.relatedTarget)) alternar(false);
    });
    // Girar o tablet (ou alargar a janela) com o menu aberto passa pro layout
    // de desktop, onde o véu não tem mais o que cobrir. `addListener` é o
    // nome antigo (Safari < 14): sem o fallback, a exceção pararia este
    // arquivo antes de desenhar o rodapé e o botão do WhatsApp.
    const desktop = window.matchMedia('(min-width: 961px)');
    const aoVirarDesktop = (e) => {
      if (e.matches && aberto()) alternar(false);
    };
    if (desktop.addEventListener) desktop.addEventListener('change', aoVirarDesktop);
    else if (desktop.addListener) desktop.addListener(aoVirarDesktop);
  })();

  document.body.insertAdjacentHTML(
    'beforeend',
    `
    <footer class="site">
      <div class="wrap">
        <p class="footer-marca">© Mostraí, Matão-SP. Parte do ecossistema San &amp; Co.</p>
        <nav class="footer-links" aria-label="Rodapé"><a href="/contato.html">Fale com a gente</a><a href="/termos-de-uso.html">Termos de Uso</a><a href="/politica-de-privacidade.html">Privacidade</a><a href="/comodato.html">Comodato</a><a href="/contrato-anunciante.html">Contrato do anunciante</a></nav>
        <a class="footer-email" href="mailto:mostrai@sancocore.com.br">mostrai@sancocore.com.br</a>
      </div>
    </footer>
    <a class="whatsapp-fab" href="${window.linkWhatsApp('Olá! Vim pelo site da Mostraí e quero saber mais.')}" target="_blank" rel="noopener" aria-label="Falar no WhatsApp">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.48 1.32 5.03L2 22l5.25-1.38a9.88 9.88 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.8 14.13c-.24.68-1.4 1.32-1.93 1.4-.5.08-1.12.11-1.8-.11-.42-.13-.96-.31-1.65-.6-2.9-1.25-4.79-4.17-4.94-4.36-.14-.2-1.18-1.57-1.18-3 0-1.42.75-2.12 1.02-2.41.27-.29.58-.36.78-.36.2 0 .39 0 .56.01.18.01.42-.07.65.5.24.58.82 2 .89 2.15.07.14.11.31.02.5-.09.19-.14.31-.27.47-.14.16-.29.36-.41.48-.14.14-.28.28-.12.56.16.28.71 1.17 1.53 1.89 1.05.94 1.94 1.23 2.22 1.37.28.14.44.12.6-.07.16-.19.68-.79.87-1.06.19-.28.37-.23.62-.14.26.09 1.65.78 1.93.92.28.14.47.21.53.33.07.11.07.65-.17 1.33z"/></svg>
    </a>`,
  );

  // Conta logada: uma requisição só, compartilhada por quem precisar (o
  // painel usa a mesma promessa em vez de pedir /anunciantes/me de novo).
  //
  // Sessão estável (27/09/2026): a promessa REJEITA quando não deu pra ler a
  // conta, e diz por quê — `err.sessaoExpirada` só num 401 (a sessão
  // realmente acabou); qualquer outra coisa (500, 503, rede, prazo de 20 s,
  // resposta que não é JSON) é `err.transitorio` e nunca pede login. Antes
  // tudo virava `null` e ficava guardado pela vida da página: um 500 na
  // abertura contaminava todo mundo que perguntasse depois. Agora só o
  // SUCESSO fica guardado; a falha se apaga e a próxima chamada tenta de
  // novo. `{ recarregar: true }` pede de novo mesmo com uma conta guardada
  // (plano, suspensão ou e-mail podem ter mudado).
  const PRAZO_CONTA_MS = 20000;
  function erroConta(tipo, status) {
    const err = new Error(tipo === 'sessao' ? 'sessão expirada' : 'conta indisponível');
    err.sessaoExpirada = tipo === 'sessao';
    err.transitorio = tipo !== 'sessao';
    err.status = status || 0;
    return err;
  }
  async function lerConta() {
    const controle = new AbortController();
    const prazo = setTimeout(() => controle.abort(), PRAZO_CONTA_MS);
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include', signal: controle.signal });
      if (r.status === 401) throw erroConta('sessao', 401);
      if (!r.ok) throw erroConta('transitorio', r.status);
      const conta = await r.json().catch(() => null);
      if (!conta || typeof conta !== 'object' || !conta.id) throw erroConta('transitorio', r.status);
      return conta;
    } catch (err) {
      if (err.sessaoExpirada || err.transitorio) throw err;
      throw erroConta('transitorio', 0); // rede caiu, prazo estourou, leitura abortada
    } finally {
      clearTimeout(prazo);
    }
  }
  // Numeração das leituras: menu e trava do e-mail só mudam com a leitura
  // MAIS RECENTE. Duas recargas sobrepostas (SSE + ativação de modo, por
  // exemplo) não podem deixar a velha, chegando por último, repor o menu ou o
  // aviso de antes (revisão Codex do PR #82).
  let leituraAtual = 0;
  window.carregarConta = function carregarConta({ recarregar = false } = {}) {
    if (recarregar || !window.__conta) {
      const numero = ++leituraAtual;
      const leitura = lerConta().then((conta) => {
        if (numero === leituraAtual) aplicarContaNoLayout(conta);
        return conta;
      });
      window.__conta = leitura;
      leitura.catch(() => {
        if (window.__conta === leitura) window.__conta = null;
      });
    }
    return window.__conta;
  };

  // Sessão que acabou de verdade (401): um aviso e o login, uma vez só por
  // página. O login não pergunta pela conta, então não tem como voltar pra
  // cá sozinho — sem loop.
  let saindoPorSessao = false;
  window.sessaoExpirada = function sessaoExpirada() {
    if (saindoPorSessao) return;
    saindoPorSessao = true;
    window.location.href = '/anunciante/login.html?expirou=1';
  };

  // Sessão pra páginas PÚBLICAS (decisão D4 do dono, 24/09/2026): só diz se
  // há alguém logado e o mínimo pro cabeçalho (nome, foto, papéis). Antes a
  // vitrine perguntava isso a /anunciantes/me — rota privada —, e todo
  // visitante anônimo via um 401 no console. `GET /conta/sessao` responde 200
  // com `logado: false` pra quem não entrou. A conta completa continua em
  // `carregarConta`, só nas páginas da conta.
  window.carregarSessao = function carregarSessao() {
    if (!window.__sessao) {
      window.__sessao = fetch(`${API_BASE_URL}/conta/sessao`, { credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((s) => (s?.logado ? s.conta : null))
        .catch(() => null);
    }
    return window.__sessao;
  };

  // No site público, quem já está logado vê o menu da conta em vez de "Entrar"
  // e do menu de marketing inteiro — as informações dele já estão nas abas da
  // própria conta. (Isso substituiu o antigo nav-auth.js.)
  if (layout === 'publico') {
    window.carregarSessao().then((conta) => {
      if (!conta) return;
      const papeis = conta.papeis || ['anunciante'];
      const inicial = (conta.nome_empresa || '?').trim().charAt(0).toUpperCase();
      // Conta só-vendedor não tem mais casa própria (programa de vendedores
      // aposentado, 23/09/2026): toda conta pode anunciar, então cai no painel.
      // Painel único (Fatia 6): a casa de toda conta é o Painel — inclusive a
      // do dono de ponto que não anuncia.
      const casa = '/anunciante/painel.html';
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
        // Painel serve toda conta (Fatia 6); o cadeado só vale pra outro modo.
        const liberado = papel === 'anunciante' || papeis.includes(papel);
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
  // Roda a CADA leitura da conta que deu certo (lerConta), não só na primeira:
  // se a abertura falhou e o [Tentar novamente] do painel funcionou, o menu e
  // a trava do e-mail ainda precisam acontecer — antes era um `.then` único,
  // e uma primeira leitura com erro deixava a trava de fora.
  function aplicarContaNoLayout(conta) {
    if (document.body.dataset.layout !== 'conta') return;
    window.aplicarPapeisNoMenu(conta);
    // E-mail não confirmado (migration 061): pop-up obrigatório em toda
    // página de conta — a pessoa pode entrar direto por outra página da
    // conta sem nunca passar pelo painel. Pedido do
    // dono, 19/09/2026: virou trava de verdade, não só aviso — antes era
    // uma barra que dava pra ignorar e continuar navegando.
    if (!conta.email_confirmado && !document.querySelector('.modal-email')) mostrarModalEmailNaoConfirmado(conta);
  }
  if (document.body.dataset.layout === 'conta') {
    // Falha aqui não decide nada: a página (painel) trata o 401 e a falha
    // transitória com a mensagem dela.
    window.carregarConta().catch(() => {});
  }

  // Confirmação do e-mail do cadastro (estação de e-mail, 27/09/2026). O
  // PRAZO vem do servidor (`expiraEm`, GET /anunciantes/me/verificacao-email):
  // recarregar a página mostra o mesmo relógio, não reinicia. Reenviar gera
  // um código novo (o anterior deixa de valer) e o servidor diz quando dá pra
  // pedir de novo. "Corrigir e-mail" resolve quem digitou o endereço errado
  // no cadastro — nunca receberia o código — com a senha da conta como prova.
  function mostrarModalEmailNaoConfirmado(conta) {
    document.body.style.overflow = 'hidden';
    const el = document.createElement('div');
    el.className = 'modal-email';
    el.innerHTML = `
      <div class="caixa" role="dialog" aria-modal="true" aria-labelledby="tituloConfirmarEmail">
        <div data-etapa="codigo">
          <h2 id="tituloConfirmarEmail">Confirme seu e-mail</h2>
          <p id="textoConfirmarEmail">Mandamos um código pra <b id="emailConfirmar">${window.esc(conta.contato_email || '')}</b>. Digite ele aqui pra continuar.</p>
          <p class="expira" id="expiraEmail" aria-live="polite"></p>
          <form id="formConfirmarEmail">
            <input id="codigoConfirmarEmail" name="codigo" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="000000" autocomplete="one-time-code" aria-label="Código de 6 dígitos" required autofocus>
            <button type="submit" class="btn primary">Confirmar</button>
          </form>
          <button type="button" class="reenviar" id="btnReenviarCodigoEmail">Reenviar código</button>
          <button type="button" class="reenviar" id="btnCorrigirEmail">O e-mail está errado? Corrigir e-mail</button>
        </div>
        <div data-etapa="corrigir" hidden>
          <h2>Corrigir e-mail</h2>
          <p>Digite o e-mail certo e a senha que você criou no cadastro. O código vai pro endereço novo.</p>
          <form id="formCorrigirEmail" class="corrigir">
            <label for="novoEmailCadastro">E-mail certo</label>
            <input id="novoEmailCadastro" name="email" type="email" autocomplete="username" maxlength="254" required>
            <label for="senhaCorrigirEmail">Sua senha</label>
            <input id="senhaCorrigirEmail" name="senha" type="password" autocomplete="current-password" required>
            <button type="submit" class="btn primary">Salvar e enviar código</button>
          </form>
          <button type="button" class="reenviar" id="btnVoltarCodigo">Voltar</button>
        </div>
        <p class="msg" id="msgConfirmarEmail" role="status"></p>
      </div>`;
    document.body.appendChild(el);

    const $ = (sel) => el.querySelector(sel);
    const msg = $('#msgConfirmarEmail');
    const expiraEl = $('#expiraEmail');
    const btnReenviar = $('#btnReenviarCodigoEmail');
    const avisar = (texto, tipo = '') => {
      msg.textContent = texto;
      msg.className = `msg ${tipo}`.trim();
    };
    const etapa = (nome) =>
      el.querySelectorAll('[data-etapa]').forEach((d) => {
        d.hidden = d.dataset.etapa !== nome;
      });

    // Relógio do código e trava do botão, os dois a partir do que o servidor
    // disse — o navegador só conta o tempo que falta.
    let expiraEm = null;
    let podeReenviarEm = null;
    let tique = null;
    const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    function pintarRelogio() {
      const agora = Date.now();
      const resta = expiraEm ? Math.max(0, Math.ceil((expiraEm - agora) / 1000)) : 0;
      if (!expiraEm) expiraEl.textContent = 'Nenhum código valendo agora — peça um novo.';
      else expiraEl.textContent = resta > 0 ? `Expira em ${mmss(resta)}` : 'Código expirado — peça um novo';
      expiraEl.classList.toggle('expirado', !expiraEm || resta <= 0);
      const espera = podeReenviarEm ? Math.max(0, Math.ceil((podeReenviarEm - agora) / 1000)) : 0;
      btnReenviar.disabled = espera > 0;
      btnReenviar.textContent =
        espera > 0 ? `Reenviar código (${espera}s)` : expiraEm && resta > 0 ? 'Reenviar código' : 'Enviar código';
    }
    function aplicarPrazos(d) {
      expiraEm = d.expiraEm ? new Date(d.expiraEm).getTime() : null;
      podeReenviarEm = d.podeReenviarEm ? new Date(d.podeReenviarEm).getTime() : null;
      if (d.email) $('#emailConfirmar').textContent = d.email;
      clearInterval(tique);
      pintarRelogio();
      tique = setInterval(pintarRelogio, 1000);
    }

    async function lerEstado() {
      try {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/verificacao-email`, { credentials: 'include' });
        if (!r.ok) return;
        const d = await r.json();
        if (d.confirmado) return fechar();
        aplicarPrazos({ ...(d.cadastro || {}), email: d.email });
        // O que aconteceu com o envio: "abandonado" = o servidor desistiu de
        // entregar (endereço provavelmente errado ou e-mail fora do ar).
        if (d.cadastro?.envio === 'abandonado') {
          avisar('Não conseguimos entregar o código nesse endereço. Confira se o e-mail está certo.', 'err');
        } else if (d.cadastro?.envio === 'tentando_de_novo') {
          avisar('O envio atrasou — estamos tentando de novo. Se não chegar, confira o spam.');
        }
      } catch {
        avisar('sem conexão com o servidor', 'err');
      }
    }

    function fechar() {
      clearInterval(tique);
      document.body.style.overflow = '';
      el.remove();
    }

    $('#formConfirmarEmail').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      avisar('');
      const codigo = $('#codigoConfirmarEmail').value.trim();
      try {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/confirmar-email`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ codigo }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          avisar(d.erro || 'não deu pra confirmar', 'err');
          if (d.motivo === 'esgotado' || d.motivo === 'expirado') lerEstado();
          return;
        }
        conta.email_confirmado = true;
        fechar();
        // Quem depende disso na mesma página (o perfil libera a troca de
        // e-mail) se atualiza sem F5.
        window.dispatchEvent(new CustomEvent('mostrai:email-confirmado', { detail: { email: conta.contato_email } }));
      } catch {
        avisar('sem conexão com o servidor', 'err');
      }
    });

    btnReenviar.addEventListener('click', async () => {
      avisar('enviando...');
      btnReenviar.disabled = true;
      try {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/reenviar-codigo-email`, {
          method: 'POST',
          credentials: 'include',
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) {
          if (d.podeReenviarEm) aplicarPrazos({ expiraEm, podeReenviarEm: d.podeReenviarEm });
          else pintarRelogio();
          return avisar(d.erro || 'não deu pra reenviar agora', 'err');
        }
        aplicarPrazos(d);
        avisar('código novo enviado — o anterior não vale mais. Confira também o spam.', 'ok');
      } catch {
        pintarRelogio();
        avisar('sem conexão com o servidor', 'err');
      }
    });

    $('#btnCorrigirEmail').addEventListener('click', () => {
      avisar('');
      etapa('corrigir');
      $('#novoEmailCadastro').focus();
    });
    $('#btnVoltarCodigo').addEventListener('click', () => {
      avisar('');
      etapa('codigo');
    });
    $('#formCorrigirEmail').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      avisar('salvando...');
      try {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/corrigir-email`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: $('#novoEmailCadastro').value.trim(), senha: $('#senhaCorrigirEmail').value }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok && !d.email) return avisar(d.erro || 'não deu pra corrigir', 'err');
        $('#senhaCorrigirEmail').value = '';
        etapa('codigo');
        if (d.email) conta.contato_email = d.email;
        if (r.ok) {
          aplicarPrazos(d);
          avisar('e-mail corrigido — mandamos um código novo pra ele.', 'ok');
        } else {
          await lerEstado();
          avisar(d.erro, 'err');
        }
      } catch {
        avisar('sem conexão com o servidor', 'err');
      }
    });

    pintarRelogio();
    lerEstado();
  }
})();

// Rótulos de status. Estavam repetidos em 5 arquivos, já com textos diferentes
// pro mesmo status entre uma tela e outra.
window.ROTULOS = {
  // `status` deixou de ser estado operacional (16/09/2026) — só distingue
  // comum de parceiro (substitui o antigo "fundador"). O que bloqueia
  // login/veiculação é `suspenso`, mostrado à parte por quem usa isso.
  anunciante: { comum: 'Comum', parceiro: 'Parceiro' },
  // Os quatro status automáticos do ponto (migration 069, derivados das
  // telas por sincronizarStatusPonto). Faltavam os dois últimos: um ponto em
  // reparo aparecia com a chave crua do banco.
  ponto: {
    a_instalar: 'Aguardando instalação',
    aguardando_primeiro_sinal: 'Aguardando primeiro sinal',
    em_operacao: 'Ativo',
    em_reparo: 'Em reparo',
    inativo: 'Inativo',
  },
  pontoClasse: {
    a_instalar: 'badge-pendente',
    aguardando_primeiro_sinal: 'badge-pendente',
    em_operacao: 'badge-ok',
    em_reparo: 'badge-pendente',
    inativo: 'badge-neutro',
  },
  // "Meus pontos" do painel (src/pontos/meus-pontos.js): o ciclo inteiro do
  // estabelecimento, do pedido em análise ao ponto no ar.
  estabelecimento: {
    em_analise: 'Em análise',
    aguardando_instalacao: 'Aguardando instalação',
    aguardando_primeiro_sinal: 'Aguardando primeiro sinal',
    ativo: 'Ativo',
    em_manutencao: 'Em reparo',
    inativo: 'Inativo',
  },
  estabelecimentoClasse: {
    em_analise: 'badge-pendente',
    aguardando_instalacao: 'badge-pendente',
    aguardando_primeiro_sinal: 'badge-pendente',
    ativo: 'badge-ok',
    em_manutencao: 'badge-pendente',
    inativo: 'badge-neutro',
  },
  // 'retirado' (23/09/2026, migration 075): o admin tirou do ar, ou saiu
  // porque a versão nova foi aprovada no lugar. Continua na conta.
  criativo: { pendente: 'Em análise', aprovado: 'Aprovado', reprovado: 'Reprovado', retirado: 'Fora do ar' },
  criativoClasse: {
    pendente: 'badge-pendente',
    aprovado: 'badge-ok',
    reprovado: 'badge-err',
    retirado: 'badge-pendente',
  },
  // "Meus criativos" do painel (GET /anunciantes/me/criativos): a situação
  // que o cliente entende, com "No ar" separado de "Aprovado" (aprovada mas
  // fora do rodízio agora — plano sem vaga pra mais uma peça, ou sem plano).
  criativoSituacao: {
    em_analise: 'Em análise',
    aprovado: 'Aprovado',
    no_ar: 'No ar',
    fora_do_ar: 'Fora do ar',
    recusado: 'Recusado',
  },
  criativoSituacaoClasse: {
    em_analise: 'badge-pendente',
    aprovado: 'badge-neutro',
    no_ar: 'badge-ok',
    fora_do_ar: 'badge-neutro',
    recusado: 'badge-err',
  },
  // Créditos e benefícios. As chaves de tier são as do banco (planos.tier);
  // o nome que o cliente vê é outro desde a grade nova.
  tier: { essencial: 'Essencial', destaque: 'Pro', maximo: 'Prime' },
  // Ciclo comercial — o MESMO nome pro plano pago e pro benefício por
  // créditos (ADR-018, espelho de src/lib/ciclos.js). Chave = meses.
  ciclo: { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' },
  movimentoCredito: {
    indicacao_primeiro_pagamento: 'Indicação · primeiro pagamento',
    indicacao_renovacao: 'Indicação · renovação',
    credito_mensal_ponto: 'Crédito mensal do ponto',
    concessao_admin: 'Crédito da Mostraí',
    estorno_admin: 'Ajuste da Mostraí',
    resgate_beneficio: 'Resgate',
    estorno_resgate: 'Estorno de resgate',
  },
};
