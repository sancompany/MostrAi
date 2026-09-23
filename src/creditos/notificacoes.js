const pool = require('../db/pool');
const sse = require('../lib/sse');

// Central de atualizações da conta (migration 079). Distinta de
// src/lib/eventos.js (métrica interna, o dono nunca vê) — aqui é histórico
// que o CLIENTE lê, então nunca falha silenciosamente igual eventos.js: se
// a notificação não grava, quem chamou decide se isso é grave (por isso
// `registrar` devolve a Promise em vez de engolir o erro sozinha — ao
// contrário de eventos.registrar). Mesmo assim, nenhuma chamada deve travar
// o caminho de negócio por causa da notificação: quem chama envolve em
// try/catch quando a ação principal não pode falhar por causa dela.
async function registrar(contaId, { tipo, titulo, descricao, entidadeTipo, entidadeId, link }, db = pool) {
  const { rows } = await db.query(
    `INSERT INTO notificacoes (anunciante_id, tipo, titulo, descricao, entidade_tipo, entidade_id, link)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [contaId, tipo, titulo, descricao || null, entidadeTipo || null, entidadeId || null, link || null],
  );
  // Emite o evento em tempo real DEPOIS de commitar — quem chama passa o
  // pool (não uma transação em aberto) quando quer emitir na hora; dentro
  // de uma transação, quem chama emite depois do COMMIT (ver
  // plano-administrativo.js) pra nunca anunciar um dado que pode dar
  // ROLLBACK.
  if (db === pool) sse.emitirParaConta(contaId, 'notification.created', { id: rows[0].id });
  return rows[0];
}

async function listar(contaId, { apenasNaoLidas = false, limite = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM notificacoes WHERE anunciante_id = $1 ${apenasNaoLidas ? 'AND lida_em IS NULL' : ''}
      ORDER BY criado_em DESC LIMIT $2`,
    [contaId, limite],
  );
  return rows;
}

async function contarNaoLidas(contaId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM notificacoes WHERE anunciante_id = $1 AND lida_em IS NULL',
    [contaId],
  );
  return rows[0].n;
}

async function marcarLida(contaId, id) {
  const { rows } = await pool.query(
    'UPDATE notificacoes SET lida_em = now() WHERE id = $1 AND anunciante_id = $2 AND lida_em IS NULL RETURNING *',
    [id, contaId],
  );
  return rows[0] || null;
}

async function marcarTodasLidas(contaId) {
  await pool.query('UPDATE notificacoes SET lida_em = now() WHERE anunciante_id = $1 AND lida_em IS NULL', [contaId]);
}

module.exports = { registrar, listar, contarNaoLidas, marcarLida, marcarTodasLidas };
