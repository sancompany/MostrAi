require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const vigencia = require('../src/lib/vigencia');

// Estação mestre de finalização (28/09/2026) — auditoria lógica ponta a
// ponta. Cada teste aqui nasceu de um achado reproduzido antes da correção:
//   · FIN-01 ciclo pago não tira a suspensão (chargeback, admin, arrependimento);
//   · FIN-02 cancelar e assinar OUTRO plano não empilha os dias restantes;
//   · FIN-06 custo por exibição prevista sem snapshot do plano atual: cai no
//     snapshot calculado do plano, não em "-";
//   · CRI-01 criativo retirado não ocupa vaga;
//   · CRI-03 substituto recusado e depois aprovado retira o original;
//   · CRI-05 teto de cadastro conta os retirados — 3º substituto recusado;
//     excluir um retirado libera (revisão Codex do PR #88);
//   · CTA-01 conta excluída perde as outras sessões;
//   · POP-02 criativoId fora do int4 não derruba o lote de comprovantes.

process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-teste';
process.env.SAN_CHECKOUT_API_URL = process.env.SAN_CHECKOUT_API_URL || 'https://checkout.exemplo';
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const cicloContratado = require('../src/financeiro/ciclo-contratado');

async function subirApp(montar) {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-finalizacao', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-admin'] === '1') {
      req.session.isAdmin = true;
      req.session.adminUsuario = 'admin-teste';
    }
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  montar(app);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo, cabecalhos = { 'x-admin': '1' }) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...cabecalhos },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, base, fechar: () => new Promise((r) => server.close(r)) };
}

async function criarConta(extra = {}) {
  const campos = {
    nome_empresa: `Final ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
    contato_email: `final-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    email_confirmado: true,
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
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
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const t of [
    'eventos',
    'notificacoes',
    'planos_administrativos',
    'ciclos_contratados',
    'criativos',
    'cobrancas_confirmadas',
    'email_outbox',
  ]) {
    await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]);
  }
  await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1 OR origem_conta_id = $1', [id]);
  await pool.query(
    "DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' IN (SELECT id FROM assinaturas WHERE anunciante_id = $1)",
    [id],
  );
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

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

const daqui = (dias) => vigencia.somarDias(vigencia.hojeComercial(), dias);

// Um ciclo pago pelo mesmo caminho do webhook/conciliação.
async function pagar(contaId, planoId, { status = 'ativa' } = {}) {
  const assinatura = await assinaturasRepo.criar({ anuncianteId: contaId, planoId, status });
  await sc.aplicarCicloPago(await assinaturasRepo.buscarPorId(assinatura.id), `final-${randomUUID()}`);
  return assinatura;
}

// ---------------------------------------------------------------------------
// FIN-01
// ---------------------------------------------------------------------------
test('FIN-01: ciclo pago não tira a suspensão — chargeback/admin/arrependimento só o admin desfaz', async () => {
  const conta = await criarConta();
  try {
    await pagar(conta.id, 'essencial-1m');
    assert.strictEqual((await anunciantesRepo.buscarPorId(conta.id)).suspenso, false, 'controle: conta normal');
    // Chargeback suspendeu (cobranca_contestada). A assinatura na Asaas segue
    // cobrando: a renovação do mês seguinte chega.
    await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [conta.id]);
    await pagar(conta.id, 'essencial-1m');
    const depois = await anunciantesRepo.buscarPorId(conta.id);
    assert.strictEqual(depois.suspenso, true, 'a renovação não reativa uma conta suspensa');
    assert.strictEqual(depois.plano_id, 'essencial-1m', 'o ciclo pago continua contado (o dinheiro entrou)');
    const { rows: pend } = await pool.query(
      `SELECT motivo FROM eventos_assinatura_pendentes
        WHERE NOT resolvido AND payload->>'planoId' IN (SELECT id FROM assinaturas WHERE anunciante_id = $1)`,
      [conta.id],
    );
    assert.ok(
      pend.some((p) => /suspensa/i.test(p.motivo)),
      `ciclo pago em conta suspensa vira pendência pra alguém olhar: ${JSON.stringify(pend)}`,
    );
  } finally {
    await apagarConta(conta.id);
  }
});

// ---------------------------------------------------------------------------
// FIN-02
// ---------------------------------------------------------------------------
test('FIN-02: cancelar e assinar OUTRO plano não empilha os dias já pagos no plano novo', async () => {
  const financeiro = require('../src/financeiro/routes');
  const app = await subirApp((a) => a.use(financeiro.router));
  const conta = await criarConta();
  try {
    // Essencial anual pago: 12 meses de cobertura.
    const anual = await pagar(conta.id, 'essencial-12m');
    const antes = await anunciantesRepo.buscarPorId(conta.id);
    assert.ok(vigencia.coberturaVigente(antes.data_expiracao));
    await assinaturasRepo.marcarCancelada(anual.id);

    // Rota: assinar Prime mensal com cobertura paga de outro plano em vigor
    // não gera link — o cliente vê o motivo e o caminho.
    const r = await app.chamar(
      'POST',
      `/anunciantes/${conta.id}/assinar`,
      { planoId: 'maximo-1m' },
      { 'x-conta': String(conta.id) },
    );
    assert.strictEqual(r.status, 409, JSON.stringify(r.corpo));
    assert.match(r.corpo.erro, /vale até/i);
    assert.strictEqual(
      await assinaturasRepo.buscarPendenteDePagamento(conta.id, 'maximo-1m'),
      null,
      'nenhum link criado',
    );

    // Mesmo plano (renovação antecipada) continua liberado.
    const mesmo = await app.chamar(
      'POST',
      `/anunciantes/${conta.id}/assinar`,
      { planoId: 'essencial-12m' },
      { 'x-conta': String(conta.id) },
    );
    assert.strictEqual(mesmo.status, 200, JSON.stringify(mesmo.corpo));

    // Defesa em profundidade no crédito do ciclo: se um pagamento de OUTRO
    // plano entrar mesmo assim, a cobertura começa hoje, não no fim da antiga.
    await pagar(conta.id, 'maximo-1m');
    const depois = await anunciantesRepo.buscarPorId(conta.id);
    assert.strictEqual(depois.plano_id, 'maximo-1m');
    const limite = vigencia.somarDias(vigencia.hojeComercial(), 32);
    assert.ok(
      String(vigencia.diaTexto ? vigencia.diaTexto(depois.data_expiracao) : depois.data_expiracao).slice(0, 10) <=
        limite,
      `Prime mensal vale ~1 mês a partir de hoje, não 13: ${depois.data_expiracao}`,
    );
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
  }
});

// ---------------------------------------------------------------------------
// FIN-06
// ---------------------------------------------------------------------------
test('FIN-06: custo por exibição prevista sem snapshot do plano atual usa o cálculo do plano, não "-"', async () => {
  const conta = await criarConta({
    plano_id: 'destaque-3m',
    data_inicio_cobertura: daqui(-10),
    data_expiracao: daqui(80),
  });
  try {
    // Snapshot só do plano ANTERIOR (troca feita antes da migration 087).
    await pool.query(
      `INSERT INTO ciclos_contratados (anunciante_id, plano_id, origem, ciclo_meses, valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
       VALUES ($1, 'essencial-1m', 'compra', 1, 149, 1000, 1000)`,
      [conta.id],
    );
    const s = await cicloContratado.situacaoDoCusto(await anunciantesRepo.buscarPorId(conta.id));
    assert.strictEqual(s.tipo, 'pago', JSON.stringify(s));
    assert.ok(s.custoPorExibicaoPrevista > 0, 'tem número');
    assert.match(s.plano, /Pro/, 'o custo é do plano em vigor (Pro · Trimestral), não do Essencial antigo');
    assert.strictEqual(s.aproximado, true, 'marcado como calculado, não contratado');
  } finally {
    await apagarConta(conta.id);
  }
});

// ---------------------------------------------------------------------------
// CRI-01 / CRI-03
// ---------------------------------------------------------------------------
test('CRI-01: criativo retirado não ocupa vaga — Essencial (1) depois da substituição segue com 1 de 1', async () => {
  const conta = await criarConta({ plano_id: 'essencial-1m', data_expiracao: daqui(30) });
  try {
    await criativo(conta.id, { status: 'retirado' });
    await criativo(conta.id, { status: 'aprovado' });
    assert.strictEqual(await criativosRepo.contarNaoReprovados(conta.id), 1);
  } finally {
    await apagarConta(conta.id);
  }
});

test('CRI-03: substituto recusado e depois aprovado retira o original no mesmo gesto', async () => {
  const admin = require('../src/admin/routes');
  const app = await subirApp((a) => a.use(admin));
  // Com categoria: peça da fila sem ela não se aprova (migration 121).
  const {
    rows: [academia],
  } = await pool.query(`SELECT id FROM categorias WHERE nome = 'Academia'`);
  const conta = await criarConta({ plano_id: 'essencial-1m', data_expiracao: daqui(30), categoria_id: academia.id });
  try {
    const a = await criativo(conta.id);
    const b = await criativo(conta.id, { status: 'pendente', substitui_criativo_id: a.id });
    await app.chamar('PATCH', `/admin/criativos/${b.id}`, { status: 'reprovado', motivo_reprovacao: 'x' });
    assert.strictEqual((await criativosRepo.buscarPorId(a.id)).status, 'aprovado', 'recusar B não mexe em A');
    const r = await app.chamar('PATCH', `/admin/criativos/${b.id}`, { status: 'aprovado' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await criativosRepo.buscarPorId(b.id)).status, 'aprovado');
    assert.strictEqual(
      (await criativosRepo.buscarPorId(a.id)).status,
      'retirado',
      'A sai do ar: nunca dois no ar pela troca',
    );
  } finally {
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [conta.id]);
    await app.fechar();
    await apagarConta(conta.id);
  }
});

// ---------------------------------------------------------------------------
// CRI-05
// ---------------------------------------------------------------------------
// Vaga do plano ≠ teto de cadastro (revisão Codex do PR #88, 28/09/2026):
// o retirado não ocupa vaga (CRI-01), mas continua guardado — e a
// substituição pula o limite do plano, então cada troca deixava mais um
// retirado sem teto nenhum. O teto de cadastro (CRIATIVOS_POR_CONTA) conta
// os retirados e vale pra substituição também.
test('CRI-05: teto de cadastro conta os retirados — 3º substituto recusado; excluir um retirado libera', async () => {
  const { CRIATIVOS_POR_CONTA } = require('../src/lib/limites');
  const anunciantes = require('../src/anunciantes/routes');
  const app = await subirApp((a) => a.use(anunciantes.router));
  const conta = await criarConta({ plano_id: 'essencial-1m', data_expiracao: daqui(30) });
  try {
    // Duas trocas já feitas: A e B retirados, C no ar. 3 cadastrados, 1 de 1.
    const a = await criativo(conta.id, { status: 'retirado' });
    await criativo(conta.id, { status: 'retirado' });
    const c = await criativo(conta.id, { status: 'aprovado' });
    assert.strictEqual(await criativosRepo.contarCadastrados(conta.id), 3, 'retirado conta como cadastrado');
    assert.strictEqual(await criativosRepo.contarNaoReprovados(conta.id), 1, 'mas não ocupa vaga do plano');

    // A recusa acontece antes do ffmpeg: qualquer arquivo serve.
    const substituir = async () => {
      const form = new FormData();
      form.append('substitui', String(c.id));
      form.append('arquivo', new Blob([Buffer.from('peca-de-teste')], { type: 'video/mp4' }), 'peca.mp4');
      const r = await fetch(`${app.base}/anunciantes/${conta.id}/criativos`, {
        method: 'POST',
        headers: { 'x-conta': String(conta.id) },
        body: form,
      });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    };
    const recusado = await substituir();
    assert.strictEqual(recusado.status, 400, JSON.stringify(recusado.corpo));
    assert.match(recusado.corpo.erro, /cadastrados/, `terceiro substituto esbarra no teto de ${CRIATIVOS_POR_CONTA}`);
    assert.strictEqual(await criativosRepo.contarCadastrados(conta.id), 3, 'nada criado');

    // Excluir um retirado libera o teto: o mesmo POST passa da trava (pode
    // falhar adiante por arquivo inválido — só não é mais o 400 do teto).
    await criativosRepo.deletar(a.id);
    assert.strictEqual(await criativosRepo.contarCadastrados(conta.id), 2);
    const liberado = await substituir();
    assert.ok(
      !(liberado.status === 400 && /cadastrados/.test(liberado.corpo?.erro || '')),
      `com 2 cadastrados o teto não barra: ${liberado.status} ${JSON.stringify(liberado.corpo)}`,
    );
  } finally {
    await app.fechar();
    await apagarConta(conta.id);
  }
});

// ---------------------------------------------------------------------------
// CTA-01
// ---------------------------------------------------------------------------
test('CTA-01: conta excluída perde a sessão que ficou aberta em outro aparelho', async () => {
  const { derrubarSessaoSuspensa } = require('../src/anunciantes/routes');
  const conta = await criarConta({ excluido_em: new Date() });
  try {
    const req = { session: { anuncianteId: conta.id } };
    await new Promise((r) => derrubarSessaoSuspensa(req, {}, r));
    assert.strictEqual(req.session.anuncianteId, undefined, 'sessão derrubada');
  } finally {
    await apagarConta(conta.id);
  }
});

// ---------------------------------------------------------------------------
// POP-02
// ---------------------------------------------------------------------------
test('POP-02: criativoId fora do int4 no comprovante não derruba o lote (nem vira 500)', async () => {
  const gerador = require('../src/playlist/gerador');
  // Só a validação do id: fora do alcance do int4 responde false sem ir ao banco.
  const db = {
    query: async () => {
      throw new Error('não deveria consultar o banco com id inválido');
    },
  };
  assert.strictEqual(await gerador.marcarExibicaoDoCriativo('3000000000', 1, new Date(), db), false);
  assert.strictEqual(await gerador.marcarExibicaoDoCriativo('2147483648', 1, new Date(), db), false);
});
