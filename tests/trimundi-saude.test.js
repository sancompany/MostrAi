const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const apoio = require('./trimundi-apoio');
const { Client } = require('pg');
const { consultar } = require('../src/trimundi/db/conexao');
const config = require('../src/trimundi/config');
const saude = require('../src/trimundi/saude');

// Saúde da TICK (C3): cada sinal provocado de verdade no banco de teste e
// conferido pela contagem. O banco é compartilhado com os outros arquivos
// (rodam em paralelo), então cada caso compara com a contagem de antes.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const qtd = (r, chave) => r.sinais.find((s) => s.chave === chave)?.quantidade || 0;
const doSinal = (r, chave) => r.sinais.find((s) => s.chave === chave);

test('rota do Admin: só com sessão de admin; resposta sem dado pessoal', async () => {
  const anonimo = apoio.cliente(srv);
  assert.strictEqual((await anonimo.get('/admin/trimundi/saude')).status, 401);
  const admin = apoio.cliente(srv, { cookie: await apoio.entrarAdmin(srv) });
  const r = await admin.get('/admin/trimundi/saude');
  assert.strictEqual(r.status, 200);
  assert.ok(['ok', 'atencao', 'critico'].includes(r.json.nivel));
  assert.ok(Array.isArray(r.json.sinais));
  for (const s of r.json.sinais) {
    assert.deepStrictEqual(
      Object.keys(s).filter((k) => !['chave', 'nivel', 'quantidade', 'texto', 'acao', 'pedidos'].includes(k)),
      [],
    );
    for (const c of s.pedidos || []) assert.match(c, /^[0-9A-F]{8}$/);
  }
  // Ambiente de teste sem e-mail: o sinal crítico aparece e manda no nível.
  assert.ok(doSinal(r.json, 'email_ausente'));
  assert.strictEqual(r.json.nivel, 'critico');
});

test('pedido pago sem ingresso: crítico, com o código curto do pedido', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  const antes = qtd(await saude.verificar(), 'pago_sem_ingresso');
  // Falha de integridade simulada: o pedido virou pago e nada foi emitido.
  await consultar("UPDATE pedidos SET status = 'pago', pago_em = now() - interval '20 minutes' WHERE id = $1", [
    p.pedido_id,
  ]);
  const r = await saude.verificar();
  assert.strictEqual(qtd(r, 'pago_sem_ingresso'), antes + 1);
  const s = doSinal(r, 'pago_sem_ingresso');
  assert.strictEqual(s.nivel, 'critico');
  assert.strictEqual(r.nivel, 'critico');
  if (antes < 10) assert.ok(s.pedidos.includes(p.pedido_id.slice(0, 8).toUpperCase()));

  // Pago há menos de 10 min ainda está dentro do prazo da emissão: não acusa.
  await consultar("UPDATE pedidos SET pago_em = now() - interval '1 minute' WHERE id = $1", [p.pedido_id]);
  assert.strictEqual(qtd(await saude.verificar(), 'pago_sem_ingresso'), antes);
  await consultar("UPDATE pedidos SET status = 'cancelado', pago_em = NULL WHERE id = $1", [p.pedido_id]);
});

test('pedido pago pelo fluxo de verdade (com ingresso) não acusa nada', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2));
  await apoio.pagar(p.pedido_id);
  await consultar("UPDATE pedidos SET pago_em = now() - interval '20 minutes' WHERE id = $1", [p.pedido_id]);
  const s = doSinal(await saude.verificar(), 'pago_sem_ingresso');
  assert.ok(!s?.pedidos?.includes(p.pedido_id.slice(0, 8).toUpperCase()));
});

test('reserva vencida e não expirada: atenção (a expiração parou)', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  const antes = qtd(await saude.verificar(), 'expiracao_parada');
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '30 minutes' WHERE id = $1", [p.pedido_id]);
  const r = await saude.verificar();
  // Outro arquivo pode rodar a expiração ao mesmo tempo e levar este pedido:
  // só conta se ele ainda estiver aguardando.
  const { rows } = await consultar('SELECT status FROM pedidos WHERE id = $1', [p.pedido_id]);
  if (rows[0].status === 'aguardando_pagamento') {
    assert.ok(qtd(r, 'expiracao_parada') >= antes + 1);
    assert.strictEqual(doSinal(r, 'expiracao_parada').nivel, 'atencao');
  }
  await consultar(
    "UPDATE pedidos SET status = 'expirado', encerrado_em = now() WHERE id = $1 AND status = 'aguardando_pagamento'",
    [p.pedido_id],
  );
});

test('fila de pagamento parada: crítico; aviso morto: atenção', async () => {
  const antes = await saude.verificar();
  const id = `saude-teste-${crypto.randomUUID()}`;
  const { rows } = await consultar(
    `INSERT INTO pagamento_eventos (evento_id, provedor, status, payload, processamento, proxima_tentativa_em)
     VALUES ($1, 'teste', 'confirmado', '{}', 'recebido', now() - interval '20 minutes') RETURNING id`,
    [id],
  );
  // Segura a linha: a fila dos outros arquivos usa SKIP LOCKED e passa por
  // cima dela — a contagem (SELECT simples) continua vendo.
  // Conexão própria: o pool da TICK tem uma vaga só, e a conferência
  // precisa dela enquanto a trava fica aberta.
  const trava = new Client({ connectionString: config.urlDoBanco() });
  await trava.connect();
  await trava.query(`SET search_path TO ${config.ESQUEMA}`);
  try {
    await trava.query('BEGIN');
    const { rows: presa } = await trava.query(
      "SELECT processamento FROM pagamento_eventos WHERE id = $1 AND processamento = 'recebido' FOR UPDATE",
      [rows[0].id],
    );
    if (presa.length) {
      const r = await saude.verificar();
      assert.strictEqual(qtd(r, 'fila_pagamento_parada'), qtd(antes, 'fila_pagamento_parada') + 1);
      assert.strictEqual(doSinal(r, 'fila_pagamento_parada').nivel, 'critico');
    }
    await trava.query("UPDATE pagamento_eventos SET processamento = 'morto', tentativas = 6 WHERE id = $1", [
      rows[0].id,
    ]);
    await trava.query('COMMIT');
  } finally {
    await trava.end();
  }
  const depois = await saude.verificar();
  assert.ok(qtd(depois, 'pagamento_morto') >= qtd(antes, 'pagamento_morto') + 1);
  assert.strictEqual(doSinal(depois, 'pagamento_morto').nivel, 'atencao');
});

test('fila de e-mail parada e e-mail que falhou', async () => {
  const antes = await saude.verificar();
  const sufixo = crypto.randomUUID();
  await consultar(
    `INSERT INTO emails (chave, tipo, para, assunto, texto, status, proxima_tentativa_em)
     VALUES ($1, 'teste', 'saude@exemplo.invalid', 'teste', 'teste', 'na_fila', now() - interval '20 minutes'),
            ($2, 'teste', 'saude@exemplo.invalid', 'teste', 'teste', 'falhou', now())`,
    [`saude-fila-${sufixo}`, `saude-falhou-${sufixo}`],
  );
  const r = await saude.verificar();
  // Sem provedor no teste, ninguém processa a fila: a contagem é exata.
  assert.strictEqual(qtd(r, 'fila_email_parada'), qtd(antes, 'fila_email_parada') + 1);
  assert.strictEqual(doSinal(r, 'fila_email_parada').nivel, 'critico');
  assert.strictEqual(qtd(r, 'email_falhou'), qtd(antes, 'email_falhou') + 1);
  assert.strictEqual(doSinal(r, 'email_falhou').nivel, 'atencao');
  await consultar("UPDATE emails SET status = 'enviado', enviado_em = now() WHERE chave LIKE $1", [
    `saude-%-${sufixo}`,
  ]);
});

test('aviso "Precisa de você" entra na saúde e sai quando resolvido', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  const antes = qtd(await saude.verificar(), 'aviso_valor_divergente');
  // Pagamento com valor diferente do pedido: o aviso que o Admin já mostra.
  const payload = await apoio.aviso(p.pedido_id, 'confirmado', { valorComDesconto: 1 });
  await apoio.aplicarAviso(payload);
  const participantes = require('../src/trimundi/participantes');
  const avisos = (await participantes.avisos(pronta.edicao.id)).filter((a) => a.tipo === 'valor_divergente');
  assert.strictEqual(avisos.length, 1, 'o cenário precisa gerar o aviso de valor divergente');
  const r = await saude.verificar();
  assert.strictEqual(qtd(r, 'aviso_valor_divergente'), antes + 1);
  assert.strictEqual(doSinal(r, 'aviso_valor_divergente').texto, participantes.TEXTO_AVISO.valor_divergente);

  await participantes.resolverAviso(
    pronta.edicao.id,
    { chave: avisos[0].chave, motivo: 'conferido no teste' },
    apoio.AUTOR,
  );
  assert.strictEqual(qtd(await saude.verificar(), 'aviso_valor_divergente'), antes);
});
