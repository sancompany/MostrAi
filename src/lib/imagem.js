// O tipo REAL de uma imagem enviada, pelos primeiros bytes (assinatura do
// formato) — nunca pelo nome do arquivo nem pelo Content-Type que o
// navegador declarou. O bucket é público: um .html renomeado para .jpg não
// pode ir para lá. Só os três formatos que os navegadores mostram em
// qualquer card: JPEG, PNG e WebP. `null` = não é uma imagem aceita.
function tipoDaImagem(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

const EXTENSAO = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

module.exports = { tipoDaImagem, EXTENSAO };
