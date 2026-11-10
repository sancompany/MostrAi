const { consultar } = require('../db/conexao');
const pagamentos = require('../pagamentos');
const cliente = require('./cliente');

// Conciliação diária (API.md §5.2 e §4.3.6): pergunta ao Checkout por todo
// pedido que ainda espera um fato do nosso lado — aguardando/expirado recente
// (pagamento cujo aviso se perdeu) e pago com reembolso pedido e ainda não
// confirmado (estorno cujo aviso se perdeu). Pedido de teste entra também: o
// pagamento dele é real. A resposta do Checkout é a correta (ele reconsulta a
// Asaas); o fato entra pela MESMA fila dos avisos, com evento_id próprio da
// conciliação — reaplicar não duplica nada.
async function conciliarPendentes({ dias = 2 } = {}) {
  const { rows } = await consultar(
    `SELECT p.id FROM pedidos p
      WHERE (p.status IN ('aguardando_pagamento', 'expirado') AND p.criado_em > now() - make_interval(days => $1))
         OR (p.status IN ('pago', 'pago_sem_vaga') AND EXISTS (
               SELECT 1 FROM reembolsos r WHERE r.pedido_id = p.id AND r.status = 'solicitado'
                 AND r.criado_em > now() - interval '30 days'))
      ORDER BY p.criado_em`,
    [dias],
  );
  let encontrados = 0;
  for (const p of rows) {
    let r;
    try {
      r = await cliente.consultarCobranca(p.id);
    } catch (err) {
      if (err.naoConfigurado) return { pedidos: rows.length, encontrados, configurado: false };
      console.error(`trimundi: conciliação do pedido ${p.id.slice(0, 8)} falhou:`, err.message);
      continue;
    }
    if (r.status !== 200 || !r.corpo?.status || !r.corpo?.chargeId) continue;
    const { novo } = await pagamentos.registrarEvento({
      eventoId: `conciliacao:${p.id}:${r.corpo.chargeId}:${r.corpo.status}`,
      provedor: 'conciliacao',
      payload: { ...r.corpo, pedidoId: p.id },
    });
    if (novo) encontrados += 1;
  }
  await pagamentos.processarFila();
  return { pedidos: rows.length, encontrados, configurado: true };
}

if (require.main === module) {
  require('dotenv').config();
  conciliarPendentes()
    .then(async (r) => {
      console.log(
        `trimundi: conciliação — ${r.pedidos} pedido(s) olhados, ${r.encontrados} fato(s) novo(s)${r.configurado ? '' : ' (Checkout não configurado)'}`,
      );
      await require('../db/conexao').encerrar();
    })
    .catch(async (err) => {
      console.error('trimundi: conciliação falhou:', err.message);
      await require('../db/conexao')
        .encerrar()
        .catch(() => {});
      process.exit(1);
    });
}

module.exports = { conciliarPendentes };
