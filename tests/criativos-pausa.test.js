require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const criativosRepo = require('../src/anunciantes/criativos-repository');

// Pausar / retomar a própria peça (finalização, 28/09/2026, migration 109):
// o cliente pausa e retoma o que ele pausou; o que o admin retirou (ou a
// substituição retirou) não volta pela mão dele; retomar respeita o limite
// de peças ativas do plano.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-pausa', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/admin/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, conta, corpo) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json', ...(conta ? { 'x-conta': String(conta) } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function conta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              email_confirmado, plano_id, data_inicio_cobertura, data_expiracao)
     VALUES (now(), $1, '11144477735', $2, '16999990000', 'x', true, 'essencial-1m', now(), now() + interval '20 days')
     RETURNING *`,
    [`Pausa ${randomUUID().slice(0, 6)}`, `pausa-${randomUUID()}@example.com`],
  );
  return rows[0];
}

async function peca(contaId, status) {
  const c = await criativosRepo.criar({
    anunciante_id: contaId,
    arquivo_original_url: 'x.png',
    arquivo_normalizado_url: `https://exemplo.test/pausa-${randomUUID()}.png`,
    thumbnail_url: null,
    duracao_segundos: 10,
  });
  if (status !== 'pendente') await criativosRepo.atualizar(c.id, { status });
  return c;
}

const situacao = async (id) => {
  const { rows } = await pool.query('SELECT status, retirado_por FROM criativos WHERE id = $1', [id]);
  return rows[0];
};

const contas = [];
test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes(); // métrica grava solta; espera terminar antes de apagar
  for (const id of contas) {
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

test('pausar e retomar a própria peça: retirado_por = cliente vai e volta, situação "pausado" no painel', async () => {
  const app = await subirApp();
  const c = await conta();
  contas.push(c.id);
  try {
    const a = await peca(c.id, 'aprovado');
    let r = await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/pausar`, c.id);
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.deepEqual(await situacao(a.id), { status: 'retirado', retirado_por: 'cliente' });
    const lista = await app.chamar('GET', '/anunciantes/me/criativos', c.id);
    const noPainel = lista.corpo.criativos.find((x) => x.id === a.id);
    assert.equal(noPainel.situacao, 'pausado');
    assert.equal(noPainel.retiradaPor, 'cliente');

    r = await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/pausar`, c.id);
    assert.equal(r.status, 409, 'pausar de novo não é aprovada');

    r = await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/retomar`, c.id);
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.deepEqual(await situacao(a.id), { status: 'aprovado', retirado_por: null });

    // Pendente não se pausa; peça de outra conta é 404 (nem diz que existe).
    const pendente = await peca(c.id, 'pendente');
    assert.equal((await app.chamar('POST', `/anunciantes/me/criativos/${pendente.id}/pausar`, c.id)).status, 409);
    const outra = await conta();
    contas.push(outra.id);
    assert.equal((await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/pausar`, outra.id)).status, 404);
    assert.equal((await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/retomar`, outra.id)).status, 404);
  } finally {
    await app.fechar();
  }
});

test('retomar respeita o limite de peças ativas do plano', async () => {
  const app = await subirApp();
  const c = await conta();
  contas.push(c.id);
  try {
    const { rows } = await pool.query("SELECT limite_criativos FROM planos WHERE id = 'essencial-1m'");
    const limite = rows[0].limite_criativos;
    const a = await peca(c.id, 'aprovado');
    assert.equal((await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/pausar`, c.id)).status, 200);
    // Enquanto A está pausada, o plano fica cheio com outras peças.
    for (let i = 0; i < limite; i += 1) await peca(c.id, 'aprovado');
    const r = await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/retomar`, c.id);
    assert.equal(r.status, 409);
    assert.match(r.corpo.erro, /pause ou exclua outra peça/);
    assert.deepEqual(await situacao(a.id), { status: 'retirado', retirado_por: 'cliente' }, 'continua pausada');
  } finally {
    await app.fechar();
  }
});

test('o que o admin retirou não volta pela mão do cliente; "Colocar no ar" do admin limpa a marca', async () => {
  const app = await subirApp();
  const c = await conta();
  contas.push(c.id);
  try {
    const a = await peca(c.id, 'aprovado');
    let r = await app.chamar('PATCH', `/admin/criativos/${a.id}`, null, { status: 'retirado' });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.deepEqual(await situacao(a.id), { status: 'retirado', retirado_por: 'admin' });
    const lista = await app.chamar('GET', '/anunciantes/me/criativos', c.id);
    const noPainel = lista.corpo.criativos.find((x) => x.id === a.id);
    assert.equal(noPainel.situacao, 'fora_do_ar');
    assert.equal(noPainel.retiradaPor, 'admin');

    r = await app.chamar('POST', `/anunciantes/me/criativos/${a.id}/retomar`, c.id);
    assert.equal(r.status, 409);
    assert.match(r.corpo.erro, /não foi pausada por você/);

    r = await app.chamar('PATCH', `/admin/criativos/${a.id}`, null, { status: 'aprovado' });
    assert.equal(r.status, 200);
    assert.deepEqual(await situacao(a.id), { status: 'aprovado', retirado_por: null });
  } finally {
    await app.fechar();
  }
});

test('a substituição aprovada marca o original como retirado pela substituição', async () => {
  const app = await subirApp();
  const c = await conta();
  contas.push(c.id);
  try {
    const original = await peca(c.id, 'aprovado');
    const nova = await criativosRepo.criar({
      anunciante_id: c.id,
      arquivo_original_url: 'y.png',
      arquivo_normalizado_url: `https://exemplo.test/pausa-${randomUUID()}.png`,
      thumbnail_url: null,
      duracao_segundos: 10,
      substitui_criativo_id: original.id,
    });
    const r = await app.chamar('PATCH', `/admin/criativos/${nova.id}`, null, { status: 'aprovado' });
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    assert.deepEqual(await situacao(original.id), { status: 'retirado', retirado_por: 'substituicao' });
    assert.deepEqual(await situacao(nova.id), { status: 'aprovado', retirado_por: null });
    const lista = await app.chamar('GET', '/anunciantes/me/criativos', c.id);
    assert.equal(lista.corpo.criativos.find((x) => x.id === original.id).retiradaPor, 'substituicao');
    assert.equal((await app.chamar('POST', `/anunciantes/me/criativos/${original.id}/retomar`, c.id)).status, 409);
  } finally {
    await app.fechar();
  }
});
