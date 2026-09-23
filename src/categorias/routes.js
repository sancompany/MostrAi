const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// CRUD trivial — sem camada de repositório própria, o SQL cabe aqui.
// Categoria é o segmento do negócio: o anunciante diz o que vende, o ponto
// diz o que é, e a playlist usa isso pra não colocar concorrente dentro de
// concorrente (src/playlist/gerador.js).
//
// Reconstrução de Contas + Categorias (23/09/2026): categoria passa a ter uma
// CANÔNICA (`canonica_id`, migration 074). Categoria absorvida por outra vira
// legado, some do cadastro e aponta pra que ficou — quem a usava foi
// reapontado junto. A regra de bloqueio continua comparando só categoria_id.

// Pública — alimenta o seletor pesquisável dos cadastros. Só a canônica
// ativa sai daqui. `aliases` vai junto porque a busca acontece no navegador
// ("dentista" acha "Odontologia"), mas nunca é mostrado; `grupo` é só
// organização do admin e não sai mais (Parte 45: o cliente vê só o nome).
router.get('/categorias', async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, nome, aliases FROM categorias WHERE ativo AND NOT legado ORDER BY nome',
  );
  res.json(rows);
});

// Admin — com o uso de cada uma (contas e pontos que apontam pra ela), pra
// tela decidir o que dá pra excluir e o que só dá pra tirar do cadastro. Duas
// contagens agrupadas por cima de ~250 linhas: barato o bastante pra ir junto.
router.get('/admin/categorias', async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, canon.nome AS canonica_nome,
            COALESCE(ua.total, 0)::int AS uso_contas,
            COALESCE(up.total, 0)::int AS uso_pontos
       FROM categorias c
       LEFT JOIN categorias canon ON canon.id = c.canonica_id
       LEFT JOIN (SELECT categoria_id, COUNT(*) AS total FROM anunciantes
                   WHERE categoria_id IS NOT NULL AND NOT conta_propria GROUP BY categoria_id) ua
              ON ua.categoria_id = c.id
       LEFT JOIN (SELECT categoria_id, COUNT(*) AS total FROM pontos
                   WHERE categoria_id IS NOT NULL GROUP BY categoria_id) up
              ON up.categoria_id = c.id
      ORDER BY c.nome`,
  );
  res.json(rows);
});

function limparAliases(lista) {
  if (!Array.isArray(lista)) return [];
  return [...new Set(lista.map((a) => String(a).trim()).filter(Boolean))];
}

router.post('/admin/categorias', async (req, res) => {
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ erro: 'nome obrigatório' });
  const grupo = String(req.body.grupo || '').trim() || null;
  const legado = req.body.legado === true;
  // Legado nunca aparece no cadastro — mesma regra da rota pública.
  const ativo = legado ? false : req.body.ativo !== false;
  try {
    const { rows } = await pool.query(
      'INSERT INTO categorias (nome, grupo, aliases, ativo, legado) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [nome, grupo, limparAliases(req.body.aliases), ativo, legado],
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe uma categoria com esse nome' });
    throw err;
  }
});

router.patch('/admin/categorias/:id', async (req, res) => {
  const corpo = { ...req.body };
  if (corpo.nome !== undefined) {
    corpo.nome = String(corpo.nome).trim();
    if (!corpo.nome) return res.status(400).json({ erro: 'nome obrigatório' });
  }
  if (corpo.grupo !== undefined) corpo.grupo = String(corpo.grupo || '').trim() || null;
  if (corpo.aliases !== undefined) corpo.aliases = limparAliases(corpo.aliases);
  if (corpo.legado === true) corpo.ativo = false;
  const campos = ['nome', 'ativo', 'grupo', 'aliases', 'legado'].filter((c) => corpo[c] !== undefined);
  if (!campos.length) return res.status(400).json({ erro: 'nada pra atualizar' });
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(`UPDATE categorias SET ${sets} WHERE id = $1 RETURNING *`, [
      req.params.id,
      ...campos.map((c) => corpo[c]),
    ]);
    if (!rows[0]) return res.status(404).json({ erro: 'categoria não encontrada' });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe uma categoria com esse nome' });
    throw err;
  }
});

// Mesclar (substitui o "Excluir" de categoria em uso): a mesma operação da
// migration 074, sob demanda — reaponta contas e pontos pra canônica, grava
// o mapeamento, tira a absorvida do cadastro e guarda o nome dela como alias.
// Tudo numa transação: ou a fusão inteira acontece, ou nada muda.
router.post('/admin/categorias/:id/mesclar', async (req, res) => {
  const origemId = Number(req.params.id);
  const destinoId = Number(req.body.destino_id);
  if (!Number.isInteger(origemId) || !Number.isInteger(destinoId)) {
    return res.status(400).json({ erro: 'escolha a categoria que fica' });
  }
  if (origemId === destinoId)
    return res.status(400).json({ erro: 'escolha outra categoria — não dá pra mesclar nela mesma' });

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query('SELECT * FROM categorias WHERE id = ANY($1::int[]) FOR UPDATE', [
      [origemId, destinoId],
    ]);
    const origem = rows.find((c) => c.id === origemId);
    const destino = rows.find((c) => c.id === destinoId);
    if (!origem || !destino) {
      await cliente.query('ROLLBACK');
      return res.status(404).json({ erro: 'categoria não encontrada' });
    }
    if (destino.legado || destino.canonica_id) {
      await cliente.query('ROLLBACK');
      return res.status(400).json({ erro: 'a categoria que fica tem que ser uma categoria ativa, não uma legada' });
    }
    const contas = await cliente.query('UPDATE anunciantes SET categoria_id = $2 WHERE categoria_id = $1', [
      origemId,
      destinoId,
    ]);
    const pontos = await cliente.query('UPDATE pontos SET categoria_id = $2 WHERE categoria_id = $1', [
      origemId,
      destinoId,
    ]);
    // Quem já tinha sido absorvido pela origem passa a apontar pro destino —
    // o mapeamento nunca fica em cadeia.
    await cliente.query('UPDATE categorias SET canonica_id = $2 WHERE canonica_id = $1', [origemId, destinoId]);
    await cliente.query('UPDATE categorias SET canonica_id = $2, legado = true, ativo = false WHERE id = $1', [
      origemId,
      destinoId,
    ]);
    const aliases = limparAliases([...(destino.aliases || []), origem.nome.toLowerCase(), ...(origem.aliases || [])]);
    const { rows: atualizada } = await cliente.query('UPDATE categorias SET aliases = $2 WHERE id = $1 RETURNING *', [
      destinoId,
      aliases,
    ]);
    await cliente.query('COMMIT');
    res.json({ destino: atualizada[0], contas_movidas: contas.rowCount, pontos_movidos: pontos.rowCount });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
});

// Excluir só vale pra categoria que ninguém usa (criada por engano). Em uso,
// a FK recusa — o certo é tirar do cadastro, marcar legado ou mesclar.
router.delete('/admin/categorias/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM categorias WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23503') {
      return res.status(409).json({ erro: 'categoria em uso — mescle em outra ou tire do cadastro em vez de excluir' });
    }
    throw err;
  }
});

module.exports = router;
