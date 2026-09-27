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
const { instalarPlayer } = require('./apoio-player');

// Banco de horas (G.3 de docs/PENDENCIAS.md) — Saldo de Veiculação para o
// cliente. Unidade é o SEGUNDO desde a migration 100 (27/09/2026); cenários
// ponta a ponta em tests/saldo-veiculacao.test.js. Cada teste cria e apaga a
// própria conta, com e-mail único, pra não colidir com outra rodada da suíte.

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

// Linha de saldo pronta (segundos), como a apuração deixaria.
async function saldoDeTeste(anuncianteId, mesReferencia, segundos) {
  await pool.query(
    `INSERT INTO banco_horas (anunciante_id, mes_referencia, exibicoes_pedidas, exibicoes_entregues, exibicoes_banco,
                              segundos_obrigacao, segundos_entregues, segundos_banco, apurado_em)
     VALUES ($1, $2, CEIL($3 / 20.0)::int, 0, CEIL($3 / 20.0)::int, $3, 0, $3, now())`,
    [anuncianteId, mesReferencia, segundos],
  );
}

async function mesAnterior() {
  const { rows } = await pool.query(
    `SELECT to_char(date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '1 month', 'YYYY-MM') AS mes,
            (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') - interval '1 month' + interval '14 days')
              AT TIME ZONE 'America/Sao_Paulo' AS meio`,
  );
  return rows[0];
}

test('apuração da mesma competência duas vezes não duplica o saldo', async () => {
  const { rows: dispositivo } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
  if (!dispositivo.length) return;
  const id = await contaDeTeste();
  try {
    const { meio } = await mesAnterior();
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas,
                                       vezes_confirmadas, segundos_obrigacao, duracao_segundos, minutos_abertos)
       VALUES ($1, $2, $3, 6, 6, 2, 120, 20, 60)`,
      [id, dispositivo[0].id, meio],
    );
    const primeira = await apurarMes({ apenasContas: [id] });
    assert.strictEqual(primeira.novasLinhas, 1);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 80, '120 s devidos − 2 × 20 s confirmados');
    const segunda = await apurarMes({ apenasContas: [id] });
    assert.strictEqual(segunda.novasLinhas, 0, 'UNIQUE anunciante+mês');
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 80, 'rodar de novo não soma nada');
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM banco_horas WHERE anunciante_id = $1', [id]);
    assert.strictEqual(rows[0].n, 1);
  } finally {
    await apagarConta(id);
  }
});

test('drenar tira do saldo (segundos), respeita o teto disponível, e marca drenado quando zera', async () => {
  const id = await contaDeTeste();
  try {
    await saldoDeTeste(id, '2026-07-01', 200);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 200);

    assert.strictEqual(await bancoHorasRepo.drenar(id, 80), 80);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 120);

    assert.strictEqual(await bancoHorasRepo.drenar(id, 9999), 120, 'nunca drena mais do que existe');
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 0);

    const { rows } = await pool.query(
      'SELECT status, exibicoes_banco, exibicoes_drenadas FROM banco_horas WHERE anunciante_id = $1',
      [id],
    );
    assert.strictEqual(rows[0].status, 'drenado');
    assert.strictEqual(rows[0].exibicoes_drenadas, rows[0].exibicoes_banco, 'o equivalente acompanha');
  } finally {
    await apagarConta(id);
  }
});

test('drenar segue FIFO — a linha mais antiga esvazia primeiro', async () => {
  const id = await contaDeTeste();
  try {
    await saldoDeTeste(id, '2026-06-01', 100); // mais antiga
    await saldoDeTeste(id, '2026-07-01', 100); // mais nova

    await bancoHorasRepo.drenar(id, 100);
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
    await saldoDeTeste(id, tresMesesAtras.toISOString().slice(0, 10), 100);
    await saldoDeTeste(id, umMesAtras.toISOString().slice(0, 10), 100);

    const saldos = await bancoHorasRepo.saldosAtivos();
    assert.strictEqual(saldos[id].segundos, 200, 'soma as duas linhas ativas');
    assert.strictEqual(saldos[id].idadeMeses, 3, 'idade é da linha mais antiga (3 meses), não da mais nova (1 mês)');
  } finally {
    await apagarConta(id);
  }
});

test('apurarMes: saldo = obrigação − entrega CONFIRMADA; programada que não tocou não entrega', async () => {
  // Sem dispositivo nenhum no banco de teste, pula: é falta de fixture,
  // não bug real (exibicoes_contador exige um dispositivo_id válido).
  const { rows: dispositivo } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
  if (!dispositivo.length) return;
  const id = await contaDeTeste();
  try {
    const { meio } = await mesAnterior();
    // Até 27/09/2026 esta hora dava saldo 0: 4 programadas = 4 "entregues".
    // Só 1 tocou de verdade. Devia 100 s (5 × 20 s), entregou 20 s.
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas,
                                       vezes_pedidas, segundos_obrigacao, duracao_segundos, minutos_abertos)
       VALUES ($1, $2, $3, 4, 1, 5, 100, 20, 60)`,
      [id, dispositivo[0].id, meio],
    );
    const resultado = await apurarMes({ apenasContas: [id] });
    assert.strictEqual(resultado.anunciantesComDeficit, 1);
    assert.strictEqual(resultado.segundosDevidos, 80);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 80);
  } finally {
    await apagarConta(id);
  }
});

test('apurarMes: linha anterior à migration 100 (sem obrigação gravada) usa pedidas × duração de reserva', async () => {
  const { rows: dispositivo } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
  if (!dispositivo.length) return;
  const id = await contaDeTeste();
  try {
    const { meio } = await mesAnterior();
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas)
       VALUES ($1, $2, $3, 4, 1, 5)`,
      [id, dispositivo[0].id, meio],
    );
    await apurarMes({ apenasContas: [id] });
    // Sem peça aprovada: 20 s (DURACAO_PADRAO). 5 × 20 − 1 × 20 = 80 s.
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 80);
  } finally {
    await apagarConta(id);
  }
});

test('banco de horas não expira: saldo de 6 meses atrás continua ativo depois da apuração e da liquidação', async () => {
  const id = await contaDeTeste();
  try {
    const antigo = new Date();
    antigo.setMonth(antigo.getMonth() - 6, 1);
    await saldoDeTeste(id, antigo.toISOString().slice(0, 10), 100);
    await apurarMes({ apenasContas: [id] });
    await liquidarBancoConfirmado({ apenasContas: [id] });
    const { rows } = await pool.query('SELECT status FROM banco_horas WHERE anunciante_id = $1', [id]);
    assert.deepStrictEqual(
      rows.map((r) => r.status),
      ['ativo'],
      'sem válvula: nada vira aguardando_credito',
    );
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 100);
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
    // ANTERIOR. Devia 80 s (4 × 20 s); 6 programadas, 2 do banco; 5
    // confirmadas → entrega normal = min(5, 6 − 2) = 4 × 20 s = 80 s, e a
    // 5ª confirmada é devolução de dívida antiga, não entrega do mês.
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco,
                                       vezes_confirmadas, segundos_obrigacao, duracao_segundos, minutos_abertos)
       VALUES ($1, $2, $3, 6, 4, 2, 3, 80, 20, 60)`,
      [id, dispositivo[0].id, new Date(inicio.getTime() - 2 * 3600 * 1000)],
    );
    // 00h do dia 1 em Matão: já é o mês corrente — fora da apuração.
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas,
                                       segundos_obrigacao, duracao_segundos, minutos_abertos)
       VALUES ($1, $2, $3, 0, 9, 180, 20, 60)`,
      [id, dispositivo[0].id, inicio],
    );

    const simulado = await apurarMes({ apenasContas: [id], simular: true });
    assert.strictEqual(simulado.segundosDevidos, 20, 'devia 80 s, confirmou 3 × 20 s = 60 s');
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 0, 'simulação não grava');

    const real = await apurarMes({ apenasContas: [id] });
    assert.strictEqual(real.novasLinhas, 1);
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 20);
  } finally {
    await apagarConta(id);
  }
});

test('apuração recusa mês que ainda não fechou em Matão', async () => {
  const { rows } = await pool.query("SELECT to_char(now() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM') AS mes");
  await assert.rejects(apurarMes({ mes: rows[0].mes, apenasContas: [0] }), (err) => err.argumentoInvalido === true);
});

test('liquidação abate só o banco CONFIRMADO (em segundos da hora), uma vez por hora fechada; o resto fica reservado', async () => {
  const { rows: dispositivo } = await pool.query('SELECT id FROM dispositivos LIMIT 1');
  if (!dispositivo.length) return;
  const id = await contaDeTeste();
  try {
    const mesPassado = new Date();
    mesPassado.setMonth(mesPassado.getMonth() - 1, 1);
    await saldoDeTeste(id, mesPassado.toISOString().slice(0, 10), 300);
    // Fechada = passou o prazo do proof-of-play offline (7 dias depois do
    // fim da hora). Uma hora de 6 dias atrás ainda pode receber confirmação.
    const horaFechada = new Date(Date.now() - 8 * 24 * 3600 * 1000);
    horaFechada.setMinutes(0, 0, 0);
    const outraHoraFechada = new Date(horaFechada.getTime() - 3600 * 1000);
    const horaAberta = new Date(Date.now() - 6 * 24 * 3600 * 1000);
    horaAberta.setMinutes(0, 0, 0);
    // Hora fechada A (peça de 30 s): 5 programadas (2 do banco), 4
    // confirmadas → a normal (3) foi toda, e 1 do banco = 30 s. Hora fechada
    // B (20 s): 2 confirmadas de 5 → nada do banco. Hora aberta (6 dias, 20 s):
    // 3 do banco ainda podem ser confirmadas.
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas, vezes_banco,
                                       vezes_confirmadas, duracao_segundos)
       VALUES ($1, $2, $3, 5, 3, 2, 4, 30), ($1, $2, $4, 5, 3, 2, 2, 20), ($1, $2, $5, 3, 0, 3, 0, 20)`,
      [id, dispositivo[0].id, horaFechada, outraHoraFechada, horaAberta],
    );
    assert.strictEqual(
      (await bancoHorasRepo.saldosAtivos())[id].segundos,
      300 - (2 * 30 + 2 * 20 + 3 * 20),
      'disponível = saldo − banco programado ainda não liquidado, na duração de cada hora',
    );

    const simulado = await liquidarBancoConfirmado({ apenasContas: [id], simular: true });
    assert.deepStrictEqual(simulado, { contas: 1, linhas: 2, exibicoesAbatidas: 1, segundosAbatidos: 30 });
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 300, 'simulação não abate');

    const [a, b] = await Promise.all([
      liquidarBancoConfirmado({ apenasContas: [id] }),
      liquidarBancoConfirmado({ apenasContas: [id] }),
    ]);
    assert.strictEqual(a.segundosAbatidos + b.segundosAbatidos, 30, 'duas execuções juntas abatem a hora uma vez só');
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(id), 270);
    assert.strictEqual((await liquidarBancoConfirmado({ apenasContas: [id] })).linhas, 0, 'hora liquidada não volta');
    assert.strictEqual(
      (await bancoHorasRepo.saldosAtivos())[id].segundos,
      270 - 3 * 20,
      'o banco não confirmado das horas fechadas volta a ficar disponível (só a hora aberta segue reservada)',
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
  await dispositivosRepo.atualizar(tela.id, { status: 'ativo' });
  await instalarPlayer(tela.id);
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
    await saldoDeTeste(conta.id, mesPassado.toISOString().slice(0, 10), 150); // 10 peças de 15 s
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
    assert.strictEqual(await bancoHorasRepo.saldoAtivoDoAnunciante(conta.id), 150, 'geração não abate saldo');
    assert.strictEqual(
      (await bancoHorasRepo.saldosAtivos())[conta.id]?.segundos ?? 0,
      150 - rows[0].vezes_banco * 15,
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
