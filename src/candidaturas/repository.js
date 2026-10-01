const pool = require('../db/pool');
const { validar: validarHorarioSemanal } = require('../lib/horario-semanal');
const { PARTES, colunasDoEndereco, parteQueFalta } = require('../lib/endereco');

// Candidatura = formulário público de "quero ser ponto" / "quero ser
// vendedor". Não cria conta; o dono fala com a pessoa e gera um convite.
const TIPOS = ['ponto', 'vendedor'];
const STATUS = ['nova', 'em_contato', 'aprovada', 'recusada'];
const CAMPOS_ATUALIZAVEIS = ['status', 'convite_id'];

// conta_id/origem: pedido feito de dentro do painel (migration 020).
async function criar(dados, db = pool) {
  const horarioValidado = validarHorarioSemanal(dados.horario_semanal);
  // Partes do endereço e a linha composta num lugar só (D5, migration 086).
  const end = colunasDoEndereco(dados);
  const { rows } = await db.query(
    `INSERT INTO candidaturas
       (tipo, nome, nome_comercio, contato_telefone, contato_email, endereco, bairro, complemento, cidade, uf, cep,
        segmento, fluxo_estimado_mensal, mensagem, conta_id, origem, chave_pix, plano_ponto_id,
        horario_semanal, logradouro, numero)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [
      dados.tipo,
      dados.nome,
      dados.nome_comercio || null,
      dados.contato_telefone,
      dados.contato_email || null,
      end.endereco ?? null,
      end.bairro ?? null,
      end.complemento ?? null,
      end.cidade ?? null,
      end.uf ?? null,
      end.cep ?? null,
      dados.segmento || null,
      dados.fluxo_estimado_mensal ? Number(dados.fluxo_estimado_mensal) : null,
      dados.mensagem || null,
      dados.conta_id || null,
      dados.origem || 'site',
      dados.chave_pix || null,
      // Modalidade de comodato aposentada (24/09/2026, ADR-016): coluna
      // mantida pelo histórico, nunca mais preenchida.
      null,
      horarioValidado ? JSON.stringify(horarioValidado) : null,
      end.logradouro ?? null,
      end.numero ?? null,
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

// Endereço do pedido em análise, pela conta dona (Meus pontos, estação de
// endereços, 01/10/2026). Só enquanto está em análise e ainda não virou
// ponto — depois disso o endereço é do ponto (src/pontos/endereco.js, com
// histórico). Pedido de outra conta, já decidido ou já materializado
// responde 404, igual a inexistente. `partes` já validadas na rota.
async function atualizarEnderecoDoPedido(id, contaId, partes) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `SELECT * FROM candidaturas c
        WHERE c.id = $1 AND c.conta_id = $2 AND c.tipo = 'ponto' AND c.status IN ('nova', 'em_contato')
          AND NOT EXISTS (SELECT 1 FROM pontos p WHERE p.candidatura_id = c.id)
        FOR UPDATE`,
      [id, contaId],
    );
    const atual = rows[0];
    if (!atual) throw Object.assign(new Error('pedido não encontrado'), { status: 404 });
    const enviado = Object.fromEntries(PARTES.filter((p) => partes?.[p] !== undefined).map((p) => [p, partes[p]]));
    const novo = { ...atual, ...colunasDoEndereco(enviado, atual) };
    const falta = parteQueFalta(novo);
    if (falta) throw Object.assign(new Error(`endereço incompleto — preencha o campo ${falta}`), { status: 400 });
    const r = await cliente.query(
      `UPDATE candidaturas SET cep = $2, logradouro = $3, numero = $4, complemento = $5, bairro = $6,
              cidade = $7, uf = $8, endereco = $9
        WHERE id = $1 RETURNING *`,
      [id, novo.cep, novo.logradouro, novo.numero, novo.complemento, novo.bairro, novo.cidade, novo.uf, novo.endereco],
    );
    await cliente.query('COMMIT');
    return r.rows[0];
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

async function contarNovas() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS total FROM candidaturas WHERE status = 'nova'");
  return rows[0].total;
}

module.exports = {
  criar,
  listar,
  buscarPorId,
  atualizar,
  atualizarEnderecoDoPedido,
  definirFoto,
  contarNovas,
  TIPOS,
  STATUS,
};
