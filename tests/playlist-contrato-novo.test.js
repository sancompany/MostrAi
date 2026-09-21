const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const execucoesRepo = require('../src/playlist/execucoes-repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');

// Contrato novo de /playlist e /played (migration 065, pedido do app Android
// nativo `sancompany/playlist.mostrai`): envelope com itemProgramacaoId
// estável por posição, e proof-of-play em lote deduplicado por execucaoId.
// Ver docs/api.md e docs/PENDENCIAS.md seção H.

const PONTO_ID = 1; // "Farmácia Central", em_operacao — já existe no seed local.

async function contaComPlanoEAnuncioAprovado() {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Teste Contrato ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `contrato-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  await anunciantesRepo.atualizar(conta.id, { plano_id: 'essencial-1m' });
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: 'https://exemplo.test/normalizado.mp4',
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  return conta;
}

async function dispositivoContratoNovo() {
  const dispositivo = await dispositivosRepo.criar(PONTO_ID, { apelido: `Teste ${randomUUID()}` });
  await dispositivosRepo.atualizar(dispositivo.id, { contrato_playlist: 2 });
  return dispositivosRepo.buscarComPonto(dispositivo.id);
}

async function limparDispositivo(id) {
  await dispositivosRepo.deletar(id);
}

async function apagarConta(id) {
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

test('gerarPlaylistDaHora devolve o envelope novo com itemProgramacaoId e criativoId estáveis', async () => {
  const conta = await contaComPlanoEAnuncioAprovado();
  const dispositivo = await dispositivoContratoNovo();
  try {
    const hora = new Date();
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, hora);

    assert.strictEqual(envelope.versaoContrato, 2);
    assert.ok(envelope.janelaId.startsWith(`${dispositivo.id}|`));
    assert.ok(envelope.itens.length > 0, 'devia ter pelo menos um item programado');

    const item = envelope.itens.find((i) => i.anuncianteId === conta.id);
    assert.ok(item, 'a conta de teste devia estar programada nesta tela');
    assert.strictEqual(item.contabiliza, true);
    assert.strictEqual(item.autoanuncio, false);
    assert.strictEqual(item.institucional, false);
    assert.match(item.itemProgramacaoId, /^\d+\|.+\|\d+\|\d+$/);
    assert.ok(item.itemProgramacaoId.startsWith(`${envelope.janelaId}|`));
    assert.strictEqual(typeof item.criativoId, 'string');

    // Um segundo poll, na mesma hora, tem que devolver a MESMA identidade —
    // é a garantia que o app depende pra reancorar sem reiniciar a exibição
    // em andamento (RN-09, playlist.mostrai).
    const envelope2 = await gerador.gerarPlaylistDaHora(dispositivo, hora);
    const item2 = envelope2.itens.find((i) => i.anuncianteId === conta.id);
    assert.strictEqual(item2.itemProgramacaoId, item.itemProgramacaoId);
    assert.strictEqual(item2.criativoId, item.criativoId);
  } finally {
    await limparDispositivo(dispositivo.id);
    await apagarConta(conta.id);
  }
});

test('dispositivo com contrato_playlist=1 (padrão) não muda — array de sempre', async () => {
  const dispositivo = await dispositivosRepo.buscarComPonto(1); // Tela 1 do seed, nunca migrada pra contrato 2
  assert.strictEqual(dispositivo.contrato_playlist, 1);
});

test('confirmarComDedup credita uma vez, e a retentativa com o mesmo execucaoId devolve duplicado', async () => {
  const conta = await contaComPlanoEAnuncioAprovado();
  const dispositivo = await dispositivoContratoNovo();
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  try {
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas)
       VALUES ($1, $2, $3, 1)`,
      [conta.id, dispositivo.id, hora],
    );
    const janelaId = `${dispositivo.id}|${hora.toISOString()}`;
    const evento = {
      execucaoId: randomUUID(),
      janelaId,
      itemProgramacaoId: `${janelaId}|0|${conta.id}`,
      criativoId: '1',
      iniciadoEm: new Date().toISOString(),
      terminadoEm: new Date().toISOString(),
    };

    const primeira = await execucoesRepo.confirmarComDedup(dispositivo.id, evento, new Date());
    assert.strictEqual(primeira.status, 'contabilizado');

    const { rows } = await pool.query(
      'SELECT vezes_confirmadas FROM exibicoes_contador WHERE anunciante_id=$1 AND dispositivo_id=$2 AND janela_hora=$3',
      [conta.id, dispositivo.id, hora],
    );
    assert.strictEqual(rows[0].vezes_confirmadas, 1);

    // Mesmo execucaoId de novo (retentativa depois de resposta perdida) —
    // nunca pode creditar duas vezes o mesmo execucaoId.
    const retentativa = await execucoesRepo.confirmarComDedup(dispositivo.id, evento, new Date());
    assert.strictEqual(retentativa.status, 'duplicado');

    const { rows: depois } = await pool.query(
      'SELECT vezes_confirmadas FROM exibicoes_contador WHERE anunciante_id=$1 AND dispositivo_id=$2 AND janela_hora=$3',
      [conta.id, dispositivo.id, hora],
    );
    assert.strictEqual(depois[0].vezes_confirmadas, 1, 'não pode dobrar o crédito na retentativa');
  } finally {
    await limparDispositivo(dispositivo.id);
    await apagarConta(conta.id);
  }
});

test('confirmarComDedup: teto atingido quando já confirmou tudo que foi programado', async () => {
  const conta = await contaComPlanoEAnuncioAprovado();
  const dispositivo = await dispositivoContratoNovo();
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  try {
    await pool.query(
      `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas)
       VALUES ($1, $2, $3, 1, 1)`,
      [conta.id, dispositivo.id, hora],
    );
    const janelaId = `${dispositivo.id}|${hora.toISOString()}`;
    const evento = {
      execucaoId: randomUUID(),
      janelaId,
      itemProgramacaoId: `${janelaId}|0|${conta.id}`,
    };
    const resultado = await execucoesRepo.confirmarComDedup(dispositivo.id, evento, new Date());
    assert.strictEqual(resultado.status, 'teto_atingido');
  } finally {
    await limparDispositivo(dispositivo.id);
    await apagarConta(conta.id);
  }
});

test('confirmarExecucao: item malformado, janela de outra tela e janela expirada', async () => {
  const dispositivo = await dispositivoContratoNovo();
  try {
    assert.strictEqual(await gerador.confirmarExecucao(dispositivo.id, 'lixo', 'lixo', new Date()), 'item_invalido');

    const hora = new Date();
    hora.setMinutes(0, 0, 0);
    const janelaOutraTela = `999999|${hora.toISOString()}`;
    assert.strictEqual(
      await gerador.confirmarExecucao(dispositivo.id, `${janelaOutraTela}|0|1`, janelaOutraTela, new Date()),
      'janela_desconhecida',
    );

    const horaAntiga = new Date('2020-01-01T00:00:00.000Z');
    const janelaAntiga = `${dispositivo.id}|${horaAntiga.toISOString()}`;
    assert.strictEqual(
      await gerador.confirmarExecucao(dispositivo.id, `${janelaAntiga}|0|1`, janelaAntiga, new Date()),
      'janela_expirada',
    );
  } finally {
    await limparDispositivo(dispositivo.id);
  }
});
