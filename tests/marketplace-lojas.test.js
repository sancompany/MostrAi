require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const lojas = require('../src/lojas/repository');
const { hojeComercial } = require('../src/lib/vigencia');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const gerador = require('../src/playlist/gerador');
const { instalarPlayer, tirarDoSorteio } = require('./apoio-player');

// Marketplace de Lojas — Etapa 3 (migration 123): lojas, planos e assinaturas
// da loja, vitrine e contato, e a NÃO-INTERFERÊNCIA com a rede própria
// (Mostraí Core). As lojas ficam no banco de teste (o histórico da loja é
// imutável, então a loja não se apaga); os pontos e telas da Core criados
// aqui são removidos no fim.

const HORARIO_24H = Object.fromEntries(
  ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sab'].map((d) => [d, [{ abre: '00:00', fecha: '24:00' }]]),
);
const sufixo = () => randomUUID().slice(0, 8);
const ADMIN = { operador: 'admin-teste', operadorAccess: null };
const emMatao = (dia) => new Date(`${dia}T15:00:00Z`); // meio-dia em Matão

const criados = { pontos: [], criativos: [] };
test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const pontoId of criados.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM midias_exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
  delete process.env.MARKETPLACE_ATIVO;
  await pool.end();
});

async function novaConta({ plano = null } = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Loja Teste ${sufixo()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `marketplace-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  if (plano) await pool.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [conta.id, plano]);
  return anunciantesRepo.buscarPorId(conta.id);
}

const novoPlano = (dados = {}) =>
  lojas.criarPlano({
    id: `ml-${sufixo()}`,
    nome: 'Plano de loja teste',
    modalidade: 'mensal',
    prazo_meses: 1,
    valor_mensal: 79.9,
    dias_tolerancia: 5,
    ...dados,
  });

async function lojaAtiva({ conta = null, inicio, plano = null } = {}) {
  const c = conta || (await novaConta());
  const loja = await lojas.criarLoja(
    {
      conta_id: c.id,
      slug: `loja-${sufixo()}`,
      nome: 'Extra Painéis',
      documento: '12345678000199',
      cidade: 'Matão',
      uf: 'SP',
    },
    ADMIN,
  );
  await lojas.mudarStatus(loja.id, 'ativa', null, ADMIN);
  const p = plano || (await novoPlano());
  const assinatura = await lojas.criarAssinatura(loja.id, { plano_loja_id: p.id, inicio }, ADMIN, emMatao(inicio));
  return { conta: c, loja, plano: p, assinatura };
}

const situacaoEm = async (lojaId, dia) => (await lojas.ficha(lojaId, emMatao(dia))).situacao;
const naVitrine = async (slug, dia) => Boolean(await lojas.lojaPublica(slug, emMatao(dia)));

// ---------------------------------------------------------------------------
test('plano de loja: mensal e anual (12+ meses); nada entra na tabela `planos` dos anunciantes', async () => {
  const id = `ml-${sufixo()}`;
  const mensal = await lojas.criarPlano({ id, nome: 'Mensal', modalidade: 'mensal', prazo_meses: 1, valor_mensal: 50 });
  assert.strictEqual(mensal.modalidade, 'mensal');
  assert.strictEqual(Number(mensal.taxa_percentual), 0);
  const anual = await novoPlano({ modalidade: 'anual', prazo_meses: 12, valor_mensal: 60, taxa_percentual: 2 });
  assert.strictEqual(anual.prazo_meses, 12);
  await assert.rejects(novoPlano({ modalidade: 'anual', prazo_meses: 6 }), /12 meses ou mais/);
  await assert.rejects(
    lojas.criarPlano({ id, nome: 'x2', modalidade: 'mensal', prazo_meses: 1, valor_mensal: 1 }),
    /já existe/,
  );
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM planos WHERE id = ANY($1)', [
    [mensal.id, anual.id],
  ]);
  assert.strictEqual(rows[0].n, 0, 'plano de loja nunca é linha de `planos`');
});

test('fim do contrato: início + N meses − 1 dia (o último dia é inclusivo)', () => {
  assert.strictEqual(lojas.fimDoContrato('2030-03-01', 1), '2030-03-31');
  assert.strictEqual(lojas.fimDoContrato('2030-03-01', 12), '2031-02-28');
  assert.strictEqual(lojas.fimDoContrato('2030-01-31', 1), '2030-02-27');
  assert.strictEqual(lojas.fimDoContrato('2028-02-29', 12), '2029-02-27');
});

test('criar loja: papel "loja" na conta sem tirar "anunciante"; endereço e conta únicos; conta excluída recusada', async () => {
  const conta = await novaConta();
  const loja = await lojas.criarLoja({ conta_id: conta.id, slug: `loja-${sufixo()}`, nome: 'Painéis X' }, ADMIN);
  assert.strictEqual(loja.status, 'rascunho');
  const depois = await anunciantesRepo.buscarPorId(conta.id);
  assert.deepStrictEqual([...depois.papeis].sort(), ['anunciante', 'loja']);
  await assert.rejects(
    lojas.criarLoja({ conta_id: conta.id, slug: `outra-${sufixo()}`, nome: 'Dois' }, ADMIN),
    /já tem loja/,
  );
  const outra = await novaConta();
  await assert.rejects(lojas.criarLoja({ conta_id: outra.id, slug: loja.slug, nome: 'Copia' }, ADMIN), /outra loja/);
  await assert.rejects(
    lojas.criarLoja({ conta_id: outra.id, slug: 'Com Espaço', nome: 'Inválida' }, ADMIN),
    /minúsculas/,
  );
  await pool.query('UPDATE anunciantes SET excluido_em = now() WHERE id = $1', [outra.id]);
  await assert.rejects(
    lojas.criarLoja({ conta_id: outra.id, slug: `exc-${sufixo()}`, nome: 'Excluída' }, ADMIN),
    /não encontrada/,
  );
  const { rows } = await pool.query('SELECT acao FROM lojas_eventos WHERE loja_id = $1', [loja.id]);
  assert.deepStrictEqual(
    rows.map((r) => r.acao),
    ['loja_criada'],
  );
});

test('status da loja: transições, motivo obrigatório para suspender, encerrada é final', async () => {
  const conta = await novaConta();
  const loja = await lojas.criarLoja({ conta_id: conta.id, slug: `st-${sufixo()}`, nome: 'Status' }, ADMIN);
  await assert.rejects(lojas.mudarStatus(loja.id, 'suspensa', 'x', ADMIN), /rascunho para suspensa/);
  await lojas.mudarStatus(loja.id, 'ativa', null, ADMIN);
  await assert.rejects(lojas.mudarStatus(loja.id, 'suspensa', '', ADMIN), /motivo/);
  await lojas.mudarStatus(loja.id, 'suspensa', 'documentação pendente', ADMIN);
  await lojas.mudarStatus(loja.id, 'ativa', null, ADMIN);
  await lojas.mudarStatus(loja.id, 'encerrada', 'fim de contrato', ADMIN);
  await assert.rejects(lojas.mudarStatus(loja.id, 'ativa', null, ADMIN), /encerrada para ativa/);
  await assert.rejects(lojas.criarAssinatura(loja.id, { plano_loja_id: 'qualquer' }, ADMIN), /encerrada/);
});

test('vigência na vitrine: antes do início fora; tolerância sem pagamento; inadimplente sai; pagamento volta; vencida sai', async () => {
  const { loja, assinatura } = await lojaAtiva({ inicio: '2030-03-01' });
  assert.strictEqual(assinatura.fim, '2030-03-31');
  assert.strictEqual(await situacaoEm(loja.id, '2030-02-28'), 'aguardando_inicio');
  assert.strictEqual(await naVitrine(loja.slug, '2030-02-28'), false);
  // Nada pago: vale até início − 1 + 5 dias de tolerância = 05/03.
  assert.strictEqual(await situacaoEm(loja.id, '2030-03-05'), 'na_vitrine');
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-05'), true);
  assert.strictEqual(await situacaoEm(loja.id, '2030-03-06'), 'inadimplente');
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-06'), false);
  // Pagamento registrado até o fim do contrato: volta para a vitrine.
  await lojas.registrarPagamento(
    assinatura.id,
    { pago_ate: '2030-03-31', valor: 79.9, meio: 'pix', referencia: 'PIX-1' },
    ADMIN,
  );
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-06'), true);
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-31'), true, 'o último dia é inclusivo');
  assert.strictEqual(await situacaoEm(loja.id, '2030-04-01'), 'vencida');
  assert.strictEqual(await naVitrine(loja.slug, '2030-04-01'), false);
  // Pagamento nunca para trás nem fora do contrato; o histórico não se altera.
  await assert.rejects(
    lojas.registrarPagamento(assinatura.id, { pago_ate: '2030-03-15', valor: 1, meio: 'pix' }, ADMIN),
    /já está pago/,
  );
  await assert.rejects(
    lojas.registrarPagamento(assinatura.id, { pago_ate: '2030-05-01', valor: 1, meio: 'pix' }, ADMIN),
    /dentro do contrato/,
  );
  await assert.rejects(
    pool.query('UPDATE assinaturas_loja_pagamentos SET valor = 1 WHERE assinatura_id = $1', [assinatura.id]),
    /não se altera/,
  );
});

test('renovação: só depois de vencer (a vencida vira encerrada); cancelar tira da vitrine na hora', async () => {
  const { loja, plano, assinatura } = await lojaAtiva({ inicio: '2030-03-01' });
  await assert.rejects(
    lojas.criarAssinatura(loja.id, { plano_loja_id: plano.id, inicio: '2030-03-10' }, ADMIN, emMatao('2030-03-10')),
    /assinatura em curso/,
  );
  const nova = await lojas.criarAssinatura(
    loja.id,
    { plano_loja_id: plano.id, inicio: '2030-04-01' },
    ADMIN,
    emMatao('2030-04-01'),
  );
  const { rows } = await pool.query('SELECT status FROM assinaturas_loja WHERE id = $1', [assinatura.id]);
  assert.strictEqual(rows[0].status, 'encerrada');
  assert.strictEqual(await naVitrine(loja.slug, '2030-04-02'), true);
  await lojas.cancelarAssinatura(nova.id, 'pedido da loja', ADMIN);
  assert.strictEqual(await situacaoEm(loja.id, '2030-04-02'), 'sem_assinatura');
  assert.strictEqual(await naVitrine(loja.slug, '2030-04-02'), false);
});

test('suspensão da loja e conta suspensa/excluída tiram da vitrine; reativar devolve', async () => {
  const { loja, conta, assinatura } = await lojaAtiva({ inicio: '2030-03-01' });
  await lojas.registrarPagamento(assinatura.id, { pago_ate: '2030-03-31', valor: 79.9, meio: 'pix' }, ADMIN);
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-10'), true);
  await lojas.mudarStatus(loja.id, 'suspensa', 'denúncia em análise', ADMIN);
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-10'), false);
  await lojas.mudarStatus(loja.id, 'ativa', null, ADMIN);
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-10'), true);
  await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [conta.id]);
  assert.strictEqual(await situacaoEm(loja.id, '2030-03-10'), 'conta_indisponivel');
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-10'), false);
  await pool.query('UPDATE anunciantes SET suspenso = false WHERE id = $1', [conta.id]);
  assert.strictEqual(await naVitrine(loja.slug, '2030-03-10'), true);
});

test('catálogo: só espaço publicado de loja visível; filtros por cidade e tipo; sem dado cadastral na vitrine', async () => {
  const { loja, assinatura } = await lojaAtiva({ inicio: '2030-03-01' });
  await lojas.registrarPagamento(assinatura.id, { pago_ate: '2030-03-31', valor: 79.9, meio: 'pix' }, ADMIN);
  const cidade = `Cidade ${sufixo()}`;
  await lojas.criarEspaco(
    loja.id,
    {
      slug: 'totem-centro',
      nome: 'Totem do Centro',
      tipo: 'totem',
      cidade,
      uf: 'sp',
      preco: 300,
      periodo_preco: 'semana',
      status: 'publicado',
      latitude: -21.6,
      longitude: -48.36,
    },
    ADMIN,
  );
  await lojas.criarEspaco(loja.id, { slug: 'led-rascunho', nome: 'LED', tipo: 'painel_led', cidade, uf: 'SP' }, ADMIN);
  await assert.rejects(
    lojas.criarEspaco(
      loja.id,
      { slug: 'sem-periodo', nome: 'Sem período', tipo: 'totem', cidade, uf: 'SP', preco: 10 },
      ADMIN,
    ),
    /preço e período/,
  );
  const lista = await lojas.vitrine({ cidade }, emMatao('2030-03-10'));
  assert.deepStrictEqual(
    lista.map((e) => e.slug),
    ['totem-centro'],
  );
  assert.strictEqual(lista[0].preco, 300);
  assert.strictEqual(lista[0].uf, 'SP');
  assert.strictEqual(lista[0].loja_slug, loja.slug);
  assert.deepStrictEqual(await lojas.vitrine({ cidade, tipo: 'outdoor' }, emMatao('2030-03-10')), []);
  const publica = await lojas.lojaPublica(loja.slug, emMatao('2030-03-10'));
  const texto = JSON.stringify(publica);
  for (const proibido of ['documento', 'razao_social', 'conta_id', 'assinatura', 'valor_mensal', '12345678000199']) {
    assert.ok(!texto.includes(proibido), `vitrine sem ${proibido}`);
  }
  // Vencida: a vitrine some inteira (o espaço publicado junto).
  assert.deepStrictEqual(await lojas.vitrine({ cidade }, emMatao('2030-04-01')), []);
});

test('contato: só loja visível e espaço publicado dela; fica com a loja', async () => {
  const { loja, assinatura } = await lojaAtiva({ inicio: '2030-03-01' });
  await lojas.registrarPagamento(assinatura.id, { pago_ate: '2030-03-31', valor: 79.9, meio: 'pix' }, ADMIN);
  await lojas.criarEspaco(
    loja.id,
    { slug: 'painel-1', nome: 'Painel 1', tipo: 'painel_led', cidade: 'Matão', uf: 'SP', status: 'publicado' },
    ADMIN,
  );
  await lojas.criarEspaco(loja.id, { slug: 'oculto', nome: 'Oculto', tipo: 'totem', cidade: 'Matão', uf: 'SP' }, ADMIN);
  const dados = {
    nome: 'Comprador',
    email: 'Comprador@Example.com',
    mensagem: 'Quero a semana do dia 10',
    espaco: 'painel-1',
  };
  await lojas.registrarContato(loja.slug, dados, emMatao('2030-03-10'));
  await assert.rejects(
    lojas.registrarContato(loja.slug, { ...dados, espaco: 'oculto' }, emMatao('2030-03-10')),
    /espaço não encontrado/,
  );
  await assert.rejects(lojas.registrarContato(loja.slug, dados, emMatao('2030-04-05')), /loja não encontrada/);
  await assert.rejects(
    lojas.registrarContato(loja.slug, { ...dados, email: 'sem-arroba' }, emMatao('2030-03-10')),
    /e-mail/,
  );
  const contatos = await lojas.contatosDaLoja(loja.id);
  assert.strictEqual(contatos.length, 1);
  assert.strictEqual(contatos[0].email, 'comprador@example.com');
  assert.strictEqual(contatos[0].espaco_slug, 'painel-1');
});

test('LGPD: a exportação da titular traz a loja, o contrato com pagamentos e os espaços — não os contatos de terceiros', async () => {
  const { conta, loja, assinatura } = await lojaAtiva({ inicio: '2030-03-01' });
  await lojas.registrarPagamento(assinatura.id, { pago_ate: '2030-03-31', valor: 79.9, meio: 'pix' }, ADMIN);
  await lojas.criarEspaco(
    loja.id,
    { slug: 'e1', nome: 'Espaço 1', tipo: 'totem', cidade: 'Matão', uf: 'SP', status: 'publicado' },
    ADMIN,
  );
  await lojas.registrarContato(
    loja.slug,
    { nome: 'Terceiro', email: 'terceiro@example.com', mensagem: 'oi' },
    emMatao('2030-03-10'),
  );
  const exp = await require('../src/titular/repository').exportarConta(conta.id);
  assert.deepStrictEqual(
    exp.loja_no_marketplace.map((l) => l.slug),
    [loja.slug],
  );
  assert.strictEqual(exp.assinaturas_da_loja.length, 1);
  assert.strictEqual(exp.assinaturas_da_loja[0].pagamentos.length, 1);
  assert.deepStrictEqual(
    exp.espacos_da_loja.map((e) => e.slug),
    ['e1'],
  );
  assert.ok(!JSON.stringify(exp).includes('terceiro@example.com'), 'contato de terceiro fora da exportação');
});

// ---------------------------------------------------------------------------
// Rotas: desligadas por padrão; com a chave, Admin, dona e vitrine.
async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-marketplace', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-admin'] === '1') {
      req.session.isAdmin = true;
      req.session.adminUsuario = 'admin-teste';
    }
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/lojas/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo, cabecalhos = {}) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: {
        'Content-Type': 'application/json',
        'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.1`,
        ...cabecalhos,
      },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  // Página HTML: status, texto e cabeçalhos.
  const pagina = async (caminho, cabecalhos = {}) => {
    const r = await fetch(`${base}${caminho}`, { headers: cabecalhos });
    return { status: r.status, html: await r.text(), cache: r.headers.get('cache-control') };
  };
  // Upload multipart (campo `arquivo`), como o navegador manda.
  const enviar = async (caminho, buffer, nome, cabecalhos = {}) => {
    const form = new FormData();
    form.append('arquivo', new Blob([buffer]), nome);
    const r = await fetch(`${base}${caminho}`, { method: 'POST', headers: cabecalhos, body: form });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, pagina, enviar, fechar: () => new Promise((r) => server.close(r)) };
}

test('rotas: sem MARKETPLACE_ATIVO=1 tudo responde 404', async () => {
  delete process.env.MARKETPLACE_ATIVO;
  const app = await subirApp();
  try {
    for (const caminho of [
      '/admin/lojas',
      '/admin/lojas/planos',
      '/admin/lojas/espacos',
      '/conta/loja',
      '/conta/loja/contatos',
      '/marketplace/api/espacos',
      '/marketplace/api/lojas/qualquer',
    ]) {
      assert.strictEqual(
        (await app.chamar('GET', caminho, null, { 'x-admin': '1', 'x-conta': '1' })).status,
        404,
        caminho,
      );
    }
    // Páginas também somem: quem responde é o 404 do site.
    for (const caminho of ['/marketplace', '/loja/qualquer', '/anunciante/minha-loja']) {
      assert.strictEqual((await app.pagina(caminho, { 'x-conta': '1' })).status, 404, caminho);
    }
    // Escrita idem — nem a validação roda.
    assert.strictEqual((await app.chamar('POST', '/marketplace/api/lojas/qualquer/contato', {})).status, 404);
    assert.strictEqual(
      (await app.chamar('POST', '/admin/lojas/1/espacos/1/moderacao', { acao: 'bloquear' }, { 'x-admin': '1' })).status,
      404,
    );
    // O Admin só pergunta se mostra o item "Lojas" no menu.
    assert.deepStrictEqual((await app.chamar('GET', '/admin/marketplace/estado')).corpo, { ativo: false });
  } finally {
    await app.fechar();
  }
});

test('rotas ligadas: Admin cria e ativa, dona edita só a vitrine dela, público vê e manda contato', async () => {
  process.env.MARKETPLACE_ATIVO = '1';
  const app = await subirApp();
  const admin = { 'x-admin': '1' };
  try {
    const hoje = hojeComercial();
    const plano = await app.chamar(
      'POST',
      '/admin/lojas/planos',
      { id: `ml-${sufixo()}`, nome: 'Mensal', modalidade: 'mensal', prazo_meses: 1, valor_mensal: 99 },
      admin,
    );
    assert.strictEqual(plano.status, 201, JSON.stringify(plano.corpo));
    const dona = await novaConta();
    const slug = `rota-${sufixo()}`;
    const criada = await app.chamar(
      'POST',
      '/admin/lojas',
      { conta_id: dona.id, slug, nome: 'Painéis da Rota', documento: '12.345.678/0001-99' },
      admin,
    );
    assert.strictEqual(criada.status, 201, JSON.stringify(criada.corpo));
    assert.strictEqual(criada.corpo.documento, '12345678000199');
    const lojaId = criada.corpo.id;
    assert.strictEqual(
      (await app.chamar('POST', `/admin/lojas/${lojaId}/status`, { status: 'ativa' }, admin)).status,
      200,
    );
    const ass = await app.chamar(
      'POST',
      `/admin/lojas/${lojaId}/assinaturas`,
      { plano_loja_id: plano.corpo.id, inicio: hoje },
      admin,
    );
    assert.strictEqual(ass.status, 201, JSON.stringify(ass.corpo));
    assert.strictEqual(ass.corpo.fim >= hoje, true);

    // Dona: sem sessão 401; outra conta sem loja 404; a dona cria espaço.
    assert.strictEqual((await app.chamar('GET', '/conta/loja')).status, 401);
    const outra = await novaConta();
    assert.strictEqual((await app.chamar('GET', '/conta/loja', null, { 'x-conta': String(outra.id) })).status, 404);
    const daDona = { 'x-conta': String(dona.id) };
    const espaco = await app.chamar(
      'POST',
      '/conta/loja/espacos',
      { slug: 'totem-1', nome: 'Totem 1', tipo: 'totem', cidade: 'Matão', uf: 'SP', status: 'publicado' },
      daDona,
    );
    assert.strictEqual(espaco.status, 201, JSON.stringify(espaco.corpo));
    // Loja ativa: a dona edita o perfil (nome, descrição), mas o cadastro
    // conferido (documento) só muda pelo Admin.
    const edit = await app.chamar(
      'PATCH',
      '/conta/loja',
      { documento: '99999999999', nome: 'Painéis da Rota Centro', descricao: 'Telas no centro' },
      daDona,
    );
    assert.strictEqual(edit.status, 200);
    assert.strictEqual(edit.corpo.documento, '12345678000199');
    assert.strictEqual(edit.corpo.nome, 'Painéis da Rota Centro');
    assert.strictEqual(edit.corpo.descricao, 'Telas no centro');
    const ficha = await app.chamar('GET', '/conta/loja', null, daDona);
    assert.strictEqual(ficha.corpo.situacao, 'na_vitrine');

    // Público.
    const pub = await app.chamar('GET', `/marketplace/api/lojas/${slug}`);
    assert.strictEqual(pub.status, 200);
    assert.deepStrictEqual(
      pub.corpo.espacos.map((e) => e.slug),
      ['totem-1'],
    );
    assert.ok(!('documento' in pub.corpo));
    const contato = await app.chamar('POST', `/marketplace/api/lojas/${slug}/contato`, {
      nome: 'Cliente',
      email: 'c@example.com',
      mensagem: 'Orçamento',
      espaco: 'totem-1',
    });
    assert.strictEqual(contato.status, 201);
    const meus = await app.chamar('GET', '/conta/loja/contatos', null, daDona);
    assert.strictEqual(meus.corpo.length, 1);
    assert.strictEqual(
      (await app.chamar('POST', `/conta/loja/contatos/${meus.corpo[0].id}/lido`, null, daDona)).status,
      200,
    );

    // Moderação do Admin: bloqueia o espaço e ele sai da vitrine.
    const mod = await app.chamar(
      'POST',
      `/admin/lojas/${lojaId}/espacos/${espaco.corpo.id}/moderacao`,
      { acao: 'bloquear', motivo: 'Foto de outro lugar' },
      admin,
    );
    assert.strictEqual(mod.status, 200, JSON.stringify(mod.corpo));
    assert.strictEqual(mod.corpo.status, 'pausado');
    assert.deepStrictEqual((await app.chamar('GET', `/marketplace/api/lojas/${slug}`)).corpo.espacos, []);
    // Sem motivo, o bloqueio é recusado.
    assert.strictEqual(
      (
        await app.chamar(
          'POST',
          `/admin/lojas/${lojaId}/espacos/${espaco.corpo.id}/moderacao`,
          { acao: 'bloquear' },
          admin,
        )
      ).status,
      400,
    );
    // A dona não republica o espaço bloqueado pela rota.
    const republicar = await app.chamar(
      'PATCH',
      `/conta/loja/espacos/${espaco.corpo.id}`,
      { status: 'publicado' },
      daDona,
    );
    assert.strictEqual(republicar.status, 409);
    assert.match(republicar.corpo.erro, /só o Admin libera/);
    // A fila de moderação mostra o bloqueio.
    const fila = await app.chamar('GET', '/admin/lojas/espacos', null, admin);
    const naFila = fila.corpo.find((e) => e.id === espaco.corpo.id);
    assert.strictEqual(naFila.bloqueado_motivo, 'Foto de outro lugar');
    assert.strictEqual((await app.chamar('GET', '/marketplace/api/lojas/nao-existe')).status, 404);
    assert.strictEqual((await app.chamar('GET', '/marketplace/api/espacos?tipo=invalido')).status, 400);
  } finally {
    await app.fechar();
  }
});

// ---------------------------------------------------------------------------
// MODERAÇÃO (migration 124): o bloqueio do Admin tira o espaço da vitrine e
// trava a republicação pela dona — no repositório, na rota (acima) e no
// próprio banco. Liberar só destrava; quem publica de novo é a dona.
const ESPACO_LED = { slug: 'led-1', nome: 'LED 1', tipo: 'painel_led', cidade: 'Matão', uf: 'SP' };

test('moderação: bloqueio do Admin trava a republicação pela dona, no repositório e no banco', async () => {
  const hoje = hojeComercial();
  const { loja } = await lojaAtiva({ inicio: hoje });
  const dona = { operador: `conta:${loja.conta_id}`, operadorAccess: null };
  const espaco = await lojas.criarEspaco(loja.id, { ...ESPACO_LED, status: 'publicado' }, dona);
  const naLoja = async () => (await lojas.lojaPublica(loja.slug)).espacos.some((e) => e.slug === 'led-1');
  const naVitrineGeral = async () => (await lojas.vitrine({})).some((e) => e.loja_slug === loja.slug);
  assert.ok(await naLoja());
  assert.ok(await naVitrineGeral());

  // Motivo obrigatório; ação desconhecida recusada; liberar sem bloqueio é 404.
  await assert.rejects(lojas.moderarEspaco(loja.id, espaco.id, { acao: 'bloquear', motivo: ' ' }, ADMIN), /motivo/);
  await assert.rejects(lojas.moderarEspaco(loja.id, espaco.id, { acao: 'apagar' }, ADMIN), /bloquear ou liberar/);
  await assert.rejects(lojas.moderarEspaco(loja.id, espaco.id, { acao: 'liberar' }, ADMIN), (e) => e.status === 404);
  // Espaço de outra loja: 404, nada muda.
  const outra = await lojaAtiva({ inicio: hoje });
  await assert.rejects(
    lojas.moderarEspaco(outra.loja.id, espaco.id, { acao: 'bloquear', motivo: 'errado' }, ADMIN),
    (e) => e.status === 404,
  );
  assert.ok(await naLoja());

  const bloqueado = await lojas.moderarEspaco(
    loja.id,
    espaco.id,
    { acao: 'bloquear', motivo: 'Endereço não confere' },
    ADMIN,
  );
  assert.strictEqual(bloqueado.status, 'pausado');
  assert.ok(bloqueado.bloqueado_admin_em);
  assert.strictEqual(bloqueado.bloqueado_motivo, 'Endereço não confere');
  assert.strictEqual(await naLoja(), false);
  assert.strictEqual(await naVitrineGeral(), false);
  // Nem contato sobre ele.
  await assert.rejects(
    lojas.registrarContato(loja.slug, { nome: 'Cliente', email: 'c@example.com', mensagem: 'oi', espaco: 'led-1' }),
    (e) => e.status === 404,
  );

  // A dona não republica; o resto ela edita, e o espaço continua pausado.
  await assert.rejects(
    lojas.atualizarEspaco(loja.id, espaco.id, { status: 'publicado' }, dona),
    (e) => e.status === 409 && /só o Admin libera/.test(e.message),
  );
  const editado = await lojas.atualizarEspaco(loja.id, espaco.id, { descricao: 'Foto nova em breve' }, dona);
  assert.strictEqual(editado.status, 'pausado');
  assert.ok(editado.bloqueado_admin_em);
  // O banco recusa mesmo por fora do código (CHECK da migration 124).
  await assert.rejects(
    pool.query("UPDATE lojas_espacos SET status = 'publicado' WHERE id = $1", [espaco.id]),
    (e) => e.code === '23514',
  );
  await assert.rejects(
    pool.query('UPDATE lojas_espacos SET bloqueado_motivo = NULL WHERE id = $1', [espaco.id]),
    (e) => e.code === '23514',
  );

  // Liberar: destrava, mas não publica sozinho.
  const liberado = await lojas.moderarEspaco(loja.id, espaco.id, { acao: 'liberar' }, ADMIN);
  assert.strictEqual(liberado.status, 'pausado');
  assert.strictEqual(liberado.bloqueado_admin_em, null);
  assert.strictEqual(liberado.bloqueado_motivo, null);
  assert.strictEqual(await naLoja(), false);
  await lojas.atualizarEspaco(loja.id, espaco.id, { status: 'publicado' }, dona);
  assert.ok(await naLoja());

  // Bloquear um arquivado não o ressuscita como pausado.
  const arquivado = await lojas.criarEspaco(loja.id, { ...ESPACO_LED, slug: 'led-2' }, dona);
  await lojas.atualizarEspaco(loja.id, arquivado.id, { status: 'arquivado' }, dona);
  const b2 = await lojas.moderarEspaco(loja.id, arquivado.id, { acao: 'bloquear', motivo: 'Duplicado' }, ADMIN);
  assert.strictEqual(b2.status, 'arquivado');

  // Tudo no histórico da loja, com autor e motivo.
  const { rows } = await pool.query(
    "SELECT acao, detalhe, autor FROM lojas_eventos WHERE loja_id = $1 AND acao IN ('espaco_bloqueado', 'espaco_liberado') ORDER BY id",
    [loja.id],
  );
  assert.deepStrictEqual(
    rows.map((r) => r.acao),
    ['espaco_bloqueado', 'espaco_liberado', 'espaco_bloqueado'],
  );
  assert.strictEqual(rows[0].detalhe.motivo, 'Endereço não confere');
  assert.strictEqual(rows[0].detalhe.espaco_id, espaco.id);
  const hist = await lojas.historico(loja.id);
  assert.ok(hist.eventos.some((e) => e.acao === 'espaco_liberado'));
  assert.strictEqual(hist.assinaturas.length, 1);
});

// ---------------------------------------------------------------------------
// RETENÇÃO (LGPD, docs/inventario-de-dados.md): contato da vitrine fica 12
// meses e sai, lido ou não.
test('retenção: contato com mais de 12 meses sai no expurgo, o recente fica', async () => {
  assert.strictEqual(lojas.RETENCAO_CONTATOS_MESES, 12);
  const { loja } = await lojaAtiva({ inicio: hojeComercial() });
  const contato = (nome) => lojas.registrarContato(loja.slug, { nome, email: 'c@example.com', mensagem: 'Orçamento' });
  const velho = await contato('Antigo');
  const quase = await contato('Quase um ano');
  const novo = await contato('Recente');
  await lojas.marcarContatoRespondido(loja.id, velho.id);
  await pool.query("UPDATE lojas_contatos SET criado_em = now() - interval '13 months' WHERE id = $1", [velho.id]);
  await pool.query("UPDATE lojas_contatos SET criado_em = now() - interval '11 months' WHERE id = $1", [quase.id]);
  assert.ok((await lojas.expurgarContatosAntigos()) >= 1);
  assert.deepStrictEqual(
    (await lojas.contatosDaLoja(loja.id)).map((c) => c.id).sort((a, b) => a - b),
    [quase.id, novo.id].sort((a, b) => a - b),
  );
  // Rodar de novo não apaga mais nada desta loja.
  await lojas.expurgarContatosAntigos();
  assert.strictEqual((await lojas.contatosDaLoja(loja.id)).length, 2);
});

test('contatos: respondido também conta como lido; contato de outra loja é 404', async () => {
  const { loja } = await lojaAtiva({ inicio: hojeComercial() });
  const outra = await lojaAtiva({ inicio: hojeComercial() });
  const c = await lojas.registrarContato(loja.slug, { nome: 'Cliente', email: 'c@example.com', mensagem: 'Oi' });
  const r = await lojas.marcarContatoRespondido(loja.id, c.id);
  assert.ok(r.lido_em);
  assert.ok(r.respondido_em);
  await assert.rejects(lojas.marcarContatoRespondido(outra.loja.id, c.id), (e) => e.status === 404);
  await assert.rejects(lojas.marcarContatoLido(outra.loja.id, c.id), (e) => e.status === 404);
});

// ---------------------------------------------------------------------------
// CADASTRO: a dona preenche razão social e documento enquanto a loja está em
// rascunho; depois de o Admin ativar, só o Admin muda.
test('cadastro: dona preenche razão social e documento só em rascunho; depois, só o Admin', async () => {
  const conta = await novaConta();
  const loja = await lojas.criarLoja({ conta_id: conta.id, slug: `cad-${sufixo()}`, nome: 'Cadastro' }, ADMIN);
  const dona = { operador: `conta:${conta.id}`, operadorAccess: null };
  const r = await lojas.atualizarLoja(
    loja.id,
    { razao_social: 'Cadastro Painéis Ltda', documento: '12.345.678/0001-99' },
    dona,
    { soVitrine: true },
  );
  assert.strictEqual(r.razao_social, 'Cadastro Painéis Ltda');
  assert.strictEqual(r.documento, '12345678000199');
  await lojas.mudarStatus(loja.id, 'ativa', null, ADMIN);
  const depois = await lojas.atualizarLoja(
    loja.id,
    { razao_social: 'Outra Ltda', documento: '98765432000100', nome: 'Cadastro Novo' },
    dona,
    { soVitrine: true },
  );
  assert.strictEqual(depois.razao_social, 'Cadastro Painéis Ltda');
  assert.strictEqual(depois.documento, '12345678000199');
  assert.strictEqual(depois.nome, 'Cadastro Novo');
  await assert.rejects(
    lojas.atualizarLoja(loja.id, { documento: '98765432000100' }, dona, { soVitrine: true }),
    /nada para alterar/,
  );
  const adm = await lojas.atualizarLoja(loja.id, { documento: '98765432000100' }, ADMIN);
  assert.strictEqual(adm.documento, '98765432000100');
  // Logo e foto não entram por URL livre — só pelo upload.
  const comUrl = await lojas.atualizarLoja(
    loja.id,
    { logo_url: 'https://exemplo.invalid/x.png', descricao: 'd' },
    dona,
    { soVitrine: true },
  );
  assert.strictEqual(comUrl.logo_url, null);
});

test('Admin: busca de contas para virar loja ignora quem já tem loja e trata curinga como texto', async () => {
  const livre = await novaConta();
  const comLoja = await novaConta();
  await lojas.criarLoja({ conta_id: comLoja.id, slug: `bc-${sufixo()}`, nome: 'Já Tem' }, ADMIN);
  assert.deepStrictEqual(
    (await lojas.buscarContas(livre.contato_email)).map((c) => c.id),
    [livre.id],
  );
  assert.deepStrictEqual(await lojas.buscarContas(comLoja.contato_email), []);
  assert.ok((await lojas.buscarContas(String(livre.id))).some((c) => c.id === livre.id));
  assert.deepStrictEqual(await lojas.buscarContas('%%%'), []);
  await assert.rejects(lojas.buscarContas('a'), /busca/);
});

// ---------------------------------------------------------------------------
// PÁGINAS (ligadas): HTML sem script, estilo nem handler inline (a CSP do
// site proíbe), título escapado e /loja/<slug> só enquanto a loja está na
// vitrine.
test('páginas ligadas: vitrine, página da loja e painel da dona, sem nada inline e com texto escapado', async () => {
  process.env.MARKETPLACE_ATIVO = '1';
  const app = await subirApp();
  try {
    assert.deepStrictEqual((await app.chamar('GET', '/admin/marketplace/estado')).corpo, { ativo: true });
    const conta = await novaConta();
    const loja = await lojas.criarLoja(
      {
        conta_id: conta.id,
        slug: `pag-${sufixo()}`,
        nome: 'Telas <b>&</b> "Cia"',
        cidade: 'Matão',
        uf: 'SP',
        descricao: '<script>alert(1)</script> Painéis no centro',
      },
      ADMIN,
    );
    // Rascunho: fora da vitrine, a página não existe.
    assert.strictEqual((await app.pagina(`/loja/${loja.slug}`)).status, 404);
    await lojas.mudarStatus(loja.id, 'ativa', null, ADMIN);
    await lojas.criarAssinatura(loja.id, { plano_loja_id: (await novoPlano()).id, inicio: hojeComercial() }, ADMIN);

    const p = await app.pagina(`/loja/${loja.slug}`);
    assert.strictEqual(p.status, 200);
    assert.strictEqual(p.cache, 'no-store');
    assert.ok(p.html.includes('<title>Telas &lt;b&gt;&amp;&lt;/b&gt; &quot;Cia&quot; — Matão/SP · Marketplace'));
    assert.ok(p.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!p.html.includes('<script>alert'));
    assert.ok(!p.html.includes('{{'));
    assert.ok(p.html.includes(`data-loja="${loja.slug}"`));
    // Endereço em maiúsculas leva à mesma loja.
    assert.strictEqual((await app.pagina(`/loja/${loja.slug.toUpperCase()}`)).status, 200);

    for (const caminho of ['/marketplace', `/loja/${loja.slug}`, '/anunciante/minha-loja']) {
      const r = await app.pagina(caminho);
      assert.strictEqual(r.status, 200, caminho);
      assert.ok(!/<style/i.test(r.html), `${caminho}: <style>`);
      assert.ok(!/\sstyle\s*=/i.test(r.html), `${caminho}: style=`);
      assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(r.html), `${caminho}: script inline`);
      assert.ok(!/\son[a-z]+\s*=/i.test(r.html), `${caminho}: handler inline`);
    }

    // Suspensa: some de novo.
    await lojas.mudarStatus(loja.id, 'suspensa', 'teste de página', ADMIN);
    assert.strictEqual((await app.pagina(`/loja/${loja.slug}`)).status, 404);
    assert.strictEqual((await app.pagina('/loja/nao-existe-mesmo')).status, 404);
  } finally {
    await app.fechar();
  }
});

// ---------------------------------------------------------------------------
// IMAGENS: logo e foto só pelo upload, tipo pelos bytes, cada dona na sua
// loja. STORAGE_CAPTURA desvia o arquivo para uma pasta local (sem Storage).
test('imagens: upload de logo e foto conferido pelos bytes, e só na própria loja', async () => {
  process.env.MARKETPLACE_ATIVO = '1';
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'mkt-storage-'));
  const capturaAntes = process.env.STORAGE_CAPTURA;
  process.env.STORAGE_CAPTURA = pasta;
  const app = await subirApp();
  try {
    const hoje = hojeComercial();
    const { conta, loja } = await lojaAtiva({ inicio: hoje });
    const daDona = { 'x-conta': String(conta.id) };
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

    assert.strictEqual((await app.enviar('/conta/loja/logo', PNG, 'logo.png')).status, 401);
    const logo = await app.enviar('/conta/loja/logo', PNG, 'logo.png', daDona);
    assert.strictEqual(logo.status, 200, JSON.stringify(logo.corpo));
    assert.match(logo.corpo.url, new RegExp(`^/e2e-storage/loja-${loja.id}-logo\\.png\\?v=\\d+$`));
    assert.ok(fs.existsSync(path.join(pasta, `loja-${loja.id}-logo.png`)));
    assert.strictEqual((await lojas.ficha(loja.id)).logo_url, logo.corpo.url);

    // HTML com nome de imagem: recusado pelos bytes. Sem arquivo: 400.
    const falso = await app.enviar(
      '/conta/loja/logo',
      Buffer.from('<html><script>alert(1)</script></html>'),
      'x.png',
      daDona,
    );
    assert.strictEqual(falso.status, 400);
    assert.strictEqual((await app.chamar('POST', '/conta/loja/logo', null, daDona)).status, 400);

    // Foto do espaço da própria loja.
    const espaco = await lojas.criarEspaco(loja.id, ESPACO_LED, ADMIN);
    const foto = await app.enviar(`/conta/loja/espacos/${espaco.id}/foto`, PNG, 'f.png', daDona);
    assert.strictEqual(foto.status, 200, JSON.stringify(foto.corpo));
    assert.match(foto.corpo.url, new RegExp(`^/e2e-storage/loja-${loja.id}-espaco-${espaco.id}\\.png\\?v=\\d+$`));

    // Espaço de OUTRA loja: 404, e nenhum arquivo é gravado.
    const outra = await lojaAtiva({ inicio: hoje });
    const daOutra = await lojas.criarEspaco(outra.loja.id, ESPACO_LED, ADMIN);
    const alheio = await app.enviar(`/conta/loja/espacos/${daOutra.id}/foto`, PNG, 'f.png', daDona);
    assert.strictEqual(alheio.status, 404);
    assert.ok(!fs.existsSync(path.join(pasta, `loja-${loja.id}-espaco-${daOutra.id}.png`)));
    const { rows } = await pool.query('SELECT foto_url FROM lojas_espacos WHERE id = $1', [daOutra.id]);
    assert.strictEqual(rows[0].foto_url, null);

    // O Admin sobe a logo de qualquer loja.
    const pelaMostrai = await app.enviar(`/admin/lojas/${outra.loja.id}/logo`, PNG, 'l.png', { 'x-admin': '1' });
    assert.strictEqual(pelaMostrai.status, 200, JSON.stringify(pelaMostrai.corpo));
  } finally {
    await app.fechar();
    if (capturaAntes === undefined) delete process.env.STORAGE_CAPTURA;
    else process.env.STORAGE_CAPTURA = capturaAntes;
    fs.rmSync(pasta, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// NÃO-INTERFERÊNCIA: a mesma tela, na mesma hora, gera exatamente a mesma
// playlist antes e depois de existirem lojas, planos de loja, assinaturas,
// espaços e contatos — inclusive com a conta anunciante virando dona de loja.
// E a conta não ganha plano, assinatura, ciclo nem obrigação de veiculação.
test('rede própria intacta: playlist idêntica e conta anunciante sem plano/ciclo/obrigação novos', async () => {
  const conta = await novaConta({ plano: 'essencial-1m' });
  const urlDaPeca = `https://exemplo.test/ml-${sufixo()}.mp4`;
  const c = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: urlDaPeca,
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await criativosRepo.atualizar(c.id, { status: 'aprovado' });
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2) RETURNING id`,
    [`ML ${sufixo()}`, JSON.stringify(HORARIO_24H)],
  );
  const pontoId = rows[0].id;
  criados.pontos.push(pontoId);
  await tirarDoSorteio(pontoId);
  const tela = await dispositivosRepo.criar(pontoId, {});
  await instalarPlayer(tela.id);
  await pool.query(
    'INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, clock_timestamp())',
    [conta.id, pontoId],
  );

  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  const gerar = async () => {
    // Recomeça a hora do zero: sem congelamento nem contador da geração anterior.
    await pool.query('DELETE FROM playlist_hora_congelada WHERE dispositivo_id = $1', [tela.id]);
    await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [tela.id]);
    await pool.query('DELETE FROM midias_exibicoes_contador WHERE dispositivo_id = $1', [tela.id]);
    const { servidorAgora: _relogio, ...envelope } = await gerador.gerarPlaylistDaHora(
      await dispositivosRepo.buscarComPonto(tela.id),
      hora,
    );
    // `servidorAgora` é o relógio do servidor na resposta (muda a cada
    // chamada); todo o resto tem de ser idêntico.
    return envelope;
  };
  const retrato = async () => {
    const core = await pool.query(
      `SELECT (SELECT plano_id FROM anunciantes WHERE id = $1) AS plano,
              (SELECT count(*)::int FROM assinaturas WHERE anunciante_id = $1) AS assinaturas,
              (SELECT count(*)::int FROM ciclos_contratados WHERE anunciante_id = $1) AS ciclos,
              (SELECT count(*)::int FROM obrigacoes_veiculacao WHERE anunciante_id = $1) AS obrigacoes,
              (SELECT count(*)::int FROM anunciantes_pontos WHERE anunciante_id = $1) AS escolhas,
              (SELECT count(*)::int FROM dispositivos WHERE ponto_id = $2) AS telas,
              (SELECT status FROM pontos WHERE id = $2) AS status_ponto`,
      [conta.id, pontoId],
    );
    return core.rows[0];
  };

  const antes = await gerar();
  const coreAntes = await retrato();
  assert.ok(JSON.stringify(antes).includes(urlDaPeca), 'a peça da conta anunciante está na playlist da tela');

  // Tudo do marketplace, inclusive a própria conta anunciante virando loja.
  const { loja, assinatura } = await lojaAtiva({ conta, inicio: hojeComercial() });
  await lojas.registrarPagamento(assinatura.id, { pago_ate: assinatura.fim, valor: 79.9, meio: 'pix' }, ADMIN);
  await lojas.criarEspaco(
    loja.id,
    { slug: 'tela-1', nome: 'Tela 1', tipo: 'tela_indoor', cidade: 'Matão', uf: 'SP', status: 'publicado' },
    ADMIN,
  );
  await lojas.registrarContato(loja.slug, { nome: 'Cliente', email: 'c@example.com', mensagem: 'oi' });
  await lojaAtiva({ inicio: hojeComercial() });

  const depois = await gerar();
  assert.deepStrictEqual(depois, antes, 'a playlist da rede própria não muda');
  assert.deepStrictEqual(await retrato(), coreAntes, 'nada da Core muda para a conta e o ponto');
  const papeis = (await anunciantesRepo.buscarPorId(conta.id)).papeis;
  assert.ok(papeis.includes('anunciante') && papeis.includes('loja'));
});
