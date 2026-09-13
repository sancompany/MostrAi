const pool = require('../db/pool');

// Candidatura = formulário público de "quero ser ponto" / "quero ser
// vendedor". Não cria conta; o dono fala com a pessoa e gera um convite.
const TIPOS = ['ponto', 'vendedor'];
const STATUS = ['nova', 'em_contato', 'aprovada', 'recusada'];
const CAMPOS_ATUALIZAVEIS = ['status', 'convite_id'];

// conta_id/origem: pedido feito de dentro do painel (migration 020).
async function criar(dados, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO candidaturas
       (tipo, nome, nome_comercio, contato_telefone, contato_email, endereco, cidade, uf, cep,
        segmento, fluxo_estimado_mensal, mensagem, conta_id, origem, chave_pix, plano_ponto_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [dados.tipo, dados.nome, dados.nome_comercio || null, dados.contato_telefone, dados.contato_email || null,
      dados.endereco || null, dados.cidade || null, dados.uf || null, dados.cep || null,
      dados.segmento || null, dados.fluxo_estimado_mensal ? Number(dados.fluxo_estimado_mensal) : null,
      dados.mensagem || null, dados.conta_id || null, dados.origem || 'site',
      dados.chave_pix || null, dados.plano_ponto_id || null]
  );
  return rows[0];
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT c.*, v.token AS convite_token, v.usado_em AS convite_usado_em,
            (v.usado_em IS NULL AND v.expira_em > now()) AS convite_aberto,
            a.nome_empresa AS conta_nome, a.contato_email AS conta_email
     FROM candidaturas c LEFT JOIN convites v ON v.id = c.convite_id
     LEFT JOIN anunciantes a ON a.id = c.conta_id
     ORDER BY CASE c.status WHEN 'nova' THEN 0 WHEN 'em_contato' THEN 1 ELSE 2 END, c.criado_em DESC`
  );
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM candidaturas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `UPDATE candidaturas SET ${sets} WHERE id = $1 RETURNING *`, [id, ...campos.map((c) => dados[c])]
  );
  return rows[0] || null;
}

async function contarNovas() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM candidaturas WHERE status = 'nova'");
  return rows[0].total;
}

module.exports = { criar, listar, buscarPorId, atualizar, contarNovas, TIPOS, STATUS };
