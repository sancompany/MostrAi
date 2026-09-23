// Resumo da conta + alertas do painel único (Fatia 5, 23/09/2026).
//
// Cada módulo (plano, pontos, criativos, créditos) já carrega os próprios
// dados; em vez de um endpoint novo repetindo as mesmas consultas, cada um
// publica aqui o que sabe:
//   window.publicarResumo('pontos', { chips: [...], alertas: [...] })
//   chip   = { rotulo, valor, alvo }            (alvo = id do módulo)
//   alerta = { nivel: 'atencao'|'info', texto, alvo }
// Publicar de novo SUBSTITUI o que o módulo tinha publicado — nada acumula
// quando o SSE recarrega um módulo. A ordem dos módulos é fixa.
(function () {
  const ORDEM = ['plano', 'pontos', 'criativos', 'creditos'];
  const porModulo = {};
  let agendado = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);

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
      lista.hidden = !alertas.length;
      lista.innerHTML = alertas
        .map(
          (a) =>
            `<li class="alerta-${a.nivel}"><span class="alerta-icone" aria-hidden="true">${a.nivel === 'atencao' ? '!' : 'i'}</span>
              <span>${esc(a.texto)}</span>${a.alvo ? `<a href="#${esc(a.alvo)}">Ver</a>` : ''}</li>`,
        )
        .join('');
    }
  }

  window.publicarResumo = function publicarResumo(modulo, dados) {
    porModulo[modulo] = { chips: dados?.chips || [], alertas: dados?.alertas || [] };
    // Vários módulos terminam juntos na carga: um desenho por volta.
    if (!agendado) {
      agendado = true;
      setTimeout(desenhar, 0);
    }
  };
})();
