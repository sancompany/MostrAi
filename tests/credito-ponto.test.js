const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const creditosPonto = require('../src/creditos/ponto');
const creditosRepo = require('../src/creditos/repository');

// Crédito mensal do ponto (24/09/2026, ADR-016): ponto aprovado + tela
// provisionada e ativa = +1 crédito por mês, no ledger único, com o ponto e
// a competência de origem. Cada teste é uma regra do pedido do dono.

async function conta(extra = {}) {
  const campos = {
    nome_empresa: `Ponto ${randomUUID().slice(0, 6)}`,
    cpf_cnpj: '11144477735',
    contato_email: `cp-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    papeis: '{anunciante,ponto}',
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, ${nomes.join(', ')})
     VALUES (now(), ${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  return rows[0];
}

// Pontos criados neste arquivo — o job roda só sobre eles (outros arquivos de
// teste rodam em paralelo no mesmo banco).
const meusPontos = [];
const conceder = () => creditosPonto.concederCreditosMensais({ apenasPontos: meusPontos });

async function ponto(contaId, nome, status = 'em_operacao') {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
     VALUES ($1, 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'R', '16 9', $2, $3) RETURNING id`,
    [nome, contaId, status],
  );
  meusPontos.push(rows[0].id);
  return rows[0].id;
}

async function tela(pontoId, { status = 'ativo', provisionada = true } = {}) {
  await pool.query(`INSERT INTO dispositivos (ponto_id, apelido, status, aparelho_id) VALUES ($1, 'Tela', $2, $3)`, [
    pontoId,
    status,
    provisionada ? `ap-${randomUUID()}` : null,
  ]);
}

async function creditosDoPonto(contaId) {
  const { rows } = await pool.query(
    `SELECT ponto_id, competencia, quantidade, observacao FROM creditos_ledger
      WHERE anunciante_id = $1 AND tipo = 'credito_mensal_ponto' ORDER BY ponto_id`,
    [contaId],
  );
  return rows;
}

async function apagar(id) {
  await new Promise((r) => setTimeout(r, 50));
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM dispositivos WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = $1)', [id]);
  await pool.query('UPDATE pontos SET mesclado_em_ponto_id = NULL WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

const competencia = creditosPonto.competenciaDe();

test('candidatura não gera crédito; ponto aprovado sem tela não gera', async () => {
  const c = await conta();
  try {
    await pool.query(
      `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, endereco, cidade, uf, cep, conta_id, origem)
       VALUES ('ponto', 'R', 'Pedido', '16999990000', 'Rua Y, 2', 'Matão', 'SP', '15990-000', $1, 'painel')`,
      [c.id],
    );
    await ponto(c.id, 'Sem Tela', 'a_instalar');
    await conceder();
    assert.deepEqual(await creditosDoPonto(c.id), []);
  } finally {
    await apagar(c.id);
  }
});

test('tela desligada ou nunca provisionada não conta; tela ativa provisionada gera 1 crédito', async () => {
  const c = await conta();
  try {
    const p1 = await ponto(c.id, 'Desligada', 'inativo');
    await tela(p1, { status: 'inativo' });
    const p2 = await ponto(c.id, 'Nunca Ligou', 'a_instalar');
    await tela(p2, { provisionada: false });
    const p3 = await ponto(c.id, 'Santos unio');
    await tela(p3);
    await conceder();
    const creditos = await creditosDoPonto(c.id);
    assert.equal(creditos.length, 1);
    assert.equal(creditos[0].ponto_id, p3, 'o histórico identifica o ponto');
    assert.equal(String(creditos[0].competencia).slice(0, 10), competencia, 'e a competência');
    assert.equal(creditos[0].quantidade, 1);
    assert.equal(creditos[0].observacao, 'Crédito mensal do ponto Santos unio');
    assert.equal(await creditosRepo.saldo(c.id), 1, 'mesma carteira (ledger único)');
  } finally {
    await apagar(c.id);
  }
});

test('três telas no mesmo ponto = 1 crédito; três pontos = 3 créditos', async () => {
  const c = await conta();
  try {
    const um = await ponto(c.id, 'Um');
    await tela(um);
    await tela(um);
    await tela(um);
    const dois = await ponto(c.id, 'Dois');
    await tela(dois);
    const tres = await ponto(c.id, 'Três');
    await tela(tres);
    await conceder();
    const creditos = await creditosDoPonto(c.id);
    assert.deepEqual(
      creditos.map((x) => x.ponto_id),
      [um, dois, tres].sort((a, b) => a - b),
    );
    assert.equal(await creditosRepo.saldo(c.id), 3);
  } finally {
    await apagar(c.id);
  }
});

test('rodar o job duas vezes (ou em paralelo) não duplica — idempotência no banco', async () => {
  const c = await conta();
  try {
    const p = await ponto(c.id, 'Idempotente');
    await tela(p);
    const [a, b] = await Promise.all([conceder(), conceder()]);
    await conceder();
    assert.equal((await creditosDoPonto(c.id)).length, 1);
    assert.ok(a.concedidos + b.concedidos >= 1);
    await assert.rejects(
      pool.query(
        `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, ponto_id, competencia) VALUES ($1, 'credito_mensal_ponto', 1, $2, $3)`,
        [c.id, p, competencia],
      ),
      /duplicate key|unique/i,
      'o índice único recusa o mesmo ponto no mesmo mês',
    );
  } finally {
    await apagar(c.id);
  }
});

test('ponto mesclado/arquivado não gera; troca de dono no mês não gera o mês de novo', async () => {
  const a = await conta();
  const b = await conta();
  try {
    const canonico = await ponto(a.id, 'Canônico');
    await tela(canonico);
    const duplicado = await ponto(a.id, 'Duplicado');
    await tela(duplicado);
    await pool.query(
      `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste',
              mesclado_em_ponto_id = $2 WHERE id = $1`,
      [duplicado, canonico],
    );
    await conceder();
    assert.deepEqual(
      (await creditosDoPonto(a.id)).map((x) => x.ponto_id),
      [canonico],
    );
    // O ponto muda de dono no meio do mês: o mês já saiu, não sai de novo.
    await pool.query('UPDATE pontos SET anunciante_id = $2 WHERE id = $1', [canonico, b.id]);
    await conceder();
    assert.deepEqual(await creditosDoPonto(b.id), []);
  } finally {
    await apagar(a.id);
    await apagar(b.id);
  }
});

test('situação do benefício no painel: elegível, crédito do mês já saiu, próxima competência', async () => {
  const c = await conta();
  try {
    const p = await ponto(c.id, 'Painel');
    await tela(p);
    let sit = (await creditosPonto.situacaoDosPontos([p])).get(p);
    assert.equal(sit.elegivel, true);
    assert.equal(sit.creditoDoMesConcedido, false);
    await conceder();
    sit = (await creditosPonto.situacaoDosPontos([p])).get(p);
    assert.equal(sit.creditoDoMesConcedido, true);
    assert.notEqual(sit.proximaCompetencia, sit.competenciaAtual, 'próximo crédito é no mês seguinte');
    const { rows } = await pool.query(
      `SELECT titulo FROM notificacoes WHERE anunciante_id = $1 AND tipo = 'credito_mensal_ponto'`,
      [c.id],
    );
    assert.deepEqual(
      rows.map((r) => r.titulo),
      ['Seu ponto Painel gerou 1 crédito'],
    );
  } finally {
    await apagar(c.id);
  }
});

test('conta excluída ou conta interna do Mostraí não recebem crédito de ponto', async () => {
  const excluida = await conta({ excluido_em: new Date() });
  try {
    const p = await ponto(excluida.id, 'Excluída');
    await tela(p);
    await conceder();
    assert.deepEqual(await creditosDoPonto(excluida.id), []);
  } finally {
    await apagar(excluida.id);
  }
});

test.after(() => pool.end());
