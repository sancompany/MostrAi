// Vigência de cobertura — a régua única (consolidação final, 24/09/2026).
//
// `anunciantes.data_expiracao` é `date` (o pool devolve texto 'AAAA-MM-DD').
// O ÚLTIMO DIA É INCLUSIVO, no relógio de Matão (America/Sao_Paulo — D1 da
// rodada de 24/09/2026): quem tem cobertura até 30/09 roda o dia 30 inteiro
// e sai do ar à meia-noite de Matão. Antes desta régua cada lugar comparava
// de um jeito: `new Date('2026-09-30') >= agora` vence às 00:00 UTC (21:00
// de Matão do dia 29 — 27 horas antes), `>= current_date` vence às 00:00 UTC
// do dia 30 (21:00 de Matão do dia 29 ainda vale, 21:00–24:00 não), e o
// admin/conciliação comparavam por dia. Quem decide vigência usa daqui:
// `coberturaVigente` no JS e `vigenteSql` no SQL — nunca `new Date(date)`.
const { FUSO } = require('./fuso-comercial');

// 'en-CA' formata como AAAA-MM-DD.
const diaEmMatao = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Hoje, em Matão, como 'AAAA-MM-DD'.
function hojeComercial(agora = new Date()) {
  return diaEmMatao.format(agora);
}

// O dia de uma coluna `date` como 'AAAA-MM-DD'. Texto (o normal) passa como
// veio; `Date` (linha montada em JS ou coluna sem o parser de texto) é lido
// como o dia UTC, que é como o pg serializa um `date` — não como instante.
function diaTexto(valor) {
  if (!valor) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor).slice(0, 10);
}

// Cobertura sem data (plano sem vencimento) é vigente; com data, vale até o
// fim do dia gravado, em Matão.
function coberturaVigente(dataExpiracao, agora = new Date()) {
  const dia = diaTexto(dataExpiracao);
  return !dia || dia >= hojeComercial(agora);
}

// Só é "vencida" quem TEM data e ela já passou — sem data não é vencida.
function coberturaVencida(dataExpiracao, agora = new Date()) {
  return !!diaTexto(dataExpiracao) && !coberturaVigente(dataExpiracao, agora);
}

// Dias inteiros de hoje (Matão) até o dia gravado: 0 = vence hoje, 1 = vence
// amanhã, negativo = já venceu.
function diasAteVencer(dataExpiracao, agora = new Date()) {
  const dia = diaTexto(dataExpiracao);
  if (!dia) return null;
  return Math.round((Date.UTC(...partes(dia)) - Date.UTC(...partes(hojeComercial(agora)))) / 86400000);
}

function partes(dia) {
  const [a, m, d] = dia.split('-').map(Number);
  return [a, m - 1, d];
}

// Aritmética em dias sobre 'AAAA-MM-DD' (UTC por baixo, só pra não escorregar
// um dia no fuso do processo).
function somarDias(dataISO, dias) {
  const base = new Date(`${diaTexto(dataISO)}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + Number(dias));
  return base.toISOString().slice(0, 10);
}

// A mesma régua no SQL: "hoje" é o dia de Matão, e a comparação é por dia.
const HOJE_SQL = "(now() AT TIME ZONE 'America/Sao_Paulo')::date";
const vigenteSql = (coluna) => `(${coluna} IS NULL OR ${coluna} >= ${HOJE_SQL})`;
const vencidaSql = (coluna) => `(${coluna} IS NOT NULL AND ${coluna} < ${HOJE_SQL})`;

module.exports = {
  hojeComercial,
  diaTexto,
  coberturaVigente,
  coberturaVencida,
  diasAteVencer,
  somarDias,
  HOJE_SQL,
  vigenteSql,
  vencidaSql,
};
