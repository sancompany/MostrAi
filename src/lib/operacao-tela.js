const { feriadosNacionais } = require('./horario-semanal');

// Horário de operação da tela — regra ÚNICA do backend para "esta tela
// deveria estar operando agora?" (saúde, alertas, obrigação por minutos
// abertos, métricas). Desde 08/10/2026 o Player não apaga mais por horário:
// o bloco `operacao` de GET /player/:id/config (docs/player-mvp-contract.md
// §6) vai sempre como dia inteiro — `operacaoDoPonto(null)` — e o horário
// fica só como informação operacional/comercial (src/player/config.js).
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
const DIA_DO_UTC = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'];
const DIA_INTEIRO = [{ inicio: '00:00', fim: '24:00' }];

// Resposta guardada por fuso: construir um `Intl.DateTimeFormat` só pra
// validar custava ~80 µs por chamada de `deveriaOperar` (medido em
// 27/09/2026) — o grosso do tempo de somar 30 dias de horário aberto.
const fusosValidos = new Map();
function timezoneValida(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  if (!fusosValidos.has(tz)) {
    let ok = true;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
      ok = false;
    }
    if (fusosValidos.size > 1000) fusosValidos.clear();
    fusosValidos.set(tz, ok);
  }
  return fusosValidos.get(tz);
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

// Um formatador por fuso, reaproveitado: criar `Intl.DateTimeFormat` é caro,
// e as métricas da Mídia Mostraí (minutos abertos num período de 30 dias)
// avaliam milhares de instantes por ponto.
const formatadores = new Map();
function formatadorDo(timezone) {
  let f = formatadores.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    formatadores.set(timezone, f);
  }
  return f;
}

// Diferença do fuso pro UTC naquela hora, em ms. Uma chamada ao Intl por
// (fuso, hora UTC) em vez de uma por instante: avaliar 30 dias em fatias de
// 5 min eram ~8.600 `formatToParts` (650 ms por ponto, medido em
// 27/09/2026); agora são ~720.
// limite: supõe que o fuso só muda de deslocamento em hora cheia UTC —
// verdade pra America/Sao_Paulo (sem horário de verão desde 2019; as
// mudanças antigas eram à meia-noite local = 03:00/02:00 UTC). Um fuso com
// troca no meio da hora UTC erraria só os minutos dessa hora.
const HORA_MS = 3_600_000;
const deslocamentos = new Map();
function deslocamentoDoFuso(instanteMs, timezone) {
  const hora = Math.floor(instanteMs / HORA_MS) * HORA_MS;
  const chave = `${timezone}|${hora}`;
  let d = deslocamentos.get(chave);
  if (d === undefined) {
    const p = Object.fromEntries(
      formatadorDo(timezone)
        .formatToParts(new Date(hora))
        .map((x) => [x.type, x.value]),
    );
    // `hour12:false` pode devolver "24" à meia-noite dependendo do ICU.
    d = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute)) - hora;
    if (deslocamentos.size > 50_000) deslocamentos.clear();
    deslocamentos.set(chave, d);
  }
  return d;
}

function relogio(agora, timezone) {
  const local = new Date(agora.getTime() + deslocamentoDoFuso(agora.getTime(), timezone));
  return {
    data: local.toISOString().slice(0, 10),
    dia: DIA_DO_UTC[local.getUTCDay()],
    minuto: local.getUTCHours() * 60 + local.getUTCMinutes(),
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

// Quantos minutos o ponto opera em [de, ate) — a mesma régua de
// `deveriaOperar`, avaliada no meio de cada fatia de `passoMin` minutos.
// Usada pra "quanto a Mídia Mostraí DEVERIA ter tocado" (esperado), que não
// pode ser frequência × 24: fora do horário não se espera exibição (o que a
// TV ligada tocar ali é bônus).
// limite: resolução de 5 min — um horário que abre às 09:07 conta a fatia
// inteira de 09:05 ou nada; o erro é de no máximo uma fatia por borda.
const PASSO_PADRAO_MIN = 5;
function minutosOperando(operacao, de, ate, passoMin = PASSO_PADRAO_MIN) {
  const inicio = new Date(de).getTime();
  const fim = new Date(ate).getTime();
  if (!(fim > inicio)) return 0;
  const passo = passoMin * 60_000;
  let total = 0;
  for (let t = inicio; t < fim; t += passo) {
    const fatia = Math.min(passo, fim - t);
    if (deveriaOperar(operacao, new Date(t + fatia / 2))) total += fatia;
  }
  return total / 60_000;
}

module.exports = { TIMEZONE_PADRAO, operacaoDoPonto, deveriaOperar, minutosOperando };
