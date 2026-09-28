const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const concorrencia = require('./concorrencia');

// CRUD trivial — sem camada de repositório própria, o SQL cabe aqui.
// Categoria é o segmento do negócio: o anunciante diz o que vende, o ponto
// diz o que é, e a playlist usa isso pra não colocar concorrente dentro de
// concorrente (src/playlist/gerador.js).
//
// Reconstrução de Contas + Categorias (23/09/2026): categoria passa a ter uma
// CANÔNICA (`canonica_id`, migration 074). Categoria absorvida por outra vira
// legado, some do cadastro e aponta pra que ficou — quem a usava foi
// reapontado junto. A regra de bloqueio compara categoria_id — igual, ou par
// registrado como concorrente direto (migration 105, ./concorrencia.js).

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
// `concorrentes`: ids dos concorrentes diretos, dos dois lados do par — uma
// consulta a mais pra lista inteira, não uma por categoria.
router.get('/admin/categorias', async (_req, res) => {
  const [{ rows }, mapa] = await Promise.all([
    pool.query(
      `SELECT c.*, canon.nome AS canonica_nome,
            COALESCE(ua.total, 0)::int AS uso_contas,
            COALESCE(up.total, 0)::int AS uso_pontos
       FROM categorias c
       LEFT JOIN categorias canon ON canon.id = c.canonica_id
       LEFT JOIN (SELECT categoria_id, COUNT(*) AS total FROM anunciantes
                   WHERE categoria_id IS NOT NULL AND NOT conta_propria GROUP BY categoria_id) ua
              ON ua.categoria_id = c.id
       LEFT JOIN (SELECT categoria_id, COUNT(*) AS total FROM pontos
                   WHERE categoria_id IS NOT NULL AND status <> 'arquivado' GROUP BY categoria_id) up
              ON up.categoria_id = c.id
      ORDER BY c.nome`,
    ),
    concorrencia.mapaDeConcorrentes(),
  ]);
  res.json(rows.map((c) => ({ ...c, concorrentes: mapa.get(c.id) || [] })));
});

// Grava a categoria e, se veio `concorrentes`, o conjunto de concorrentes
// diretos dela — na mesma transação: o modal salva tudo ou nada.
async function comTransacao(trabalho) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const resultado = await trabalho(cliente);
    await cliente.query('COMMIT');
    return resultado;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

function respostaDeErro(res, err) {
  if (err instanceof concorrencia.ErroConcorrentes) return res.status(400).json({ erro: err.message });
  if (err.code === '23505') return res.status(409).json({ erro: 'já existe uma categoria com esse nome' });
  throw err;
}

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
    const criada = await comTransacao(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO categorias (nome, grupo, aliases, ativo, legado) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [nome, grupo, limparAliases(req.body.aliases), ativo, legado],
      );
      const concorrentes =
        req.body.concorrentes === undefined
          ? []
          : await concorrencia.definirConcorrentes(db, rows[0].id, req.body.concorrentes);
      return { ...rows[0], concorrentes };
    });
    res.status(201).json(criada);
  } catch (err) {
    return respostaDeErro(res, err);
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
  const mexeConcorrentes = corpo.concorrentes !== undefined;
  if (!campos.length && !mexeConcorrentes) return res.status(400).json({ erro: 'nada pra atualizar' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ erro: 'categoria não encontrada' });
  try {
    const salva = await comTransacao(async (db) => {
      // FOR UPDATE: duas edições da mesma categoria ao mesmo tempo não
      // intercalam o conjunto de concorrentes (a última grava inteira).
      const { rows } = campos.length
        ? await db.query(
            `UPDATE categorias SET ${campos.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
            [id, ...campos.map((c) => corpo[c])],
          )
        : await db.query('SELECT * FROM categorias WHERE id = $1 FOR UPDATE', [id]);
      if (!rows[0]) return null;
      const concorrentes = mexeConcorrentes
        ? await concorrencia.definirConcorrentes(db, id, corpo.concorrentes)
        : [...(await concorrencia.concorrentesDe(id, db))].sort((x, y) => x - y);
      return { ...rows[0], concorrentes };
    });
    if (!salva) return res.status(404).json({ erro: 'categoria não encontrada' });
    res.json(salva);
  } catch (err) {
    return respostaDeErro(res, err);
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
    await concorrencia.moverNaFusao(cliente, origemId, destinoId);
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
