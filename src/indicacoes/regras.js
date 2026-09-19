// Limiar de créditos pra liberar o plano de anúncio de um tier acima (pedido
// do dono, 19/09/2026): 3 comerciantes indicados que pagaram libera Destaque
// (Pro), 10 libera Máximo (Prime). Constante em código, não em schema —
// mesmo padrão de MESES_PARA_FILA_DE_CREDITO em src/bancohoras/apuracao.js:
// só muda código se o dono decidir outro número, nunca migration.
const LIMIAR_DESTAQUE = 3;
const LIMIAR_MAXIMO = 10;

// Tier mais alto que a contagem de créditos já garante, ou null se nem o
// primeiro limiar foi batido ainda.
function tierElegivel(creditos) {
  if (creditos >= LIMIAR_MAXIMO) return 'maximo';
  if (creditos >= LIMIAR_DESTAQUE) return 'destaque';
  return null;
}

module.exports = { LIMIAR_DESTAQUE, LIMIAR_MAXIMO, tierElegivel };
