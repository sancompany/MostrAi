// Número de cada ingresso dentro do pedido ("Ingresso 2 de 4"), pedido do
// dono de 10/11/2026. Não é guardado: sai da ordem do item no pedido
// (pedido_itens.ordem) e da posição da vaga nele (reservas.posicao), que são
// gravadas na criação do pedido e não mudam depois — o mesmo número na conta,
// na página do pedido e na portaria, por mais que a lista seja reordenada ou
// que um ingresso seja cancelado. Não é o número do lote. Cortesia (sem
// pedido) fica sem número.
//
// `alias` é o nome da tabela `ingressos` na consulta que usa os trechos.
const numeroDoIngresso = (alias = 'i') => `
  (SELECT count(*)::int
     FROM reservas r_ JOIN pedido_itens pi_ ON pi_.id = r_.pedido_item_id,
          reservas re_ JOIN pedido_itens pe_ ON pe_.id = re_.pedido_item_id
    WHERE re_.id = ${alias}.reserva_id AND r_.pedido_id = re_.pedido_id
      AND (pi_.ordem, r_.posicao) <= (pe_.ordem, re_.posicao))`;

const ingressosDoPedido = (alias = 'i') => `
  (SELECT count(*)::int FROM reservas rt_ WHERE ${alias}.reserva_id IS NOT NULL AND rt_.pedido_id = ${alias}.pedido_id)`;

// `numero` e `numero_de` prontos para o SELECT; nulos na cortesia.
const colunasDeNumero = (alias = 'i') =>
  `CASE WHEN ${alias}.reserva_id IS NULL THEN NULL ELSE ${numeroDoIngresso(alias)} END AS numero,
   CASE WHEN ${alias}.reserva_id IS NULL THEN NULL ELSE ${ingressosDoPedido(alias)} END AS numero_de`;

module.exports = { colunasDeNumero };
