// TICK — home pública (/tic/eventos): os eventos publicados, com banner,
// nome, data e local, e a busca. Cada card leva à página de venda do evento
// (/ticket/<evento>/<edição>), que é a de sempre.
(() => {
  const { el, api, dataHora, visitante, guardarIndicacaoGeral, indicacaoGeral } = window.trimundi;
  const lista = document.getElementById('lista');
  const form = document.getElementById('formBusca');
  const campo = document.getElementById('busca');
  const CLASSIFICACAO = { livre: 'Livre', 10: '10 anos', 12: '12 anos', 14: '14 anos', 16: '16 anos', 18: '18 anos' };

  function cartao(e) {
    return el(
      'a',
      { class: 'cartao-evento', href: e.endereco },
      el(
        'div',
        { class: 'cartao-evento-capa' },
        e.banner
          ? el('img', { class: 'cartao-evento-banner', src: e.banner, alt: '', loading: 'lazy' })
          : el('div', { class: 'cartao-evento-banner vazio', 'aria-hidden': 'true' }),
        e.logo ? el('img', { class: 'cartao-evento-logo', src: e.logo, alt: '', loading: 'lazy' }) : null,
      ),
      el(
        'div',
        { class: 'cartao-evento-corpo' },
        el('p', { class: 'sobre', text: e.evento }),
        el('h2', { text: e.edicao }),
        el('p', { class: 'detalhe', text: e.inicio_em ? dataHora(e.inicio_em) : 'Data a definir' }),
        el('p', { class: 'detalhe', text: e.local || 'Local a definir' }),
        el(
          'div',
          { class: 'cartao-evento-selos' },
          e.classificacao_etaria ? el('span', { class: 'selo', text: CLASSIFICACAO[e.classificacao_etaria] }) : null,
          e.vendas_pausadas ? el('span', { class: 'selo alerta', text: 'Vendas pausadas' }) : null,
        ),
      ),
    );
  }

  async function carregar(q = '') {
    lista.replaceChildren(el('p', { class: 'carregando', text: 'Carregando...' }));
    try {
      const { eventos } = await api(`/ticket/api/vitrine${q ? `?q=${encodeURIComponent(q)}` : ''}`);
      if (!eventos.length) {
        lista.replaceChildren(
          el('p', {
            class: 'vazio-lista',
            text: q ? `Nenhum evento encontrado para "${q}".` : 'Nenhum evento à venda agora.',
          }),
        );
        return;
      }
      lista.replaceChildren(...eventos.map(cartao));
    } catch (err) {
      lista.replaceChildren(el('p', { class: 'mensagem erro', text: err.message }));
    }
  }

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const q = campo.value.trim();
    const url = new URL(window.location.href);
    if (q) url.searchParams.set('q', q);
    else url.searchParams.delete('q');
    history.replaceState(null, '', url);
    carregar(q);
  });

  // Link de indicação geral (/tic/eventos?ind=CÓDIGO): o código fica guardado
  // para o evento que a pessoa abrir, a visita conta uma vez por navegador e
  // a página diz quem indicou (só o nome).
  async function indicacao() {
    const ind = new URLSearchParams(window.location.search).get('ind');
    if (ind) guardarIndicacaoGeral(ind);
    const codigo = indicacaoGeral();
    if (!codigo) return;
    try {
      const r = await api('/ticket/api/indicacao/visita', {
        metodo: 'POST',
        corpo: { codigo, visitante: visitante() },
      });
      if (r.indicacao) {
        const aviso = el('p', {
          class: 'mensagem indicado-por',
          text:
            r.indicacao.tipo === 'operador'
              ? `Você chegou por indicação de ${r.indicacao.nome} — Operador oficial.`
              : `Você chegou por indicação de ${r.indicacao.nome}.`,
        });
        form.after(aviso);
      }
    } catch {}
  }

  const inicial = new URLSearchParams(window.location.search).get('q') || '';
  campo.value = inicial;
  carregar(inicial);
  indicacao();
})();
