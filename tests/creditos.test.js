const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const repo = require('../src/creditos/repository');
const { custoDoBeneficio, opcoesDisponiveis } = require('../src/creditos/regras');
const planoAdministrativo = require('../src/financeiro/plano-administrativo');

// Ledger de créditos e ciclo de vida do benefício (migration 079,
// reconstrução do painel da conta, 23/09/2026). Cada teste cria as próprias
// contas, com e-mail único, pra não colidir com outra rodada da suíte.

async function contaDeTeste(prefixo, extra = {}) {
  const email = `${prefixo}-${randomUUID()}@example.com`;
  const campos = {
    nome_empresa: prefixo,
    cpf_cnpj: '11144477735',
    contato_email: email,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    papeis: '{anunciante,ponto}',
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, ${nomes.join(', ')}) VALUES (now(), ${nomes
      .map((_, i) => `$${i + 1}`)
      .join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  return rows[0];
}

async function apagarContas(ids) {
  await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = ANY($1) OR origem_conta_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = ANY($1)', [ids]);
  await pool.query('DELETE FROM anunciantes WHERE id = ANY($1)', [ids]);
}

async function cobrancaFake(anuncianteId, planoId = 'essencial-1m') {
  const { rows } = await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES ($1,$2,10) RETURNING id`,
    [anuncianteId, planoId],
  );
  return rows[0].id;
}

async function plano(id) {
  const { rows } = await pool.query('SELECT * FROM planos WHERE id = $1', [id]);
  return rows[0];
}

// ---------- regras (puro, sem banco) ----------

test('custoDoBeneficio: escada 3/7/10 × 1/3/6/12 meses, sem período inválido', () => {
  assert.strictEqual(custoDoBeneficio('essencial', 1), 3);
  assert.strictEqual(custoDoBeneficio('essencial', 12), 36);
  assert.strictEqual(custoDoBeneficio('destaque', 3), 21);
  assert.strictEqual(custoDoBeneficio('maximo', 6), 60);
  assert.strictEqual(custoDoBeneficio('maximo', 12), 120);
  assert.strictEqual(custoDoBeneficio('essencial', 2), null, 'período fora da escada não existe');
  assert.strictEqual(custoDoBeneficio('inexistente', 1), null);
});

test('opcoesDisponiveis: marca disponível conforme saldo, nunca esconde a que falta', () => {
  const opcoes = opcoesDisponiveis(5);
  const essencial1m = opcoes.find((o) => o.tier === 'essencial' && o.meses === 1);
  const prime1m = opcoes.find((o) => o.tier === 'maximo' && o.meses === 1);
  assert.strictEqual(essencial1m.disponivel, true);
  assert.strictEqual(prime1m.disponivel, false);
  assert.strictEqual(prime1m.faltam, 5); // custo 10 - saldo 5
  assert.strictEqual(opcoes.length, 12, 'as 12 combinações tier×período sempre aparecem');
});

// ---------- ledger: geração e idempotência ----------

test('registrarCreditoIndicacao: primeiro pagamento gera exatamente +1', async () => {
  const ponto = await contaDeTeste('creditos-ponto-1');
  const indicado = await contaDeTeste('creditos-indicado-1');
  try {
    const cobrancaId = await cobrancaFake(indicado.id);
    const linha = await repo.registrarCreditoIndicacao(ponto.id, indicado.id, cobrancaId);
    assert.ok(linha, 'grava a primeira linha');
    assert.strictEqual(linha.tipo, 'indicacao_primeiro_pagamento');
    assert.strictEqual(linha.quantidade, 1);
    assert.strictEqual(await repo.saldo(ponto.id), 1);
  } finally {
    await apagarContas([ponto.id, indicado.id]);
  }
});

test('registrarCreditoIndicacao: cada renovação paga confirmada gera +1 crédito adicional', async () => {
  const ponto = await contaDeTeste('creditos-ponto-2');
  const indicado = await contaDeTeste('creditos-indicado-2');
  try {
    const primeira = await cobrancaFake(indicado.id);
    await repo.registrarCreditoIndicacao(ponto.id, indicado.id, primeira);
    const segunda = await cobrancaFake(indicado.id);
    const linhaRenovacao = await repo.registrarCreditoIndicacao(ponto.id, indicado.id, segunda);
    assert.strictEqual(linhaRenovacao.tipo, 'indicacao_renovacao', 'a segunda cobrança do MESMO indicado é renovação');
    assert.strictEqual(await repo.saldo(ponto.id), 2, 'duas cobranças confirmadas = 2 créditos, não 1');
  } finally {
    await apagarContas([ponto.id, indicado.id]);
  }
});

test('registrarCreditoIndicacao: webhook duplicado (mesma cobrança) não duplica o crédito', async () => {
  const ponto = await contaDeTeste('creditos-ponto-3');
  const indicado = await contaDeTeste('creditos-indicado-3');
  try {
    const cobrancaId = await cobrancaFake(indicado.id);
    const primeira = await repo.registrarCreditoIndicacao(ponto.id, indicado.id, cobrancaId);
    const reprocessada = await repo.registrarCreditoIndicacao(ponto.id, indicado.id, cobrancaId);
    assert.ok(primeira, 'primeira chamada grava');
    assert.strictEqual(reprocessada, null, 'reprocessar a MESMA cobrança não grava de novo');
    assert.strictEqual(await repo.saldo(ponto.id), 1, 'saldo continua 1, não 2');
  } finally {
    await apagarContas([ponto.id, indicado.id]);
  }
});

// ---------- ledger: admin ----------

test('concederAdmin: grava ADMIN_GRANT positivo, soma no saldo', async () => {
  const conta = await contaDeTeste('creditos-admin-1');
  try {
    const linha = await repo.concederAdmin(conta.id, 7, { motivo: 'teste', adminUsuario: 'admin-teste' });
    assert.strictEqual(linha.tipo, 'concessao_admin');
    assert.strictEqual(linha.quantidade, 7);
    assert.strictEqual(linha.concedido_por, 'admin-teste');
    assert.strictEqual(await repo.saldo(conta.id), 7);
  } finally {
    await apagarContas([conta.id]);
  }
});

test('concederAdmin: recusa quantidade zero ou negativa', async () => {
  const conta = await contaDeTeste('creditos-admin-2');
  try {
    await assert.rejects(() => repo.concederAdmin(conta.id, 0, {}), /quantidade/);
    await assert.rejects(() => repo.concederAdmin(conta.id, -3, {}), /quantidade/);
  } finally {
    await apagarContas([conta.id]);
  }
});

test('estornarAdmin: grava débito, saldo reflete a soma', async () => {
  const conta = await contaDeTeste('creditos-admin-3');
  try {
    await repo.concederAdmin(conta.id, 10, {});
    await repo.estornarAdmin(conta.id, 4, { motivo: 'correção' });
    assert.strictEqual(await repo.saldo(conta.id), 6);
  } finally {
    await apagarContas([conta.id]);
  }
});

// ---------- ciclo de vida do benefício ----------

test('resgatarOuConcederBeneficio: sem plano pago em curso, ativa na hora', async () => {
  const conta = await contaDeTeste('beneficio-1');
  try {
    const alvo = await plano('essencial-1m');
    const { conta: atualizada, status } = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta,
      plano: alvo,
      validoAte: '2099-01-01',
      observacao: 'teste',
      origem: 'indicacao',
    });
    assert.strictEqual(status, 'ativo');
    assert.strictEqual(atualizada.plano_id, 'essencial-1m');
    assert.strictEqual(atualizada.plano_cortesia, true);
  } finally {
    await apagarContas([conta.id]);
  }
});

test('resgatarOuConcederBeneficio: ciclo pago em curso NÃO é interrompido — benefício nasce agendado', async () => {
  const contaBase = await contaDeTeste('beneficio-2');
  try {
    // Simula uma assinatura paga em dia (Pro, vence daqui a 20 dias).
    const dataFutura = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
    await pool.query(
      `UPDATE anunciantes SET plano_id='destaque-1m', plano_cortesia=false, data_expiracao=$2 WHERE id=$1`,
      [contaBase.id, dataFutura],
    );
    const { rows } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    const conta = rows[0];

    const alvo = await plano('maximo-1m');
    const { conta: atualizada, status } = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta,
      plano: alvo,
      validoAte: '2099-01-01',
      observacao: 'teste agendado',
      origem: 'indicacao',
    });
    assert.strictEqual(status, 'agendado');
    // A conta NÃO foi tocada — continua no plano pago (Pro), sem cortesia,
    // sem cobrar de novo, até o ciclo pago acabar sozinho.
    assert.strictEqual(atualizada.plano_id, 'destaque-1m');
    assert.strictEqual(atualizada.plano_cortesia, false);

    const historico = await planoAdministrativo.historicoDaConta(contaBase.id);
    const agendado = historico.find((h) => h.status === 'agendado');
    assert.ok(agendado, 'existe uma linha agendada no histórico');
    assert.strictEqual(agendado.plano_anterior_id, 'destaque-1m');
  } finally {
    await apagarContas([contaBase.id]);
  }
});

test('ativarBeneficiosAgendados: ativa só quando o ciclo pago anterior já passou', async () => {
  const contaBase = await contaDeTeste('beneficio-3');
  try {
    // Plano pago AINDA EM DIA no momento do resgate — nasce agendado.
    const futuro = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
    await pool.query(
      `UPDATE anunciantes SET plano_id='destaque-1m', plano_cortesia=false, data_expiracao=$2 WHERE id=$1`,
      [contaBase.id, futuro],
    );
    const { rows } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    const conta = rows[0];
    const alvo = await plano('maximo-1m');
    const { status } = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta,
      plano: alvo,
      validoAte: '2099-01-01',
      observacao: 'agendado vencido',
      origem: 'indicacao',
    });
    assert.strictEqual(status, 'agendado', 'nasce agendado enquanto o plano pago ainda vale');

    // O tempo passa: o ciclo pago que estava em dia agora já venceu — é o
    // que a conciliação diária encontraria sozinha no dia seguinte.
    const ontem = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    await pool.query('UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1', [contaBase.id, ontem]);

    const resultado = await planoAdministrativo.ativarBeneficiosAgendados();
    assert.ok(resultado.ativados >= 1, 'ativou pelo menos o benefício desta conta');

    const { rows: agora } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    assert.strictEqual(agora[0].plano_id, 'maximo-1m', 'a conta virou Prime');
    assert.strictEqual(agora[0].plano_cortesia, true);

    const historico = await planoAdministrativo.historicoDaConta(contaBase.id);
    const linha = historico.find((h) => h.plano_id === 'maximo-1m');
    assert.strictEqual(linha.status, 'ativo');
  } finally {
    await apagarContas([contaBase.id]);
  }
});

test('ativarBeneficiosAgendados: NÃO ativa se o ciclo pago foi renovado no meio-tempo (corrida com webhook)', async () => {
  const contaBase = await contaDeTeste('beneficio-4');
  try {
    // Plano pago em dia no momento do resgate — nasce agendado.
    const futuroPerto = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    await pool.query(
      `UPDATE anunciantes SET plano_id='destaque-1m', plano_cortesia=false, data_expiracao=$2 WHERE id=$1`,
      [contaBase.id, futuroPerto],
    );
    const { rows } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    const conta = rows[0];
    const alvo = await plano('maximo-1m');
    const { status } = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta,
      plano: alvo,
      validoAte: '2099-01-01',
      observacao: 'agendado',
      origem: 'indicacao',
    });
    assert.strictEqual(status, 'agendado');

    // Um webhook renovou a assinatura paga por mais tempo, entre o
    // agendamento e o dia em que a conciliação rodaria.
    const futuroLonge = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
    await pool.query(`UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1`, [contaBase.id, futuroLonge]);

    await planoAdministrativo.ativarBeneficiosAgendados();

    const { rows: agora } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    assert.strictEqual(agora[0].plano_id, 'destaque-1m', 'continua no plano pago renovado, não virou Prime');
    assert.strictEqual(agora[0].plano_cortesia, false);

    const historico = await planoAdministrativo.historicoDaConta(contaBase.id);
    const linha = historico.find((h) => h.plano_id === 'maximo-1m');
    assert.strictEqual(linha.status, 'agendado', 'o benefício continua esperando, não foi perdido');
  } finally {
    await apagarContas([contaBase.id]);
  }
});

test('encerrarBeneficiosVencidos: benefício vencido encerra e a conta volta pra sem plano (sem cobrança nova)', async () => {
  const conta = await contaDeTeste('beneficio-5');
  try {
    const alvo = await plano('essencial-1m');
    await planoAdministrativo.resgatarOuConcederBeneficio({
      conta,
      plano: alvo,
      validoAte: '2020-01-01', // já vencido de propósito
      observacao: 'teste',
      origem: 'indicacao',
    });

    const resultado = await planoAdministrativo.encerrarBeneficiosVencidos();
    assert.ok(resultado.encerrados >= 1);

    const { rows } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [conta.id]);
    assert.strictEqual(rows[0].plano_id, null, 'sem benefício e sem assinatura-base, a conta fica sem plano');
    assert.strictEqual(rows[0].plano_cortesia, false);

    const historico = await planoAdministrativo.historicoDaConta(conta.id);
    assert.strictEqual(historico[0].status, 'encerrado');
    assert.strictEqual(historico[0].encerrado_motivo, 'vencido');
  } finally {
    await apagarContas([conta.id]);
  }
});

test('resgatarOuConcederBeneficio: fecha o benefício anterior aberto (no máximo 1 ativo por conta)', async () => {
  const conta = await contaDeTeste('beneficio-6');
  try {
    const essencial = await plano('essencial-1m');
    const primeiro = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta,
      plano: essencial,
      validoAte: '2099-01-01',
      origem: 'indicacao',
    });
    assert.strictEqual(primeiro.status, 'ativo');

    const { rows } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [conta.id]);
    const prime = await plano('maximo-1m');
    const segundo = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta: rows[0],
      plano: prime,
      validoAte: '2099-01-01',
      origem: 'indicacao',
    });
    assert.strictEqual(segundo.status, 'ativo');

    const { rows: ativos } = await pool.query(
      "SELECT count(*)::int AS n FROM planos_administrativos WHERE anunciante_id = $1 AND status = 'ativo'",
      [conta.id],
    );
    assert.strictEqual(ativos[0].n, 1, 'nunca mais de um benefício ativo por conta ao mesmo tempo');
  } finally {
    await apagarContas([conta.id]);
  }
});
