const pool = require('../src/db/pool');

// Dívida de veiculação de um ciclo ANTIGO, já vencido e não entregue
// (migration 111): um lote do livro de junho de 2026 — antes de todas as
// horas que os testes usam (agosto de 2026 em diante), fixo pra não andar com
// o relógio do CI. É o
// equivalente, no modelo em que a obrigação nasce do ciclo, à linha de
// `banco_horas` de "mês anterior com saldo" que os testes antigos semeavam —
// todo o tempo do lote é atraso, e a camada T3 do gerador o devolve.
async function obrigacaoVencida(contaId, segundos, { planoId = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO obrigacoes_veiculacao (anunciante_id, tipo, chave, segundos, plano_id, inicio, fim, motivo, criado_em)
     VALUES ($1, 'ciclo', 'teste:' || gen_random_uuid(), $2, $3,
             '2026-06-01T03:00:00Z', '2026-07-01T03:00:00Z', 'teste: ciclo antigo não entregue',
             '2026-06-01T03:00:00Z')
     RETURNING *`,
    [contaId, segundos, planoId],
  );
  return rows[0];
}

module.exports = { obrigacaoVencida };
