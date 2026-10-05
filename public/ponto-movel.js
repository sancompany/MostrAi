// Mostraí Móvel — a REDE MÓVEL de uma cidade (migrations 112 a 115): os
// textos que aparecem em mais de uma tela — escolha de pontos do
// anunciante, Admin e "Onde estamos" — nascem aqui uma vez. Quantas telas a
// rede tem e quantas estão em operação é o servidor que decide
// (src/pontos/movel.js); aqui só se escreve. A cidade vem da rede — nunca
// fixa no texto.
(() => {
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  window.PONTO_MOVEL = {
    selo: 'Itinerante',
    // A ideia comercial (pedido do dono): mobilidade e eventos — nunca
    // promessa de audiência.
    explica: (cidade) => `Rede móvel de eventos e ações${cidade ? ` em ${cidade}` : ''}.`,
    telas: (total, emOperacao) => `${plural(total, 'tela', 'telas')} na rede · ${emOperacao} em operação agora`,
    // 0 tela em operação: a rede continua escolhível (1 posição do plano).
    semOperacao: (cidade) =>
      `Nenhuma tela móvel em operação agora. A campanha volta automaticamente para a rede móvel quando houver inventário ativo${cidade ? ` em ${cidade}` : ''}.`,
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
