const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const pedidos = require('../src/trimundi/pedidos');
const reembolsos = require('../src/trimundi/reembolsos');
const checkout = require('../src/trimundi/checkout/cliente');
const operadores = require('../src/trimundi/operadores');
const desempenho = require('../src/trimundi/desempenho');

// Indicação de compradores e operadores (pedido do dono, 10/11/2026): link
// permanente, origem fixa no servidor, conversão só com compra confirmada,
// fichas do Admin e ranking. Os números são de pessoas (contas compradoras)
// e de ingressos, separados: 4 ingressos de uma pessoa = 1 pessoa e 4 ingressos.

let srv;
let admin;
test.before(async () => {
  srv = await apoio.iniciarApp();
  admin = apoio.cliente(srv, { cookie: await apoio.entrarAdmin(srv) });
});
test.after(async () => {
  checkout.substituir(null);
  await srv.fechar();
  await apoio.encerrar();
});

const logado = async (p) => apoio.cliente(srv, { cookie: await apoio.entrarCliente(srv, p) });
async function codigoDe(p) {
  const c = await logado(p);
  return (await c.get('/ticket/api/conta')).json.indicacao;
}
const comprar = async (pronta, p, codigo, n = 1, { pagar = true } = {}) => {
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, n), { comprador: p, indicacao: codigo });
  if (pagar) await apoio.pagar(ped.pedido_id);
  return ped;
};
const indicadorDoPedido = async (pedidoId) =>
  (await consultar('SELECT indicador_id FROM pedidos WHERE id = $1', [pedidoId])).rows[0].indicador_id;
const indicadorDaConta = async (p) =>
  (await consultar('SELECT i.id FROM indicadores i JOIN clientes c ON c.id = i.cliente_id WHERE c.cpf = $1', [p.cpf]))
    .rows[0]?.id;
const avisoDaPagina = (pronta, c, codigo) =>
  c.post(`/ticket/api/edicoes/${pronta.slugEvento}/${pronta.slugEdicao}/indicacao`, { codigo });

test('1 e 2. comprador e operador têm link permanente, sem precisar de campanha', async () => {
  const pronta = await apoio.edicaoPronta();
  const ana = apoio.pessoa('Ana');
  const ind = await codigoDe(ana);
  assert.match(ind.codigo, /^[A-Z2-9]{8}$/);
  const link = ind.links.find((l) => Number(l.edicao_id) === Number(pronta.edicao.id));
  assert.ok(link, 'link da edição à venda, sem campanha nenhuma');
  assert.match(link.link, new RegExp(`/ticket/${pronta.slugEvento}/${pronta.slugEdicao}\\?ind=${ind.codigo}$`));
  assert.equal((await codigoDe(ana)).codigo, ind.codigo, 'o código não muda');
  assert.equal(link.link.includes(ana.cpf) || link.link.includes(ana.email), false, 'o link não expõe dado pessoal');

  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const deOp = (await apoio.cliente(srv, { cookie: op.cookie }).get('/ticket/api/operador')).json.indicacao;
  assert.match(deOp.codigo, /^[A-Z2-9]{8}$/);
  assert.deepEqual(
    deOp.links.map((l) => Number(l.edicao_id)),
    [Number(pronta.edicao.id)],
    'só a edição autorizada',
  );
});

test('3 e 4. compra pelo link do comprador e do operador fica atribuída a quem indicou; a página diz quem foi', async () => {
  const pronta = await apoio.edicaoPronta();
  const ana = apoio.pessoa('Ana');
  const { codigo } = await codigoDe(ana);
  const bia = apoio.pessoa('Bia');
  const ped = await comprar(pronta, bia, codigo);
  assert.equal(await indicadorDoPedido(ped.pedido_id), await indicadorDaConta(ana));

  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const deOp = (await apoio.cliente(srv, { cookie: op.cookie }).get('/ticket/api/operador')).json.indicacao;
  const caio = apoio.pessoa('Caio');
  const pedOp = await comprar(pronta, caio, deOp.codigo);
  const { rows } = await consultar('SELECT operador_id FROM indicadores WHERE id = $1', [
    await indicadorDoPedido(pedOp.pedido_id),
  ]);
  assert.equal(Number(rows[0].operador_id), Number(op.id));

  // Aviso da página: só nome e tipo, sem login inclusive.
  const anonimo = apoio.cliente(srv);
  assert.deepEqual((await avisoDaPagina(pronta, anonimo, codigo)).json.indicacao, {
    nome: ana.nome,
    tipo: 'comprador',
  });
  const opNome = (await operadores.obter(op.id)).nome;
  assert.deepEqual((await avisoDaPagina(pronta, anonimo, deOp.codigo)).json.indicacao, {
    nome: opNome,
    tipo: 'operador',
  });
  assert.equal((await avisoDaPagina(pronta, anonimo, 'ZZZZZZZZ')).json.indicacao, null);
});

test('5. a origem fica no servidor: sobrevive ao cadastro/login, a outro link e a outro aparelho', async () => {
  const pronta = await apoio.edicaoPronta();
  const ana = apoio.pessoa('Ana');
  const leo = apoio.pessoa('Leo');
  const { codigo: deAna } = await codigoDe(ana);
  const { codigo: deLeo } = await codigoDe(leo);
  const bia = apoio.pessoa('Bia');

  // Antes de entrar: a página só mostra; nada é registrado.
  await avisoDaPagina(pronta, apoio.cliente(srv), deAna);
  const conta = await apoio.contaDe(bia);
  const origem = async () =>
    (
      await consultar('SELECT indicador_id FROM indicacao_origens WHERE cliente_id = $1 AND edicao_id = $2', [
        conta.id,
        pronta.edicao.id,
      ])
    ).rows[0]?.indicador_id;
  assert.equal(await origem(), undefined);

  // Entrou (a página reenvia o código guardado): a origem fica registrada.
  const c = await logado(bia);
  assert.equal((await avisoDaPagina(pronta, c, deAna)).json.indicacao.nome, ana.nome);
  assert.equal(await origem(), await indicadorDaConta(ana));
  // Outro link depois não troca a origem.
  assert.equal((await avisoDaPagina(pronta, c, deLeo)).json.indicacao.nome, ana.nome, 'segue a Ana');
  // Outro aparelho (sem código guardado): o servidor lembra.
  const outroAparelho = await logado(bia);
  assert.equal((await avisoDaPagina(pronta, outroAparelho, null)).json.indicacao.nome, ana.nome);
  // O pedido com o código do Leo fica com a Ana; pedido sem código também.
  const p1 = await comprar(pronta, bia, deLeo);
  assert.equal(await indicadorDoPedido(p1.pedido_id), await indicadorDaConta(ana));
  const p2 = await comprar(pronta, bia, null);
  assert.equal(await indicadorDoPedido(p2.pedido_id), await indicadorDaConta(ana));
  // Em OUTRA edição a origem é outra conversa: o link do Leo vale lá.
  const outra = await apoio.edicaoPronta();
  const p3 = await comprar(outra, bia, deLeo);
  assert.equal(await indicadorDoPedido(p3.pedido_id), await indicadorDaConta(leo));
});

test('6 e 8. pendente, expirado e cancelado não contam; cada compra tem um indicador só', async () => {
  const pronta = await apoio.edicaoPronta();
  const ana = apoio.pessoa('Ana');
  const { codigo } = await codigoDe(ana);
  const pendente = await comprar(pronta, apoio.pessoa('Bia'), codigo, 1, { pagar: false });
  const expira = await comprar(pronta, apoio.pessoa('Caio'), codigo, 1, { pagar: false });
  await consultar("UPDATE pedidos SET reserva_expira_em = now() - interval '1 minute' WHERE id = $1", [
    expira.pedido_id,
  ]);
  await pedidos.expirarVencidos(expira.pedido_id);
  assert.deepEqual(await desempenho.ranking(pronta.edicao.id), [], 'nada confirmado ainda');
  await comprar(pronta, apoio.pessoa('Duda'), codigo);
  const r = await desempenho.ranking(pronta.edicao.id);
  assert.equal(r.length, 1);
  assert.deepEqual([r[0].pessoas, r[0].compras, r[0].ingressos], [1, 1, 1]);
  // A lista de indicados mostra os outros, fora dos totais.
  const { totais, indicados } = await desempenho.indicadosPor(await indicadorDaConta(ana), pronta.edicao.id);
  assert.deepEqual(totais, { pessoas: 1, compras: 1, ingressos: 1 });
  assert.deepEqual(indicados.map((x) => x.situacao).sort(), ['aguardando pagamento', 'compra confirmada', 'expirado']);
  // Um indicador por pedido: a coluna é uma só e o pedido aparece uma vez.
  const { rows } = await consultar(
    'SELECT count(*)::int AS n FROM pedidos WHERE id = $1 AND indicador_id IS NOT NULL',
    [pendente.pedido_id],
  );
  assert.equal(rows[0].n, 1);
});

test('7. reembolso total tira a conversão; reembolso de um ingresso tira só aquele ingresso', async () => {
  const pronta = await apoio.edicaoPronta();
  const ana = apoio.pessoa('Ana');
  const { codigo } = await codigoDe(ana);
  const total = await comprar(pronta, apoio.pessoa('Bia'), codigo, 2);
  const parcial = await comprar(pronta, apoio.pessoa('Caio'), codigo, 2);
  let [r] = await desempenho.ranking(pronta.edicao.id);
  assert.deepEqual([r.pessoas, r.compras, r.ingressos], [2, 2, 4]);

  await apoio.aplicarAviso(await apoio.aviso(total.pedido_id, 'estornado'));
  [r] = await desempenho.ranking(pronta.edicao.id);
  assert.deepEqual([r.pessoas, r.compras, r.ingressos], [1, 1, 2], 'o reembolsado sai');

  const { rows: ings } = await consultar('SELECT id FROM ingressos WHERE pedido_id = $1 ORDER BY id', [
    parcial.pedido_id,
  ]);
  checkout.substituir({
    estornar: async () => ({
      status: 200,
      ok: true,
      corpo: { status: 'estornado_parcialmente', valorEstornado: 50, estornoParcial: true },
    }),
  });
  await reembolsos.solicitar(parcial.pedido_id, { motivo: 'desistência', ingresso_id: ings[0].id }, apoio.AUTOR);
  checkout.substituir(null);
  [r] = await desempenho.ranking(pronta.edicao.id);
  assert.deepEqual([r.pessoas, r.compras, r.ingressos], [1, 1, 1], 'a pessoa segue indicada; sai o ingresso devolvido');
});

test('9. autorreferência: o próprio link não vale (nem na página, nem no pedido)', async () => {
  const pronta = await apoio.edicaoPronta();
  const ana = apoio.pessoa('Ana');
  const { codigo } = await codigoDe(ana);
  const c = await logado(ana);
  assert.equal((await avisoDaPagina(pronta, c, codigo)).json.indicacao, null);
  const ped = await comprar(pronta, ana, codigo);
  assert.equal(await indicadorDoPedido(ped.pedido_id), null);
  const { rows } = await consultar(
    'SELECT 1 FROM indicacao_origens o JOIN clientes c ON c.id = o.cliente_id WHERE c.cpf = $1',
    [ana.cpf],
  );
  assert.equal(rows.length, 0, 'nem vira origem');
  assert.deepEqual(await desempenho.ranking(pronta.edicao.id), []);
});

test('10. ficha do comprador: quem indicou, quem ele indicou, pessoas × ingressos; CPF mascarado e o inteiro auditado', async () => {
  const pronta = await apoio.edicaoPronta();
  const leo = apoio.pessoa('Leo');
  const { codigo: deLeo } = await codigoDe(leo);
  const ana = apoio.pessoa('Ana');
  await comprar(pronta, ana, deLeo);
  const { codigo: deAna } = await codigoDe(ana);
  const bia = apoio.pessoa('Bia');
  await comprar(pronta, bia, deAna, 4); // 1 pessoa, 4 ingressos
  await comprar(pronta, apoio.pessoa('Caio'), deAna, 1, { pagar: false });
  // Davi chegou pelo link e ainda não comprou.
  await avisoDaPagina(pronta, await logado(apoio.pessoa('Davi')), deAna);

  const contaAna = await apoio.contaDe(ana);
  const f = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/compradores/${contaAna.id}`)).json;
  assert.equal(f.comprador.nome, ana.nome);
  assert.equal(f.comprador.email, ana.email);
  assert.equal(f.comprador.situacao_conta, 'ativa');
  assert.match(f.comprador.cpf, /^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
  assert.equal(JSON.stringify(f).includes(ana.cpf), false, 'CPF inteiro não vem na ficha');
  assert.deepEqual([f.compra.ingressos, f.compra.pagamento, f.compra.entradas], [1, 'confirmado', 0]);
  assert.deepEqual(f.compra.tipos, [{ nome: 'Pista', quantidade: 1 }]);
  assert.deepEqual(f.indicado_por, { nome: leo.nome, tipo: 'comprador' });
  assert.match(f.link, new RegExp(`\\?ind=${deAna}$`));
  assert.deepEqual(f.indicacoes.totais, { pessoas: 1, compras: 1, ingressos: 4 });
  const porNome = Object.fromEntries(f.indicacoes.indicados.map((x) => [x.nome.split(' ')[0], x]));
  assert.deepEqual(
    [porNome.Bia.situacao, porNome.Bia.ingressos, porNome.Bia.tipos],
    ['compra confirmada', 4, ['Pista']],
  );
  assert.ok(porNome.Bia.convertido_em);
  assert.match(porNome.Bia.cpf, /^\*\*\*\./);
  assert.equal(porNome.Caio.situacao, 'aguardando pagamento');
  assert.equal(porNome.Davi.situacao, 'sem compra');

  const cpf = await admin.post(`/admin/trimundi/clientes/${contaAna.id}/cpf`, {});
  assert.equal(cpf.json.cpf.replace(/\D/g, ''), ana.cpf);
  const { rows } = await consultar(
    "SELECT 1 FROM auditoria WHERE acao = 'cpf_consultado' AND entidade = 'cliente' AND entidade_id = $1",
    [String(contaAna.id)],
  );
  assert.equal(rows.length, 1, 'quem viu o CPF fica registrado');
  // A lista de participantes leva à ficha da conta compradora.
  const lista = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/participantes`)).json.itens;
  assert.ok(lista.some((i) => Number(i.cliente_id) === Number(contaAna.id)));
});

test('11. ficha e lista de operadores: link, compradores trazidos, compras e ingressos, por edição', async () => {
  const pronta = await apoio.edicaoPronta();
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const deOp = (await apoio.cliente(srv, { cookie: op.cookie }).get('/ticket/api/operador')).json.indicacao;
  const bia = apoio.pessoa('Bia');
  await comprar(pronta, bia, deOp.codigo, 2);
  await comprar(pronta, bia, deOp.codigo, 1);
  await comprar(pronta, apoio.pessoa('Caio'), deOp.codigo, 1, { pagar: false });

  const f = (await admin.get(`/admin/trimundi/operadores/${op.id}/desempenho`)).json;
  assert.equal(f.codigo, deOp.codigo);
  assert.equal(f.links.length, 1);
  assert.deepEqual(f.totais, { pessoas: 1, compras: 2, ingressos: 3 }, 'Bia é uma pessoa, com 2 compras e 3 ingressos');
  assert.equal(f.por_edicao.length, 1);
  assert.deepEqual([f.por_edicao[0].pessoas, f.por_edicao[0].compras, f.por_edicao[0].ingressos], [1, 2, 3]);
  const bia2 = f.indicados.find((x) => x.nome === bia.nome);
  assert.match(bia2.cpf, /^\*\*\*\./);
  assert.equal(JSON.stringify(f).includes(bia.cpf), false);

  const lista = (await admin.get('/admin/trimundi/operadores')).json;
  const linha = lista.find((o) => Number(o.id) === Number(op.id));
  assert.equal(linha.indicacao.codigo, deOp.codigo);
  assert.deepEqual([linha.indicacao.pessoas, linha.indicacao.compras, linha.indicacao.ingressos], [1, 2, 3]);
});

test('12 e 13. ranking separa comprador e operador, só conta confirmadas; CSV sem CPF nem e-mail', async () => {
  const pronta = await apoio.edicaoPronta();
  const ana = apoio.pessoa('Ana');
  const { codigo } = await codigoDe(ana);
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const deOp = (await apoio.cliente(srv, { cookie: op.cookie }).get('/ticket/api/operador')).json.indicacao;
  for (const n of ['Bia', 'Caio']) await comprar(pronta, apoio.pessoa(n), deOp.codigo);
  await comprar(pronta, apoio.pessoa('Duda'), codigo, 3);
  await comprar(pronta, apoio.pessoa('Eva'), codigo, 1, { pagar: false });

  const r = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/ranking`)).json;
  assert.deepEqual(
    r.map((x) => [x.posicao, x.categoria, x.pessoas, x.compras, x.ingressos]),
    [
      [1, 'operador', 2, 2, 2],
      [2, 'comprador', 1, 1, 3],
    ],
  );
  assert.equal(r[1].nome, ana.nome);

  const csv = await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/ranking.csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment/);
  const linhas = csv.texto.replace(/^﻿/, '').trim().split(/\r\n/);
  assert.equal(linhas[0], 'posicao;nome;categoria;pessoas_indicadas_com_compra;compras_confirmadas;ingressos_vendidos');
  assert.equal(linhas.length, 3);
  assert.equal(linhas[2], `2;${ana.nome};comprador;1;1;3`);
  assert.equal(csv.texto.includes(ana.cpf), false);
  assert.equal(csv.texto.includes(ana.email), false);
  assert.equal(csv.texto.includes(codigo), false, 'nem o código');
  // Nome com cara de fórmula não vira fórmula na planilha.
  assert.equal(desempenho.celula('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(desempenho.celula('+55'), "'+55");
});

test('14. operador não abre o Admin nem vê CPF; comprador não vê dados de outro', async () => {
  const pronta = await apoio.edicaoPronta();
  const op = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const deOp = apoio.cliente(srv, { cookie: op.cookie });
  const bia = apoio.pessoa('Bia');
  await comprar(pronta, bia, (await deOp.get('/ticket/api/operador')).json.indicacao.codigo);
  const contaBia = await apoio.contaDe(bia);
  for (const caminho of [
    `/admin/trimundi/edicoes/${pronta.edicao.id}/ranking`,
    `/admin/trimundi/edicoes/${pronta.edicao.id}/compradores/${contaBia.id}`,
    `/admin/trimundi/operadores/${op.id}/desempenho`,
  ]) {
    assert.equal((await deOp.get(caminho)).status, 401, caminho);
  }
  assert.equal((await deOp.post(`/admin/trimundi/clientes/${contaBia.id}/cpf`, {})).status, 401);
  const tela = await deOp.get('/ticket/api/operador');
  assert.equal(tela.texto.includes(bia.cpf), false);
  assert.equal(tela.texto.includes(bia.email), false);
  // Outro comprador logado: a ficha do Admin não abre para ele.
  const caio = await logado(apoio.pessoa('Caio'));
  assert.equal((await caio.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/compradores/${contaBia.id}`)).status, 401);
  const minha = await caio.get('/ticket/api/conta');
  assert.equal(minha.texto.includes(bia.nome), false);
});
