const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const apoio = require('./trimundi-apoio');
const { consultar, emTransacao } = require('../src/trimundi/db/conexao');

// Alertas da saúde (B13): o vigia (dentro do serviço) e a sentinela (tarefa
// agendada do Northflank). E-mail de verdade nunca: o envio vai para um
// arquivo de captura (TRIMUNDI_EMAIL_CAPTURA), só neste processo.
const CAPTURA = path.join(os.tmpdir(), `trimundi-alertas-${process.pid}.jsonl`);
process.env.TRIMUNDI_EMAIL_FROM = 'alertas@teste.invalid';
process.env.TRIMUNDI_ALERTA_EMAIL = 'dono@teste.invalid';
process.env.TRIMUNDI_EMAIL_CAPTURA = CAPTURA;

const alertas = require('../src/trimundi/alertas');
const sentinela = require('../src/trimundi/sentinela');
const saude = require('../src/trimundi/saude');

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
  // Só este arquivo mexe em saude_alertas; começa limpo.
  await consultar('DELETE FROM saude_alertas');
});
test.after(async () => {
  fs.rmSync(CAPTURA, { force: true });
  await srv.fechar();
  await apoio.encerrar();
});

const enviados = () =>
  fs.existsSync(CAPTURA)
    ? fs
        .readFileSync(CAPTURA, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
const processar = (origem, ativos) => alertas.processar(emTransacao, origem, ativos);
const A = { chave: 'sentinela:teste_a', texto: 'A caiu.', acao: 'olhar A' };

test('ciclo de um alerta: novo avisa, repetido não, lembrete em 6 h, resolvido avisa uma vez, volta como novo', async () => {
  const antes = enviados().length;
  let r = await processar('sentinela', [A]);
  assert.strictEqual(r.enviado, true);
  let m = enviados().at(-1);
  assert.strictEqual(m.para, 'dono@teste.invalid');
  assert.match(m.assunto, /^\[TICK\] ALERTA: 1 problema/);
  assert.match(m.texto, /NOVO:\n- A caiu\.\n {2}O que fazer: olhar A/);
  assert.match(m.texto, /RUNBOOK\.md §11\.5/);

  r = await processar('sentinela', [A]);
  assert.strictEqual(r.enviado, false, 'a mesma coisa na volta seguinte não avisa de novo');
  assert.strictEqual(enviados().length, antes + 1);

  await consultar("UPDATE saude_alertas SET avisado_em = now() - interval '7 hours' WHERE chave = $1", [A.chave]);
  r = await processar('sentinela', [A]);
  assert.strictEqual(r.enviado, true);
  assert.match(enviados().at(-1).texto, /CONTINUA \(lembrete a cada 6 h\)/);

  r = await processar('sentinela', []);
  assert.strictEqual(r.enviado, true);
  m = enviados().at(-1);
  assert.match(m.assunto, /^\[TICK\] Resolvido: 1 problema/);
  assert.match(m.texto, /RESOLVIDO:\n- A caiu\./);
  assert.strictEqual((await processar('sentinela', [])).enviado, false);

  r = await processar('sentinela', [A]);
  assert.strictEqual(r.novos.length, 1, 'voltou: é novo de novo');
  const { rows } = await consultar('SELECT avisos, resolvido_em FROM saude_alertas WHERE chave = $1', [A.chave]);
  assert.deepStrictEqual(rows[0], { avisos: 1, resolvido_em: null });
  await processar('sentinela', []);
});

test('envio que falha desfaz: a volta seguinte avisa como novo; origens não se misturam', async () => {
  // Captura apontando para uma pasta: o appendFile falha como um SMTP fora.
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'trimundi-alerta-'));
  process.env.TRIMUNDI_EMAIL_CAPTURA = pasta;
  await assert.rejects(processar('sentinela', [{ chave: 'sentinela:teste_b', texto: 'B caiu.' }]));
  process.env.TRIMUNDI_EMAIL_CAPTURA = CAPTURA;
  fs.rmSync(pasta, { recursive: true, force: true });
  const { rows } = await consultar('SELECT avisado_em, avisos FROM saude_alertas WHERE chave = $1', [
    'sentinela:teste_b',
  ]);
  assert.deepStrictEqual(rows[0], { avisado_em: null, avisos: 0 });

  const r = await processar('sentinela', [{ chave: 'sentinela:teste_b', texto: 'B caiu.' }]);
  assert.strictEqual(r.enviado, true);
  assert.strictEqual(r.novos.length, 1);
  assert.match(enviados().at(-1).texto, /NOVO:\n- B caiu\./);

  // O vigia não resolve o que é da sentinela.
  await processar('vigia', []);
  const { rows: b } = await consultar('SELECT resolvido_em FROM saude_alertas WHERE chave = $1', ['sentinela:teste_b']);
  assert.strictEqual(b[0].resolvido_em, null);
  await processar('sentinela', []);
});

test('trava: com outra volta decidindo, esta não avisa nada', async () => {
  const { Client } = require('pg');
  const config = require('../src/trimundi/config');
  const outra = new Client({ connectionString: config.urlDoBanco() });
  await outra.connect();
  try {
    await outra.query('BEGIN');
    await outra.query('SELECT pg_advisory_xact_lock($1)', [alertas.TRAVA]);
    const r = await processar('sentinela', [{ chave: 'sentinela:teste_c', texto: 'C caiu.' }]);
    assert.strictEqual(r.enviado, false);
    assert.strictEqual(r.pulado, true);
    await outra.query('COMMIT');
  } finally {
    await outra.end();
  }
});

test('vigia: pedido pago sem ingresso vira alerta com o código; resolvido quando some', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  const codigo = p.pedido_id.slice(0, 8).toUpperCase();
  await consultar("UPDATE pedidos SET status = 'pago', pago_em = now() - interval '20 minutes' WHERE id = $1", [
    p.pedido_id,
  ]);
  try {
    const r = await alertas.vigiar();
    assert.ok(r.enviado, 'avisou');
    const m = enviados().at(-1);
    assert.match(m.assunto, /ALERTA/);
    assert.ok(m.texto.includes('sem nenhum ingresso emitido'), m.texto);
    assert.ok(m.texto.includes(codigo), 'o código curto do pedido vai no aviso');
    // Nenhum dado pessoal: nem e-mail nem CPF de comprador.
    assert.doesNotMatch(m.texto, /@(?!teste\.invalid)|\d{3}\.\d{3}\.\d{3}-\d{2}/);
    const r2 = await alertas.vigiar();
    assert.ok(!r2.novos?.some((a) => a.chave === 'vigia:pago_sem_ingresso'), 'não repete');
  } finally {
    await consultar("UPDATE pedidos SET status = 'cancelado', pago_em = NULL WHERE id = $1", [p.pedido_id]);
  }
  const r3 = await alertas.vigiar();
  assert.ok(
    r3.resolvidos?.some((a) => a.chave === 'vigia:pago_sem_ingresso'),
    'resolvido',
  );
});

test('saúde pública: só { ok }, 503 com sinal crítico, sem detalhe', async () => {
  const cliente = apoio.cliente(srv);
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await consultar("UPDATE pedidos SET status = 'pago', pago_em = now() - interval '20 minutes' WHERE id = $1", [
    p.pedido_id,
  ]);
  try {
    saude.esquecerEstado();
    const r = await cliente.get('/ticket/api/saude');
    assert.strictEqual(r.status, 503);
    assert.deepStrictEqual(r.json, { ok: false });
    assert.strictEqual(r.headers.get('cache-control'), 'no-store');
  } finally {
    await consultar("UPDATE pedidos SET status = 'cancelado', pago_em = NULL WHERE id = $1", [p.pedido_id]);
  }
  saude.esquecerEstado();
  const ok = await cliente.get('/ticket/api/saude');
  assert.ok([200, 503].includes(ok.status));
  assert.deepStrictEqual(ok.json, { ok: ok.status === 200 });
});

test('sentinela: confere o site de fora, avisa uma vez e resolve; sem banco avisa assim mesmo', async () => {
  const url = require('../src/trimundi/config').urlDoBanco();
  // Site no ar: /health responde; a saúde pode estar ok ou não (banco compartilhado).
  const falhas = await sentinela.checarAlvos(srv.base, { espera: 0 });
  assert.ok(!falhas.some((f) => f.chave === 'sentinela:site'));

  // Site fora (porta fechada): os dois alvos falham, um aviso só.
  const fora = 'http://127.0.0.1:9';
  const antes = enviados().length;
  let r = await sentinela.rodar({ base: fora, url, espera: 0 });
  assert.deepStrictEqual(r.falhas.map((f) => f.chave).sort(), ['sentinela:site', 'sentinela:tick']);
  assert.strictEqual(r.resultado.enviado, true);
  assert.match(enviados().at(-1).texto, /o site \(\/health\) não respondeu/);
  r = await sentinela.rodar({ base: fora, url, espera: 0 });
  assert.strictEqual(r.resultado.enviado, false, 'não repete');
  assert.strictEqual(enviados().length, antes + 1);

  // Sem o banco dos alertas: avisa direto (repetir é melhor que calar).
  r = await sentinela.rodar({ base: fora, url: 'postgres://x:y@127.0.0.1:9/nada', espera: 0 });
  assert.strictEqual(r.resultado.sem_registro, true);
  assert.strictEqual(enviados().length, antes + 2);

  // Voltou: o site responde de novo → "resolvido" para o /health.
  r = await sentinela.rodar({ base: srv.base, url, espera: 0 });
  assert.ok(r.resultado.resolvidos?.some((a) => a.chave === 'sentinela:site'));
  assert.match(enviados().at(-1).texto, /RESOLVIDO/);
});
