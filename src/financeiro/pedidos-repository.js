const crypto = require('node:crypto');
const pool = require('../db/pool');

// Id imprevisível (API.md do Checkout, seção 4.1.1): a rota GET /pedido/:id
// é pública por necessidade — o comprador chega antes de qualquer login —
// e um id sequencial deixaria qualquer um varrer /pedido/1, /pedido/2...
async function criar({ anuncianteId, tipo, planoAtualId, planoNovoId, valor, descricao }) {
  const id = crypto.randomBytes(24).toString('hex');
  const { rows } = await pool.query(
    `INSERT INTO pedidos_avulsos (id, anunciante_id, tipo, plano_atual_id, plano_novo_id, valor, descricao)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [id, anuncianteId, tipo, planoAtualId, planoNovoId, valor, descricao],
  );
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM pedidos_avulsos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function marcarPago(id) {
  const { rows } = await pool.query(
    `UPDATE pedidos_avulsos SET status = 'pago', pago_em = now() WHERE id = $1 RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

async function marcarCancelado(id) {
  const { rows } = await pool.query(`UPDATE pedidos_avulsos SET status = 'cancelado' WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

module.exports = { criar, buscarPorId, marcarPago, marcarCancelado };
