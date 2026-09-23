const pool = require('../db/pool');

// Ledger de créditos (migration 079). Toda escrita é uma linha nova e
// imutável — nunca um UPDATE de saldo. O saldo é sempre SOMA(quantidade),
// recalculado na leitura (mesmo raciocínio de `cobrancas_confirmadas`: a
// verdade é a soma dos eventos, nunca um contador à parte que pode
// dessincronizar).

// Crédito de indicação — chamado de dentro da transação do ciclo pago
// (san-checkout.js#aplicarCicloPago), com o `db` da própria transação.
// Idempotente por `cobranca_confirmada_id` (índice único parcial da
// migration 079): a mesma cobrança nunca gera duas linhas, mesmo que o
// webhook chegue duplicado ou a conciliação diária reprocesse. Decide
// sozinho se é o primeiro crédito desse indicado ou uma renovação, olhando
// se já existe alguma linha de indicação pra esse par (ponto, indicado) —
// cada renovação paga confirmada gera +1 crédito adicional (diferente do
// modelo antigo de indicacoes_pagas, que só contava a primeira vez).
async function registrarCreditoIndicacao(pontoContaId, indicadoContaId, cobrancaConfirmadaId, db = pool) {
  const { rows: existentes } = await db.query(
    `SELECT 1 FROM creditos_ledger
      WHERE anunciante_id = $1 AND origem_conta_id = $2
        AND tipo IN ('indicacao_primeiro_pagamento', 'indicacao_renovacao') LIMIT 1`,
    [pontoContaId, indicadoContaId],
  );
  const tipo = existentes.length ? 'indicacao_renovacao' : 'indicacao_primeiro_pagamento';
  const { rows } = await db.query(
    `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, origem_conta_id, cobranca_confirmada_id)
     VALUES ($1, $2, 1, $3, $4)
     ON CONFLICT (cobranca_confirmada_id) WHERE cobranca_confirmada_id IS NOT NULL DO NOTHING
     RETURNING *`,
    [pontoContaId, tipo, indicadoContaId, cobrancaConfirmadaId],
  );
  return rows[0] || null;
}

// Concessão do admin — substitui "Liberar plano" na Central de Contas
// (pedido do dono). Créditos genéricos, sem tier/período escolhido ainda —
// quem decide em que vira é o resgate, exatamente como créditos de
// indicação. `quantidade` sempre positiva aqui (estorno usa a função
// própria abaixo, nunca quantidade negativa direto).
async function concederAdmin(contaId, quantidade, { motivo, adminUsuario }, db = pool) {
  const qtd = Math.trunc(Number(quantidade));
  if (!Number.isFinite(qtd) || qtd <= 0)
    throw Object.assign(new Error('quantidade precisa ser um inteiro positivo'), { status: 400 });
  const { rows } = await db.query(
    `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, concedido_por, observacao)
     VALUES ($1, 'concessao_admin', $2, $3, $4) RETURNING *`,
    [contaId, qtd, adminUsuario || null, motivo || null],
  );
  return rows[0];
}

async function estornarAdmin(contaId, quantidade, { motivo, adminUsuario }, db = pool) {
  const qtd = Math.trunc(Number(quantidade));
  if (!Number.isFinite(qtd) || qtd <= 0)
    throw Object.assign(new Error('quantidade precisa ser um inteiro positivo'), { status: 400 });
  const { rows } = await db.query(
    `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, concedido_por, observacao)
     VALUES ($1, 'estorno_admin', $2, $3, $4) RETURNING *`,
    [contaId, -qtd, adminUsuario || null, motivo || null],
  );
  return rows[0];
}

// Débito do resgate — sempre dentro da mesma transação que cria o
// benefício em `planos_administrativos` (ver src/financeiro/
// plano-administrativo.js#resgatarBeneficio), pra nunca existir débito sem
// benefício nem benefício sem débito.
async function debitarResgate(contaId, quantidade, observacao, db = pool) {
  const qtd = Math.trunc(Number(quantidade));
  const { rows } = await db.query(
    `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao)
     VALUES ($1, 'resgate_beneficio', $2, $3) RETURNING *`,
    [contaId, -Math.abs(qtd), observacao || null],
  );
  return rows[0];
}

async function saldo(contaId, db = pool) {
  const { rows } = await db.query(
    'SELECT COALESCE(SUM(quantidade), 0)::int AS n FROM creditos_ledger WHERE anunciante_id = $1',
    [contaId],
  );
  return rows[0].n;
}

// Movimentações recentes pra tela "Créditos e benefícios" — nome de quem
// indicou quando for o caso.
async function movimentacoes(contaId, limite = 50, db = pool) {
  const { rows } = await db.query(
    `SELECT l.*, o.nome_empresa AS origem_nome
       FROM creditos_ledger l LEFT JOIN anunciantes o ON o.id = l.origem_conta_id
      WHERE l.anunciante_id = $1
      ORDER BY l.criado_em DESC, l.id DESC LIMIT $2`,
    [contaId, limite],
  );
  return rows;
}

// Toda conta com QUALQUER linha no ledger — usada pela reavaliação diária
// (não é o mesmo uso de antes: hoje o saldo nunca aplica sozinho, só
// alimenta a tela; a reavaliação diária é só pra ativar benefício agendado
// e encerrar o vencido, ver plano-administrativo.js).
async function listarContasComMovimentacao(db = pool) {
  const { rows } = await db.query('SELECT DISTINCT anunciante_id FROM creditos_ledger');
  return rows.map((r) => r.anunciante_id);
}

module.exports = {
  registrarCreditoIndicacao,
  concederAdmin,
  estornarAdmin,
  debitarResgate,
  saldo,
  movimentacoes,
  listarContasComMovimentacao,
};
