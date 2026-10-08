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
// imagem estática do arquivo. O `srcset` (versão leve pro celular) sai junto:
// com ele presente, o navegador ignora a `src` nova e continuaria mostrando
// a foto estática. As dimensões reservadas também saem — a foto do admin
// pode ter outra proporção.
fetch(`${API_BASE_URL}/pontos/config`)
  .then((r) => r.json())
  .then(({ fotoExemploUrl }) => {
    if (!fotoExemploUrl) return;
    const img = document.querySelector('.exemplo-ponto img');
    img.removeAttribute('srcset');
    img.removeAttribute('width');
    img.removeAttribute('height');
    img.src = fotoExemploUrl;
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
    // Rede móvel: `em_operacao` só com local atual (GET /pontos), nunca o
    // estado técnico das telas.
    const ativos = pontos.filter((p) => p.status === 'em_operacao').length;
    const emConstrucao = pontos.filter(
      (p) => p.status === 'a_instalar' || p.status === 'aguardando_primeiro_sinal',
    ).length;
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
      aguardando_primeiro_sinal: { texto: 'Em instalação', classe: 'badge-pendente' },
      em_reparo: { texto: 'Em reparo', classe: 'badge-pendente' },
    };
    const linkDoMapa = (endereco) =>
      `<a class="mapa-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(endereco)}" target="_blank" rel="noopener">📍 Ver no mapa</a>`;
    const fixo = (p) => {
      // Linha do endereço com a mesma regra do resto do sistema
      // (window.linhaEndereco — D5, 24/09/2026): rua, número e bairro.
      const linha = window.linhaEndereco(p);
      const st = STATUS_LABEL[p.status] || STATUS_LABEL.a_instalar;
      return `
      <div class="ponto-card">
        <div class="ponto-card-media">${fotoOuPlaceholder(p.foto_instalacao_url, p.nome)}</div>
        <span class="badge ${st.classe}">${st.texto}</span>
        <h4>${esc(p.nome)}</h4>
        <p>${esc(p.cidade)}${linha ? ', ' + esc(linha) : ''}</p>
        ${linkDoMapa(`${linha ? linha + ', ' : ''}${p.cidade}`)}
      </div>
    `;
    };
    // MOSTRAÍ MÓVEL — UM card por rede (cidade/UF), com ou sem localização:
    // a foto da rede com o selo MÓVEL, "Local atual" e "Próximo". O mapa só
    // aparece para o local REAL de agora (o endereço da alocação em curso);
    // sem local, nenhum mapa — a rede não tem base nem coordenada.
    const movel = (p) => {
      const PM = window.PONTO_MOVEL;
      const m = p.movel || {};
      const agora = Array.isArray(m.agora) ? m.agora : [];
      const cidade = PM.cidade(p.cidade, p.uf);
      const onde = (rotulo, valor, vazio) =>
        `<p class="ponto-movel-onde${vazio ? ' vazio' : ''}"><span class="ponto-movel-rotulo">${rotulo}</span><span class="ponto-movel-valor">${esc(valor)}</span></p>`;
      const atual = agora.length
        ? agora
            .map(
              (l) =>
                `${onde('Local atual', [l.evento, l.nome].filter(Boolean).join(' · '), false)}${
                  l.endereco || l.nome
                    ? linkDoMapa([...new Set([l.nome, l.endereco, cidade].filter(Boolean))].join(', '))
                    : ''
                }`,
            )
            .join('')
        : onde('Local atual', PM.semLocal, true);
      const proximo = m.proximo
        ? `${[m.proximo.nome, m.proximo.local].filter(Boolean).join(' · ')} — ${PM.quando(m.proximo.inicio)}`
        : PM.semProximoCompromisso;
      return `
      <div class="ponto-card ponto-card-movel">
        <div class="ponto-card-media">${fotoOuPlaceholder(m.foto, p.nome)}<span class="selo-movel">${esc(PM.selo)}</span></div>
        <h4>${esc(p.nome)}</h4>
        <p>${esc(cidade)}</p>
        <p class="u-dim">${esc(PM.explica(p.cidade))}</p>
        ${atual}
        ${onde('Próximo', proximo, !m.proximo)}
      </div>
    `;
    };
    grid.innerHTML = pontos.map((p) => (p.tipo === 'movel' && window.PONTO_MOVEL ? movel(p) : fixo(p))).join('');
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
