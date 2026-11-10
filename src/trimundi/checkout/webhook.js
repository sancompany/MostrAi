const crypto = require('node:crypto');
const config = require('../config');
const { derivar } = require('../lib/chaves');
const pagamentos = require('../pagamentos');

// Webhook do San Checkout para a Trimundi (API.md §4.3). Fechado na falha:
// sem chave, nada passa. A assinatura é HMAC-SHA256 com a MESMA chave do
// contratante sobre "{timestamp}.{corpo cru}", com janela de 300 s e
// comparação em tempo constante (CONSTRAINTS da Mostraí, regras duras).

// Em desenvolvimento com pagamento simulado e sem Checkout configurado, a
// chave é derivada do segredo-mestre — o simulador assina com ela e o
// aviso passa pela mesma conferência.
function chaveSimulada() {
  return derivar('checkout-simulado').toString('hex');
}

function chaveDoWebhook() {
  const ck = config.checkout();
  if (ck.chave) return ck.chave;
  if (config.pagamentoSimulado()) return chaveSimulada();
  return null;
}

function provedor() {
  return config.checkout().chave ? 'san_checkout' : 'simulado';
}

function assinar(chave, timestamp, corpoCru) {
  return `sha256=${crypto.createHmac('sha256', chave).update(`${timestamp}.${corpoCru}`).digest('hex')}`;
}

function assinaturaValida(corpoCru, timestamp, assinatura, chave, agoraMs = Date.now()) {
  if (!chave || !corpoCru) return false;
  const ts = Number(timestamp);
  if (!/^\d{9,11}$/.test(String(timestamp ?? '')) || Math.abs(Math.floor(agoraMs / 1000) - ts) > 300) return false;
  const esperada = Buffer.from(assinar(chave, timestamp, corpoCru.toString('utf8')));
  const recebida = Buffer.from(String(assinatura ?? ''));
  return esperada.length === recebida.length && crypto.timingSafeEqual(esperada, recebida);
}

// Grava o aviso (inbox) e responde 200 rápido; o efeito roda depois, na fila.
async function receber(req, res) {
  const chave = chaveDoWebhook();
  if (!chave) return res.status(401).json({ erro: 'webhook não configurado' });
  if (!assinaturaValida(req.rawBody, req.get('X-Checkout-Timestamp'), req.get('X-Checkout-Signature'), chave)) {
    return res.status(401).json({ erro: 'assinatura inválida' });
  }
  let corpo;
  try {
    corpo = JSON.parse(req.rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ erro: 'JSON inválido' });
  }
  // A Trimundi não vende assinatura: aviso de assinatura é ignorado com 200.
  if (corpo?.tipo === 'assinatura') return res.json({ ok: true, ignorado: true });
  const eventoId =
    corpo?.eventoId ||
    req.get('X-Checkout-Event-Id') ||
    (corpo?.chargeId && corpo?.status ? `v1:${corpo.pedidoId}:${corpo.chargeId}:${corpo.status}` : null);
  if (!eventoId) return res.json({ ok: true, ignorado: true });
  await pagamentos.registrarEvento({ eventoId, provedor: provedor(), payload: corpo });
  res.json({ ok: true });
  setImmediate(() =>
    pagamentos.processarFila().catch((err) => console.error('trimundi: fila de pagamento:', err.message)),
  );
}

module.exports = { receber, assinaturaValida, assinar, chaveDoWebhook, provedor };
