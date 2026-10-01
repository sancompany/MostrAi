// Resumo da conta + alertas do painel único (Fatia 5, 23/09/2026).
//
// Cada módulo (plano, pontos, criativos, créditos) já carrega os próprios
// dados; em vez de um endpoint novo repetindo as mesmas consultas, cada um
// publica aqui o que sabe:
//   window.publicarResumo('pontos', { chips: [...], alertas: [...] })
//   chip   = { rotulo, valor, alvo }            (alvo = id do módulo)
//   alerta = { nivel: 'atencao'|'info', texto, alvo }
// Pendência da conta (public/pendencias.js, 01/10/2026) é um alerta com
// `pendencia: true`, `titulo` e `cta: { rotulo, acao }` — o botão abre a
// correção direto. Elas vêm primeiro, com a contagem em cima.
// Publicar de novo SUBSTITUI o que o módulo tinha publicado — nada acumula
// quando o SSE recarrega um módulo. A ordem dos módulos é fixa.
(function () {
  const ORDEM = ['pendencias', 'plano', 'pontos', 'criativos', 'creditos'];
  const porModulo = {};
  let agendado = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  let alertasDesenhados = [];

  function desenhar() {
    agendado = false;
    const chips = ORDEM.flatMap((m) => porModulo[m]?.chips || []);
    const alertas = ORDEM.flatMap((m) => porModulo[m]?.alertas || []).sort(
      (a, b) => (a.nivel === 'atencao' ? 0 : 1) - (b.nivel === 'atencao' ? 0 : 1),
    );
    const resumo = $('resumoConta');
    if (resumo) {
      resumo.innerHTML = chips
        .map(
          (c) =>
            `<a class="resumo-chip" href="#${esc(c.alvo)}"><span>${esc(c.rotulo)}</span><b>${esc(c.valor)}</b></a>`,
        )
        .join('');
    }
    const lista = $('alertasConta');
    if (lista) {
      alertasDesenhados = alertas;
      const pendencias = alertas.filter((a) => a.pendencia).length;
      const cabeca = pendencias
        ? `<li class="alertas-conta-cabeca">${
            pendencias === 1
              ? '1 pendência precisa da sua atenção.'
              : `${pendencias} pendências precisam da sua atenção.`
          }</li>`
        : '';
      lista.hidden = !alertas.length;
      lista.innerHTML =
        cabeca +
        alertas
          .map((a, i) => {
            const acao = a.cta
              ? `<button type="button" class="btn ghost mini alerta-cta" data-alerta-cta="${i}">${esc(a.cta.rotulo)}</button>`
              : a.alvo
                ? `<a href="#${esc(a.alvo)}">Ver</a>`
                : '';
            return `<li class="alerta-${a.nivel}"><span class="alerta-icone" aria-hidden="true">${a.nivel === 'atencao' ? '!' : 'i'}</span>
              <span>${a.titulo ? `<b>${esc(a.titulo)}</b> ` : ''}${esc(a.texto)}</span>${acao}</li>`;
          })
          .join('');
    }
  }

  // Os botões são redesenhados a cada publicação: um ouvinte só, na lista.
  document.addEventListener('click', (ev) => {
    const botao = ev.target.closest?.('#alertasConta [data-alerta-cta]');
    if (botao) alertasDesenhados[Number(botao.dataset.alertaCta)]?.cta?.acao();
  });

  window.publicarResumo = function publicarResumo(modulo, dados) {
    porModulo[modulo] = { chips: dados?.chips || [], alertas: dados?.alertas || [] };
    // Vários módulos terminam juntos na carga: um desenho por volta.
    if (!agendado) {
      agendado = true;
      setTimeout(desenhar, 0);
    }
  };
})();
