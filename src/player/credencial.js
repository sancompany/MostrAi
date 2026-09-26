const crypto = require('node:crypto');
const pool = require('../db/pool');
const telaEventos = require('./tela-eventos');
const { sincronizarStatusPonto } = require('../pontos/repository');

// Credencial da tela (docs/player-mvp-contract.md §3–4): UMA chave por tela,
// entregue só na instalação (código de instalação → chave). O servidor
// guarda só o SHA-256: a chave tem 256 bits aleatórios, então hash rápido
// basta (não é senha escolhida por gente, não precisa de KDF lento) e a
// comparação por requisição continua barata. A chave em claro nunca vai
// para o banco, o log ou a tela do admin.
//
// Não há rotação: chave suspeita = revogar e instalar de novo (o operador
// gera um código novo na ficha da tela).

const gerarChave = () => crypto.randomBytes(32).toString('base64url');

const hashDaChave = (chave) => crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');

function hashesIguais(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

// A chave enviada é a desta tela? Vazia nunca passa.
function chaveConfere(tela, enviada) {
  if (typeof enviada !== 'string' || !enviada.trim()) return false;
  return hashesIguais(hashDaChave(enviada), tela.chave_hash);
}

// Revogar: a chave desta tela deixa de valer agora (o Player recebe 401 e
// volta para a tela de instalação), o código pendente morre junto, e a
// tela volta a "Aguardando instalação" — pronta para um código novo.
async function revogar(telaId) {
  const { rows } = await pool.query(
    `UPDATE dispositivos SET chave_hash = NULL, chave_ultimo_uso_em = NULL, revogado_em = now()
      WHERE id = $1 AND chave_hash IS NOT NULL
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

// Último uso com resolução de 1 min: gravar a cada requisição (heartbeat a
// cada 15 s, playlist, played, config) seria uma escrita por chamada só
// para um "há 2 min".
async function registrarUso(telaId) {
  await pool.query(
    `UPDATE dispositivos SET chave_ultimo_uso_em = now()
      WHERE id = $1 AND (chave_ultimo_uso_em IS NULL OR chave_ultimo_uso_em < now() - interval '1 minute')`,
    [telaId],
  );
}

module.exports = { gerarChave, hashDaChave, chaveConfere, revogar, registrarUso };
