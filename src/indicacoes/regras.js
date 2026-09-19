// Limiar de créditos pra liberar o plano de anúncio de um tier acima
// (pedido do dono, 19/09/2026, especificação final depois de várias
// rodadas): 3 comerciantes indicados que pagaram libera o Essencial, 7
// libera o Pro (tier `destaque`), 10 libera o Prime (tier `maximo`).
// Constante em código, não em schema — mesmo padrão de
// MESES_PARA_FILA_DE_CREDITO em src/bancohoras/apuracao.js: só muda código
// se o dono decidir outro número, nunca migration.
const LIMIAR_ESSENCIAL = 3;
const LIMIAR_DESTAQUE = 7;
const LIMIAR_MAXIMO = 10;

// Tier mais alto que a contagem de créditos já garante, ou null se nem o
// primeiro limiar foi batido ainda. Nunca aponta pros planos de comodato
// (Inicial/Básico) — esses só vêm de troca de modalidade, não de crédito.
function tierElegivel(creditos) {
  if (creditos >= LIMIAR_MAXIMO) return 'maximo';
  if (creditos >= LIMIAR_DESTAQUE) return 'destaque';
  if (creditos >= LIMIAR_ESSENCIAL) return 'essencial';
  return null;
}

module.exports = { LIMIAR_ESSENCIAL, LIMIAR_DESTAQUE, LIMIAR_MAXIMO, tierElegivel };
