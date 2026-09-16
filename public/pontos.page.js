fetch(`${API_BASE_URL}/pontos`)
  .then((r) => {
    if (!r.ok) throw new Error(`resposta ${r.status}`);
    return r.json();
  })
  .then((pontos) => {
    const grid = document.getElementById('pontosGrid');
    if (!Array.isArray(pontos)) throw new Error('resposta inesperada');
    const ativos = pontos.filter((p) => p.status === 'ativo').length;
    const emConstrucao = pontos.filter((p) => p.status === 'aguardando_instalacao').length;
    const cidades = new Set(pontos.map((p) => p.cidade)).size;
    // `cidades || 1` dizia "1 Cidade atendida" com a rede vazia — o numero que
    // mais importa pra quem esta decidindo assinar, inventado. Com zero ponto a
    // faixa some e a pagina diz o que e verdade logo abaixo.
    document.getElementById('statRow').innerHTML = pontos.length
      ? `
      <div class="stat"><b>${ativos}</b><span>${ativos === 1 ? 'Ponto ativo' : 'Pontos ativos'}</span></div>
      <div class="stat"><b>${emConstrucao}</b><span>Em instalação</span></div>
      <div class="stat"><b>${cidades}</b><span>${cidades > 1 ? 'Cidades atendidas' : 'Cidade atendida'}</span></div>
    `
      : '';
    // Soma de fluxo só aparece com 1.000+ pessoas somadas (ver
    // GET /pontos/fluxo) — número pequeno demais não vira prova social.
    fetch(`${API_BASE_URL}/pontos/fluxo`)
      .then((r) => r.json())
      .then(({ pessoasPorMes }) => {
        if (!pessoasPorMes) return;
        document
          .getElementById('statRow')
          .insertAdjacentHTML(
            'afterbegin',
            `<div class="stat"><b>${pessoasPorMes.toLocaleString('pt-BR')}</b><span>Pessoas por mês (estimativa dos pontos)</span></div>`,
          );
      })
      .catch(() => {});
    if (!pontos.length) {
      grid.innerHTML =
        '<p class="empty-state">A rede está em montagem: nenhuma tela no ar ainda. Se você tem comércio em Matão, <a href="/seja-um-ponto.html">a primeira pode ser a sua</a>.</p>';
      return;
    }
    const STATUS_LABEL = {
      ativo: { texto: 'Ativo', classe: 'badge-ok' },
      aguardando_instalacao: { texto: 'Em construção', classe: 'badge-pendente' },
      reparo: { texto: 'Em reparo', classe: 'badge-err' },
    };
    grid.innerHTML = pontos
      .map((p) => {
        const enderecoCompleto = `${p.endereco ? p.endereco + ', ' : ''}${p.cidade}`;
        const mapaUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enderecoCompleto)}`;
        const st = STATUS_LABEL[p.status] || STATUS_LABEL.ativo;
        return `
      <div class="ponto-card">
        <span class="badge ${st.classe}">${st.texto}</span>
        <h4>${esc(p.nome)}</h4>
        <p>${esc(p.cidade)}${p.endereco ? ', ' + esc(p.endereco) : ''}</p>
        <a class="mapa-link" href="${mapaUrl}" target="_blank" rel="noopener">📍 Ver no mapa</a>
      </div>
    `;
      })
      .join('');
  })
  .catch((err) => {
    // Erro tem que ser distinguivel de "a rede esta vazia": a faixa de
    // contadores some (nao existe numero nenhum pra mostrar) e a mensagem
    // convida a tentar de novo, em vez de dizer que nao ha ponto.
    console.error('falha ao carregar os pontos', err);
    document.getElementById('statRow').innerHTML = '';
    document.getElementById('pontosGrid').innerHTML =
      '<p class="empty-state">Não foi possível carregar os pontos agora. Atualize a página em alguns instantes.</p>';
  });
