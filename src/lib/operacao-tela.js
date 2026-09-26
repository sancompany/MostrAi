const { feriadosNacionais } = require('./horario-semanal');

// Horário de operação da tela — regra ÚNICA do backend para duas perguntas:
//   1. o que vai no bloco `operacao` de GET /player/:id/config
//      (docs/player-mvp-contract.md §6);
//   2. "esta tela deveria estar operando agora?" (saúde, alertas).
// As duas saem do mesmo objeto, e (2) repete a semântica que o contrato
// pede ao Player: o admin nunca chama de "Sem sinal" uma tela que o próprio
// Player apagou por horário, nem o contrário.
//
// Toda tela segue o horário do PONTO — não existe horário por tela. Ponto
// 24 h é um ponto com 00:00–24:00 (ou sem horário cadastrado).
//
// Semântica (contrato §6):
// - faixa HH:MM, início inclusivo, fim exclusivo; "24:00" = fim do dia;
//   fim < início cruza a meia-noite e a madrugada pertence à faixa do dia
//   em que começou;
// - sempre os 7 dias; lista vazia = fechado;
// - feriado substitui o dia inteiro, inclusive a madrugada da véspera;
// - faixas presentes e nenhuma legível = dia inteiro aceso ("na dúvida,
//   acende").
const TIMEZONE_PADRAO = 'America/Sao_Paulo';
const DIAS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'];
const DIA_DO_INTL = { Mon: 'seg', Tue: 'ter', Wed: 'qua', Thu: 'qui', Fri: 'sex', Sat: 'sab', Sun: 'dom' };
const DIA_DO_UTC = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const DIA_INTEIRO = [{ inicio: '00:00', fim: '24:00' }];

function timezoneValida(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// `horario_semanal` (src/lib/horario-semanal.js): por dia, `null` = fechado,
// `{abre, fecha}` = uma faixa, chave ausente (registro antigo) = "não
// informado", que o backend sempre tratou como "deveria estar online" — vira
// o dia inteiro aceso, para o Player não apagar o que ninguém mandou apagar.
function faixasDoDia(valor) {
  if (valor === undefined) return DIA_INTEIRO;
  if (valor === null) return [];
  return [{ inicio: valor.abre, fim: valor.fecha }];
}

function anoNoFuso(agora, timezone) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric' }).format(agora));
}

// Bloco `operacao` da config, materializado a partir do horário do ponto.
// limite: feriados nacionais do ano corrente e dos dois seguintes — uma tela
// que passe mais de dois anos sem nenhuma mudança de config fica sem os
// feriados do terceiro ano (o dia da semana normal vale). Qualquer mudança
// de margem, de horário do ponto ou do PIN remonta a lista.
function operacaoDoPonto(horarioDoPonto, agora = new Date()) {
  const timezone = TIMEZONE_PADRAO;
  const porDiaDaSemana = {};
  for (const dia of DIAS) porDiaDaSemana[dia] = horarioDoPonto ? faixasDoDia(horarioDoPonto[dia]) : DIA_INTEIRO;

  const feriados = {};
  if (horarioDoPonto && horarioDoPonto.feriados !== undefined) {
    const faixas = faixasDoDia(horarioDoPonto.feriados);
    const ano = anoNoFuso(agora, timezone);
    for (const a of [ano, ano + 1, ano + 2]) for (const data of feriadosNacionais(a)) feriados[data] = faixas;
  }
  return { timezone, porDiaDaSemana, feriados };
}

// ---------------------------------------------------------------------------
// Avaliação — a mesma regra que o contrato pede ao Player (§6)
// ---------------------------------------------------------------------------
function minutosDeTexto(texto) {
  if (typeof texto !== 'string') return null;
  const partes = texto.trim().split(':');
  if (partes.length < 2 || partes.length > 3) return null;
  const [hora, minuto, segundo = 0] = partes.map((p) => (/^\d+$/.test(p) ? Number(p) : Number.NaN));
  if (![hora, minuto, segundo].every(Number.isInteger)) return null;
  if (hora < 0 || hora > 24 || minuto < 0 || minuto > 59 || segundo < 0 || segundo > 59) return null;
  return hora * 60 + minuto;
}

function lerFaixas(lista) {
  if (!Array.isArray(lista)) return [];
  const faixas = [];
  for (const f of lista) {
    const inicio = minutosDeTexto(f?.inicio);
    const fim = minutosDeTexto(f?.fim);
    if (inicio == null || fim == null) continue;
    faixas.push({ inicio, fim });
  }
  if (!faixas.length && lista.length > 0) return [{ inicio: 0, fim: 24 * 60 }];
  return faixas;
}

const contem = (f, m) => (f.fim >= f.inicio ? m >= f.inicio && m < f.fim : m >= f.inicio || m < f.fim);
const cruza = (f) => f.fim < f.inicio;
const noDiaDeInicio = (f, m) => (cruza(f) ? m >= f.inicio : m >= f.inicio && m < f.fim);
const naMadrugadaSeguinte = (f, m) => cruza(f) && m < f.fim;

function relogio(agora, timezone) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .formatToParts(agora)
      .map((p) => [p.type, p.value]),
  );
  return {
    data: `${partes.year}-${partes.month}-${partes.day}`,
    dia: DIA_DO_INTL[partes.weekday],
    // `hour12:false` pode devolver "24" à meia-noite dependendo do ICU.
    minuto: (Number(partes.hour) % 24) * 60 + Number(partes.minute),
  };
}

function diaAnterior(data) {
  const d = new Date(`${data}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return { data: d.toISOString().slice(0, 10), dia: DIA_DO_UTC[d.getUTCDay()] };
}

function deveriaOperar(operacao, agora = new Date()) {
  if (!operacao) return true;
  const porDia = operacao.porDiaDaSemana || {};
  const feriados = operacao.feriados || {};
  if (!Object.keys(porDia).length && !Object.keys(feriados).length) return true;

  const zona = timezoneValida(operacao.timezone) ? operacao.timezone : TIMEZONE_PADRAO;
  const { data, dia, minuto } = relogio(agora, zona);
  if (feriados[data]) return lerFaixas(feriados[data]).some((f) => contem(f, minuto));

  const ontem = diaAnterior(data);
  const faixasOntem = lerFaixas(feriados[ontem.data] || porDia[ontem.dia]);
  return (
    lerFaixas(porDia[dia]).some((f) => noDiaDeInicio(f, minuto)) ||
    faixasOntem.some((f) => naMadrugadaSeguinte(f, minuto))
  );
}

module.exports = { TIMEZONE_PADRAO, operacaoDoPonto, deveriaOperar };
