const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// CRUD trivial de 3 colunas — sem camada de repositório própria, o SQL cabe
// aqui. Categoria é o segmento do negócio: o anunciante diz o que vende, o
// ponto diz o que é, e a playlist usa isso pra não colocar concorrente
// dentro de concorrente (src/playlist/gerador.js).

// Pública — alimenta o seletor pesquisável dos cadastros (22/09/2026: ganhou
// grupo — só organização visual da lista — e aliases — só pra achar na busca,
// nenhum dos dois entra na regra de bloqueio, que continua comparando só
// categoria_id). `legado` nunca aparece aqui: categoria legada não sai mais
// pra quem está cadastrando agora (ver migration 067).
router.get('/categorias', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, grupo, aliases FROM categorias WHERE ativo AND NOT legado ORDER BY grupo, nome',
  );
  res.json(rows);
});

router.get('/admin/categorias', async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM categorias ORDER BY nome');
  res.json(rows);
});

router.post('/admin/categorias', async (req, res) => {
  const { nome, grupo } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  const aliases = Array.isArray(req.body.aliases) ? req.body.aliases.filter(Boolean) : [];
  try {
    const { rows } = await pool.query('INSERT INTO categorias (nome, grupo, aliases) VALUES ($1, $2, $3) RETURNING *', [
      nome,
      grupo || null,
      aliases,
    ]);
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe uma categoria com esse nome' });
    throw err;
  }
});

router.patch('/admin/categorias/:id', async (req, res) => {
  const campos = ['nome', 'ativo', 'grupo', 'aliases', 'legado'].filter((c) => req.body[c] !== undefined);
  if (!campos.length) return res.status(400).json({ erro: 'nada pra atualizar' });
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => (c === 'aliases' ? req.body[c].filter(Boolean) : req.body[c]));
  try {
    const { rows } = await pool.query(`UPDATE categorias SET ${sets} WHERE id = $1 RETURNING *`, [
      req.params.id,
      ...valores,
    ]);
    res.json(rows[0] || null);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe uma categoria com esse nome' });
    throw err;
  }
});

// Excluir categoria em uso quebraria a FK dos cadastros já feitos — nesse
// caso o certo é desativar (some dos selects, quem já está fica no lugar).
router.delete('/admin/categorias/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM categorias WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ erro: 'categoria em uso por alguém cadastrado — desative em vez de excluir' });
    }
    throw err;
  }
});

module.exports = router;
