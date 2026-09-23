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
// sempre, antes de existir este cálculo).
// limite: janela que passa da meia-noite (ex. 18:00-02:00) só é reconhecida
// no dia em que COMEÇA — não olha o dia anterior. Cobre o caso pedido (tela
// além do horário do comércio, mesmo dia); virada de dia por instalação
// aberta a noite toda é caso raro o suficiente pra ficar de fora desta rodada.
function estaAbertoAgora(horario, agora = new Date()) {
  if (!horario) return null;
  const chave = DIAS[agora.getDay() === 0 ? 6 : agora.getDay() - 1]; // getDay(): 0=domingo
  const janela = horario[chave];
  if (janela === undefined) return null;
  if (!janela) return false;
  const minutos = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
  };
  const agoraMin = agora.getHours() * 60 + agora.getMinutes();
  const abre = minutos(janela.abre);
  const fecha = minutos(janela.fecha);
  // `abre > fecha` = janela vira a noite (validado como caso legítimo em
  // `validar`, ex. bar 18:00-02:00) — aberto fora do intervalo [fecha,abre).
  return abre < fecha ? agoraMin >= abre && agoraMin < fecha : agoraMin >= abre || agoraMin < fecha;
}

module.exports = { DIAS, NOME_DIA, validar, resumo, estaAbertoAgora };
