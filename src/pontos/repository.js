const pool = require('../db/pool');

// Dois status desde 17/09/2026 (migration 045). Os cinco de antes misturavam
// "o ponto existe na rede?" com "a tela está funcionando?" — a segunda tem
// resposta própria em `dispositivos.status`, que continua com três.
const STATUS = ['a_instalar', 'em_operacao'];

// Whitelist de colunas editáveis via PATCH — nunca monta SET a partir de
// chave arbitrária vinda do body.
const CAMPOS_ATUALIZAVEIS = [
  'nome',
  'endereco',
  'cidade',
  'uf',
  'cep',
  'segmento',
  'categoria_id',
  'responsavel_nome',
  'responsavel_contato',
  'plano_ponto_id',
  'valor_pago_mensal',
  'cota_autoanuncio_slots_hora',
  'horario_abertura',
  'horario_fechamento',
  'status',
  'anunciante_id',
  'acabamento_completo',
  'foto_instalacao_url',
  'fluxo_estimado_mensal',
];

async function criar(dados, db = pool) {
  const {
    nome,
    endereco,
    cidade,
    uf,
    cep,
    segmento,
    categoria_id,
    plano_ponto_id,
    responsavel_nome,
    responsavel_contato,
    anunciante_id,
    fluxo_estimado_mensal,
    status,
    aceitou_termos_em,
    valor_pago_mensal,
    cota_autoanuncio_slots_hora,
  } = dados;

  const { rows } = await db.query(
    `INSERT INTO pontos
       (nome, endereco, cidade, uf, cep, segmento, categoria_id, plano_ponto_id,
        responsavel_nome, responsavel_contato, status, aceitou_termos_em,
        valor_pago_mensal, cota_autoanuncio_slots_hora, anunciante_id, fluxo_estimado_mensal)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      nome,
      endereco,
      cidade,
      uf,
      cep,
      segmento,
      categoria_id || null,
      plano_ponto_id || null,
      responsavel_nome,
      responsavel_contato,
      status || 'a_instalar',
      aceitou_termos_em || null,
      valor_pago_mensal || 0,
      cota_autoanuncio_slots_hora || 0,
      anunciante_id || null,
      fluxo_estimado_mensal || null,
    ],
  );
  return rows[0];
}

async function listar() {
  const { rows } = await pool.query(
    `SELECT p.*, c.nome AS categoria_nome, pp.nome AS plano_ponto_nome,
            a.nome_empresa AS dono_nome,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id) AS telas,
            (SELECT COUNT(*)::int FROM dispositivos d WHERE d.ponto_id = p.id AND d.status = 'ativo') AS telas_ativas
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
     LEFT JOIN anunciantes a ON a.id = p.anunciante_id
     ORDER BY p.created_at DESC`,
  );
  return rows;
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM pontos WHERE id = $1', [id]);
  return rows[0] || null;
}

async function atualizar(id, dados) {
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (!campos.length) return buscarPorId(id);

  const sets = campos.map((campo, i) => `${campo} = $${i + 2}`).join(', ');
  const valores = campos.map((c) => dados[c]);
  const { rows } = await pool.query(`UPDATE pontos SET ${sets} WHERE id = $1 RETURNING *`, [id, ...valores]);
  return rows[0] || null;
}

// Pública (módulo 7 "onde estamos") — pontos ativos + em construção/reparo,
// pra mostrar a rede crescendo com status visível, só campo seguro. Nunca
// devolver responsavel_contato aqui. (O player não usa isso — ele resolve
// playlist por ponto_id direto, não lista pontos.)
async function listarPublicos() {
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.cidade, p.endereco, p.status, c.nome AS categoria_nome
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.status IN ('em_operacao', 'a_instalar')
     ORDER BY (p.status = 'em_operacao') DESC, p.nome`,
  );
  return rows;
}

async function listarPorAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT p.*, c.nome AS categoria_nome, pp.nome AS plano_ponto_nome
     FROM pontos p
     LEFT JOIN categorias c ON c.id = p.categoria_id
     LEFT JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
     WHERE p.anunciante_id = $1
     ORDER BY p.created_at DESC`,
    [anuncianteId],
  );
  return rows;
}

// Soma de fluxo estimado só dos pontos com status "ativo" — nunca devolve o
// valor por ponto isolado (ver comentário da coluna na migration 016). Some
// menos de 1.000, não mostra nada no site (número pequeno demais pra ser
// prova social).
const FLUXO_MINIMO_PARA_EXIBIR = 1000;
async function somaFluxoMensal() {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(fluxo_estimado_mensal), 0)::int AS total
     FROM pontos WHERE status = 'em_operacao'`,
  );
  const total = rows[0].total;
  return total >= FLUXO_MINIMO_PARA_EXIBIR ? total : null;
}

module.exports = {
  criar,
  listar,
  buscarPorId,
  atualizar,
  listarPublicos,
  listarPorAnunciante,
  somaFluxoMensal,
  STATUS,
};
