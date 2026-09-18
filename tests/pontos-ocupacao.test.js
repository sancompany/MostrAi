const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const pontosRepo = require('../src/pontos/repository');

// Bloqueio de escolha por ponto cheio (G.7, docs/PENDENCIAS.md). Cada teste
// cria e apaga o próprio ponto/anunciante/plano, com nomes/e-mails únicos,
// pra não colidir com outra rodada da suíte.

async function planoDeTeste(segundosPorHora) {
  const id = `plano-teste-ocupacao-${randomUUID()}`;
  await pool.query(
    `INSERT INTO planos (id, tier, nome, valor_mensal, compromisso_meses, frequencia_hora, cobertura, segundos_por_hora, pontos_incluidos, duracao_maxima_segundos, limite_criativos)
     VALUES ($1,'essencial','Teste Ocupação',100,1,0,'todos_pontos',$2,1,30,3)`,
    [id, segundosPorHora],
  );
  return id;
}

async function pontoDeTeste() {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ($1, 'Rua Teste', 'Matão', 'SP', '00000000', 'teste', 'Fulano', '16999990000', 'em_operacao') RETURNING id`,
    [`Ponto Teste Ocupação ${randomUUID()}`],
  );
  return rows[0].id;
}

async function anuncianteDeTeste(planoId) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, plano_id, data_expiracao)
     VALUES ('Teste Ocupação', '11144477735', $1, '16999990000', 'x', now(), $2, now() + interval '30 days')
     RETURNING id`,
    [`ocupacao-${randomUUID()}@example.com`, planoId],
  );
  return rows[0].id;
}

async function bloqueadaEm(pontoId) {
  const { rows } = await pool.query('SELECT escolha_bloqueada_em FROM pontos WHERE id = $1', [pontoId]);
  return rows[0].escolha_bloqueada_em;
}

async function limpar({ anuncianteId, pontoId, planoId }) {
  if (anuncianteId) await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [anuncianteId]);
  if (anuncianteId) await pool.query('DELETE FROM anunciantes WHERE id = $1', [anuncianteId]);
  if (pontoId) await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  if (planoId) await pool.query('DELETE FROM planos WHERE id = $1', [planoId]);
}

test('avaliarBloqueios trava sozinho ao cruzar 80%, e nunca destrava sozinho', async () => {
  const planoId = await planoDeTeste(3000); // 3000/3600 = 83%
  const pontoId = await pontoDeTeste();
  const anuncianteId = await anuncianteDeTeste(planoId);
  try {
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1,$2)', [
      anuncianteId,
      pontoId,
    ]);

    const bloqueados = await pontosRepo.avaliarBloqueios();
    assert.ok(bloqueados.includes(pontoId), 'ponto com 83% de ocupação deveria travar');

    assert.ok(await bloqueadaEm(pontoId), 'escolha_bloqueada_em deve estar preenchido');

    // Esvazia o ponto — a ocupação cai a zero, mas o bloqueio é STICKY.
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    await pontosRepo.avaliarBloqueios();
    assert.ok(await bloqueadaEm(pontoId), 'ponto esvaziado continua travado — só o admin libera');
  } finally {
    await limpar({ anuncianteId, pontoId, planoId });
  }
});

test('avaliarBloqueios não trava ponto abaixo de 80%', async () => {
  const planoId = await planoDeTeste(2800); // 2800/3600 = 78%
  const pontoId = await pontoDeTeste();
  const anuncianteId = await anuncianteDeTeste(planoId);
  try {
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1,$2)', [
      anuncianteId,
      pontoId,
    ]);
    const bloqueados = await pontosRepo.avaliarBloqueios();
    assert.ok(!bloqueados.includes(pontoId), 'ponto com 78% de ocupação não deveria travar');
  } finally {
    await limpar({ anuncianteId, pontoId, planoId });
  }
});

test('liberarEscolha recusa sem folga de 15 minutos, aceita com folga', async () => {
  const planoId = await planoDeTeste(3000); // 600s livres — menos que a folga de 900s
  const pontoId = await pontoDeTeste();
  const anuncianteId = await anuncianteDeTeste(planoId);
  try {
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1,$2)', [
      anuncianteId,
      pontoId,
    ]);
    await pontosRepo.avaliarBloqueios();

    assert.strictEqual(await pontosRepo.liberarEscolha(pontoId), false, 'só 600s livres, precisa de 900');

    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    assert.strictEqual(await pontosRepo.liberarEscolha(pontoId), true, 'ponto vazio tem folga de sobra');

    assert.strictEqual(await bloqueadaEm(pontoId), null, 'liberado — escolha_bloqueada_em volta a null');
  } finally {
    await limpar({ anuncianteId, pontoId, planoId });
  }
});

test('ocupacaoPorAnunciante traz uma linha por (ponto, anunciante), com o total do ponto', async () => {
  const planoId = await planoDeTeste(1000);
  const pontoId = await pontoDeTeste();
  const anuncianteId = await anuncianteDeTeste(planoId);
  try {
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1,$2)', [
      anuncianteId,
      pontoId,
    ]);
    const linhas = await pontosRepo.ocupacaoPorAnunciante();
    const linha = linhas.find((l) => l.anunciante_id === anuncianteId && l.ponto_id === pontoId);
    assert.ok(linha, 'linha do par (ponto, anunciante) deve existir');
    assert.strictEqual(linha.segundos_por_hora, 1000);
    assert.strictEqual(linha.segundos_vendidos, 1000, 'só esta conta no ponto — total bate com o dela');
  } finally {
    await limpar({ anuncianteId, pontoId, planoId });
  }
});

test('idsBloqueadosParaEscolha só lista quem está travado agora', async () => {
  const planoId = await planoDeTeste(3000);
  const pontoId = await pontoDeTeste();
  const anuncianteId = await anuncianteDeTeste(planoId);
  try {
    assert.ok(!(await pontosRepo.idsBloqueadosParaEscolha()).includes(pontoId), 'ainda não travou');
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1,$2)', [
      anuncianteId,
      pontoId,
    ]);
    await pontosRepo.avaliarBloqueios();
    assert.ok((await pontosRepo.idsBloqueadosParaEscolha()).includes(pontoId), 'travou depois de cruzar 80%');
  } finally {
    await limpar({ anuncianteId, pontoId, planoId });
  }
});
