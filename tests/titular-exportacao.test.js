const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const titular = require('../src/titular/repository');

// Exportação do titular (RN-24, GET /titular/meus-dados). Até 26/09/2026 ela
// quebrava pra QUALQUER conta: lia `exibicoes_contador.ponto_id` (dropada na
// 036) e `planos_administrativos.criado_em` (a coluna é `created_at`, 075) —
// o Promise.all rejeitava e a rota respondia 500. Nenhum teste passava por
// aqui. Este cria uma conta com exibição e benefício, e exige que a
// exportação saia com o formato documentado.

async function montarConta() {
  const { rows: conta } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em)
     VALUES ('Teste exportação titular', '11144477735', $1, '16999990000', 'x', now()) RETURNING id`,
    [`titular-${randomUUID()}@example.com`],
  );
  const id = conta[0].id;
  const { rows: ponto } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
     VALUES ('Ponto exportação', 'Rua X, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '16999990000', $1) RETURNING id`,
    [id],
  );
  const { rows: tela } = await pool.query(
    `INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela 1', 'ativo') RETURNING id`,
    [ponto[0].id],
  );
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas)
     VALUES ($1, $2, date_trunc('hour', now()), 3, 2)`,
    [id, tela[0].id],
  );
  await pool.query(
    `INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem)
     VALUES ($1, 'essencial-1m', '2099-01-01', 'encerrado', 'admin')`,
    [id],
  );
  return { id, pontoId: ponto[0].id, telaId: tela[0].id };
}

async function apagarConta({ id, pontoId }) {
  await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
  await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

test.after(() => pool.end());

test('exportação do titular sai com exibições (ponto pela tela) e benefícios', async () => {
  const conta = await montarConta();
  try {
    const dados = await titular.exportarConta(conta.id);
    assert.strictEqual(dados.conta.id, conta.id);

    assert.strictEqual(dados.exibicoes_por_hora.length, 1);
    const [exibicao] = dados.exibicoes_por_hora;
    assert.deepStrictEqual(Object.keys(exibicao).sort(), [
      'dispositivo_id',
      'janela_hora',
      'ponto_id',
      'vezes_confirmadas',
      'vezes_programadas',
    ]);
    assert.strictEqual(exibicao.ponto_id, conta.pontoId, 'o ponto vem da tela que exibiu');
    assert.strictEqual(exibicao.dispositivo_id, conta.telaId);
    assert.strictEqual(exibicao.vezes_confirmadas, 2);

    assert.strictEqual(dados.beneficios_por_creditos.length, 1);
    assert.ok(dados.beneficios_por_creditos[0].criado_em instanceof Date, 'criado_em vem de created_at');
  } finally {
    await apagarConta(conta);
  }
});
