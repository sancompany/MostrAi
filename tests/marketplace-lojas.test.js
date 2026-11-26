require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
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
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

test('rotas: sem MARKETPLACE_ATIVO=1 tudo responde 404', async () => {
  delete process.env.MARKETPLACE_ATIVO;
  const app = await subirApp();
  try {
    for (const caminho of ['/admin/lojas', '/admin/lojas/planos', '/conta/loja', '/marketplace/api/espacos']) {
      assert.strictEqual(
        (await app.chamar('GET', caminho, null, { 'x-admin': '1', 'x-conta': '1' })).status,
        404,
        caminho,
      );
    }
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
    // A dona não mexe no cadastro conferido (documento, nome) — só na vitrine.
    const edit = await app.chamar(
      'PATCH',
      '/conta/loja',
      { documento: '99999999999', nome: 'Outro', descricao: 'Telas no centro' },
      daDona,
    );
    assert.strictEqual(edit.status, 200);
    assert.strictEqual(edit.corpo.documento, '12345678000199');
    assert.strictEqual(edit.corpo.nome, 'Painéis da Rota');
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

    // Moderação do Admin: pausa o espaço e ele sai da vitrine.
    const mod = await app.chamar(
      'POST',
      `/admin/lojas/${lojaId}/espacos/${espaco.corpo.id}/status`,
      { status: 'pausado' },
      admin,
    );
    assert.strictEqual(mod.status, 200);
    assert.deepStrictEqual((await app.chamar('GET', `/marketplace/api/lojas/${slug}`)).corpo.espacos, []);
    assert.strictEqual((await app.chamar('GET', '/marketplace/api/lojas/nao-existe')).status, 404);
    assert.strictEqual((await app.chamar('GET', '/marketplace/api/espacos?tipo=invalido')).status, 400);
  } finally {
    await app.fechar();
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
