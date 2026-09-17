const pool = require('../db/pool');

// TROCA DE MODALIDADE DO COMODATO (decisão do dono, 17/09/2026).
//
// Quem cede a parede escolhe entre receber R$ 50 por mês ou trocar esses
// R$ 50 por tela. A troca tem MÃO ÚNICA no autoatendimento:
//
//   receber R$ 50  ->  trocar por tela   o dono do ponto faz quando quiser
//   trocar por tela ->  receber R$ 50    só o admin faz
//
// A assimetria não é capricho. Abrir mão do dinheiro não custa nada à
// Mostraí — ela para de pagar e o comerciante ganha mais tela, então pode ser
// imediato e sem pedir licença. Voltar a receber é despesa nova, recorrente,
// e entra no caixa do mês: passa pela mão do dono. Sem essa trava, dava pra
// pingar entre as duas modalidades todo mês e sacar a ajuda de custo nos
// meses em que ela valesse mais, o que ninguém concilia.
//
// Tudo aqui roda na MESMA transação de quem chamou: modalidade trocada e
// contrapartida ajustada são um ato só. Metade aplicada é um comerciante
// que deixou de receber R$ 50 e não ganhou a tela.

// O crédito vale o MAIOR entre os pontos da conta, nunca a soma — dono de
// três pontos tem crédito de R$ 50, não de R$ 150. Recalcular a partir dos
// pontos (em vez de somar ou subtrair no lugar) é o que faz a troca funcionar
// nos dois sentidos sem deixar resto: quem volta pra ajuda de custo perde o
// crédito no mesmo cálculo que o deu.
async function recalcularCredito(contaId, db) {
  await db.query(
    `UPDATE anunciantes a
        SET credito_comodato_mensal = COALESCE((
              SELECT MAX(pp.desconto_assinatura_reais)
                FROM pontos p
                JOIN planos_ponto pp ON pp.id = p.plano_ponto_id
               WHERE p.anunciante_id = a.id
            ), 0)
      WHERE a.id = $1`,
    [contaId],
  );
}

// O plano incluído só é trocado quando o que está lá é O PLANO DO COMODATO.
// Conta que assinou Destaque com o próprio dinheiro não pode ter a assinatura
// substituída por um plano de cortesia porque trocou de modalidade — seria
// apagar o que ela paga.
async function ajustarPlanoIncluido(contaId, opcao, db) {
  if (!opcao?.plano_incluido_id) return;
  await db.query(
    `UPDATE anunciantes
        SET plano_id = $2, plano_cortesia = true, cortesia_motivo = 'comodato'
      WHERE id = $1
        AND (plano_id IS NULL OR (plano_cortesia AND cortesia_motivo = 'comodato'))`,
    [contaId, opcao.plano_incluido_id],
  );
}

// Aplica uma modalidade a UM ponto e acerta a conta do dono dele.
async function aplicarModalidade(pontoId, opcaoId, db = pool) {
  const { rows: pts } = await db.query('SELECT id, anunciante_id FROM pontos WHERE id = $1', [pontoId]);
  const ponto = pts[0];
  if (!ponto) return null;

  const { rows: ops } = await db.query('SELECT * FROM planos_ponto WHERE id = $1', [opcaoId]);
  const opcao = ops[0];
  if (!opcao) return null;

  await db.query(
    `UPDATE pontos
        SET plano_ponto_id = $2, valor_pago_mensal = $3, cota_autoanuncio_slots_hora = $4
      WHERE id = $1`,
    [ponto.id, opcao.id, opcao.ajuda_custo_mensal, opcao.cota_slots_hora],
  );

  if (ponto.anunciante_id) {
    await ajustarPlanoIncluido(ponto.anunciante_id, opcao, db);
    await recalcularCredito(ponto.anunciante_id, db);
  }
  return opcao;
}

// A modalidade que o dono do ponto pode escolher sozinho: a que NÃO paga
// dinheiro. Descoberta por dado (`ajuda_custo_mensal = 0`), não por id fixo —
// se o dono renomear ou recriar as opções no admin, isto continua certo.
async function modalidadeSemDinheiro(db = pool) {
  const { rows } = await db.query(
    'SELECT * FROM planos_ponto WHERE ativo AND ajuda_custo_mensal = 0 ORDER BY ordem, id LIMIT 1',
  );
  return rows[0] || null;
}

module.exports = { aplicarModalidade, recalcularCredito, modalidadeSemDinheiro };
