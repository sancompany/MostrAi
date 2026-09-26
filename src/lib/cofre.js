const crypto = require('node:crypto');

// Cofre para o pouco que o servidor precisa guardar E recuperar do Player
// (docs/player-mvp-contract.md): o PIN de saída global (vai em claro na
// config), o código de instalação enquanto ele vale (o admin o reexibe com a
// contagem regressiva) e a credencial de uma instalação durante a janela de
// repetição. Todo o resto é hash.
//
// AES-256-GCM (autenticado: texto adulterado não decifra). Chave derivada por
// HKDF-SHA256 do SESSION_SECRET — sem variável nova para o dono configurar.
// Conferido na doc do Node 22 (crypto.hkdfSync, createCipheriv com
// 'aes-256-gcm', IV de 12 bytes, tag de 16), 23/09/2026.
// limite: trocar o SESSION_SECRET torna ilegível o que já foi cifrado. Nada
// quebra — `abrir` devolve null e quem chama trata como ausente (PIN pede
// redefinição, código de instalação pendente precisa ser gerado de novo).
const ROTULO = 'v1';

function derivar(uso) {
  const segredo = process.env.SESSION_SECRET;
  if (!segredo) throw new Error('SESSION_SECRET ausente — o cofre não tem de onde derivar a chave');
  return Buffer.from(crypto.hkdfSync('sha256', segredo, 'mostrai-cofre', uso, 32));
}

// Rótulo HKDF 'player-v2' mantido: é o que decifra o que já foi guardado.
const chave = () => derivar('player-v2');

// Assinatura (HMAC-SHA256) para segredo CURTO que precisa ser achado por
// igualdade sem ficar recuperável: o código de instalação tem ~40 bits, e um
// SHA-256 simples dele cai por força bruta offline em minutos se o banco
// vazar. Com a chave do servidor, o hash sozinho não serve pra nada. Chave
// própria (outro rótulo HKDF), nunca a mesma da cifra.
function assinar(texto) {
  return crypto.createHmac('sha256', derivar('codigo-instalacao')).update(String(texto), 'utf8').digest('hex');
}

function fechar(texto) {
  const iv = crypto.randomBytes(12);
  const cifra = crypto.createCipheriv('aes-256-gcm', chave(), iv);
  const corpo = Buffer.concat([cifra.update(String(texto), 'utf8'), cifra.final()]);
  const tag = cifra.getAuthTag();
  return [ROTULO, iv.toString('base64url'), tag.toString('base64url'), corpo.toString('base64url')].join(':');
}

// null quando não dá para abrir (formato estranho, chave trocada, adulterado)
// — nunca lança: quem chama decide o que "ausente" significa ali.
function abrir(fechado) {
  if (!fechado) return null;
  try {
    const [rotulo, iv, tag, corpo] = String(fechado).split(':');
    if (rotulo !== ROTULO || !iv || !tag || corpo === undefined) return null;
    const decifra = crypto.createDecipheriv('aes-256-gcm', chave(), Buffer.from(iv, 'base64url'));
    decifra.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decifra.update(Buffer.from(corpo, 'base64url')), decifra.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { fechar, abrir, assinar };
