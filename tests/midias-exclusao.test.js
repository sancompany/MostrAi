require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const pool = require('../src/db/pool');
const midiasRepo = require('../src/midias/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');

// Exclusão de mídia própria (refino da Mídia Mostraí, 29/09/2026). LÓGICA,
// pela migration 107: um DELETE físico cascatearia as exibições confirmadas
// (o comprovante) e o histórico de estados. Aqui: ativa e agendada não se
// excluem direto; pausada e encerrada sim; a linha e o histórico ficam; a
// excluída some da lista, da playlist e não volta por rota nenhuma.

const criadas = { midias: [], criativos: [], pontos: [] };
test.after(async () => {
  for (const id of criadas.midias) {
    await pool.query('DELETE FROM midias_exibicoes_contador WHERE midia_id = $1', [id]);
    await pool.query('DELETE FROM midias_proprias_pontos WHERE midia_id = $1', [id]);
    await pool.query('DELETE FROM midias_proprias WHERE id = $1', [id]);
  }
  for (const id of criadas.criativos) await pool.query('DELETE FROM criativos WHERE id = $1', [id]);
  for (const id of criadas.pontos) await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
  await pool.end();
});

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, proximo) => {
    req.session = { adminUsuario: 'teste' };
    proximo();
  });
  app.use(require('../src/midias/routes'));
  app.use(require('../src/admin/routes'));
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

async function pontoDeTeste() {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ($1, 'Rua Teste', 'Matão', 'SP', '00000000', 'teste', 'Fulano', '16999990000', 'em_operacao') RETURNING id`,
    [`Ponto Exclusão ${randomUUID()}`],
  );
  criadas.pontos.push(rows[0].id);
  return rows[0].id;
}

// Banco recém-criado: outro arquivo pode estar criando a conta institucional
// no mesmo instante (ensureContaMostrai não trata a corrida — anterior a esta
// estação). Quem perde a corrida só lê a que o outro criou.
async function contaMostrai() {
  try {
    return await anunciantesRepo.ensureContaMostrai();
  } catch (erro) {
    if (erro.code !== '23505') throw erro;
    return anunciantesRepo.buscarContaPropria();
  }
}

// Mídia de 1x/hora num ponto só do teste: não pesa na capacidade de nenhum
// outro arquivo rodando em paralelo.
async function midiaDeTeste({
  situacao = 'ativa',
  periodoInicio = null,
  periodoFim = null,
  criativo = 'aprovado',
} = {}) {
  const conta = await contaMostrai();
  const ponto = await pontoDeTeste();
  const c = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: 'https://exemplo.test/exclusao.mp4',
    thumbnail_url: null,
    duracao_segundos: 10,
  });
  await criativosRepo.atualizar(c.id, { status: criativo });
  criadas.criativos.push(c.id);
  const m = await midiasRepo.criar({
    criativoId: c.id,
    nomeInterno: `Exclusão ${randomUUID().slice(0, 6)}`,
    frequenciaHora: 1,
    coberturaTipo: 'pontos',
    pontosIds: [ponto],
  });
  criadas.midias.push(m.id);
  // Período direto no banco: o `criar` recusa início no passado distante
  // só por ser digitado; aqui interessa o estado, não a digitação.
  if (periodoInicio || periodoFim) {
    await pool.query('UPDATE midias_proprias SET periodo_inicio = $2, periodo_fim = $3 WHERE id = $1', [
      m.id,
      periodoInicio,
      periodoFim,
    ]);
  }
  if (situacao !== 'ativa') await midiasRepo.definirSituacao(m.id, situacao);
  return { ...(await midiasRepo.buscarPorId(m.id)), pontoId: ponto };
}

const HORA = 3_600_000;
const situacaoNoBanco = async (id) =>
  (await pool.query('SELECT situacao FROM midias_proprias WHERE id = $1', [id])).rows[0]?.situacao;

test('ativa e agendada não se excluem direto: 409, e a mídia continua como estava', async () => {
  const app = await subirApp();
  try {
    const ativa = await midiaDeTeste();
    const agendada = await midiaDeTeste({ periodoInicio: new Date(Date.now() + 24 * HORA) });
    assert.strictEqual(agendada.situacaoDerivada, 'agendada');
    for (const m of [ativa, agendada]) {
      const r = await app.chamar('DELETE', `/admin/midias-proprias/${m.id}`);
      assert.strictEqual(r.status, 409, m.situacaoDerivada);
      assert.match(r.corpo.erro, /pause ou retire/);
      assert.strictEqual(await situacaoNoBanco(m.id), 'ativa');
    }
  } finally {
    await app.fechar();
  }
});

test('pausada se exclui: a linha e o histórico ficam, a mídia sai da lista e da playlist', async () => {
  const app = await subirApp();
  try {
    const m = await midiaDeTeste();
    // Duas horas de exibição confirmada pela TV: o comprovante que não pode sumir.
    await pool.query(
      `INSERT INTO midias_exibicoes_contador (midia_id, dispositivo_id, ponto_id, janela_hora, vezes_programadas, vezes_confirmadas)
       VALUES ($1, 999001, $2, date_trunc('hour', now()) - interval '2 hours', 1, 1),
              ($1, 999001, $2, date_trunc('hour', now()) - interval '1 hour', 1, 1)`,
      [m.id, m.pontoId],
    );
    assert.strictEqual((await app.chamar('POST', `/admin/midias-proprias/${m.id}/pausar`)).status, 200);
    const historicoAntes = (
      await pool.query('SELECT COUNT(*)::int AS n FROM midias_proprias_situacoes WHERE midia_id = $1', [m.id])
    ).rows[0].n;

    const r = await app.chamar('DELETE', `/admin/midias-proprias/${m.id}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));

    assert.strictEqual(await situacaoNoBanco(m.id), 'excluida', 'exclusão lógica: a linha fica');
    const contador = await pool.query(
      'SELECT SUM(vezes_confirmadas)::int AS n FROM midias_exibicoes_contador WHERE midia_id = $1',
      [m.id],
    );
    assert.strictEqual(contador.rows[0].n, 2, 'as exibições confirmadas continuam lá');
    const historico = await pool.query(
      'SELECT situacao FROM midias_proprias_situacoes WHERE midia_id = $1 ORDER BY desde, id',
      [m.id],
    );
    assert.strictEqual(historico.rows.length, historicoAntes + 1, 'o histórico ganha a exclusão, não perde nada');
    assert.strictEqual(historico.rows.at(-1).situacao, 'excluida');

    const lista = (await app.chamar('GET', '/admin/midias-proprias')).corpo;
    assert.ok(!lista.some((x) => x.id === m.id), 'some da lista de trabalho');
    assert.strictEqual((await midiasRepo.buscarPorId(m.id)).situacaoDerivada, 'excluida');
    assert.ok(!(await midiasRepo.elegiveisNoPonto(m.pontoId)).some((x) => x.id === m.id), 'nunca entra na playlist');
    const noPonto = (await midiasRepo.ocupacaoPorPonto([m.pontoId], null))[0];
    assert.strictEqual(noPonto.segundosMostrai, 0, 'nem na capacidade');
  } finally {
    await app.fechar();
  }
});

test('encerrada (retirada do ar ou período vencido) se exclui', async () => {
  const app = await subirApp();
  try {
    const retirada = await midiaDeTeste({ situacao: 'encerrada' });
    const vencida = await midiaDeTeste({
      periodoInicio: new Date(Date.now() - 48 * HORA),
      periodoFim: new Date(Date.now() - 24 * HORA),
    });
    assert.strictEqual(vencida.situacaoDerivada, 'encerrada');
    for (const m of [retirada, vencida]) {
      const r = await app.chamar('DELETE', `/admin/midias-proprias/${m.id}`);
      assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
      assert.strictEqual(await situacaoNoBanco(m.id), 'excluida');
    }
  } finally {
    await app.fechar();
  }
});

test('excluída não volta por rota nenhuma', async () => {
  const app = await subirApp();
  try {
    const m = await midiaDeTeste({ situacao: 'pausada' });
    assert.strictEqual((await app.chamar('DELETE', `/admin/midias-proprias/${m.id}`)).status, 200);
    for (const acao of ['pausar', 'retomar', 'encerrar']) {
      const r = await app.chamar('POST', `/admin/midias-proprias/${m.id}/${acao}`);
      assert.strictEqual(r.status, 409, acao);
    }
    assert.strictEqual(
      (await app.chamar('PATCH', `/admin/midias-proprias/${m.id}`, { nome_interno: 'Volta' })).status,
      409,
    );
    assert.strictEqual((await app.chamar('DELETE', `/admin/midias-proprias/${m.id}`)).status, 404);
    assert.strictEqual(
      (await app.chamar('PATCH', `/admin/criativos/${m.criativo_id}`, { status: 'aprovado' })).status,
      409,
      'o arquivo não volta por aprovação',
    );
    assert.strictEqual(
      (await app.chamar('POST', `/admin/criativos/${m.criativo_id}/substituir`)).status,
      409,
      'nem trocando o arquivo',
    );
    assert.strictEqual(await situacaoNoBanco(m.id), 'excluida');
  } finally {
    await app.fechar();
  }
});

test('arquivo ainda em análise sai da fila junto com a mídia; arquivo aprovado fica como estava', async () => {
  const app = await subirApp();
  try {
    const emAnalise = await midiaDeTeste({ situacao: 'pausada', criativo: 'pendente' });
    const aprovada = await midiaDeTeste({ situacao: 'pausada' });
    for (const m of [emAnalise, aprovada]) {
      assert.strictEqual((await app.chamar('DELETE', `/admin/midias-proprias/${m.id}`)).status, 200);
    }
    const c1 = await criativosRepo.buscarPorId(emAnalise.criativo_id);
    assert.strictEqual(c1.status, 'reprovado');
    assert.match(c1.motivo_reprovacao, /Mídia excluída/);
    assert.strictEqual((await criativosRepo.buscarPorId(aprovada.criativo_id)).status, 'aprovado');
  } finally {
    await app.fechar();
  }
});
