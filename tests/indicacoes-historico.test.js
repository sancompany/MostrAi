require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const creditosRepo = require('../src/creditos/repository');

// Indicações — finalização (28/09/2026): "Você foi indicado por" no cadastro
// (GET /indicacoes/:codigo, anônima) e o histórico de quem se cadastrou pelo
// link no card do ponto (`indicacao.indicados` em GET /anunciantes/me/creditos).
// O que sai e, sobretudo, o que NÃO sai: nome do negócio, cidade, datas,
// cadastro concluído, plano e créditos — nunca contato, documento, endereço,
// valor nem o id da conta indicada.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-indicacoes', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/creditos/routes'));
  app.use(require('../src/indicacoes/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, conta) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: conta ? { 'x-conta': String(conta) } : {},
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function conta(extra = {}) {
  const campos = {
    nome_empresa: `Indicação ${randomUUID().slice(0, 6)}`,
    cpf_cnpj: '11144477735',
    contato_email: `indic-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    cidade: 'Matão',
    uf: 'SP',
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

const criadas = [];
test.after(async () => {
  for (const id of criadas) {
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1 OR origem_conta_id = $1', [id]);
    await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

test('cadastro: GET /indicacoes/:codigo devolve só o nome do negócio que indica', async () => {
  const app = await subirApp();
  const ponto = await conta({ nome_empresa: 'Padaria do Ponto' });
  criadas.push(ponto.id);
  try {
    await pool.query(
      `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
       VALUES ('Ponto da indicação', 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'R', '16 9', $1)`,
      [ponto.id],
    );
    const meus = await app.chamar('GET', '/anunciantes/me/creditos', ponto.id);
    assert.equal(meus.status, 200);
    const codigo = meus.corpo.indicacao.codigo;
    assert.match(codigo, /^PT-/);
    assert.deepEqual(meus.corpo.indicacao.indicados, [], 'sem indicado ainda');

    const r = await app.chamar('GET', `/indicacoes/${codigo}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.corpo, { nome: 'Padaria do Ponto' }, 'só o nome — nada mais sai');
    const minusculo = await app.chamar('GET', `/indicacoes/${codigo.toLowerCase()}`);
    assert.equal(minusculo.status, 200, 'o cupom não diferencia maiúsculas (o cadastro também não)');
    assert.equal((await app.chamar('GET', '/indicacoes/PT-NAOEXI999')).status, 404);
    assert.equal(
      (await app.chamar('GET', `/indicacoes/${encodeURIComponent("x' OR 1=1")}`)).status,
      404,
      'fora do formato: 404, sem consultar',
    );

    // Conta excluída não indica mais: o link dela morre com ela.
    await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [ponto.id]);
    assert.equal((await app.chamar('GET', `/indicacoes/${codigo}`)).status, 404);
  } finally {
    await app.fechar();
  }
});

test('painel do ponto: histórico de quem se cadastrou pelo link, com o que pode ser visto e nada mais', async () => {
  const app = await subirApp();
  const ponto = await conta({ nome_empresa: 'Mercado do Ponto' });
  criadas.push(ponto.id);
  try {
    await pool.query(
      `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
       VALUES ('Ponto do histórico', 'Rua X, 1', 'Matão', 'SP', '15990-000', 'outro', 'R', '16 9', $1)`,
      [ponto.id],
    );
    const { codigo } = (await app.chamar('GET', '/anunciantes/me/creditos', ponto.id)).corpo.indicacao;

    // Indicado 1: cadastrou e parou (e-mail sem confirmar).
    const iniciado = await conta({ nome_empresa: 'Loja Iniciada', indicado_por_cupom: codigo, cidade: 'Araraquara' });
    criadas.push(iniciado.id);
    let ind = (await app.chamar('GET', '/anunciantes/me/creditos', ponto.id)).corpo.indicacao;
    assert.equal(ind.cadastradas, 1);
    assert.equal(ind.indicados.length, 1);
    assert.deepEqual(Object.keys(ind.indicados[0]).sort(), [
      'cadastroConcluido',
      'cadastroEm',
      'cidade',
      'creditos',
      'nome',
      'planoNome',
      'uf',
      'ultimoCreditoEm',
    ]);
    assert.equal(ind.indicados[0].nome, 'Loja Iniciada');
    assert.equal(ind.indicados[0].cidade, 'Araraquara');
    assert.equal(ind.indicados[0].cadastroConcluido, false);
    assert.equal(ind.indicados[0].planoNome, null);
    assert.equal(ind.indicados[0].creditos, 0);
    const bruto = JSON.stringify(ind);
    assert.ok(!bruto.includes(iniciado.contato_email), 'e-mail do indicado nunca sai');
    assert.ok(!bruto.includes('11144477735'), 'documento do indicado nunca sai');
    assert.ok(!bruto.includes(`"id":${iniciado.id}`), 'id da conta indicada nunca sai');

    // Indicado 2: concluiu, contratou e pagou duas vezes (dois créditos no
    // ledger do ponto — a mesma gravação do ciclo pago).
    const pagante = await conta({
      nome_empresa: 'Farmácia Pagante',
      indicado_por_cupom: codigo,
      email_confirmado: true,
      plano_id: 'essencial-1m',
    });
    criadas.push(pagante.id);
    await creditosRepo.registrarCreditoIndicacao(ponto.id, pagante.id, null);
    await creditosRepo.registrarCreditoIndicacao(ponto.id, pagante.id, null);
    // Indicado 3: excluído — some da lista e do resumo.
    const excluido = await conta({ nome_empresa: 'Sumiu', indicado_por_cupom: codigo, excluido_em: new Date() });
    criadas.push(excluido.id);

    ind = (await app.chamar('GET', '/anunciantes/me/creditos', ponto.id)).corpo.indicacao;
    assert.equal(ind.cadastradas, 2);
    assert.equal(ind.indicados.length, 2);
    const farmacia = ind.indicados.find((i) => i.nome === 'Farmácia Pagante');
    assert.ok(farmacia);
    assert.equal(farmacia.cadastroConcluido, true);
    assert.equal(farmacia.planoNome, 'Essencial');
    assert.equal(farmacia.creditos, 2);
    assert.ok(farmacia.ultimoCreditoEm);
    assert.ok(!ind.indicados.some((i) => i.nome === 'Sumiu'), 'conta excluída não aparece');
    // Mais recente primeiro.
    assert.equal(ind.indicados[0].nome, 'Farmácia Pagante');
  } finally {
    await app.fechar();
  }
});
