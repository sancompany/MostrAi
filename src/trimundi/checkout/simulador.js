const crypto = require('node:crypto');
const config = require('../config');
const v = require('../lib/validacao');
const { erro } = require('../lib/erros');
const { consultar } = require('../db/conexao');
const pagamentos = require('../pagamentos');
const { assinar, assinaturaValida, chaveDoWebhook } = require('./webhook');

// Pagamento SIMULADO — só fora de produção e só com
// TRIMUNDI_PAGAMENTO_SIMULADO=1. Monta o mesmo aviso v2 que o Checkout
// mandaria (API.md §4.3.3), assina com a chave do webhook e passa pela
// mesma conferência de assinatura, fila e aplicação. O evento fica com o
// provedor 'simulado': nunca se confunde com pagamento real.

function exigirSimulado() {
  if (!config.pagamentoSimulado()) throw erro(404, 'não encontrado');
}

function montarAviso(pedido, status, extra = {}) {
  const total = Number(pedido.total_centavos) / 100;
  return {
    versao: 2,
    tipo: 'pedido',
    eventoId: crypto.randomUUID(),
    ocorridoEm: new Date().toISOString(),
    pedidoId: pedido.id,
    chargeId: pedido.charge_id || `sim_${crypto.randomBytes(6).toString('hex')}`,
    status,
    statusFinanceiro: status,
    valorCheio: total,
    desconto: 0,
    cupom: null,
    valorComDesconto: extra.valorComDesconto ?? total,
    frete: 0,
    taxaDoProjeto: 0,
    taxaAsaas: 0,
    taxaPropria: 0,
    taxaIsenta: false,
    taxasTotais: 0,
    metodoPagamento: 'pix',
    valorCobrado: total,
    valorEstornado: extra.valorEstornado ?? null,
    estornoParcial: status === 'estornado_parcialmente',
    cotacaoId: null,
    pagamentoDuplicado: false,
    duplicadoCom: [],
  };
}

async function simular(pedidoId, status, extra = {}) {
  exigirSimulado();
  const id = v.uuid(pedidoId);
  const { rows } = await consultar('SELECT * FROM pedidos WHERE id = $1', [id]);
  if (!rows[0]) throw erro(404, 'pedido não encontrado');
  const aviso = montarAviso(rows[0], status, extra);
  const corpo = JSON.stringify(aviso);
  const ts = String(Math.floor(Date.now() / 1000));
  const chave = chaveDoWebhook();
  if (!assinaturaValida(Buffer.from(corpo), ts, assinar(chave, ts, corpo), chave)) {
    throw new Error('assinatura simulada não conferiu');
  }
  await pagamentos.registrarEvento({ eventoId: aviso.eventoId, provedor: 'simulado', payload: aviso });
  await pagamentos.processarFila();
  const { rows: depois } = await consultar('SELECT status, pagamento_recusado_em FROM pedidos WHERE id = $1', [id]);
  return {
    status: depois[0].status,
    recusado: depois[0].status === 'aguardando_pagamento' && Boolean(depois[0].pagamento_recusado_em),
  };
}

// Estorno simulado: responde como o Checkout e, logo depois, manda o aviso
// de estorno (total ou parcial) pelo mesmo caminho.
async function estornarSimulado({ pedidoId, valor }) {
  exigirSimulado();
  const { rows } = await consultar(
    `SELECT p.total_centavos,
            COALESCE((SELECT sum(valor_centavos) FROM reembolsos WHERE pedido_id = p.id AND status = 'confirmado'), 0)::bigint AS ja
       FROM pedidos p WHERE p.id = $1`,
    [pedidoId],
  );
  if (!rows[0]) return { status: 404, ok: false, corpo: { erro: 'pedido não encontrado' } };
  const total = Number(rows[0].total_centavos);
  // Sem `valor` é o estorno total (API.md §5.4): devolve tudo o que falta.
  const acumulado =
    valor === undefined || valor === null ? total : Number(rows[0].ja) + Math.round(Number(valor) * 100);
  const parcial = acumulado < total;
  setTimeout(() => {
    simular(pedidoId, parcial ? 'estornado_parcialmente' : 'estornado', { valorEstornado: acumulado / 100 }).catch(
      (err) => console.error('trimundi: estorno simulado falhou:', err.message),
    );
  }, 300);
  return { status: 200, ok: true, corpo: { ok: true, simulado: true } };
}

module.exports = { simular, estornarSimulado, montarAviso, exigirSimulado };
