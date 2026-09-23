require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');

// Reconstrução de Contas + Categorias (23/09/2026, pedido do dono): plano
// administrativo (benefício, nunca cobrança), suspensão que tira o acesso,
// substituição de criativo sem tirar o atual do ar, consolidação de
// categorias e o programa de vendedores aposentado — com linha real no banco
// e, onde a regra mora na rota, com a rota de verdade montada num app mínimo.

async function subirApp(montar) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-contas', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-admin'] === '1') {
      req.session.isAdmin = true;
      req.session.adminUsuario = 'admin-teste';
    }
    proximo();
  });
  montar(app);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', 'x-admin': '1' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function criarConta(extra = {}) {
  const campos = {
    nome_empresa: `Conta Teste ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
    contato_email: `contas-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, ${nomes.join(', ')})
     VALUES (now(), ${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  return rows[0];
}

async function apagarConta(id) {
  await new Promise((r) => setTimeout(r, 100)); // eventos.registrar é fire-and-forget
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM comissoes WHERE anunciante_id = $1 OR vendedor_conta_id = $1', [id]);
  await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM vendedores WHERE conta_id = $1', [id]);
  await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

function daqui(dias) {
  const d = new Date(Date.now() + dias * 24 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// ---------- plano administrativo ----------
const planoAdm = require('../src/financeiro/plano-administrativo');

test('validadeValida: só data real e que ainda não passou', () => {
  assert.strictEqual(planoAdm.validadeValida('2020-01-01'), null, 'passado');
  assert.strictEqual(planoAdm.validadeValida(`${new Date().getFullYear() + 1}-02-30`), null, '30/02 não existe');
  assert.strictEqual(planoAdm.validadeValida('amanhã'), null);
  assert.strictEqual(planoAdm.validadeValida(daqui(40)), daqui(40), 'devolve a própria string');
});

test('origemDoPlano separa assinatura, cortesia e comodato', () => {
  assert.strictEqual(planoAdm.origemDoPlano({ plano_id: null }), null);
  assert.strictEqual(planoAdm.origemDoPlano({ plano_id: 'x', plano_cortesia: false }), 'assinatura');
  assert.strictEqual(
    planoAdm.origemDoPlano({ plano_id: 'x', plano_cortesia: true, cortesia_motivo: 'comodato' }),
    'comodato',
  );
  assert.strictEqual(
    planoAdm.origemDoPlano({ plano_id: 'x', plano_cortesia: true, cortesia_motivo: 'teste' }),
    'cortesia',
  );
});

test('conceder → trocar → encerrar: um plano vigente, histórico guardado, nenhuma cobrança', async () => {
  const conta = await criarConta();
  try {
    const plano = (await pool.query("SELECT * FROM planos WHERE id = 'destaque-3m'")).rows[0];
    const { conta: depois } = await planoAdm.conceder({
      conta,
      plano,
      validoAte: daqui(90),
      observacao: 'comodato',
      adminUsuario: 'admin-teste',
    });
    assert.strictEqual(depois.plano_id, 'destaque-3m');
    assert.strictEqual(depois.plano_cortesia, true, 'benefício é cortesia — fora do MRR');
    assert.strictEqual(depois.data_expiracao, daqui(90), 'data de calendário, sem desvio de fuso');
    assert.notStrictEqual(depois.cortesia_motivo, 'comodato', 'observação "comodato" não vira comodato');
    assert.strictEqual(planoAdm.origemDoPlano(depois), 'cortesia');

    const prime = (await pool.query("SELECT * FROM planos WHERE id = 'maximo-12m'")).rows[0];
    await planoAdm.conceder({ conta: depois, plano: prime, validoAte: daqui(365), adminUsuario: 'admin-teste' });
    const historico = await planoAdm.historicoDaConta(conta.id);
    assert.strictEqual(historico.length, 2);
    assert.strictEqual(historico.filter((h) => !h.encerrado_em).length, 1, 'só um benefício aberto');
    const antigo = historico.find((h) => h.plano_id === 'destaque-3m');
    assert.strictEqual(antigo.encerrado_motivo, 'substituido');
    const novo = historico.find((h) => h.plano_id === 'maximo-12m');
    assert.strictEqual(novo.plano_anterior_id, 'destaque-3m');
    assert.strictEqual(novo.plano_anterior_origem, 'cortesia');
    assert.strictEqual(novo.concedido_por, 'admin-teste');

    const atual = (await pool.query('SELECT * FROM anunciantes WHERE id = $1', [conta.id])).rows[0];
    const encerrada = await planoAdm.encerrar({ conta: atual, adminUsuario: 'admin-teste' });
    assert.strictEqual(encerrada.plano_id, null, 'sem ponto em comodato: fica sem plano');
    assert.strictEqual(encerrada.plano_cortesia, false);
    const fechados = await planoAdm.historicoDaConta(conta.id);
    assert.ok(
      fechados.every((h) => h.encerrado_em),
      'histórico todo encerrado, nada apagado',
    );
    assert.strictEqual(fechados.length, 2);

    const { rows: dinheiro } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM assinaturas WHERE anunciante_id = $1)::int AS assinaturas,
              (SELECT COUNT(*) FROM cobrancas_confirmadas WHERE anunciante_id = $1)::int AS cobrancas`,
      [conta.id],
    );
    assert.deepStrictEqual(dinheiro[0], { assinaturas: 0, cobrancas: 0 }, 'benefício nunca gera cobrança');
  } finally {
    await apagarConta(conta.id);
  }
});

test('encerrar benefício de dono de ponto em comodato devolve o plano do comodato', async () => {
  const conta = await criarConta({ papeis: '{anunciante,ponto}' });
  try {
    await pool.query(
      `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, plano_ponto_id)
       VALUES ('Ponto Teste Contas', 'Rua X', 'Matão', 'SP', '15990000', 'x', 'X', '16999990000', $1, 'mais-cota')`,
      [conta.id],
    );
    const plano = (await pool.query("SELECT * FROM planos WHERE id = 'essencial-1m'")).rows[0];
    const { conta: comBeneficio } = await planoAdm.conceder({ conta, plano, validoAte: daqui(30) });
    const depois = await planoAdm.encerrar({ conta: comBeneficio });
    assert.strictEqual(depois.plano_id, 'comodato-basico');
    assert.strictEqual(depois.cortesia_motivo, 'comodato');
    assert.strictEqual(depois.data_expiracao, null, 'comodato não tem prazo');
  } finally {
    await apagarConta(conta.id);
  }
});

test('rota de plano administrativo: recusa o que não é benefício válido', async () => {
  const financeiro = require('../src/financeiro/routes');
  const app = await subirApp((a) => a.use(financeiro.router));
  const conta = await criarConta();
  const suspensa = await criarConta({ suspenso: true });
  try {
    const url = `/admin/anunciantes/${conta.id}/plano-administrativo`;
    for (const plano_id of ['comodato-basico', 'inicial-1m', 'fundador-12m', 'nao-existe']) {
      const r = await app.chamar('POST', url, { plano_id, valido_ate: daqui(30) });
      assert.strictEqual(r.status, 400, `${plano_id} não é plano comercial concedível`);
    }
    assert.strictEqual(
      (await app.chamar('POST', url, { plano_id: 'essencial-1m', valido_ate: '2020-01-01' })).status,
      400,
    );
    const r = await app.chamar('POST', `/admin/anunciantes/${suspensa.id}/plano-administrativo`, {
      plano_id: 'essencial-1m',
      valido_ate: daqui(30),
    });
    assert.strictEqual(r.status, 409, 'conta suspensa: reativa antes');
    const ok = await app.chamar('POST', url, { plano_id: 'essencial-1m', valido_ate: daqui(30), observacao: 'teste' });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.corpo.conta.plano_id, 'essencial-1m');
    assert.strictEqual(ok.corpo.assinatura_cancelada, false);
    const info = await app.chamar('GET', `/admin/anunciantes/${conta.id}/plano`);
    assert.strictEqual(info.corpo.origem, 'cortesia');
    assert.strictEqual(info.corpo.historico[0].concedido_por, 'admin-teste');
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
    await apagarConta(suspensa.id);
  }
});

test('trocar assinatura paga por benefício: San Checkout recusa → nada muda; aceita → cancela e concede', async () => {
  const sanCheckout = require('../src/financeiro/san-checkout');
  const financeiro = require('../src/financeiro/routes');
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const original = sanCheckout.cancelarAssinatura;
  const app = await subirApp((a) => a.use(financeiro.router));
  const conta = await criarConta({ plano_id: 'destaque-3m', plano_cortesia: false, data_expiracao: daqui(60) });
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: conta.id, planoId: 'destaque-3m', status: 'ativa' });
    const url = `/admin/anunciantes/${conta.id}/plano-administrativo`;

    sanCheckout.cancelarAssinatura = async () => {
      throw new Error('checkout fora do ar');
    };
    const falhou = await app.chamar('POST', url, { plano_id: 'maximo-1m', valido_ate: daqui(30) });
    assert.strictEqual(falhou.status, 502);
    const intacta = (await pool.query('SELECT plano_id, plano_cortesia FROM anunciantes WHERE id = $1', [conta.id]))
      .rows[0];
    assert.deepStrictEqual(intacta, { plano_id: 'destaque-3m', plano_cortesia: false }, 'nada foi alterado');
    assert.strictEqual((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa');

    const cancelou = [];
    sanCheckout.cancelarAssinatura = async (id) => {
      cancelou.push(id);
    };
    const ok = await app.chamar('POST', url, { plano_id: 'maximo-1m', valido_ate: daqui(30) });
    assert.strictEqual(ok.status, 200);
    assert.deepStrictEqual(cancelou, [assinatura.id], 'a assinatura paga é cancelada pela lógica existente');
    assert.strictEqual((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'cancelada');
    assert.strictEqual(ok.corpo.conta.plano_id, 'maximo-1m');
    assert.strictEqual(ok.corpo.conta.plano_cortesia, true);
    const [h] = await planoAdm.historicoDaConta(conta.id);
    assert.strictEqual(h.plano_anterior_origem, 'assinatura');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM cobrancas_confirmadas WHERE anunciante_id = $1', [
      conta.id,
    ]);
    assert.strictEqual(rows[0].n, 0, 'sem cobrança, sem diferença');
  } finally {
    sanCheckout.cancelarAssinatura = original;
    await app.fechar();
    await apagarConta(conta.id);
  }
});

// ---------- suspensão ----------
test('conta suspensa não entra e perde a sessão já aberta', async () => {
  const anunciantes = require('../src/anunciantes/routes');
  const { gerarHash } = require('../src/lib/senha');
  const senha = `Senha-${randomUUID()}`;
  const conta = await criarConta({ senha_hash: await gerarHash(senha) });
  const app = await subirApp((a) => {
    a.use(anunciantes.derrubarSessaoSuspensa);
    a.use(anunciantes.router);
  });
  try {
    const entrar = await app.chamar('POST', '/anunciantes/login', { email: conta.contato_email, senha });
    assert.strictEqual(entrar.status, 200, 'ativa entra');

    await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [conta.id]);
    const barrado = await app.chamar('POST', '/anunciantes/login', { email: conta.contato_email, senha });
    assert.strictEqual(barrado.status, 403);
    assert.match(barrado.corpo.erro, /suspensa/);
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
  }
});

test('derrubarSessaoSuspensa: tira a conta da sessão só quando está suspensa', async () => {
  const { derrubarSessaoSuspensa } = require('../src/anunciantes/routes');
  const conta = await criarConta();
  try {
    const req = { session: { anuncianteId: conta.id } };
    await derrubarSessaoSuspensa(req, {}, () => {});
    assert.strictEqual(req.session.anuncianteId, conta.id, 'ativa continua logada');
    await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [conta.id]);
    await derrubarSessaoSuspensa(req, {}, () => {});
    assert.strictEqual(req.session.anuncianteId, undefined, 'suspensa perde a sessão');
  } finally {
    await apagarConta(conta.id);
  }
});

// ---------- criativos ----------
async function criativo(contaId, extra = {}) {
  const campos = {
    anunciante_id: contaId,
    arquivo_original_url: 'peca.jpg',
    arquivo_normalizado_url: 'https://exemplo/peca.mp4',
    status: 'aprovado',
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO criativos (${nomes.join(', ')}) VALUES (${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  return rows[0];
}

test('substituição: A segue no ar com B em análise; aprovar B retira A; recusar B não mexe em A', async () => {
  const admin = require('../src/admin/routes');
  const anunciantes = require('../src/anunciantes/routes');
  const criativosRepo = require('../src/anunciantes/criativos-repository');
  const app = await subirApp((a) => {
    a.use(admin);
    a.use(anunciantes.router);
  });
  const conta = await criarConta({ plano_id: 'essencial-1m', data_expiracao: daqui(30) });
  try {
    const a = await criativo(conta.id);
    const b = await criativo(conta.id, { status: 'pendente', substitui_criativo_id: a.id });
    assert.strictEqual(await criativosRepo.contarNaoReprovados(conta.id), 1, 'substituto em análise não ocupa vaga');

    let lista = (await app.chamar('GET', `/admin/anunciantes/${conta.id}/criativos`)).corpo;
    assert.strictEqual(lista.criativos.find((c) => c.id === a.id).no_ar, true, 'A no ar enquanto B espera');
    assert.strictEqual(lista.limite_cadastro, 3);

    const aprovado = await app.chamar('PATCH', `/admin/criativos/${b.id}`, { status: 'aprovado' });
    assert.strictEqual(aprovado.status, 200);
    assert.strictEqual((await criativosRepo.buscarPorId(a.id)).status, 'retirado', 'A sai do ar, fica cadastrado');
    lista = (await app.chamar('GET', `/admin/anunciantes/${conta.id}/criativos`)).corpo;
    assert.deepStrictEqual(
      lista.criativos.filter((c) => c.no_ar).map((c) => c.id),
      [b.id],
      'só B no ar',
    );

    // B' recusado: B (agora no ar) não é tocado.
    const b2 = await criativo(conta.id, { status: 'pendente', substitui_criativo_id: b.id });
    await app.chamar('PATCH', `/admin/criativos/${b2.id}`, { status: 'reprovado', motivo_reprovacao: 'teste' });
    assert.strictEqual((await criativosRepo.buscarPorId(b.id)).status, 'aprovado');

    // Retirar e colocar no ar de novo.
    await app.chamar('PATCH', `/admin/criativos/${b.id}`, { status: 'retirado' });
    lista = (await app.chamar('GET', `/admin/anunciantes/${conta.id}/criativos`)).corpo;
    assert.strictEqual(lista.criativos.filter((c) => c.no_ar).length, 0, 'retirado não roda');
    await app.chamar('PATCH', `/admin/criativos/${b.id}`, { status: 'aprovado' });
    assert.strictEqual((await criativosRepo.buscarPorId(b.id)).status, 'aprovado');
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
  }
});

test('no ar respeita o limite do plano e a conta suspensa não veicula', async () => {
  const anunciantes = require('../src/anunciantes/routes');
  const app = await subirApp((a) => a.use(anunciantes.router));
  // essencial-1m põe 1 no ar por vez
  const conta = await criarConta({ plano_id: 'essencial-1m', data_expiracao: daqui(30) });
  try {
    await criativo(conta.id);
    await new Promise((r) => setTimeout(r, 20));
    const recente = await criativo(conta.id);
    let lista = (await app.chamar('GET', `/admin/anunciantes/${conta.id}/criativos`)).corpo;
    assert.deepStrictEqual(
      lista.criativos.filter((c) => c.no_ar).map((c) => c.id),
      [recente.id],
      'o mais recente, como o gerador',
    );
    await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [conta.id]);
    lista = (await app.chamar('GET', `/admin/anunciantes/${conta.id}/criativos`)).corpo;
    assert.strictEqual(lista.conta_veicula, false);
    assert.strictEqual(lista.criativos.filter((c) => c.no_ar).length, 0);
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
  }
});

// ---------- categorias ----------
test('074: sinônimos fundidos na canônica, sem apagar e sem duplicar ativa', async () => {
  const { rows } = await pool.query(
    `SELECT o.nome AS absorvida, o.legado, o.ativo, d.nome AS canonica, d.aliases
       FROM categorias o JOIN categorias d ON d.id = o.canonica_id
      WHERE o.nome IN ('Pousada', 'Casa de carnes', 'Ortodontia', 'Sementes')`,
  );
  const por = Object.fromEntries(rows.map((r) => [r.absorvida, r]));
  assert.strictEqual(por.Pousada.canonica, 'Hotel / Pousada');
  assert.ok(por.Pousada.aliases.includes('pousada'), 'o nome antigo vira alias');
  assert.strictEqual(por['Casa de carnes'].canonica, 'Açougue / Casa de carnes');
  assert.strictEqual(por.Ortodontia.canonica, 'Odontologia');
  assert.strictEqual(por.Sementes.canonica, 'Insumos agrícolas');
  for (const r of rows) assert.ok(r.legado && !r.ativo, `${r.absorvida} sai do cadastro, fica no banco`);

  const { rows: dup } = await pool.query(
    'SELECT lower(nome) FROM categorias WHERE ativo AND NOT legado GROUP BY 1 HAVING COUNT(*) > 1',
  );
  assert.deepStrictEqual(dup, []);
  const { rows: cadeia } = await pool.query(
    'SELECT o.id FROM categorias o JOIN categorias d ON d.id = o.canonica_id WHERE d.canonica_id IS NOT NULL OR d.legado',
  );
  assert.deepStrictEqual(cadeia, [], 'canônica nunca é legado nem aponta pra outra');
});

test('categorias: pública sem grupo nem legado; mesclar move contas e pontos; excluir em uso é recusado', async () => {
  const rotas = require('../src/categorias/routes');
  const app = await subirApp((a) => a.use(rotas));
  const sufixo = randomUUID().slice(0, 8);
  const origem = (
    await pool.query(`INSERT INTO categorias (nome, grupo) VALUES ($1, 'Teste') RETURNING *`, [`Origem ${sufixo}`])
  ).rows[0];
  const destino = (
    await pool.query(`INSERT INTO categorias (nome, grupo, aliases) VALUES ($1, 'Teste', '{x}') RETURNING *`, [
      `Destino ${sufixo}`,
    ])
  ).rows[0];
  const conta = await criarConta({ categoria_id: origem.id });
  try {
    const publica = (await app.chamar('GET', '/categorias')).corpo;
    assert.ok(publica.length > 100);
    assert.ok(
      publica.every((c) => !('grupo' in c)),
      'cliente não vê grupo',
    );
    assert.ok(!publica.some((c) => c.nome === 'Pousada'), 'legado não é oferecido');

    const adminLista = (await app.chamar('GET', '/admin/categorias')).corpo;
    assert.strictEqual(adminLista.find((c) => c.id === origem.id).uso_contas, 1, 'uso por contas vem na lista');

    assert.strictEqual((await app.chamar('DELETE', `/admin/categorias/${origem.id}`)).status, 409, 'em uso não exclui');
    assert.strictEqual(
      (await app.chamar('POST', `/admin/categorias/${origem.id}/mesclar`, { destino_id: origem.id })).status,
      400,
      'não mescla nela mesma',
    );
    const legado = (await pool.query("SELECT id FROM categorias WHERE nome = 'Pousada'")).rows[0];
    assert.strictEqual(
      (await app.chamar('POST', `/admin/categorias/${origem.id}/mesclar`, { destino_id: legado.id })).status,
      400,
      'canônica não pode ser legado',
    );

    const r = await app.chamar('POST', `/admin/categorias/${origem.id}/mesclar`, { destino_id: destino.id });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corpo.contas_movidas, 1);
    assert.ok(r.corpo.destino.aliases.includes(`origem ${sufixo}`));
    const movida = (await pool.query('SELECT categoria_id FROM anunciantes WHERE id = $1', [conta.id])).rows[0];
    assert.strictEqual(movida.categoria_id, destino.id, 'quem usava foi junto (bloqueio de concorrente correto)');
    const depois = (await pool.query('SELECT * FROM categorias WHERE id = $1', [origem.id])).rows[0];
    assert.strictEqual(depois.canonica_id, destino.id);
    assert.strictEqual(depois.legado, true);
    assert.strictEqual(depois.ativo, false);
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
    await pool.query('DELETE FROM categorias WHERE id = ANY($1::int[])', [[origem.id, destino.id]]);
  }
});

// ---------- vendedor aposentado ----------
test('vendedor aposentado: sem papel novo, sem convite novo, sem comissão nova — histórico intacto', async () => {
  const { liberarPapelNaConta } = require('../src/conta/modos');
  const convitesRepo = require('../src/convites/repository');
  const financeiro = require('../src/financeiro/routes');
  const app = await subirApp((a) => a.use(financeiro.router));
  const conta = await criarConta();
  try {
    assert.strictEqual((await app.chamar('POST', `/admin/anunciantes/${conta.id}/ativar-vendedor`)).status, 410);
    await liberarPapelNaConta(conta, 'vendedor', null, pool);
    const { rows } = await pool.query('SELECT papeis FROM anunciantes WHERE id = $1', [conta.id]);
    assert.ok(!rows[0].papeis.includes('vendedor'));
    const { rows: v } = await pool.query('SELECT 1 FROM vendedores WHERE conta_id = $1', [conta.id]);
    assert.strictEqual(v.length, 0, 'nenhum perfil de vendedor criado');
    await assert.rejects(() => convitesRepo.criar({ papeis: ['vendedor'] }), /papel/);
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
  }
});

test('ciclo pago de quem veio por cupom de vendedor não gera comissão nova', async () => {
  process.env.SAN_CHECKOUT_KEY = 'chave-de-teste-do-contratante';
  process.env.SAN_CHECKOUT_CONTRATANTE_ID = 'mostrai';
  process.env.SAN_CHECKOUT_BASE_URL = 'https://checkout.exemplo';
  process.env.SAN_CHECKOUT_API_URL = 'https://checkout.exemplo';
  const sanCheckout = require('../src/financeiro/san-checkout');
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const cupom = `VT${randomUUID().slice(0, 6).toUpperCase()}`;
  const vendedor = await criarConta({ papeis: '{anunciante,vendedor}' });
  const cliente = await criarConta({ indicado_por_cupom: cupom });
  try {
    await pool.query(
      `INSERT INTO vendedores (conta_id, codigo_cupom, status, comissao_percentual) VALUES ($1, $2, 'aprovado', 12)`,
      [vendedor.id, cupom],
    );
    const assinatura = await assinaturasRepo.criar({
      anuncianteId: cliente.id,
      planoId: 'essencial-1m',
      status: 'ativa',
    });
    await sanCheckout.aplicarCicloPago(assinatura, `teste-vendedor-${randomUUID()}`);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM comissoes WHERE anunciante_id = $1', [
      cliente.id,
    ]);
    assert.strictEqual(rows[0].n, 0);
    const { rows: pago } = await pool.query('SELECT plano_id FROM anunciantes WHERE id = $1', [cliente.id]);
    assert.strictEqual(pago[0].plano_id, 'essencial-1m', 'o ciclo pago em si continua aplicado');
  } finally {
    await apagarConta(cliente.id);
    await apagarConta(vendedor.id);
  }
});
