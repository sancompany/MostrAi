const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const catalogo = require('../src/trimundi/catalogo');
const promocoes = require('../src/trimundi/promocoes');
const indicacao = require('../src/trimundi/indicacao');
const { conteudoDoQr } = require('../src/trimundi/lib/qr');

// Portaria (§6 do prompt master; decisões do dono de 14/11/2026, itens F, G
// e H): a leitura mostra comprador, titular, tipo, lote, número, validade,
// evento, benefício, pulseira e recompensas de indicação; já utilizado é
// recusado com a primeira entrada (data, hora, operador) e cada tentativa
// fica registrada; combo aparece ingresso por ingresso; benefício e
// recompensa são entregues uma vez só, independentes da entrada.

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

async function ingressosDo(pedidoId) {
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, i.codigo_curto, ed.codigo_publico FROM ingressos i JOIN edicoes ed ON ed.id = i.edicao_id
      WHERE i.pedido_id = $1 ORDER BY i.id`,
    [pedidoId],
  );
  return rows.map((r) => ({ ...r, qr: conteudoDoQr(r.codigo_publico, r.codigo) }));
}

async function portaria(pronta) {
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const c = apoio.cliente(srv, { cookie: op.cookie });
  const ed = pronta.edicao.id;
  return {
    op,
    ler: (entrada) => c.post('/ticket/api/checkin/consultar', { edicao_id: ed, entrada }),
    validar: (id) => c.post('/ticket/api/checkin/confirmar', { edicao_id: ed, ingresso_id: id }),
    entregar: (id, recompensaId) =>
      c.post('/ticket/api/checkin/recompensa', { edicao_id: ed, ingresso_id: id, recompensa_id: recompensaId }),
  };
}

const tentativas = async (ingressoId) =>
  (
    await consultar(
      `SELECT count(*)::int AS n FROM checkins WHERE ingresso_id = $1 AND escopo = 'entrada' AND resultado = 'recusado'`,
      [ingressoId],
    )
  ).rows[0].n;

test('a leitura mostra a ficha completa: comprador, titular, tipo, lote, número, validade, evento e pulseira', async () => {
  // Dois lotes: o 1º com 1 ingresso só; a segunda compra sai do 2º lote.
  const pronta = await apoio.edicaoPronta({
    lotes: [
      { preco_centavos: 5000, quantidade: 1 },
      { preco_centavos: 6000, quantidade: 10 },
    ],
  });
  await catalogo.atualizarTipo(pronta.tipo.id, { pulseira: 'Azul' }, apoio.AUTOR);
  const primeiro = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(primeiro.pedido_id);
  const comprador = apoio.pessoa('Compradora');
  const segundo = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2), { comprador });
  await apoio.pagar(segundo.pedido_id);
  const [, dois] = await ingressosDo(segundo.pedido_id);
  const p = await portaria(pronta);

  const r = await p.ler(dois.qr);
  assert.equal(r.status, 200, r.texto);
  assert.equal(r.json.resultado, 'valido');
  const i = r.json.ingresso;
  assert.equal(i.comprador, comprador.nome);
  assert.equal(i.participante, segundo.corpo.participantes[1].nome, 'titular é quem entra');
  assert.equal(i.categoria, 'Pista');
  assert.equal(i.lote, 2);
  assert.deepEqual([i.numero, i.numero_de], [2, 2]);
  assert.equal(i.pulseira, 'Azul');
  assert.equal(i.evento, pronta.edicao.evento.nome);
  assert.equal(i.edicao, pronta.edicao.nome);
  assert.ok('inicio_em' in i.validade && 'fim_em' in i.validade, 'validade = data e horário da edição');
  for (const dado of [comprador.cpf, comprador.email, segundo.corpo.participantes[1].cpf]) {
    assert.equal(r.texto.includes(dado), false, 'sem CPF nem e-mail na portaria');
  }
  const [doPrimeiro] = await ingressosDo(primeiro.pedido_id);
  assert.equal((await p.ler(doPrimeiro.qr)).json.ingresso.lote, 1);

  // Pacote offline: lote e pulseira por ingresso, validade da edição — e
  // nada de comprador.
  const c = apoio.cliente(srv, { cookie: p.op.cookie });
  const pacote = (await c.get(`/ticket/api/checkin/pacote?edicao=${pronta.edicao.id}`)).json;
  const doDois = pacote.ingressos.find((x) => x.i === Number(dois.id));
  assert.deepEqual([doDois.l, doDois.p], [2, 'Azul']);
  assert.ok('inicio_em' in pacote.edicao && 'fim_em' in pacote.edicao);
  assert.equal(JSON.stringify(pacote).includes(comprador.nome), false);
});

test('já utilizado: recusado com a primeira entrada (data, hora, operador) e cada tentativa registrada', async () => {
  const pronta = await apoio.edicaoPronta();
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(ped.pedido_id);
  const [ing] = await ingressosDo(ped.pedido_id);
  const a = await portaria(pronta);
  const b = await portaria(pronta);

  assert.equal((await a.validar(ing.id)).json.resultado, 'entrada_registrada');
  assert.equal(await tentativas(ing.id), 0);

  // Outro operador lê o mesmo QR: recusado, com a primeira entrada.
  const r = await b.ler(ing.qr);
  assert.equal(r.json.resultado, 'ja_utilizado');
  assert.ok(r.json.ingresso.utilizado_em);
  assert.equal(r.json.ingresso.utilizado_por, a.op.nome);
  assert.equal(r.json.ingresso.tentativas_recusadas, 1, 'a tentativa já fica registrada na leitura');
  // O mesmo QR parado na câmera (mesmo operador, em segundos) conta uma vez.
  await b.ler(ing.qr);
  await b.ler(ing.codigo_curto);
  assert.equal(await tentativas(ing.id), 1);
  // Outro operador tentando: outra tentativa.
  await a.ler(ing.qr);
  assert.equal(await tentativas(ing.id), 2);
  const { rows } = await consultar(
    `SELECT operador_id, motivo FROM checkins WHERE ingresso_id = $1 AND resultado = 'recusado' ORDER BY id`,
    [ing.id],
  );
  assert.deepEqual(
    rows.map((x) => [Number(x.operador_id), x.motivo]),
    [
      [Number(b.op.id), 'ja_utilizado'],
      [Number(a.op.id), 'ja_utilizado'],
    ],
  );
  // A entrada continua uma só.
  const { rows: aceitas } = await consultar(
    `SELECT count(*)::int AS n FROM checkins WHERE ingresso_id = $1 AND resultado = 'aceito'`,
    [ing.id],
  );
  assert.equal(aceitas[0].n, 1);
});

test('ingresso cancelado lido na portaria: recusado e a tentativa registrada; válido não registra nada', async () => {
  const pronta = await apoio.edicaoPronta();
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2));
  await apoio.pagar(ped.pedido_id);
  const [um, dois] = await ingressosDo(ped.pedido_id);
  await consultar("UPDATE ingressos SET status = 'cancelado', motivo_status = 'teste' WHERE id = $1", [um.id]);
  const p = await portaria(pronta);
  assert.equal((await p.ler(um.qr)).json.resultado, 'cancelado');
  assert.equal(await tentativas(um.id), 1);
  assert.equal((await p.ler(dois.qr)).json.resultado, 'valido');
  const { rows } = await consultar('SELECT count(*)::int AS n FROM checkins WHERE ingresso_id = $1', [dois.id]);
  assert.equal(rows[0].n, 0, 'consultar um ingresso válido não grava nada');
});

test('combo: os ingressos do combo aparecem um a um e cada QR é validado sozinho', async () => {
  const pronta = await apoio.edicaoPronta();
  const combo = await promocoes.criarPromocao(
    pronta.edicao.id,
    {
      nome: 'Dupla',
      preco_total_centavos: 9000,
      quantidade: 5,
      itens: [{ categoria_id: pronta.tipo.id, quantidade: 2 }],
    },
    apoio.AUTOR,
  );
  const ped = await apoio.novoPedido(pronta, { combos: [{ promocao_id: combo.id, quantidade: 1 }] });
  await apoio.pagar(ped.pedido_id);
  const [um, dois] = await ingressosDo(ped.pedido_id);
  const p = await portaria(pronta);

  let r = await p.ler(um.qr);
  assert.equal(r.json.ingresso.combo.nome, 'Dupla');
  assert.deepEqual(
    r.json.ingresso.combo.ingressos.map((x) => [x.numero, x.este, x.utilizado_em]),
    [
      [1, true, null],
      [2, false, null],
    ],
  );
  assert.equal(r.json.ingresso.combo.ingressos[1].participante, ped.corpo.participantes[1].nome);
  assert.equal((await p.validar(um.id)).json.resultado, 'entrada_registrada');

  // O outro do combo continua válido, e mostra que o primeiro já entrou.
  r = await p.ler(dois.qr);
  assert.equal(r.json.resultado, 'valido', 'validar um não valida o outro');
  const [primeiro, este] = r.json.ingresso.combo.ingressos;
  assert.ok(primeiro.utilizado_em);
  assert.deepEqual([este.este, este.utilizado_em], [true, null]);
});

test('recompensa de indicação: aparece só no ingresso principal de quem indicou e é entregue uma vez', async () => {
  const pronta = await apoio.edicaoPronta();
  await indicacao.criarCampanha(
    pronta.edicao.id,
    { nome: 'Indique', recompensa: 'Copão', quantidade: 10, indicacoes_por_recompensa: 1 },
    apoio.AUTOR,
  );
  // A Ana compra 2 (o 1º é o principal dela) e indica a Bia, que paga.
  const ana = apoio.pessoa('Ana');
  const contaAna = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const { codigo } = (await contaAna.get('/ticket/api/conta')).json.indicacao;
  const dela = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2), {
    comprador: ana,
    participantes: [{ conta: true }, apoio.pessoa('Amigo')],
  });
  await apoio.pagar(dela.pedido_id);
  const bia = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: apoio.pessoa('Bia'),
    indicacao: codigo,
  });
  await apoio.pagar(bia.pedido_id);
  const [principal, outro] = await ingressosDo(dela.pedido_id);
  const p = await portaria(pronta);

  const lido = await p.ler(principal.qr);
  const [rec] = lido.json.ingresso.recompensas_indicacao;
  assert.equal(lido.json.ingresso.recompensas_indicacao.length, 1);
  assert.deepEqual([rec.nome, rec.entregue_em], ['Copão', null]);
  // A conta mostra o mesmo ingresso como principal.
  const painel = (await contaAna.get('/ticket/api/conta')).json;
  const doPainel = painel.edicoes.flatMap((g) => g.pedidos).flatMap((x) => x.ingressos);
  assert.equal(doPainel.find((x) => x.principal).codigo_curto, principal.codigo_curto);

  // No outro ingresso do pedido, não aparece e não se entrega.
  assert.deepEqual((await p.ler(outro.qr)).json.ingresso.recompensas_indicacao, []);
  const errado = await p.entregar(outro.id, rec.id);
  assert.equal(errado.status, 409);

  // Entrega antes da entrada: vale (independente), uma vez só.
  const ok = await p.entregar(principal.id, rec.id);
  assert.equal(ok.status, 200, ok.texto);
  assert.equal(ok.json.resultado, 'entregue');
  assert.equal(ok.json.entregue_por, p.op.nome);
  const de_novo = await p.entregar(principal.id, rec.id);
  assert.equal(de_novo.json.resultado, 'ja_entregue');
  const depois = (await p.ler(principal.qr)).json.ingresso;
  assert.equal(depois.recompensas_indicacao[0].entregue_por, p.op.nome);
  assert.ok(depois.recompensas_indicacao[0].entregue_em);
  assert.equal(depois.utilizado_em, null, 'entregar não registra entrada');
  // No banco: entregue pelo operador, com auditoria.
  const { rows } = await consultar('SELECT status, entregue_por FROM recompensas_indicacao WHERE id = $1', [rec.id]);
  assert.deepEqual([rows[0].status, rows[0].entregue_por], ['entregue', `operador:${p.op.id}`]);
  const { rows: aud } = await consultar(
    `SELECT autor, detalhe FROM auditoria WHERE entidade = 'recompensa_indicacao' AND entidade_id = $1
      AND acao = 'recompensa_entregue'`,
    [String(rec.id)],
  );
  assert.equal(aud.length, 1);
  assert.equal(aud[0].autor, `operador:${p.op.id}`);
  assert.equal(aud[0].detalhe.via, 'portaria');
  // O Admin não entrega de novo.
  await assert.rejects(indicacao.entregarRecompensa(rec.id, apoio.AUTOR), (err) => err.status === 409);
});

test('recompensa revogada (indicação reembolsada) não aparece nem se entrega; outra edição é 403', async () => {
  const pronta = await apoio.edicaoPronta();
  await indicacao.criarCampanha(
    pronta.edicao.id,
    { nome: 'Indique', recompensa: 'Copão', quantidade: 10, indicacoes_por_recompensa: 1 },
    apoio.AUTOR,
  );
  const ana = apoio.pessoa('Ana');
  const contaAna = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const { codigo } = (await contaAna.get('/ticket/api/conta')).json.indicacao;
  const dela = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: ana,
    participantes: [{ conta: true }],
  });
  await apoio.pagar(dela.pedido_id);
  const bia = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1), {
    comprador: apoio.pessoa('Bia'),
    indicacao: codigo,
  });
  await apoio.pagar(bia.pedido_id);
  const [principal] = await ingressosDo(dela.pedido_id);
  const p = await portaria(pronta);
  const [rec] = (await p.ler(principal.qr)).json.ingresso.recompensas_indicacao;
  await apoio.aplicarAviso(await apoio.aviso(bia.pedido_id, 'estornado'));
  assert.deepEqual((await p.ler(principal.qr)).json.ingresso.recompensas_indicacao, []);
  assert.equal((await p.entregar(principal.id, rec.id)).status, 404);

  const outra = await apoio.edicaoPronta();
  const daOutra = await portaria(outra);
  // Pela edição dele: o ingresso não é de lá (404, sem dizer nada dele).
  assert.equal((await daOutra.entregar(principal.id, rec.id)).status, 404);
  // Pedindo a edição da Ana, que não é dele: 403.
  const r = await apoio.cliente(srv, { cookie: daOutra.op.cookie }).post('/ticket/api/checkin/recompensa', {
    edicao_id: pronta.edicao.id,
    ingresso_id: principal.id,
    recompensa_id: rec.id,
  });
  assert.equal(r.status, 403, 'operador de outra edição não entrega');
});

test('pulseira do tipo: opcional, até 40 caracteres, some quando apagada, com auditoria', async () => {
  const pronta = await apoio.edicaoPronta();
  assert.equal(pronta.tipo.pulseira, null, 'tipos existentes ficam sem pulseira');
  const comPulseira = await catalogo.atualizarTipo(pronta.tipo.id, { pulseira: '  VIP-02 ' }, apoio.AUTOR);
  assert.equal(comPulseira.pulseira, 'VIP-02');
  await assert.rejects(
    catalogo.atualizarTipo(pronta.tipo.id, { pulseira: 'x'.repeat(41) }, apoio.AUTOR),
    (err) => err.status === 400,
  );
  const sem = await catalogo.atualizarTipo(pronta.tipo.id, { pulseira: '' }, apoio.AUTOR);
  assert.equal(sem.pulseira, null);
  const { rows } = await consultar(
    `SELECT detalhe FROM auditoria WHERE entidade = 'categoria' AND entidade_id = $1 AND acao = 'tipo_alterado'`,
    [String(pronta.tipo.id)],
  );
  assert.ok(rows.some((r) => r.detalhe.campos.includes('pulseira')));
});
