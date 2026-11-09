const crypto = require('node:crypto');
const config = require('../config');

// Toda chave da Trimundi deriva do segredo-mestre (TRIMUNDI_SEGREDO) por
// HKDF com um rótulo por uso: trocar o segredo invalida os QR emitidos e os
// códigos de ativação pendentes (RUNBOOK §11). Os links de pedido não
// dependem dele (só o sha256 do token fica no banco).
function derivar(rotulo, tamanho = 32) {
  const mestre = config.segredoMestre();
  if (!mestre) throw new Error('segredo da Trimundi ausente');
  return Buffer.from(crypto.hkdfSync('sha256', mestre, 'trimundi', rotulo, tamanho));
}

function hmac(rotulo, valor) {
  return crypto.createHmac('sha256', derivar(rotulo)).update(String(valor)).digest('hex');
}

module.exports = { derivar, hmac };
