// Ponto móvel (02/10/2026, migration 112): os textos que aparecem em mais de
// uma tela — escolha de pontos do anunciante, "Meus pontos" da base, Admin e
// "Onde estamos" — nascem aqui uma vez. Quem decide local atual e próximo
// evento é o servidor (src/pontos/movel.js); aqui só se escreve.
(() => {
  window.PONTO_MOVEL = {
    selo: 'Ponto móvel',
    // A ideia comercial (pedido do dono): mobilidade e eventos — nunca
    // promessa de audiência.
    explica: 'Circula por eventos e locais da cidade, levando sua campanha além de um endereço fixo.',
    semEvento: 'Sem evento programado no momento.',
    // Já em evento e nada depois dele: "sem evento no momento" desmentiria
    // o "Agora em: <evento>" logo acima.
    semOutroEvento: 'Nenhum outro evento programado.',
  };

  const dia = (v) => /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));

  // "18/10/2026", "18 a 20/10/2026", "30/10 a 02/11/2026" ou "28/12/2026 a 03/01/2027".
  window.periodoDoEvento = function periodoDoEvento(inicio, fim) {
    const a = dia(inicio);
    const b = dia(fim);
    if (!a) return '';
    if (!b || fim === inicio) return `${a[3]}/${a[2]}/${a[1]}`;
    if (a[1] !== b[1]) return `${a[3]}/${a[2]}/${a[1]} a ${b[3]}/${b[2]}/${b[1]}`;
    if (a[2] !== b[2]) return `${a[3]}/${a[2]} a ${b[3]}/${b[2]}/${b[1]}`;
    return `${a[3]} a ${b[3]}/${b[2]}/${b[1]}`;
  };

  // Estimativa do EVENTO (informada pela organização), nunca audiência
  // medida nem exibição garantida — por isso o "~" e a palavra "estimado".
  window.publicoEstimadoTexto = function publicoEstimadoTexto(n) {
    const v = Number(n);
    return Number.isFinite(v) && v > 0 ? `Público estimado: ~${v.toLocaleString('pt-BR')} pessoas` : '';
  };
})();
