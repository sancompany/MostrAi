const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const pedidos = require('../src/trimundi/pedidos');
const catalogo = require('../src/trimundi/catalogo');
const promocoes = require('../src/trimundi/promocoes');
const emissao = require('../src/trimundi/emissao');
const participantes = require('../src/trimundi/participantes');
const reembolsos = require('../src/trimundi/reembolsos');
const checkout = require('../src/trimundi/checkout/cliente');
const { conciliarPendentes } = require('../src/trimundi/checkout/conciliar');
const { lerQr } = require('../src/trimundi/lib/qr');

// Trimundi, Etapas 4 e 5 — pagamento pelo San Checkout (contrato v2, API.md
// do Checkout): webhook assinado e idempotente, emissão na confirmação,
// pagamento tardio, chargeback, reembolso total e parcial com a nossa chave
// de idempotência, o GET /pedido que o Checkout chama e a conciliação.
// Nada aqui fala com o Checkout de verdade: o cliente HTTP é um dublê.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  checkout.substituir(null);
  await srv.fechar();
  await apoio.encerrar();
});

const { itensDe } = apoio;

async function postarWebhook(payload, opcoes) {
  const { corpo, headers } = apoio.assinarWebhook(payload, opcoes);
  const r = await fetch(`${srv.base}/ticket/api/checkout/webhook`, { method: 'POST', headers, body: corpo });
  return { status: r.status, json: await r.json().catch(() => null) };
}

const linha = async (sql, params) => (await consultar(sql, params)).rows[0];
const ingressosDo = async (pedidoId) =>
  (
    await consultar(
      'SELECT id, status, motivo_status, valor_centavos, lote_id FROM ingressos WHERE pedido_id = $1 ORDER BY id',
      [pedidoId],
    )
  ).rows;

test('webhook fechado na falha: sem assinatura, chave errada, hora velha ou corpo alterado → 401 e nada gravado', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  const payload = await apoio.aviso(p.pedido_id, 'confirmado');

  const semAssinatura = await fetch(`${srv.base}/ticket/api/checkout/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(semAssinatura.status, 401);
  assert.equal((await postarWebhook(payload, { chave: 'chave-de-outro-contratante-0123456789' })).status, 401);
  assert.equal((await postarWebhook(payload, { ts: Math.floor(Date.now() / 1000) - 600 })).status, 401);
  // Mostraí e Trimundi são contratantes diferentes: a chave da Mostraí não serve.
  assert.equal((await postarWebhook(payload, { chave: 'chave-da-mostrai-nao-vale-aqui-0123456789' })).status, 401);
  const { corpo, headers } = apoio.assinarWebhook(payload);
  const alterado = await fetch(`${srv.base}/ticket/api/checkout/webhook`, {
    method: 'POST',
    headers,
    body: corpo.replace('"confirmado"', '"estornado"'),
  });
  assert.equal(alterado.status, 401);

  const n = await linha('SELECT count(*)::int AS n FROM pagamento_eventos WHERE evento_id = $1', [payload.eventoId]);
  assert.equal(n.n, 0);
  assert.equal((await linha('SELECT status FROM pedidos WHERE id = $1', [p.pedido_id])).status, 'aguardando_pagamento');
});

test('confirmado: um ingresso por vaga, com benefício, QR e aviso ao comprador na fila de e-mail', async () => {
  const pronta = await apoio.edicaoPronta();
  const b = await catalogo.criarBeneficio(pronta.edicao.id, { nome: 'Open bar' }, apoio.AUTOR);
  await catalogo.atualizarTipo(pronta.tipo.id, { beneficios: [b.id] }, apoio.AUTOR);
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  const payload = await apoio.aviso(p.pedido_id, 'confirmado');

  const r = await postarWebhook(payload);
  assert.equal(r.status, 200);
  assert.equal(await apoio.aguardarEvento(payload.eventoId), 'aplicado');

  const pedido = await linha('SELECT * FROM pedidos WHERE id = $1', [p.pedido_id]);
  assert.equal(pedido.status, 'pago');
  assert.equal(pedido.charge_id, payload.chargeId);
  assert.equal(Number(pedido.valor_cobrado_centavos), 10149, 'o que o comprador pagou, com as taxas por cima');
  const ingressos = await ingressosDo(p.pedido_id);
  assert.equal(ingressos.length, 2);
  for (const i of ingressos) {
    assert.equal(i.status, 'valido');
    assert.equal(Number(i.valor_centavos), 5000);
    const ben = await consultar('SELECT nome, origem FROM ingresso_beneficios WHERE ingresso_id = $1', [i.id]);
    assert.deepEqual(ben.rows, [{ nome: 'Open bar', origem: 'categoria' }]);
    const h = await linha(
      "SELECT count(*)::int AS n FROM ingresso_historico WHERE ingresso_id = $1 AND tipo = 'emitido'",
      [i.id],
    );
    assert.equal(h.n, 1);
  }
  const email = await linha('SELECT tipo, status, para, texto FROM emails WHERE chave = $1', [
    `pedido_confirmado:${p.pedido_id}`,
  ]);
  assert.equal(email.tipo, 'pedido_confirmado');
  assert.equal(email.status, 'aguardando_provedor', 'sem provedor de e-mail, nunca finge que enviou');
  assert.equal(email.para, p.corpo.comprador.email);
  assert.match(email.texto, new RegExp(`/ticket/pedido/${p.pedido_id}\\?t=`));

  // O QR de cada ingresso confere com a assinatura da edição e não leva CPF.
  const pagina = await pedidos.paraComprador(p.pedido_id, p.token);
  const { codigo_publico: codigoPublico } = await linha('SELECT codigo_publico FROM edicoes WHERE id = $1', [
    pronta.edicao.id,
  ]);
  const { rows: codigos } = await consultar('SELECT codigo FROM ingressos WHERE pedido_id = $1', [p.pedido_id]);
  for (const c of codigos) {
    const conteudo = require('../src/trimundi/lib/qr').conteudoDoQr(codigoPublico, c.codigo);
    assert.deepEqual(lerQr(conteudo), { codigoPublico, codigo: c.codigo });
    assert.equal(conteudo.includes(p.corpo.comprador.cpf), false);
  }
  assert.equal(pagina.ingressos.length, 2);
});

test('o mesmo aviso cinco vezes ao mesmo tempo: uma linha na fila, uma emissão', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  const payload = await apoio.aviso(p.pedido_id, 'confirmado');
  const respostas = await Promise.all(Array.from({ length: 5 }, () => postarWebhook(payload)));
  assert.deepEqual(
    respostas.map((r) => r.status),
    [200, 200, 200, 200, 200],
  );
  await apoio.aguardarEvento(payload.eventoId);
  assert.equal(
    (await linha('SELECT count(*)::int AS n FROM pagamento_eventos WHERE evento_id = $1', [payload.eventoId])).n,
    1,
  );
  assert.equal((await ingressosDo(p.pedido_id)).length, 2);
});

test('aviso novo do mesmo pagamento não emite de novo; outro chargeId é pagamento duplicado e vira aviso', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  const primeiro = await apoio.aviso(p.pedido_id, 'confirmado');
  await apoio.aplicarAviso(primeiro);
  assert.equal(await apoio.aplicarAviso({ ...primeiro, eventoId: apoio.chave() }), 'ja_aplicado');
  const duplicado = await apoio.aplicarAviso({
    ...primeiro,
    eventoId: apoio.chave(),
    chargeId: `pay_${apoio.sufixo()}`,
    pagamentoDuplicado: true,
  });
  assert.equal(duplicado, 'pagamento_duplicado');
  assert.equal((await ingressosDo(p.pedido_id)).length, 1);
  const avisos = await participantes.avisos(pronta.edicao.id);
  assert.ok(avisos.some((a) => a.tipo === 'pagamento_duplicado' && a.pedido_id === p.pedido_id));
});

test('valor diferente do pedido não libera nada e vira aviso', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  assert.equal(
    await apoio.aplicarAviso(await apoio.aviso(p.pedido_id, 'confirmado', { valorComDesconto: 5 })),
    'valor_divergente',
  );
  assert.equal((await linha('SELECT status FROM pedidos WHERE id = $1', [p.pedido_id])).status, 'aguardando_pagamento');
  assert.equal((await ingressosDo(p.pedido_id)).length, 0);
  assert.ok((await participantes.avisos(pronta.edicao.id)).some((a) => a.tipo === 'valor_divergente'));
});

test('recusado não derruba o pedido: segue aguardando, e dá para pagar de novo', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  assert.equal(await apoio.aplicarAviso(await apoio.aviso(p.pedido_id, 'recusado')), 'recusado_aguardando');
  const pagina = await pedidos.paraComprador(p.pedido_id, p.token);
  assert.equal(pagina.pedido.status, 'aguardando_pagamento');
  assert.equal(pagina.pedido.pagamento_recusado, true);
  assert.ok(pagina.pagamento.url, 'o link de pagamento continua');
  assert.equal(await apoio.pagar(p.pedido_id), 'aplicado');
});

test('pagamento depois da reserva vencida: emite se ainda cabe; se não cabe, pago sem vaga', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 1 }] });
  const atrasado = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [
    atrasado.pedido_id,
  ]);
  const outro = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  await apoio.pagar(outro.pedido_id);
  assert.equal(await apoio.pagar(atrasado.pedido_id), 'sem_vaga');
  assert.equal((await linha('SELECT status FROM pedidos WHERE id = $1', [atrasado.pedido_id])).status, 'pago_sem_vaga');
  assert.equal((await ingressosDo(atrasado.pedido_id)).length, 0, 'nunca vende acima do estoque');
  assert.ok(
    (await participantes.avisos(pronta.edicao.id)).some(
      (a) => a.tipo === 'sem_vaga' && a.pedido_id === atrasado.pedido_id,
    ),
  );

  const folgada = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 5 }] });
  const tarde = await apoio.novoPedido(folgada, itensDe(folgada.tipo, 2));
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '2 hours' WHERE id = $1", [tarde.pedido_id]);
  await pedidos.expirarVencidos(tarde.pedido_id);
  assert.equal(await apoio.pagar(tarde.pedido_id), 'aplicado');
  assert.equal((await ingressosDo(tarde.pedido_id)).length, 2);
});

test('pagamento atrasado de lote encerrado não pega vaga do lote seguinte (sem sobra)', async () => {
  const pronta = await apoio.edicaoPronta({
    lotes: [
      { preco_centavos: 5000, quantidade: 2 },
      { preco_centavos: 8000, quantidade: 5 },
    ],
  });
  const atrasado = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [
    atrasado.pedido_id,
  ]);
  const { rows: lotes } = await consultar('SELECT id FROM lotes WHERE categoria_id = $1 ORDER BY ordem', [
    pronta.tipo.id,
  ]);
  await catalogo.encerrarLote(lotes[0].id, apoio.AUTOR);
  assert.equal(await apoio.pagar(atrasado.pedido_id), 'sem_vaga', 'o 2º lote tem vaga, mas é de outro lote');
  assert.equal((await ingressosDo(atrasado.pedido_id)).length, 0);
});

test('combo: cada posição é um ingresso próprio, e o benefício não se repete', async () => {
  const pronta = await apoio.edicaoPronta();
  const b1 = await catalogo.criarBeneficio(pronta.edicao.id, { nome: 'Camarim' }, apoio.AUTOR);
  const b2 = await catalogo.criarBeneficio(pronta.edicao.id, { nome: 'Copo' }, apoio.AUTOR);
  await catalogo.atualizarTipo(pronta.tipo.id, { beneficios: [b1.id] }, apoio.AUTOR);
  const combo = await promocoes.criarPromocao(
    pronta.edicao.id,
    {
      nome: 'Casal',
      preco_total_centavos: 8000,
      quantidade: 3,
      itens: [
        { categoria_id: pronta.tipo.id, quantidade: 1, beneficio_id: b2.id },
        { categoria_id: pronta.tipo.id, quantidade: 1, beneficio_id: b1.id },
      ],
    },
    apoio.AUTOR,
  );
  const p = await apoio.novoPedido(pronta, { combos: [{ promocao_id: combo.id, quantidade: 1 }] });
  await apoio.pagar(p.pedido_id);
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, i.participante_id, i.promocao_id, i.valor_centavos,
            (SELECT array_agg(ib.nome ORDER BY ib.nome) FROM ingresso_beneficios ib WHERE ib.ingresso_id = i.id) AS beneficios
       FROM ingressos i JOIN reservas r ON r.id = i.reserva_id WHERE i.pedido_id = $1 ORDER BY r.posicao`,
    [p.pedido_id],
  );
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].codigo, rows[1].codigo);
  assert.notEqual(rows[0].participante_id, rows[1].participante_id);
  assert.deepEqual(rows[0].beneficios, ['Camarim', 'Copo'], 'o do tipo + o do combo');
  assert.deepEqual(rows[1].beneficios, ['Camarim'], 'o do combo igual ao do tipo não duplica');
  assert.equal(Number(rows[0].valor_centavos) + Number(rows[1].valor_centavos), 8000);
  assert.ok(rows.every((r) => Number(r.promocao_id) === Number(combo.id)));
});

test('chargeback bloqueia; baixa desfeita bloqueia e o novo confirmado desbloqueia (o chargeback não)', async () => {
  const pronta = await apoio.edicaoPronta();
  const a = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  const confirmacao = await apoio.aviso(a.pedido_id, 'confirmado');
  await apoio.aplicarAviso(confirmacao);
  assert.equal(
    await apoio.aplicarAviso({ ...confirmacao, eventoId: apoio.chave(), status: 'chargeback' }),
    'bloqueado_chargeback',
  );
  assert.deepEqual(
    (await ingressosDo(a.pedido_id)).map((i) => i.status),
    ['bloqueado', 'bloqueado'],
  );
  // Um confirmado depois não tira o bloqueio do chargeback (decisão de gente).
  await apoio.aplicarAviso({ ...confirmacao, eventoId: apoio.chave() });
  assert.deepEqual(
    (await ingressosDo(a.pedido_id)).map((i) => i.status),
    ['bloqueado', 'bloqueado'],
  );
  assert.equal((await participantes.resumo(pronta.edicao.id)).chargebacks, 1);

  const b = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  const conf = await apoio.aviso(b.pedido_id, 'confirmado');
  await apoio.aplicarAviso(conf);
  assert.equal(
    await apoio.aplicarAviso({ ...conf, eventoId: apoio.chave(), status: 'pendente' }),
    'bloqueado_pagamento_desfeito',
  );
  assert.equal((await ingressosDo(b.pedido_id))[0].status, 'bloqueado');
  assert.equal(await apoio.aplicarAviso({ ...conf, eventoId: apoio.chave() }), 'pagamento_refeito');
  assert.equal((await ingressosDo(b.pedido_id))[0].status, 'valido');
});

// ------------------------------------------------------------- reembolsos
function duble(respostas) {
  const chamadas = [];
  checkout.substituir({
    estornar: async (dados) => {
      chamadas.push(dados);
      const r = respostas.shift();
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r(dados) : r;
    },
  });
  return chamadas;
}

test('reembolso total: o 200 do Checkout já confirma; o aviso depois não muda nada nem vira alarme', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  await apoio.pagar(p.pedido_id);
  const { charge_id: chargeId } = await linha('SELECT charge_id FROM pedidos WHERE id = $1', [p.pedido_id]);
  const chamadas = duble([
    { status: 200, ok: true, corpo: { chargeId, status: 'estornado', valorEstornado: 101.49, estornoParcial: false } },
  ]);

  const r = await reembolsos.solicitar(p.pedido_id, { motivo: 'evento remarcado' }, apoio.AUTOR);
  assert.equal(r.status, 'confirmado');
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].pedidoId, p.pedido_id);
  assert.equal(chamadas[0].valor, undefined, 'total vai sem valor (API.md §5.4)');
  assert.match(chamadas[0].chaveIdempotencia, /^tm-[0-9a-f-]{36}$/);
  assert.equal((await linha('SELECT status FROM pedidos WHERE id = $1', [p.pedido_id])).status, 'estornado');
  assert.deepEqual(
    (await ingressosDo(p.pedido_id)).map((i) => i.status),
    ['cancelado', 'cancelado'],
  );

  const depois = await apoio.aviso(p.pedido_id, 'estornado', { valorEstornado: 101.49 });
  assert.equal(await apoio.aplicarAviso(depois), 'ignorado');
  assert.deepEqual(
    (await participantes.avisos(pronta.edicao.id)).map((a) => a.tipo),
    [],
  );
  const resumo = await participantes.resumo(pronta.edicao.id);
  assert.equal(resumo.receita_confirmada_centavos, 10000);
  assert.equal(resumo.reembolsado_centavos, 10000, 'conta o preço dos ingressos, não as taxas');
  assert.equal(resumo.receita_liquida_centavos, 0);
  assert.equal(resumo.reembolsos, 1);
  assert.equal(resumo.cancelados, 2);
});

test('reembolso de um ingresso: só ele cancela, com o valor dele e a nossa chave', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  await apoio.pagar(p.pedido_id);
  const [alvo, outro] = await ingressosDo(p.pedido_id);
  const chamadas = duble([
    { status: 200, ok: true, corpo: { status: 'estornado_parcialmente', valorEstornado: 50, estornoParcial: true } },
  ]);
  const r = await reembolsos.solicitar(p.pedido_id, { motivo: 'desistência', ingresso_id: alvo.id }, apoio.AUTOR);
  assert.equal(r.status, 'confirmado');
  assert.equal(chamadas[0].valor, 50);
  assert.match(chamadas[0].chaveIdempotencia, /^tm-/);
  const depois = await ingressosDo(p.pedido_id);
  assert.equal(depois.find((i) => i.id === alvo.id).status, 'cancelado');
  assert.equal(depois.find((i) => i.id === outro.id).status, 'valido');
  assert.equal((await linha('SELECT status FROM pedidos WHERE id = $1', [p.pedido_id])).status, 'pago');
  // O webhook do mesmo estorno, depois, não vira "devolução fora do Admin".
  assert.equal(
    await apoio.aplicarAviso(await apoio.aviso(p.pedido_id, 'estornado_parcialmente', { valorEstornado: 50 })),
    'ja_aplicado',
  );
  assert.equal((await participantes.resumo(pronta.edicao.id)).reembolsado_centavos, 5000);
});

test('falha de rede ou 502: o reembolso espera e o reenvio usa a MESMA chave', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  await apoio.pagar(p.pedido_id);
  const chamadas = duble([
    new Error('fetch failed'),
    { status: 502, ok: false, corpo: { erro: 'Asaas não respondeu' } },
    { status: 409, ok: false, corpo: { codigo: 'estorno_em_reconciliacao', erro: 'em reconciliação' } },
    { status: 200, ok: true, corpo: { status: 'estornado', valorEstornado: 51.49 } },
  ]);
  const r = await reembolsos.solicitar(p.pedido_id, { motivo: 'teste de rede' }, apoio.AUTOR);
  assert.deepEqual(r, { reembolso_id: r.reembolso_id, status: 'solicitado', reenviar: true });
  assert.equal((await ingressosDo(p.pedido_id))[0].status, 'bloqueado', 'bloqueado enquanto o reembolso anda');
  assert.ok((await participantes.avisos(pronta.edicao.id)).some((a) => a.tipo === 'reembolso_reenviar'));
  assert.equal((await reembolsos.enviarAoCheckout(r.reembolso_id)).reenviar, true);
  assert.equal((await reembolsos.enviarAoCheckout(r.reembolso_id)).reenviar, true);
  assert.equal((await reembolsos.enviarAoCheckout(r.reembolso_id)).status, 'confirmado');
  assert.equal(new Set(chamadas.map((c) => c.chaveIdempotencia)).size, 1, 'uma chave só para o mesmo reembolso');
  await assert.rejects(
    reembolsos.enviarAoCheckout(r.reembolso_id),
    (err) => err.status === 409,
    'confirmado não se reenvia',
  );
});

test('recusa que repetir não resolve: o reembolso falha e o ingresso volta a valer', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  await apoio.pagar(p.pedido_id);
  duble([{ status: 409, ok: false, corpo: { codigo: 'mais_de_uma_cobranca_paga', erro: 'duas cobranças pagas' } }]);
  await assert.rejects(
    reembolsos.solicitar(p.pedido_id, { motivo: 'teste' }, apoio.AUTOR),
    (err) => err.status === 502,
  );
  assert.equal((await linha('SELECT status FROM reembolsos WHERE pedido_id = $1', [p.pedido_id])).status, 'falhou');
  assert.equal((await ingressosDo(p.pedido_id))[0].status, 'valido');
  assert.ok((await participantes.avisos(pronta.edicao.id)).some((a) => a.tipo === 'reembolso_falhou'));
});

test('estorno negado pelo provedor devolve os ingressos', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  await apoio.pagar(p.pedido_id);
  duble([{ status: 200, ok: true, corpo: { status: 'estorno_solicitado' } }]);
  const r = await reembolsos.solicitar(p.pedido_id, { motivo: 'teste' }, apoio.AUTOR);
  assert.equal(r.status, 'solicitado');
  assert.equal(await apoio.aplicarAviso(await apoio.aviso(p.pedido_id, 'estorno_negado')), 'estorno_negado');
  assert.equal((await linha('SELECT status FROM reembolsos WHERE id = $1', [r.reembolso_id])).status, 'negado');
  assert.deepEqual(
    (await ingressosDo(p.pedido_id)).map((i) => i.status),
    ['valido', 'valido'],
  );
});

test('reembolso só de pedido pago, e nunca acima do que falta devolver', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  await assert.rejects(reembolsos.solicitar(p.pedido_id, { motivo: 'x' }, apoio.AUTOR), (err) => err.status === 409);
  await apoio.pagar(p.pedido_id);
  await assert.rejects(
    reembolsos.solicitar(p.pedido_id, {}, apoio.AUTOR),
    (err) => err.status === 400,
    'motivo obrigatório',
  );
  duble([{ status: 200, ok: true, corpo: { status: 'estornado', valorEstornado: 51.49 } }]);
  await reembolsos.solicitar(p.pedido_id, { motivo: 'x' }, apoio.AUTOR);
  await assert.rejects(
    reembolsos.solicitar(p.pedido_id, { motivo: 'de novo' }, apoio.AUTOR),
    (err) => err.status === 409,
  );
});

// --------------------------------------------- o que o Checkout chama aqui
test('GET /pedido do Checkout: exige a chave da Trimundi e responde no formato do contrato', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2), {
    comprador: { ...apoio.pessoa('Comprador'), telefone: '(16) 99999-0000' },
  });
  const c = apoio.cliente(srv);
  const caminho = `/ticket/api/checkout/pedido/${p.pedido_id}`;
  const chave = { 'x-checkout-key': process.env.TRIMUNDI_CHECKOUT_KEY };
  assert.equal((await c.get(caminho)).status, 401);
  assert.equal((await c.get(caminho, { 'x-checkout-key': 'errada' })).status, 401);
  assert.equal((await c.get('/ticket/api/checkout/pedido/00000000-0000-4000-8000-000000000000', chave)).status, 404);
  assert.equal((await c.get('/ticket/api/checkout/pedido/12345', chave)).status, 404);

  const r = await c.get(caminho, chave);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.json.pedidoId, p.pedido_id);
  assert.equal(r.json.status, 'pendente');
  assert.deepEqual(r.json.itens, [{ nome: 'Pista — 1º lote', quantidade: 2, valorUnitario: 50 }]);
  assert.equal(r.json.valorCheio, 100);
  assert.equal(r.json.valorComDesconto, 100);
  assert.equal(r.json.desconto, 0);
  assert.equal(r.json.pagador.documento, p.corpo.comprador.cpf);
  assert.equal(r.json.pagador.telefone, '16999990000');
  assert.match(r.json.descricao, /^Evento [0-9a-f]+ — Edição 01$/);
  const expira = new Date(r.json.expiraEm).getTime() - Date.now();
  assert.ok(expira > 29 * 60000 && expira <= 30 * 60000, 'expiraEm = fim da reserva (30 min)');

  await apoio.pagar(p.pedido_id);
  assert.equal((await c.get(caminho, chave)).json.status, 'pago', 'pago: o Checkout recusa cobrar de novo');

  const vencido = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [
    vencido.pedido_id,
  ]);
  assert.equal((await c.get(`/ticket/api/checkout/pedido/${vencido.pedido_id}`, chave)).json.status, 'cancelado');
});

test('conciliação: acha o pagamento cujo aviso se perdeu, pelo mesmo caminho da fila', async () => {
  const pronta = await apoio.edicaoPronta();
  const perdido = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  const semCobranca = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  const resposta = await apoio.aviso(perdido.pedido_id, 'confirmado');
  delete resposta.eventoId;
  delete resposta.ocorridoEm;
  checkout.substituir({
    consultarCobranca: async (pedidoId) =>
      pedidoId === perdido.pedido_id
        ? { status: 200, ok: true, corpo: { ...resposta, criadoEm: new Date().toISOString() } }
        : { status: 404, ok: false, corpo: { erro: 'nenhuma cobrança' } },
  });
  const r = await conciliarPendentes();
  assert.equal(r.configurado, true);
  assert.ok(r.encontrados >= 1);
  await apoio.aguardarEvento(`conciliacao:${perdido.pedido_id}:${resposta.chargeId}:confirmado`);
  assert.equal((await linha('SELECT status FROM pedidos WHERE id = $1', [perdido.pedido_id])).status, 'pago');
  assert.equal(
    (await linha('SELECT status FROM pedidos WHERE id = $1', [semCobranca.pedido_id])).status,
    'aguardando_pagamento',
  );
  // Rodar de novo não duplica nada.
  await conciliarPendentes();
  assert.equal((await ingressosDo(perdido.pedido_id)).length, 1);
  checkout.substituir(null);
});

test('resumo da edição (D1): teste fica fora de tudo e cortesia nunca é receita', async () => {
  const pronta = await apoio.edicaoPronta({ publicar: true });
  const venda = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 2));
  await apoio.pagar(venda.pedido_id);
  await emissao.emitirCortesia(
    pronta.edicao.id,
    { ...apoio.pessoa('Convidado'), categoria_id: pronta.tipo.id, classificacao: 'patrocinador', chave: apoio.chave() },
    apoio.AUTOR,
  );
  const teste = await pedidos.criarTeste(
    pronta.edicao.id,
    { itens: itensDe(pronta.tipo, 1), comprador: apoio.pessoa('Equipe'), participantes: [apoio.pessoa('Equipe')] },
    apoio.AUTOR,
  );
  await apoio.pagar(teste.pedido_id);
  const resumo = await participantes.resumo(pronta.edicao.id);
  assert.deepEqual(
    {
      pagos: resumo.ingressos_pagos,
      cortesias: resumo.cortesias,
      participantes: resumo.participantes,
      receita: resumo.receita_confirmada_centavos,
      pedidos: resumo.pedidos_pagos,
    },
    { pagos: 2, cortesias: 1, participantes: 3, receita: 10000, pedidos: 1 },
  );
  const lista = await participantes.listar(pronta.edicao.id, { filtro: 'testes' });
  assert.equal(lista.total, 1);
  assert.equal(lista.itens[0].pagamento, 'teste');
  const { rows: metricas } = await consultar(
    "SELECT propriedades FROM metricas WHERE nome = 'venda:pagamento_confirma' AND edicao_id = $1 ORDER BY id",
    [pronta.edicao.id],
  );
  assert.deepEqual(
    metricas.map((m) => m.propriedades.teste),
    [false, true],
    'a métrica marca o teste para ficar fora das contas',
  );
});

test('participantes: CPF mascarado na lista, busca pelo número inteiro', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, itensDe(pronta.tipo, 1));
  await apoio.pagar(p.pedido_id);
  const cpf = p.corpo.participantes[0].cpf;
  const achado = await participantes.listar(pronta.edicao.id, { busca: cpf });
  assert.equal(achado.total, 1);
  assert.equal(achado.itens[0].cpf, `***.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-**`);
  assert.equal(
    (await participantes.listar(pronta.edicao.id, { busca: '%' })).total,
    0,
    'curinga do LIKE não vaza tudo',
  );
});
