const crypto = require('node:crypto');

// Identificadores que saem do sistema: todos aleatórios (CSPRNG), nunca
// sequenciais — não há o que varrer (regra dura 1 e lição do API.md §3).

// Sem 0/O e 1/I: o código curto é digitado à mão na portaria.
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 128 bits em base64url (22 caracteres): o código do ingresso que vai no QR.
function codigoIngresso() {
  return crypto.randomBytes(16).toString('base64url');
}

// 8 caracteres do alfabeto acima (~40 bits), XXXX-XXXX: o código impresso
// para digitar quando o QR não lê. Único por edição (índice no banco).
function codigoCurto() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  // 256 é múltiplo de 32: o resto por 32 é uniforme.
  for (const b of bytes) s += ALFABETO[b % 32];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

function normalizarCodigoCurto(valor) {
  const s = String(valor ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (s.length !== 8 || [...s].some((c) => !ALFABETO.includes(c))) return null;
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// Código público da edição (vai dentro do QR, nunca o id sequencial).
function codigoPublico() {
  return crypto.randomBytes(9).toString('base64url');
}

// Token de acesso (página do pedido): 192 bits; o banco guarda só o hash.
function token() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashToken(valor) {
  return crypto.createHash('sha256').update(String(valor)).digest('hex');
}

function hashTexto(valor) {
  return crypto.createHash('sha256').update(String(valor), 'utf8').digest('hex');
}

module.exports = {
  ALFABETO,
  codigoIngresso,
  codigoCurto,
  normalizarCodigoCurto,
  codigoPublico,
  token,
  hashToken,
  hashTexto,
};
