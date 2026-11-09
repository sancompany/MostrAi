// Histórico do Admin (RN-T29), histórico do ingresso e eventos de medição
// (D1). Gravados pelo MESMO cliente da transação da ação: se a ação desfaz,
// o registro desfaz junto. Nenhum dos três leva dado pessoal.

function autorDaRequisicao(req) {
  const { operadorDaRequisicao } = require('../../lib/operador');
  const { operador, operadorAccess } = operadorDaRequisicao(req);
  return { autor: String(operador).slice(0, 200), autorAccess: operadorAccess };
}

async function auditar(cliente, autor, acao, entidade, entidadeId, detalhe = {}) {
  await cliente.query(
    `INSERT INTO auditoria (autor, autor_access, acao, entidade, entidade_id, detalhe)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      autor?.autor || 'sistema',
      autor?.autorAccess || null,
      acao,
      entidade,
      entidadeId ? String(entidadeId) : null,
      detalhe,
    ],
  );
}

async function historicoDoIngresso(cliente, ingressoId, tipo, { motivo = null, autor = null } = {}) {
  await cliente.query('INSERT INTO ingresso_historico (ingresso_id, tipo, motivo, autor) VALUES ($1, $2, $3, $4)', [
    ingressoId,
    tipo,
    motivo ? String(motivo).slice(0, 300) : null,
    autor ? String(autor).slice(0, 200) : null,
  ]);
}

async function medir(cliente, nome, edicaoId, propriedades = {}) {
  await cliente.query('INSERT INTO metricas (nome, edicao_id, propriedades) VALUES ($1, $2, $3)', [
    nome,
    edicaoId || null,
    propriedades,
  ]);
}

module.exports = { autorDaRequisicao, auditar, historicoDoIngresso, medir };
