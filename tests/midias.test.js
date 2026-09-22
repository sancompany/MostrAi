const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const midiasRepo = require('../src/midias/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');

// Mídia Mostraí (reorganização de Conteúdo, 22/09/2026) — cobre a parte
// testável sem ffmpeg/upload real (não há binário `ffmpeg` neste ambiente,
// mesma razão pela qual os outros testes de criativo inserem
// `arquivo_normalizado_url` direto em vez de subir um arquivo de verdade):
// capacidade (Parte 10/11/12), elegibilidade na playlist (Parte 5/7) e
// substituição preservando o mesmo criativo lógico (Parte 27).

async function pontoDeTeste(nome) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ($1, 'Rua Teste', 'Matão', 'SP', '00000000', 'teste', 'Fulano', '16999990000', 'em_operacao') RETURNING id`,
    [nome || `Ponto Teste Mídia ${randomUUID()}`],
  );
  return rows[0].id;
}

async function criativoDeTeste(contaId, { duracaoSegundos = 10, status = 'aprovado' } = {}) {
  const criativo = await criativosRepo.criar({
    anunciante_id: contaId,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: 'https://exemplo.test/midia-teste.mp4',
    thumbnail_url: null,
    duracao_segundos: duracaoSegundos,
  });
  return criativosRepo.atualizar(criativo.id, { status });
}

async function limpar({ midiaIds = [], criativoIds = [], pontoIds = [] }) {
  for (const id of midiaIds) {
    await pool.query('DELETE FROM midias_proprias_pontos WHERE midia_id = $1', [id]);
    await pool.query('DELETE FROM midias_proprias WHERE id = $1', [id]);
  }
  for (const id of criativoIds) await pool.query('DELETE FROM criativos WHERE id = $1', [id]);
  for (const id of pontoIds) await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
}

test('ensureContaMostrai é idempotente — chamadas repetidas devolvem a mesma conta', async () => {
  const a = await anunciantesRepo.ensureContaMostrai();
  const b = await anunciantesRepo.ensureContaMostrai();
  assert.strictEqual(a.id, b.id);
  assert.strictEqual(a.conta_propria, true);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM anunciantes WHERE conta_propria');
  assert.strictEqual(rows[0].n, 1, 'só pode existir uma conta própria — índice único garante');
});

test('ocupacaoPorPonto: cobertura "rede" soma em todos os pontos, "pontos" só nos escolhidos', async () => {
  const conta = await anunciantesRepo.ensureContaMostrai();
  const pontoA = await pontoDeTeste();
  const pontoB = await pontoDeTeste();
  const criativo = await criativoDeTeste(conta.id, { duracaoSegundos: 10 });
  // 6x/hora * 10s = 60s/hora = 100/60 ~= 1.67% — baixo de propósito, só pra
  // não interferir com outra mídia rodando em paralelo na mesma suíte.
  const midiaRede = await midiasRepo.criar({
    criativoId: criativo.id,
    nomeInterno: 'Rede Teste',
    frequenciaHora: 6,
    coberturaTipo: 'rede',
    pontosIds: [],
  });
  const criativo2 = await criativoDeTeste(conta.id, { duracaoSegundos: 10 });
  const midiaPontoA = await midiasRepo.criar({
    criativoId: criativo2.id,
    nomeInterno: 'Ponto A Teste',
    frequenciaHora: 6,
    coberturaTipo: 'pontos',
    pontosIds: [pontoA],
  });
  try {
    const linhas = await midiasRepo.ocupacaoPorPonto([pontoA, pontoB], null);
    const linhaA = linhas.find((l) => l.pontoId === pontoA);
    const linhaB = linhas.find((l) => l.pontoId === pontoB);
    // Ponto A recebe as duas (rede + específica); ponto B só a de rede.
    assert.ok(
      linhaA.institucionalPct > linhaB.institucionalPct,
      'ponto A tem mais institucional que B (recebe as duas mídias)',
    );
    // Cada percentual já vem arredondado a uma casa — comparar o dobro exato
    // bate com arredondamento diferente por ponto (3.3% vs 1.7%×2=3.4%).
    // A margem de 0.15pp absorve isso sem esconder um bug de verdade (uma
    // mídia "sumindo" do cálculo mudaria a diferença em pontos inteiros).
    assert.ok(
      Math.abs(linhaA.institucionalPct - linhaB.institucionalPct * 2) < 0.15,
      `ponto A (${linhaA.institucionalPct}%) deveria ser ~2x o ponto B (${linhaB.institucionalPct}%) — duas mídias de mesmo peso contra uma só`,
    );
  } finally {
    await limpar({
      midiaIds: [midiaRede.id, midiaPontoA.id],
      criativoIds: [criativo.id, criativo2.id],
      pontoIds: [pontoA, pontoB],
    });
  }
});

test('previewOcupacao: comporta=false quando a frequência somada passaria de 100%', async () => {
  const conta = await anunciantesRepo.ensureContaMostrai();
  const ponto = await pontoDeTeste();
  const criativo = await criativoDeTeste(conta.id, { duracaoSegundos: 30 });
  // 100x/hora * 30s = 3000s/hora, já 83% sozinha.
  const midiaExistente = await midiasRepo.criar({
    criativoId: criativo.id,
    nomeInterno: 'Quase Cheio',
    frequenciaHora: 100,
    coberturaTipo: 'pontos',
    pontosIds: [ponto],
  });
  try {
    // Mais 100x/hora * 30s ultrapassaria 100% de sobra.
    const linhas = await midiasRepo.previewOcupacao({
      pontosAlvo: [ponto],
      frequenciaHora: 100,
      duracaoSegundos: 30,
      excluirMidiaId: null,
    });
    const linha = linhas.find((l) => l.pontoId === ponto);
    assert.strictEqual(linha.comporta, false, 'passar de 100% deve bloquear (Parte 10/12)');

    // A própria mídia se editando (excluindo a si mesma do cálculo) com uma
    // frequência menor deve caber.
    const linhasEditando = await midiasRepo.previewOcupacao({
      pontosAlvo: [ponto],
      frequenciaHora: 10,
      duracaoSegundos: 30,
      excluirMidiaId: midiaExistente.id,
    });
    assert.strictEqual(
      linhasEditando.find((l) => l.pontoId === ponto).comporta,
      true,
      'editar a própria mídia não deve disputar espaço com ela mesma',
    );
  } finally {
    await limpar({ midiaIds: [midiaExistente.id], criativoIds: [criativo.id], pontoIds: [ponto] });
  }
});

test('elegiveisNoPonto: só entra ativa, aprovada, dentro do período e da cobertura certa', async () => {
  const conta = await anunciantesRepo.ensureContaMostrai();
  const ponto = await pontoDeTeste();
  const outroPonto = await pontoDeTeste();

  const criativoOk = await criativoDeTeste(conta.id);
  const midiaOk = await midiasRepo.criar({
    criativoId: criativoOk.id,
    nomeInterno: 'Elegível',
    frequenciaHora: 3,
    coberturaTipo: 'pontos',
    pontosIds: [ponto],
  });

  const criativoPausado = await criativoDeTeste(conta.id);
  const midiaPausada = await midiasRepo.criar({
    criativoId: criativoPausado.id,
    nomeInterno: 'Pausada',
    frequenciaHora: 3,
    coberturaTipo: 'pontos',
    pontosIds: [ponto],
  });
  await midiasRepo.definirSituacao(midiaPausada.id, 'pausada');

  const criativoPendente = await criativoDeTeste(conta.id, { status: 'pendente' });
  const midiaPendente = await midiasRepo.criar({
    criativoId: criativoPendente.id,
    nomeInterno: 'Em análise',
    frequenciaHora: 3,
    coberturaTipo: 'pontos',
    pontosIds: [ponto],
  });

  const criativoOutroPonto = await criativoDeTeste(conta.id);
  const midiaOutroPonto = await midiasRepo.criar({
    criativoId: criativoOutroPonto.id,
    nomeInterno: 'Outro ponto',
    frequenciaHora: 3,
    coberturaTipo: 'pontos',
    pontosIds: [outroPonto],
  });

  try {
    const elegiveis = await midiasRepo.elegiveisNoPonto(ponto);
    const ids = elegiveis.map((e) => e.id);
    assert.ok(ids.includes(midiaOk.id), 'ativa + aprovada + no ponto certo deve entrar');
    assert.ok(!ids.includes(midiaPausada.id), 'pausada não entra na playlist');
    assert.ok(!ids.includes(midiaPendente.id), 'em análise (não aprovada) não entra na playlist — Parte 29');
    assert.ok(!ids.includes(midiaOutroPonto.id), 'cobertura de outro ponto não vaza pra este');
  } finally {
    await limpar({
      midiaIds: [midiaOk.id, midiaPausada.id, midiaPendente.id, midiaOutroPonto.id],
      criativoIds: [criativoOk.id, criativoPausado.id, criativoPendente.id, criativoOutroPonto.id],
      pontoIds: [ponto, outroPonto],
    });
  }
});

test('atualizar: trocar cobertura de "rede" pra "pontos" substitui os vínculos, não acumula', async () => {
  const conta = await anunciantesRepo.ensureContaMostrai();
  const pontoA = await pontoDeTeste();
  const pontoB = await pontoDeTeste();
  const criativo = await criativoDeTeste(conta.id);
  const midia = await midiasRepo.criar({
    criativoId: criativo.id,
    nomeInterno: 'Troca de cobertura',
    frequenciaHora: 2,
    coberturaTipo: 'pontos',
    pontosIds: [pontoA],
  });
  try {
    let atual = await midiasRepo.buscarPorId(midia.id);
    assert.deepStrictEqual(atual.pontosIds, [pontoA]);

    await midiasRepo.atualizar(midia.id, { coberturaTipo: 'pontos', pontosIds: [pontoB] });
    atual = await midiasRepo.buscarPorId(midia.id);
    assert.deepStrictEqual(atual.pontosIds, [pontoB], 'trocar de ponto substitui a lista inteira, não soma');
  } finally {
    await limpar({ midiaIds: [midia.id], criativoIds: [criativo.id], pontoIds: [pontoA, pontoB] });
  }
});

test('situacaoDerivada: agendada/ativa/encerrada por período, sempre que não houver controle manual', async () => {
  const agora = new Date('2026-09-22T12:00:00Z');
  const futuro = new Date('2026-10-01T00:00:00Z');
  const passado = new Date('2026-01-01T00:00:00Z');
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'ativa', periodo_inicio: futuro, periodo_fim: null }, agora),
    'agendada',
  );
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'ativa', periodo_inicio: null, periodo_fim: passado }, agora),
    'encerrada',
  );
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'ativa', periodo_inicio: null, periodo_fim: null }, agora),
    'ativa',
  );
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'pausada', periodo_inicio: null, periodo_fim: null }, agora),
    'pausada',
  );
  assert.strictEqual(
    midiasRepo.situacaoDerivada({ situacao: 'encerrada', periodo_inicio: futuro, periodo_fim: null }, agora),
    'encerrada',
    'encerrar manualmente vence qualquer período',
  );
});

test('substituir arquivo (mesmo mecanismo de routes.js #substituir): preserva o mesmo criativo lógico, volta pra pendente', async () => {
  const conta = await anunciantesRepo.ensureContaMostrai();
  const criativo = await criativoDeTeste(conta.id, { status: 'aprovado' });
  const idOriginal = criativo.id;
  try {
    // Mesma operação que a rota faz: atualiza o arquivo do MESMO id, nunca
    // cria uma linha nova — Parte 27, o requisito mais crítico do pedido.
    const substituido = await criativosRepo.atualizar(idOriginal, {
      arquivo_original_url: 'novo.mp4',
      arquivo_normalizado_url: 'https://exemplo.test/novo-normalizado.mp4',
      thumbnail_url: null,
      duracao_segundos: 22,
      status: 'pendente',
      motivo_reprovacao: null,
    });
    assert.strictEqual(substituido.id, idOriginal, 'substituir nunca cria um criativo novo');
    assert.strictEqual(substituido.status, 'pendente', 'volta pra análise — nunca aprova sozinho (Parte 29)');
    assert.strictEqual(substituido.arquivo_normalizado_url, 'https://exemplo.test/novo-normalizado.mp4');

    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM criativos WHERE id = $1', [idOriginal]);
    assert.strictEqual(rows[0].n, 1, 'só existe uma linha para este id — nenhum duplicado foi criado');
  } finally {
    await limpar({ criativoIds: [idOriginal] });
  }
});
