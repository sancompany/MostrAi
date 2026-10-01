require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
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
const { obrigacaoVencida } = require('./apoio-obrigacao');

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
  if (plano) await comPlano(conta.id, plano);
  await criativoAprovado(conta.id, duracao);
  return conta;
}

const comPlano = (contaId, plano) =>
  pool.query(
    `UPDATE anunciantes SET plano_id = $2, data_inicio_cobertura = '2026-07-01', data_expiracao = '2099-12-31' WHERE id = $1`,
    [contaId, plano],
  );

async function criativoAprovado(contaId, duracao) {
  const criativo = await criativosRepo.criar({
    anunciante_id: contaId,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/basico-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: duracao,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  return criativo;
}

// Rotas do anunciante com a sessão da conta no cabeçalho (o mesmo apoio de
// tests/meus-criativos.test.js).
async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-basico', resave: false, saveUninitialized: false }));
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
    get: async (caminho, conta) => {
      const r = await fetch(`${base}${caminho}`, { headers: { 'x-conta': String(conta) } });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    post: async (caminho, conta) => {
      const r = await fetch(`${base}${caminho}`, { method: 'POST', headers: { 'x-conta': String(conta) } });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    fechar: () => new Promise((r) => server.close(r)),
  };
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

const recuarInicio = (pontoId, inicio = INICIO_TESTE) =>
  pool.query('UPDATE beneficios_basico_ponto SET inicio = $2 WHERE ponto_id = $1 AND fim IS NULL', [pontoId, inicio]);

// Ponto em operação (primeiro sinal): é o que põe o ponto na régua da
// cobertura (`pontosEmOperacao`) e na rede de segurança do Saldo.
async function emOperacao({ pontoId, telaId }) {
  await pool.query('UPDATE dispositivos SET primeiro_sinal_em = $2, provisionado_em = $2 WHERE id = $1', [
    telaId,
    INICIO_TESTE,
  ]);
  await require('../src/pontos/repository').sincronizarStatusPonto(pontoId);
}

// Saldo de Veiculação pronto (segundos), do mês anterior, como a apuração deixaria.
// Saldo atrasado de um ciclo antigo (migration 111: a obrigação nasce do
// ciclo contratado, e o gerador devolve o atraso na capacidade ociosa).
const saldoNoBanco = (contaId, segundos) => obrigacaoVencida(contaId, segundos);
const bancoProgramado = async (contaId, telaId, hora) =>
  (
    await pool.query(
      'SELECT vezes_banco FROM exibicoes_contador WHERE anunciante_id = $1 AND dispositivo_id = $2 AND janela_hora = $3',
      [contaId, telaId, hora],
    )
  ).rows[0]?.vezes_banco;
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
    // Plano sem teto de peça (NULL — migration 045) continua sem teto com o
    // Básico junto: o maior dos dois não vira os 15 s do Básico.
    const semTeto = basicoRepo.direitosCombinados({ ...plano, duracao_maxima_segundos: null }, basicos);
    assert.strictEqual(semTeto.duracaoMaxima, null, `${planoId}: sem teto continua sem teto`);
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
  await recuarInicio(pontoId);
  // Arquivado há 5 h, e só agora a sincronização vê.
  const arquivadoEm = new Date(Date.now() - 5 * 3_600_000);
  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = $2, motivo_arquivamento = 'teste' WHERE id = $1`,
    [pontoId, arquivadoEm],
  );
  // Antes do job: a leitura já não o considera ativo.
  assert.deepStrictEqual(await basicoRepo.ativosDaConta(conta.id), []);
  const { encerrados } = await basicoRepo.sincronizar({ apenasPontos: [pontoId] });
  assert.strictEqual(encerrados.length, 1);
  const [linha] = await linhasDoBasico(pontoId);
  assert.ok(linha.fim, 'o Básico tem fim registrado');
  assert.strictEqual(linha.motivo_fim, 'ponto_arquivado');
  // O fim é o instante do arquivamento, não o da sincronização: a rede de
  // segurança do Saldo não cobra as horas entre os dois.
  assert.strictEqual(new Date(linha.fim).getTime(), arquivadoEm.getTime(), 'fim = quando foi arquivado');
  assert.strictEqual(basicoRepo.valiaNaHora(linha, new Date(arquivadoEm.getTime() + 3_600_000)), false);
  assert.strictEqual(basicoRepo.valiaNaHora(linha, new Date(arquivadoEm.getTime() - 3_600_000)), true);
  assert.strictEqual((await anunciantesRepo.buscarPorId(conta.id)).plano_id, 'destaque-1m', 'o Pro não é tocado');
  // Tela em reparo NÃO encerra (não é "deixar de ser ponto").
  const outra = await novaConta();
  const p2 = await pontoDaConta(outra.id);
  await dispositivosRepo.atualizar(p2.telaId, { status: 'reparo' });
  assert.strictEqual((await basicoRepo.ativosDaConta(outra.id)).length, 1, 'reparo não encerra o Básico');
});

// Fechamento da estação (28/09/2026, migration 106): a régua é a tela
// INSTALADA, nunca o sinal. Problema temporário mantém; ficar sem nenhuma
// tela instalada encerra; tela nova reabre, sem duplicar, com histórico.
test('regra estrutural: sem sinal e reparo mantêm; sem tela instalada encerra; tela nova volta sem duplicar', async () => {
  const conta = await novaConta({ plano: 'destaque-1m' });
  const ponto = await pontoDaConta(conta.id);
  await emOperacao(ponto);
  const { revogar } = require('../src/player/credencial');
  const ativos = async () => (await basicoRepo.ativosDaConta(conta.id)).length;
  const sincronizar = () => basicoRepo.sincronizar({ apenasPontos: [ponto.pontoId] });

  // Offline temporário: TV sem heartbeat há 30 dias continua sendo ponto.
  await pool.query(`UPDATE dispositivos SET ultima_vez_online = now() - interval '30 days' WHERE id = $1`, [
    ponto.telaId,
  ]);
  assert.strictEqual((await sincronizar()).encerrados.length, 0, 'sem sinal não encerra');
  assert.strictEqual(await ativos(), 1);

  // Reparo: temporário por definição — mantém, e voltar a ativa não abre outro.
  await dispositivosRepo.atualizar(ponto.telaId, { status: 'reparo' });
  assert.strictEqual(await ativos(), 1, 'reparo não encerra');
  await dispositivosRepo.atualizar(ponto.telaId, { status: 'ativo' });
  assert.strictEqual((await linhasDoBasico(ponto.pontoId)).length, 1, 'mesma linha, sem reabrir');

  // Duas telas: revogar uma não encerra; revogar a última encerra.
  const segunda = await dispositivosRepo.criar(ponto.pontoId, {});
  await instalarPlayer(segunda.id);
  await revogar(ponto.telaId);
  assert.strictEqual(await ativos(), 1, 'ainda há uma tela instalada');
  await revogar(segunda.id);
  assert.strictEqual(await ativos(), 0, 'todas revogadas → encerra');
  let linhas = await linhasDoBasico(ponto.pontoId);
  assert.strictEqual(linhas.length, 1);
  assert.strictEqual(linhas[0].motivo_fim, 'sem_tela_instalada');
  assert.ok(linhas[0].fim);

  // Tela nova instalada: volta — uma linha nova, a antiga fica no histórico.
  await instalarPlayer(ponto.telaId);
  await sincronizar();
  await sincronizar();
  linhas = await linhasDoBasico(ponto.pontoId);
  assert.strictEqual(linhas.length, 2, 'histórico preservado');
  assert.strictEqual(linhas.filter((l) => !l.fim).length, 1, '1 ponto → no máximo 1 Básico ativo');
  assert.strictEqual(await ativos(), 1);

  // Removida em definitivo (inativo) a última instalada → encerra.
  await dispositivosRepo.deletar(segunda.id);
  assert.strictEqual(await ativos(), 1, 'excluir tela revogada não muda nada');
  await dispositivosRepo.atualizar(ponto.telaId, { status: 'inativo' });
  assert.strictEqual(await ativos(), 0, 'última tela inativa → encerra');
  assert.strictEqual((await linhasDoBasico(ponto.pontoId)).at(-1).motivo_fim, 'sem_tela_instalada');

  // Reparo com a credencial revogada: revogar vence o reparo → encerra
  // (revisão Codex do #96).
  const reparada = await pontoDaConta(conta.id);
  await dispositivosRepo.atualizar(reparada.telaId, { status: 'reparo' });
  assert.ok(await basicoRepo.ativoNoPonto(reparada.pontoId), 'reparo com credencial mantém');
  await revogar(reparada.telaId);
  assert.strictEqual(await basicoRepo.ativoNoPonto(reparada.pontoId), null, 'reparo revogado → encerra');
  assert.strictEqual((await linhasDoBasico(reparada.pontoId))[0].motivo_fim, 'sem_tela_instalada');

  // Antes do job ver (tela tirada por fora da sincronização): a leitura do
  // painel/admin já não mostra o Básico, igual à leitura dos direitos.
  const semJob = await pontoDaConta(conta.id);
  assert.ok((await situacaoDosPontos([semJob.pontoId])).get(semJob.pontoId).basico, 'com tela: aparece');
  await pool.query('UPDATE dispositivos SET chave_hash = NULL WHERE id = $1', [semJob.telaId]);
  assert.strictEqual((await situacaoDosPontos([semJob.pontoId])).get(semJob.pontoId).basico, null);
  assert.strictEqual(await basicoRepo.ativoNoPonto(semJob.pontoId), null);

  // Última tela excluída → encerra.
  const outro = await pontoDaConta(conta.id);
  assert.strictEqual(await ativos(), 1);
  await dispositivosRepo.deletar(outro.telaId);
  assert.strictEqual(await ativos(), 0, 'última tela excluída → encerra');

  // O plano comercial não é tocado em nenhum passo.
  assert.strictEqual((await anunciantesRepo.buscarPorId(conta.id)).plano_id, 'destaque-1m');
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
  // 14 h/mês na régua da vitrine = 12 h abertas × 30 dias. A sequência fecha
  // exata em QUALQUER horário de funcionamento, não só em múltiplo de 3 h
  // (revisão independente, 28/09/2026: aberto 10 h/dia dava 2.790 ou 2.820).
  const noMes = (duracao, abre, fecha, dia0) => {
    let n = 0;
    for (let dia = dia0; dia < dia0 + 30; dia++)
      for (let h = abre; h < fecha; h++) n += basicoRepo.insercoesDoBasicoNaHora(140, duracao, emMatao(dia, h));
    return n;
  };
  for (const dia0 of [1, 2, 3]) {
    const insercoes = noMes(15, 8, 20, dia0);
    assert.strictEqual(insercoes, 3360, 'exibições equivalentes de 15 s');
    assert.strictEqual(insercoes * 15, 50_400, '14 h em segundos');
    assert.strictEqual(noMes(15, 8, 18, dia0), 2800, '10 h/dia: 140 s × 300 h ÷ 15 s');
    assert.strictEqual(noMes(15, 12, 22, dia0), 2800, '10 h/dia em outro horário');
    assert.strictEqual(noMes(12, 7, 21, dia0), 4900, '14 h/dia, peça de 12 s: 140 s × 420 h ÷ 12 s');
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

// --- Achados da revisão independente (28/09/2026) ---------------------------

test('a parte Básico congela junto com o total: extra com total fixado não quebra a playlist', async () => {
  // A hora do deploy: a conta entrou no meio da hora (extra) e a linha dela
  // ficou com o total sem parte Básico; num poll seguinte, o Básico já vale.
  const conta = await novaConta();
  const ponto = await pontoDaConta(conta.id);
  const hora = emMatao(5, 10);
  await recuarInicio(ponto.pontoId, new Date(hora.getTime() + 2 * 3_600_000));
  await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), hora, new Date(hora.getTime() + 5 * 60_000));
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas,
                                     vezes_banco, segundos_obrigacao, duracao_segundos, minutos_abertos)
     VALUES ($1, $2, $3, 2, 2, 0, 30, 15, 60)`,
    [conta.id, ponto.telaId, hora],
  );
  await recuarInicio(ponto.pontoId);
  const playlist = await gerador.gerarPlaylistDaHora(
    await tela(ponto.telaId),
    hora,
    new Date(hora.getTime() + 20 * 60_000),
  );
  assert.ok(
    playlist.itens.some((i) => i.anuncianteId === conta.id),
    'a conta entra no fim da hora congelada',
  );
  const [linha] = (
    await pool.query(
      'SELECT segundos_obrigacao, segundos_obrigacao_basico FROM exibicoes_contador WHERE anunciante_id = $1 AND janela_hora = $2',
      [conta.id, hora],
    )
  ).rows;
  assert.deepStrictEqual(linha, { segundos_obrigacao: 30, segundos_obrigacao_basico: null }, 'o par fica o congelado');
});

test('Saldo de Veiculação: dividido pelos pontos do Básico também, sem puxar o saldo inteiro em cada ponto', async () => {
  // Dona de três estabelecimentos, só com o Básico. Dois puxam o saldo (este,
  // gerando agora, e outro em operação); o terceiro está com a tela em
  // reparo — o Básico continua, mas o ponto não gera playlist, não puxa saldo
  // e não entra na divisão (revisão Codex do #93).
  const dona = await novaConta();
  const p1 = await pontoDaConta(dona.id);
  await pontoDaConta(dona.id);
  const emReparo = await pontoDaConta(dona.id);
  await dispositivosRepo.atualizar(emReparo.telaId, { status: 'reparo' });
  assert.strictEqual((await basicoRepo.ativosDaConta(dona.id)).length, 3, 'reparo não encerra o Básico');
  await recuarInicio(p1.pontoId);
  await saldoNoBanco(dona.id, 150);
  const hora = emMatao(6, 10);
  await gerador.gerarPlaylistDaHora(await tela(p1.telaId), hora);
  assert.strictEqual(await bancoProgramado(dona.id, p1.telaId, hora), 5, '150 s ÷ 2 pontos que puxam ÷ 15 s');

  // Essencial num ponto de outro + Básico no próprio (barrada nele pela trava
  // de ramo, sem escolher o próprio): os dois pontos dividem o mesmo saldo.
  const { rows: cat } = await pool.query('SELECT id FROM categorias WHERE ativo ORDER BY id LIMIT 1');
  const conta = await novaConta({ plano: 'essencial-1m' });
  const proprio = await pontoDaConta(conta.id);
  await pool.query('UPDATE anunciantes SET categoria_id = $2 WHERE id = $1', [conta.id, cat[0].id]);
  await pool.query('UPDATE pontos SET categoria_id = $2 WHERE id = $1', [proprio.pontoId, cat[0].id]);
  await recuarInicio(proprio.pontoId);
  const outro = await pontoDaConta((await novaConta()).id);
  await emOperacao(outro);
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, now())', [
    conta.id,
    outro.pontoId,
  ]);
  await saldoNoBanco(conta.id, 180);
  // `agora` = a própria hora: a obrigação do Básico desta hora ainda não é
  // atraso (a hora está sendo entregue) — só os 180 s antigos são.
  await gerador.gerarPlaylistDaHora(await tela(proprio.telaId), hora, hora);
  assert.strictEqual(await bancoProgramado(conta.id, proprio.telaId, hora), 6, 'no próprio (Básico): 180 s ÷ 2 ÷ 15 s');
  // Na outra tela, o saldo que sobrou (180 − 90 já programados) também ÷ 2.
  await gerador.gerarPlaylistDaHora(await tela(outro.telaId), hora, hora);
  assert.strictEqual(
    await bancoProgramado(conta.id, outro.telaId, hora),
    3,
    'no escolhido (comercial): 90 s ÷ 2 ÷ 15 s',
  );
});

test('rede de segurança: com o comercial vencido na hora, o Básico usa a peça do Básico, como ao vivo', async () => {
  // Destaque: 2 peças no ar (5 s e 15 s, média 10 s); o Básico roda 1 — a mais nova, 15 s.
  const conta = await novaConta({ plano: 'destaque-1m', duracao: 5 });
  await criativoAprovado(conta.id, 15);
  const ponto = await pontoDaConta(conta.id);
  await emOperacao(ponto);
  await recuarInicio(ponto.pontoId);
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, now())', [
    conta.id,
    ponto.pontoId,
  ]);
  // Uma hora servida com o plano valendo (a rede de segurança só cobra depois dela).
  const servida = emMatao(3, 10);
  await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), servida);
  await pool.query('UPDATE anunciantes SET data_expiracao = $2 WHERE id = $1', [
    conta.id,
    new Date(servida.getTime() + 2 * 3_600_000),
  ]);
  const semSinal = emMatao(4, 10);
  await registrarHorasSemPedido({
    de: semSinal,
    ate: new Date(semSinal.getTime() + 3_600_000),
    apenasContas: [conta.id],
    apenasTelas: [ponto.telaId],
  });
  const [linha] = (
    await pool.query(
      `SELECT segundos_obrigacao, segundos_obrigacao_basico, duracao_segundos FROM exibicoes_contador
        WHERE anunciante_id = $1 AND janela_hora = $2 AND obrigacao_sem_pedido`,
      [conta.id, semSinal],
    )
  ).rows;
  const basico = basicoRepo.insercoesDoBasicoNaHora(140, 15, semSinal) * 15;
  assert.deepStrictEqual(
    linha,
    { segundos_obrigacao: basico, segundos_obrigacao_basico: basico, duracao_segundos: 15 },
    'só o Básico valia: peça de 15 s, não a média de 10 s do plano',
  );
});

test('vaga do Básico: peça acima do teto da conta não toca pelo Básico nem toma a vez da que cabe', async () => {
  // Só com o Básico (teto 15 s): a peça que cabe é a mais antiga; a mais nova
  // tem 30 s (sobra de um plano vencido, ou subida pelo operador).
  const conta = await novaConta();
  const curta = (await pool.query('SELECT id FROM criativos WHERE anunciante_id = $1', [conta.id])).rows[0].id;
  const ponto = await pontoDaConta(conta.id);
  await recuarInicio(ponto.pontoId);
  const longa = await criativoAprovado(conta.id, 30);
  const [b] = await basicoRepo.ativosDaConta(conta.id);
  assert.deepStrictEqual(
    (await basicoRepo.pecasDoBasico(b)).map((p) => p.criativoId),
    [curta],
    'a de 15 s, não a de 30 s mais nova',
  );
  const playlist = await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), emMatao(7, 10));
  const itens = playlist.itens.filter((i) => i.anuncianteId === conta.id);
  assert.ok(itens.length > 0, 'o Básico toca, com a peça que cabe');
  assert.ok(
    itens.every((i) => i.criativoId === String(curta)),
    'a de 30 s não entra na vaga do Básico',
  );
  // O painel diz o mesmo — e o motivo é a duração, não "espere outra sair".
  const app = await subirApp();
  try {
    const r = await app.get('/anunciantes/me/criativos', conta.id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    const por = Object.fromEntries(r.corpo.criativos.map((c) => [c.id, c]));
    assert.strictEqual(por[longa.id].entrada.motivo, 'acima_da_duracao_maxima');
    assert.ok(!['acima_da_duracao_maxima', 'fora_do_limite_de_pecas'].includes(por[curta].entrada.motivo));
  } finally {
    await app.fechar();
  }
  // Com o plano comercial valendo (Destaque, peça até 20 s), o teto é o da
  // conta — o maior das origens: a peça de 20 s cabe na vaga do Básico.
  await comPlano(conta.id, 'destaque-1m');
  const media = await criativoAprovado(conta.id, 20);
  assert.deepStrictEqual(
    (await basicoRepo.pecasDoBasico(b)).map((p) => p.criativoId),
    [media.id],
  );
});

// Integração do PR #92 (29/09/2026): pausar/retomar a própria peça usa a MESMA
// régua do upload — os direitos somados do plano e do Básico. Conta só com o
// Básico (sem plano comercial) retoma a peça que pausou; antes o #92 conferia
// só o plano e respondia "sua conta está sem plano".
test('pausar e retomar a própria peça: conta só com o Básico retoma, dentro da vaga do Básico', async () => {
  const conta = await novaConta();
  await pontoDaConta(conta.id);
  const [b] = await basicoRepo.ativosDaConta(conta.id);
  assert.ok(b && b.limite_criativos === 1, 'Básico ativo, 1 peça');
  const { rows } = await pool.query(`SELECT id FROM criativos WHERE anunciante_id = $1 AND status = 'aprovado'`, [
    conta.id,
  ]);
  const pecaId = rows[0].id;
  const app = await subirApp();
  try {
    let r = await app.post(`/anunciantes/me/criativos/${pecaId}/pausar`, conta.id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    // Outra peça aprovada ocupa a única vaga do Básico: retomar é recusado.
    const outra = await criativoAprovado(conta.id, 15);
    r = await app.post(`/anunciantes/me/criativos/${pecaId}/retomar`, conta.id);
    assert.strictEqual(r.status, 409, 'sem vaga no Básico');
    assert.match(r.corpo.erro, /até 1 criativo/);
    // Liberada a vaga, retoma.
    await criativosRepo.atualizar(outra.id, { status: 'reprovado' });
    r = await app.post(`/anunciantes/me/criativos/${pecaId}/retomar`, conta.id);
    assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
    const { rows: depois } = await pool.query('SELECT status, retirado_por FROM criativos WHERE id = $1', [pecaId]);
    assert.deepStrictEqual(depois[0], { status: 'aprovado', retirado_por: null });
  } finally {
    await app.fechar();
  }
});
