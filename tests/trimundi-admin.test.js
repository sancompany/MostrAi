const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const armazenamento = require('../src/trimundi/armazenamento');

// Trimundi, Etapa 2 — o Admin (menu "Eventos"): as cinco funções por HTTP,
// atrás da sessão do Admin da Mostraí. Cada escrita confere as regras no
// servidor e grava a auditoria com o autor.

let srv;
let admin;
test.before(async () => {
  srv = await apoio.iniciarApp();
  admin = apoio.cliente(srv, { cookie: await apoio.entrarAdmin(srv) });
});
test.after(async () => {
  armazenamento.substituir(null);
  await srv.fechar();
  await apoio.encerrar();
});

const TEXTOS = { regras_entrada: 'Documento com foto.', termos_compra: 'Termos de compra.' };

async function novaEdicao(extra = {}) {
  const s = apoio.sufixo();
  const r = await admin.post('/admin/trimundi/edicoes', {
    evento: { nome: `Treemundo ${s}`, slug: `treemundo-${s}` },
    edicao: { nome: 'Edition 01', slug: 'EDITION01', classificacao_etaria: '18', textos: TEXTOS, ...extra },
  });
  assert.equal(r.status, 201, r.texto);
  return r.json;
}

async function novoTipo(edicaoId, corpo = {}) {
  const r = await admin.post(`/admin/trimundi/edicoes/${edicaoId}/tipos`, {
    nome: 'Pista',
    lotes: [{ preco_centavos: 5000, quantidade: 10 }],
    ...corpo,
  });
  assert.equal(r.status, 201, r.texto);
  return r.json;
}

const publicar = (id) => admin.post(`/admin/trimundi/edicoes/${id}/status`, { status: 'publicado' });

test('sem a sessão do Admin, nada abre', async () => {
  const anonimo = apoio.cliente(srv);
  for (const [metodo, caminho] of [
    ['get', '/admin/trimundi/estado'],
    ['get', '/admin/trimundi/edicoes'],
    ['post', '/admin/trimundi/edicoes'],
    ['post', '/admin/trimundi/operadores'],
    ['post', '/admin/trimundi/pedidos/00000000-0000-4000-8000-000000000000/reembolsos'],
  ]) {
    assert.equal((await anonimo[metodo](caminho)).status, 401, caminho);
  }
});

test('estado: diz o que está configurado, sem segredo nenhum', async () => {
  const r = await admin.get('/admin/trimundi/estado');
  assert.deepEqual(r.json, {
    configurada: true,
    checkout: 'configurado',
    imagens: null,
    email: false,
    pedido_teste: true,
  });
  assert.equal(r.texto.includes(process.env.TRIMUNDI_CHECKOUT_KEY), false);
});

test('evento e edição: endereço validado, reservado e único; segunda edição no mesmo evento', async () => {
  const reservado = await admin.post('/admin/trimundi/edicoes', {
    evento: { nome: 'Check', slug: 'checkin' },
    edicao: { nome: 'Ed', slug: 'ED01' },
  });
  assert.equal(reservado.status, 400);
  const espaco = await admin.post('/admin/trimundi/edicoes', {
    evento: { nome: 'X', slug: 'com espaço' },
    edicao: { nome: 'Ed', slug: 'ED01' },
  });
  assert.equal(espaco.status, 400);

  const ed = await novaEdicao();
  assert.equal(ed.status, 'rascunho');
  assert.match(ed.endereco_publico, /^\/ticket\/treemundo-[0-9a-f]+\/EDITION01$/);
  const repetido = await admin.post('/admin/trimundi/edicoes', {
    evento: { nome: 'Outro', slug: ed.evento.slug.toUpperCase() },
    edicao: { nome: 'Ed', slug: 'ED01' },
  });
  assert.equal(repetido.status, 409, 'endereço de evento sem diferença de maiúscula');
  const segunda = await admin.post('/admin/trimundi/edicoes', {
    evento: { id: ed.evento.id },
    edicao: { nome: 'Edition 02', slug: 'EDITION02' },
  });
  assert.equal(segunda.status, 201);
  const mesma = await admin.post('/admin/trimundi/edicoes', {
    evento: { id: ed.evento.id },
    edicao: { nome: 'De novo', slug: 'edition01' },
  });
  assert.equal(mesma.status, 409);
  const lista = await admin.get('/admin/trimundi/edicoes');
  assert.ok(lista.json.some((e) => e.id === ed.id));
});

test('publicar exige classificação, regras e termos; publicada, o endereço trava', async () => {
  const s = apoio.sufixo();
  const r = await admin.post('/admin/trimundi/edicoes', {
    evento: { nome: 'Sem textos', slug: `sem-${s}` },
    edicao: { nome: 'Ed', slug: 'ED01' },
  });
  const id = r.json.id;
  const falta = await publicar(id);
  assert.equal(falta.status, 422);
  assert.deepEqual(falta.json.falta, ['classificação etária', 'regras de entrada', 'termos e condições de compra']);

  assert.equal(
    (await admin.patch(`/admin/trimundi/edicoes/${id}`, { classificacao_etaria: '16', textos: TEXTOS })).status,
    200,
  );
  const pub = await publicar(id);
  assert.equal(pub.status, 200);
  assert.equal(pub.json.endereco_travado, true);
  assert.equal((await admin.patch(`/admin/trimundi/edicoes/${id}`, { slug: 'ED02' })).status, 409);
  assert.equal((await admin.patch(`/admin/trimundi/edicoes/${id}`, { evento: { slug: `outro-${s}` } })).status, 409);
  assert.equal(
    (await admin.patch(`/admin/trimundi/edicoes/${id}`, { nome: 'Nome novo' })).json.nome,
    'Nome novo',
    'o resto muda',
  );
  assert.equal((await admin.post(`/admin/trimundi/edicoes/${id}/status`, { status: 'rascunho' })).status, 409);
  assert.equal(
    (await admin.post(`/admin/trimundi/edicoes/${id}/status`, { status: 'pausado' })).json.status,
    'pausado',
  );
  assert.equal(
    (await admin.post(`/admin/trimundi/edicoes/${id}/status`, { status: 'encerrado' })).json.status,
    'encerrado',
  );
  assert.equal(
    (await admin.patch(`/admin/trimundi/edicoes/${id}`, { nome: 'Depois' })).status,
    409,
    'encerrada é só consulta',
  );
  const { rows } = await consultar(
    "SELECT count(*)::int AS n FROM metricas WHERE nome = 'catalogo:edicao_publica' AND edicao_id = $1",
    [id],
  );
  assert.equal(rows[0].n, 1);
});

test('textos versionados: mudar grava versão nova e a antiga fica guardada', async () => {
  const ed = await novaEdicao();
  const mudou = await admin.patch(`/admin/trimundi/edicoes/${ed.id}`, { textos: { termos_compra: 'Termos v2.' } });
  assert.deepEqual(mudou.json.versoes_novas, [{ tipo: 'termos_compra', versao: 2 }]);
  assert.equal(mudou.json.textos.termos_compra.versao, 2);
  const igual = await admin.patch(`/admin/trimundi/edicoes/${ed.id}`, { textos: { termos_compra: 'Termos v2.' } });
  assert.deepEqual(igual.json.versoes_novas, [], 'mesmo texto não cria versão');
  const { rows } = await consultar(
    "SELECT versao, vigente FROM termos WHERE edicao_id = $1 AND tipo = 'termos_compra' ORDER BY versao",
    [ed.id],
  );
  assert.deepEqual(rows, [
    { versao: 1, vigente: false },
    { versao: 2, vigente: true },
  ]);
  const condicoes = await admin.patch(`/admin/trimundi/edicoes/${ed.id}`, {
    textos: { condicoes_especiais: 'Meia-entrada: lei 12.933.' },
  });
  assert.equal(condicoes.json.textos.condicoes_especiais.versao, 1);
});

test('capacidade não fica abaixo do que já está ocupado', async () => {
  const pronta = await apoio.edicaoPronta();
  await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 2));
  const r = await admin.patch(`/admin/trimundi/edicoes/${pronta.edicao.id}`, { capacidade: 1 });
  assert.equal(r.status, 409);
  assert.match(r.json.erro, /\(2\)/);
  assert.equal((await admin.patch(`/admin/trimundi/edicoes/${pronta.edicao.id}`, { capacidade: 2 })).status, 200);
});

// PNG 1×1 de verdade (assinatura + IHDR + IDAT + IEND).
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function enviarImagem(edicaoId, tipo, buffer, nome = 'banner.png') {
  const form = new FormData();
  form.append('tipo', tipo);
  form.append('arquivo', new Blob([buffer]), nome);
  return fetch(`${srv.base}/admin/trimundi/edicoes/${edicaoId}/imagens`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'x-forwarded-for': admin.ip },
    body: form,
  });
}

test('imagens: sem armazenamento é 503; só imagem de verdade; banner substitui; galeria até 8', async () => {
  const ed = await novaEdicao();
  armazenamento.substituir(null);
  assert.equal((await enviarImagem(ed.id, 'banner', PNG)).status, 503);

  const guardados = new Map();
  armazenamento.substituir({
    tipo: 'memoria',
    async salvar(caminho, buffer) {
      guardados.set(caminho, buffer);
      return `https://arquivos.teste.invalid/${caminho}`;
    },
    async remover(caminho) {
      guardados.delete(caminho);
    },
  });
  const texto = await enviarImagem(ed.id, 'banner', Buffer.from('<script>alert(1)</script> não é imagem'), 'x.png');
  assert.equal(texto.status, 400, 'a extensão não basta: confere os bytes');

  const primeiro = await enviarImagem(ed.id, 'banner', PNG);
  assert.equal(primeiro.status, 201);
  const segundo = await enviarImagem(ed.id, 'banner', PNG);
  assert.equal(segundo.status, 201);
  const ficha = await admin.get(`/admin/trimundi/edicoes/${ed.id}`);
  assert.equal(ficha.json.imagens.filter((i) => i.tipo === 'banner').length, 1, 'um banner só');
  assert.equal(guardados.size, 1, 'o arquivo do banner antigo sai do armazenamento');

  for (let i = 0; i < 8; i++) assert.equal((await enviarImagem(ed.id, 'galeria', PNG)).status, 201);
  assert.equal((await enviarImagem(ed.id, 'galeria', PNG)).status, 409);
  const umaDaGaleria = (await admin.get(`/admin/trimundi/edicoes/${ed.id}`)).json.imagens.find(
    (i) => i.tipo === 'galeria',
  );
  assert.equal((await admin.delete(`/admin/trimundi/imagens/${umaDaGaleria.id}`)).status, 200);
  assert.equal(guardados.size, 8);
  armazenamento.substituir(null);
});

test('tipos e lotes: preço mínimo, até 10 lotes, nada abaixo do vendido, lote com venda não se apaga', async () => {
  const ed = await novaEdicao();
  const barato = await admin.post(`/admin/trimundi/edicoes/${ed.id}/tipos`, {
    nome: 'Pista',
    lotes: [{ preco_centavos: 499, quantidade: 1 }],
  });
  assert.equal(barato.status, 400);
  assert.equal(barato.json.erro, 'O preço mínimo é R$ 5,00 (limite do meio de pagamento).');
  const muitos = await admin.post(`/admin/trimundi/edicoes/${ed.id}/tipos`, {
    nome: 'Pista',
    lotes: Array.from({ length: 11 }, () => ({ preco_centavos: 500, quantidade: 1 })),
  });
  assert.equal(muitos.status, 400);
  const datas = await admin.post(`/admin/trimundi/edicoes/${ed.id}/tipos`, {
    nome: 'Pista',
    lotes: [
      { preco_centavos: 500, quantidade: 1, inicio_vendas: '2026-12-10T10:00:00Z', fim_vendas: '2026-12-01T10:00:00Z' },
    ],
  });
  assert.equal(datas.status, 400);

  const tipo = await novoTipo(ed.id, {
    lotes: [
      { preco_centavos: 5000, quantidade: 3 },
      { preco_centavos: 7000, quantidade: 5 },
    ],
  });
  assert.deepEqual(
    tipo.lotes.map((l) => [l.numero, l.situacao]),
    [
      [1, 'a_venda'],
      [2, 'aguardando_anterior'],
    ],
  );
  assert.equal(
    (
      await admin.post(`/admin/trimundi/edicoes/${ed.id}/tipos`, {
        nome: 'pista',
        lotes: [{ preco_centavos: 500, quantidade: 1 }],
      })
    ).status,
    409,
  );

  await publicar(ed.id);
  const pronta = { slugEvento: ed.evento.slug, slugEdicao: ed.slug, tipo };
  await apoio.novoPedido(pronta, apoio.itensDe(tipo, 2));
  const [l1, l2] = tipo.lotes;
  const abaixo = await admin.patch(`/admin/trimundi/tipos/${tipo.id}`, {
    lotes: [
      { id: l1.id, preco_centavos: 5000, quantidade: 1 },
      { id: l2.id, preco_centavos: 7000, quantidade: 5 },
    ],
  });
  assert.equal(abaixo.status, 409);
  const semLote1 = await admin.patch(`/admin/trimundi/tipos/${tipo.id}`, {
    lotes: [{ id: l2.id, preco_centavos: 7000, quantidade: 5 }],
  });
  assert.equal(semLote1.status, 409);
  assert.match(semLote1.json.erro, /encerre o lote/);
  const maisUm = await admin.patch(`/admin/trimundi/tipos/${tipo.id}`, {
    lotes: [
      { id: l1.id, preco_centavos: 5000, quantidade: 3 },
      { id: l2.id, preco_centavos: 7500, quantidade: 5 },
      { preco_centavos: 9000, quantidade: 5 },
    ],
  });
  assert.equal(maisUm.status, 200);
  assert.deepEqual(
    maisUm.json.lotes.map((l) => [l.numero, l.preco_centavos]),
    [
      [1, 5000],
      [2, 7500],
      [3, 9000],
    ],
  );

  const encerrado = await admin.post(`/admin/trimundi/lotes/${l1.id}/encerrar`);
  assert.equal(encerrado.status, 200);
  assert.equal(encerrado.json.vigente.preco_centavos, 7500, 'o seguinte assume na hora');
  assert.equal(encerrado.json.lotes[1].quantidade, 5);
  assert.equal(encerrado.json.disponivel_agora, 11, '5 + 1 que sobrou do encerrado + 5 do 3º');
  assert.equal((await admin.post(`/admin/trimundi/lotes/${l1.id}/encerrar`)).status, 409);
  const inativo = await admin.patch(`/admin/trimundi/tipos/${tipo.id}`, { ativo: false });
  assert.equal(inativo.json.disponivel_agora, 0);
});

test('promoção: de 2 a 20 ingressos, preço mínimo, tipo da própria edição; a lista mostra a situação', async () => {
  const ed = await novaEdicao();
  const tipo = await novoTipo(ed.id);
  const outra = await novaEdicao();
  const tipoDeOutra = await novoTipo(outra.id);
  const base = { nome: 'Combo', preco_total_centavos: 9000, quantidade: 5 };
  const um = await admin.post(`/admin/trimundi/edicoes/${ed.id}/promocoes`, {
    ...base,
    itens: [{ categoria_id: tipo.id, quantidade: 1 }],
  });
  assert.equal(um.status, 400);
  const barato = await admin.post(`/admin/trimundi/edicoes/${ed.id}/promocoes`, {
    ...base,
    preco_total_centavos: 100,
    itens: [{ categoria_id: tipo.id, quantidade: 2 }],
  });
  assert.equal(barato.status, 400);
  const alheio = await admin.post(`/admin/trimundi/edicoes/${ed.id}/promocoes`, {
    ...base,
    itens: [{ categoria_id: tipoDeOutra.id, quantidade: 2 }],
  });
  assert.equal(alheio.status, 400);
  const ok = await admin.post(`/admin/trimundi/edicoes/${ed.id}/promocoes`, {
    ...base,
    itens: [{ categoria_id: tipo.id, quantidade: 2 }],
  });
  assert.equal(ok.status, 201, ok.texto);
  const lista = await admin.get(`/admin/trimundi/edicoes/${ed.id}/promocoes`);
  assert.equal(lista.json[0].situacao, 'a_venda');
  assert.equal(lista.json[0].ingressos_por_combo, 2);
  const pausada = await admin.patch(`/admin/trimundi/promocoes/${ok.json.id}`, { ativo: false });
  assert.equal(pausada.json.situacao, 'inativa');
});

test('cortesia: idempotente pela chave, classificação obrigatória; cancelar libera a vaga; pago não se cancela por aqui', async () => {
  const pronta = await apoio.edicaoPronta({ capacidade: 1 });
  const url = `/admin/trimundi/edicoes/${pronta.edicao.id}/cortesias`;
  const corpo = {
    ...apoio.pessoa('Convidado'),
    categoria_id: pronta.tipo.id,
    classificacao: 'equipe',
    chave: apoio.chave(),
  };
  assert.equal((await admin.post(url, { ...corpo, classificacao: 'vip' })).status, 400);
  const r = await admin.post(url, corpo);
  assert.equal(r.status, 201);
  const repetida = await admin.post(url, corpo);
  assert.equal(repetida.json.ingresso_id, r.json.ingresso_id, 'clique duplo não emite duas');
  assert.equal(repetida.json.repetida, true);
  assert.equal((await admin.post(url, { ...corpo, chave: apoio.chave() })).status, 409, 'capacidade 1');

  const cancelar = `/admin/trimundi/ingressos/${r.json.ingresso_id}/cancelar`;
  assert.equal((await admin.post(cancelar, {})).status, 400, 'motivo obrigatório');
  assert.equal((await admin.post(cancelar, { motivo: 'nome errado' })).status, 200);
  assert.equal((await admin.post(cancelar, { motivo: 'de novo' })).status, 409);
  assert.equal((await admin.post(url, { ...corpo, chave: apoio.chave() })).status, 201, 'a vaga voltou');

  const folgada = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(folgada, apoio.itensDe(folgada.tipo, 1));
  await apoio.pagar(p.pedido_id);
  const { rows } = await consultar('SELECT id FROM ingressos WHERE pedido_id = $1', [p.pedido_id]);
  assert.equal((await admin.post(`/admin/trimundi/ingressos/${rows[0].id}/cancelar`, { motivo: 'x' })).status, 409);
  const resumo = await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/resumo`);
  assert.equal(resumo.json.cortesias, 1);
  assert.equal(resumo.json.receita_confirmada_centavos, 0, 'cortesia nunca é receita');
});

test('participantes no Admin: lista, QR em PNG e SVG, link novo do pedido e a ficha do pedido', async () => {
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(p.pedido_id);
  const lista = await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/participantes?filtro=pagos`);
  assert.equal(lista.json.total, 1);
  const ingressoId = lista.json.itens[0].id;
  const png = await fetch(`${srv.base}/admin/trimundi/ingressos/${ingressoId}/qr`, {
    headers: { cookie: admin.cookie },
  });
  assert.equal(png.headers.get('content-type'), 'image/png');
  const svg = await fetch(`${srv.base}/admin/trimundi/ingressos/${ingressoId}/qr?formato=svg`, {
    headers: { cookie: admin.cookie },
  });
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);

  const link = await admin.post(`/admin/trimundi/pedidos/${p.pedido_id}/link`);
  const t = new URL(link.json.url).searchParams.get('t');
  const pagina = await apoio.cliente(srv).get(`/ticket/api/pedidos/${p.pedido_id}?t=${encodeURIComponent(t)}`);
  assert.equal(pagina.status, 200, 'o link novo abre o pedido');
  const ficha = await admin.get(`/admin/trimundi/pedidos/${p.pedido_id}`);
  assert.equal(ficha.json.status, 'pago');
  assert.equal(ficha.json.ingressos.length, 1);
  assert.equal((await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/participantes?filtro=nada`)).status, 400);
});

test('operadores pelo Admin: o código aparece só na criação; a lista não leva segredo', async () => {
  const ed = await novaEdicao();
  const email = `porta.${apoio.sufixo()}@exemplo.com`;
  const criado = await admin.post('/admin/trimundi/operadores', { nome: 'Porta 1', email, edicoes: [ed.id] });
  assert.equal(criado.status, 201);
  assert.match(criado.json.codigo, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(criado.json.endereco, 'https://site.teste.invalid/ticket/ativar');
  assert.equal(
    (await admin.post('/admin/trimundi/operadores', { nome: 'Porta 1', email, edicoes: 'todas' })).status,
    409,
  );
  const lista = await admin.get('/admin/trimundi/operadores');
  const op = lista.json.find((o) => o.email === email);
  assert.equal(op.status, 'aguardando_ativacao');
  assert.deepEqual(
    op.edicoes.map((e) => e.id),
    [ed.id],
  );
  assert.equal(lista.texto.includes(criado.json.codigo), false);
  assert.equal(lista.texto.includes('codigo_hash'), false);
  assert.equal(lista.texto.includes('senha_hash'), false);
  assert.equal((await admin.patch(`/admin/trimundi/operadores/${op.id}`, { edicoes: 'todas' })).json.edicoes, 'todas');
  assert.equal((await admin.post(`/admin/trimundi/operadores/${op.id}/desativar`)).json.status, 'desativado');
  assert.equal((await admin.post(`/admin/trimundi/operadores/${op.id}/desativar`)).status, 409);
  const novo = await admin.post(`/admin/trimundi/operadores/${op.id}/codigo`);
  assert.notEqual(novo.json.codigo, criado.json.codigo);
});

test('auditoria: cada escrita do Admin fica com o autor e sem dado pessoal', async () => {
  const ed = await novaEdicao();
  const tipo = await novoTipo(ed.id);
  await admin.post(`/admin/trimundi/edicoes/${ed.id}/cortesias`, {
    ...apoio.pessoa('Convidado'),
    categoria_id: tipo.id,
    classificacao: 'convidado',
    chave: apoio.chave(),
  });
  const { rows } = await consultar(
    `SELECT acao, autor, detalhe::text AS detalhe FROM auditoria
      WHERE (entidade = 'edicao' AND entidade_id = $1) OR (entidade = 'categoria' AND entidade_id = $2)
         OR (acao = 'cortesia_emitida' AND detalhe->>'edicao_id' = $1)
      ORDER BY id`,
    [String(ed.id), String(tipo.id)],
  );
  assert.deepEqual(
    rows.map((r) => r.acao),
    ['edicao_criada', 'tipo_criado', 'cortesia_emitida'],
  );
  assert.ok(rows.every((r) => r.autor === process.env.ADMIN_USER));
  assert.ok(
    rows.every((r) => !/@|\d{11}/.test(r.detalhe)),
    'auditoria sem e-mail nem CPF',
  );
});

test('pedido de teste pelo Admin (HTTP): sai com o link do pedido e o do pagamento', async () => {
  const pronta = await apoio.edicaoPronta({ publicar: false });
  const r = await admin.post(`/admin/trimundi/edicoes/${pronta.edicao.id}/pedido-teste`, {
    itens: apoio.itensDe(pronta.tipo, 1),
    comprador: apoio.pessoa('Equipe'),
    participantes: [apoio.pessoa('Equipe')],
  });
  assert.equal(r.status, 201, r.texto);
  assert.match(r.json.url, /^\/ticket\/pedido\//);
  assert.equal(r.json.pagamento.modo, 'checkout');
});
