const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const vigencia = require('../src/lib/vigencia');
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
    // Ontem em Matão (RN-32-B): um timestamp UTC de 24 h atrás ainda pode
    // cair no dia comercial de hoje entre 21:00 e 00:00 UTC.
    const ontem = vigencia.somarDias(vigencia.hojeComercial(), -1);
    await pool.query('UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1', [contaBase.id, ontem]);

    const resultado = await planoAdministrativo.ativarBeneficiosAgendados({ apenasContas: [contaBase.id] });
    assert.strictEqual(resultado.ativados, 1, 'ativou exatamente o benefício desta conta');

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

// Revisão do PR #55 (25/09/2026): com a ativação estrita (o benefício começa
// no dia SEGUINTE ao último dia pago), a varredura de cobertura vencida da
// conciliação chega na conta em D+1 ANTES de `ativarBeneficiosAgendados` —
// é a ordem de scripts/conciliar.js. Quando o plano pago não renova, ela
// fechava o benefício agendado junto com o pago: créditos gastos, benefício
// que nunca começou, conta sem plano. O teste roda o job NA ORDEM REAL.
test('job diário em D+1: plano pago que não renovou dá lugar ao benefício agendado, não o apaga', async () => {
  const { encerrarCoberturaVencida } = require('../src/financeiro/conciliacao');
  const contaBase = await contaDeTeste('beneficio-d1');
  try {
    const hoje = vigencia.hojeComercial();
    await pool.query(
      `UPDATE anunciantes SET plano_id='destaque-1m', plano_cortesia=false, data_expiracao=$2 WHERE id=$1`,
      [contaBase.id, vigencia.somarDias(hoje, 2)],
    );
    const { rows } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    const { status } = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta: rows[0],
      plano: await plano('maximo-1m'),
      diasDeBeneficio: 30,
      observacao: 'resgate de créditos',
      origem: 'indicacao',
    });
    assert.strictEqual(status, 'agendado');

    // D+1: o último dia pago (D) foi ontem e a assinatura não renovou.
    const ontem = vigencia.somarDias(hoje, -1);
    await pool.query('UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1', [contaBase.id, ontem]);
    await pool.query(
      `UPDATE planos_administrativos SET plano_anterior_valido_ate = $2, valido_ate = $3
        WHERE anunciante_id = $1 AND status = 'agendado'`,
      [contaBase.id, ontem, vigencia.somarDias(hoje, 30)],
    );

    await encerrarCoberturaVencida({ apenasContas: [contaBase.id] });
    await planoAdministrativo.encerrarBeneficiosVencidos({ apenasContas: [contaBase.id] });
    const ativ = await planoAdministrativo.ativarBeneficiosAgendados({ apenasContas: [contaBase.id] });
    assert.strictEqual(ativ.ativados, 1, 'o benefício agendado começou');

    const { rows: agora } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    assert.strictEqual(agora[0].plano_id, 'maximo-1m', 'a conta está no benefício, não sem plano');
    assert.strictEqual(agora[0].plano_cortesia, true);
    // Ativado no dia certo, termina no dia que a tela prometeu (início + 30,
    // a mesma régua do benefício que ativa na hora) — nem um dia a mais.
    assert.strictEqual(vigencia.diaTexto(agora[0].data_expiracao), vigencia.somarDias(hoje, 30));
    const historico = await planoAdministrativo.historicoDaConta(contaBase.id);
    assert.deepStrictEqual(
      historico.map((h) => h.status),
      ['ativo'],
      'nenhuma linha encerrada por "vencido": o agendado virou ativo',
    );
  } finally {
    await apagarContas([contaBase.id]);
  }
});

// Regra 32 do pedido de 24/09/2026 (ADR-016): o benefício resgatado com
// plano pago em dia começa NO FIM do ciclo em que foi resgatado, mesmo que a
// assinatura renove — o pago fica GUARDADO com os dias que tinha e volta
// depois do benefício. Antes, a renovação empurrava o benefício pra sempre.
test('ativarBeneficiosAgendados: renovação no meio-tempo não segura o benefício — o pago fica guardado', async () => {
  const contaBase = await contaDeTeste('beneficio-4');
  try {
    const futuroPerto = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
    await pool.query(
      `UPDATE anunciantes SET plano_id='destaque-1m', plano_cortesia=false, data_expiracao=$2 WHERE id=$1`,
      [contaBase.id, futuroPerto],
    );
    const { rows } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    const alvo = await plano('maximo-1m');
    const { status } = await planoAdministrativo.resgatarOuConcederBeneficio({
      conta: rows[0],
      plano: alvo,
      diasDeBeneficio: 30,
      observacao: 'agendado',
      origem: 'indicacao',
    });
    assert.strictEqual(status, 'agendado');

    // Webhook renovou a assinatura (+20 dias) antes do fim do ciclo.
    const futuroLonge = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
    await pool.query(`UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1`, [contaBase.id, futuroLonge]);

    // Ainda não chegou o fim do ciclo em que o resgate foi feito: espera.
    await planoAdministrativo.ativarBeneficiosAgendados({ apenasContas: [contaBase.id] });
    let { rows: agora } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]);
    assert.strictEqual(agora[0].plano_id, 'destaque-1m', 'antes da data, continua no pago');

    // Chegou a data de início (simulada: o último dia do ciclo pago foi ontem —
    // o último dia é inclusivo, RN-32-B, então o benefício entra no seguinte).
    await pool.query(
      `UPDATE planos_administrativos SET plano_anterior_valido_ate = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1, valido_ate = (now() AT TIME ZONE 'America/Sao_Paulo')::date + 30
        WHERE anunciante_id = $1 AND status = 'agendado'`,
      [contaBase.id],
    );
    await planoAdministrativo.ativarBeneficiosAgendados({ apenasContas: [contaBase.id] });
    ({ rows: agora } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]));
    assert.strictEqual(agora[0].plano_id, 'maximo-1m', 'o benefício entrou na data, mesmo com a renovação');
    assert.strictEqual(agora[0].plano_pago_guardado_id, 'destaque-1m', 'o pago ficou guardado');
    assert.ok(agora[0].plano_pago_guardado_dias >= 19, 'com os dias pagos que ainda tinha');

    // Benefício acaba: o pago volta com os dias guardados.
    await pool.query(
      `UPDATE planos_administrativos SET valido_ate = (now() AT TIME ZONE 'America/Sao_Paulo')::date - 1 WHERE anunciante_id = $1 AND status = 'ativo'`,
      [contaBase.id],
    );
    const dias = agora[0].plano_pago_guardado_dias;
    await planoAdministrativo.encerrarBeneficiosVencidos({ apenasContas: [contaBase.id] });
    ({ rows: agora } = await pool.query('SELECT * FROM anunciantes WHERE id = $1', [contaBase.id]));
    assert.strictEqual(agora[0].plano_id, 'destaque-1m', 'voltou ao pago');
    assert.strictEqual(agora[0].plano_cortesia, false);
    assert.strictEqual(agora[0].plano_pago_guardado_id, null);
    const esperado = vigencia.somarDias(vigencia.hojeComercial(), dias);
    assert.strictEqual(String(agora[0].data_expiracao).slice(0, 10), esperado, 'nenhum dia pago se perdeu');
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

    const resultado = await planoAdministrativo.encerrarBeneficiosVencidos({ apenasContas: [conta.id] });
    assert.strictEqual(resultado.encerrados, 1);

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
