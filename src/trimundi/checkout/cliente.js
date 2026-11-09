const config = require('../config');

// Chamadas da Trimundi à API do San Checkout (API.md §5), com a chave do
// contratante da Trimundi — nunca a da Mostraí. Endereço montado só aqui
// (lição de 14/09/2026: o Checkout tem dois endereços e eles não se trocam).
// Os testes trocam a implementação por um dublê (`substituir`).

let substituto = null;
function substituir(dubles) {
  substituto = dubles;
}

async function chamar(metodo, rota, corpo) {
  const ck = config.checkout();
  if (!ck.configurado) {
    const err = new Error('San Checkout não configurado para a Trimundi');
    err.naoConfigurado = true;
    throw err;
  }
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), 15000);
  try {
    const r = await fetch(`${ck.apiUrl}/api/checkout/${rota}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'X-Checkout-Key': ck.chave },
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controle.signal,
      redirect: 'manual',
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, ok: r.ok, corpo: json };
  } finally {
    clearTimeout(prazo);
  }
}

// §5.2 — conciliação de um pedido avulso.
async function consultarCobranca(pedidoId) {
  if (substituto?.consultarCobranca) return substituto.consultarCobranca(pedidoId);
  const ck = config.checkout();
  return chamar('GET', `cobranca/${encodeURIComponent(ck.contratanteId)}/${encodeURIComponent(pedidoId)}`);
}

// §5.4 — estorno total ou parcial, sempre com a nossa chave de idempotência.
async function estornar(dados) {
  if (substituto?.estornar) return substituto.estornar(dados);
  if (!config.checkout().configurado && config.pagamentoSimulado()) {
    return require('./simulador').estornarSimulado(dados);
  }
  return chamar('POST', 'estornar', dados);
}

module.exports = { substituir, consultarCobranca, estornar };
