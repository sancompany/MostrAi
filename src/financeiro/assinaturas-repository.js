const { randomUUID } = require('node:crypto');
const pool = require('../db/pool');

async function criar({ anuncianteId, planoId, status }) {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO assinaturas (id, anunciante_id, plano_id, status)
     VALUES ($1,$2,$3, COALESCE($4, 'ativa')) RETURNING *`,
    [id, anuncianteId, planoId, status || null],
  );
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM assinaturas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function marcarCancelada(id) {
  const { rows } = await pool.query(`UPDATE assinaturas SET status = 'cancelada' WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

// Troca de plano pelo Checkout (migration 056): a linha nova nasce
// 'pendente_troca' — só existe pra o Checkout ler o plano de destino antes
// de cobrar o acerto (ver montarRespostaPlano). 'excluir' desfaz uma
// tentativa que o Checkout recusou (nunca existiu de verdade pro
// anunciante); 'marcarTrocada'/'marcarAtiva' são o par que acontece junto,
// só depois de a troca confirmar.
async function excluir(id) {
  await pool.query(`DELETE FROM assinaturas WHERE id = $1 AND status = 'pendente_troca'`, [id]);
}

async function marcarTrocada(id, db = pool) {
  const { rows } = await db.query(`UPDATE assinaturas SET status = 'trocada' WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

async function marcarAtiva(id, db = pool) {
  const { rows } = await db.query(
    `UPDATE assinaturas SET status = 'ativa' WHERE id = $1 AND status = 'pendente_troca' RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

async function buscarAtivaDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT * FROM assinaturas WHERE anunciante_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1`,
    [anuncianteId],
  );
  return rows[0] || null;
}

module.exports = {
  criar,
  buscarPorId,
  marcarCancelada,
  excluir,
  marcarTrocada,
  marcarAtiva,
  buscarAtivaDoAnunciante,
};
