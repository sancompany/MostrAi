const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// Estação "Pagamentos / cancelamento ≠ estorno" (09/10/2026, ADR-046,
// migration 120). O que este arquivo prova:
//   · CANCELAR não estorna (não chama refund, não devolve, a cobrança segue
//     paga) — inclusive o caso REAL de produção: pagou → ativou → obrigação →
//     cancelou;
//   · ESTORNAR não cancela; só o Admin pede; janela de 7 dias no servidor;
//     só o webhook do PSP confirma; total desfaz o ciclo, parcial é só
//     dinheiro; idempotência e corridas;
//   · a desistência (art. 49) vira pedidos de estorno por cobrança e fecha
//     quando o PSP confirma; o "Registrar" manual saiu;
//   · o backfill da migration 120 casa a cobrança pelo significado.
process.env.SAN_CHECKOUT_KEY ||= 'chave-teste';
process.env.SAN_CHECKOUT_API_URL ||= 'https://checkout.exemplo';
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-estorno';
const app = require('../src/server');
const sc = require('../src/financeiro/san-checkout');
const estornos = require('../src/financeiro/estornos');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const vigencia = require('../src/lib/vigencia');

const PLANO = 'essencial-1m';
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const DIA = 24 * 3600 * 1000;

let base;
let servidor;
let admin;
const contas = [];

// O Checkout é simulado; o resto do fetch (o próprio servidor de teste) é
// real. Toda chamada ao Checkout fica registrada — é assim que se prova que
// nada chamou estorno.
const fetchReal = globalThis.fetch;
const chamadasCheckout = [];
globalThis.fetch = async (url, opcoes) => {
  const u = String(url);
  if (!u.startsWith(process.env.SAN_CHECKOUT_API_URL)) return fetchReal(url, opcoes);
  const rota = u.split('/api/checkout/')[1];
  chamadasCheckout.push(rota);
  if (rota === 'cancelar-assinatura') return { ok: true, status: 200, json: async () => ({ status: 'cancelada' }) };
  return { ok: false, status: 404, json: async () => ({}) };
};

function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo, extras = {}) {
    const cookie = [...potes.entries()]
      .filter(([, c]) => caminho.startsWith(c.path))
      .map(([nome, c]) => `${nome}=${c.valor}`)
      .join('; ');
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...(cookie ? { cookie } : {}), ...extras },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const caminhoCookie = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor: resto.join('='), path: caminhoCookie });
    }
    const texto = await r.text();
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    return { status: r.status, json, texto };
  };
}

async function criarConta() {
  const senha = 'Senha12@teste';
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, endereco, cidade, uf, cep)
     VALUES (now(), $1, '52998224725', $2, '16999990000', $3, ARRAY['anunciante'], true, 'Rua A, 1', 'Matão', 'SP', '15990000')
     RETURNING *`,
    [`Estorno ${randomUUID().slice(0, 8)}`, `estorno-${randomUUID()}@example.com`, await gerarHash(senha)],
  );
  contas.push(rows[0].id);
  const nav = navegador();
  return { ...rows[0], senha, nav };
}

async function entrar(conta) {
  const r = await conta.nav('POST', '/anunciantes/login', { email: conta.contato_email, senha: conta.senha });
  assert.equal(r.status, 200, `login do anunciante: ${r.texto}`);
}

const evento = (assinatura, conta, extras) => ({
  versao: 2,
  tipo: 'assinatura',
  eventoId: `evt_${randomUUID()}`,
  ocorridoEm: new Date().toISOString(),
  planoId: assinatura.id,
  documento: conta.cpf_cnpj,
  assinaturaId: `sub_${randomUUID().slice(0, 8)}`,
  statusFinanceiro: 'confirmado',
  ciclo: 'MONTHLY',
  cicloCanonico: 'mensal',
  metodoPagamento: 'assinatura',
  valorEstornado: null,
  estornoParcial: false,
  ...extras,
});

// Pagamento confirmado pelo PSP (webhook `criada` v2): o caminho real.
async function pagar(conta, { valor = 134.99, ocorridoEm = new Date().toISOString() } = {}) {
  const assinatura = await assinaturasRepo.criar({ anuncianteId: conta.id, planoId: PLANO });
  const chargeId = `pay_${randomUUID().slice(0, 12)}`;
  const criada = evento(assinatura, conta, { evento: 'criada', chargeId, valor, ocorridoEm });
  await sc.processarWebhookAssinatura(criada);
  const {
    rows: [cobranca],
  } = await pool.query('SELECT * FROM cobrancas_confirmadas WHERE charge_id = $1', [chargeId]);
  return { assinatura, chargeId, cobranca, criada };
}

async function estornoDoPsp(assinatura, conta, chargeId, extras) {
  const ev = evento(assinatura, conta, { evento: 'cobranca_estornada', chargeId, ...extras });
  await sc.processarWebhookAssinatura(ev);
  return ev;
}

const linha = async (sql, p) => (await pool.query(sql, p)).rows[0];
const linhas = async (sql, p) => (await pool.query(sql, p)).rows;

test.before(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  admin = navegador();
  const r = await admin('POST', '/admin/login', { usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD });
  assert.equal(r.status, 200, 'login do admin');
});

test.after(async () => {
  for (const id of contas) {
    await pool.query('DELETE FROM estornos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM arrependimentos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM obrigacoes_veiculacao WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [id]);
    await pool.query(
      `DELETE FROM webhooks_processados WHERE split_part(id, '|', 1) IN
         (SELECT charge_id FROM cobrancas_confirmadas WHERE anunciante_id = $1)`,
      [id],
    );
    await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
    await pool.query(
      "DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' IN (SELECT id FROM assinaturas WHERE anunciante_id = $1)",
      [id],
    );
    await pool.query("DELETE FROM eventos_assinatura_pendentes WHERE (payload->>'arrependimentoId') IS NOT NULL");
    await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  globalThis.fetch = fetchReal;
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// ---------------------------------------------------------------------------
// O caso REAL de produção (09/10/2026), como regressão
// ---------------------------------------------------------------------------
test('caso real: pagou → ativou → obrigação → CANCELOU: cobrança segue paga, sem estorno, sem refund (1, 2)', async () => {
  const conta = await criarConta();
  const pagoEm = new Date(Date.now() - 60_000).toISOString();
  const { assinatura, chargeId, cobranca } = await pagar(conta, { ocorridoEm: pagoEm });

  assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa', 'ciclo ativado');
  assert.equal(cobranca.status_financeiro, 'confirmado');
  assert.equal(Number(cobranca.valor), 134.99);
  assert.equal(cobranca.charge_id, chargeId, 'a cobrança sabe quem ela é no PSP');
  assert.equal(new Date(cobranca.pago_em).toISOString(), pagoEm, 'pago_em = confirmação no PSP (ocorridoEm)');
  assert.equal(cobranca.pago_em_fonte, 'psp');
  const obrig = await linhas(
    `SELECT o.tipo, o.segundos FROM obrigacoes_veiculacao o JOIN ciclos_contratados c ON c.id = o.ciclo_contratado_id
      WHERE c.cobranca_confirmada_id = $1`,
    [cobranca.id],
  );
  assert.equal(obrig.length, 1, 'uma obrigação do ciclo');
  assert.equal(obrig[0].tipo, 'ciclo');
  const antes = await linha('SELECT plano_id, data_expiracao, suspenso FROM anunciantes WHERE id = $1', [conta.id]);
  assert.equal(antes.plano_id, PLANO);

  await entrar(conta);
  chamadasCheckout.length = 0;
  const r = await conta.nav('POST', '/anunciantes/me/cancelar-assinatura');
  assert.equal(r.status, 200, r.texto);

  assert.deepEqual(chamadasCheckout, ['cancelar-assinatura'], 'cancelar chama SÓ o cancelamento — nenhum estorno');
  assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'cancelada', 'recorrência cancelada');
  const depois = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(depois.status_financeiro, 'confirmado', 'a cobrança continua PAGA');
  assert.equal(Number(depois.valor_estornado), 0, 'nada devolvido');
  assert.equal(Number(depois.valor), 134.99);
  assert.equal(
    (await linhas('SELECT 1 FROM estornos WHERE cobranca_id = $1', [cobranca.id])).length,
    0,
    'nenhum estorno',
  );
  assert.equal(
    (await linhas("SELECT 1 FROM obrigacoes_veiculacao WHERE anunciante_id = $1 AND tipo = 'reembolso'", [conta.id]))
      .length,
    0,
    'a obrigação do ciclo pago fica',
  );
  const contaDepois = await linha('SELECT plano_id, data_expiracao, suspenso FROM anunciantes WHERE id = $1', [
    conta.id,
  ]);
  assert.deepEqual(contaDepois, antes, 'a cobertura paga continua até o fim');
  assert.equal((await linhas('SELECT 1 FROM arrependimentos WHERE anunciante_id = $1', [conta.id])).length, 0);
});

// ---------------------------------------------------------------------------
// Quem pode estornar
// ---------------------------------------------------------------------------
test('anunciante (ou ninguém logado) não estorna; não há rota de estorno do cliente (4)', async () => {
  const conta = await criarConta();
  const { cobranca } = await pagar(conta);
  await entrar(conta);
  const pelaConta = await conta.nav('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    motivo: 'quero meu dinheiro',
  });
  assert.equal(pelaConta.status, 401, 'sessão de anunciante não é admin');
  const anonimo = await navegador()('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    motivo: 'sem login',
  });
  assert.equal(anonimo.status, 401);
  for (const rota of [
    '/anunciantes/me/estornar',
    '/anunciantes/me/estornos',
    `/anunciantes/me/cobrancas/${cobranca.id}/estorno`,
  ]) {
    assert.equal((await conta.nav('POST', rota, {})).status, 404, `${rota} não existe`);
  }
  assert.equal((await linhas('SELECT 1 FROM estornos WHERE cobranca_id = $1', [cobranca.id])).length, 0);
});

test('Admin estorna cobrança elegível: pedido com operador, motivo, valor; NÃO cancela; PSP confirma; total desfaz o ciclo (3, 5)', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  chamadasCheckout.length = 0;

  const r = await admin(
    'POST',
    `/admin/cobrancas/${cobranca.id}/estornos`,
    { tipo: 'ordinario', motivo: 'cliente pediu na primeira semana' },
    { 'cf-access-authenticated-user-email': 'operador@mostrai.test' },
  );
  assert.equal(r.status, 201, r.texto);
  assert.equal(r.json.status, 'solicitado', 'pedido, não devolução');
  assert.equal(Number(r.json.valor), 134.99, 'sem valor = o que falta (total)');
  assert.equal(r.json.solicitado_por, process.env.ADMIN_USER);
  assert.equal(r.json.solicitado_por_access, 'operador@mostrai.test');
  assert.equal(r.json.status_financeiro_antes, 'confirmado');
  assert.equal(r.json.psp_charge_id, chargeId);
  assert.deepEqual(chamadasCheckout, [], 'pedir estorno não chama o Checkout (nem cancela)');
  assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa', 'estornar NÃO cancela');
  let cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(cob.status_financeiro, 'confirmado', 'sem o PSP, nada foi devolvido');

  const ev = await estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 });
  cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(cob.status_financeiro, 'estornado');
  assert.equal(Number(cob.valor_estornado), 134.99);
  const e = await linha('SELECT * FROM estornos WHERE cobranca_id = $1', [cobranca.id]);
  assert.equal(e.status, 'confirmado');
  assert.equal(e.psp_evento_id, ev.eventoId);
  assert.equal(Number(e.valor_confirmado), 134.99);
  assert.equal(e.status_financeiro_depois, 'estornado');

  assert.equal(
    (await assinaturasRepo.buscarPorId(assinatura.id)).status,
    'ativa',
    'confirmar o estorno também não cancela',
  );
  const contaDepois = await linha('SELECT suspenso, data_expiracao FROM anunciantes WHERE id = $1', [conta.id]);
  assert.equal(contaDepois.suspenso, false, 'nem suspende');
  assert.ok(vigencia.coberturaVencida(contaDepois.data_expiracao), 'total: a cobertura do ciclo devolvido sai');
  const reembolso = await linhas(
    "SELECT segundos FROM obrigacoes_veiculacao WHERE anunciante_id = $1 AND tipo = 'reembolso'",
    [conta.id],
  );
  assert.equal(reembolso.length, 1, 'total: as horas do ciclo devolvido saem');
  assert.ok(Number(reembolso[0].segundos) < 0);
});

test('estorno parcial confirmado é só dinheiro: horas e cobertura iguais', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  const antes = await linha('SELECT data_expiracao FROM anunciantes WHERE id = $1', [conta.id]);
  const r = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    valor: 30,
    motivo: 'compensação por tela fora do ar',
  });
  assert.equal(r.status, 201, r.texto);
  await estornoDoPsp(assinatura, conta, chargeId, {
    statusFinanceiro: 'estornado_parcialmente',
    valorEstornado: 30,
    estornoParcial: true,
    valor: 134.99,
  });
  const cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(cob.status_financeiro, 'estornado_parcialmente');
  assert.equal(Number(cob.valor_estornado), 30);
  assert.equal((await linha('SELECT status FROM estornos WHERE cobranca_id = $1', [cobranca.id])).status, 'confirmado');
  assert.deepEqual(
    await linha('SELECT data_expiracao FROM anunciantes WHERE id = $1', [conta.id]),
    antes,
    'cobertura igual',
  );
  assert.equal(
    (await linhas("SELECT 1 FROM obrigacoes_veiculacao WHERE anunciante_id = $1 AND tipo = 'reembolso'", [conta.id]))
      .length,
    0,
    'horas iguais',
  );
});

// ---------------------------------------------------------------------------
// Janela de 7 dias — no servidor, pelo relógio do servidor
// ---------------------------------------------------------------------------
test('fora dos 7 dias: o servidor recusa o ordinário, a tela recebe "fora da janela", data no corpo não contorna (6, 7, 8)', async () => {
  const conta = await criarConta();
  const { cobranca } = await pagar(conta, { ocorridoEm: new Date(Date.now() - 8 * DIA).toISOString() });

  const lista = await admin('GET', '/admin/cobrancas');
  const minha = lista.json.find((c) => c.id === cobranca.id);
  assert.equal(minha.elegibilidade.ordinario.pode, false, 'a tela não recebe a ação ordinária');
  assert.equal(minha.elegibilidade.ordinario.motivo, 'Fora da janela de estorno pelo painel.');
  assert.equal(minha.elegibilidade.excepcional.pode, true, 'o excepcional é outro caminho');

  const r = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    motivo: 'tentando fora do prazo',
    pago_em: new Date().toISOString(),
    agora: new Date(Date.now() - 9 * DIA).toISOString(),
    prazoAte: new Date(Date.now() + DIA).toISOString(),
  });
  assert.equal(r.status, 409, 'campos de data no corpo são ignorados');
  assert.match(r.json.erro, /Fora da janela/);

  const exc = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'excepcional',
    motivo: 'cobrou em dobro',
  });
  assert.equal(exc.status, 400, 'excepcional exige categoria');
  const ok = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'excepcional',
    categoria: 'duplicidade',
    motivo: 'cobrou em dobro',
  });
  assert.equal(ok.status, 201, ok.texto);
  assert.equal(ok.json.categoria, 'duplicidade');

  // Dentro da janela, a tela recebe a ação.
  const outra = await criarConta();
  const { cobranca: nova } = await pagar(outra);
  const lista2 = await admin('GET', '/admin/cobrancas');
  const minha2 = lista2.json.find((c) => c.id === nova.id);
  assert.equal(minha2.elegibilidade.ordinario.pode, true);
  assert.ok(new Date(minha2.elegibilidade.prazoAte).getTime() > Date.now() + 6 * DIA);
});

test('janela pura: 7 dias corridos de pago_em, inclusive o último instante', () => {
  const pagoEm = new Date('2026-10-01T12:34:56Z');
  const c = {
    pago_em: pagoEm,
    valor: '134.99',
    valor_estornado: '0',
    status_financeiro: 'confirmado',
    charge_id: 'pay_x',
  };
  assert.equal(estornos.elegibilidade(c, { agora: new Date('2026-10-08T12:34:56Z') }).ordinario.pode, true);
  assert.equal(estornos.elegibilidade(c, { agora: new Date('2026-10-08T12:34:57Z') }).ordinario.pode, false);
  assert.equal(
    estornos.elegibilidade({ ...c, charge_id: null }).ordinario.pode,
    false,
    'sem chargeId não há como confirmar',
  );
  assert.equal(estornos.elegibilidade({ ...c, status_financeiro: 'contestado' }).excepcional.pode, false);
});

// ---------------------------------------------------------------------------
// Idempotência, limites, falha do PSP
// ---------------------------------------------------------------------------
test('pedido duplicado e aviso do PSP repetido não devolvem duas vezes (9, 10)', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  const pedir = () =>
    admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, { tipo: 'ordinario', motivo: 'duplo clique' });
  const [a, b] = await Promise.all([pedir(), pedir()]);
  assert.deepEqual([a.status, b.status].sort(), [201, 409], 'um pedido aberto por cobrança');

  const ev = await estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 });
  await sc.processarWebhookAssinatura(ev); // mesmo eventoId
  await estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 }); // outro aviso, mesmo fato
  const cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(Number(cob.valor_estornado), 134.99, 'o acumulado não passa do pago');
  const es = await linhas('SELECT status FROM estornos WHERE cobranca_id = $1', [cobranca.id]);
  assert.deepEqual(
    es.map((e) => e.status),
    ['confirmado'],
    'um estorno só',
  );
  assert.equal(
    (await linhas("SELECT 1 FROM obrigacoes_veiculacao WHERE anunciante_id = $1 AND tipo = 'reembolso'", [conta.id]))
      .length,
    1,
    'o ciclo é desfeito uma vez',
  );
  const depois = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'excepcional',
    categoria: 'duplicidade',
    motivo: 'de novo',
  });
  assert.equal(depois.status, 409, 'estornada por inteiro não aceita mais pedido');
});

test('webhook de confirmação duplicado não cria segunda cobrança nem segunda obrigação (10, 11)', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, criada } = await pagar(conta);
  await sc.processarWebhookAssinatura(criada); // mesmo evento
  await sc.processarWebhookAssinatura({ ...criada, eventoId: `evt_${randomUUID()}`, evento: 'cobranca_confirmada' }); // mesma cobrança, outro aviso
  assert.equal((await linhas('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [conta.id])).length, 1);
  assert.equal((await linhas('SELECT 1 FROM cobrancas_confirmadas WHERE charge_id = $1', [chargeId])).length, 1);
  assert.equal(
    (await linhas("SELECT 1 FROM obrigacoes_veiculacao WHERE anunciante_id = $1 AND tipo = 'ciclo'", [conta.id]))
      .length,
    1,
  );
  assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa');
});

test('valor acima do que pode voltar é recusado; cobrança inexistente é 404; corpo com outra conta é ignorado (17, 18, 19)', async () => {
  const conta = await criarConta();
  const outra = await criarConta();
  const { cobranca } = await pagar(conta);
  const acima = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    valor: 135,
    motivo: 'acima do pago',
  });
  assert.equal(acima.status, 400);
  assert.match(acima.json.erro, /maior que o que ainda pode voltar/);
  const centavo = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    valor: 10.001,
    motivo: 'três casas',
  });
  assert.equal(centavo.status, 400);
  const zero = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    valor: -5,
    motivo: 'negativo',
  });
  assert.equal(zero.status, 400);
  const semMotivo = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    motivo: '  ',
  });
  assert.equal(semMotivo.status, 400, 'motivo é obrigatório');

  assert.equal(
    (await admin('POST', '/admin/cobrancas/999999999/estornos', { tipo: 'ordinario', motivo: 'não existe' })).status,
    404,
  );
  assert.equal(
    (await admin('POST', '/admin/cobrancas/abc/estornos', { tipo: 'ordinario', motivo: 'id inválido' })).status,
    404,
  );

  const r = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    valor: 20,
    motivo: 'conta trocada no corpo',
    anunciante_id: outra.id,
    anuncianteId: outra.id,
  });
  assert.equal(r.status, 201);
  assert.equal(r.json.anunciante_id, conta.id, 'a conta é a da cobrança, nunca a do corpo');

  // E o anunciante de outra conta não enxerga esta cobrança.
  await entrar(outra);
  const fin = await outra.nav('GET', '/anunciantes/me/financeiro');
  assert.equal(fin.status, 200);
  assert.equal(fin.json.pagamentos.cobrancas.length, 0);
});

test('PSP não confirmou: o banco não diz que devolveu; cancelar o pedido não mexe no dinheiro (20)', async () => {
  const conta = await criarConta();
  const { cobranca } = await pagar(conta);
  const r = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
    tipo: 'ordinario',
    motivo: 'Asaas fora do ar',
  });
  assert.equal(r.status, 201);
  let cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(cob.status_financeiro, 'confirmado');
  assert.equal(Number(cob.valor_estornado), 0);
  assert.equal(
    (await admin('POST', `/admin/estornos/${r.json.id}/cancelar`, { motivo: '' })).status,
    400,
    'cancelar exige motivo',
  );
  const c = await admin('POST', `/admin/estornos/${r.json.id}/cancelar`, { motivo: 'não executado na Asaas' });
  assert.equal(c.status, 200);
  assert.equal(c.json.status, 'cancelado');
  assert.equal(c.json.cancelado_por, process.env.ADMIN_USER);
  cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(cob.status_financeiro, 'confirmado', 'cancelar o pedido não devolve nada');
  assert.equal((await admin('POST', `/admin/estornos/${r.json.id}/cancelar`, { motivo: 'de novo' })).status, 409);
  // Não há caminho para "marcar como devolvido" sem o PSP.
  assert.equal((await admin('POST', `/admin/estornos/${r.json.id}/confirmar`, {})).status, 404);
});

// ---------------------------------------------------------------------------
// Corridas
// ---------------------------------------------------------------------------
test('corrida cancelamento × estorno: os dois acontecem, nenhum dispara o outro (15)', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  await entrar(conta);
  chamadasCheckout.length = 0;
  const [cancelou, pediu] = await Promise.all([
    conta.nav('POST', '/anunciantes/me/cancelar-assinatura'),
    admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, { tipo: 'ordinario', motivo: 'corrida' }),
  ]);
  assert.equal(cancelou.status, 200);
  assert.equal(pediu.status, 201);
  assert.deepEqual(chamadasCheckout, ['cancelar-assinatura']);
  await estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 });
  assert.equal((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'cancelada');
  assert.equal((await linha('SELECT status FROM estornos WHERE cobranca_id = $1', [cobranca.id])).status, 'confirmado');
  assert.equal(
    (await linha('SELECT status_financeiro FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id])).status_financeiro,
    'estornado',
  );
});

test('corrida webhook × pedido: um estorno confirmado, nada em aberto, nada além do pago (16)', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  await Promise.all([
    admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, { tipo: 'ordinario', motivo: 'corrida com o PSP' }),
    estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 }),
  ]);
  const cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
  assert.equal(Number(cob.valor_estornado), 134.99);
  const es = await linhas('SELECT status FROM estornos WHERE cobranca_id = $1', [cobranca.id]);
  assert.equal(es.filter((e) => e.status === 'confirmado').length, 1);
  assert.equal(es.filter((e) => e.status === 'solicitado').length, 0);
});

test('corrida "cancelar pedido" × confirmação do PSP: um estado só, nunca cancelado e confirmado ao mesmo tempo', async () => {
  for (let i = 0; i < 4; i += 1) {
    const conta = await criarConta();
    const { assinatura, chargeId, cobranca } = await pagar(conta);
    const pedido = await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, {
      tipo: 'ordinario',
      motivo: 'corrida do cancelamento',
    });
    assert.equal(pedido.status, 201);
    const [cancelou] = await Promise.all([
      admin('POST', `/admin/estornos/${pedido.json.id}/cancelar`, { motivo: 'não vai ser feito' }),
      estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 }),
    ]);
    const es = await linhas('SELECT * FROM estornos WHERE cobranca_id = $1 ORDER BY id', [cobranca.id]);
    const oPedido = es.find((e) => e.id === pedido.json.id);
    if (cancelou.status === 200) {
      // Cancelado primeiro: o dinheiro voltou mesmo assim — entra como
      // devolução feita direto na Asaas, e o pedido fica cancelado.
      assert.equal(oPedido.status, 'cancelado');
      assert.equal(oPedido.psp_evento_id, null, 'cancelado não recebe a confirmação');
      assert.equal(es.filter((e) => e.tipo === 'externo' && e.status === 'confirmado').length, 1);
    } else {
      // Confirmado primeiro: cancelar chega tarde.
      assert.equal(cancelou.status, 409);
      assert.equal(oPedido.status, 'confirmado');
      assert.equal(oPedido.cancelado_em, null, 'confirmado não carrega cancelamento');
      assert.equal(es.length, 1);
    }
    const cob = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cobranca.id]);
    assert.equal(Number(cob.valor_estornado), 134.99, 'o dinheiro devolvido conta uma vez');
  }
});

test('estorno feito direto na Asaas, sem pedido: registrado como externo + pendência; chargeback marca contestada', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  await estornoDoPsp(assinatura, conta, chargeId, {
    statusFinanceiro: 'estornado_parcialmente',
    valorEstornado: 10,
    estornoParcial: true,
    valor: 134.99,
  });
  const e = await linha('SELECT * FROM estornos WHERE cobranca_id = $1', [cobranca.id]);
  assert.equal(e.tipo, 'externo');
  assert.equal(e.status, 'confirmado');
  assert.equal(Number(e.valor), 10);
  const pend = await linhas("SELECT motivo FROM eventos_assinatura_pendentes WHERE payload->>'chargeId' = $1", [
    chargeId,
  ]);
  assert.ok(pend.some((p) => /direto na Asaas/.test(p.motivo)));

  const conta2 = await criarConta();
  const pago2 = await pagar(conta2);
  await sc.processarWebhookAssinatura(
    evento(pago2.assinatura, conta2, {
      evento: 'cobranca_contestada',
      chargeId: pago2.chargeId,
      statusFinanceiro: 'chargeback',
    }),
  );
  assert.equal(
    (await linha('SELECT status_financeiro FROM cobrancas_confirmadas WHERE id = $1', [pago2.cobranca.id]))
      .status_financeiro,
    'contestado',
  );
  assert.equal(
    (await linhas('SELECT 1 FROM estornos WHERE cobranca_id = $1', [pago2.cobranca.id])).length,
    0,
    'chargeback não é estorno',
  );
  assert.equal(
    (await assinaturasRepo.buscarPorId(pago2.assinatura.id)).status,
    'ativa',
    'chargeback não cancela sozinho',
  );
});

// ---------------------------------------------------------------------------
// Preço, plano, retorno — nada vem do navegador
// ---------------------------------------------------------------------------
test('preço, plano e retorno de sucesso não ativam nada nem mudam o valor (12, 13, 14)', async () => {
  const conta = await criarConta();
  await entrar(conta);
  const inexistente = await conta.nav('POST', `/anunciantes/${conta.id}/assinar`, {
    planoId: 'plano-que-nao-existe',
    valor: 1,
  });
  assert.equal(inexistente.status, 400);
  const r = await conta.nav('POST', `/anunciantes/${conta.id}/assinar`, {
    planoId: PLANO,
    valor: 1,
    preco: 1,
    desconto: 100,
  });
  assert.equal(r.status, 200, r.texto);
  const assinaturaId = /[?&]assinatura=([^&]+)/.exec(r.json.checkoutUrl)[1];
  const plano = await fetch(`${base}/plano/${assinaturaId}`, {
    headers: { 'x-checkout-key': process.env.SAN_CHECKOUT_KEY },
  }).then((x) => x.json());
  const daConta = await linha('SELECT * FROM anunciantes WHERE id = $1', [conta.id]);
  const doPlano = await linha('SELECT * FROM planos WHERE id = $1', [PLANO]);
  const esperado =
    sc.valorMensalDaConta(daConta, doPlano, await assinaturasRepo.buscarPorId(assinaturaId)) *
    doPlano.compromisso_meses;
  assert.ok(plano.valor > 1, 'o valor do corpo (1) não chega ao Checkout');
  assert.equal(plano.valor, esperado, 'o Checkout cobra o valor calculado do banco');

  // Voltar pela página de "obrigado" (ou forjar um webhook sem assinatura) não ativa nada.
  assert.equal((await fetch(`${base}/obrigado.html?status=pago&assinatura=${assinaturaId}`)).status, 200);
  const forjado = await fetch(`${base}/webhook/san-checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(evento({ id: assinaturaId }, conta, { evento: 'criada', chargeId: 'pay_forjado', valor: 1 })),
  });
  assert.equal(forjado.status, 401);
  assert.equal((await assinaturasRepo.buscarPorId(assinaturaId)).status, 'pendente_pagamento');
  assert.equal((await linha('SELECT plano_id FROM anunciantes WHERE id = $1', [conta.id])).plano_id, null);
  assert.equal((await linhas('SELECT 1 FROM cobrancas_confirmadas WHERE anunciante_id = $1', [conta.id])).length, 0);
});

// ---------------------------------------------------------------------------
// Desistência (art. 49) pela trilha nova
// ---------------------------------------------------------------------------
test('desistência: cliente só pede; vira pedido de estorno por cobrança; fecha quando o PSP confirma; não repete', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  await entrar(conta);
  const consulta = await conta.nav('GET', '/titular/arrependimento');
  assert.equal(consulta.json.disponivel, true);
  assert.equal(consulta.json.valor_a_estornar, 134.99);

  chamadasCheckout.length = 0;
  const r = await conta.nav('POST', '/titular/arrependimento');
  assert.equal(r.status, 201, r.texto);
  assert.deepEqual(chamadasCheckout, ['cancelar-assinatura'], 'o cliente não aciona estorno no PSP');
  const pedido = await linha('SELECT * FROM estornos WHERE cobranca_id = $1', [cobranca.id]);
  assert.equal(pedido.tipo, 'desistencia');
  assert.equal(pedido.status, 'solicitado');
  assert.equal(pedido.arrependimento_id, r.json.pedido.id);
  assert.equal(Number(pedido.valor), 134.99);

  // O "Registrar" manual saiu; cancelar a devolução de desistência também não pode.
  assert.equal(
    (await admin('POST', `/admin/arrependimentos/${r.json.pedido.id}/estornado`, { comprovante: 'x' })).status,
    410,
  );
  assert.equal(
    (await admin('POST', `/admin/estornos/${pedido.id}/cancelar`, { motivo: 'não quero devolver' })).status,
    409,
  );

  await estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 });
  const arr = await linha('SELECT * FROM arrependimentos WHERE id = $1', [r.json.pedido.id]);
  assert.equal(arr.status, 'estornado', 'fecha quando o PSP confirma a última devolução');
  assert.equal(arr.comprovante, chargeId);
  assert.equal(
    (await linhas("SELECT 1 FROM obrigacoes_veiculacao WHERE anunciante_id = $1 AND tipo = 'reembolso'", [conta.id]))
      .length,
    1,
    'a reversão da desistência e a do estorno total são a mesma (não dobra)',
  );

  // Reativada por engano dentro da janela: a segunda desistência é barrada.
  await pool.query('UPDATE anunciantes SET suspenso = false WHERE id = $1', [conta.id]);
  await entrar(conta);
  const segunda = await conta.nav('POST', '/titular/arrependimento');
  assert.equal(segunda.status, 409);
});

test('desistência com cobrança sem chargeId: confirmar a outra NÃO fecha — ainda há dinheiro a voltar', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId } = await pagar(conta);
  // Uma cobrança antiga, sem identificador do PSP (antes da 120, sem match no backfill).
  await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status, pago_em, pago_em_fonte)
     VALUES ($1, $2, 50, 'pendente', now() - interval '1 hour', 'registro')`,
    [conta.id, PLANO],
  );
  await entrar(conta);
  const r = await conta.nav('POST', '/titular/arrependimento');
  assert.equal(r.status, 201, r.texto);
  const pend = await linhas(
    "SELECT motivo FROM eventos_assinatura_pendentes WHERE (payload->>'arrependimentoId')::int = $1",
    [r.json.pedido.id],
  );
  assert.ok(
    pend.some((p) => /sem chargeId/.test(p.motivo)),
    'a cobrança sem chargeId vira aviso pro Admin',
  );

  await estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 });
  const arr = await linha('SELECT status FROM arrependimentos WHERE id = $1', [r.json.pedido.id]);
  assert.equal(arr.status, 'pendente', 'R$ 50 ainda não voltaram: a desistência continua aberta');
});

test('desistência com duas cobranças confirmadas AO MESMO TEMPO pela Asaas: fecha (nenhuma espera a outra pra sempre)', async () => {
  for (let i = 0; i < 8; i += 1) {
    const conta = await criarConta();
    const { assinatura, chargeId } = await pagar(conta);
    const segunda = `pay_${randomUUID().slice(0, 12)}`;
    await pool.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, nota_fiscal_status, charge_id, pago_em, pago_em_fonte)
       VALUES ($1, $2, 50, 'pendente', $3, now() - interval '1 hour', 'psp')`,
      [conta.id, PLANO, segunda],
    );
    await entrar(conta);
    const r = await conta.nav('POST', '/titular/arrependimento');
    assert.equal(r.status, 201, r.texto);
    // Direto no domínio (o caminho do webhook tem mais passos antes e
    // raramente sobrepõe as duas transações): é a sobreposição que se testa.
    await Promise.all([
      estornos.registrarEstornoDoPsp(
        evento(assinatura, conta, {
          evento: 'cobranca_estornada',
          chargeId,
          statusFinanceiro: 'estornado',
          valor: 134.99,
        }),
      ),
      estornos.registrarEstornoDoPsp(
        evento(assinatura, conta, {
          evento: 'cobranca_estornada',
          chargeId: segunda,
          statusFinanceiro: 'estornado',
          valor: 50,
        }),
      ),
    ]);
    const arr = await linha('SELECT status, comprovante FROM arrependimentos WHERE id = $1', [r.json.pedido.id]);
    assert.equal(arr.status, 'estornado', `rodada ${i}: as duas devoluções confirmadas fecham a desistência`);
    assert.equal(arr.comprovante.split(', ').length, 2);
  }
});

test('desistência quando tudo já foi estornado: nada a voltar, fecha na hora', async () => {
  const conta = await criarConta();
  const { assinatura, chargeId, cobranca } = await pagar(conta);
  await admin('POST', `/admin/cobrancas/${cobranca.id}/estornos`, { tipo: 'ordinario', motivo: 'pediu na semana' });
  await estornoDoPsp(assinatura, conta, chargeId, { statusFinanceiro: 'estornado', valor: 134.99 });
  await entrar(conta);
  assert.equal((await conta.nav('GET', '/titular/arrependimento')).json.valor_a_estornar, 0);
  const r = await conta.nav('POST', '/titular/arrependimento');
  assert.equal(r.status, 201, r.texto);
  assert.equal(
    (await linha('SELECT status FROM arrependimentos WHERE id = $1', [r.json.pedido.id])).status,
    'estornado',
  );
  assert.equal(
    (await linhas("SELECT 1 FROM estornos WHERE tipo = 'desistencia' AND anunciante_id = $1", [conta.id])).length,
    0,
  );
});

// ---------------------------------------------------------------------------
// Backfill da migration 120 — pelo significado, nunca por id
// ---------------------------------------------------------------------------
test('migration 120: backfill casa chargeId/ocorridoEm só com webhook único, assinado, mesmo valor e mesma hora', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/120_estornos.sql'), 'utf8');
  const backfill = sql.slice(
    sql.indexOf('WITH candidatos AS'),
    sql.indexOf('UPDATE cobrancas_confirmadas SET pago_em = criado_em'),
  );
  assert.match(backfill, /^WITH candidatos AS[\s\S]+NOT EXISTS[\s\S]+;\s*$/);

  const conta = await criarConta();
  const assinatura = await assinaturasRepo.criar({ anuncianteId: conta.id, planoId: PLANO });
  const chargeId = `pay_bf_${randomUUID().slice(0, 8)}`;
  const ocorridoEm = '2026-10-01T12:34:56.000Z';
  // Como estava em produção antes da 120: cobrança sem chargeId, ciclo da assinatura, webhook processado, chave na dedupe.
  const {
    rows: [cob],
  } = await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, criado_em, pago_em)
     VALUES ($1, $2, 134.99, now(), now()) RETURNING *`,
    [conta.id, PLANO],
  );
  await pool.query(
    `INSERT INTO ciclos_contratados (anunciante_id, plano_id, assinatura_id, cobranca_confirmada_id, origem, ciclo_meses,
                                     valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
     VALUES ($1, $2, $3, $4, 'compra', 1, 134.99, 10, 10)`,
    [conta.id, PLANO, assinatura.id, cob.id],
  );
  const payload = evento(assinatura, conta, { evento: 'criada', chargeId, valor: 134.99, ocorridoEm });
  await pool.query(
    `INSERT INTO webhooks_recebidos (chave, tipo, evento, payload, status, recebido_em, processado_em)
     VALUES ($1, 'assinatura', 'criada', $2, 'processado', now() - interval '70 milliseconds', now())`,
    [`evento:${payload.eventoId}`, payload],
  );
  await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1)', [`${chargeId}|confirmado`]);
  // Outra cobrança, de valor diferente, que NÃO pode casar com o mesmo webhook.
  const {
    rows: [outra],
  } = await pool.query(
    `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, criado_em, pago_em)
     VALUES ($1, $2, 99.90, now(), now()) RETURNING *`,
    [conta.id, PLANO],
  );
  try {
    await pool.query(backfill);
    const depois = await linha('SELECT * FROM cobrancas_confirmadas WHERE id = $1', [cob.id]);
    assert.equal(depois.charge_id, chargeId);
    assert.equal(new Date(depois.pago_em).toISOString(), ocorridoEm);
    assert.equal(depois.pago_em_fonte, 'psp');
    assert.equal(depois.status_financeiro, 'confirmado', 'a migration não interpreta nada como estorno');
    assert.equal(Number(depois.valor), 134.99);
    const intacta = await linha('SELECT charge_id, pago_em_fonte FROM cobrancas_confirmadas WHERE id = $1', [outra.id]);
    assert.equal(intacta.charge_id, null, 'sem casamento, não adivinha');
    assert.equal(intacta.pago_em_fonte, 'registro');
    await pool.query(backfill);
    assert.equal(
      (await linha('SELECT charge_id FROM cobrancas_confirmadas WHERE id = $1', [cob.id])).charge_id,
      chargeId,
      'idempotente',
    );
  } finally {
    await pool.query('DELETE FROM webhooks_recebidos WHERE chave = $1', [`evento:${payload.eventoId}`]);
  }
});

test('migration 120: um webhook que descreve DUAS cobranças não casa nenhuma (nem aborta pelo índice único)', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../src/db/migrations/120_estornos.sql'), 'utf8');
  const backfill = sql.slice(
    sql.indexOf('WITH candidatos AS'),
    sql.indexOf('UPDATE cobrancas_confirmadas SET pago_em = criado_em'),
  );
  const conta = await criarConta();
  const assinatura = await assinaturasRepo.criar({ anuncianteId: conta.id, planoId: PLANO });
  const chargeId = `pay_bf2_${randomUUID().slice(0, 8)}`;
  const ids = [];
  // Duas cobranças iguais da mesma assinatura, gravadas no mesmo instante.
  for (let i = 0; i < 2; i += 1) {
    const {
      rows: [c],
    } = await pool.query(
      `INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor, criado_em, pago_em)
       VALUES ($1, $2, 134.99, now(), now()) RETURNING id`,
      [conta.id, PLANO],
    );
    await pool.query(
      `INSERT INTO ciclos_contratados (anunciante_id, plano_id, assinatura_id, cobranca_confirmada_id, origem, ciclo_meses,
                                       valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
       VALUES ($1, $2, $3, $4, 'compra', 1, 134.99, 10, 10)`,
      [conta.id, PLANO, assinatura.id, c.id],
    );
    ids.push(c.id);
  }
  const payload = evento(assinatura, conta, { evento: 'criada', chargeId, valor: 134.99 });
  await pool.query(
    `INSERT INTO webhooks_recebidos (chave, tipo, evento, payload, status, recebido_em, processado_em)
     VALUES ($1, 'assinatura', 'criada', $2, 'processado', now(), now())`,
    [`evento:${payload.eventoId}`, payload],
  );
  await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1)', [`${chargeId}|confirmado`]);
  try {
    await pool.query(backfill);
    const depois = await linhas('SELECT charge_id FROM cobrancas_confirmadas WHERE id = ANY($1)', [ids]);
    assert.deepEqual(
      depois.map((d) => d.charge_id),
      [null, null],
      'ambíguo: não adivinha qual das duas',
    );
  } finally {
    await pool.query('DELETE FROM webhooks_recebidos WHERE chave = $1', [`evento:${payload.eventoId}`]);
  }
});
