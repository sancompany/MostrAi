const pool = require('../db/pool');

const CAMPOS_ATUALIZAVEIS = ['texto', 'ordem', 'ativo'];

async function listar() {
  const { rows } = await pool.query('SELECT * FROM beneficios ORDER BY ordem, id');
  return rows;
}

async function criar({ texto, ordem }) {
  const { rows } = await pool.query('INSERT INTO beneficios (texto, ordem) VALUES ($1, $2) RETURNING *', [
    texto,
    ordem || 0,
  ]);
  return rows[0];
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return null;
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(`UPDATE beneficios SET ${sets} WHERE id = $1 RETURNING *`, [
    id,
    ...campos.map((c) => dados[c]),
  ]);
  return rows[0] || null;
}

// O vínculo com planos cai junto (ON DELETE CASCADE na migration 015).
async function excluir(id) {
  const { rowCount } = await pool.query('DELETE FROM beneficios WHERE id = $1', [id]);
  return rowCount > 0;
}

module.exports = { listar, criar, atualizar, excluir };
