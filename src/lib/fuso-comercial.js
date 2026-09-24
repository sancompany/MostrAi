// Data e hora comercial digitada no admin: sempre no relógio de Matão.
//
// Por que existe (D3 da rodada de 24/09/2026): o `<input type="datetime-local">`
// manda "2026-10-31T23:59" — parede, sem fuso. A promoção ia assim direto
// pro Postgres, cuja sessão roda em UTC, e virava 23:59 de LONDRES: a
// pré-venda "até 31/10 23:59" encerrava às 20:59 de Matão, três horas antes
// do combinado. A mídia própria errava do outro lado: o navegador convertia
// certo na ida, mas o formulário relia o valor em UTC, e cada "salvar" sem
// mexer na data empurrava o período três horas pra frente.
//
// A regra agora é uma só, no servidor, pros dois: horário sem fuso é horário
// de São Paulo, convertido aqui de forma explícita — não depende do fuso do
// processo, do banco, nem do navegador de quem está no admin. Valor que já
// traz fuso (`Z`, `-03:00`) é um instante e passa como veio.
//
// Fim de janela é INCLUSIVO no minuto: "termina 31/10 23:59" vale até
// 23:59:59,999. É o que o admin lê no campo e o que o site promete ("até
// 31/10/2026"); as consultas de vigência já comparam `fim >= now()`.
const FUSO = 'America/Sao_Paulo';

const PAREDE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?)?$/;
const COM_FUSO = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const relogio = new Intl.DateTimeFormat('en-US', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function paredeEm(instanteMs) {
  const p = {};
  for (const parte of relogio.formatToParts(new Date(instanteMs))) {
    if (parte.type !== 'literal') p[parte.type] = Number(parte.value);
  }
  return p;
}

// Quanto São Paulo está à frente (negativo: atrás) de UTC naquele instante,
// em ms. O Brasil não tem horário de verão desde 2019, mas a conta não
// presume isso: a tabela de fusos da plataforma é quem responde.
function deslocamento(instanteMs) {
  const p = paredeEm(instanteMs);
  const comoUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return comoUTC - Math.floor(instanteMs / 1000) * 1000;
}

function invalida(campo) {
  return Object.assign(new Error(`${campo}: data e hora inválidas`), { status: 400 });
}

// Converte o valor de um campo de data comercial num `Date` (ou null).
// `fim: true` estende o minuto (ou o dia, se veio só a data) até o último
// milissegundo, pra janela valer até o fim do horário escrito.
function instanteComercial(valor, { campo = 'data', fim = false } = {}) {
  if (valor === undefined) return undefined;
  if (valor === null || valor === '') return null;
  if (valor instanceof Date) {
    if (Number.isNaN(valor.getTime())) throw invalida(campo);
    return valor;
  }
  const texto = String(valor).trim();
  if (!texto) return null;

  if (COM_FUSO.test(texto)) {
    const d = new Date(texto);
    if (Number.isNaN(d.getTime())) throw invalida(campo);
    return d;
  }

  const m = PAREDE.exec(texto);
  if (!m) throw invalida(campo);
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const soData = m[4] === undefined;
  const hora = soData ? 0 : Number(m[4]);
  const minuto = soData ? 0 : Number(m[5]);
  const segundo = m[6] === undefined ? 0 : Number(m[6]);

  const paredeMs = Date.UTC(ano, mes - 1, dia, hora, minuto, segundo);
  // Rejeita 31/02, 24:00 e afins: o Date.UTC "conserta" sozinho e a data
  // salva seria outra.
  const conferida = new Date(paredeMs);
  if (
    conferida.getUTCFullYear() !== ano ||
    conferida.getUTCMonth() !== mes - 1 ||
    conferida.getUTCDate() !== dia ||
    conferida.getUTCHours() !== hora ||
    conferida.getUTCMinutes() !== minuto
  ) {
    throw invalida(campo);
  }

  // Duas passadas: o deslocamento é o do instante resultante, não o da
  // parede lida como UTC (só difere perto de mudança de fuso).
  let instante = paredeMs - deslocamento(paredeMs);
  const segundaPassada = paredeMs - deslocamento(instante);
  if (segundaPassada !== instante) instante = segundaPassada;

  if (fim) {
    if (soData) instante += 24 * 60 * 60 * 1000 - 1;
    else if (m[6] === undefined) instante += 60 * 1000 - 1;
  }
  return new Date(instante);
}

// O inverso, pro formulário do admin e pra testes: o instante como parede de
// São Paulo no formato do `datetime-local` ("2026-10-31T23:59").
function paredeComercial(valor) {
  if (!valor) return '';
  const d = new Date(valor);
  if (Number.isNaN(d.getTime())) return '';
  const p = paredeEm(d.getTime());
  const dois = (n) => String(n).padStart(2, '0');
  return `${p.year}-${dois(p.month)}-${dois(p.day)}T${dois(p.hour)}:${dois(p.minute)}`;
}

module.exports = { FUSO, instanteComercial, paredeComercial };
