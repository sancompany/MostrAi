const pool = require('../db/pool');
const { confirmarExecucao } = require('./gerador');

// Deduplicação do proof-of-play em lote (contrato novo, migration 065). Ver
// `docs/PENDENCIAS.md` seção H pro porquê deste ledger existir separado de
// `exibicoes_contador` (que é agregado por hora, não por execução).
//
// Reserva o `execucaoId` e credita NA MESMA TRANSAÇÃO — reservar primeiro e
// creditar depois deixaria uma janela onde um crash no meio grava "já visto"
// sem ter creditado nada, e a retentativa (que é o próprio motivo do
// `execucaoId` existir) nunca mais credita essa exibição de verdade.
// `ON CONFLICT DO NOTHING` na reserva é a trava: duas chamadas com o mesmo
// `execucaoId` (retentativa do aparelho depois de resposta perdida) só a
// primeira reserva — a segunda vê a linha já lá e devolve `duplicado` sem
// tocar em `exibicoes_contador` de novo.
async function confirmarComDedup(dispositivoId, evento, agora) {
  const { execucaoId, itemProgramacaoId, janelaId } = evento || {};
  if (!execucaoId || !itemProgramacaoId || !janelaId) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reserva = await client.query(
      `INSERT INTO execucoes_confirmadas (execucao_id, dispositivo_id, status)
       VALUES ($1, $2, 'pendente') ON CONFLICT (execucao_id) DO NOTHING
       RETURNING execucao_id`,
      [execucaoId, dispositivoId],
    );
    if (!reserva.rows[0]) {
      await client.query('COMMIT');
      return { execucaoId, status: 'duplicado' };
    }

    const status = await confirmarExecucao(dispositivoId, itemProgramacaoId, janelaId, agora, client);
    await client.query('UPDATE execucoes_confirmadas SET status = $2 WHERE execucao_id = $1', [execucaoId, status]);
    await client.query('COMMIT');
    return { execucaoId, status };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = { confirmarComDedup };
