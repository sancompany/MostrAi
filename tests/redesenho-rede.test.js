const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const pontosRepo = require('../src/pontos/repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const candidaturasRepo = require('../src/candidaturas/repository');
const { liberarPapelNaConta } = require('../src/conta/modos');

// Rodada final da Rede do admin (22/09/2026) — cobre o que o código novo faz
// de diferente: status do ponto 100% automático (`sincronizarStatusPonto`,
// migration 069, derivado de `dispositivos.status`, nunca escrito à mão), e
// os dois furos fechados no pipeline candidatura → ponto (foto da fachada e
// "algo a mais" → observações). A regra de 80% e o resto do pipeline já têm
// cobertura própria em pontos-ocupacao.test.js — não duplicada aqui.

async function contaDeTeste() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em)
     VALUES ('Conta Teste Rede', '11144477735', $1, '16999990000', 'x', now())
     RETURNING *`,
    [`rede-${randomUUID()}@example.com`],
  );
  return rows[0];
}

async function candidaturaDeTeste(dados = {}) {
  return candidaturasRepo.criar({
    tipo: 'ponto',
    nome: 'Fulano da Silva',
    contato_telefone: '16988880000',
    nome_comercio: 'Bar Teste',
    endereco: 'Rua Teste, 123',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'bar',
    fluxo_estimado_mensal: 500,
    mensagem: 'tem estacionamento nos fundos',
    ...dados,
  });
}

async function limpar({ contaId, pontoId, candidaturaId }) {
  if (pontoId) await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
  if (pontoId) await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  if (candidaturaId) await pool.query('DELETE FROM candidaturas WHERE id = $1', [candidaturaId]);
  if (contaId) await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [contaId]);
  if (contaId) await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
}

test('candidaturasRepo.definirFoto grava a URL da fachada', async () => {
  const cand = await candidaturaDeTeste();
  try {
    assert.strictEqual(cand.foto_fachada_url, null, 'nasce sem foto — ela é opcional e sobe depois');
    const atualizada = await candidaturasRepo.definirFoto(cand.id, 'https://exemplo.test/fachada.jpg');
    assert.strictEqual(atualizada.foto_fachada_url, 'https://exemplo.test/fachada.jpg');
  } finally {
    await pool.query('DELETE FROM candidaturas WHERE id = $1', [cand.id]);
  }
});

// liberarPapelNaConta usa SAVEPOINT (cupom de indicação, src/indicacoes/repository.js)
// — só funciona dentro de uma transação de verdade, nunca com o pool cru.
// Os dois chamadores reais (aceitar convite, admin libera candidatura,
// src/conta/modos.js) sempre passam um client de `pool.connect()` já em
// BEGIN; o teste replica o mesmo formato.
async function emTransacaoDeTeste(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

test('liberarPapelNaConta propaga foto da fachada e observações da candidatura pro ponto', async () => {
  const conta = await contaDeTeste();
  const cand = await candidaturaDeTeste();
  await candidaturasRepo.definirFoto(cand.id, 'https://exemplo.test/fachada.jpg');
  const candComFoto = await candidaturasRepo.buscarPorId(cand.id);
  let pontoId;
  try {
    await emTransacaoDeTeste((cliente) => liberarPapelNaConta(conta, 'ponto', candComFoto, cliente));
    const [ponto] = await pool.query('SELECT * FROM pontos WHERE anunciante_id = $1', [conta.id]).then((r) => r.rows);
    pontoId = ponto.id;
    assert.strictEqual(ponto.foto_instalacao_url, 'https://exemplo.test/fachada.jpg', 'furo A: foto chega no ponto');
    assert.strictEqual(ponto.observacoes, 'tem estacionamento nos fundos', 'furo B: "algo a mais" vira observações');
    assert.strictEqual(ponto.status, 'a_instalar');
  } finally {
    await limpar({ contaId: conta.id, pontoId, candidaturaId: cand.id });
  }
});

test('liberarPapelNaConta não quebra sem foto nem mensagem (os dois furos são opcionais)', async () => {
  const conta = await contaDeTeste();
  const cand = await candidaturaDeTeste({ mensagem: null });
  let pontoId;
  try {
    await emTransacaoDeTeste((cliente) => liberarPapelNaConta(conta, 'ponto', cand, cliente));
    const [ponto] = await pool.query('SELECT * FROM pontos WHERE anunciante_id = $1', [conta.id]).then((r) => r.rows);
    pontoId = ponto.id;
    assert.strictEqual(ponto.foto_instalacao_url, null);
    assert.strictEqual(ponto.observacoes, null);
  } finally {
    await limpar({ contaId: conta.id, pontoId, candidaturaId: cand.id });
  }
});

// Sequência de aceite da rodada final (seção de testes do prompt, 22/09/2026):
// 0 telas -> a_instalar; 1 ativa -> em_operacao; ativa->reparo (única tela)
// -> em_reparo; reparo->inativa -> inativo; ganha uma 2ª ativa -> em_operacao
// de novo; apaga a última tela -> volta a a_instalar. Nenhum estado residual
// incorreto em nenhum passo.
test('status do ponto acompanha as telas sozinho, sem estado residual', async () => {
  const { rows: pontoRows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato)
     VALUES ($1, 'Rua Teste', 'Matão', 'SP', '00000000', 'teste', 'Fulano', '16999990000') RETURNING id`,
    [`Ponto Teste Status Automático ${randomUUID()}`],
  );
  const pontoId = pontoRows[0].id;
  const statusDoPonto = async () => (await pontosRepo.buscarPorId(pontoId)).status;
  try {
    assert.strictEqual(await statusDoPonto(), 'a_instalar', '0 telas nasce aguardando instalação');

    // Tela nasce 'inativo' (default da coluna) — a partir daqui já existe
    // 1 tela cadastrada, então "aguardando instalação" (0 telas) não se
    // aplica mais: cai em "tem tela(s), nenhuma ativa/reparo" -> inativo.
    const tela1 = await dispositivosRepo.criar(pontoId, { apelido: 'Tela 1' });
    assert.strictEqual(await statusDoPonto(), 'inativo', 'tela recém-criada (inativa) já conta como tela cadastrada');

    await dispositivosRepo.atualizar(tela1.id, { status: 'ativo' });
    assert.strictEqual(await statusDoPonto(), 'em_operacao', '1 tela ativa já basta pra "Ativo"');

    await dispositivosRepo.atualizar(tela1.id, { status: 'reparo' });
    assert.strictEqual(await statusDoPonto(), 'em_reparo', 'única tela foi pra reparo, ninguém mais ativa');

    await dispositivosRepo.atualizar(tela1.id, { status: 'inativo' });
    assert.strictEqual(await statusDoPonto(), 'inativo', 'tem tela cadastrada, nenhuma ativa nem em reparo');

    const tela2 = await dispositivosRepo.criar(pontoId, { apelido: 'Tela 2' });
    await dispositivosRepo.atualizar(tela2.id, { status: 'ativo' });
    assert.strictEqual(await statusDoPonto(), 'em_operacao', 'segunda tela ativa reabre o ponto');

    await dispositivosRepo.deletar(tela1.id);
    assert.strictEqual(await statusDoPonto(), 'em_operacao', 'apagar a tela inativa não mexe — a outra segue ativa');

    await dispositivosRepo.deletar(tela2.id);
    assert.strictEqual(await statusDoPonto(), 'a_instalar', 'apagou a última tela — volta a aguardando instalação');
  } finally {
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
});

test('criar()/atualizar() aceitam foto_instalacao_url e observacoes direto (migration 067)', async () => {
  const ponto = await pontosRepo.criar({
    nome: `Ponto Teste Campos Novos ${randomUUID()}`,
    endereco: 'Rua Teste',
    cidade: 'Matão',
    uf: 'SP',
    cep: '00000000',
    segmento: 'teste',
    responsavel_nome: 'Fulano',
    responsavel_contato: '16999990000',
    foto_instalacao_url: 'https://exemplo.test/a.jpg',
    observacoes: 'observação de teste',
  });
  try {
    assert.strictEqual(ponto.foto_instalacao_url, 'https://exemplo.test/a.jpg');
    assert.strictEqual(ponto.observacoes, 'observação de teste');
    const atualizado = await pontosRepo.atualizar(ponto.id, { observacoes: 'nova observação' });
    assert.strictEqual(atualizado.observacoes, 'nova observação');
  } finally {
    await pool.query('DELETE FROM pontos WHERE id = $1', [ponto.id]);
  }
});
