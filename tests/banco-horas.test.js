const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const bancoHorasRepo = require('../src/bancohoras/repository');
const { apurarMesAnterior, MESES_PARA_FILA_DE_CREDITO } = require('../src/bancohoras/apuracao');

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
  await pool.query('DELETE FROM exibicoes_contador WHERE anunciante_id = $1', [anuncianteId]);
  await pool.query('DELETE FROM banco_horas WHERE anunciante_id = $1', [anuncianteId]);
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

test('apurarMesAnterior fecha o déficit do mês anterior por vezes_programadas, não por vezes_confirmadas', async () => {
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

    const resultado = await apurarMesAnterior();
    assert.ok(resultado.anunciantesComDeficit >= 1);
    assert.strictEqual(
      await bancoHorasRepo.saldoAtivoDoAnunciante(id),
      1,
      '5 pedidas - 4 programadas = 1 (a queda pra 1 confirmada é problema de tela offline, não entra na conta)',
    );
  } finally {
    await apagarConta(id);
  }
});

test('a válvula move pra aguardando_credito só depois de N meses, e resolverCredito tira da fila', async () => {
  const id = await contaDeTeste();
  try {
    const meses = MESES_PARA_FILA_DE_CREDITO;
    const antigo = new Date();
    antigo.setMonth(antigo.getMonth() - (meses + 1));
    await bancoHorasRepo.registrarDeficit({
      anuncianteId: id,
      mesReferencia: antigo.toISOString().slice(0, 10),
      exibicoesPedidas: 10,
      exibicoesEntregues: 5,
    });

    const { rows: antesQuery } = await pool.query('SELECT id FROM banco_horas WHERE anunciante_id = $1', [id]);
    const linhaId = antesQuery[0].id;

    const { linhasMovidas } = await require('../src/bancohoras/apuracao').aplicarValvula();
    assert.ok(linhasMovidas >= 1);

    const fila = await bancoHorasRepo.listarAguardandoCredito();
    assert.ok(
      fila.some((l) => l.id === linhaId),
      'a linha antiga entrou na fila do admin',
    );

    await bancoHorasRepo.resolverCredito(linhaId);
    const filaDepois = await bancoHorasRepo.listarAguardandoCredito();
    assert.ok(!filaDepois.some((l) => l.id === linhaId), 'resolvida, sai da fila');
  } finally {
    await apagarConta(id);
  }
});
