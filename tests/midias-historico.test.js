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
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo) => {
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers: { 'Content-Type': 'application/json' },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

async function novaMidia(nome, extra = {}) {
  const conta = await anunciantesRepo.ensureContaMostrai();
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/hist-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: 10,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  const midia = await midiasRepo.criar({
    criativoId: criativo.id,
    nomeInterno: nome,
    frequenciaHora: 1,
    coberturaTipo: 'rede',
    pontosIds: [],
    ...extra,
  });
  return { midia, criativoId: criativo.id };
}

const criadas = [];
test.after(async () => {
  for (const { midia, criativoId } of criadas) {
    await pool.query('DELETE FROM midias_exibicoes_contador WHERE midia_id = $1', [midia.id]);
    await pool.query('DELETE FROM midias_proprias WHERE id = $1', [midia.id]);
    await pool.query('DELETE FROM criativos WHERE id = $1', [criativoId]);
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

test('excluir: exclusão lógica — some da playlist e das listas de trabalho, comprovante fica, sem volta', async () => {
  const app = await subirApp();
  const a = await novaMidia('Hist B');
  criadas.push(a);
  try {
    const id = a.midia.id;
    // Comprovante de exibição de antes da exclusão.
    const { rows: telas } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
    const telaId = telas[0]?.id;
    if (telaId) {
      await pool.query(
        `INSERT INTO midias_exibicoes_contador (midia_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas)
         VALUES ($1, $2, date_trunc('hour', now()), 2, 2)
         ON CONFLICT DO NOTHING`,
        [id, telaId],
      );
    }
    let r = await app.chamar('DELETE', `/admin/midias-proprias/${id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    const depois = await midiasRepo.buscarPorId(id);
    assert.strictEqual(depois.situacao, 'excluida');
    assert.strictEqual(depois.situacaoDerivada, 'excluida');
    if (telaId) {
      const { rows } = await pool.query(
        'SELECT SUM(vezes_confirmadas)::int AS n FROM midias_exibicoes_contador WHERE midia_id = $1',
        [id],
      );
      assert.strictEqual(rows[0].n, 2, 'o comprovante de exibição fica');
    }
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
    const { rows: pontos } = await pool.query('SELECT id FROM pontos LIMIT 1');
    if (pontos[0]) {
      const elegiveis = await midiasRepo.elegiveisNoPonto(pontos[0].id);
      assert.ok(!elegiveis.some((m) => m.id === id), 'excluída nunca é elegível');
    }
  } finally {
    await app.fechar();
  }
});

test('situacaoDerivada: excluída vence período e pausa', () => {
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'excluida', periodo_inicio: '2099-01-01', periodo_fim: null }),
    'excluida',
  );
});
