const crypto = require('node:crypto');
const pool = require('../db/pool');

// Convite = link com token, papéis, validade e uso único, gerado pelo dono.
// É o ÚNICO caminho de entrada de dono de ponto (CONSTRAINTS.md). 'vendedor'
// saiu da lista (papel aposentado, 23/09/2026): convite novo não o carrega
// mais — convite antigo que ainda o tenha é filtrado na aceitação.
const PAPEIS = ['anunciante', 'ponto'];
const VALIDADE_DIAS_PADRAO = 7;

async function criar({ papeis, nomeSugerido, emailSugerido, candidaturaId, validadeDias }) {
  const lista = (papeis || []).filter((p) => PAPEIS.includes(p));
  if (!lista.length) throw Object.assign(new Error('convite precisa de ao menos um papel'), { status: 400 });
  const token = crypto.randomBytes(24).toString('base64url');
  const expira = new Date(Date.now() + (Number(validadeDias) || VALIDADE_DIAS_PADRAO) * 24 * 3600 * 1000);
  const { rows } = await pool.query(
    `INSERT INTO convites (token, papeis, nome_sugerido, email_sugerido, candidatura_id, expira_em)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [token, lista, nomeSugerido || null, emailSugerido || null, candidaturaId || null, expira],
  );
  return rows[0];
}

// Válido = existe, não usado, não expirado.
async function buscarValido(token) {
  const { rows } = await pool.query(
    `SELECT * FROM convites WHERE token = $1 AND usado_em IS NULL AND expira_em > now()`,
    [token],
  );
  return rows[0] || null;
}

// Marca usado de forma atômica: dois cadastros simultâneos com o mesmo link,
// só um passa.
async function consumir(token, contaId, db = pool) {
  const { rows } = await db.query(
    `UPDATE convites SET usado_em = now(), conta_id = $2
     WHERE token = $1 AND usado_em IS NULL AND expira_em > now() RETURNING *`,
    [token, contaId],
  );
  return rows[0] || null;
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT c.*, a.nome_empresa AS conta_nome,
            CASE WHEN c.usado_em IS NOT NULL THEN 'usado' WHEN c.expira_em < now() THEN 'expirado' ELSE 'aberto' END AS situacao
     FROM convites c LEFT JOIN anunciantes a ON a.id = c.conta_id
     ORDER BY c.criado_em DESC`,
  );
  return rows;
}

async function revogar(id) {
  const { rows } = await pool.query(
    `UPDATE convites SET expira_em = now() WHERE id = $1 AND usado_em IS NULL RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

module.exports = { criar, buscarValido, consumir, listar, revogar, PAPEIS };
