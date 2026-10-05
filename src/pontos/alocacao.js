const { instanteComercial, paredeComercial, FUSO } = require('../lib/fuso-comercial');
const horarioSemanal = require('../lib/horario-semanal');
const { operacaoDoPonto, deveriaOperar } = require('../lib/operacao-tela');

// ALOCAÇÃO DO PONTO MÓVEL (migration 114). O móvel é equipamento, não
// estabelecimento: só tem local, contexto e horário enquanto está ALOCADO —
// uma hospedagem ou um evento, com período (data E hora, no relógio de
// Matão) e o horário de funcionamento que o Admin define para aquele
// período. Este módulo é a régua única de período e horário das duas:
//   · período: [inicio, fim) — instantes; `data_inicio`/`data_fim` (colunas
//     antigas) são derivadas daqui;
//   · horário: o formato de `pontos.horario_semanal` (o mesmo que vira
//     `config.operacao` para a TV — docs/player-mvp-contract.md §6). 24 h é
//     00:00–24:00 escolhido explicitamente; nunca é o padrão;
//   · tempo válido: o que a tela comprovou ∩ o período ∩ o horário.

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

const H24 = { abre: '00:00', fecha: '24:00' };
const HORARIO_24H = Object.fromEntries(horarioSemanal.DIAS.map((d) => [d, H24]));
// Período máximo de uma alocação: o equipamento circula — uma hospedagem
// de meses seria outro produto.
const DURACAO_MAXIMA_MS = 120 * 24 * 3600 * 1000;

// "2026-10-10" (data) → dia em Matão.
const diaEmMatao = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dataEmMatao = (instante) => diaEmMatao.format(new Date(instante));

// Período a partir do corpo: `inicio`/`fim` ("2026-10-10T08:00", parede de
// Matão, ou instante com fuso). Compatível com o formato antigo
// (`data_inicio`/`data_fim`, dias inteiros): início às 00:00 do primeiro dia,
// fim às 00:00 do dia seguinte ao último.
function lerPeriodo(corpo, { agora = new Date(), exigirFuturo = true } = {}) {
  let inicio;
  let fim;
  if (corpo?.inicio !== undefined || corpo?.fim !== undefined) {
    inicio = instanteComercial(corpo?.inicio, { campo: 'Início' });
    fim = instanteComercial(corpo?.fim, { campo: 'Fim' });
  } else if (corpo?.data_inicio !== undefined) {
    inicio = instanteComercial(soData(corpo.data_inicio, 'data_inicio', 'Início'), { campo: 'Início' });
    const ultimoDia = corpo?.data_fim ? soData(corpo.data_fim, 'data_fim', 'Fim') : corpo.data_inicio;
    const fimDoDia = instanteComercial(ultimoDia, { campo: 'Fim', fim: true });
    fim = fimDoDia ? new Date(fimDoDia.getTime() + 1) : null;
  }
  if (!inicio) throw erro(400, 'Início: informe data e hora', 'inicio');
  if (!fim) throw erro(400, 'Fim: informe data e hora', 'fim');
  if (fim <= inicio) throw erro(400, 'O fim vem antes do início', 'fim');
  if (fim - inicio > DURACAO_MAXIMA_MS) throw erro(400, 'Período longo demais (máximo de 120 dias)', 'fim');
  if (exigirFuturo && fim <= agora) {
    throw erro(400, 'Esse período já terminou — programe só o que ainda vai acontecer', 'fim');
  }
  return { inicio, fim, ...datasDoPeriodo(inicio, fim) };
}

function soData(valor, campo, rotulo) {
  const v = typeof valor === 'string' ? valor.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw erro(400, `${rotulo}: data inválida`, campo);
  return v;
}

// As colunas antigas (date): o dia do início e o dia do último instante.
function datasDoPeriodo(inicio, fim) {
  return { dataInicio: dataEmMatao(inicio), dataFim: dataEmMatao(new Date(new Date(fim).getTime() - 1)) };
}

// Horário de funcionamento da alocação: obrigatório (o Admin define; nunca
// "24 h automático"). `'24h'` é o atalho explícito para todos os dias
// 00:00–24:00. Pelo menos um dia aberto.
function lerHorario(valor, { obrigatorio = true } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw erro(400, 'Horário de funcionamento: defina os dias e horários', 'horario_operacao');
    return null;
  }
  if (valor === '24h') return { ...HORARIO_24H };
  let horario;
  try {
    horario = horarioSemanal.validar(valor);
  } catch (e) {
    throw erro(400, `Horário de funcionamento: ${e.message}`, 'horario_operacao');
  }
  if (!horarioSemanal.DIAS.some((d) => horario[d])) {
    throw erro(400, 'Horário de funcionamento: abra pelo menos um dia', 'horario_operacao');
  }
  return horario;
}

// Os trechos de [de, ate) em que o horário está aberto, em ms. Sem horário
// (linha antiga, anterior à 114) = o trecho inteiro. A régua é a mesma da TV
// e da saúde da tela (`deveriaOperar`), avaliada minuto a minuto — horários
// têm resolução de minuto, então o resultado é exato.
function intervalosAbertos(horario, de, ate) {
  const inicio = new Date(de).getTime();
  const fim = new Date(ate).getTime();
  if (!(fim > inicio)) return [];
  if (!horario) return [[inicio, fim]];
  const operacao = operacaoDoPonto(horario, new Date(inicio));
  const MIN = 60_000;
  const saida = [];
  let aberto = null;
  for (let t = Math.floor(inicio / MIN) * MIN; t < fim; t += MIN) {
    const ok = deveriaOperar(operacao, new Date(t));
    const a = Math.max(t, inicio);
    const b = Math.min(t + MIN, fim);
    if (ok) {
      if (aberto && aberto[1] === a) aberto[1] = b;
      else {
        aberto = [a, b];
        saida.push(aberto);
      }
    }
  }
  return saida;
}

// Interseção de duas listas de intervalos [a, b) ordenadas e sem sobreposição.
function intersectar(xs, ys) {
  const saida = [];
  let i = 0;
  let j = 0;
  while (i < xs.length && j < ys.length) {
    const a = Math.max(xs[i][0], ys[j][0]);
    const b = Math.min(xs[i][1], ys[j][1]);
    if (b > a) saida.push([a, b]);
    if (xs[i][1] < ys[j][1]) i += 1;
    else j += 1;
  }
  return saida;
}

const somaSegundos = (intervalos) => Math.floor(intervalos.reduce((t, [a, b]) => t + (b - a), 0) / 1000);

// Para o formulário: o instante como "2026-10-10T08:00" de Matão.
const parede = (instante) => paredeComercial(instante);

module.exports = {
  HORARIO_24H,
  lerPeriodo,
  datasDoPeriodo,
  lerHorario,
  intervalosAbertos,
  intersectar,
  somaSegundos,
  parede,
  dataEmMatao,
};
