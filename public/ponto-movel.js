// Ponto móvel (migrations 112 e 114): os textos que aparecem em mais de uma
// tela — escolha de pontos do anunciante, Admin e "Onde estamos" — nascem
// aqui uma vez. Quem decide local atual e próximo evento é o servidor
// (src/pontos/movel.js); aqui só se escreve. O móvel não tem base: só tem
// local enquanto está ALOCADO (hospedagem ou evento).
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
    semAlocacao: 'Sem alocação',
    // Quem já tinha escolhido o móvel e ele ficou sem alocação.
    semAlocacaoEscolhido: 'Sem alocação no momento — volta a veicular quando for alocado.',
  };

  // "10/10 08:00", no relógio de Matão (o período da alocação tem hora).
  const formato = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  window.instanteMatao = (v) => (v ? formato.format(new Date(v)).replace(',', '') : '');
  // "10/10 08:00 → 12/10 18:00".
  window.periodoComHora = (inicio, fim) =>
    inicio ? `${window.instanteMatao(inicio)} → ${window.instanteMatao(fim)}` : '';

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
