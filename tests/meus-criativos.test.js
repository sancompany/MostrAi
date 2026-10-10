require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');

// "Meus criativos" (Fatia 3 do painel único): a situação de cada peça sai do
// mesmo motor da ficha do admin (no ar = aprovada, arquivo pronto, dentro do
// limite do plano) e a substituição pelo próprio cliente só vale pra peça
// aprovada, uma substituta por vez.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-criativos', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    chamar: async (metodo, caminho, conta, corpo) => {
      const r = await fetch(`${base}${caminho}`, {
        method: metodo,
        headers: { 'x-conta': String(conta) },
        body: corpo,
      });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    fechar: () => new Promise((r) => server.close(r)),
  };
}

async function criarConta() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, plano_id, data_inicio_cobertura, data_expiracao)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante'], true, 'essencial-1m', now(), now() + interval '20 days')
     RETURNING *`,
    [
      `MC ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `mc-${randomUUID()}@example.com`,
    ],
  );
  return rows[0];
}

async function criativo(contaId, status, { dias = 0, substitui = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos, status,
                            substitui_criativo_id, created_at)
     VALUES ($1, 'x.mp4', '/x.mp4', 10, $2, $3, now() - ($4 || ' days')::interval) RETURNING id`,
    [contaId, status, substitui, String(dias)],
  );
  return rows[0].id;
}

async function limpar(contaId) {
  await pool.query('UPDATE criativos SET substitui_criativo_id = NULL WHERE anunciante_id = $1', [contaId]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [contaId]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
}

test('situação de cada peça: no ar, aprovada fora do rodízio, em análise substituindo, recusada, fora do ar', async () => {
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const antiga = await criativo(conta.id, 'aprovado', { dias: 3 });
    const noAr = await criativo(conta.id, 'aprovado');
    const substituta = await criativo(conta.id, 'pendente', { substitui: noAr });
    const recusada = await criativo(conta.id, 'reprovado');
    const retirada = await criativo(conta.id, 'retirado');
    // Aprovada e no rodízio ainda NÃO é "no ar" (27/09/2026): sem
    // comprovante, a situação é a da entrada (programado/aprovado).
    const antes = await app.chamar('GET', '/anunciantes/me/criativos', conta.id);
    const semComprovante = antes.corpo.criativos.find((c) => c.id === noAr);
    assert.notEqual(semComprovante.situacao, 'no_ar', 'aprovar não põe no ar');
    assert.ok(semComprovante.entrada, 'a peça aprovada vem com a entrada no ar calculada');
    // Exibição confirmada pela TV (o que confirmarExecucao grava).
    await pool.query('UPDATE criativos SET primeira_exibicao_em = now(), ultima_exibicao_em = now() WHERE id = $1', [
      noAr,
    ]);
    const r = await app.chamar('GET', '/anunciantes/me/criativos', conta.id);
    assert.equal(r.status, 200, JSON.stringify(r.corpo));
    const por = Object.fromEntries(r.corpo.criativos.map((c) => [c.id, c]));
    assert.equal(por[noAr].situacao, 'no_ar', 'essencial roda 1 peça: a mais recente, e ela já tocou');
    assert.ok(por[noAr].entrada.ultimaExibicaoEm);
    assert.equal(por[antiga].situacao, 'aprovado');
    assert.equal(por[substituta].situacao, 'em_analise');
    assert.equal(por[substituta].substitui, noAr);
    assert.equal(por[noAr].substitutaEmAnalise, substituta);
    assert.equal(por[recusada].situacao, 'recusado');
    assert.equal(por[retirada].situacao, 'fora_do_ar');
    assert.equal(r.corpo.limiteNoAr, 1);
    assert.equal(r.corpo.rodaNaRede, true);
    assert.equal(r.corpo.rodaNoProprioPonto, false);
    assert.ok(!('arquivo_original_url' in por[noAr]), 'projeção própria, não a linha crua');
  } finally {
    await app.fechar();
    await limpar(conta.id);
  }
});

test('substituir: só peça aprovada da própria conta, uma substituta por vez', async () => {
  const conta = await criarConta();
  const outra = await criarConta();
  const app = await subirApp();
  const enviar = (alvo) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob(['nao e video'], { type: 'video/mp4' }), 'a.mp4');
    fd.append('substitui', String(alvo));
    return app.chamar('POST', `/anunciantes/${conta.id}/criativos`, conta.id, fd);
  };
  try {
    const pendente = await criativo(conta.id, 'pendente');
    const aprovada = await criativo(conta.id, 'aprovado');
    const alheia = await criativo(outra.id, 'aprovado');
    const naoAprovada = await enviar(pendente);
    assert.equal(naoAprovada.status, 400);
    assert.match(naoAprovada.corpo.erro, /só dá pra substituir uma peça aprovada/);
    assert.equal((await enviar(alheia)).status, 404);
    await criativo(conta.id, 'pendente', { substitui: aprovada });
    const dupla = await enviar(aprovada);
    assert.equal(dupla.status, 409);
    assert.match(dupla.corpo.erro, /substituta em análise/);
  } finally {
    await app.fechar();
    await limpar(conta.id);
    await limpar(outra.id);
  }
});

// Envio sob demanda (10/10/2026): o painel avisa do teto de CADASTRO antes de
// a pessoa escolher o arquivo. A lista diz quantas peças a conta guarda (a
// mesma conta de `contarCadastrados`, que o upload usa) e o teto — só
// leitura: a regra continua no upload, e os dois têm que concordar.
test('lista traz o teto de cadastro: retirada conta, recusada e substituta em análise não; o upload concorda', async () => {
  const { CRIATIVOS_POR_CONTA } = require('../src/lib/limites');
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const vazia = await app.chamar('GET', '/anunciantes/me/criativos', conta.id);
    assert.equal(vazia.corpo.guardados, 0);
    assert.equal(vazia.corpo.tetoGuardados, CRIATIVOS_POR_CONTA);
    const aprovada = await criativo(conta.id, 'aprovado');
    await criativo(conta.id, 'pendente', { substitui: aprovada });
    await criativo(conta.id, 'reprovado');
    await criativo(conta.id, 'retirado');
    const r = await app.chamar('GET', '/anunciantes/me/criativos', conta.id);
    assert.equal(r.corpo.guardados, 2, 'aprovada + retirada');
    assert.equal(r.corpo.emUso, 1, 'a vaga do plano segue sem a retirada');
    const outra = await criativo(conta.id, 'aprovado');
    const cheia = await app.chamar('GET', '/anunciantes/me/criativos', conta.id);
    assert.equal(cheia.corpo.guardados, CRIATIVOS_POR_CONTA);
    const fd = new FormData();
    fd.append('arquivo', new Blob(['nao e video'], { type: 'video/mp4' }), 'a.mp4');
    fd.append('substitui', String(outra));
    const troca = await app.chamar('POST', `/anunciantes/${conta.id}/criativos`, conta.id, fd);
    assert.equal(troca.status, 400, 'teto cheio: o upload recusa a substituição também');
    assert.match(troca.corpo.erro, /criativos cadastrados/);
  } finally {
    await app.fechar();
    await limpar(conta.id);
  }
});

test.after(() => pool.end());
