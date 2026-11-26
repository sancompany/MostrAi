// /marketplace — vitrine geral: só espaços publicados de lojas que estão na
// vitrine (ativa, contrato vigente e em dia — a regra é do servidor,
// GET /marketplace/api/espacos). Filtro por cidade e tipo.
(() => {
  const V = window.VITRINE;
  const grid = document.getElementById('espacos');
  const contagem = document.getElementById('contagem');
  const selCidade = document.getElementById('filtroCidade');
  const selTipo = document.getElementById('filtroTipo');
  const esc = (v) => window.esc(v ?? '');

  selTipo.insertAdjacentHTML(
    'beforeend',
    Object.entries(V.TIPOS)
      .map(([valor, rotulo]) => `<option value="${valor}">${esc(rotulo)}</option>`)
      .join(''),
  );

  // Filtro pela URL (?cidade=&tipo=): o link compartilhado abre filtrado.
  const url = new URL(window.location.href);
  selTipo.value = url.searchParams.get('tipo') || '';

  let todos = [];
  function desenhar() {
    const cidade = selCidade.value;
    const tipo = selTipo.value;
    const lista = todos.filter((e) => (!cidade || e.cidade === cidade) && (!tipo || e.tipo === tipo));
    const q = new URLSearchParams();
    if (cidade) q.set('cidade', cidade);
    if (tipo) q.set('tipo', tipo);
    history.replaceState(null, '', `/marketplace${q.toString() ? `?${q}` : ''}`);
    contagem.textContent = todos.length
      ? `${lista.length} ${lista.length === 1 ? 'espaço' : 'espaços'}${cidade || tipo ? ' com esse filtro' : ''}`
      : '';
    if (!todos.length) {
      grid.innerHTML = '<p class="empty-state">Ainda não há espaços no Marketplace. Volte em breve.</p>';
      return;
    }
    grid.innerHTML = lista.length
      ? lista.map((e) => V.cartao(e, { loja: true })).join('')
      : '<p class="empty-state">Nenhum espaço com esse filtro. Tente outra cidade ou tipo.</p>';
  }

  fetch(`${API_BASE_URL}/marketplace/api/espacos`)
    .then((r) => {
      if (!r.ok) throw new Error(`resposta ${r.status}`);
      return r.json();
    })
    .then((lista) => {
      todos = Array.isArray(lista) ? lista : [];
      const cidades = [...new Set(todos.map((e) => e.cidade))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
      selCidade.insertAdjacentHTML(
        'beforeend',
        cidades.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join(''),
      );
      const pedida = url.searchParams.get('cidade');
      if (pedida && cidades.includes(pedida)) selCidade.value = pedida;
      desenhar();
    })
    .catch(() => {
      grid.innerHTML =
        '<p class="empty-state">Não foi possível carregar os espaços agora. Tente de novo em instantes.</p>';
    });

  selCidade.addEventListener('change', desenhar);
  selTipo.addEventListener('change', desenhar);
})();
