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

// Ramo em texto → categoria do catálogo (consolidação, 24/09/2026). A
// candidatura guarda o ramo do comércio como texto (`segmento`); na hora de
// materializar o ponto, o texto vira `categoria_id` se bater com o nome ou
// com um apelido (`aliases`, migration 067) de uma categoria ativa. Sem
// correspondência devolve null e o chamador decide o que fazer.
async function buscarAtivaPorNomeOuApelido(texto, db = pool) {
  const t = String(texto || '')
    .trim()
    .toLowerCase();
  if (!t) return null;
  const { rows } = await db.query(
    `SELECT id, nome FROM categorias
      WHERE ativo AND (lower(nome) = $1 OR $1 = ANY (SELECT lower(a) FROM unnest(COALESCE(aliases, '{}')) a))
      ORDER BY (lower(nome) = $1) DESC, id LIMIT 1`,
    [t],
  );
  return rows[0] || null;
}

module.exports = { buscarAtivaPorId, buscarAtivaPorNomeOuApelido };
