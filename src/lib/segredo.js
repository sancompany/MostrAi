const crypto = require('node:crypto');

// Compara segredo recebido com o esperado em TEMPO CONSTANTE, e nunca passa
// com segredo vazio.
//
// Duas armadilhas que esta função fecha:
// - `===` devolve mais rápido quanto mais cedo os bytes divergem, então quem
//   mede o tempo de resposta descobre o segredo prefixo a prefixo;
// - `a !== b` com a variável de ambiente ausente vira `undefined !== undefined`
//   = falso, e a rota abre sozinha quando alguém esquece de configurar.
function segredoConfere(recebido, esperado) {
  if (!esperado || !recebido) return false;
  const a = Buffer.from(String(recebido));
  const b = Buffer.from(String(esperado));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { segredoConfere };
