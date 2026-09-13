const pool = require('../db/pool');

const STATUS = ['pendente', 'aprovado', 'reprovado'];

const CAMPOS_ATUALIZAVEIS = ['status', 'arquivo_normalizado_url', 'thumbnail_url', 'editado_pelo_operador'];

async function criar(dados) {
  const { rows } = await pool.query(
    `INSERT INTO criativos
       (anunciante_id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url, duracao_segundos)
     VALUES ($1,$2,$3,$4,$5)
     RETURNING *`,
    [dados.anunciante_id, dados.arquivo_original_url, dados.arquivo_normalizado_url,
      dados.thumbnail_url, dados.duracao_segundos]
  );
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM criativos WHERE id = $1', [id]);
  return rows[0] || null;
}

// Conta pra aplicar o limite de criativos do plano (não conta reprovado —
// reprovado não ocupa a cota, ver src/anunciantes/routes.js).
async function contarNaoReprovados(anuncianteId) {
  const { rows } = await pool.query(
    "SELECT COUNT(*)::int AS total FROM criativos WHERE anunciante_id = $1 AND status != 'reprovado'",
    [anuncianteId]
  );
  return rows[0].total;
}

async function listarPorAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    'SELECT * FROM criativos WHERE anunciante_id = $1 ORDER BY created_at DESC',
    [anuncianteId]
  );
  return rows;
}

async function listarPorStatus(status) {
  const { rows } = await pool.query(
    'SELECT * FROM criativos WHERE status = $1 ORDER BY created_at ASC',
    [status]
  );
  return rows;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => dados[c]);
  const { rows } = await pool.query(
    `UPDATE criativos SET ${sets} WHERE id = $1 RETURNING *`,
    [id, ...valores]
  );
  return rows[0] || null;
}

async function deletar(id) {
  await pool.query('DELETE FROM criativos WHERE id = $1', [id]);
}

module.exports = { criar, buscarPorId, listarPorAnunciante, listarPorStatus, atualizar, deletar, contarNaoReprovados, STATUS };
