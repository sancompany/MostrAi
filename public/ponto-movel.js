// Mostraí Móvel — a REDE MÓVEL de uma cidade (migrations 112 a 115): os
// textos que aparecem em mais de uma tela — escolha de pontos do
// anunciante, Admin e "Onde estamos" — nascem aqui uma vez. Onde a rede está
// agora e o próximo compromisso é o servidor que decide
// (src/pontos/movel.js); aqui só se escreve. A cidade vem da rede — nunca
// fixa no texto, nem dentro do nome (nome e cidade são campos separados).
(() => {
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  window.PONTO_MOVEL = {
    selo: 'Itinerante',
    // A ideia comercial (pedido do dono): mobilidade e eventos — nunca
    // promessa de audiência.
    explica: (cidade) => `Rede móvel de eventos e ações${cidade ? ` em ${cidade}` : ''}.`,
    cidade: (cidade, uf) => [cidade, uf].filter(Boolean).join('/'),
    telas: (total, emOperacao) => `${plural(total, 'tela', 'telas')} · ${emOperacao} em operação`,
    // Card do anunciante: onde está AGORA e a PRÓXIMA localização. Sem
    // localização não é erro nem indisponibilidade — a rede continua
    // escolhível.
    semLocal: 'Sem localização no momento',
    semProximo: 'Nenhuma programada',
    locais: (n) => `${n} locais em operação`,
    tipo: (t) => (t === 'evento' ? 'Evento' : 'Estabelecimento'),
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

  // Datas curtas do card e da agenda pública, no relógio de Matão:
  // "Hoje", "Amanhã" ou "08/10"; hora "18h" / "18h30" / "18:00".
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const emMatao = (v) => {
    const o = Object.fromEntries(partes.formatToParts(new Date(v)).map((x) => [x.type, x.value]));
    return { dia: `${o.year}-${o.month}-${o.day}`, dd: o.day, mm: o.month, hh: o.hour, mi: o.minute };
  };
  const diaRelativo = (v) => {
    const alvo = emMatao(v);
    const hoje = emMatao(Date.now());
    const amanha = emMatao(Date.now() + 86_400_000);
    if (alvo.dia === hoje.dia) return 'Hoje';
    if (alvo.dia === amanha.dia) return 'Amanhã';
    return `${alvo.dd}/${alvo.mm}`;
  };
  const horaCurta = (v) => {
    const t = emMatao(v);
    return t.mi === '00' ? `${Number(t.hh)}h` : `${Number(t.hh)}h${t.mi}`;
  };
  const hora = (v) => {
    const t = emMatao(v);
    return `${t.hh}:${t.mi}`;
  };
  // "Hoje às 18h", "08/10 às 18h30".
  window.PONTO_MOVEL.quando = (inicio) => (inicio ? `${diaRelativo(inicio)} às ${horaCurta(inicio)}` : '');
  // Linha da agenda: { data, horario } — mesmo dia: "Hoje" + "18:00–22:00";
  // vários dias: "07/10–14/10" + "08:00 → 18:00".
  window.PONTO_MOVEL.periodoDaAgenda = (inicio, fim) => {
    const a = emMatao(inicio);
    const b = emMatao(fim);
    if (a.dia === b.dia) return { data: diaRelativo(inicio), horario: `${hora(inicio)}–${hora(fim)}` };
    return { data: `${diaRelativo(inicio)}–${diaRelativo(fim)}`, horario: `${hora(inicio)} → ${hora(fim)}` };
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
