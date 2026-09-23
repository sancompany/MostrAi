const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const promocoesRepo = require('../src/financeiro/promocoes-repository');
const anunciantesRepo = require('../src/anunciantes/repository');

// Reconstrução de Ofertas/Promoções (23/09/2026, pedido do dono): a promoção
// não é mais segmentada por sessão (logado × deslogado) — é segmentada por
// ELEGIBILIDADE COMERCIAL (novos/assinantes/todos), calculada a partir do
// estado real da conta (plano ativo agora, ou já pagou antes).

test('elegivel: "todos" sempre elegível, independente do estado', () => {
  const promo = { publico_elegivel: 'todos' };
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: false, jaAssinouAntes: false }), true);
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: true, jaAssinouAntes: true }), true);
});

test('elegivel: "assinantes" só quem tem plano ativo agora', () => {
  const promo = { publico_elegivel: 'assinantes' };
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: true, jaAssinouAntes: false }), true);
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: false, jaAssinouAntes: true }), false);
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: false, jaAssinouAntes: false }), false);
});

test('elegivel: "novos" exclui plano ativo E histórico de assinatura', () => {
  const promo = { publico_elegivel: 'novos' };
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: false, jaAssinouAntes: false }), true);
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: true, jaAssinouAntes: false }), false);
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: false, jaAssinouAntes: true }), false);
  assert.strictEqual(promocoesRepo.elegivel(promo, { temPlanoAtivo: true, jaAssinouAntes: true }), false);
});

test('estadoComercialDaConta: visitante sem sessão (conta null) é tratado como novo', async () => {
  const estado = await promocoesRepo.estadoComercialDaConta(null);
  assert.deepStrictEqual(estado, { temPlanoAtivo: false, jaAssinouAntes: false });
});

async function planoDeTeste() {
  const id = `plano-teste-promo-${randomUUID()}`;
  await pool.query(
    `INSERT INTO planos (id, tier, nome, valor_mensal, compromisso_meses, frequencia_hora, cobertura, segundos_por_hora, pontos_incluidos, duracao_maxima_segundos, limite_criativos)
     VALUES ($1,'essencial','Teste Promo',100,3,0,'todos_pontos',600,1,30,3)`,
    [id],
  );
  return id;
}

async function contaDeTeste() {
  return anunciantesRepo.criar({
    nome_empresa: `Teste Promo ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `promo-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
}

async function limpar({ contaId, planoId }) {
  if (contaId) await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [contaId]);
  if (contaId) await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
  if (planoId) await pool.query('DELETE FROM planos WHERE id = $1', [planoId]);
}

test('estadoComercialDaConta: plano ativo (sem expiração) conta como assinante', async () => {
  const planoId = await planoDeTeste();
  const conta = await contaDeTeste();
  try {
    await anunciantesRepo.atualizar(conta.id, { plano_id: planoId });
    const atualizada = await anunciantesRepo.buscarPorId(conta.id);
    const estado = await promocoesRepo.estadoComercialDaConta(atualizada);
    assert.strictEqual(estado.temPlanoAtivo, true);
  } finally {
    await limpar({ contaId: conta.id, planoId });
  }
});

test('estadoComercialDaConta: plano com data_expiracao no passado não conta como ativo', async () => {
  const planoId = await planoDeTeste();
  const conta = await contaDeTeste();
  try {
    await anunciantesRepo.atualizar(conta.id, { plano_id: planoId, data_expiracao: '2020-01-01' });
    const atualizada = await anunciantesRepo.buscarPorId(conta.id);
    const estado = await promocoesRepo.estadoComercialDaConta(atualizada);
    assert.strictEqual(estado.temPlanoAtivo, false, 'plano vencido não é "ativo agora"');
  } finally {
    await limpar({ contaId: conta.id, planoId });
  }
});

test('estadoComercialDaConta: conta suspensa não conta como assinante ativo mesmo com plano_id', async () => {
  const planoId = await planoDeTeste();
  const conta = await contaDeTeste();
  try {
    await anunciantesRepo.atualizar(conta.id, { plano_id: planoId, suspenso: true });
    const atualizada = await anunciantesRepo.buscarPorId(conta.id);
    const estado = await promocoesRepo.estadoComercialDaConta(atualizada);
    assert.strictEqual(estado.temPlanoAtivo, false);
  } finally {
    await limpar({ contaId: conta.id, planoId });
  }
});

test('estadoComercialDaConta: cobrança confirmada anterior marca jaAssinouAntes mesmo sem plano hoje', async () => {
  const planoId = await planoDeTeste();
  const conta = await contaDeTeste();
  try {
    await pool.query(`INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES ($1, $2, 100)`, [
      conta.id,
      planoId,
    ]);
    const estado = await promocoesRepo.estadoComercialDaConta(conta);
    assert.strictEqual(estado.temPlanoAtivo, false, 'sem plano_id na conta hoje');
    assert.strictEqual(estado.jaAssinouAntes, true, 'já pagou antes — não é mais "novo"');
  } finally {
    await limpar({ contaId: conta.id, planoId });
  }
});

test('condicaoVigente: promoção "novos" aparece pra quem nunca assinou, não pra quem tem plano ativo', async () => {
  const promo = await promocoesRepo.criar({
    nome_interno: `Teste elegibilidade ${randomUUID()}`,
    titulo_publico: 'Pré-venda de teste',
    publico_elegivel: 'novos',
    status: 'ativa',
    duracao_beneficio_meses: 12,
    itens: [{ tier: 'essencial', compromissoMeses: 3, descontoPercentual: 20 }],
  });
  try {
    const condicaoParaNovo = await promocoesRepo.condicaoVigente('essencial', 3, {
      temPlanoAtivo: false,
      jaAssinouAntes: false,
    });
    assert.ok(condicaoParaNovo, 'quem não tem plano nem histórico deve ver a condição de "novos"');
    assert.strictEqual(condicaoParaNovo.descontoPercentual, 20);

    const condicaoParaAssinante = await promocoesRepo.condicaoVigente('essencial', 3, {
      temPlanoAtivo: true,
      jaAssinouAntes: false,
    });
    assert.strictEqual(condicaoParaAssinante, null, 'quem já tem plano ativo não pode receber condição de "novos"');
  } finally {
    await promocoesRepo.excluir(promo.id);
  }
});

test('condicaoVigente: promoção "assinantes" nunca aparece pra quem não tem plano', async () => {
  const promo = await promocoesRepo.criar({
    nome_interno: `Teste elegibilidade assinantes ${randomUUID()}`,
    titulo_publico: 'Upgrade de teste',
    publico_elegivel: 'assinantes',
    status: 'ativa',
    duracao_beneficio_meses: 12,
    itens: [{ tier: 'destaque', compromissoMeses: 6, descontoPercentual: 15 }],
  });
  try {
    const paraNovo = await promocoesRepo.condicaoVigente('destaque', 6, {
      temPlanoAtivo: false,
      jaAssinouAntes: false,
    });
    assert.strictEqual(paraNovo, null);
    const paraAssinante = await promocoesRepo.condicaoVigente('destaque', 6, {
      temPlanoAtivo: true,
      jaAssinouAntes: true,
    });
    assert.ok(paraAssinante);
    assert.strictEqual(paraAssinante.descontoPercentual, 15);
  } finally {
    await promocoesRepo.excluir(promo.id);
  }
});

test('listarVigentes: só promoções com status=ativa dentro da janela de compra', async () => {
  const rascunho = await promocoesRepo.criar({
    nome_interno: `Teste rascunho ${randomUUID()}`,
    titulo_publico: 'Rascunho',
    status: 'rascunho',
    duracao_beneficio_meses: 12,
    itens: [],
  });
  const ativa = await promocoesRepo.criar({
    nome_interno: `Teste ativa ${randomUUID()}`,
    titulo_publico: 'Ativa',
    status: 'ativa',
    duracao_beneficio_meses: 12,
    itens: [],
  });
  try {
    const vigentes = await promocoesRepo.listarVigentes();
    const ids = vigentes.map((v) => v.id);
    assert.ok(ids.includes(ativa.id), 'status ativa deve aparecer');
    assert.ok(!ids.includes(rascunho.id), 'status rascunho não deve aparecer');
  } finally {
    await promocoesRepo.excluir(rascunho.id);
    await promocoesRepo.excluir(ativa.id);
  }
});
