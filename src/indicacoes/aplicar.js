const pool = require('../db/pool');
const anunciantesRepo = require('../anunciantes/repository');
const planosRepo = require('../financeiro/planos-repository');
const repo = require('./repository');
const { tierElegivel } = require('./regras');
const comodato = require('../pontos/comodato');

const ORDEM_TIER = ['essencial', 'destaque', 'maximo'];

// Aplica o upgrade de tier ganho por indicação, se a conta estiver livre pra
// cortesia (sem plano, ou já em algum plano de cortesia) — nunca sobrescreve
// cobertura PAGA (mesma cautela de POST /admin/anunciantes/:id/liberar-plano,
// em src/financeiro/routes.js, e de ajustarPlanoIncluido em
// src/pontos/comodato.js). Quando a conta está pagando o próprio plano, o
// crédito já ficou contado pra sempre em indicacoes_pagas (migration 062) —
// quem reavalia depois que o plano pago vencer é a apuração diária
// (scripts/conciliar.js), chamando esta mesma função de novo.
//
// Recebe `db` porque o webhook de pagamento chama isto de dentro da própria
// transação da cobrança — upgrade e crédito entram juntos, ou nenhum dos
// dois. A apuração diária chama sem transação, e `db` cai no pool.
async function aplicarUpgradeSeElegivel(pontoContaId, db = pool) {
  const creditos = await repo.contarCreditos(pontoContaId, db);
  const tierAlvo = tierElegivel(creditos);
  if (!tierAlvo) return null;

  const conta = await anunciantesRepo.buscarPorId(pontoContaId);
  if (!conta) return null;

  // `conta.plano_id` é só plano COMERCIAL desde 23/09/2026 (migration 077,
  // separação de comodato) — antes precisava excluir os ids de comodato daqui
  // à mão (`idsDePlanosDeComodato`) pra não confundir Inicial/Básico com um
  // Essencial de verdade; agora `plano_id` nunca é um produto de comodato,
  // então o tier lido aqui já é sempre o comercial, sem filtro nenhum.
  const planoAtual = conta.plano_id ? await planosRepo.buscarPorId(conta.plano_id) : null;
  const tierAtual = planoAtual ? planoAtual.tier : null;
  // Já está no tier alvo ou acima dele — nada a fazer (nunca rebaixa).
  if (tierAtual && ORDEM_TIER.indexOf(tierAtual) >= ORDEM_TIER.indexOf(tierAlvo)) return null;
  // A mesma trava de qualquer concessão de plano comercial (upgrade por
  // indicação também concede um plano de verdade) — conta em Inicial espera
  // até trocar de modalidade; a reavaliação diária tenta de novo sozinha
  // (`reavaliarTodos`), sem perder o crédito já acumulado.
  if (await comodato.bloqueiaPlanoComercial(pontoContaId, db)) return null;

  // "Livre pra cortesia" é o oposto de "pagando cobertura em dia" — mesma
  // conta de temPlanoPagoAtivo em public/anunciante/painel.page.js e do gate
  // de POST /anunciantes/me/trocar-plano. Plano_id sozinho não basta: uma
  // conta que pagou e cuja cobertura já venceu ainda tem plano_id preenchido
  // (nada nesse projeto zera o campo na expiração — outras telas leem
  // data_expiracao pra saber se está ativo), e sem checar a data aqui o
  // crédito ficaria PRESO pra sempre depois que o dono parasse de pagar.
  const pagandoEmDia =
    conta.plano_id && !conta.plano_cortesia && conta.data_expiracao && new Date(conta.data_expiracao) > new Date();
  if (pagandoEmDia) return null;

  // Mantém o ciclo que a conta já tinha (1 mês pra quem ainda não tem plano
  // nenhum — mesmo padrão do comodato).
  const cicloAlvo = planoAtual?.compromisso_meses || 1;
  const planoNovo = await repo.buscarPlanoAtivoDoTier(tierAlvo, cicloAlvo, db);
  if (!planoNovo) return null;

  // Mesma condição de `pagandoEmDia` acima, como trava atômica no próprio
  // UPDATE: entre a leitura e aqui, nada nesta função mexe na conta, mas o
  // guard custa nada e é o mesmo hábito de ajustarPlanoIncluido
  // (src/pontos/comodato.js) — nunca confiar só na checagem em JS quando dá
  // pra repetir a mesma regra no WHERE.
  const { rows } = await db.query(
    `UPDATE anunciantes
        SET plano_id = $2, plano_cortesia = true, cortesia_motivo = 'indicação',
            data_inicio_cobertura = COALESCE(data_inicio_cobertura, now())
      WHERE id = $1
        AND NOT (plano_id IS NOT NULL AND NOT plano_cortesia AND data_expiracao > now())
      RETURNING *`,
    [pontoContaId, planoNovo.id],
  );
  return rows[0] || null;
}

// Reavaliação diária (scripts/conciliar.js, junto da conciliação de
// assinaturas): pega toda conta que já tem crédito e tenta aplicar de novo.
// É onde o upgrade que ficou pendente por causa de plano pago entra sozinho,
// assim que esse plano vencer — aplicarUpgradeSeElegivel já sabe não fazer
// nada quando não há nada a fazer (tier já concedido, ainda pagando, ou
// crédito insuficiente), então rodar pra todo mundo todo dia é seguro e
// barato: a rede tem poucos pontos.
async function reavaliarTodos() {
  const contas = await repo.listarContasComCredito();
  let aplicados = 0;
  for (const contaId of contas) {
    const resultado = await aplicarUpgradeSeElegivel(contaId);
    if (resultado) aplicados += 1;
  }
  return { verificadas: contas.length, aplicados };
}

module.exports = { aplicarUpgradeSeElegivel, reavaliarTodos };
