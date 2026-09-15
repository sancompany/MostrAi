const pool = require('../db/pool');

// Perfil de vendedor de uma conta (migration 019). Substitui a tabela
// afiliados, que fica no banco só até o dono autorizar o drop.
function gerarCupom(nome) {
  const slug =
    String(nome || 'vend')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z]/g, '')
      .toUpperCase()
      .slice(0, 6) || 'VEND';
  return `${slug}${Math.floor(100 + Math.random() * 900)}`;
}

async function criar(contaId, dados, db = pool) {
  // Cupom único: tenta até não colidir (3 dígitos aleatórios; colisão é rara).
  // Dentro de transação, um 23505 aborta a transação inteira — por isso o
  // SAVEPOINT em volta de cada tentativa.
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    try {
      await db.query('SAVEPOINT cupom');
      const { rows } = await db.query(
        `INSERT INTO vendedores (conta_id, chave_pix, codigo_cupom) VALUES ($1,$2,$3) RETURNING *`,
        [contaId, dados.chave_pix, dados.codigo_cupom || gerarCupom(dados.nome)],
      );
      await db.query('RELEASE SAVEPOINT cupom');
      return rows[0];
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT cupom').catch(() => {});
      if (err.code !== '23505' || tentativa === 4) throw err;
    }
  }
  return null;
}

async function buscarPorConta(contaId) {
  const { rows } = await pool.query('SELECT * FROM vendedores WHERE conta_id = $1', [contaId]);
  return rows[0] || null;
}

async function buscarPorCupomAprovado(cupom) {
  const { rows } = await pool.query(
    `SELECT v.*, a.nome_empresa AS nome FROM vendedores v JOIN anunciantes a ON a.id = v.conta_id
     WHERE v.codigo_cupom = $1 AND v.status = 'aprovado' AND a.excluido_em IS NULL`,
    [cupom],
  );
  return rows[0] || null;
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT v.*, a.nome_empresa AS nome, a.contato_email AS email, a.contato_telefone AS telefone, a.cpf_cnpj AS cpf
     FROM vendedores v JOIN anunciantes a ON a.id = v.conta_id ORDER BY v.created_at DESC`,
  );
  return rows;
}

const CAMPOS_ATUALIZAVEIS = ['status', 'comissao_percentual', 'chave_pix'];
async function atualizar(contaId, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorConta(contaId);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(`UPDATE vendedores SET ${sets} WHERE conta_id = $1 RETURNING *`, [
    contaId,
    ...campos.map((c) => dados[c]),
  ]);
  return rows[0] || null;
}

module.exports = { criar, buscarPorConta, buscarPorCupomAprovado, listar, atualizar };
