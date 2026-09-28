const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const { confirmarComDedup } = require('../src/playlist/execucoes-repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const basicoRepo = require('../src/pontos/basico');
const { concederCreditosMensais, situacaoDosPontos } = require('../src/creditos/ponto');
const { registrarHorasSemPedido } = require('../src/bancohoras/obrigacao');
const { horasDeTelaPorMes } = require('../src/lib/pacing');
const { instalarPlayer } = require('./apoio-player');

// PLANO BÁSICO COMO BENEFÍCIO DO PONTO (migration 103, ADR-025). Os 10 casos
// da estação de 28/09/2026 + a hora sem sinal. Relógio controlado: as horas
// geradas ficam em agosto de 2026 (03/08 é segunda), e o início do Básico é
// recuado pra antes delas.

const emMatao = (dia, hora) => new Date(Date.UTC(2026, 7, dia, hora + 3));
const INICIO_TESTE = '2026-08-01T00:00:00Z';

const criados = { contas: [], pontos: [] };
test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const pontoId of criados.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM creditos_ledger WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM beneficios_basico_ponto WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
  for (const id of criados.contas) {
    for (const t of [
      'banco_horas',
      'exibicoes_contador',
      'anunciantes_pontos',
      'eventos',
      'notificacoes',
      'creditos_ledger',
      'criativos',
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]);
    }
    await pool.query('DELETE FROM beneficios_basico_ponto WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

async function novaConta({ plano = null, duracao = 15 } = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Padaria ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `basico-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criados.contas.push(conta.id);
  if (plano) {
    await pool.query(
      `UPDATE anunciantes SET plano_id = $2, data_inicio_cobertura = '2026-07-01', data_expiracao = '2099-12-31' WHERE id = $1`,
      [conta.id, plano],
    );
  }
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/basico-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: duracao,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  return conta;
}

// Ponto da conta, fora do sorteio automático, com uma tela. `instalar`:
// Player provisionado (é o que torna o ponto elegível — a régua do crédito).
async function pontoDaConta(contaId, { instalar = true } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                         anunciante_id, escolha_bloqueada_em)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2, now()) RETURNING id`,
    [`Padaria ${randomUUID().slice(0, 8)}`, contaId],
  );
  const pontoId = rows[0].id;
  criados.pontos.push(pontoId);
  const tela = await dispositivosRepo.criar(pontoId, {});
  if (instalar) await instalarPlayer(tela.id);
  return { pontoId, telaId: tela.id };
}

const recuarInicio = (pontoId) =>
  pool.query('UPDATE beneficios_basico_ponto SET inicio = $2 WHERE ponto_id = $1 AND fim IS NULL', [
    pontoId,
    INICIO_TESTE,
  ]);
const linhasDoBasico = async (pontoId) =>
  (await pool.query('SELECT * FROM beneficios_basico_ponto WHERE ponto_id = $1 ORDER BY id', [pontoId])).rows;
const tela = (telaId) => dispositivosRepo.buscarComPonto(telaId);

// ---------------------------------------------------------------------------

test('caso 1: conta comum, sem ponto, não tem Básico', async () => {
  const conta = await novaConta();
  assert.deepStrictEqual(await basicoRepo.ativosDaConta(conta.id), []);
  // Ponto cadastrado, mas sem Player instalado: ainda não é ponto ativo.
  const { pontoId } = await pontoDaConta(conta.id, { instalar: false });
  await basicoRepo.sincronizar({ apenasPontos: [pontoId] });
  assert.deepStrictEqual(await basicoRepo.ativosDaConta(conta.id), [], 'ponto sem tela instalada não dá Básico');
});

test('caso 2: conta vira ponto operacional → Básico ativo: 14 h, 1 ponto próprio, peça até 15 s', async () => {
  const conta = await novaConta();
  const { pontoId } = await pontoDaConta(conta.id);
  const [b] = await basicoRepo.ativosDaConta(conta.id);
  assert.ok(b, 'a instalação do Player ativa o Básico sem esperar o job');
  assert.strictEqual(b.ponto_id, pontoId, 'o ponto do Básico é o próprio estabelecimento');
  assert.strictEqual(b.horas_por_mes, 14);
  assert.strictEqual(b.segundos_por_hora, 140);
  assert.strictEqual(b.duracao_maxima_segundos, 15);
  assert.strictEqual(b.limite_criativos, 1);
  assert.strictEqual(horasDeTelaPorMes(b.segundos_por_hora, 1), 14, '140 s/h na régua da vitrine = 14 h/mês');
  const r = basicoRepo.resumo(b);
  assert.strictEqual(r.pontos, 1);
  // Não é plano comercial: nada em plano_id, nenhuma assinatura, nenhuma cobrança.
  const { rows } = await pool.query(
    `SELECT a.plano_id,
            (SELECT COUNT(*)::int FROM assinaturas WHERE anunciante_id = a.id) AS assinaturas,
            (SELECT COUNT(*)::int FROM cobrancas_confirmadas WHERE anunciante_id = a.id) AS cobrancas
       FROM anunciantes a WHERE a.id = $1`,
    [conta.id],
  );
  assert.deepStrictEqual(rows[0], { plano_id: null, assinaturas: 0, cobrancas: 0 });
});

test('caso 3: o mesmo evento rodando de novo não duplica o Básico', async () => {
  const conta = await novaConta();
  const { pontoId } = await pontoDaConta(conta.id);
  await basicoRepo.sincronizar({ apenasPontos: [pontoId] });
  await basicoRepo.sincronizar({ apenasPontos: [pontoId] });
  await Promise.all([
    basicoRepo.sincronizar({ apenasPontos: [pontoId] }),
    basicoRepo.sincronizar({ apenasPontos: [pontoId] }),
  ]);
  assert.strictEqual((await linhasDoBasico(pontoId)).length, 1);
});

test('casos 4 e 5: Básico + Essencial = 4 pontos e 41 h; Básico + Pro = 8 pontos e 98 h — origens separadas', async () => {
  for (const [planoId, pontos, horasPlano] of [
    ['essencial-1m', 4, 27],
    ['destaque-1m', 8, 84],
  ]) {
    const conta = await novaConta({ plano: planoId });
    await pontoDaConta(conta.id);
    const plano = (await pool.query('SELECT * FROM planos WHERE id = $1', [planoId])).rows[0];
    const basicos = await basicoRepo.ativosDaConta(conta.id);
    assert.strictEqual(basicos.length, 1, `${planoId}: o Básico continua depois do plano comercial`);
    const d = basicoRepo.direitosCombinados(plano, basicos);
    assert.strictEqual(d.pontos, pontos, `${planoId}: pontos somados`);
    assert.strictEqual(d.pontosPlano, pontos - 1);
    assert.strictEqual(d.pontosBasico, 1);
    assert.strictEqual(d.horasPlano, horasPlano, `${planoId}: horas do plano comercial`);
    assert.strictEqual(d.horasBasico, 14, 'horas do Básico');
    assert.strictEqual(d.horasPorMes, horasPlano + 14);
    // O plano comercial continua sendo o plano_id; o Básico nunca vira plano_id.
    assert.strictEqual((await anunciantesRepo.buscarPorId(conta.id)).plano_id, planoId);
  }
});

test('caso 6: plano comercial cancelado → o Básico continua', async () => {
  const conta = await novaConta({ plano: 'essencial-1m' });
  await pontoDaConta(conta.id);
  await pool.query('UPDATE anunciantes SET plano_id = NULL, data_expiracao = NULL WHERE id = $1', [conta.id]);
  const basicos = await basicoRepo.ativosDaConta(conta.id);
  assert.strictEqual(basicos.length, 1);
  const d = basicoRepo.direitosCombinados(null, basicos);
  assert.deepStrictEqual([d.pontos, d.horasPorMes, d.duracaoMaxima, d.limiteCriativos], [1, 14, 15, 1]);
});

test('caso 7: deixa de ser ponto → Básico termina; o Pro continua', async () => {
  const conta = await novaConta({ plano: 'destaque-1m' });
  const { pontoId } = await pontoDaConta(conta.id);
  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste' WHERE id = $1`,
    [pontoId],
  );
  // Antes do job: a leitura já não o considera ativo.
  assert.deepStrictEqual(await basicoRepo.ativosDaConta(conta.id), []);
  const { encerrados } = await basicoRepo.sincronizar({ apenasPontos: [pontoId] });
  assert.strictEqual(encerrados.length, 1);
  const [linha] = await linhasDoBasico(pontoId);
  assert.ok(linha.fim, 'o Básico tem fim registrado');
  assert.strictEqual(linha.motivo_fim, 'ponto_arquivado');
  assert.strictEqual((await anunciantesRepo.buscarPorId(conta.id)).plano_id, 'destaque-1m', 'o Pro não é tocado');
  // Tela em reparo NÃO encerra (não é "deixar de ser ponto").
  const outra = await novaConta();
  const p2 = await pontoDaConta(outra.id);
  await dispositivosRepo.atualizar(p2.telaId, { status: 'reparo' });
  assert.strictEqual((await basicoRepo.ativosDaConta(outra.id)).length, 1, 'reparo não encerra o Básico');
});

test('caso 8: o próprio ponto também escolhido no Essencial — uma linha, obrigação das duas origens, POP único', async () => {
  const conta = await novaConta({ plano: 'essencial-1m' });
  const ponto = await pontoDaConta(conta.id);
  await recuarInicio(ponto.pontoId);
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, now())', [
    conta.id,
    ponto.pontoId,
  ]);
  const hora = emMatao(3, 10);
  const playlist = await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), hora);
  const { rows } = await pool.query('SELECT * FROM exibicoes_contador WHERE anunciante_id = $1', [conta.id]);
  assert.strictEqual(rows.length, 1, 'uma linha só por conta, tela e hora — nada em dobro');
  const linha = rows[0];
  const basico = basicoRepo.insercoesDoBasicoNaHora(140, 15, hora) * 15;
  // Essencial: 90 s/h, 3 pontos contratados, 1 coberto → RN-49 concentra (270 s), 18 peças de 15 s.
  assert.strictEqual(linha.segundos_obrigacao_basico, basico, 'a parcela do Básico fica guardada à parte');
  assert.strictEqual(linha.segundos_obrigacao, 270 + basico, 'obrigação total = Essencial + Básico');
  const itens = playlist.itens.filter((i) => i.anuncianteId === conta.id);
  assert.strictEqual(itens.length, linha.vezes_programadas, 'o que foi programado cabe as duas origens');
  // POP: cada item conta uma vez, na mesma linha; reenvio do mesmo evento é duplicado.
  const evento = {
    execucaoId: randomUUID(),
    janelaId: playlist.janelaId,
    itemProgramacaoId: itens[0].itemProgramacaoId,
  };
  const momento = new Date(hora.getTime() + 30 * 60_000);
  assert.strictEqual((await confirmarComDedup(ponto.telaId, evento, momento)).status, 'contabilizado');
  assert.strictEqual((await confirmarComDedup(ponto.telaId, evento, momento)).status, 'duplicado');
  const depois = (await pool.query('SELECT vezes_confirmadas FROM exibicoes_contador WHERE id = $1', [linha.id]))
    .rows[0];
  assert.strictEqual(depois.vezes_confirmadas, 1);
});

test('caso 9: Saldo — 14 h são a fonte de verdade; 3.360 exibições equivalentes de 15 s, sem arredondar hora a hora', async () => {
  // 360 horas abertas (12 h × 30 dias) a partir de qualquer hora: a sequência
  // soma exatamente 140 s × 360 = 50.400 s = 14 h.
  for (const inicio of [0, 7, 123457]) {
    let insercoes = 0;
    for (let k = inicio; k < inicio + 360; k++) insercoes += basicoRepo.insercoesDoBasicoNaHora(140, 15, k * 3_600_000);
    assert.strictEqual(insercoes, 3360, 'exibições equivalentes de 15 s');
    assert.strictEqual(insercoes * 15, 50_400, '14 h em segundos');
  }
  // Peça de 20 s: 140 ÷ 20 = 7 por hora exatas.
  assert.strictEqual(basicoRepo.insercoesDoBasicoNaHora(140, 20, emMatao(3, 9)), 7);

  // Conta só com o Básico: a hora aberta grava a obrigação do Básico inteira.
  const conta = await novaConta();
  const ponto = await pontoDaConta(conta.id);
  await recuarInicio(ponto.pontoId);
  const hora = emMatao(3, 11);
  const playlist = await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), hora);
  const [linha] = (await pool.query('SELECT * FROM exibicoes_contador WHERE anunciante_id = $1', [conta.id])).rows;
  const esperado = basicoRepo.insercoesDoBasicoNaHora(140, 15, hora);
  assert.strictEqual(linha.vezes_programadas, esperado);
  assert.strictEqual(linha.segundos_obrigacao, esperado * 15);
  assert.strictEqual(linha.segundos_obrigacao_basico, esperado * 15, 'tudo da origem Básico');
  assert.strictEqual(playlist.itens.filter((i) => i.anuncianteId === conta.id).length, esperado);

  // Hora aberta sem sinal (a TV não pediu): a rede de segurança cobra o Básico
  // que valia NAQUELA hora; antes do início dele, nada.
  // A rede de segurança só olha tela de ponto em operação (primeiro sinal)
  // instalada antes da hora: o relógio do teste é agosto.
  await pool.query('UPDATE dispositivos SET primeiro_sinal_em = $2, provisionado_em = $2 WHERE id = $1', [
    ponto.telaId,
    INICIO_TESTE,
  ]);
  await require('../src/pontos/repository').sincronizarStatusPonto(ponto.pontoId);
  const semSinal = emMatao(4, 10);
  const antes = emMatao(1, 0);
  await pool.query('UPDATE beneficios_basico_ponto SET inicio = $2 WHERE ponto_id = $1', [
    ponto.pontoId,
    new Date(antes.getTime() + 3_600_000),
  ]);
  await registrarHorasSemPedido({
    de: antes,
    ate: new Date(semSinal.getTime() + 3_600_000),
    apenasContas: [conta.id],
    apenasTelas: [ponto.telaId],
  });
  const { rows } = await pool.query(
    'SELECT janela_hora, segundos_obrigacao, segundos_obrigacao_basico FROM exibicoes_contador WHERE anunciante_id = $1 AND obrigacao_sem_pedido',
    [conta.id],
  );
  const naHora = rows.find((r) => new Date(r.janela_hora).getTime() === semSinal.getTime());
  assert.ok(naHora, 'a hora sem sinal depois da primeira servida tem obrigação');
  assert.strictEqual(naHora.segundos_obrigacao_basico, naHora.segundos_obrigacao);
  assert.ok(!rows.some((r) => new Date(r.janela_hora) < hora), 'antes da primeira hora servida, nada (regra do Saldo)');
});

test('caso 10: conta com Básico recebe o +1 crédito/mês, sem duplicar', async () => {
  const conta = await novaConta();
  const { pontoId } = await pontoDaConta(conta.id);
  const agora = new Date('2026-08-15T15:00:00Z');
  await concederCreditosMensais({ agora, apenasPontos: [pontoId] });
  await concederCreditosMensais({ agora, apenasPontos: [pontoId] });
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantidade), 0)::int AS saldo FROM creditos_ledger
      WHERE anunciante_id = $1 AND tipo = 'credito_mensal_ponto'`,
    [conta.id],
  );
  assert.deepStrictEqual(rows[0], { n: 1, saldo: 1 });
  const situacao = (await situacaoDosPontos([pontoId], agora)).get(pontoId);
  assert.strictEqual(situacao.creditoDoMesConcedido, true, 'crédito do mês');
  assert.strictEqual(situacao.basico?.horasPorMes, 14, 'e o Básico, separado, no mesmo ponto');
});
