require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pool = require('../src/db/pool');
const midiasRepo = require('../src/midias/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');

// Mídia Mostraí — histórico e exclusão (finalização, 28/09/2026, migration
// 101). Transições que o admin pode fazer, exclusão lógica que preserva o
// comprovante de exibição, e o que a playlist nunca vê.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(require('../src/midias/routes'));
  // A fila de aprovação (PATCH /admin/criativos/:id) mora em admin/routes —
  // entra aqui pra provar que o criativo de mídia excluída não volta por ela
  // (revisão Codex do PR #89, 28/09/2026).
  app.use(require('../src/admin/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: corpo instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: corpo instanceof FormData ? corpo : corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

// `aprovado: false` deixa o criativo em análise — é o caso do operador que
// substituiu o arquivo e excluiu a mídia antes de aprovar.
async function novaMidia(nome, { aprovado = true, ...extra } = {}) {
  const conta = await anunciantesRepo.ensureContaMostrai();
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/hist-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: 10,
  });
  if (aprovado) await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  // Cobertura só no ponto da fixture, não 'rede': mídia de rede ativa entra
  // na ocupação de TODO ponto, e a suíte roda em paralelo — a razão A ≈ 2×B
  // de tests/midias.test.js (margem de 0,15 pp) quebrava com as daqui.
  const midia = await midiasRepo.criar({
    criativoId: criativo.id,
    nomeInterno: nome,
    frequenciaHora: 1,
    coberturaTipo: 'pontos',
    pontosIds: [tela.ponto_id],
    ...extra,
  });
  return { midia, criativoId: criativo.id };
}

// Fim já passado direto no banco, só pra não depender da rota (o PATCH
// aceita data passada — `instanteComercial` valida formato, não passado).
// É o estado que a tela alcança quando o período vence sozinho.
const fimHaUmaHora = (id) =>
  pool.query(`UPDATE midias_proprias SET periodo_fim = now() - interval '1 hour' WHERE id = $1`, [id]);

// Comprovante precisa de uma tela real (ponto_id e dispositivo_id são NOT
// NULL). Sem tela no banco a checagem era pulada em silêncio (revisão Codex
// do PR #89, 28/09/2026) — agora cria ponto + tela de teste e apaga no fim.
let tela;
let fixtureCriada = false;
test.before(async () => {
  const { rows } = await pool.query('SELECT id, ponto_id FROM dispositivos ORDER BY id LIMIT 1');
  if (rows[0]) {
    tela = rows[0];
    return;
  }
  const { rows: pontos } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato)
     VALUES ('Ponto histórico (teste)', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1') RETURNING id`,
  );
  const { rows: telas } = await pool.query(
    `INSERT INTO dispositivos (ponto_id, apelido, status) VALUES ($1, 'Tela 1', 'ativo') RETURNING id, ponto_id`,
    [pontos[0].id],
  );
  tela = telas[0];
  fixtureCriada = true;
});

const criadas = [];
test.after(async () => {
  for (const { midia, criativoId } of criadas) {
    await pool.query('DELETE FROM midias_exibicoes_contador WHERE midia_id = $1', [midia.id]);
    await pool.query('DELETE FROM midias_proprias WHERE id = $1', [midia.id]);
    await pool.query('DELETE FROM criativos WHERE id = $1', [criativoId]);
  }
  if (fixtureCriada) {
    await pool.query('DELETE FROM dispositivos WHERE id = $1', [tela.id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [tela.ponto_id]);
  }
  await pool.end();
});

test('transições: retirada do ar não volta; excluída não muda; pausar só de ativa', async () => {
  const app = await subirApp();
  const a = await novaMidia('Hist A');
  criadas.push(a);
  try {
    const id = a.midia.id;
    let r = await app.chamar('POST', `/admin/midias-proprias/${id}/retomar`);
    assert.strictEqual(r.status, 409, 'ativa não se "retoma"');
    r = await app.chamar('POST', `/admin/midias-proprias/${id}/pausar`);
    assert.strictEqual(r.status, 200);
    r = await app.chamar('POST', `/admin/midias-proprias/${id}/pausar`);
    assert.strictEqual(r.status, 409, 'pausada não se pausa de novo');
    r = await app.chamar('POST', `/admin/midias-proprias/${id}/retomar`);
    assert.strictEqual(r.status, 200);
    r = await app.chamar('POST', `/admin/midias-proprias/${id}/encerrar`);
    assert.strictEqual(r.status, 200);
    r = await app.chamar('POST', `/admin/midias-proprias/${id}/retomar`);
    assert.strictEqual(r.status, 409, 'retirada do ar não volta (antes voltava)');
    assert.match(r.corpo.erro, /não volta/);
    r = await app.chamar('POST', `/admin/midias-proprias/${id}/pausar`);
    assert.strictEqual(r.status, 409);
    assert.strictEqual((await midiasRepo.buscarPorId(id)).situacaoDerivada, 'encerrada');
  } finally {
    await app.fechar();
  }
});

// Revisão Codex do PR #89 (28/09/2026): a régua olhava só a situação
// PERSISTIDA — com o período vencido ela ainda é 'ativa', e Pausar era
// aceito, tirando a mídia do histórico e oferecendo "Retomar" depois.
test('período vencido: não pausa (409), a persistida continua ativa e a derivada é encerrada', async () => {
  const app = await subirApp();
  const a = await novaMidia('Hist vencida');
  criadas.push(a);
  try {
    const id = a.midia.id;
    await fimHaUmaHora(id);
    const r = await app.chamar('POST', `/admin/midias-proprias/${id}/pausar`);
    assert.strictEqual(r.status, 409, JSON.stringify(r.corpo));
    // A derivada ('encerrada') barra na régua; o UPDATE com `soVigente` é a
    // segunda trava, pra corrida entre a tela e o clique.
    assert.match(r.corpo.erro, /pausada/);
    assert.strictEqual(await midiasRepo.definirSituacao(id, 'pausada', { soVigente: true }), false, 'nem na corrida');
    const depois = await midiasRepo.buscarPorId(id);
    assert.strictEqual(depois.situacao, 'ativa', 'a persistida não muda');
    assert.strictEqual(depois.situacaoDerivada, 'encerrada');
  } finally {
    await app.fechar();
  }
});

test('período vencido: pausada não retoma (409) e cai no histórico como encerrada', async () => {
  const app = await subirApp();
  const a = await novaMidia('Hist pausada vencida');
  criadas.push(a);
  try {
    const id = a.midia.id;
    let r = await app.chamar('POST', `/admin/midias-proprias/${id}/pausar`);
    assert.strictEqual(r.status, 200);
    await fimHaUmaHora(id);
    r = await app.chamar('POST', `/admin/midias-proprias/${id}/retomar`);
    assert.strictEqual(r.status, 409, JSON.stringify(r.corpo));
    const depois = await midiasRepo.buscarPorId(id);
    assert.strictEqual(depois.situacao, 'pausada');
    assert.strictEqual(depois.situacaoDerivada, 'encerrada', 'pausada com fim no passado não tem pra onde voltar');
  } finally {
    await app.fechar();
  }
});

// Revisão do PR #89 (28/09/2026): "retirada do ar não volta" valia pra
// Pausar/Retomar, mas Editar deixava estender o `periodo_fim` — e sem
// revalidar capacidade, porque a derivada no momento do PATCH era
// 'encerrada'. Agora período, frequência e cobertura ficam travados; só o
// nome muda (o card nem mostra Editar).
test('período vencido: Editar não estende o período nem mexe na frequência (409); só o nome muda', async () => {
  const app = await subirApp();
  const a = await novaMidia('Hist vencida editada');
  criadas.push(a);
  try {
    const id = a.midia.id;
    await fimHaUmaHora(id);
    let r = await app.chamar('PATCH', `/admin/midias-proprias/${id}`, { periodo_fim: '2099-12-31T23:59' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.corpo));
    assert.match(r.corpo.erro, /não volta/);
    r = await app.chamar('PATCH', `/admin/midias-proprias/${id}`, { frequencia_hora: 5 });
    assert.strictEqual(r.status, 409, 'frequência também não');
    r = await app.chamar('PATCH', `/admin/midias-proprias/${id}`, { nome_interno: 'Hist vencida (renomeada)' });
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    const depois = await midiasRepo.buscarPorId(id);
    assert.strictEqual(depois.situacaoDerivada, 'encerrada', 'continua no histórico');
    assert.strictEqual(depois.nome_interno, 'Hist vencida (renomeada)');
    assert.strictEqual(depois.frequencia_hora, 1, 'frequência intacta');
  } finally {
    await app.fechar();
  }
});

test('excluir: exclusão lógica — some da playlist e das listas de trabalho, comprovante fica, sem volta', async () => {
  const app = await subirApp();
  const a = await novaMidia('Hist B');
  criadas.push(a);
  try {
    const id = a.midia.id;
    // Comprovante de exibição de antes da exclusão.
    await pool.query(
      `INSERT INTO midias_exibicoes_contador (midia_id, dispositivo_id, ponto_id, janela_hora, vezes_programadas, vezes_confirmadas)
       VALUES ($1, $2, $3, date_trunc('hour', now()), 2, 2)
       ON CONFLICT DO NOTHING`,
      [id, tela.id, tela.ponto_id],
    );
    let r = await app.chamar('DELETE', `/admin/midias-proprias/${id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    const depois = await midiasRepo.buscarPorId(id);
    assert.strictEqual(depois.situacao, 'excluida');
    assert.strictEqual(depois.situacaoDerivada, 'excluida');
    const { rows } = await pool.query(
      'SELECT SUM(vezes_confirmadas)::int AS n FROM midias_exibicoes_contador WHERE midia_id = $1',
      [id],
    );
    assert.strictEqual(rows[0].n, 2, 'o comprovante de exibição fica');
    // Histórico de estados (trigger da 099) registra a exclusão.
    const { rows: hist } = await pool.query(
      'SELECT situacao FROM midias_proprias_situacoes WHERE midia_id = $1 ORDER BY desde DESC LIMIT 1',
      [id],
    );
    assert.strictEqual(hist[0].situacao, 'excluida');

    // Sem volta, por nenhum caminho.
    for (const acao of ['retomar', 'pausar', 'encerrar']) {
      r = await app.chamar('POST', `/admin/midias-proprias/${id}/${acao}`);
      assert.strictEqual(r.status, 409, `${acao} em excluída`);
    }
    r = await app.chamar('DELETE', `/admin/midias-proprias/${id}`);
    assert.strictEqual(r.status, 409, 'excluir de novo');
    r = await app.chamar('PATCH', `/admin/midias-proprias/${id}`, { nome_interno: 'x' });
    assert.strictEqual(r.status, 409, 'editar excluída');
    assert.strictEqual(await midiasRepo.definirSituacao(id, 'ativa'), false, 'nem por script');

    // Lista do admin: por último; playlist: nunca.
    const lista = await midiasRepo.listar();
    const ultima = lista[lista.length - 1];
    assert.strictEqual(ultima.situacao, 'excluida');
    const elegiveis = await midiasRepo.elegiveisNoPonto(tela.ponto_id);
    assert.ok(!elegiveis.some((m) => m.id === id), 'excluída nunca é elegível');
  } finally {
    await app.fechar();
  }
});

// Revisão Codex do PR #89 (28/09/2026): o criativo em análise de uma mídia
// excluída continuava na fila com Aprovar/Ajustar/Reprovar. Vira
// 'reprovado' (não 'retirado': esse tem "Colocar no ar" na ficha), e a fila
// não mexe mais nele.
test('excluir com criativo pendente: sai da fila como reprovado e a fila não o aprova nem substitui', async () => {
  const app = await subirApp();
  const a = await novaMidia('Hist pendente', { aprovado: false });
  criadas.push(a);
  try {
    const { criativoId } = a;
    assert.strictEqual((await criativosRepo.buscarPorId(criativoId)).status, 'pendente');
    let r = await app.chamar('DELETE', `/admin/midias-proprias/${a.midia.id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    const criativo = await criativosRepo.buscarPorId(criativoId);
    assert.strictEqual(criativo.status, 'reprovado');
    assert.match(criativo.motivo_reprovacao, /excluída/);
    assert.ok(!(await criativosRepo.listarPorStatus('pendente')).some((c) => c.id === criativoId), 'fora da fila');
    assert.strictEqual(await midiasRepo.situacaoPorCriativo(criativoId), 'excluida');

    r = await app.chamar('PATCH', `/admin/criativos/${criativoId}`, { status: 'aprovado' });
    assert.strictEqual(r.status, 409, JSON.stringify(r.corpo));
    assert.match(r.corpo.erro, /excluída/);
    assert.strictEqual((await criativosRepo.buscarPorId(criativoId)).status, 'reprovado', 'continua reprovado');

    // Substituir o arquivo também não: recusa antes do ffmpeg.
    const form = new FormData();
    form.append('arquivo', new Blob([Buffer.from('nada')], { type: 'video/mp4' }), 'x.mp4');
    r = await app.chamar('POST', `/admin/criativos/${criativoId}/substituir`, form);
    assert.strictEqual(r.status, 409, JSON.stringify(r.corpo));
    assert.strictEqual((await criativosRepo.buscarPorId(criativoId)).status, 'reprovado');
  } finally {
    await app.fechar();
  }
});

test('situacaoDerivada: excluída vence período e pausa; período que acabou vence a pausa', () => {
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'excluida', periodo_inicio: '2099-01-01', periodo_fim: null }),
    'excluida',
  );
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'pausada', periodo_inicio: null, periodo_fim: '2000-01-01' }),
    'encerrada',
    'pausada com fim no passado não tem pra onde voltar',
  );
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'pausada', periodo_inicio: null, periodo_fim: '2099-01-01' }),
    'pausada',
  );
});
