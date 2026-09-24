const { randomUUID } = require('node:crypto');
const pool = require('../db/pool');

// `promocao*` (rodada de Ofertas/Promoções, 22/09/2026) — snapshot travado
// no instante da adesão, não referência viva. Quem chama já resolveu a
// condição vigente antes (ver promocoesRepo#condicaoVigente em
// financeiro/routes.js); esta função só grava o que recebeu.
//
// Nasce 'pendente_pagamento' (migration 089, consolidação 24/09/2026): o
// link foi gerado, ninguém pagou ainda. Vira 'ativa' com o primeiro ciclo
// pago (aplicarCicloPago) — nunca pelo navegador voltar do Checkout.
async function criar({ anuncianteId, planoId, status, promocaoId, promocaoDescontoPercentual, promocaoValidoAte }) {
  const id = randomUUID();
  const { rows } = await pool.query(
    `INSERT INTO assinaturas (id, anunciante_id, plano_id, status, promocao_id, promocao_desconto_percentual, promocao_valido_ate)
     VALUES ($1,$2,$3, COALESCE($4, 'pendente_pagamento'), $5, $6, $7) RETURNING *`,
    [
      id,
      anuncianteId,
      planoId,
      status || null,
      promocaoId || null,
      promocaoDescontoPercentual || null,
      promocaoValidoAte || null,
    ],
  );
  return rows[0];
}

async function buscarPorId(id) {
  const { rows } = await pool.query('SELECT * FROM assinaturas WHERE id = $1', [id]);
  return rows[0] || null;
}

async function marcarCancelada(id) {
  const { rows } = await pool.query(`UPDATE assinaturas SET status = 'cancelada' WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

// Troca de plano pelo Checkout (migration 056): a linha nova nasce
// 'pendente_troca' — só existe pra o Checkout ler o plano de destino antes
// de cobrar o acerto (ver montarRespostaPlano). 'excluir' desfaz uma
// tentativa que o Checkout recusou (nunca existiu de verdade pro
// anunciante); 'marcarTrocada'/'marcarAtiva' são o par que acontece junto,
// só depois de a troca confirmar.
async function excluir(id) {
  await pool.query(`DELETE FROM assinaturas WHERE id = $1 AND status = 'pendente_troca'`, [id]);
}

async function marcarTrocada(id, db = pool) {
  const { rows } = await db.query(`UPDATE assinaturas SET status = 'trocada' WHERE id = $1 RETURNING *`, [id]);
  return rows[0] || null;
}

async function marcarAtiva(id, db = pool) {
  const { rows } = await db.query(
    `UPDATE assinaturas SET status = 'ativa' WHERE id = $1 AND status IN ('pendente_troca', 'pendente_pagamento') RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

// Link já gerado e ainda não pago para este plano — reaproveitado por um
// segundo clique em "Assinar" (o Checkout lê a mesma linha; nada é criado
// em dobro). Só dentro de 24 h: depois disso é outra sessão de compra.
async function buscarPendenteDePagamento(anuncianteId, planoId, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM assinaturas
      WHERE anunciante_id = $1 AND plano_id = $2 AND status = 'pendente_pagamento'
        AND created_at > now() - interval '24 hours'
      ORDER BY created_at DESC LIMIT 1`,
    [anuncianteId, planoId],
  );
  return rows[0] || null;
}

async function buscarAtivaDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT * FROM assinaturas WHERE anunciante_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1`,
    [anuncianteId],
  );
  return rows[0] || null;
}

module.exports = {
  criar,
  buscarPorId,
  marcarCancelada,
  excluir,
  marcarTrocada,
  marcarAtiva,
  buscarPendenteDePagamento,
  buscarAtivaDoAnunciante,
};
