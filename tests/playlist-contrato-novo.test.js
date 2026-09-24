const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const execucoesRepo = require('../src/playlist/execucoes-repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const { registrarHeartbeat } = require('../src/player/sinal');
const pontosRepo = require('../src/pontos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');

// Contrato novo de /playlist e /played (migration 065, pedido do app Android
// nativo `sancompany/playlist.mostrai`): envelope com itemProgramacaoId
// estável por posição, e proof-of-play em lote deduplicado por execucaoId.
// Ver docs/api.md e docs/PENDENCIAS.md seção H.

// Ponto próprio por teste, não um id fixo do "seed local" — o CI sobe um
// Postgres limpo, sem seed nenhum (achado rodando este arquivo pela primeira
// vez no pipeline, 22/09/2026): PONTO_ID=1 nunca existiu lá.
async function criarPontoTeste() {
  return pontosRepo.criar({
    nome: `Ponto Teste ${randomUUID()}`,
    endereco: 'Rua Y, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'Teste',
    responsavel_nome: 'Fulano',
    responsavel_contato: '16999990000',
    // `status` não entra mais aqui — é automático (sincronizarStatusPonto,
    // migration 069): `dispositivoContratoNovo` marca a tela 'ativo' depois
    // de criada, e o ponto acompanha sozinho.
  });
}

async function apagarPonto(id) {
  await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [id]);
  await pool.query('DELETE FROM pontos WHERE id = $1', [id]);
}

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
  const ponto = await criarPontoTeste();
  const dispositivo = await dispositivosRepo.criar(ponto.id, { apelido: `Teste ${randomUUID()}` });
  await dispositivosRepo.atualizar(dispositivo.id, { contrato_playlist: 2, status: 'ativo' });
  // Primeiro sinal: ponto só entra na cobertura depois dele (Player V2).
  await registrarHeartbeat(dispositivo.id, {}, {});
  return dispositivosRepo.buscarComPonto(dispositivo.id);
}

// Escolha explícita do ponto: com outros arquivos rodando em paralelo a rede
// tem vários pontos em operação, e a cobertura automática poderia cair noutro.
async function escolherPonto(contaId, pontoId) {
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [contaId, pontoId]);
}

async function limparDispositivo(id, pontoId) {
  await dispositivosRepo.deletar(id);
  if (pontoId) await apagarPonto(pontoId);
}

async function apagarConta(id) {
  await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

test('gerarPlaylistDaHora devolve o envelope novo com itemProgramacaoId e criativoId estáveis', async () => {
  const conta = await contaComPlanoEAnuncioAprovado();
  const dispositivo = await dispositivoContratoNovo();
  // Escolha explícita do ponto: com outros arquivos de teste rodando em
  // paralelo a rede tem vários pontos em operação, e a cobertura automática
  // do plano poderia cair noutro.
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [
    conta.id,
    dispositivo.ponto_id,
  ]);
  try {
    const hora = new Date();
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, hora);

    assert.strictEqual(envelope.versaoContrato, 2);
    assert.ok(envelope.janelaId.startsWith(`${dispositivo.id}|`));
    assert.ok(envelope.itens.length > 0, 'devia ter pelo menos um item programado');

    const item = envelope.itens.find((i) => i.anuncianteId === conta.id);
    assert.ok(
      item,
      `a conta de teste devia estar programada nesta tela: ${JSON.stringify(envelope.itens.map((i) => i.anuncianteId))} conta=${conta.id}`,
    );
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
    await limparDispositivo(dispositivo.id, dispositivo.ponto_id);
    await apagarConta(conta.id);
  }
});

test('dispositivo com contrato_playlist=1 (padrão) não muda — array de sempre', async () => {
  const ponto = await criarPontoTeste();
  const criado = await dispositivosRepo.criar(ponto.id, { apelido: `Teste ${randomUUID()}` }); // sem tocar contrato_playlist — fica no padrão
  try {
    const dispositivo = await dispositivosRepo.buscarComPonto(criado.id);
    assert.strictEqual(dispositivo.contrato_playlist, 1);
  } finally {
    await limparDispositivo(criado.id, ponto.id);
  }
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
    await limparDispositivo(dispositivo.id, dispositivo.ponto_id);
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
    await limparDispositivo(dispositivo.id, dispositivo.ponto_id);
    await apagarConta(conta.id);
  }
});

// Achado real em revisão (Codex, PR #20, 23/09/2026): anunciantesElegiveis
// junta COALESCE(plano_id, comodato_plano_id), mas o WHERE ainda excluía a
// conta INTEIRA quando `data_expiracao` (do plano COMERCIAL) tinha passado —
// mesmo com comodato ativo, que não tem validade própria (é ligado à
// modalidade do ponto, não a um ciclo). Um Básico com plano pago vencido
// sumia da playlist até o próximo encerrarCoberturaVencida, um dia depois.
test('gerarPlaylistDaHora: cai pro comodato quando o plano comercial venceu, sem sumir da playlist', async () => {
  const comodato = require('../src/pontos/comodato');
  const conta = await contaComPlanoEAnuncioAprovado();
  const dispositivo = await dispositivoContratoNovo();
  await escolherPonto(conta.id, dispositivo.ponto_id);
  try {
    // O próprio dono do ponto também cede a parede (Básico) — dá o
    // comodato_plano_id independente que o plano comercial vencido devia
    // ceder lugar.
    await pontosRepo.atualizar(dispositivo.ponto_id, { anunciante_id: conta.id, plano_ponto_id: 'mais-cota' });
    await comodato.sincronizarComodato(conta.id);
    // Plano comercial VENCIDO — como fica entre a cobrança recorrente falhar
    // e a conciliação diária ainda não ter rodado.
    await anunciantesRepo.atualizar(conta.id, { data_expiracao: '2020-01-01' });

    const hora = new Date();
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, hora);
    const item = envelope.itens.find((i) => i.anuncianteId === conta.id);
    assert.ok(item, 'comodato (Básico) mantém a conta elegível mesmo com o comercial vencido');

    // Controle: sem comodato nenhum (só o plano comercial, vencido), a conta
    // continua de fora — o achado não é "nunca mais expira", é só "cai pro
    // comodato quando ele existir".
    await pontosRepo.atualizar(dispositivo.ponto_id, { anunciante_id: null, plano_ponto_id: null });
    await pool.query('UPDATE anunciantes SET comodato_plano_id = NULL WHERE id = $1', [conta.id]);
    const envelopeSemComodato = await gerador.gerarPlaylistDaHora(dispositivo, hora);
    assert.ok(
      !envelopeSemComodato.itens.some((i) => i.anuncianteId === conta.id),
      'sem comodato nenhum, plano comercial vencido continua de fora',
    );
  } finally {
    await pool.query('UPDATE pontos SET anunciante_id = NULL, plano_ponto_id = NULL WHERE id = $1', [
      dispositivo.ponto_id,
    ]);
    await limparDispositivo(dispositivo.id, dispositivo.ponto_id);
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
    await limparDispositivo(dispositivo.id, dispositivo.ponto_id);
  }
});
