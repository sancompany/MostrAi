const pool = require('../db/pool');
const { validar: validarHorarioSemanal } = require('../lib/horario-semanal');

// Candidatura = formulário público de "quero ser ponto" / "quero ser
// vendedor". Não cria conta; o dono fala com a pessoa e gera um convite.
const TIPOS = ['ponto', 'vendedor'];
const STATUS = ['nova', 'em_contato', 'aprovada', 'recusada'];
const CAMPOS_ATUALIZAVEIS = ['status', 'convite_id'];

// conta_id/origem: pedido feito de dentro do painel (migration 020).
async function criar(dados, db = pool) {
  const horarioValidado = validarHorarioSemanal(dados.horario_semanal);
  const { rows } = await db.query(
    `INSERT INTO candidaturas
       (tipo, nome, nome_comercio, contato_telefone, contato_email, endereco, bairro, complemento, cidade, uf, cep,
        segmento, fluxo_estimado_mensal, mensagem, conta_id, origem, chave_pix, plano_ponto_id,
        horario_semanal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [
      dados.tipo,
      dados.nome,
      dados.nome_comercio || null,
      dados.contato_telefone,
      dados.contato_email || null,
      dados.endereco || null,
      dados.bairro || null,
      dados.complemento || null,
      dados.cidade || null,
      dados.uf || null,
      dados.cep || null,
      dados.segmento || null,
      dados.fluxo_estimado_mensal ? Number(dados.fluxo_estimado_mensal) : null,
      dados.mensagem || null,
      dados.conta_id || null,
      dados.origem || 'site',
      dados.chave_pix || null,
      dados.plano_ponto_id || null,
      horarioValidado ? JSON.stringify(horarioValidado) : null,
    ],
  );
  return rows[0];
}

// Foto da fachada (migration 067) — segundo passo do formulário de
// candidatura (a candidatura já existe, criada como JSON puro; a foto sobe
// depois, com multipart, no mesmo padrão de upload das demais fotos do
// projeto). Não passa por `atualizar`/CAMPOS_ATUALIZAVEIS de propósito: essa
// whitelist serve a rota ADMIN (`PATCH /admin/candidaturas/:id`), e uma URL
// de storage não é campo que o admin edite à mão.
async function definirFoto(id, url, db = pool) {
  const { rows } = await db.query('UPDATE candidaturas SET foto_fachada_url = $2 WHERE id = $1 RETURNING *', [id, url]);
  return rows[0] || null;
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT c.*, v.token AS convite_token, v.usado_em AS convite_usado_em,
            (v.usado_em IS NULL AND v.expira_em > now()) AS convite_aberto,
            a.nome_empresa AS conta_nome, a.contato_email AS conta_email
     FROM candidaturas c LEFT JOIN convites v ON v.id = c.convite_id
     LEFT JOIN anunciantes a ON a.id = c.conta_id
     ORDER BY CASE c.status WHEN 'nova' THEN 0 WHEN 'em_contato' THEN 1 ELSE 2 END, c.criado_em DESC`,
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
  const { rows } = await pool.query(`UPDATE candidaturas SET ${sets} WHERE id = $1 RETURNING *`, [
    id,
    ...campos.map((c) => dados[c]),
  ]);
  return rows[0] || null;
}

async function contarNovas() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM candidaturas WHERE status = 'nova'");
  return rows[0].total;
}

// Candidaturas em aberto de uma conta (Parte de correção cirúrgica de Rede,
// 23/09/2026): "Meus endereços" precisa mostrar o que está em análise junto
// dos pontos de verdade, sem misturar as duas coisas no modelo — a
// candidatura continua candidatura até o admin aprovar (aí vira ponto, e some
// daqui porque o status deixa de ser 'nova'/'em_contato').
async function listarAbertasPorConta(contaId, tipo) {
  const { rows } = await pool.query(
    `SELECT id, tipo, nome_comercio, endereco, bairro, cidade, uf, foto_fachada_url, status, criado_em
       FROM candidaturas
      WHERE conta_id = $1 AND tipo = $2 AND status IN ('nova', 'em_contato')
      ORDER BY criado_em DESC`,
    [contaId, tipo],
  );
  return rows;
}

module.exports = {
  criar,
  listar,
  buscarPorId,
  atualizar,
  definirFoto,
  contarNovas,
  listarAbertasPorConta,
  TIPOS,
  STATUS,
};
