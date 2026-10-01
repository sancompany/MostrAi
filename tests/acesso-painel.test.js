require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const anunciantesRepo = require('../src/anunciantes/repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const basicoRepo = require('../src/pontos/basico');
const { acessoDoPainel } = require('../src/anunciantes/acesso-painel');
const { primeirosPassosDaConta } = require('../src/anunciantes/primeiros-passos');

// Acesso ao painel ≠ direito de veicular (01/10/2026). Caso real: conta sem
// plano, dona de um ponto aprovado aguardando instalação, presa em "Comece
// sua primeira campanha / Escolha seu plano". Ser dono de ponto da rede libera
// o painel inteiro; o direito de veicular continua sendo plano ou Básico
// ativo, e o Básico continua nascendo só com a tela instalada.

const criados = { contas: [], pontos: [] };
test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  // Tela com Básico ativo entra no gerador e no crédito do ponto que outros
  // arquivos de teste rodam em paralelo (o CI pegou exibicoes_contador
  // apontando pra uma tela daqui): limpa o que eles podem ter gravado.
  for (const pontoId of criados.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM creditos_ledger WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM beneficios_basico_ponto WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
  for (const id of criados.contas) {
    await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
    for (const t of [
      'banco_horas',
      'exibicoes_contador',
      'anunciantes_pontos',
      'eventos',
      'notificacoes',
      'creditos_ledger',
      'criativos',
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]);
    }
    await pool.query('DELETE FROM beneficios_basico_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

async function novaConta({ plano = null } = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Barbearia ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `acesso-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criados.contas.push(conta.id);
  if (plano) {
    await pool.query(
      `UPDATE anunciantes SET plano_id = $2, data_inicio_cobertura = '2026-07-01', data_expiracao = '2099-12-31' WHERE id = $1`,
      [conta.id, plano],
    );
  }
  return anunciantesRepo.buscarPorId(conta.id);
}

// Ponto materializado da conta. `tela`: nenhuma | 'instalada' (Player
// provisionado e ativo — dá o Básico) | 'sinal' (instalada e já conectou).
async function pontoDaConta(contaId, { status = 'a_instalar', tela = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                         anunciante_id, status, arquivado_em, motivo_arquivamento)
     VALUES ($1, 'R', 'Matão', 'SP', '15990-000', 'outro', 'R', '1', $2, $3,
             CASE WHEN $3 = 'arquivado' THEN now() END, CASE WHEN $3 = 'arquivado' THEN 'teste' END) RETURNING id`,
    [`Ponto ${randomUUID().slice(0, 8)}`, contaId, status],
  );
  const pontoId = rows[0].id;
  criados.pontos.push(pontoId);
  if (tela) {
    const t = await dispositivosRepo.criar(pontoId, {});
    await pool.query(
      `UPDATE dispositivos SET status = 'ativo', chave_hash = $3, primeiro_sinal_em = $2 WHERE id = $1`,
      [t.id, tela === 'sinal' ? new Date() : null, randomUUID()],
    );
    // A tela recém-criada recalcula o status; o teste fixa o que quer.
    await pool.query('UPDATE pontos SET status = $2 WHERE id = $1', [pontoId, status]);
    await basicoRepo.sincronizar({ apenasPontos: [pontoId] });
  }
  return pontoId;
}

const conta = (id) => anunciantesRepo.buscarPorId(id);

test('caso 1: conta comum sem plano e sem ponto continua no onboarding "Escolha seu plano"', async () => {
  const c = await novaConta();
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.completo, false);
  assert.strictEqual(a.motivo, null);
  const passos = await primeirosPassosDaConta(c);
  assert.strictEqual(passos.fluxo, 'anunciante');
  assert.strictEqual(passos.proxima, 'plano');
  assert.strictEqual(passos.etapas[0].titulo, 'Escolha seu plano');
});

test('caso 2: candidatura em análise não é ponto — acesso continua fechado', async () => {
  const c = await novaConta();
  await pool.query(
    `INSERT INTO candidaturas (tipo, nome, contato_telefone, conta_id, endereco, cidade, uf, cep, status)
     VALUES ('ponto', 'A', '1', $1, 'Rua A, 1', 'Matão', 'SP', '15990-000', 'nova')`,
    [c.id],
  );
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.completo, false);
  assert.strictEqual(a.donoDePonto, false);
  assert.strictEqual((await primeirosPassosDaConta(c)).fluxo, 'anunciante');
});

test('casos 3–5: dono de ponto aguardando instalação, sem plano — painel liberado, sem "Escolha seu plano", Básico aguardando', async () => {
  const c = await novaConta();
  await pontoDaConta(c.id, { status: 'a_instalar' });
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.completo, true, 'painel completo');
  assert.strictEqual(a.motivo, 'ponto');
  assert.strictEqual(a.podeVeicular, false, 'liberar o painel não dá direito de veicular');
  assert.strictEqual(a.basico.ativo, false);
  assert.strictEqual(a.basico.aguardando, 'instalacao');
  assert.deepStrictEqual(await basicoRepo.ativosDaConta(c.id), [], 'o Básico não é forçado');
  const passos = await primeirosPassosDaConta(c);
  assert.strictEqual(passos.fluxo, 'ponto');
  assert.ok(!passos.etapas.some((e) => e.id === 'plano'), 'nenhuma etapa de comprar plano');
  assert.deepStrictEqual(
    passos.etapas.map((e) => [e.id, e.feito]),
    [
      ['ponto', true],
      ['instalacao', false],
      ['sinal', false],
      ['basico', false],
      ['criativo', false],
      ['exibicoes', false],
    ],
  );
  assert.strictEqual(passos.proxima, 'instalacao');
  assert.strictEqual(passos.etapas.find((e) => e.id === 'criativo').disponivel, false, 'criativo só com o Básico');
});

test('caso 6: ponto aguardando primeiro sinal (tela instalada) — painel liberado, Básico ativo pela régua de sempre', async () => {
  const c = await novaConta();
  await pontoDaConta(c.id, { status: 'aguardando_primeiro_sinal', tela: 'instalada' });
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.completo, true);
  assert.strictEqual(a.pontos.telaInstalada, true);
  assert.strictEqual(a.pontos.primeiroSinal, false);
  // A régua do Básico é a tela instalada (src/pontos/basico.js) — não mudou.
  assert.strictEqual(a.basico.ativo, true);
  const passos = await primeirosPassosDaConta(c);
  assert.strictEqual(passos.fluxo, 'ponto');
  assert.strictEqual(passos.proxima, 'sinal');
  assert.strictEqual(passos.etapas.find((e) => e.id === 'criativo').disponivel, true);
});

test('caso 7: ponto ativo + Básico ativo — painel liberado, motivo é o Básico', async () => {
  const c = await novaConta();
  await pontoDaConta(c.id, { status: 'em_operacao', tela: 'sinal' });
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.completo, true);
  assert.strictEqual(a.motivo, 'basico');
  assert.strictEqual(a.podeVeicular, true);
  assert.strictEqual(a.basico.aguardando, null);
  const passos = await primeirosPassosDaConta(c);
  assert.strictEqual(passos.fluxo, 'ponto');
  assert.strictEqual(passos.proxima, 'criativo');
  assert.ok(!passos.etapas.some((e) => e.id === 'plano'), 'Básico não marca "plano" como feito');
});

test('caso 8: dono de ponto + plano comercial — fluxo normal de anunciante, sem regressão', async () => {
  const c = await novaConta({ plano: 'essencial-1m' });
  await pontoDaConta(c.id, { status: 'a_instalar' });
  const a = await acessoDoPainel(await conta(c.id));
  assert.strictEqual(a.completo, true);
  assert.strictEqual(a.motivo, 'plano');
  assert.strictEqual(a.podeVeicular, true);
  const passos = await primeirosPassosDaConta(await conta(c.id));
  assert.strictEqual(passos.fluxo, 'anunciante');
  assert.strictEqual(passos.etapas[0].feito, true);
});

test('caso 9: ponto arquivado sem nenhum outro direito não libera o painel', async () => {
  const c = await novaConta();
  await pontoDaConta(c.id, { status: 'arquivado' });
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.completo, false);
  assert.strictEqual(a.donoDePonto, false);
  assert.strictEqual((await primeirosPassosDaConta(c)).fluxo, 'anunciante');
});

test('caso 10: vários pontos em estados diferentes — decisão consistente', async () => {
  const c = await novaConta();
  await pontoDaConta(c.id, { status: 'arquivado' });
  await pontoDaConta(c.id, { status: 'em_reparo' });
  await pontoDaConta(c.id, { status: 'inativo' });
  await pontoDaConta(c.id, { status: 'a_instalar' });
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.completo, true);
  assert.strictEqual(a.pontos.total, 3, 'arquivado fora da conta');
  assert.deepStrictEqual(a.pontos.porStatus, { em_reparo: 1, inativo: 1, a_instalar: 1 });
  assert.strictEqual(a.pontos.emOperacao, 0);
  assert.strictEqual(a.basico.pendentes.length, 3, 'um Básico por ponto da rede, arquivado fora');
});

// Revisão Codex do #108: com vários pontos, um Básico já ativo não esconde o
// ponto que ainda espera, e dois pontos esperando não viram uma linha só.
test('caso 10b: Básico por ponto — ativo num ponto, aguardando no outro', async () => {
  const c = await novaConta();
  const ativo = await pontoDaConta(c.id, { status: 'em_operacao', tela: 'sinal' });
  const semTela = await pontoDaConta(c.id, { status: 'a_instalar' });
  const outroSemTela = await pontoDaConta(c.id, { status: 'a_instalar' });
  const a = await acessoDoPainel(c);
  assert.strictEqual(a.basico.ativo, true);
  assert.strictEqual(a.basico.aguardando, null, 'a conta já tem Básico');
  assert.deepStrictEqual(
    a.basico.pendentes.map((p) => [p.pontoId, p.aguardando]),
    [
      [Number(semTela), 'instalacao'],
      [Number(outroSemTela), 'instalacao'],
    ],
  );
  assert.ok(!a.basico.pendentes.some((p) => p.pontoId === Number(ativo)), 'o ponto com Básico ativo não fica pendente');
});

test('plano vencido continua com acesso pela régua de antes (plano_id); suspensa idem — o painel trata', async () => {
  const c = await novaConta({ plano: 'essencial-1m' });
  await pool.query(`UPDATE anunciantes SET data_expiracao = '2020-01-01', suspenso = true WHERE id = $1`, [c.id]);
  const a = await acessoDoPainel(await conta(c.id));
  assert.strictEqual(a.completo, true);
  assert.strictEqual(a.podeVeicular, false, 'vencido não veicula');
});

// Caso 11: o que o painel lê (GET /anunciantes/me) e o endpoint de primeiros
// passos dizem a mesma coisa.
test('caso 11: GET /anunciantes/me e GET /anunciantes/me/primeiros-passos têm a mesma interpretação', async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-acesso', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (caminho, id) => (await fetch(base + caminho, { headers: { 'x-conta': String(id) } })).json();
  try {
    for (const [status, esperado] of [
      [null, { completo: false, fluxo: 'anunciante' }],
      ['a_instalar', { completo: true, fluxo: 'ponto' }],
      ['arquivado', { completo: false, fluxo: 'anunciante' }],
    ]) {
      const c = await novaConta();
      if (status) await pontoDaConta(c.id, { status });
      const me = await get('/anunciantes/me', c.id);
      const passos = await get('/anunciantes/me/primeiros-passos', c.id);
      assert.strictEqual(me.acesso_painel.completo, esperado.completo, `status ${status}`);
      assert.strictEqual(passos.fluxo, esperado.fluxo, `status ${status}`);
      assert.strictEqual(me.acesso_painel.donoDePonto, passos.fluxo === 'ponto');
      // O criativo continua fechado sem plano nem Básico (servidor).
      const criativos = await get('/anunciantes/me/criativos', c.id);
      assert.strictEqual(criativos.temPlano, false);
      assert.strictEqual(criativos.aguardandoBeneficio, status === 'a_instalar' ? 'instalacao' : null);
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
});
