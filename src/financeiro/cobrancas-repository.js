const pool = require('../db/pool');

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function marcarNotaFiscal(id, { nota_fiscal_url, drive_file_id }) {
  const { rows } = await pool.query(
    `UPDATE cobrancas_confirmadas
     SET nota_fiscal_url = $2, drive_file_id = $3, nota_fiscal_status = 'emitida'
     WHERE id = $1 RETURNING *`,
    [id, nota_fiscal_url, drive_file_id],
  );
  return rows[0] || null;
}

module.exports = { buscarPorId, marcarNotaFiscal };
