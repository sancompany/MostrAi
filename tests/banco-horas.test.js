const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const bancoHorasRepo = require('../src/bancohoras/repository');
const { apurarMes, liquidarBancoConfirmado } = require('../src/bancohoras/apuracao');
const { montarHoraDeTv, SEGUNDOS_DA_HORA } = require('../src/lib/pacing');
const gerador = require('../src/playlist/gerador');
const pontosRepo = require('../src/pontos/repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const { registrarHeartbeat } = require('../src/player/sinal');
const { gerarChaveLegada } = require('../src/player/credencial');

// Banco de horas (G.3 de docs/PENDENCIAS.md). Unidade é EXIBIÇÃO (vezes),
// não segundos — ver migration 058. Cada teste cria e apaga a própria
// conta, com e-mail único, pra não colidir com outra rodada da suíte.

async function contaDeTeste() {
  const email = `banco-horas-${randomUUID()}@example.com`;
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em)
     VALUES ('Teste banco de horas', '11144477735', $1, '16999990000', 'x', now())
     RETURNING id`,
    [email],
  );
  return rows[0].id;
}

async function apagarConta(anuncianteId) {
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [anuncianteId]);
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [anuncianteId]);
  await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [anuncianteId]);
  await pool.query('DELETE FROM banco_horas WHERE anunciante_id = $1', [anuncianteId]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [anuncianteId]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [anuncianteId]);
}

test('registrarDeficit só grava quando pedidas > entregues, e não duplica o mesmo mês', async () => {
  const id = await contaDeTeste();
  try {
    const semDeficit = await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: '2026-08-01',
      exibicoesPedidas: 10,
      exibicoesEntregues: 10,
    });
    assert.strictEqual(semDeficit, null, 'pedidas === entregues não é déficit');

    const linha = await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: '2026-08-01',
      exibicoesPedidas: 15,
      exibicoesEntregues: 9,
    });
    assert.strictEqual(linha.exibicoes_banco, 6);
    assert.strictEqual(linha.status, 'ativo');

    const denovo = await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: '2026-08-01',
      exibicoesPedidas: 999,
      exibicoesEntregues: 1,
    });
    assert.strictEqual(denovo, null, 'o mesmo mês não grava duas vezes (UNIQUE anunciante+mês)');
    assert.strictEqual(
      await bancoHorasRepo.saldoAtivoDoAnunciante(id),
      6,
      'o valor gravado foi o da primeira apuração',
    );
  } finally {
    await apagarConta(id);
  }
});

test('drenar tira do saldo, respeita o teto disponível, e marca drenado quando zera', async () => {
  const id = await contaDeTeste();
  try {
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: '2026-07-01',
      exibicoesPedidas: 20,
      exibicoesEntregues: 10,
    });
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 10);

    assert.strictEqual(await bancoHorasRepo.drenar(id, 4), 4);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 6);

    assert.strictEqual(await bancoHorasRepo.drenar(id, 999), 6, 'nunca drena mais do que existe');
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 0);

    const { rows } = await pool.query('SELECT status FROM banco_horas WHERE anunciante_id = $1', [id]);
    assert.strictEqual(rows[0].status, 'drenado');
  } finally {
    await apagarConta(id);
  }
});

test('drenar segue FIFO — a linha mais antiga esvazia primeiro', async () => {
  const id = await contaDeTeste();
  try {
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: '2026-06-01',
      exibicoesPedidas: 15,
      exibicoesEntregues: 10,
    }); // banco 5, mais antigo
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: '2026-07-01',
      exibicoesPedidas: 15,
      exibicoesEntregues: 10,
    }); // banco 5, mais novo

    await bancoHorasRepo.drenar(id, 5);
    const { rows } = await pool.query(
      `SELECT mes_referencia, status FROM banco_horas WHERE anunciante_id = $1 ORDER BY mes_referencia`,
      [id],
    );
    assert.strictEqual(rows[0].status, 'drenado', 'a linha de junho (mais antiga) esvaziou primeiro');
    assert.strictEqual(rows[1].status, 'ativo', 'a de julho continua com o saldo intacto');
  } finally {
    await apagarConta(id);
  }
});

test('saldosAtivos traz a idade da linha MAIS ANTIGA ainda ativa, não da mais nova', async () => {
  const id = await contaDeTeste();
  try {
    const hoje = new Date();
    const tresMesesAtras = new Date(hoje.getFullYear(), hoje.getMonth() - 3, 1);
    const umMesAtras = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);

    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: tresMesesAtras.toISOString().slice(0, 10),
      exibicoesPedidas: 15,
      exibicoesEntregues: 10,
    }); // banco 5, 3 meses de idade
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: umMesAtras.toISOString().slice(0, 10),
      exibicoesPedidas: 15,
      exibicoesEntregues: 10,
    }); // banco 5, 1 mês de idade

    const saldos = await bancoHorasRepo.saldosAtivos();
    assert.strictEqual(saldos[id].saldo, 10, 'soma as duas linhas ativas');
    assert.strictEqual(saldos[id].idadeMeses, 3, 'idade é da linha mais antiga (3 meses), não da mais nova (1 mês)');
  } finally {
    await apagarConta(id);
  }
});

test('apurarMes (padrão: mês anterior) fecha o déficit do mês anterior por vezes_programadas, não por vezes_confirmadas', async () => {
  // Sem dispositivo nenhum no banco de teste, pula: é falta de fixture,
  // não bug real (exibicoes_contador exige um dispositivo_id válido).
  const { rows: dispositivo } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
  if (!dispositivo.length) return;

  const id = await contaDeTeste();
  try {
    const hoje = new Date();
    const inicioMesAnterior = new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1);
    const janela = new Date(inicioMesAnterior);
    janela.setDate(15); // um dia qualquer dentro do mês anterior

    // `vezes_confirmadas` bem abaixo de `vezes_programadas` (tela ficou
    // offline e não confirmou tudo que rodou) — se o déficit usasse essa
    // coluna, creditaria banco de horas por um problema de tela, não de
    // hora vendida. `vezes_pedidas` (5) > `vezes_programadas` (4) é o
    // ÚNICO déficit real aqui: 1, do corte proporcional (RN-30).
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
       VALUES ($1, $2, $3, 4, 1, 5)`,
      [id, dispositivo[0].id, janela],
    );

    const resultado = await apurarMes({ apenasContas: [id] });
    assert.strictEqual(resultado.anunciantesComDeficit, 1);
    assert.strictEqual(
      await bancoHorasRepo.saldoAtivoDoAnunciante(id),
      1,
      '5 pedidas - 4 programadas = 1 (a queda pra 1 confirmada é problema de tela offline, não entra na conta)',
    );
  } finally {
    await apagarConta(id);
  }
});

test('banco de horas não expira: saldo de 6 meses atrás continua ativo depois da apuração e da liquidação', async () => {
  const id = await contaDeTeste();
  try {
    const antigo = new Date();
    antigo.setMonth(antigo.getMonth() - 6, 1);
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: antigo.toISOString().slice(0, 10),
      exibicoesPedidas: 10,
      exibicoesEntregues: 5,
    });
    await apurarMes({ apenasContas: [id] });
    await liquidarBancoConfirmado({ apenasContas: [id] });
    const { rows } = await pool.query('SELECT status FROM banco_horas WHERE anunciante_id = $1', [id]);
    assert.deepStrictEqual(
      rows.map((r) => r.status),
      ['ativo'],
      'sem válvula: nada vira aguardando_credito',
    );
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 5);
  } finally {
    await apagarConta(id);
  }
});

test('duracaoMediaDoAnunciante lê a duração dos criativos aprovados, e cai no padrão sem nenhum', async () => {
  const id = await contaDeTeste();
  try {
    assert.strictEqual(
      await bancoHorasRepo.duracaoMediaDoAnunciante(id),
      20,
      'sem criativo aprovado, cai no DURACAO_PADRAO (20s)',
    );

    await pool.query(
      `INSERT INTO criativos (anunciante_id, status, arquivo_normalizado_url, arquivo_original_url, duracao_segundos)
       VALUES ($1,'aprovado','https://exemplo.com/a.mp4','https://exemplo.com/a-orig.mp4',10),
              ($1,'aprovado','https://exemplo.com/b.mp4','https://exemplo.com/b-orig.mp4',20),
              ($1,'pendente','https://exemplo.com/c.mp4','https://exemplo.com/c-orig.mp4',90)`,
      [id],
    );
    assert.strictEqual(
      await bancoHorasRepo.duracaoMediaDoAnunciante(id),
      15,
      'média só dos aprovados (10 e 20) — o pendente (90) não entra',
    );
  } finally {
    await apagarConta(id);
  }
});

// ---------- banco de horas como obrigação (decisão do dono, 25/09/2026) ----------

test('montarHoraDeTv: banco só ocupa o tempo que a hora vendida deixou livre — a entrega corrente não muda', () => {
  // Hora quase cheia: 170 × 20s = 3400s vendidos, sobram 200s.
  const normal = [
    { id: 1, frequenciaBase: 100, duracaoSegundos: 20 },
    { id: 2, frequenciaBase: 70, duracaoSegundos: 20 },
  ];
  const semBanco = montarHoraDeTv(normal, 'semente');
  const comBanco = montarHoraDeTv(
    normal.map((a) => (a.id === 2 ? { ...a, banco: 500 } : a)),
    'semente',
  );
  assert.strictEqual(comBanco.programados[1], semBanco.programados[1], 'a conta 1 não perde nada pro banco da 2');
  assert.strictEqual(comBanco.programados[2] - comBanco.bancoProgramados[2], semBanco.programados[2]);
  assert.strictEqual(comBanco.bancoProgramados[2], 10, 'banco pediu 500, coube só nos 200s livres (10 × 20s)');
  assert.strictEqual(comBanco.segundosBanco, 200);
  assert.strictEqual(comBanco.qtdInstitucional, 0, 'o banco toma o lugar do institucional, não o de quem pagou');
  assert.strictEqual(comBanco.ocupacao, semBanco.ocupacao, 'banco não conta como hora vendida');
  assert.deepStrictEqual(comBanco.pedidosPorAnunciante, semBanco.pedidosPorAnunciante, 'banco não é pedido novo');
});

test('montarHoraDeTv: hora cortada (RN-30) não tem espaço pro banco — o corte proporcional fica igual', () => {
  const lotada = [
    { id: 1, frequenciaBase: 150, duracaoSegundos: 20 },
    { id: 2, frequenciaBase: 100, duracaoSegundos: 20, banco: 40 },
  ];
  const hora = montarHoraDeTv(lotada, 'x');
  const semBanco = montarHoraDeTv(
    lotada.map(({ banco, ...a }) => a),
    'x',
  );
  assert.ok(hora.cortou);
  assert.deepStrictEqual(hora.bancoProgramados, {});
  assert.deepStrictEqual(hora.programados, semBanco.programados);
  assert.ok(hora.segundosContratados <= SEGUNDOS_DA_HORA);
});

async function inicioDoMesEmMatao() {
  const { rows } = await pool.query(
    "SELECT date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' AS inicio",
  );
  return rows[0].inicio;
}

test('apuração: mês de Matão (não UTC) e exibição do banco não conta como entrega do mês', async () => {
  const { rows: dispositivo } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
  if (!dispositivo.length) return;
  const id = await contaDeTeste();
  try {
    const inicio = await inicioDoMesEmMatao();
    // 22h do último dia do mês anterior em Matão = 01h UTC do dia 1: é do mês
    // ANTERIOR. 5 pedidas, 6 programadas das quais 2 do banco → entrega
    // normal 4, déficit 1 (a conta antiga, 5 − 6, não via déficit nenhum).
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco)
       VALUES ($1, $2, $3, 6, 5, 2)`,
      [id, dispositivo[0].id, new Date(inicio.getTime() - 2 * 3600 * 1000)],
    );
    // 00h do dia 1 em Matão: já é o mês corrente — fora da apuração.
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas)
       VALUES ($1, $2, $3, 0, 9)`,
      [id, dispositivo[0].id, inicio],
    );

    const simulado = await apurarMes({ apenasContas: [id], simular: true });
    assert.strictEqual(simulado.exibicoesDevidas, 1);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 0, 'simulação não grava');

    const real = await apurarMes({ apenasContas: [id] });
    assert.strictEqual(real.novasLinhas, 1);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 1);
  } finally {
    await apagarConta(id);
  }
});

test('apuração recusa mês que ainda não fechou em Matão', async () => {
  const { rows } = await pool.query("SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS mes");
  await assert.rejects(apurarMes({ mes: rows[0].mes, apenasContas: [0] }), (err) => err.argumentoInvalido === true);
});

test('liquidação abate só o banco CONFIRMADO, uma vez por hora fechada; o resto fica reservado até lá', async () => {
  const { rows: dispositivo } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
  if (!dispositivo.length) return;
  const id = await contaDeTeste();
  try {
    const mesPassado = new Date();
    mesPassado.setMonth(mesPassado.getMonth() - 1, 1);
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: mesPassado.toISOString().slice(0, 10),
      exibicoesPedidas: 20,
      exibicoesEntregues: 10,
    }); // saldo 10
    // Fechada = passou o prazo do proof-of-play offline (7 dias depois do
    // fim da hora). Uma hora de 6 dias atrás ainda pode receber confirmação.
    const horaFechada = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    horaFechada.setMinutes(0, 0, 0);
    const outraHoraFechada = new Date(horaFechada.getTime() - 3600 * 1000);
    const horaAberta = new Date(Date.now() - 6 * 24 * 3600 * 1000);
    horaAberta.setMinutes(0, 0, 0);
    // Hora fechada A: 5 programadas (2 do banco), 4 confirmadas → a normal
    // (3) foi toda, e 1 do banco. Hora fechada B: 2 confirmadas de 5 → nada
    // do banco. Hora aberta (6 dias): 3 do banco ainda podem ser confirmadas.
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco, vezes_confirmadas)
       VALUES ($1, $2, $3, 5, 3, 2, 4), ($1, $2, $4, 5, 3, 2, 2), ($1, $2, $5, 3, 0, 3, 0)`,
      [id, dispositivo[0].id, horaFechada, outraHoraFechada, horaAberta],
    );
    assert.strictEqual(
      (await bancoHorasRepo.saldosAtivos())[id].saldo,
      3,
      'disponível = 10 − 7 programadas do banco ainda não liquidadas',
    );

    const simulado = await liquidarBancoConfirmado({ apenasContas: [id], simular: true });
    assert.deepStrictEqual(simulado, { contas: 1, linhas: 2, exibicoesAbatidas: 1 });
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 10, 'simulação não abate');

    const [a, b] = await Promise.all([
      liquidarBancoConfirmado({ apenasContas: [id] }),
      liquidarBancoConfirmado({ apenasContas: [id] }),
    ]);
    assert.strictEqual(a.exibicoesAbatidas + b.exibicoesAbatidas, 1, 'duas execuções juntas abatem a hora uma vez só');
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 9);
    assert.strictEqual((await liquidarBancoConfirmado({ apenasContas: [id] })).linhas, 0, 'hora liquidada não volta');
    assert.strictEqual(
      (await bancoHorasRepo.saldosAtivos())[id].saldo,
      6,
      'o banco não confirmado das horas fechadas volta a ficar disponível (9 − 3 da hora aberta)',
    );
  } finally {
    await apagarConta(id);
  }
});

test('gerador: banco é programado no tempo livre e NÃO abate o saldo na geração', async () => {
  const ponto = await pontosRepo.criar({
    nome: `Ponto Banco ${randomUUID()}`,
    endereco: 'Rua B, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'Teste',
    responsavel_nome: 'Fulano',
    responsavel_contato: '16999990000',
  });
  const tela = await dispositivosRepo.criar(ponto.id, { apelido: `Banco ${randomUUID()}` });
  await dispositivosRepo.atualizar(tela.id, { contrato_playlist: 2, status: 'ativo' });
  await gerarChaveLegada(tela.id);
  await registrarHeartbeat(tela.id, {}, {});
  const dispositivo = await dispositivosRepo.buscarComPonto(tela.id);
  // Ponto escolhido antes do plano e do criativo aprovado: a conta nunca
  // cai na cobertura automática de outro arquivo (playlist-contrato-novo).
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Banco ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `banco-gerador-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  try {
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [conta.id, ponto.id]);
    await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m' });
    const mesPassado = new Date();
    mesPassado.setMonth(mesPassado.getMonth() - 1, 1);
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: conta.id,
      mesReferencia: mesPassado.toISOString().slice(0, 10),
      exibicoesPedidas: 12,
      exibicoesEntregues: 2,
    }); // saldo 10
    const criativo = await criativosRepo.criar({
      anunciante_id: conta.id,
      arquivo_original_url: 'original.mp4',
      arquivo_normalizado_url: 'https://exemplo.test/banco.mp4',
      thumbnail_url: null,
      duracao_segundos: 15,
    });
    await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });

    const hora = new Date();
    hora.setMinutes(0, 0, 0);
    await gerador.gerarPlaylistDaHora(dispositivo, hora);
    await gerador.gerarPlaylistDaHora(dispositivo, hora); // poll de novo: mesma hora congelada
    const { rows } = await pool.query(
      'SELECT vezes_banco, vezes_programadas, vezes_pedidas FROM exibicoes_contador WHERE anunciante_id = $1 AND dispositivo_id = $2',
      [conta.id, dispositivo.id],
    );
    assert.strictEqual(rows.length, 1);
    assert.ok(rows[0].vezes_banco > 0, 'a hora tinha espaço livre: o banco entrou');
    assert.ok(rows[0].vezes_banco <= 10, `nunca programa mais que a dívida (programou ${rows[0].vezes_banco})`);
    assert.strictEqual(rows[0].vezes_programadas - rows[0].vezes_banco, rows[0].vezes_pedidas, 'normal + banco');
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(conta.id), 10, 'geração não abate saldo');
    assert.strictEqual(
      (await bancoHorasRepo.saldosAtivos())[conta.id]?.saldo ?? 0,
      10 - rows[0].vezes_banco,
      'o programado fica reservado até a liquidação',
    );
  } finally {
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [conta.id]);
    await apagarConta(conta.id);
    await pool.query('DELETE FROM execucoes_confirmadas WHERE dispositivo_id = $1', [tela.id]);
    await pool.query('DELETE FROM exibicoes_contador WHERE dispositivo_id = $1', [tela.id]);
    await dispositivosRepo.deletar(tela.id);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [ponto.id]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [ponto.id]);
  }
});
