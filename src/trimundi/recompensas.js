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

async function daEdicao(edicaoId) {
  const [{ rows: indicacao }, { rows: beneficios }] = await Promise.all([
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
        LIMIT 1000`,
      [edicaoId],
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
  ]);
  const conta = (s) => indicacao.filter((r) => r.status === s).length;
  return {
    indicacao: {
      totais: { a_retirar: conta('concedida'), entregues: conta('entregue'), revogadas: conta('revogada') },
      itens: indicacao,
    },
    beneficios: beneficios.map((b) => ({ ...b, pendentes: b.total - b.entregues })),
  };
}

module.exports = { daEdicao };
