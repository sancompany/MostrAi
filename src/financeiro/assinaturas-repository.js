const { randomUUID } = require('node:crypto');
const pool = require('../db/pool');

async function criar({ anuncianteId, planoId }) {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO assinaturas (id, anunciante_id, plano_id) VALUES ($1,$2,$3) RETURNING *`,
    [id, anuncianteId, planoId]
  );
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM assinaturas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function marcarCancelada(id) {
  const { rows } = await pool.query(
    `UPDATE assinaturas SET status = 'cancelada' WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

async function buscarAtivaDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT * FROM assinaturas WHERE anunciante_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1`,
    [anuncianteId]
  );
  return rows[0] || null;
}

module.exports = { criar, buscarPorId, marcarCancelada, buscarAtivaDoAnunciante };
