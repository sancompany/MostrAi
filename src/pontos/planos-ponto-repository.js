const pool = require('../db/pool');

const CAMPOS_ATUALIZAVEIS = [
  'nome',
  'chamada',
  'ajuda_custo_mensal',
  'cota_slots_hora',
  'beneficios',
  'ordem',
  'ativo',
  'plano_bonus_id',
  'plano_bonus_apos_meses',
  'plano_bonus_meses',
];

async function listarAtivos() {
  const { rows } = await pool.query('SELECT * FROM planos_ponto WHERE ativo ORDER BY ordem, id');
  return rows;
}

async function listarTodos() {
  const { rows } = await pool.query('SELECT * FROM planos_ponto ORDER BY ordem, id');
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM planos_ponto WHERE id = $1', [id]);
  return rows[0] || null;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);
  const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(`UPDATE planos_ponto SET ${sets} WHERE id = $1 RETURNING *`, [
    id,
    ...campos.map((c) => dados[c]),
  ]);
  return rows[0] || null;
}

async function criar(dados) {
  const { rows } = await pool.query(
    `INSERT INTO planos_ponto (id, nome, chamada, ajuda_custo_mensal, cota_slots_hora, beneficios, ordem)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [
      dados.id,
      dados.nome,
      dados.chamada,
      dados.ajuda_custo_mensal || 0,
      dados.cota_slots_hora || 0,
      dados.beneficios || [],
      dados.ordem || 0,
    ],
  );
  return rows[0];
}

module.exports = { listarAtivos, listarTodos, buscarPorId, atualizar, criar };
