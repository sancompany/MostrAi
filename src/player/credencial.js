const crypto = require('node:crypto');
const pool = require('../db/pool');
const cofre = require('../lib/cofre');
const telaEventos = require('./tela-eventos');

// Credencial do Player (contrato V2 §1). O servidor guarda só o SHA-256 da
// chave: a chave tem 256 bits aleatórios, então hash rápido basta (não é
// senha escolhida por gente, não precisa de KDF lento) e a comparação por
// requisição continua barata. A chave em claro existe em três momentos só:
// na resposta do provisionamento, na resposta do heartbeat que entrega a
// candidata de uma rotação, e no link do player web V1 quando o admin gera
// uma chave legada — nunca no banco, no log ou na tela do admin.

// Contrato §1.1: "O backend precisa aceitar as duas chaves durante a janela
// de sobreposição (24h basta)."
const SOBREPOSICAO_MS = 24 * 3600 * 1000;

const gerarChave = () => crypto.randomBytes(32).toString('base64url');
const gerarUid = () => `tela_${crypto.randomBytes(10).toString('hex')}`;
const hashDaChave = (chave) => crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');
// Identificador não secreto da chave, para o admin reconhecer "é a mesma?".
const fingerprintDoHash = (hash) => (hash ? hash.slice(-6).toUpperCase() : null);

function hashesIguais(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// Qual das chaves aceitas a TV mandou: 'atual' | 'nova' | 'anterior' | null.
// Credencial vazia nunca passa (contrato §1: "O backend deve rejeitar
// credencial vazia").
function identificarChave(tela, enviada, agora = new Date()) {
  if (typeof enviada !== 'string' || !enviada.trim()) return null;
  const hash = hashDaChave(enviada);
  if (hashesIguais(hash, tela.chave_hash)) return 'atual';
  if (hashesIguais(hash, tela.chave_nova_hash)) return 'nova';
  if (
    hashesIguais(hash, tela.chave_anterior_hash) &&
    tela.chave_anterior_expira_em &&
    new Date(tela.chave_anterior_expira_em) > agora
  ) {
    return 'anterior';
  }
  return null;
}

// Primeira requisição bem-sucedida com a candidata: ela vira a oficial e a
// antiga passa a valer só pela janela de sobreposição. Condicional ao hash
// da candidata: duas requisições simultâneas com ela promovem uma vez só.
async function promoverChaveNova(telaId, hashNova, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE dispositivos
        SET chave_anterior_hash = chave_hash,
            chave_anterior_expira_em = now() + ($3::bigint * interval '1 millisecond'),
            chave_hash = chave_nova_hash,
            chave_fingerprint = chave_nova_fingerprint,
            chave_criada_em = chave_nova_criada_em,
            chave_nova_hash = NULL, chave_nova_fingerprint = NULL,
            chave_nova_cifrada = NULL, chave_nova_criada_em = NULL
      WHERE id = $1 AND chave_nova_hash = $2`,
    [telaId, hashNova, SOBREPOSICAO_MS],
  );
  if (rowCount)
    await telaEventos.registrar(telaId, 'CREDENTIAL_ROTATED', { fingerprint: fingerprintDoHash(hashNova) }, db);
  return rowCount > 0;
}

// Admin pede rotação: a candidata fica pendente até o Player usá-la. Só para
// tela com Player provisionado (sem chave atual, não há o que rotacionar).
async function iniciarRotacao(telaId) {
  const chave = gerarChave();
  const hash = hashDaChave(chave);
  const { rows } = await pool.query(
    `UPDATE dispositivos
        SET chave_nova_hash = $2, chave_nova_fingerprint = $3, chave_nova_cifrada = $4, chave_nova_criada_em = now()
      WHERE id = $1 AND chave_hash IS NOT NULL
      RETURNING id`,
    [telaId, hash, fingerprintDoHash(hash), cofre.fechar(chave)],
  );
  if (!rows[0]) return false;
  await telaEventos.registrar(telaId, 'CREDENTIAL_ROTATION_REQUESTED', { fingerprint: fingerprintDoHash(hash) });
  return true;
}

async function cancelarRotacao(telaId, motivo = 'cancelada no admin') {
  const { rowCount } = await pool.query(
    `UPDATE dispositivos
        SET chave_nova_hash = NULL, chave_nova_fingerprint = NULL, chave_nova_cifrada = NULL, chave_nova_criada_em = NULL
      WHERE id = $1 AND chave_nova_hash IS NOT NULL`,
    [telaId],
  );
  if (rowCount) await telaEventos.registrar(telaId, 'CREDENTIAL_ROTATION_CANCELLED', { motivo });
  return rowCount > 0;
}

// Revogar: nenhuma chave desta tela vale mais, a partir de agora. O Player
// passa a receber 401 (AUTH_ERROR no aparelho) até ser reprovisionado.
async function revogar(telaId) {
  const { rowCount } = await pool.query(
    `UPDATE dispositivos
        SET chave_hash = NULL, chave_fingerprint = NULL, chave_criada_em = NULL, chave_ultimo_uso_em = NULL,
            chave_nova_hash = NULL, chave_nova_fingerprint = NULL, chave_nova_cifrada = NULL, chave_nova_criada_em = NULL,
            chave_anterior_hash = NULL, chave_anterior_expira_em = NULL,
            revogado_em = now()
      WHERE id = $1 AND (chave_hash IS NOT NULL OR chave_nova_hash IS NOT NULL OR chave_anterior_hash IS NOT NULL)`,
    [telaId],
  );
  if (rowCount) await telaEventos.registrar(telaId, 'CREDENTIAL_REVOKED', null);
  return rowCount > 0;
}

// compat-v1: o player web (public/player.html) não conhece provisionamento
// por token — recebe a chave pela URL que o admin abre na TV. Gera uma chave
// nova (derruba a anterior na hora, como sempre foi) e devolve o valor UMA
// vez, para o link; o banco guarda só o hash.
async function gerarChaveLegada(telaId) {
  const chave = gerarChave();
  const hash = hashDaChave(chave);
  const { rows } = await pool.query(
    `UPDATE dispositivos
        SET chave_hash = $2, chave_fingerprint = $3, chave_criada_em = now(), chave_ultimo_uso_em = NULL,
            chave_nova_hash = NULL, chave_nova_fingerprint = NULL, chave_nova_cifrada = NULL, chave_nova_criada_em = NULL,
            chave_anterior_hash = NULL, chave_anterior_expira_em = NULL,
            revogado_em = NULL
      WHERE id = $1 RETURNING id`,
    [telaId, hash, fingerprintDoHash(hash)],
  );
  if (!rows[0]) return null;
  await telaEventos.registrar(telaId, 'CREDENTIAL_LEGACY_ISSUED', { fingerprint: fingerprintDoHash(hash) });
  return chave;
}

// Último uso com resolução de 1 min: gravar a cada requisição (playlist,
// heartbeat, played, config) seria uma escrita por chamada só para um "há 2
// min" no admin.
async function registrarUso(telaId) {
  await pool.query(
    `UPDATE dispositivos SET chave_ultimo_uso_em = now()
      WHERE id = $1 AND (chave_ultimo_uso_em IS NULL OR chave_ultimo_uso_em < now() - interval '1 minute')`,
    [telaId],
  );
}

module.exports = {
  SOBREPOSICAO_MS,
  gerarChave,
  gerarUid,
  hashDaChave,
  fingerprintDoHash,
  identificarChave,
  promoverChaveNova,
  iniciarRotacao,
  cancelarRotacao,
  revogar,
  gerarChaveLegada,
  registrarUso,
};
