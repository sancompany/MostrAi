const pool = require('../db/pool');

// Só o que dois cadastros precisam conferir antes de gravar: que o id de ramo
// que veio no corpo existe mesmo e ainda está ativo. Id inventado viraria erro
// de chave estrangeira (500 na cara de quem cadastra), e id de outra tabela
// viraria bloqueio de concorrente errado na playlist.
async function buscarAtivaPorId(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) return null;
  const { rows } = await pool.query('SELECT id, nome FROM categorias WHERE id = $1 AND ativo', [n]);
  return rows[0] || null;
}

module.exports = { buscarAtivaPorId };
