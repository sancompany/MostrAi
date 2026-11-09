const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { derivar } = require('./chaves');

// QR do ingresso (RN-T23): `TM1.<código público da edição>.<código>.<assinatura>`.
// Assinatura Ed25519 com uma chave por edição, derivada do segredo-mestre —
// o check-in pode validar sem internet com a chave pública da edição, e o
// QR não carrega CPF, nome nem e-mail (regra dura 9).
const PREFIXO_PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const FORMATO = /^TM1\.([A-Za-z0-9_-]{10,40})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{86})$/;

const pares = new Map();
function parDaEdicao(codigoPublico) {
  let par = pares.get(codigoPublico);
  if (!par) {
    const semente = crypto.createHmac('sha256', derivar('qr-ed25519')).update(codigoPublico).digest();
    const privada = crypto.createPrivateKey({
      key: Buffer.concat([PREFIXO_PKCS8_ED25519, semente]),
      format: 'der',
      type: 'pkcs8',
    });
    par = { privada, publica: crypto.createPublicKey(privada) };
    if (pares.size > 500) pares.clear();
    pares.set(codigoPublico, par);
  }
  return par;
}

function conteudoDoQr(codigoPublico, codigo) {
  const base = `TM1.${codigoPublico}.${codigo}`;
  const assinatura = crypto.sign(null, Buffer.from(base), parDaEdicao(codigoPublico).privada).toString('base64url');
  return `${base}.${assinatura}`;
}

// Devolve { codigoPublico, codigo } só se o formato e a assinatura conferem;
// qualquer outra coisa é null (QR falso, cortado, de outro sistema).
function lerQr(texto) {
  const m = FORMATO.exec(String(texto ?? '').trim());
  if (!m) return null;
  const [, codigoPublico, codigo, assinatura] = m;
  let ok = false;
  try {
    ok = crypto.verify(
      null,
      Buffer.from(`TM1.${codigoPublico}.${codigo}`),
      parDaEdicao(codigoPublico).publica,
      Buffer.from(assinatura, 'base64url'),
    );
  } catch {
    ok = false;
  }
  return ok ? { codigoPublico, codigo } : null;
}

function chavePublicaDaEdicao(codigoPublico) {
  return parDaEdicao(codigoPublico).publica.export({ format: 'der', type: 'spki' }).toString('base64url');
}

const OPCOES = { errorCorrectionLevel: 'M', margin: 1 };
const qrDataUrl = (conteudo) => QRCode.toDataURL(conteudo, { ...OPCOES, width: 320 });
const qrPng = (conteudo) => QRCode.toBuffer(conteudo, { ...OPCOES, width: 640 });
const qrSvg = (conteudo) => QRCode.toString(conteudo, { ...OPCOES, type: 'svg' });

module.exports = { conteudoDoQr, lerQr, chavePublicaDaEdicao, qrDataUrl, qrPng, qrSvg };
