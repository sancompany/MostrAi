// Central de Atualizações — sino no cabeçalho da conta (Fase 4, reconstrução
// do painel, 23/09/2026). Histórico puro de eventos que já aconteceram
// (criativo aprovado, candidatura decidida, pagamento confirmado, créditos
// recebidos, benefício iniciado/programado, conta suspensa/reativada) —
// nunca chat, nunca CRM, nunca uma ação pra tomar.
//
// Uso: montarCentralNotificacoes() depois que a conta carregar (mesmo padrão
// de montarPerfil). Requer /config.js, /layout.js e /eventos.js antes — o
// sino e o popover já estão no HTML, injetados por layout.js#navConta.
(function () {
  let naoLidas = 0;
  let carregouUmaVez = false;

  function atualizarBadge() {
    const badge = document.getElementById('sinoBadge');
    if (!badge) return;
    badge.hidden = naoLidas === 0;
    badge.textContent = naoLidas > 99 ? '99+' : String(naoLidas);
  }

  // Um ícone por tipo — a lista inteira de tipos que o backend emite hoje
  // (src/creditos/notificacoes.js e quem chama .registrar). Tipo sem mapa
  // cai no sino genérico, nunca quebra.
  const ICONE = {
    criativo_aprovado: '🎬',
    criativo_recusado: '🎬',
    ponto_aprovado: '📍',
    ponto_recusado: '📍',
    pagamento_confirmado: '💳',
    creditos_recebidos: '🎁',
    beneficio_iniciado: '✨',
    beneficio_programado: '✨',
    conta_suspensa: '⚠️',
    conta_reativada: '✅',
  };

  function tempoRelativo(iso) {
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 48) return `há ${h} h`;
    return `há ${Math.round(h / 24)} dias`;
  }

  function itemHtml(n) {
    const lida = !!n.lida_em;
    return `<button type="button" class="central-notif-item${lida ? '' : ' nao-lida'}" data-id="${n.id}">
      <span class="central-notif-icone" aria-hidden="true">${ICONE[n.tipo] || '🔔'}</span>
      <span class="central-notif-corpo">
        <b>${window.esc(n.titulo)}</b>
        ${n.descricao ? `<span>${window.esc(n.descricao)}</span>` : ''}
        <time>${tempoRelativo(n.criado_em)}</time>
      </span>
    </button>`;
  }

  async function carregar() {
    const lista = document.getElementById('centralNotifLista');
    if (!lista) return;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/notificacoes`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      const { notificacoes, naoLidas: n } = await r.json();
      naoLidas = n;
      atualizarBadge();
      lista.innerHTML = notificacoes.length
        ? notificacoes.map(itemHtml).join('')
        : '<p class="texto-vazio">Nenhuma atualização ainda.</p>';
      lista
        .querySelectorAll('[data-id]')
        .forEach((btn) => btn.addEventListener('click', () => marcarLida(Number(btn.dataset.id), btn)));
      carregouUmaVez = true;
    } catch {
      if (!carregouUmaVez) lista.innerHTML = '<p class="texto-vazio">Não foi possível carregar agora.</p>';
    }
  }

  // Otimista (reversível, ação simples — critério do pedido original de não
  // esperar confirmação só pra pagamento/créditos/resgate/plano/aprovação):
  // marca na hora, desfaz se o servidor recusar.
  async function marcarLida(id, btn) {
    if (!btn.classList.contains('nao-lida')) return;
    btn.classList.remove('nao-lida');
    naoLidas = Math.max(0, naoLidas - 1);
    atualizarBadge();
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/notificacoes/${id}/lida`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error();
    } catch {
      btn.classList.add('nao-lida');
      naoLidas += 1;
      atualizarBadge();
    }
  }

  async function marcarTodasLidas() {
    const lista = document.getElementById('centralNotifLista');
    const antes = naoLidas;
    lista?.querySelectorAll('.nao-lida').forEach((el) => el.classList.remove('nao-lida'));
    naoLidas = 0;
    atualizarBadge();
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/notificacoes/marcar-todas-lidas`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error();
    } catch {
      naoLidas = antes;
      carregar();
    }
  }

  function alternarPopover(forcar) {
    const pop = document.getElementById('centralNotif');
    const btn = document.getElementById('btnSino');
    if (!pop || !btn) return;
    const vaiAbrir = forcar ?? pop.hidden;
    pop.hidden = !vaiAbrir;
    btn.setAttribute('aria-expanded', String(vaiAbrir));
    if (vaiAbrir) carregar();
  }

  window.montarCentralNotificacoes = function montarCentralNotificacoes() {
    const btn = document.getElementById('btnSino');
    if (!btn) return;
    carregar();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      alternarPopover();
    });
    document.getElementById('btnMarcarTodasLidas')?.addEventListener('click', marcarTodasLidas);
    document.addEventListener('click', (e) => {
      const pop = document.getElementById('centralNotif');
      if (pop && !pop.hidden && !pop.contains(e.target) && !btn.contains(e.target)) alternarPopover(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') alternarPopover(false);
    });
    // Sem F5 (Fase 3, SSE): uma notificação nova refaz a busca — o badge e,
    // se o popover já estiver aberto, a lista também. Sempre um refetch
    // canônico, nunca incrementa o contador local (evita o badge divergir
    // do servidor se dois eventos chegarem quase juntos).
    if (window.ligarEventosDaConta) {
      window.ligarEventosDaConta({ 'notification.created': carregar });
    }
  };
})();
