const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const { confirmarComDedup } = require('../src/playlist/execucoes-repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const bancoHorasRepo = require('../src/bancohoras/repository');
const { apurarMes, liquidarBancoConfirmado, recomporMesAnteriorEmPrazo } = require('../src/bancohoras/apuracao');
const { registrarHorasSemPedido, registrarHorasRecemFechadas } = require('../src/bancohoras/obrigacao');
const midiasRepo = require('../src/midias/repository');
const sinal = require('../src/player/sinal');
const { montarHoraDeTv, segundosDeObrigacao, segundosCompensados } = require('../src/lib/pacing');
const { instalarPlayer } = require('./apoio-player');
const { obrigacaoVencida } = require('./apoio-obrigacao');
const obrigacaoDoCiclo = require('../src/bancohoras/obrigacao-do-ciclo');

// Saldo de Veiculação (banco de horas) — estação de 27/09/2026. Mapa e
// invariantes: docs/specs/2026-09-27-saldo-de-veiculacao.md.
//
// RELÓGIO CONTROLADO: nada aqui espera hora nem mês de verdade. A hora da
// playlist é parâmetro do gerador, o `agora` do comprovante é parâmetro da
// confirmação, e a apuração recebe o mês (fechado) e o `agora`. Os dias
// simulados ficam em agosto de 2026 (mês fechado): 03/08/2026 é segunda.
//
// ISOLAMENTO: os arquivos de teste rodam em paralelo no mesmo banco. Todo
// ponto daqui nasce com a escolha automática bloqueada (conta de outro
// arquivo não cai nele por sorteio) e toda conta daqui ESCOLHE os pontos.

// Hora local de Matão (UTC−3, sem horário de verão) → instante UTC. Mês 8 =
// agosto (padrão), 9 = setembro.
const emMatao = (dia, hora, { minuto = 0, mes = 8 } = {}) => new Date(Date.UTC(2026, mes - 1, dia, hora + 3, minuto));
const COMERCIAL = { abre: '08:00', fecha: '18:00' };
const HORARIO_COMERCIAL = {
  seg: COMERCIAL,
  ter: COMERCIAL,
  qua: COMERCIAL,
  qui: COMERCIAL,
  sex: COMERCIAL,
  sab: null,
  dom: null,
};

const criados = { contas: [], pontos: [], planos: [], midias: [] };

test.after(async () => {
  for (const id of criados.midias) {
    await pool.query('DELETE FROM midias_exibicoes_contador WHERE midia_id = $1', [id]);
    await pool.query('DELETE FROM midias_proprias WHERE id = $1', [id]);
  }
  for (const contaId of criados.contas) {
    await pool.query('DELETE FROM banco_horas WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
  }
  for (const pontoId of criados.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM midias_exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
  for (const planoId of criados.planos) await pool.query('DELETE FROM planos WHERE id = $1', [planoId]);
});

// Plano próprio do teste: os números ficam na mão do teste, não na grade.
async function novoPlano({ segundos = 600, pontos = 1 } = {}) {
  const id = `saldo-${randomUUID().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO planos (id, tier, nome, valor_mensal, compromisso_meses, cobertura, ativo,
                         frequencia_hora, segundos_por_hora, duracao_maxima_segundos, pontos_incluidos, limite_criativos)
     VALUES ($1, 'essencial', 'Plano de teste do saldo', 1, 1, 'todos_pontos', false, 1, $2, 30, $3, 3)`,
    [id, segundos, pontos],
  );
  criados.planos.push(id);
  return id;
}

async function novaConta({ plano, duracao = 15 } = {}) {
  // Conta própria (Mídia) nunca passa por aqui.
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Saldo ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `saldo-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criados.contas.push(conta.id);
  await pool.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [conta.id, plano]);
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/saldo-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: duracao,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  return { id: conta.id, criativoId: criativo.id };
}

// Ponto em operação, fora do sorteio automático, com uma tela instalada.
async function novoPonto({ horario = null } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                         horario_semanal, escolha_bloqueada_em)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2, now()) RETURNING id`,
    [`Saldo ${randomUUID().slice(0, 8)}`, horario ? JSON.stringify(horario) : null],
  );
  const pontoId = rows[0].id;
  criados.pontos.push(pontoId);
  const tela = await dispositivosRepo.criar(pontoId, {});
  await instalarPlayer(tela.id);
  return { pontoId, telaId: tela.id };
}

async function escolher(contaId, ...pontos) {
  for (const pontoId of pontos) {
    await pool.query(
      'INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, clock_timestamp())',
      [contaId, pontoId],
    );
  }
}

const tela = (telaId) => dispositivosRepo.buscarComPonto(telaId);

async function linhas(contaId) {
  const { rows } = await pool.query(
    'SELECT * FROM exibicoes_contador WHERE anunciante_id = $1 ORDER BY janela_hora, dispositivo_id',
    [contaId],
  );
  return rows;
}

// A TV tocou até o fim `quantas` peças da conta na hora (o POST /played de
// cada uma, pelo mesmo caminho da rota: dedupe por execucaoId + crédito).
async function tocar(telaId, playlist, contaId, quantas = Number.POSITIVE_INFINITY, agora = null) {
  const itens = playlist.itens.filter((i) => i.anuncianteId === contaId).slice(0, quantas);
  const momento = agora || new Date(new Date(playlist.janelaInicio).getTime() + 30 * 60_000);
  for (const item of itens) {
    const r = await confirmarComDedup(
      telaId,
      { execucaoId: randomUUID(), janelaId: playlist.janelaId, itemProgramacaoId: item.itemProgramacaoId },
      momento,
    );
    assert.strictEqual(r.status, 'contabilizado', `POP de ${item.itemProgramacaoId}`);
  }
  return itens.length;
}

async function saldoDoMes(contaId, mes = '2026-08') {
  const { rows } = await pool.query(
    `SELECT * FROM banco_horas WHERE anunciante_id = $1 AND mes_referencia = to_date($2, 'YYYY-MM')`,
    [contaId, mes],
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// C. Regressões do ponto fechado (reproduzidas antes da correção)
// ---------------------------------------------------------------------------

test('ponto fechado: a hora fechada não grava programada comercial nenhuma', async () => {
  const plano = await novoPlano({ segundos: 600 });
  const conta = await novaConta({ plano });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);

  // Segunda 03:00 em Matão: a TV pede playlist (o Player pede a noite toda).
  const playlist = await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), emMatao(3, 3));
  assert.ok(Array.isArray(playlist.itens), 'a playlist ainda responde tecnicamente');
  assert.deepStrictEqual(await linhas(conta.id), [], 'nenhuma obrigação, programada ou banco em hora fechada');
});

test('ponto fechado: um dia inteiro entregue no horário aberto fecha o mês com saldo ZERO', async () => {
  const plano = await novoPlano({ segundos: 600 }); // 40 peças de 15 s por hora
  const conta = await novaConta({ plano });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);

  // Segunda 03/08: a TV pede a playlist nas 24 horas; toca tudo que é da
  // conta nas horas abertas (08–18) e nada nas fechadas (tela apagada).
  for (let h = 0; h < 24; h++) {
    const playlist = await gerador.gerarPlaylistDaHora(await tela(ponto.telaId), emMatao(3, h));
    if (h >= 8 && h < 18) await tocar(ponto.telaId, playlist, conta.id);
  }
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  const mes = await saldoDoMes(conta.id);
  // Era 120 exibições de dívida falsa (a madrugada rolava e estourava na
  // abertura). Agora: 10 horas abertas × 600 s devidos, tudo confirmado.
  assert.strictEqual(Number(mes.segundos_obrigacao), 10 * 600, 'só as horas abertas devem');
  assert.strictEqual(Number(mes.segundos_entregues), 10 * 600);
  assert.strictEqual(Number(mes.segundos_banco), 0, 'madrugada e noite fechadas não viram dívida');
  assert.strictEqual(mes.status, 'drenado', 'mês apurado, nada a devolver (linha de auditoria)');
  const fechadas = (await linhas(conta.id)).filter((l) => {
    const h = new Date(l.janela_hora).getUTCHours() - 3;
    return h < 8 || h >= 18;
  });
  assert.deepStrictEqual(fechadas, [], 'nenhuma linha comercial em hora fechada');
});

// ---------------------------------------------------------------------------
// Horário: 24 h, parcial, meia-noite, feriado, fuso
// ---------------------------------------------------------------------------

const gerar = async (telaId, instante, agora) => gerador.gerarPlaylistDaHora(await tela(telaId), instante, agora);
const linhaDa = async (contaId, instante) =>
  (await linhas(contaId)).find((l) => new Date(l.janela_hora).getTime() === instante.getTime());

test('horário: ponto 24 h deve toda hora, inclusive a madrugada', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto(); // sem horário = 24 h
  await escolher(conta.id, ponto.pontoId);
  for (const h of [2, 3]) await tocar(ponto.telaId, await gerar(ponto.telaId, emMatao(8, h)), conta.id);
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  const mes = await saldoDoMes(conta.id);
  assert.strictEqual(Number(mes.segundos_obrigacao), 1200, 'sábado de madrugada, aberto: 2 × 600 s');
  assert.strictEqual(Number(mes.segundos_banco), 0);
});

test('horário parcial: abre 09:30 → a hora das 9 deve 30 min, e o pedaço fechado não rola como déficit', async () => {
  const meiaHora = { abre: '09:30', fecha: '18:00' };
  const horario = { seg: meiaHora, ter: meiaHora, qua: meiaHora, qui: meiaHora, sex: meiaHora, sab: null, dom: null };
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario });
  await escolher(conta.id, ponto.pontoId);

  const nove = await gerar(ponto.telaId, emMatao(3, 9));
  await tocar(ponto.telaId, nove, conta.id, 20); // a tela acendeu 09:30: metade tocou
  const l9 = await linhaDa(conta.id, emMatao(3, 9));
  assert.strictEqual(l9.minutos_abertos, 30);
  assert.strictEqual(l9.segundos_obrigacao, 300, 'deve só os 30 min abertos');

  await tocar(ponto.telaId, await gerar(ponto.telaId, emMatao(3, 10)), conta.id);
  const l10 = await linhaDa(conta.id, emMatao(3, 10));
  assert.strictEqual(l10.vezes_pedidas, 40, 'nada do pedaço fechado das 9 rolou pras 10');
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 0);
});

test('horário que cruza a meia-noite: a madrugada de sábado pertence à sexta', async () => {
  const horario = {
    seg: null,
    ter: null,
    qua: null,
    qui: null,
    sex: { abre: '18:00', fecha: '02:00' },
    sab: null,
    dom: null,
  };
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario });
  await escolher(conta.id, ponto.pontoId);
  for (const [dia, h] of [
    [7, 17],
    [7, 18],
    [8, 1],
    [8, 3],
  ])
    await gerar(ponto.telaId, emMatao(dia, h));
  assert.ok(!(await linhaDa(conta.id, emMatao(7, 17))), 'sexta 17h: fechado');
  assert.ok(await linhaDa(conta.id, emMatao(7, 18)), 'sexta 18h: aberto');
  assert.ok(await linhaDa(conta.id, emMatao(8, 1)), 'sábado 01h: ainda é a noite de sexta');
  assert.ok(!(await linhaDa(conta.id, emMatao(8, 3))), 'sábado 03h: fechado');
});

test('feriado: ponto fechado no feriado não deve nada nesse dia', async () => {
  const dia = { abre: '08:00', fecha: '18:00' };
  const horario = { seg: dia, ter: dia, qua: dia, qui: dia, sex: dia, sab: null, dom: null, feriados: null };
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario });
  await escolher(conta.id, ponto.pontoId);
  // 07/09/2026 é segunda e feriado nacional; 08/09 é terça comum.
  await gerar(ponto.telaId, emMatao(7, 10, { mes: 9 }));
  await gerar(ponto.telaId, emMatao(8, 10, { mes: 9 }));
  assert.ok(!(await linhaDa(conta.id, emMatao(7, 10, { mes: 9 }))), 'feriado fechado: sem obrigação');
  assert.ok(await linhaDa(conta.id, emMatao(8, 10, { mes: 9 })), 'dia seguinte: deve');
});

test('fuso: a régua é a hora de Matão, não a UTC do servidor', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  const dezUtc = new Date(Date.UTC(2026, 7, 3, 10)); // 07:00 em Matão
  const onzeUtc = new Date(Date.UTC(2026, 7, 3, 11)); // 08:00 em Matão
  await gerar(ponto.telaId, dezUtc);
  await gerar(ponto.telaId, onzeUtc);
  assert.ok(!(await linhaDa(conta.id, dezUtc)), '10h UTC = 7h em Matão: fechado');
  assert.ok(await linhaDa(conta.id, onzeUtc), '11h UTC = 8h em Matão: abre');
});

// ---------------------------------------------------------------------------
// Capacidade: camadas da hora (puro — src/lib/pacing.js)
// ---------------------------------------------------------------------------

test('capacidade: compensação de A (RN-49) nunca corta a base de B, nem numa hora saturada', () => {
  // B compra 3150 s; A tem 300 s de base + 300 s de compensação (rede menor
  // que o plano). Antes, tudo numa camada: 3750 s > 3600 e B era cortado.
  const hora = montarHoraDeTv(
    [
      { id: 'A', frequenciaBase: 20, compensacao: 20, duracaoSegundos: 15 },
      { id: 'B', frequenciaBase: 210, duracaoSegundos: 15 },
    ],
    'x',
  );
  assert.strictEqual(hora.programados.B, 210, 'a base de B é intocável');
  assert.strictEqual(hora.programados.A, 30, 'A: base inteira + só os 150 s que sobraram');
});

test('capacidade: reposição da hora anterior (RN-10) também só usa o que sobra da base de todos', () => {
  const hora = montarHoraDeTv(
    [
      { id: 'A', frequenciaBase: 20, deficit: 200, duracaoSegundos: 15 },
      { id: 'B', frequenciaBase: 210, duracaoSegundos: 15 },
    ],
    'x',
  );
  assert.strictEqual(hora.programados.B, 210);
  assert.strictEqual(hora.programados.A, 30);
});

test('capacidade: saldo antigo (T3) nunca tira o tempo da compensação corrente (T2), nem de outra conta', () => {
  const hora = montarHoraDeTv(
    [
      { id: 'A', frequenciaBase: 20, compensacao: 20, duracaoSegundos: 15 },
      { id: 'B', frequenciaBase: 190, banco: 100, duracaoSegundos: 15 },
    ],
    'x',
  );
  // T1: 300 + 2850 = 3150 s; T2: A +300 s = 3450; T3: B só nos 150 s finais.
  assert.strictEqual(hora.programados.A, 40, 'o mês corrente de A inteiro');
  assert.strictEqual(hora.bancoProgramados.B, 10, 'a dívida antiga de B só no que sobrou');
});

test('capacidade: rede saturada corta a base proporcionalmente e não sobra nada pra compensação nem saldo', () => {
  const hora = montarHoraDeTv(
    [
      { id: 'A', frequenciaBase: 150, compensacao: 50, banco: 50, duracaoSegundos: 20 },
      { id: 'B', frequenciaBase: 150, duracaoSegundos: 20 },
    ],
    'x',
  );
  assert.ok(hora.cortou);
  assert.strictEqual(hora.programados.A, 90);
  assert.strictEqual(hora.programados.B, 90);
  assert.deepStrictEqual(hora.bancoProgramados, {});
});

// Exemplos da estação (84 h em 7 pontos = 12 h por ponto), por hora: base de
// 120 s/h por ponto, peça de 15 s, 3 pontos disponíveis.
test('redistribuição: 7 pontos contratados, 3 disponíveis — com capacidade sobrando, entrega tudo e o saldo é zero', () => {
  const obrigacao = segundosDeObrigacao({
    segundosPorHora: 120,
    pontosIncluidos: 7,
    pontosCobertos: 3,
    duracaoSegundos: 15,
  });
  assert.strictEqual(obrigacao, 270, '120 × 7 ÷ 3 = 280 s → 18 peças inteiras de 15 s');
  const total = Math.floor(segundosCompensados(120, 7, 3) / 15);
  const hora = montarHoraDeTv([{ id: 'A', frequenciaBase: 8, compensacao: total - 8, duracaoSegundos: 15 }], 'x');
  assert.strictEqual(hora.programados.A * 15, 270, 'a tela programa toda a obrigação');
  assert.strictEqual(obrigacao - hora.programados.A * 15, 0, 'saldo pendente = 0');
});

test('redistribuição parcial: só o que não coube em capacidade ociosa vira saldo (não a falta inteira de pontos)', () => {
  const obrigacao = segundosDeObrigacao({
    segundosPorHora: 120,
    pontosIncluidos: 7,
    pontosCobertos: 3,
    duracaoSegundos: 15,
  });
  // Outra conta ocupa 3390 s: sobram 210 s. A base de A (120 s) cabe, e só
  // 90 s da compensação.
  const hora = montarHoraDeTv(
    [
      { id: 'A', frequenciaBase: 8, compensacao: 10, duracaoSegundos: 15 },
      { id: 'B', frequenciaBase: 226, duracaoSegundos: 15 },
    ],
    'x',
  );
  assert.strictEqual(hora.programados.A, 14);
  assert.strictEqual(obrigacao - hora.programados.A * 15, 60, 'saldo = 60 s, não a falta inteira dos 4 pontos');
});

test('obrigação ignora o teto da RN-49: plano maior que a rede deve o contrato inteiro', () => {
  assert.strictEqual(segundosCompensados(300, 7, 1), 600, 'a tela programa até o teto de 1/6 da hora');
  assert.strictEqual(
    segundosDeObrigacao({ segundosPorHora: 300, pontosIncluidos: 7, pontosCobertos: 1, duracaoSegundos: 15 }),
    2100,
    'a obrigação é o contrato concentrado — o que o teto segura vira saldo',
  );
  assert.strictEqual(
    segundosDeObrigacao({
      segundosPorHora: 120,
      pontosIncluidos: 2,
      pontosCobertos: 2,
      duracaoSegundos: 15,
      telasDoPonto: 2,
    }),
    60,
    'ponto com duas telas: a obrigação do ponto se divide entre elas',
  );
  assert.strictEqual(
    segundosDeObrigacao({ segundosPorHora: 0, frequenciaHora: 3, duracaoSegundos: 20 }),
    60,
    'plano legado: frequência × duração',
  );
});

// ---------------------------------------------------------------------------
// Saldo: zero, parcial, integral; multi-conta; compensação do saldo antigo
// ---------------------------------------------------------------------------

test('saldo integral: hora aberta servida e sem nenhum comprovante deve a hora inteira', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await gerar(ponto.telaId, emMatao(3, 10)); // playlist enviada; nada tocou
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  const mes = await saldoDoMes(conta.id);
  assert.strictEqual(Number(mes.segundos_banco), 600, 'playlist enviada não é entrega');
  assert.strictEqual(mes.exibicoes_banco, 40, 'equivalente: 600 s ÷ 15 s');
  assert.strictEqual(mes.status, 'ativo');
});

test('saldo parcial: metade tocou, metade vira saldo', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await tocar(ponto.telaId, await gerar(ponto.telaId, emMatao(3, 10)), conta.id, 20);
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 300);
});

test('várias contas no mesmo ponto: a compensação de A e o teto dela nunca tiram a base de B; o que A não recebeu vira saldo de A', async () => {
  const ponto = await novoPonto(); // 24 h
  const a = await novaConta({ plano: await novoPlano({ segundos: 300, pontos: 7 }) }); // escolheu 1 de 7
  const b = await novaConta({ plano: await novoPlano({ segundos: 3150 }) });
  await escolher(a.id, ponto.pontoId);
  await escolher(b.id, ponto.pontoId);
  const playlist = await gerar(ponto.telaId, emMatao(4, 10));
  const la = await linhaDa(a.id, emMatao(4, 10));
  const lb = await linhaDa(b.id, emMatao(4, 10));
  assert.strictEqual(lb.vezes_programadas, 210, 'B recebe a base inteira');
  assert.ok(
    la.vezes_programadas >= 20 && la.vezes_programadas <= 30,
    `A: base + o que sobrou (${la.vezes_programadas})`,
  );
  assert.strictEqual(la.segundos_obrigacao, 2100, 'A deve o contrato concentrado (7 × 300 s)');
  await tocar(ponto.telaId, playlist, a.id);
  await tocar(ponto.telaId, playlist, b.id);
  await apurarMes({ mes: '2026-08', apenasContas: [a.id, b.id] });
  assert.strictEqual(Number((await saldoDoMes(b.id)).segundos_banco), 0);
  assert.strictEqual(Number((await saldoDoMes(a.id)).segundos_banco), 2100 - la.vezes_programadas * 15);
});

test('saldo antigo volta na capacidade ociosa, só abate confirmado, e não prejudica o mês corrente', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto();
  await escolher(conta.id, ponto.pontoId);
  // Dívida de um ciclo antigo não entregue (migration 111): 150 s em atraso.
  await obrigacaoVencida(conta.id, 150);
  const playlist = await gerar(ponto.telaId, emMatao(5, 10));
  const l = await linhaDa(conta.id, emMatao(5, 10));
  assert.strictEqual(l.vezes_banco, 10, 'dívida de 150 s = 10 peças de 15 s no tempo livre');
  assert.strictEqual(l.vezes_programadas - l.vezes_banco, 40, 'o mês corrente inteiro continua lá');
  assert.strictEqual((await obrigacaoDoCiclo.saldoDaConta(conta.id)).saldoSegundos, 150, 'programar não abate');

  await tocar(ponto.telaId, playlist, conta.id); // tudo tocou: 40 normais + 10 do saldo
  assert.strictEqual(
    (await obrigacaoDoCiclo.saldoDaConta(conta.id)).saldoSegundos,
    0,
    'saldo antigo compensado pelo Proof-of-Play confirmado',
  );
  const depoisDoPrazo = new Date(emMatao(5, 10).getTime() + 8 * 24 * 3_600_000);
  const liq = await liquidarBancoConfirmado({ apenasContas: [conta.id], agora: depoisDoPrazo });
  assert.strictEqual(liq.linhas, 1, 'a liquidação fecha a hora (a reserva do banco programado sai)');
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 0, 'e agosto não ganhou dívida nova');
});

// ---------------------------------------------------------------------------
// POP: só comprovante entrega, uma vez; inválido, playing e atraso
// ---------------------------------------------------------------------------

test('POP duplicado (mesmo execucaoId) credita uma vez; POP inválido não credita', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  const playlist = await gerar(ponto.telaId, emMatao(3, 10));
  const item = playlist.itens.find((i) => i.anuncianteId === conta.id);
  const agora = emMatao(3, 10, { minuto: 30 });
  const evento = { execucaoId: randomUUID(), janelaId: playlist.janelaId, itemProgramacaoId: item.itemProgramacaoId };
  assert.strictEqual((await confirmarComDedup(ponto.telaId, evento, agora)).status, 'contabilizado');
  assert.strictEqual((await confirmarComDedup(ponto.telaId, evento, agora)).status, 'duplicado');
  const forjado = { ...evento, execucaoId: randomUUID(), itemProgramacaoId: `${item.itemProgramacaoId}x` };
  assert.strictEqual((await confirmarComDedup(ponto.telaId, forjado, agora)).status, 'item_invalido');
  assert.strictEqual((await linhaDa(conta.id, emMatao(3, 10))).vezes_confirmadas, 1);
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 600 - 15);
});

test('playing sem ended (heartbeat PLAYING) não entrega nada', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await gerar(ponto.telaId, emMatao(3, 10));
  await sinal.registrarHeartbeat(
    ponto.telaId,
    { estado: 'PLAYING', criativoId: String(conta.criativoId) },
    { versao: '1.2.0', build: 12 },
  );
  assert.strictEqual((await linhaDa(conta.id, emMatao(3, 10))).vezes_confirmadas, 0);
});

test('TV offline: comprovante que chega dias depois conta; a apuração se recompõe no prazo e congela depois (idempotente)', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  const playlist = await gerar(ponto.telaId, emMatao(31, 10)); // segunda, 31/08

  const provisoria = await apurarMes({ mes: '2026-08', apenasContas: [conta.id], agora: emMatao(2, 12, { mes: 9 }) });
  assert.strictEqual(provisoria.definitivo, false);
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 600, 'sem comprovante ainda');
  assert.ok(await recomporMesAnteriorEmPrazo({ agora: emMatao(3, 6, { mes: 9 }), apenasContas: [conta.id] }));

  await tocar(ponto.telaId, playlist, conta.id, 40, emMatao(5, 9, { mes: 9 })); // a TV voltou 5 dias depois
  const recomposta = await apurarMes({ mes: '2026-08', apenasContas: [conta.id], agora: emMatao(6, 12, { mes: 9 }) });
  assert.strictEqual(recomposta.linhasRecompostas, 1);
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 0, 'o atraso entrou');
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id], agora: emMatao(6, 13, { mes: 9 }) });
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 0, 'rodar de novo dá o mesmo saldo');

  await apurarMes({ mes: '2026-08', apenasContas: [conta.id], agora: emMatao(10, 12, { mes: 9 }) }); // definitiva
  const tarde = await apurarMes({ mes: '2026-08', apenasContas: [conta.id], agora: emMatao(20, 12, { mes: 9 }) });
  assert.strictEqual(tarde.linhasRecompostas, 0, 'depois do prazo, congelada');
  assert.strictEqual(tarde.novasLinhas, 0);
  assert.strictEqual(await recomporMesAnteriorEmPrazo({ agora: emMatao(20, 12, { mes: 9 }) }), null);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM banco_horas WHERE anunciante_id = $1', [conta.id]);
  assert.strictEqual(rows[0].n, 1, 'uma linha por conta e competência, sempre');
});

test('tela sem sinal em hora aberta: a obrigação existia, vira saldo — e só depois de a conta começar', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await pool.query(`UPDATE dispositivos SET provisionado_em = '2026-08-01' WHERE id = $1`, [ponto.telaId]);
  await tocar(ponto.telaId, await gerar(ponto.telaId, emMatao(3, 10)), conta.id); // pediu e tocou às 10h
  // 11h–17h: a TV não pediu playlist (sem sinal). 18h em diante: fechado.
  const janela = { de: emMatao(3, 0), ate: emMatao(4, 0), apenasContas: [conta.id], apenasTelas: [ponto.telaId] };
  assert.strictEqual((await registrarHorasSemPedido(janela)).horas, 7);
  assert.strictEqual((await registrarHorasSemPedido(janela)).horas, 0, 'idempotente');
  const semSinal = (await linhas(conta.id)).filter((l) => l.obrigacao_sem_pedido);
  assert.deepStrictEqual(
    semSinal.map((l) => [new Date(l.janela_hora).getUTCHours() - 3, l.segundos_obrigacao, l.vezes_programadas]),
    [11, 12, 13, 14, 15, 16, 17].map((h) => [h, 600, 0]),
  );
  assert.ok(!(await linhaDa(conta.id, emMatao(3, 9))), '8h e 9h: a conta ainda não tinha começado');
  // Tira a tela da rede pra apuração não completar o resto de agosto.
  await pool.query('UPDATE dispositivos SET revogado_em = now() WHERE id = $1', [ponto.telaId]);
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 7 * 600);
});

// ---------------------------------------------------------------------------
// Mídia Mostraí fora do saldo comercial
// ---------------------------------------------------------------------------

test('Mídia Mostraí: toca e é comprovada no contador dela, nunca no saldo comercial', async () => {
  const ponto = await novoPonto();
  const propria = await anunciantesRepo.ensureContaMostrai();
  const peca = await criativosRepo.criar({
    anunciante_id: propria.id,
    arquivo_original_url: 'o.mp4',
    arquivo_normalizado_url: `https://exemplo.test/midia-saldo-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await criativosRepo.atualizar(peca.id, { status: 'aprovado' });
  const midia = await midiasRepo.criar({
    criativoId: peca.id,
    nomeInterno: `Saldo ${randomUUID().slice(0, 6)}`,
    frequenciaHora: 2,
    coberturaTipo: 'pontos',
    pontosIds: [ponto.pontoId],
  });
  criados.midias.push(midia.id);
  try {
    const playlist = await gerar(ponto.telaId, emMatao(3, 10));
    const itens = playlist.itens.filter((i) => i.itemProgramacaoId.endsWith(`|midia:${midia.id}`));
    assert.ok(itens.length > 0);
    for (const item of itens) {
      const r = await confirmarComDedup(
        ponto.telaId,
        { execucaoId: randomUUID(), janelaId: playlist.janelaId, itemProgramacaoId: item.itemProgramacaoId },
        emMatao(3, 10, { minuto: 30 }),
      );
      assert.strictEqual(r.status, 'contabilizado');
    }
    const { rows: comercial } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM exibicoes_contador WHERE anunciante_id = $1',
      [propria.id],
    );
    assert.strictEqual(comercial[0].n, 0, 'nada no contador comercial');
    await apurarMes({ mes: '2026-08', apenasContas: [propria.id] });
    const { rows: saldo } = await pool.query('SELECT COUNT(*)::int AS n FROM banco_horas WHERE anunciante_id = $1', [
      propria.id,
    ]);
    assert.strictEqual(saldo[0].n, 0, 'e nada no saldo de veiculação');
  } finally {
    await pool.query('DELETE FROM midias_exibicoes_contador WHERE midia_id = $1', [midia.id]);
    await pool.query('DELETE FROM midias_proprias WHERE id = $1', [midia.id]);
    await pool.query('DELETE FROM criativos WHERE id = $1', [peca.id]);
  }
});

// ---------------------------------------------------------------------------
// Criativos: durações e troca de peça sem reescrever histórico
// ---------------------------------------------------------------------------

test('peça de 30 s: o mesmo plano vira 20 inserções e a mesma obrigação em tempo', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }), duracao: 30 });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await tocar(ponto.telaId, await gerar(ponto.telaId, emMatao(3, 10)), conta.id, 10);
  const l = await linhaDa(conta.id, emMatao(3, 10));
  assert.strictEqual(l.vezes_programadas, 20);
  assert.strictEqual(l.duracao_segundos, 30);
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 300, '600 s − 10 × 30 s');
});

test('trocar a peça depois da apuração não muda o saldo em tempo — só as exibições equivalentes', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await tocar(ponto.telaId, await gerar(ponto.telaId, emMatao(3, 10)), conta.id, 20);
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(conta.id), 300);
  assert.strictEqual(await bancoHorasRepo.duracaoMediaDoAnunciante(conta.id), 15);

  // Nova peça de 30 s aprovada, a de 15 s retirada.
  const nova = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'o.mp4',
    arquivo_normalizado_url: `https://exemplo.test/saldo-30-${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: 30,
  });
  await criativosRepo.atualizar(nova.id, { status: 'aprovado' });
  await criativosRepo.atualizar(conta.criativoId, { status: 'retirado' });
  assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(conta.id), 300, 'o tempo devido não mudou');
  assert.strictEqual(await bancoHorasRepo.duracaoMediaDoAnunciante(conta.id), 30);
  const l = await linhaDa(conta.id, emMatao(3, 10));
  assert.strictEqual(l.duracao_segundos, 15, 'a hora guarda a duração que usou');
});

// ---------------------------------------------------------------------------
// Rede e plano: pontos entrando/saindo, troca, cancelamento, entrada no meio
// ---------------------------------------------------------------------------

test('rede: ponto novo na cobertura desconcentra a obrigação; ponto que sai concentra de novo — o total por hora não muda', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 120, pontos: 2 }) });
  const p1 = await novoPonto();
  const p2 = await novoPonto();
  await escolher(conta.id, p1.pontoId);
  await gerar(p1.telaId, emMatao(6, 10));
  assert.strictEqual((await linhaDa(conta.id, emMatao(6, 10))).segundos_obrigacao, 240, 'só 1 dos 2 pontos: concentra');

  await escolher(conta.id, p2.pontoId);
  await gerar(p1.telaId, emMatao(6, 11));
  await gerar(p2.telaId, emMatao(6, 11));
  const onze = (await linhas(conta.id)).filter((l) => new Date(l.janela_hora).getTime() === emMatao(6, 11).getTime());
  assert.deepStrictEqual(
    onze.map((l) => l.segundos_obrigacao),
    [120, 120],
    'dois pontos: 120 s em cada, os mesmos 240 s',
  );

  await pool.query(
    `UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'teste' WHERE id = $1`,
    [p2.pontoId],
  );
  await gerar(p1.telaId, emMatao(6, 12));
  assert.strictEqual(
    (await linhaDa(conta.id, emMatao(6, 12))).segundos_obrigacao,
    240,
    'ponto removido: concentra de novo',
  );
});

test('troca de plano: cada hora deve o plano daquela hora; cancelamento e suspensão encerram a obrigação', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto();
  await escolher(conta.id, ponto.pontoId);
  await gerar(ponto.telaId, emMatao(7, 10));
  await pool.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [
    conta.id,
    await novoPlano({ segundos: 300 }),
  ]);
  await gerar(ponto.telaId, emMatao(7, 11));
  assert.strictEqual((await linhaDa(conta.id, emMatao(7, 10))).segundos_obrigacao, 600);
  assert.strictEqual((await linhaDa(conta.id, emMatao(7, 11))).segundos_obrigacao, 300);

  await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [conta.id]);
  await gerar(ponto.telaId, emMatao(7, 12));
  assert.ok(!(await linhaDa(conta.id, emMatao(7, 12))), 'suspensa: sem obrigação');
  await pool.query('UPDATE anunciantes SET suspenso = false, plano_id = NULL WHERE id = $1', [conta.id]);
  await gerar(ponto.telaId, emMatao(7, 13));
  assert.ok(!(await linhaDa(conta.id, emMatao(7, 13))), 'sem plano: sem obrigação');
});

test('conta que entra no meio da hora deve só o que sobra dela', async () => {
  const ponto = await novoPonto();
  const a = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const b = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  await escolher(a.id, ponto.pontoId);
  await gerar(ponto.telaId, emMatao(10, 10), emMatao(10, 10));
  await escolher(b.id, ponto.pontoId); // escolheu às 10:30
  await gerar(ponto.telaId, emMatao(10, 10), emMatao(10, 10, { minuto: 30 }));
  assert.strictEqual((await linhaDa(a.id, emMatao(10, 10))).segundos_obrigacao, 600);
  assert.strictEqual((await linhaDa(b.id, emMatao(10, 10))).segundos_obrigacao, 300, 'meia hora restante');
  await gerar(ponto.telaId, emMatao(10, 10), emMatao(10, 10, { minuto: 45 }));
  assert.strictEqual((await linhaDa(b.id, emMatao(10, 10))).segundos_obrigacao, 300, 'o poll seguinte não reescreve');
});

test('reposição não cruza competência: o não entregue da última hora do mês fica no mês', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto();
  await escolher(conta.id, ponto.pontoId);
  await gerar(ponto.telaId, emMatao(31, 22)); // nada tocou
  await gerar(ponto.telaId, emMatao(31, 23));
  await gerar(ponto.telaId, emMatao(1, 0, { mes: 9 }));
  assert.strictEqual(
    (await linhaDa(conta.id, emMatao(31, 23))).vezes_pedidas,
    80,
    'dentro do mês, a hora anterior repõe',
  );
  assert.strictEqual((await linhaDa(conta.id, emMatao(1, 0, { mes: 9 }))).vezes_pedidas, 40, 'na virada, não');
  await apurarMes({ mes: '2026-08', apenasContas: [conta.id] });
  // 22h e 23h: 1200 s devidos, nada tocou → agosto fecha devendo 1200 s.
  assert.strictEqual(Number((await saldoDoMes(conta.id)).segundos_banco), 1200);
});

test('tela sem sinal: conta que chegou ao ponto depois da hora não deve aquela hora (nada é cobrado duas vezes)', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600, pontos: 2 }) });
  const antes = await novoPonto({ horario: HORARIO_COMERCIAL });
  const depois = await novoPonto({ horario: HORARIO_COMERCIAL });
  await pool.query(`UPDATE dispositivos SET provisionado_em = '2026-08-01' WHERE id = $1`, [depois.telaId]);
  await escolher(conta.id, antes.pontoId);
  await gerar(antes.telaId, emMatao(3, 10)); // servida no ponto de antes
  await escolher(conta.id, depois.pontoId); // escolheu o outro depois; a TV dele ficou sem sinal no dia 3
  const r = await registrarHorasSemPedido({
    de: emMatao(3, 0),
    ate: emMatao(4, 0),
    apenasContas: [conta.id],
    apenasTelas: [depois.telaId],
  });
  assert.strictEqual(r.horas, 0, 'nunca foi servida naquela tela antes: não deve as horas dela');
});

// ---------------------------------------------------------------------------
// Revisão Codex do PR #85
// ---------------------------------------------------------------------------

test('Codex #85: quem entra no meio da hora recebe também a compensação da RN-49, não só a base', async () => {
  const ponto = await novoPonto();
  const a = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const b = await novaConta({ plano: await novoPlano({ segundos: 120, pontos: 2 }) }); // 1 de 2 pontos: concentra
  await escolher(a.id, ponto.pontoId);
  await gerar(ponto.telaId, emMatao(11, 10), emMatao(11, 10));
  await escolher(b.id, ponto.pontoId);
  const playlist = await gerar(ponto.telaId, emMatao(11, 10), emMatao(11, 10, { minuto: 30 }));
  const itensDeB = playlist.itens.filter((i) => i.anuncianteId === b.id).length;
  assert.strictEqual(itensDeB, 16, '8 de base + 8 de compensação (240 s ÷ 15 s)');
  assert.strictEqual((await linhaDa(b.id, emMatao(11, 10))).segundos_obrigacao, 120, 'deve só a meia hora restante');
});

test('Codex #85: a hora da instalação só deve a partir do instante em que a tela foi instalada', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await pool.query(`UPDATE dispositivos SET provisionado_em = '2026-08-01' WHERE id = $1`, [ponto.telaId]);
  await gerar(ponto.telaId, emMatao(3, 10)); // servida na segunda
  // Reinstalada na terça às 10:30; não pediu playlist o resto do dia.
  await pool.query('UPDATE dispositivos SET provisionado_em = $2 WHERE id = $1', [
    ponto.telaId,
    emMatao(4, 10, { minuto: 30 }),
  ]);
  await registrarHorasSemPedido({
    de: emMatao(4, 0),
    ate: emMatao(5, 0),
    apenasContas: [conta.id],
    apenasTelas: [ponto.telaId],
  });
  const dez = await linhaDa(conta.id, emMatao(4, 10));
  assert.strictEqual(dez.minutos_abertos, 30);
  assert.strictEqual(dez.segundos_obrigacao, 300, 'antes das 10:30 a tela não existia');
  assert.strictEqual((await linhaDa(conta.id, emMatao(4, 11))).segundos_obrigacao, 600);
});

test('Codex #85: a hora sem sinal é gravada logo depois de fechar, com o plano daquela hora — mudar o plano ou suspender depois não reescreve', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await escolher(conta.id, ponto.pontoId);
  await pool.query(`UPDATE dispositivos SET provisionado_em = '2026-08-01' WHERE id = $1`, [ponto.telaId]);
  await gerar(ponto.telaId, emMatao(3, 10));
  const filtros = { apenasContas: [conta.id], apenasTelas: [ponto.telaId] };
  // O servidor roda isto a cada 10 min: às 12:05, a hora das 11 (sem sinal) já fechou.
  await registrarHorasRecemFechadas(emMatao(3, 12, { minuto: 5 }), filtros);
  assert.strictEqual((await linhaDa(conta.id, emMatao(3, 11))).segundos_obrigacao, 600);

  // Depois: plano menor e conta suspensa. A rede de segurança roda o dia todo.
  await pool.query('UPDATE anunciantes SET plano_id = $2 WHERE id = $1', [
    conta.id,
    await novoPlano({ segundos: 300 }),
  ]);
  await registrarHorasSemPedido({ de: emMatao(3, 0), ate: emMatao(4, 0), ...filtros });
  await pool.query('UPDATE anunciantes SET suspenso = true WHERE id = $1', [conta.id]);
  await registrarHorasSemPedido({ de: emMatao(3, 0), ate: emMatao(4, 0), ...filtros });
  assert.strictEqual(
    (await linhaDa(conta.id, emMatao(3, 11))).segundos_obrigacao,
    600,
    'a obrigação das 11h é a do plano que valia às 11h',
  );
});

// ---------------------------------------------------------------------------
// Finalização (28/09/2026), POP-01: a rede de segurança (diário e apuração
// mensal) usa o estado de HOJE pra horas antigas. Tela em reparo reativada,
// plano vencido renovado: o passe do mês inteiro dava a elas obrigação
// retroativa das horas em que não deviam nada. Regra: a rede de segurança
// só entra nas horas em que NENHUMA tela pediu playlist (servidor fora do
// ar) — hora em que a rede funcionava já foi tratada pelo job de 10 min,
// com o estado daquela hora.
// ---------------------------------------------------------------------------
test('POP-01: rede de segurança não inventa obrigação retroativa pra tela que estava em reparo (outras telas pediram naquela hora)', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600, pontos: 2 }) });
  const emReparo = await novoPonto({ horario: HORARIO_COMERCIAL });
  const funcionando = await novoPonto({ horario: HORARIO_COMERCIAL });
  await pool.query(`UPDATE dispositivos SET provisionado_em = '2026-08-01' WHERE id IN ($1, $2)`, [
    emReparo.telaId,
    funcionando.telaId,
  ]);
  await escolher(conta.id, emReparo.pontoId, funcionando.pontoId);
  await gerar(emReparo.telaId, emMatao(3, 10)); // servida antes do reparo
  // 11h–17h: a tela em reparo (403 na playlist) não pediu; a outra pediu.
  for (const h of [11, 12, 13, 14, 15, 16, 17]) await gerar(funcionando.telaId, emMatao(3, h));
  const filtros = { apenasContas: [conta.id], apenasTelas: [emReparo.telaId] };
  const seguranca = await registrarHorasSemPedido({
    de: emMatao(3, 0),
    ate: emMatao(4, 0),
    ...filtros,
    soServidorForaDoAr: true,
  });
  assert.strictEqual(seguranca.horas, 0, 'a rede estava no ar nessas horas: o passe de segurança não grava nada');
  // O job de 10 min (estado da hora) continua gravando normalmente.
  const dezMinutos = await registrarHorasSemPedido({ de: emMatao(3, 0), ate: emMatao(4, 0), ...filtros });
  assert.strictEqual(dezMinutos.horas, 7);
});

test('POP-01: servidor fora do ar (nenhuma tela pediu) — a rede de segurança grava a hora sem sinal', async () => {
  const conta = await novaConta({ plano: await novoPlano({ segundos: 600 }) });
  const ponto = await novoPonto({ horario: HORARIO_COMERCIAL });
  await pool.query(`UPDATE dispositivos SET provisionado_em = '2026-08-01' WHERE id = $1`, [ponto.telaId]);
  await escolher(conta.id, ponto.pontoId);
  // Dia 10 (segunda): pediu às 10h; ninguém na rede pediu das 11h em diante.
  await gerar(ponto.telaId, emMatao(10, 10));
  const r = await registrarHorasSemPedido({
    de: emMatao(10, 0),
    ate: emMatao(11, 0),
    apenasContas: [conta.id],
    apenasTelas: [ponto.telaId],
    soServidorForaDoAr: true,
  });
  assert.strictEqual(r.horas, 7, '11h–17h sem pedido de tela nenhuma: obrigação gravada');
});
