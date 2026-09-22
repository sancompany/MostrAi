// Placeholder oficial de ponto sem foto (redesenho da Rede, 22/09/2026) —
// mesmo conceito e a mesma marcação do card do admin (public/admin/index.page.js,
// fotoOuPlaceholder). Sem bundler, cada arquivo tem a própria cópia
// (convenção do projeto) — aqui não usa `foto` como fallback de
// estabelecimento sem foto: aquilo é a ilustração genérica do totem
// completo (abaixo), não a foto de nenhum ponto real.
function fotoOuPlaceholder(url, nome) {
  if (url) return `<img src="${esc(url)}" alt="${esc(nome || '')}" loading="lazy">`;
  return `<div class="ponto-foto-placeholder" role="img" aria-label="${esc(nome ? `${nome}, sem foto` : 'Ponto sem foto')}">
    <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
      <path d="M12 21.5s7.25-7.35 7.25-12.25a7.25 7.25 0 1 0-14.5 0c0 4.9 7.25 12.25 7.25 12.25Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="12" cy="9.25" r="2.75" fill="none" stroke="currentColor" stroke-width="1.6"/>
    </svg>
  </div>`;
}

// Foto de exemplo do "ponto completo" é trocável pelo admin (sem deploy);
// só troca a `src` quando existe uma customizada — sem isso, continua a
// imagem estática do arquivo.
fetch(`${API_BASE_URL}/pontos/config`)
  .then((r) => r.json())
  .then(({ fotoExemploUrl }) => {
    if (fotoExemploUrl) document.querySelector('.exemplo-ponto img').src = fotoExemploUrl;
  })
  .catch(() => {});

fetch(`${API_BASE_URL}/pontos`)
  .then((r) => {
    if (!r.ok) throw new Error(`resposta ${r.status}`);
    return r.json();
  })
  .then((pontos) => {
    const grid = document.getElementById('pontosGrid');
    if (!Array.isArray(pontos)) throw new Error('resposta inesperada');
    const ativos = pontos.filter((p) => p.status === 'em_operacao').length;
    const emConstrucao = pontos.filter((p) => p.status === 'a_instalar').length;
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
    // Soma de fluxo só aparece acima de zero (ver GET /pontos/fluxo).
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
        '<p class="empty-state">A rede está em montagem: nenhuma tela no ar ainda. Se você tem comércio em Matão, <a href="/anunciante/cadastro.html">a primeira pode ser a sua</a>.</p>';
      return;
    }
    const STATUS_LABEL = {
      em_operacao: { texto: 'No ar', classe: 'badge-ok' },
      a_instalar: { texto: 'Em instalação', classe: 'badge-pendente' },
    };
    grid.innerHTML = pontos
      .map((p) => {
        const enderecoCompleto = `${p.endereco ? p.endereco + ', ' : ''}${p.cidade}`;
        const mapaUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enderecoCompleto)}`;
        const st = STATUS_LABEL[p.status] || STATUS_LABEL.em_operacao;
        return `
      <div class="ponto-card">
        <div class="ponto-card-media">${fotoOuPlaceholder(p.foto_instalacao_url, p.nome)}</div>
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
