require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const candidaturasRepo = require('../src/candidaturas/repository');

// Correção cirúrgica de Rede (23/09/2026, pedido do dono): candidatura de
// endereço só bloqueia duplicata pelo MESMO endereço (achado real: bloqueava
// qualquer segundo endereço enquanto o primeiro estivesse em análise), e
// "Meus endereços" precisa de uma lista das candidaturas em aberto da conta.

async function subirApp(montar) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-rede', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    const id = req.headers['x-anunciante-id'];
    if (id) req.session.anuncianteId = Number(id);
    proximo();
  });
  montar(app);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo, contaId) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(contaId ? { 'x-anunciante-id': String(contaId) } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function criarContaPonto() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, papeis)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante','ponto'])
     RETURNING *`,
    [
      `Ponto Teste ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `rede-${randomUUID()}@example.com`,
    ],
  );
  return rows[0];
}

async function apagarConta(id) {
  await new Promise((r) => setTimeout(r, 100)); // eventos.registrar é fire-and-forget
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

const HORARIO = {
  seg: { abre: '09:00', fecha: '18:00' },
  ter: null,
  qua: null,
  qui: null,
  sex: null,
  sab: null,
  dom: null,
  feriados: null,
};

function payloadEndereco(extra = {}) {
  return {
    nome_comercio: 'Comércio Teste',
    endereco: 'Rua das Flores, 100',
    bairro: 'Centro',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990-000',
    fluxo_estimado_mensal: 1000,
    horario_semanal: HORARIO,
    ...extra,
  };
}

test('POST /anunciantes/me/pontos: bloqueia só o MESMO endereço, libera endereço diferente', async () => {
  const conta = await criarContaPonto();
  const { chamar, fechar } = await subirApp((app) => app.use(require('../src/pontos/routes')));
  try {
    const r1 = await chamar('POST', '/anunciantes/me/pontos', payloadEndereco(), conta.id);
    assert.strictEqual(r1.status, 201, JSON.stringify(r1.corpo));

    // mesmo endereço de novo (mesma rua+número, mesmo CEP) — bloqueado
    const r2 = await chamar(
      'POST',
      '/anunciantes/me/pontos',
      payloadEndereco({ nome_comercio: 'Outro nome' }),
      conta.id,
    );
    assert.strictEqual(r2.status, 409);
    assert.match(r2.corpo.erro, /Já existe uma solicitação em análise para este endereço/);

    // endereço diferente — não bloqueado
    const r3 = await chamar(
      'POST',
      '/anunciantes/me/pontos',
      payloadEndereco({ endereco: 'Avenida Central, 200', cep: '15990-100' }),
      conta.id,
    );
    assert.strictEqual(r3.status, 201, JSON.stringify(r3.corpo));

    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM candidaturas WHERE conta_id = $1 AND tipo = 'ponto'",
      [conta.id],
    );
    assert.strictEqual(rows[0].n, 2, 'a duplicata não chegou a ser inserida');
  } finally {
    await fechar();
    await apagarConta(conta.id);
  }
});

test('GET /anunciantes/me/pontos/candidaturas: só as em aberto desta conta', async () => {
  const conta = await criarContaPonto();
  const outraConta = await criarContaPonto();
  const { chamar, fechar } = await subirApp((app) => app.use(require('../src/pontos/routes')));
  try {
    const aberta = await candidaturasRepo.criar({
      tipo: 'ponto',
      nome: 'Fulano',
      contato_telefone: '16999990000',
      endereco: 'Rua A, 1',
      nome_comercio: 'Loja A',
      cidade: 'Matão',
      uf: 'SP',
      fluxo_estimado_mensal: 500,
      conta_id: conta.id,
      origem: 'painel',
    });
    const aprovada = await candidaturasRepo.criar({
      tipo: 'ponto',
      nome: 'Fulano',
      contato_telefone: '16999990000',
      endereco: 'Rua B, 2',
      nome_comercio: 'Loja B (já aprovada)',
      cidade: 'Matão',
      uf: 'SP',
      fluxo_estimado_mensal: 500,
      conta_id: conta.id,
      origem: 'painel',
    });
    await candidaturasRepo.atualizar(aprovada.id, { status: 'aprovada' });
    await candidaturasRepo.criar({
      tipo: 'ponto',
      nome: 'Ciclano',
      contato_telefone: '16999990001',
      endereco: 'Rua C, 3',
      nome_comercio: 'Loja de outra conta',
      cidade: 'Matão',
      uf: 'SP',
      fluxo_estimado_mensal: 500,
      conta_id: outraConta.id,
      origem: 'painel',
    });

    const r = await chamar('GET', '/anunciantes/me/pontos/candidaturas', null, conta.id);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(
      r.corpo.length,
      1,
      'só a candidatura em aberto desta conta — não a aprovada, não a de outra conta',
    );
    assert.strictEqual(r.corpo[0].id, aberta.id);
    assert.strictEqual(r.corpo[0].nome_comercio, 'Loja A');
  } finally {
    await fechar();
    await apagarConta(conta.id);
    await apagarConta(outraConta.id);
  }
});
