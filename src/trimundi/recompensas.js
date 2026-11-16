const { consultar } = require('./db/conexao');

// Admin → Eventos → Recompensas (§9; decisões do dono de 14/11/2026, itens A
// e H): o que foi conquistado na edição e o que já saiu, num lugar só.
//   · recompensas de indicação, uma a uma — concedida (a retirar), entregue
//     (quando e por quem: operador pelo nome, ou "Admin") ou revogada
//     (indicação reembolsada antes da entrega; fica no histórico);
//   · benefícios dos ingressos (copão, open bar...), por benefício: quantos
//     ingressos válidos têm, quantos já retiraram e quantos faltam.
// Só leitura: a entrega continua pelos caminhos de sempre (portaria, ou
// "Marcar entregue" do Admin para a recompensa de indicação).

const quemEntregou = (coluna) => `CASE WHEN ${coluna} IS NULL THEN NULL
  WHEN ${coluna} LIKE 'operador:%' THEN (SELECT nome FROM operadores WHERE 'operador:' || operadores.id = ${coluna})
  ELSE 'Admin' END`;

// A lista mostra até LIMITE_ITENS recompensas (as a retirar primeiro); os
// totais saem de uma contagem à parte, sem limite — nunca da lista cortada.
const LIMITE_ITENS = 1000;

async function daEdicao(edicaoId, { limite = LIMITE_ITENS } = {}) {
  const [{ rows: indicacao }, { rows: beneficios }, { rows: totais }] = await Promise.all([
    consultar(
      `SELECT r.id, r.status, r.concedida_em, r.entregue_em, r.revogada_em, ${quemEntregou('r.entregue_por')} AS entregue_por,
              ca.nome AS campanha, ca.recompensa,
              COALESCE(cl.nome, o.nome, '(anonimizado)') AS indicador,
              CASE WHEN i.operador_id IS NOT NULL THEN 'operador' ELSE 'cliente' END AS tipo
         FROM recompensas_indicacao r
         JOIN campanhas_indicacao ca ON ca.id = r.campanha_id
         JOIN indicadores i ON i.id = r.indicador_id
         LEFT JOIN clientes cl ON cl.id = i.cliente_id LEFT JOIN operadores o ON o.id = i.operador_id
        WHERE ca.edicao_id = $1
        ORDER BY (r.status = 'concedida') DESC, r.concedida_em DESC, r.id DESC
        LIMIT $2`,
      [edicaoId, limite],
    ),
    consultar(
      `SELECT ib.beneficio_id AS id, min(ib.nome) AS nome,
              count(*)::int AS total,
              count(*) FILTER (WHERE ib.resgatado_em IS NOT NULL)::int AS entregues
         FROM ingresso_beneficios ib JOIN ingressos i ON i.id = ib.ingresso_id
         LEFT JOIN pedidos p ON p.id = i.pedido_id
        WHERE i.edicao_id = $1 AND i.status <> 'cancelado' AND (p.id IS NULL OR p.origem = 'venda')
        GROUP BY ib.beneficio_id
        ORDER BY min(ib.nome)`,
      [edicaoId],
    ),
    consultar(
      `SELECT count(*) FILTER (WHERE r.status = 'concedida')::int AS a_retirar,
              count(*) FILTER (WHERE r.status = 'entregue')::int AS entregues,
              count(*) FILTER (WHERE r.status = 'revogada')::int AS revogadas,
              count(*)::int AS total
         FROM recompensas_indicacao r JOIN campanhas_indicacao ca ON ca.id = r.campanha_id
        WHERE ca.edicao_id = $1`,
      [edicaoId],
    ),
  ]);
  // Onde a recompensa sai (decisão do dono, 15/11/2026): a do cliente, na
  // portaria (ingresso principal) ou pelo Admin; a do operador indicador —
  // ingresso dele é cortesia, sem pedido — só pelo Admin.
  for (const r of indicacao) r.entrega = r.tipo === 'operador' ? 'so_admin' : 'portaria_ou_admin';
  return {
    indicacao: {
      totais: { a_retirar: totais[0].a_retirar, entregues: totais[0].entregues, revogadas: totais[0].revogadas },
      itens: indicacao,
      // A lista foi cortada: há mais recompensas do que as mostradas.
      itens_cortados: totais[0].total > indicacao.length,
    },
    beneficios: beneficios.map((b) => ({ ...b, pendentes: b.total - b.entregues })),
  };
}

module.exports = { daEdicao };
