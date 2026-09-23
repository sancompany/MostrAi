require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const pontosRepo = require('../src/pontos/repository');

// Ponto duplicado (auditoria forense de 23/09/2026): "Bruno H Sanches"
// aparecia duas vezes em "Onde seu anúncio aparece" porque eram DUAS linhas
// reais em `pontos` — mesmo nome, endereço e CEP. Nada impedia uma
// candidatura já materializada, ou uma segunda candidatura do mesmo lugar, de
// gerar outro ponto. Aqui: as três portas fechadas, a corrida travada, o
// arquivamento que o status automático não desfaz, e a regra de mesclagem da
// migration 080 — que NÃO pode tratar endereço igual como mesmo comércio.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-duplicados', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/conta/modos').router);
  app.use(require('../src/pontos/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo, conta) => {
    const headers = { 'Content-Type': 'application/json' };
    if (conta) headers['x-conta'] = String(conta);
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function criarConta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante','ponto']) RETURNING *`,
    [
      `Dup ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `dup-${randomUUID()}@example.com`,
    ],
  );
  return rows[0];
}

async function criarCandidatura(contaId, { nome, endereco }) {
  const { rows } = await pool.query(
    `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, endereco, cidade, uf, cep, conta_id, origem)
     VALUES ('ponto', 'Responsável', $1, '16999990000', $2, 'Matão', 'SP', '15990-000', $3, 'painel') RETURNING *`,
    [nome, endereco, contaId],
  );
  return rows[0];
}

const pontosDaConta = async (contaId) =>
  (await pool.query(`SELECT * FROM pontos WHERE anunciante_id = $1 ORDER BY id`, [contaId])).rows;

async function limpar(contaId) {
  await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [contaId]);
  await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [contaId]);
  await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [contaId]).catch(() => {});
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
}

test('aprovar a mesma candidatura duas vezes cria um ponto só', async () => {
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const cand = await criarCandidatura(conta.id, { nome: 'Padaria Um', endereco: 'Rua A, 10' });
    const r1 = await app.chamar('POST', `/admin/candidaturas/${cand.id}/liberar`);
    assert.equal(r1.status, 200);
    const r2 = await app.chamar('POST', `/admin/candidaturas/${cand.id}/liberar`);
    assert.equal(r2.status, 409);
    const pontos = await pontosDaConta(conta.id);
    assert.equal(pontos.length, 1);
    assert.equal(pontos[0].candidatura_id, cand.id, 'o ponto sabe de qual candidatura nasceu');
  } finally {
    await app.fechar();
    await limpar(conta.id);
  }
});

test('dois cliques simultâneos em Aprovar não criam dois pontos', async () => {
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const cand = await criarCandidatura(conta.id, { nome: 'Padaria Corrida', endereco: 'Rua B, 20' });
    const respostas = await Promise.all([
      app.chamar('POST', `/admin/candidaturas/${cand.id}/liberar`),
      app.chamar('POST', `/admin/candidaturas/${cand.id}/liberar`),
    ]);
    const status = respostas.map((r) => r.status).sort();
    assert.deepEqual(status, [200, 409], `vieram ${status}`);
    assert.equal((await pontosDaConta(conta.id)).length, 1);
  } finally {
    await app.fechar();
    await limpar(conta.id);
  }
});

// O teste acima depende de timing: se as duas requisições serializarem, ele
// passa até sem a trava. A garantia que NÃO depende de timing é o índice
// único parcial — este teste a prova direto no banco.
test('o banco recusa dois pontos da mesma candidatura (índice único)', async () => {
  const conta = await criarConta();
  try {
    const cand = await criarCandidatura(conta.id, { nome: 'Trava', endereco: 'Rua E, 5' });
    const inserir = () =>
      pool.query(
        `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                             anunciante_id, candidatura_id)
         VALUES ('Trava', 'Rua E, 5', 'Matão', 'SP', '', 'outro', 'x', 'x', $1, $2)`,
        [conta.id, cand.id],
      );
    await inserir();
    await assert.rejects(inserir(), (err) => err.code === '23505');
  } finally {
    await limpar(conta.id);
  }
});

test('segunda candidatura do MESMO estabelecimento não vira segundo ponto', async () => {
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const a = await criarCandidatura(conta.id, { nome: 'Bruno H Sanches', endereco: 'Avenida 28 de Agosto, 2502' });
    assert.equal((await app.chamar('POST', `/admin/candidaturas/${a.id}/liberar`)).status, 200);
    // Mesmo lugar, digitado com diferença de espaço e maiúscula.
    const b = await criarCandidatura(conta.id, { nome: ' bruno h sanches ', endereco: 'avenida 28 de agosto, 2502 ' });
    const r = await app.chamar('POST', `/admin/candidaturas/${b.id}/liberar`);
    assert.equal(r.status, 409, JSON.stringify(r.corpo));
    assert.match(r.corpo.erro, /já é um ponto/);
    assert.equal((await pontosDaConta(conta.id)).length, 1, 'era exatamente o bug de produção');
  } finally {
    await app.fechar();
    await limpar(conta.id);
  }
});

test('outro comércio no MESMO endereço é permitido (sem unique ingênuo)', async () => {
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const a = await criarCandidatura(conta.id, { nome: 'Loja Térreo', endereco: 'Galeria Central, 100' });
    const b = await criarCandidatura(conta.id, { nome: 'Loja Sobreloja', endereco: 'Galeria Central, 100' });
    assert.equal((await app.chamar('POST', `/admin/candidaturas/${a.id}/liberar`)).status, 200);
    assert.equal((await app.chamar('POST', `/admin/candidaturas/${b.id}/liberar`)).status, 200);
    assert.equal((await pontosDaConta(conta.id)).length, 2);
  } finally {
    await app.fechar();
    await limpar(conta.id);
  }
});

test('o formulário recusa pedir de novo um estabelecimento que já é ponto', async () => {
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const a = await criarCandidatura(conta.id, { nome: 'Mercado X', endereco: 'Rua C, 30' });
    assert.equal((await app.chamar('POST', `/admin/candidaturas/${a.id}/liberar`)).status, 200);
    const r = await app.chamar(
      'POST',
      '/anunciantes/me/pontos',
      { nome_comercio: 'Mercado X', endereco: 'Rua C, 30', cep: '15990-000' },
      conta.id,
    );
    assert.equal(r.status, 409, JSON.stringify(r.corpo));
    assert.match(r.corpo.erro, /já é um ponto/);
  } finally {
    await app.fechar();
    await limpar(conta.id);
  }
});

test('status automático não ressuscita um ponto arquivado', async () => {
  const conta = await criarConta();
  try {
    const { rows } = await pool.query(
      `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                           anunciante_id, status, arquivado_em, motivo_arquivamento)
       VALUES ('Arq', 'Rua D, 1', 'Matão', 'SP', '', 'outro', 'x', 'x', $1, 'arquivado', now(), 'teste')
       RETURNING id`,
      [conta.id],
    );
    const status = await pontosRepo.sincronizarStatusPonto(rows[0].id);
    assert.equal(status, 'arquivado');
    const { rows: depois } = await pool.query('SELECT status FROM pontos WHERE id = $1', [rows[0].id]);
    assert.equal(depois[0].status, 'arquivado');
    assert.equal((await pontosRepo.listarPorAnunciante(conta.id)).length, 0, 'fora da experiência normal');
  } finally {
    await limpar(conta.id);
  }
});

test('migration 080: mescla só a duplicata órfã, e é idempotente', async () => {
  const conta = await criarConta();
  const nome = `Estab ${randomUUID().slice(0, 6)}`;
  try {
    const inserir = (n, endereco) =>
      pool.query(
        `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
         VALUES ($1, $2, 'Matão', 'SP', '15997-078', 'outro', 'x', 'x', $3) RETURNING id`,
        [n, endereco, conta.id],
      );
    const canonico = (await inserir(nome, 'Av. Teste, 1')).rows[0].id;
    // O canônico tem vínculo real (uma tela); a cópia não tem nada.
    await pool.query(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela 1', 'ativo')`, [canonico]);
    const duplicata = (await inserir(nome, 'Av. Teste, 1')).rows[0].id;
    const vizinho = (await inserir(`${nome} Vizinho`, 'Av. Teste, 1')).rows[0].id;

    const sql = fs.readFileSync(
      path.join(__dirname, '../src/db/migrations/080_vinculo_candidatura_ponto_e_arquivamento.sql'),
      'utf8',
    );
    await pool.query(sql);
    await pool.query(sql); // segunda vez: nada muda, nada estoura

    const { rows } = await pool.query(
      'SELECT id, status, mesclado_em_ponto_id, motivo_arquivamento FROM pontos WHERE anunciante_id = $1',
      [conta.id],
    );
    const por = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(por[duplicata].status, 'arquivado');
    assert.equal(por[duplicata].mesclado_em_ponto_id, canonico);
    assert.match(por[duplicata].motivo_arquivamento, /duplicata do ponto/);
    assert.notEqual(por[canonico].status, 'arquivado', 'o canônico fica');
    assert.notEqual(por[vizinho].status, 'arquivado', 'nome diferente no mesmo endereço é outro comércio');
  } finally {
    await pool.query('DELETE FROM dispositivos WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = $1)', [
      conta.id,
    ]);
    await pool.query('UPDATE pontos SET mesclado_em_ponto_id = NULL WHERE anunciante_id = $1', [conta.id]);
    await limpar(conta.id);
  }
});

test.after(() => pool.end());
