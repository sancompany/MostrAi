const crypto = require('node:crypto');
const pool = require('../db/pool');
const cofre = require('../lib/cofre');
const telaEventos = require('./tela-eventos');
const { sincronizarStatusPonto } = require('../pontos/repository');

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

// Resposta 2xx a uma requisição feita com a candidata: o Player vai
// oficializá-la (contrato §1.1), então o servidor também — ANTES de a
// resposta sair (src/lib/aparelho.js). A antiga passa a valer só pela
// sobreposição, e a nova fica cifrada até o primeiro uso, para ser reenviada
// se a resposta se perder.
//
// Condição: a candidata ainda pendente, OU a chave atual ainda a mesma de
// quando a requisição foi autenticada (`hashAtualLido`) — o admin pode ter
// cancelado a rotação no meio, mas a resposta já disse "sim" ao aparelho.
// Revogação (chave atual nula) e chave legada nova (atual trocada) vencem.
// Uma rotação nova pedida no meio (outra candidata) continua pendente.
async function promoverChaveNova(telaId, chave, hashAtualLido, db = pool) {
  const hash = hashDaChave(chave);
  const { rowCount } = await db.query(
    `UPDATE dispositivos
        SET chave_anterior_hash = chave_hash,
            chave_anterior_expira_em = now() + ($4::bigint * interval '1 millisecond'),
            chave_hash = $2,
            chave_fingerprint = $3,
            chave_criada_em = CASE WHEN chave_nova_hash = $2 THEN chave_nova_criada_em ELSE now() END,
            chave_atual_cifrada = $5,
            chave_nova_fingerprint = CASE WHEN chave_nova_hash = $2 THEN NULL ELSE chave_nova_fingerprint END,
            chave_nova_cifrada = CASE WHEN chave_nova_hash = $2 THEN NULL ELSE chave_nova_cifrada END,
            chave_nova_criada_em = CASE WHEN chave_nova_hash = $2 THEN NULL ELSE chave_nova_criada_em END,
            chave_nova_hash = CASE WHEN chave_nova_hash = $2 THEN NULL ELSE chave_nova_hash END
      WHERE id = $1 AND chave_hash IS NOT NULL AND chave_hash <> $2
        AND (chave_nova_hash = $2 OR chave_hash = $6)`,
    [telaId, hash, fingerprintDoHash(hash), SOBREPOSICAO_MS, cofre.fechar(chave), hashAtualLido],
  );
  if (rowCount) await telaEventos.registrar(telaId, 'CREDENTIAL_ROTATED', { fingerprint: fingerprintDoHash(hash) }, db);
  return rowCount > 0;
}

// O Player usou a chave atual: ele a tem, a cópia cifrada não serve mais.
async function esquecerCopiaDaAtual(telaId) {
  await pool.query('UPDATE dispositivos SET chave_atual_cifrada = NULL WHERE id = $1', [telaId]);
}

// Admin pede rotação: a candidata fica pendente até o Player usá-la. Só para
// Player V2 provisionado (`dispositivo_uid` — só o V2 passa por token, e a
// chave legada o apaga): a candidata viaja na resposta do heartbeat V2, e um
// Player V1 nunca a receberia — a rotação ficaria pendente para sempre com a
// chave suspeita ainda valendo. Para V1, o caminho é gerar link novo ou
// revogar.
async function iniciarRotacao(telaId) {
  const chave = gerarChave();
  const hash = hashDaChave(chave);
  const { rows } = await pool.query(
    `UPDATE dispositivos
        SET chave_nova_hash = $2, chave_nova_fingerprint = $3, chave_nova_cifrada = $4, chave_nova_criada_em = now()
      WHERE id = $1 AND chave_hash IS NOT NULL AND dispositivo_uid IS NOT NULL
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
// `aparelho_id` (a chave V1 em claro que a migration 083 manteve só para
// rollback) sai junto: senão um revert do código ressuscitaria a chave.
async function revogar(telaId) {
  const { rows } = await pool.query(
    `UPDATE dispositivos
        SET aparelho_id = NULL, chave_hash = NULL, chave_fingerprint = NULL, chave_criada_em = NULL, chave_ultimo_uso_em = NULL,
            chave_atual_cifrada = NULL,
            chave_nova_hash = NULL, chave_nova_fingerprint = NULL, chave_nova_cifrada = NULL, chave_nova_criada_em = NULL,
            chave_anterior_hash = NULL, chave_anterior_expira_em = NULL,
            revogado_em = now()
      WHERE id = $1 AND (chave_hash IS NOT NULL OR chave_nova_hash IS NOT NULL OR chave_anterior_hash IS NOT NULL)
      RETURNING ponto_id`,
    [telaId],
  );
  // Código de instalação pendente morre junto (senão um código visto antes
  // da revogação reinstalaria a tela), e a credencial guardada para
  // repetição da instalação também.
  const { rowCount: cancelados } = await pool.query(
    `UPDATE tokens_provisionamento
        SET cancelado_em = CASE WHEN usado_em IS NULL AND cancelado_em IS NULL THEN now() ELSE cancelado_em END,
            codigo_cifrado = NULL, credencial_cifrada = NULL
      WHERE dispositivo_id = $1
        AND ((usado_em IS NULL AND cancelado_em IS NULL) OR codigo_cifrado IS NOT NULL OR credencial_cifrada IS NOT NULL)`,
    [telaId],
  );
  if (!rows[0]) return cancelados > 0;
  await telaEventos.registrar(telaId, 'CREDENTIAL_REVOKED', null);
  // Tela sem credencial não exibe: o ponto pode deixar de estar em operação.
  await sincronizarStatusPonto(rows[0].ponto_id);
  return true;
}

// compat-v1 (SÓ testes da compatibilidade V1 — o admin não gera mais chave
// legada desde a consolidação de 24/09/2026; a rota responde 410): grava
// uma chave V1 na tela, identificada pela PK numérica, como as TVs V1 em
// campo têm. Gera uma chave nova (derruba a anterior na hora) e devolve o
// valor UMA vez; o banco guarda só o hash. O `dispositivo_uid` sai.
async function gerarChaveLegada(telaId) {
  const chave = gerarChave();
  const hash = hashDaChave(chave);
  const { rows } = await pool.query(
    `UPDATE dispositivos
        SET aparelho_id = NULL, dispositivo_uid = NULL, chave_atual_cifrada = NULL,
            chave_hash = $2, chave_fingerprint = $3, chave_criada_em = now(), chave_ultimo_uso_em = NULL,
            chave_nova_hash = NULL, chave_nova_fingerprint = NULL, chave_nova_cifrada = NULL, chave_nova_criada_em = NULL,
            chave_anterior_hash = NULL, chave_anterior_expira_em = NULL,
            revogado_em = NULL
      WHERE id = $1 RETURNING ponto_id`,
    [telaId, hash, fingerprintDoHash(hash)],
  );
  if (!rows[0]) return null;
  await telaEventos.registrar(telaId, 'CREDENTIAL_LEGACY_ISSUED', { fingerprint: fingerprintDoHash(hash) });
  await sincronizarStatusPonto(rows[0].ponto_id);
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
  hashDaChave,
  fingerprintDoHash,
  identificarChave,
  promoverChaveNova,
  esquecerCopiaDaAtual,
  iniciarRotacao,
  cancelarRotacao,
  revogar,
  gerarChaveLegada,
  registrarUso,
};
