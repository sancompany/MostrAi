const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { VERSAO: VERSAO_TERMOS } = require('../src/trimundi/legal');
const { consultar } = require('../src/trimundi/db/conexao');
const eventos = require('../src/trimundi/eventos');
const catalogo = require('../src/trimundi/catalogo');
const pedidos = require('../src/trimundi/pedidos');

// TICK — cadastro único por CPF e e-mail, limite de ingressos por CPF na
// EDIÇÃO (nunca global), pedido em aberto por CPF e o aviso dos benefícios
// com estoque (pedido do dono, 10/11/2026).

let srv;
test.before(async () => {
  srv = await apoio.iniciarApp();
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const SENHA = 'Minha12@senha';
const cadastro = (c, p, extra = {}) =>
  c.post('/ticket/api/conta/cadastro', {
    ...p,
    senha: SENHA,
    senha_confirmacao: SENHA,
    maioridade: true,
    aceite_termos: true,
    versao_termos: VERSAO_TERMOS,
    ...extra,
  });
const contasDoCpf = async (cpf) =>
  (await consultar('SELECT count(*)::int AS n FROM clientes WHERE cpf = $1 AND anonimizado_em IS NULL', [cpf])).rows[0]
    .n;

// Edição publicada com limite por CPF (o mesmo campo da ficha no Admin).
async function edicaoComLimite(limite, lotes = [{ preco_centavos: 5000, quantidade: 50 }]) {
  const pronta = await apoio.edicaoPronta({ lotes, publicar: false });
  await eventos.atualizarEdicao(pronta.edicao.id, { limite_por_cpf: limite }, apoio.AUTOR);
  await eventos.mudarStatus(pronta.edicao.id, 'publicado', apoio.AUTOR);
  return pronta;
}

const comprar = (pronta, p, n) => apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, n), { comprador: p });
const recusa = async (promessa) => {
  try {
    await promessa;
  } catch (err) {
    return err;
  }
  throw new Error('era para recusar');
};

// ---------------------------------------------------------------- cadastro

test('1. cadastro com CPF e e-mail novos funciona; o CPF é guardado só com os números', async () => {
  const p = apoio.pessoa('Nova');
  const formatado = `${p.cpf.slice(0, 3)}.${p.cpf.slice(3, 6)}.${p.cpf.slice(6, 9)}-${p.cpf.slice(9)}`;
  const r = await cadastro(apoio.cliente(srv), { ...p, cpf: ` ${formatado} ` });
  assert.equal(r.status, 201);
  const { rows } = await consultar('SELECT cpf FROM clientes WHERE email = $1', [p.email]);
  assert.equal(rows[0].cpf, p.cpf);
});

test('2. e-mail que já tem conta é bloqueado, com a mensagem e o caminho do login', async () => {
  const p = apoio.pessoa('Ja');
  await apoio.contaDe(p);
  const r = await cadastro(apoio.cliente(srv), { ...apoio.pessoa('Outro'), email: p.email.toUpperCase() });
  assert.equal(r.status, 409);
  assert.equal(r.json.erro, 'Este e-mail já possui uma conta. Entre na sua conta.');
  assert.equal(r.json.codigo, 'email_em_uso');
  assert.equal(r.json.entrar, '/ticket/conta');
});

test('3. CPF que já tem conta é bloqueado mesmo com outro e-mail (e com pontos, traço e espaços)', async () => {
  const p = apoio.pessoa('Dono');
  await apoio.contaDe(p);
  const formatado = `${p.cpf.slice(0, 3)}.${p.cpf.slice(3, 6)}.${p.cpf.slice(6, 9)}-${p.cpf.slice(9)}`;
  for (const cpf of [p.cpf, formatado, ` ${formatado} `]) {
    const r = await cadastro(apoio.cliente(srv), { ...apoio.pessoa('Outro'), cpf });
    assert.equal(r.status, 409, cpf);
    assert.equal(r.json.erro, 'Este CPF já possui uma conta vinculada. Entre na sua conta.');
    assert.equal(r.json.codigo, 'cpf_em_uso');
  }
  assert.equal(await contasDoCpf(p.cpf), 1);
});

test('4. cadastros simultâneos com o mesmo CPF criam UMA conta só (e com o mesmo e-mail também)', async () => {
  const cpf = apoio.cpf();
  const respostas = await Promise.all(
    Array.from({ length: 6 }, () => cadastro(apoio.cliente(srv), { ...apoio.pessoa('Corrida'), cpf })),
  );
  assert.deepEqual(respostas.map((r) => r.status).sort(), [201, 409, 409, 409, 409, 409]);
  assert.ok(respostas.filter((r) => r.status === 409).every((r) => r.json.codigo === 'cpf_em_uso'));
  assert.equal(await contasDoCpf(cpf), 1);

  const email = `corrida.${apoio.sufixo()}@exemplo.com`;
  const porEmail = await Promise.all(
    Array.from({ length: 4 }, () => cadastro(apoio.cliente(srv), { ...apoio.pessoa('Corrida'), email })),
  );
  assert.deepEqual(porEmail.map((r) => r.status).sort(), [201, 409, 409, 409]);
  assert.ok(porEmail.filter((r) => r.status === 409).every((r) => r.json.codigo === 'email_em_uso'));
  const { rows } = await consultar('SELECT count(*)::int AS n FROM clientes WHERE email = $1', [email]);
  assert.equal(rows[0].n, 1);
});

test('a confirmação da senha é conferida no servidor', async () => {
  const r = await cadastro(apoio.cliente(srv), apoio.pessoa('Senha'), { senha_confirmacao: 'Outra12@senha' });
  assert.equal(r.status, 400);
  assert.equal(r.json.codigo, 'senha_confirmacao');
});

// ---------------------------------------------------- limite por CPF na edição

test('5 e 6. limite por CPF é da EDIÇÃO: na TREEMUNDO para em 4; em outro evento vale o limite dele', async () => {
  const treemundo = await edicaoComLimite(4);
  const outro = await edicaoComLimite(2);
  const p = apoio.pessoa('Fa');

  await apoio.pagar((await comprar(treemundo, p, 3)).pedido_id);
  const passa = await recusa(comprar(treemundo, p, 2));
  assert.equal(passa.status, 409);
  assert.equal(passa.extra.codigo, 'limite_cpf');
  assert.equal(passa.extra.disponivel, 1);
  assert.match(passa.message, /até 4 ingressos por CPF\. Você ainda pode comprar 1/);
  await apoio.pagar((await comprar(treemundo, p, 1)).pedido_id);
  const cheio = await recusa(comprar(treemundo, p, 1));
  assert.equal(cheio.extra.codigo, 'limite_cpf');
  assert.match(cheio.message, /já atingiu o limite/);

  // Outro evento: os 4 da TREEMUNDO não contam; vale o limite de 2 dele.
  await apoio.pagar((await comprar(outro, p, 2)).pedido_id);
  assert.equal((await recusa(comprar(outro, p, 1))).extra.codigo, 'limite_cpf');

  // Outra pessoa compra normalmente na TREEMUNDO.
  await comprar(treemundo, apoio.pessoa('Outra'), 4);
});

test('o limite por CPF conta combos e todos os tipos da edição; o limite por tipo segue valendo à parte', async () => {
  const pronta = await edicaoComLimite(3);
  const vip = await catalogo.criarTipo(
    pronta.edicao.id,
    { nome: 'VIP', limite_por_comprador: 1, lotes: [{ preco_centavos: 9000, quantidade: 10 }] },
    apoio.AUTOR,
  );
  const p = apoio.pessoa('Mix');
  const itens = {
    tipos: [
      { categoria_id: pronta.tipo.id, quantidade: 2 },
      { categoria_id: vip.id, quantidade: 1 },
    ],
  };
  await apoio.pagar((await apoio.novoPedido(pronta, itens, { comprador: p })).pedido_id);
  assert.equal((await recusa(comprar(pronta, p, 1))).extra.codigo, 'limite_cpf', '2 Pista + 1 VIP = 3');
  // Limite por tipo (já existente): 1 VIP por comprador, em outra edição sem limite de edição.
  const semLimite = await apoio.edicaoPronta();
  const vip2 = await catalogo.criarTipo(
    semLimite.edicao.id,
    { nome: 'VIP', limite_por_comprador: 1, lotes: [{ preco_centavos: 9000, quantidade: 10 }] },
    apoio.AUTOR,
  );
  const q = apoio.pessoa('Tipo');
  const doisVip = await recusa(
    apoio.novoPedido(semLimite, { tipos: [{ categoria_id: vip2.id, quantidade: 2 }] }, { comprador: q }),
  );
  assert.equal(doisVip.extra.codigo, 'limite');
});

test('7. duas compras simultâneas do mesmo CPF não passam do limite da edição', async () => {
  const pronta = await edicaoComLimite(4);
  const p = apoio.pessoa('Pressa');
  await apoio.pagar((await comprar(pronta, p, 2)).pedido_id);
  const r = await Promise.allSettled([comprar(pronta, p, 2), comprar(pronta, p, 2), comprar(pronta, p, 1)]);
  assert.equal(r.filter((x) => x.status === 'fulfilled').length, 1, 'só uma passa');
  for (const x of r.filter((y) => y.status === 'rejected')) {
    assert.ok(['pedido_pendente', 'limite_cpf'].includes(x.reason.extra?.codigo), x.reason.message);
  }
  const { rows } = await consultar(
    `SELECT count(*)::int AS n FROM reservas r JOIN pedidos pe ON pe.id = r.pedido_id JOIN compradores c ON c.id = pe.comprador_id
      WHERE pe.edicao_id = $1 AND c.cpf = $2 AND pe.status IN ('pago', 'aguardando_pagamento')`,
    [pronta.edicao.id, p.cpf],
  );
  assert.ok(rows[0].n <= 4, `no máximo 4 (tem ${rows[0].n})`);
});

test('um pedido aguardando pagamento por CPF na edição; em outra edição o mesmo CPF compra', async () => {
  const pronta = await edicaoComLimite(10);
  const outra = await edicaoComLimite(10);
  const p = apoio.pessoa('Aberto');
  await comprar(pronta, p, 1);
  const segundo = await recusa(comprar(pronta, p, 1));
  assert.equal(segundo.status, 409);
  assert.equal(segundo.extra.codigo, 'pedido_pendente');
  await comprar(outra, p, 1);
});

test('8. pedido expirado devolve a vaga ao lote certo e libera o limite do CPF', async () => {
  const pronta = await edicaoComLimite(4, [
    { preco_centavos: 5000, quantidade: 4 },
    { preco_centavos: 8000, quantidade: 10 },
  ]);
  const [l1] = pronta.tipo.lotes;
  const p = apoio.pessoa('Expira');
  const ped = await comprar(pronta, p, 4);
  const lote1 = async () =>
    (await catalogo.listarTipos(pronta.edicao.id))
      .find((t) => t.id === pronta.tipo.id)
      .lotes.find((l) => l.id === l1.id);
  assert.equal((await lote1()).disponivel, 0);
  assert.equal((await recusa(comprar(pronta, p, 1))).extra.codigo, 'pedido_pendente');
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [ped.pedido_id]);
  await pedidos.expirarVencidos(ped.pedido_id);
  const { rows } = await consultar('SELECT status FROM pedidos WHERE id = $1', [ped.pedido_id]);
  assert.equal(rows[0].status, 'expirado');
  assert.equal((await lote1()).disponivel, 4, 'as 4 vagas voltam ao 1º lote');
  const novo = await comprar(pronta, p, 4);
  assert.ok(novo.pedido_id, 'o CPF volta a poder comprar os 4');
});

test('9. reembolso cancela os ingressos e libera o limite do CPF (regra atual de contagem)', async () => {
  const pronta = await edicaoComLimite(2);
  const p = apoio.pessoa('Volta');
  const ped = await comprar(pronta, p, 2);
  await apoio.pagar(ped.pedido_id);
  assert.equal((await recusa(comprar(pronta, p, 1))).extra.codigo, 'limite_cpf');
  await apoio.aplicarAviso(await apoio.aviso(ped.pedido_id, 'estornado'));
  const { rows } = await consultar('SELECT status FROM ingressos WHERE pedido_id = $1', [ped.pedido_id]);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['cancelado', 'cancelado'],
  );
  await apoio.pagar((await comprar(pronta, p, 2)).pedido_id);
});

test('10. indicação e checkout seguem funcionando com o limite por CPF', async () => {
  const pronta = await edicaoComLimite(4);
  await consultar('UPDATE trimundi.campanhas_indicacao SET ativo = false WHERE edicao_id = $1', [pronta.edicao.id]);
  await require('../src/trimundi/indicacao').criarCampanha(
    pronta.edicao.id,
    { nome: 'Indique', recompensa: 'copão', quantidade: 5, indicacoes_por_recompensa: 2 },
    apoio.AUTOR,
  );
  const ana = apoio.pessoa('Ana');
  const cAna = apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, ana) });
  const codigo = (await cAna.get('/ticket/api/conta')).json.indicacao.codigo;
  for (const n of ['Bia', 'Caio']) {
    const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2), {
      comprador: apoio.pessoa(n),
      indicacao: codigo,
    });
    assert.equal(ped.pagamento.modo, 'checkout', 'link do San Checkout gerado');
    await apoio.pagar(ped.pedido_id);
  }
  const camp = (await cAna.get('/ticket/api/conta')).json.indicacao.campanhas.find((c) =>
    c.evento.startsWith(pronta.edicao.evento.nome),
  );
  assert.deepEqual([camp.conversoes, camp.recompensas_a_retirar], [2, 1]);
});

// ------------------------------------------------------- benefícios e vitrine

test('11. benefício com quantidade vem marcado "limitado" (a página avisa); sem quantidade, não', async () => {
  const pronta = await apoio.edicaoPronta({ lotes: [{ preco_centavos: 5000, quantidade: 10 }], publicar: false });
  const copao = await catalogo.criarBeneficio(pronta.edicao.id, { nome: 'Copão', quantidade: 50 }, apoio.AUTOR);
  const pulseira = await catalogo.criarBeneficio(pronta.edicao.id, { nome: 'Pulseira' }, apoio.AUTOR);
  const [l] = pronta.tipo.lotes;
  await catalogo.atualizarTipo(
    pronta.tipo.id,
    {
      beneficios: [pulseira.id],
      lotes: [{ id: l.id, preco_centavos: 5000, quantidade: 10, beneficio_id: copao.id }],
    },
    apoio.AUTOR,
  );
  await eventos.atualizarEdicao(pronta.edicao.id, { limite_por_cpf: 4 }, apoio.AUTOR);
  await eventos.mudarStatus(pronta.edicao.id, 'publicado', apoio.AUTOR);
  const r = await apoio.cliente(srv).get(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}`);
  const [t] = r.json.tipos;
  assert.equal(t.beneficio_do_lote.nome, 'Copão');
  assert.equal(t.beneficio_do_lote.limitado, true, 'copão tem quantidade: aviso de estoque');
  assert.equal(t.beneficios_limitados, false, 'pulseira sem quantidade: sem aviso');
  assert.equal(r.json.limite_por_cpf, 4);
  assert.equal(r.json.max_ingressos_por_pedido, 4, 'o carrinho respeita o limite da edição');
  const js = await (await fetch(`${srv.base}/ticket/edicao.page.js`)).text();
  assert.match(js, /Benefício disponível enquanto durar o estoque\./);
});
