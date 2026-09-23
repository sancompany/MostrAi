// Horário de funcionamento do ponto, por dia da semana (migration 066) +
// feriados (rodada final da Rede, 22/09/2026 — chave nova dentro do MESMO
// jsonb, sem migration: linha antiga sem "feriados" só lê `undefined`,
// tratado igual a fechado/não informado). Formato: objeto com uma chave por
// dia — `null` (fechado) ou `{abre:"HH:MM", fecha:"HH:MM"}`. Até 22/09/2026
// o formulário perguntava só 3 grupos (semana/sábado/domingo); a coluna
// sempre guardou por dia — o formulário virou 8 linhas (7 dias + feriados),
// mas o schema não mudou nada.
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom', 'feriados'];
const NOME_DIA = {
  seg: 'segunda',
  ter: 'terça',
  qua: 'quarta',
  qui: 'quinta',
  sex: 'sexta',
  sab: 'sábado',
  dom: 'domingo',
  feriados: 'feriados',
};
const HORA_VALIDA = /^([01]\d|2[0-3]):[0-5]\d$/;

// Fuso de Matão, não do servidor (mesmo `FUSO` de src/br/formato.js, cuja
// própria doc explica o motivo: "o servidor roda em UTC e o cliente está em
// Brasília"). Achado em revisão de PR (23/09/2026): `estaAbertoAgora` usava
// `Date#getDay/getHours/getMinutes`, que leem o fuso do PROCESSO Node, não
// de São Paulo — em produção (container sem `TZ` setado, UTC) isso desloca
// toda comparação em 3h, classificando errado tanto pra mais (alerta falso
// de manhã) quanto pra menos (falha real da tarde escondida). `Intl` (já o
// padrão deste arquivo/projeto) lê o relógio na wall-clock de São Paulo
// direto, sem depender do fuso do processo.
const FUSO = 'America/Sao_Paulo';
const DIA_SEMANA_INTL = { Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab', Sun: 'dom' };
const formatoRelogioMatao = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const formatoDataMatao = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO }); // en-CA = YYYY-MM-DD

function relogioEmMatao(agora) {
  const partes = Object.fromEntries(formatoRelogioMatao.formatToParts(agora).map((p) => [p.type, p.value]));
  // `hour12: false` do Intl pode devolver "24" pra meia-noite dependendo do
  // ICU do runtime — normaliza pra 0, senão vira minuto 1440 (fora da
  // faixa 0-1439 que `minutos()` espera).
  return { dia: DIA_SEMANA_INTL[partes.weekday], horas: Number(partes.hour) % 24, minutos: Number(partes.minute) };
}

// Feriados NACIONAIS (fixos + móveis pela Páscoa, algoritmo de Meeus/Jones/
// Butcher — mesmo usado por qualquer calendário de feriado brasileiro).
// limite: só federal. Feriado municipal (aniversário da cidade, padroeiro)
// não está mapeado em lugar nenhum do projeto — cada ponto fica numa
// cidade diferente, então um mapa fixo erraria pra quase todo mundo por
// padrão. Quem precisar de feriado municipal ajusta manualmente o dia via
// horário personalizado da tela.
function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

const CACHE_FERIADOS = new Map();
function feriadosNacionais(ano) {
  if (CACHE_FERIADOS.has(ano)) return CACHE_FERIADOS.get(ano);
  const p = pascoa(ano);
  const maisDias = (dias) => new Date(p.getTime() + dias * 86400000).toISOString().slice(0, 10);
  const set = new Set([
    `${ano}-01-01`, // confraternização universal
    maisDias(-47), // carnaval (terça-feira)
    maisDias(-2), // sexta-feira santa
    `${ano}-04-21`, // tiradentes
    `${ano}-05-01`, // dia do trabalho
    maisDias(60), // corpus christi
    `${ano}-09-07`, // independência
    `${ano}-10-12`, // n. sra. aparecida
    `${ano}-11-02`, // finados
    `${ano}-11-15`, // proclamação da república
    `${ano}-12-25`, // natal
  ]);
  CACHE_FERIADOS.set(ano, set);
  return set;
}

function ehFeriadoNacional(agora) {
  const ymd = formatoDataMatao.format(agora); // já em YYYY-MM-DD, fuso de Matão
  return feriadosNacionais(Number(ymd.slice(0, 4))).has(ymd);
}

// `null`/`undefined` passam batido (campo opcional em quem chama sem exigir
// horário, ex.: cadastro manual do admin). Quem exige preenchimento checa
// isso ANTES de chamar `validar`.
function validar(horario) {
  if (horario == null) return null;
  const erro = (msg) => Object.assign(new Error(msg), { status: 400 });
  if (typeof horario !== 'object' || Array.isArray(horario)) {
    throw erro('horário de funcionamento em formato inválido');
  }
  const limpo = {};
  for (const dia of DIAS) {
    const v = horario[dia];
    if (v == null) {
      limpo[dia] = null;
      continue;
    }
    if (typeof v !== 'object' || !HORA_VALIDA.test(v.abre) || !HORA_VALIDA.test(v.fecha)) {
      throw erro(`horário de ${NOME_DIA[dia]} inválido`);
    }
    // `abre > fecha` é válido de propósito — vira madrugada (bar/balada
    // 18:00-02:00, por exemplo). Só a igualdade exata é ambígua (nunca abre,
    // ou abre 24h — nenhum dos dois é o que o campo "Fechado" já representa)
    // e por isso é recusada.
    if (v.abre === v.fecha) {
      throw erro(`${NOME_DIA[dia]}: horário de abertura não pode ser igual ao de fechamento`);
    }
    limpo[dia] = { abre: v.abre, fecha: v.fecha };
  }
  return limpo;
}

// Texto curto pro card do anunciante e pro admin. Segunda a sexta vira uma
// fatia só quando os 5 dias são idênticos (é o único caso que o formulário
// hoje produz) — cai pra dia a dia se algum dia divergir dos outros (edição
// futura mais fina, direto no banco ou numa tela que ainda não existe).
function resumo(horario) {
  if (!horario) return null;
  const fmt = (v) => (v ? `${v.abre}-${v.fecha}` : 'fechado');
  const partes = [];
  const semana = ['seg', 'ter', 'qua', 'qui', 'sex'].map((d) => horario[d]);
  const semanaIgual = semana.every((v) => JSON.stringify(v) === JSON.stringify(semana[0]));
  if (semanaIgual) {
    partes.push(`Seg-sex ${fmt(semana[0])}`);
  } else {
    for (const d of ['seg', 'ter', 'qua', 'qui', 'sex']) partes.push(`${NOME_DIA[d]} ${fmt(horario[d])}`);
  }
  partes.push(`Sáb ${fmt(horario.sab)}`);
  partes.push(`Dom ${fmt(horario.dom)}`);
  // Só entra se alguém de fato respondeu — registro antigo não tem essa
  // chave (undefined), e "Feriados: fechado" não deveria aparecer do nada
  // pra quem nunca foi perguntado sobre isso.
  if (horario.feriados !== undefined) partes.push(`Feriados ${fmt(horario.feriados)}`);
  return partes.join(' · ');
}

// "Está aberto agora?" (revisão final da Visão Geral, 23/09/2026) — não
// existia: até aqui `horario_semanal` só alimentava texto (`resumo`), nunca
// entrou em cálculo nenhum. `null`/objeto sem a chave do dia devolve `null`
// ("não dá pra saber" — ponto sem horário cadastrado), não `false`, porque
// quem chama trata "não sei" como "deveria estar online" (mesma suposição de
// sempre, antes de existir este cálculo). Dia/hora sempre lidos na wall-clock
// de Matão (`relogioEmMatao`), nunca no fuso do processo — e feriado nacional
// usa `horario.feriados` (quando informado) em vez do dia da semana.
// limite: janela que passa da meia-noite (ex. 18:00-02:00) só é reconhecida
// no dia em que COMEÇA — não olha o dia anterior. Cobre o caso pedido (tela
// além do horário do comércio, mesmo dia); virada de dia por instalação
// aberta a noite toda é caso raro o suficiente pra ficar de fora desta rodada.
function estaAbertoAgora(horario, agora = new Date()) {
  if (!horario) return null;
  const { dia, horas, minutos: minutoAtual } = relogioEmMatao(agora);
  // Feriado usa a chave própria só quando alguém de fato preencheu (mesma
  // regra do `resumo()` acima) — registro antigo sem "feriados" continua
  // pelo dia da semana normal, igual sempre foi.
  const chave = horario.feriados !== undefined && ehFeriadoNacional(agora) ? 'feriados' : dia;
  const janela = horario[chave];
  if (janela === undefined) return null;
  if (!janela) return false;
  const minutos = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const agoraMin = horas * 60 + minutoAtual;
  const abre = minutos(janela.abre);
  const fecha = minutos(janela.fecha);
  // `abre > fecha` = janela vira a noite (validado como caso legítimo em
  // `validar`, ex. bar 18:00-02:00) — aberto fora do intervalo [fecha,abre).
  return abre < fecha ? agoraMin >= abre && agoraMin < fecha : agoraMin >= abre || agoraMin < fecha;
}

module.exports = { DIAS, NOME_DIA, validar, resumo, estaAbertoAgora };
