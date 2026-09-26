const pool = require('../db/pool');

// Histórico de TRANSIÇÕES da tela (instalou, primeiro sinal, sumiu e voltou,
// erro começou/terminou, config aplicada, revogou). Nunca um heartbeat por
// linha: 5.760 por dia por tela para dizer "continua igual" é o log infinito
// que o dono vetou. O estado atual mora nas colunas da própria
// tela; aqui só o que mudou e quando.
//
// `detalhe` nunca leva segredo (chave, código, PIN) — só código de erro,
// versão, horário.
const TIPOS = new Set([
  'SCREEN_CREATED',
  'PROVISIONING_PREPARED',
  'PROVISIONING_FAILED',
  'PLAYER_PROVISIONED',
  'FIRST_SEEN',
  'OFFLINE',
  'ONLINE',
  'ERROR_STARTED',
  'ERROR_RESOLVED',
  'CONFIG_APPLIED',
  'CREDENTIAL_REVOKED',
  'ADMIN_STATE_CHANGED',
]);

async function registrar(telaId, tipo, detalhe = null, db = pool, ocorridoEm = null) {
  if (!TIPOS.has(tipo)) throw new Error(`tipo de evento de tela desconhecido: ${tipo}`);
  await db.query(
    `INSERT INTO tela_eventos (dispositivo_id, tipo, detalhe, ocorrido_em) VALUES ($1, $2, $3, COALESCE($4, now()))`,
    [telaId, tipo, detalhe ? JSON.stringify(detalhe) : null, ocorridoEm],
  );
}

async function listar(telaId, limite = 50) {
  const { rows } = await pool.query(
    `SELECT id, tipo, ocorrido_em, detalhe FROM tela_eventos
      WHERE dispositivo_id = $1 ORDER BY ocorrido_em DESC, id DESC LIMIT $2`,
    [telaId, limite],
  );
  return rows;
}

module.exports = { TIPOS, registrar, listar };
