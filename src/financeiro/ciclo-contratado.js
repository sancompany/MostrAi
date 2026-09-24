const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const { horasDeTelaPorMes, exibicoesPorMes } = require('../lib/pacing');
const { nomeDoCiclo } = require('../lib/ciclos');

// Snapshot comercial de cada ciclo PAGO (migration 087, ADR-018) e o custo
// por exibição prevista que sai dele:
//
//   custo por exibição prevista = valor contratado no ciclo
//                                 ÷ exibições previstas no ciclo
//
// Nasce da contratação e não se mexe mais: não olha exibição realizada
// (proof-of-play), nem preço atual do admin, nem duração média dos criativos
// da conta. Só uma nova compra, troca ou renovação grava outro ciclo.

// Régua canônica da vitrine (GET /planos → `exibicoes_por_mes`): horas de
// tela do plano ÷ duração máxima da peça do plano.
function exibicoesPrevistasMes(plano) {
  if (!plano) return 0;
  return exibicoesPorMes(
    horasDeTelaPorMes(plano.segundos_por_hora, plano.pontos_incluidos),
    plano.duracao_maxima_segundos,
  );
}

// `valorCiclo` é o que foi (ou será, na troca) de fato cobrado pelo ciclo
// inteiro — quem chama passa o mesmo número que foi pra cobrança
// (`valorMensalDaConta × meses`: preço-base → desconto do ciclo ou promoção
// travada na assinatura → desconto de parceiro). Nunca recalculado aqui.
async function registrar(db, { anuncianteId, plano, assinaturaId = null, cobrancaId = null, origem, valorCiclo }) {
  const meses = Number(plano.compromisso_meses);
  const mes = exibicoesPrevistasMes(plano);
  const { rows } = await db.query(
    `INSERT INTO ciclos_contratados (anunciante_id, plano_id, assinatura_id, cobranca_confirmada_id, origem,
                                     ciclo_meses, valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [anuncianteId, plano.id, assinaturaId, cobrancaId, origem, meses, valorCiclo, mes, mes * meses],
  );
  return rows[0];
}

// Compra ou renovação: é compra se esta assinatura ainda não tem ciclo
// nenhum registrado (a troca grava o primeiro ciclo da assinatura nova, então
// o pagamento seguinte dela já é renovação).
async function origemDoCicloPago(db, assinaturaId) {
  if (!assinaturaId) return 'compra';
  const { rows } = await db.query('SELECT 1 FROM ciclos_contratados WHERE assinatura_id = $1 LIMIT 1', [assinaturaId]);
  return rows.length ? 'renovacao' : 'compra';
}

// Nunca divide por zero: plano sem exibição prevista (ou snapshot corrompido)
// não tem custo por exibição — devolve null, a tela mostra "-".
function custoPorExibicaoPrevista(ciclo) {
  if (!ciclo) return null;
  const valor = Number(ciclo.valor_ciclo);
  const exibicoes = Number(ciclo.exibicoes_previstas_ciclo);
  if (!(exibicoes > 0) || !(valor > 0)) return null;
  return valor / exibicoes;
}

// O que o card "Custo por exibição prevista" mostra pra conta AGORA:
//   · pago     → o snapshot do ciclo do plano pago em vigor;
//   · beneficio → benefício por créditos em vigor — sem valor monetário;
//   · cortesia → cortesia administrativa legada — sem cobrança;
//   · sem_plano / sem_snapshot → "-" (nada inventado).
// Benefício e cortesia NUNCA mostram R$ 0,00: não há dinheiro envolvido.
async function situacaoDoCusto(conta, db = pool) {
  if (!conta?.plano_id) return { tipo: 'sem_plano' };
  if (vigencia.coberturaVencida(conta.data_expiracao)) {
    return { tipo: 'sem_plano' };
  }
  if (conta.plano_cortesia) {
    const { rows } = await db.query(
      `SELECT origem FROM planos_administrativos
        WHERE anunciante_id = $1 AND status = 'ativo' AND plano_id = $2
        ORDER BY id DESC LIMIT 1`,
      [conta.id, conta.plano_id],
    );
    return { tipo: rows[0]?.origem === 'indicacao' ? 'beneficio' : 'cortesia' };
  }
  const { rows } = await db.query(
    `SELECT c.*, p.nome AS plano_nome
       FROM ciclos_contratados c JOIN planos p ON p.id = c.plano_id
      WHERE c.anunciante_id = $1 AND c.plano_id = $2
      ORDER BY c.id DESC LIMIT 1`,
    [conta.id, conta.plano_id],
  );
  const ciclo = rows[0];
  if (!ciclo) return { tipo: 'sem_snapshot' };
  return {
    tipo: 'pago',
    custoPorExibicaoPrevista: custoPorExibicaoPrevista(ciclo),
    valorCiclo: Number(ciclo.valor_ciclo),
    exibicoesPrevistasCiclo: ciclo.exibicoes_previstas_ciclo,
    exibicoesPrevistasMes: ciclo.exibicoes_previstas_mes,
    cicloMeses: ciclo.ciclo_meses,
    ciclo: nomeDoCiclo(ciclo.ciclo_meses),
    plano: `${ciclo.plano_nome} · ${nomeDoCiclo(ciclo.ciclo_meses)}`,
    origem: ciclo.origem,
    desde: ciclo.criado_em,
  };
}

// A assinatura já teve algum ciclo PAGO? Duas fontes, porque o backfill da
// migration 087 gravou os ciclos antigos ligados só à cobrança
// (`cobranca_confirmada_id`), sem `assinatura_id` — olhar só a coluna
// direta tratava assinatura paga antes de 087 como "nunca pagou" (revisão
// Codex do PR #56). Legado = ciclo sem assinatura_id, da mesma conta e do
// mesmo plano, cobrado depois de a assinatura nascer.
async function jaTeveCicloPago(assinatura, db = pool) {
  const { rows } = await db.query(
    `SELECT 1
       FROM ciclos_contratados c
       LEFT JOIN cobrancas_confirmadas cc ON cc.id = c.cobranca_confirmada_id
      WHERE c.assinatura_id = $1
         OR (c.assinatura_id IS NULL AND cc.anunciante_id = $2 AND cc.plano_id = $3 AND cc.criado_em >= $4)
      LIMIT 1`,
    [assinatura.id, assinatura.anunciante_id, assinatura.plano_id, assinatura.created_at],
  );
  return rows.length > 0;
}

module.exports = {
  exibicoesPrevistasMes,
  registrar,
  origemDoCicloPago,
  jaTeveCicloPago,
  custoPorExibicaoPrevista,
  situacaoDoCusto,
};
