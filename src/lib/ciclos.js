// Ciclo comercial — UMA linguagem pra plano pago e benefício por créditos
// (24/09/2026, ADR-018). O código canônico do ciclo no sistema é o número de
// meses (`planos.compromisso_meses`: 1, 3, 6, 12); o San Checkout recebe o
// equivalente dele (`CICLO_ASAAS` em financeiro/san-checkout.js). Nome
// visível é sempre um destes quatro — "Prime · Semestral", nunca
// "Prime · 6 meses". A duração em meses continua existindo como explicação
// secundária ("Período: 6 meses").
const NOME_CICLO = { 1: 'Mensal', 3: 'Trimestral', 6: 'Semestral', 12: 'Anual' };
const CICLOS_VALIDOS = [1, 3, 6, 12];

function nomeDoCiclo(meses) {
  return NOME_CICLO[Number(meses)] || `${meses} meses`;
}

function duracaoDoCiclo(meses) {
  const n = Number(meses);
  return n === 1 ? '1 mês' : `${n} meses`;
}

// Textos antigos do ledger ("Resgate: Prime · 6 meses") ganham o nome do
// ciclo na TELA — o registro gravado não muda. Só troca quando é
// inequívoco: o sufixo "· N mês/meses" com N em 1/3/6/12.
function comNomeDeCiclo(texto) {
  if (!texto) return texto;
  return String(texto).replace(/·\s*(1|3|6|12)\s+m(ê|e)s(es)?\s*$/i, (_m, n) => `· ${NOME_CICLO[n]}`);
}

module.exports = { NOME_CICLO, CICLOS_VALIDOS, nomeDoCiclo, duracaoDoCiclo, comNomeDeCiclo };
