const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const repo = require('../src/anunciantes/repository');

// Documento normalizado na gravação (21/09/2026, pedido do dono): "552.085.198-01"
// e "55208519801" não podem virar duas contas diferentes daqui pra frente —
// ver repository.js#criar/#atualizar. Cada teste cria a própria conta, com
// e-mail único, e apaga no final.

async function apagarConta(id) {
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

test('criar() normaliza cpf_cnpj: sem pontuação, maiúsculo', async () => {
  const email = `doc-${randomUUID()}@example.com`;
  const conta = await repo.criar({
    nome_empresa: 'Teste Documento',
    cpf_cnpj: '552.085.198-01',
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: email,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  try {
    assert.strictEqual(conta.cpf_cnpj, '55208519801', 'pontuação removida na gravação');
  } finally {
    await apagarConta(conta.id);
  }
});

test('criar() preserva letras do CNPJ alfanumérico, só maiúsculas', async () => {
  const email = `doc-${randomUUID()}@example.com`;
  const conta = await repo.criar({
    nome_empresa: 'Teste CNPJ Alfanumérico',
    cpf_cnpj: '12.abc.345/01de-35',
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: email,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  try {
    assert.strictEqual(conta.cpf_cnpj, '12ABC34501DE35', 'letras preservadas, maiúsculas, sem pontuação');
  } finally {
    await apagarConta(conta.id);
  }
});

test('atualizar() também normaliza cpf_cnpj quando o campo é editado', async () => {
  const email = `doc-${randomUUID()}@example.com`;
  const conta = await repo.criar({
    nome_empresa: 'Teste Atualizar',
    cpf_cnpj: '55208519801',
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: email,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  try {
    const atualizada = await repo.atualizar(conta.id, { cpf_cnpj: '552.085.198-01' });
    assert.strictEqual(atualizada.cpf_cnpj, '55208519801', 'edição também normaliza');
  } finally {
    await apagarConta(conta.id);
  }
});
