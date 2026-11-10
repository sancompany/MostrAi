const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const armazenamento = require('../src/trimundi/armazenamento');
const eventos = require('../src/trimundi/eventos');

// Ficha do evento reorganizada (pedido do dono, 10/11/2026): endereço público
// gerado do nome (sem colisão, sem mudar o de quem já existe) e o logo do
// evento ao lado do banner, no mesmo armazenamento e pelo mesmo envio.

let srv;
let admin;
const guardados = new Map();
test.before(async () => {
  srv = await apoio.iniciarApp();
  admin = apoio.cliente(srv, { cookie: await apoio.entrarAdmin(srv) });
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
});
test.after(async () => {
  armazenamento.substituir(null);
  await srv.fechar();
  await apoio.encerrar();
});

const TEXTOS = { regras_entrada: 'Documento com foto.', termos_compra: 'Termos de compra.' };

const criar = (evento, edicao = {}) =>
  admin.post('/admin/trimundi/edicoes', { evento, edicao: { nome: 'EDITION01', ...edicao } });

test('sem endereço escrito, o endereço sai do nome do evento e do código da edição', async () => {
  const s = apoio.sufixo();
  const r = await criar({ nome: `Festa de Verão São João ${s}` }, { nome: 'Edição 01 — Pôr do Sol' });
  assert.equal(r.status, 201, r.texto);
  assert.equal(r.json.evento.slug, `festa-de-verao-sao-joao-${s}`);
  assert.equal(r.json.slug, 'edicao-01-por-do-sol');
  assert.equal(r.json.endereco_publico, `/ticket/festa-de-verao-sao-joao-${s}/edicao-01-por-do-sol`);
  // Corta no tamanho do banco, sem hífen sobrando no fim.
  const longo = await criar({ nome: `${'Muito '.repeat(16)}${s}` }, { nome: `${'Edição '.repeat(10)}fim` });
  assert.equal(longo.status, 201, longo.texto);
  assert.ok(longo.json.evento.slug.length <= 60 && !longo.json.evento.slug.endsWith('-'));
  assert.ok(longo.json.slug.length <= 40 && !longo.json.slug.endsWith('-'));
});

test('colisão ganha número no fim; nome curto, reservado ou só símbolo também viram endereço válido', async () => {
  const s = apoio.sufixo();
  const nome = `Treemundo ${s}`;
  const a = await criar({ nome });
  const b = await criar({ nome });
  const c = await criar({ nome: nome.toUpperCase() });
  assert.deepEqual(
    [a.json.evento.slug, b.json.evento.slug, c.json.evento.slug],
    [`treemundo-${s}`, `treemundo-${s}-2`, `treemundo-${s}-3`],
  );
  // O banco tem outros testes: o número no fim pode já ter sido usado.
  assert.match((await criar({ nome: 'Api' })).json.evento.slug, /^api-evento(-\d+)?$/, 'reservado');
  assert.match((await criar({ nome: 'A' })).json.evento.slug, /^a-evento(-\d+)?$/, 'curto');
  assert.match((await criar({ nome: '!!!' })).json.evento.slug, /^evento(-\d+)?$/, 'só símbolo');

  // Edição repetida no mesmo evento também ganha número; em outro evento, não.
  const segunda = await criar({ id: a.json.evento.id }, { nome: 'EDITION01' });
  assert.equal(segunda.status, 201, segunda.texto);
  assert.equal(segunda.json.slug, 'edition01-2');
  assert.equal(b.json.slug, 'edition01');
});

test('criações simultâneas com o mesmo nome não brigam pelo mesmo endereço', async () => {
  const nome = `Simultâneo ${apoio.sufixo()}`;
  const rs = await Promise.all([1, 2, 3, 4].map(() => criar({ nome })));
  for (const r of rs) assert.equal(r.status, 201, r.texto);
  assert.equal(new Set(rs.map((r) => r.json.evento.slug)).size, 4);
});

test('endereço escrito nas configurações avançadas continua valendo, validado e único', async () => {
  const s = apoio.sufixo();
  const r = await criar({ nome: 'Qualquer', slug: `meu-endereco-${s}` }, { slug: 'ED-ESPECIAL' });
  assert.equal(r.status, 201, r.texto);
  assert.equal(r.json.endereco_publico, `/ticket/meu-endereco-${s}/ED-ESPECIAL`);
  assert.equal(
    (await criar({ nome: 'Outro', slug: `MEU-ENDERECO-${s}` })).status,
    409,
    'escrito à mão não ganha número',
  );
  assert.equal((await criar({ nome: 'Outro', slug: 'checkin' })).status, 400, 'reservado');
});

test('editar não muda o endereço de quem já existe (nem com o campo vazio)', async () => {
  const s = apoio.sufixo();
  const r = await criar({ nome: `Antigo ${s}`, slug: `antigo-${s}` }, { slug: 'EDITION01', textos: TEXTOS });
  const id = r.json.id;
  const antes = r.json.endereco_publico;
  const mudou = await admin.patch(`/admin/trimundi/edicoes/${id}`, {
    nome: 'Outro código',
    slug: '',
    evento: { nome: `Nome novo ${s}`, slug: '' },
  });
  assert.equal(mudou.status, 200, mudou.texto);
  assert.equal(mudou.json.endereco_publico, antes);
  assert.equal(mudou.json.nome, 'Outro código');
  assert.equal(mudou.json.evento.nome, `Nome novo ${s}`);
  // Antes de publicar, ainda dá para trocar à mão; depois, não.
  const trocado = await admin.patch(`/admin/trimundi/edicoes/${id}`, { slug: 'ED02' });
  assert.equal(trocado.json.endereco_publico, `/ticket/antigo-${s}/ED02`);
  await admin.patch(`/admin/trimundi/edicoes/${id}`, { classificacao_etaria: '18' });
  assert.equal((await admin.post(`/admin/trimundi/edicoes/${id}/status`, { status: 'publicado' })).status, 200);
  assert.equal((await admin.patch(`/admin/trimundi/edicoes/${id}`, { slug: 'ED03' })).status, 409);
  assert.equal(
    (await admin.get(`/ticket/api/edicoes/antigo-${s}/ED02`)).status,
    200,
    'a página publicada segue no endereço de sempre',
  );
});

// PNG 1×1 de verdade.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
function enviar(edicaoId, tipo, buffer = PNG) {
  const form = new FormData();
  form.append('tipo', tipo);
  form.append('arquivo', new Blob([buffer]), `${tipo}.png`);
  return fetch(`${srv.base}/admin/trimundi/edicoes/${edicaoId}/imagens`, {
    method: 'POST',
    headers: { cookie: admin.cookie, 'x-forwarded-for': admin.ip },
    body: form,
  });
}

test('logo: envio próprio, um por edição, independente do banner; substitui e remove', async () => {
  const ed = (await criar({ nome: `Logo ${apoio.sufixo()}` }, { textos: TEXTOS, classificacao_etaria: '18' })).json;
  const caminhos = () => [...guardados.keys()].filter((c) => c.startsWith(`edicoes/${ed.id}/`));
  assert.equal((await enviar(ed.id, 'banner')).status, 201);
  const logo1 = await enviar(ed.id, 'logo');
  assert.equal(logo1.status, 201);
  assert.equal((await logo1.json()).tipo, 'logo');
  assert.equal((await enviar(ed.id, 'logo')).status, 201, 'enviar outro substitui');
  let ficha = (await admin.get(`/admin/trimundi/edicoes/${ed.id}`)).json;
  assert.equal(ficha.imagens.filter((i) => i.tipo === 'logo').length, 1);
  assert.equal(ficha.imagens.filter((i) => i.tipo === 'banner').length, 1, 'o banner fica');
  assert.match(ficha.logo, /^https:\/\/arquivos\.teste\.invalid\/edicoes\/\d+\/logo-/);
  assert.match(ficha.banner, /\/banner-/);
  assert.equal(caminhos().length, 2, 'o arquivo do logo antigo sai do armazenamento');
  assert.equal((await enviar(ed.id, 'logo', Buffer.from('<svg onload=x>'))).status, 400, 'só imagem de verdade');
  assert.equal((await enviar(ed.id, 'capa')).status, 400, 'tipo que não existe');

  // A página de venda e o card da vitrine mostram o logo.
  await admin.post(`/admin/trimundi/edicoes/${ed.id}/status`, { status: 'publicado' });
  const publica = await admin.get(`/ticket/api/edicoes/${ed.evento.slug}/${ed.slug}`);
  assert.equal(publica.json.edicao.logo, ficha.logo);
  const vitrine = await admin.get(`/ticket/api/vitrine?q=${encodeURIComponent(ed.evento.nome)}`);
  assert.equal(vitrine.json.eventos[0].logo, ficha.logo);
  assert.equal(vitrine.json.eventos[0].banner, ficha.banner);

  const idLogo = ficha.imagens.find((i) => i.tipo === 'logo').id;
  assert.equal((await admin.delete(`/admin/trimundi/imagens/${idLogo}`)).status, 200);
  ficha = (await admin.get(`/admin/trimundi/edicoes/${ed.id}`)).json;
  assert.equal(ficha.logo, null);
  assert.ok(ficha.banner, 'remover o logo não mexe no banner');
  assert.equal(caminhos().length, 1);
});

test('o banco guarda a regra: tipo de imagem conhecido e um logo por edição', async () => {
  const ed = await eventos.criarEdicao(
    { evento: { nome: `Banco ${apoio.sufixo()}` }, edicao: { nome: 'E1' } },
    apoio.AUTOR,
  );
  const inserir = (tipo) =>
    consultar(
      "INSERT INTO edicao_imagens (edicao_id, tipo, caminho, url) VALUES ($1, $2, 'x', 'https://x.invalid/x')",
      [ed.id, tipo],
    );
  await inserir('logo');
  await assert.rejects(inserir('logo'), /ux_edicao_imagens_logo/);
  await assert.rejects(inserir('capa'), /edicao_imagens_tipo_check/);
  await inserir('galeria');
});
