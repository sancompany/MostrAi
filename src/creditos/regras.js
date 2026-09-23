// Regras do resgate de créditos por benefício (23/09/2026, reconstrução do
// painel da conta). Mesma escada de sempre (RN-43.1: 3→Essencial,
// 7→Pro, 10→Prime), agora estendida pros 4 ciclos que o plano comercial já
// usa — custo = limiar do tier × meses do período escolhido. A tabela
// abaixo é a MESMA coisa que a fórmula, só escrita por extenso: é o que
// aparece na tela, e número que o cliente vê tem que bater exatamente com
// o que está aqui, sem cálculo escondido.
//
//   ESSENCIAL   1 mês=3   3 meses=9    6 meses=18   12 meses=36
//   PRO         1 mês=7   3 meses=21   6 meses=42   12 meses=84
//   PRIME       1 mês=10  3 meses=30   6 meses=60   12 meses=120
const CUSTO_BASE_POR_MES = { essencial: 3, destaque: 7, maximo: 10 };
const CICLOS_VALIDOS = [1, 3, 6, 12];
const NOME_TIER = { essencial: 'Essencial', destaque: 'Pro', maximo: 'Prime' };

function custoDoBeneficio(tier, meses) {
  const base = CUSTO_BASE_POR_MES[tier];
  if (!base || !CICLOS_VALIDOS.includes(Number(meses))) return null;
  return base * Number(meses);
}

// Todas as 12 combinações tier×período, com o que falta pra cada uma —
// alimenta a expansão "Créditos e benefícios" no dashboard (as que já dá
// pra resgatar, e quanto falta pras outras — sem cadeado, sem gamificação).
function opcoesDisponiveis(saldoCreditos) {
  const opcoes = [];
  for (const tier of Object.keys(CUSTO_BASE_POR_MES)) {
    for (const meses of CICLOS_VALIDOS) {
      const custo = custoDoBeneficio(tier, meses);
      opcoes.push({
        tier,
        nomeTier: NOME_TIER[tier],
        meses,
        custo,
        disponivel: saldoCreditos >= custo,
        faltam: Math.max(0, custo - saldoCreditos),
      });
    }
  }
  return opcoes;
}

module.exports = { CUSTO_BASE_POR_MES, CICLOS_VALIDOS, NOME_TIER, custoDoBeneficio, opcoesDisponiveis };
