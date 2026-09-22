const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const dispositivosRepo = require('../src/dispositivos/repository');
const pontosRepo = require('../src/pontos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const categoriasRepo = require('../src/categorias/repository');
const { liberarPapelNaConta } = require('../src/conta/modos');

// Regra de bloqueio de concorrência (src/playlist/gerador.js:112,
// anunciantesElegiveis): pontos.categoria_id === anunciantes.categoria_id
// exclui o anunciante da playlist daquela tela. A reforma da taxonomia
// (22/09/2026, migration 067 — ~230 categorias específicas em vez de 25
// amplas, grupo/aliases só pra organização e busca) NÃO mudou essa regra,
// só deixou os valores comparados mais precisos. Não havia nenhum teste
// cobrindo essa regra antes desta migration (achado no mapeamento).

async function idDaCategoria(nome) {
  const { rows } = await pool.query('SELECT id FROM categorias WHERE nome = $1', [nome]);
  if (!rows[0]) throw new Error(`categoria de teste "${nome}" não existe no catálogo`);
  return rows[0].id;
}

async function criarPontoTeste(categoriaId) {
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
    // migration 069) e quem decide é `dispositivoDoPonto`, marcando a tela
    // 'ativo' depois de criada.
    categoria_id: categoriaId || null,
  });
}

async function dispositivoDoPonto(pontoId) {
  const dispositivo = await dispositivosRepo.criar(pontoId, { apelido: `Teste ${randomUUID()}` });
  // Nasce 'inativo' (default da coluna) — precisa virar 'ativo' pra contar
  // como tela em operação (o ponto acompanha via sincronizarStatusPonto).
  await dispositivosRepo.atualizar(dispositivo.id, { status: 'ativo' });
  return dispositivosRepo.buscarComPonto(dispositivo.id);
}

async function contaComPlanoEAnuncioAprovado(campos) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Teste Bloqueio ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `bloqueio-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
    ...campos,
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

async function limpar({ pontoId, dispositivoId, contaId }) {
  if (dispositivoId) await dispositivosRepo.deletar(dispositivoId);
  if (pontoId) await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  if (contaId) {
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
  }
}

test('mesma categoria: anunciante NÃO aparece na playlist do ponto concorrente', async () => {
  const catBarbearia = await idDaCategoria('Barbearia');
  const ponto = await criarPontoTeste(catBarbearia);
  const dispositivo = await dispositivoDoPonto(ponto.id);
  const conta = await contaComPlanoEAnuncioAprovado({ categoria_id: catBarbearia });
  try {
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
    assert.ok(
      !envelope.itens.find((i) => i.anuncianteId === conta.id),
      'barbearia não devia aparecer na tela de outra barbearia',
    );
  } finally {
    await limpar({ pontoId: ponto.id, dispositivoId: dispositivo.id, contaId: conta.id });
  }
});

test('categorias diferentes: os dois entram na playlist', async () => {
  const catBarbearia = await idDaCategoria('Barbearia');
  const catAcademia = await idDaCategoria('Academia');
  const ponto = await criarPontoTeste(catBarbearia);
  const dispositivo = await dispositivoDoPonto(ponto.id);
  const conta = await contaComPlanoEAnuncioAprovado({ categoria_id: catAcademia });
  try {
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
    assert.ok(
      envelope.itens.find((i) => i.anuncianteId === conta.id),
      'academia devia poder anunciar na tela de uma barbearia — categorias diferentes não bloqueiam',
    );
  } finally {
    await limpar({ pontoId: ponto.id, dispositivoId: dispositivo.id, contaId: conta.id });
  }
});

test('ponto sem categoria definida: ninguém é bloqueado', async () => {
  const catBarbearia = await idDaCategoria('Barbearia');
  const ponto = await criarPontoTeste(null);
  const dispositivo = await dispositivoDoPonto(ponto.id);
  const conta = await contaComPlanoEAnuncioAprovado({ categoria_id: catBarbearia });
  try {
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
    assert.ok(envelope.itens.find((i) => i.anuncianteId === conta.id));
  } finally {
    await limpar({ pontoId: ponto.id, dispositivoId: dispositivo.id, contaId: conta.id });
  }
});

test('anunciante sem categoria_id (só categoria_livre): nunca é bloqueado, mesmo com o mesmo texto', async () => {
  const catBarbearia = await idDaCategoria('Barbearia');
  const ponto = await criarPontoTeste(catBarbearia);
  const dispositivo = await dispositivoDoPonto(ponto.id);
  const conta = await contaComPlanoEAnuncioAprovado({ categoria_livre: 'Barbearia da esquina' });
  try {
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
    assert.ok(
      envelope.itens.find((i) => i.anuncianteId === conta.id),
      'categoria_livre nunca entra na regra de bloqueio — só categoria_id (ver comentário em ponto.page.js)',
    );
  } finally {
    await limpar({ pontoId: ponto.id, dispositivoId: dispositivo.id, contaId: conta.id });
  }
});

test('categoria legada continua bloqueando quem já a usa (legado só tira do cadastro novo)', async () => {
  const { rows } = await pool.query('SELECT id FROM categorias WHERE legado LIMIT 1');
  const legado = rows[0];
  assert.ok(legado, 'precisa de ao menos uma categoria legado no catálogo pra este teste fazer sentido');
  const ponto = await criarPontoTeste(legado.id);
  const dispositivo = await dispositivoDoPonto(ponto.id);
  const conta = await contaComPlanoEAnuncioAprovado({ categoria_id: legado.id });
  try {
    const envelope = await gerador.gerarPlaylistDaHora(dispositivo, new Date());
    assert.ok(
      !envelope.itens.find((i) => i.anuncianteId === conta.id),
      'quem já usa uma categoria legado continua protegido — legado só sai do catálogo oferecido a cadastro novo',
    );
  } finally {
    await limpar({ pontoId: ponto.id, dispositivoId: dispositivo.id, contaId: conta.id });
  }
});

test('GET /categorias (catalogo público) só devolve ativas e não-legado', async () => {
  const { rows } = await pool.query(
    'SELECT id, nome, grupo, aliases FROM categorias WHERE ativo AND NOT legado ORDER BY grupo, nome',
  );
  assert.ok(rows.length > 100, 'catálogo novo tem ~230 categorias específicas');
  const nomes = rows.map((r) => r.nome);
  assert.ok(!nomes.includes('Outro'), '"Outro" foi descontinuado — vira categoria_livre + categoria_id null');
  assert.ok(!nomes.includes('Clínica / consultório'), 'categoria antiga ampla não aparece mais pro cadastro novo');
  assert.ok(nomes.includes('Odontologia'), 'categoria antiga específica o bastante continua ativa');
  assert.ok(
    rows.every((r) => r.grupo),
    'toda categoria ativa e não-legado do catálogo novo tem grupo definido',
  );
});

test('categoria inativa/legado não passa em buscarAtivaPorId (validação de cadastro recusa)', async () => {
  const { rows } = await pool.query('SELECT id FROM categorias WHERE legado LIMIT 1');
  const encontrada = await categoriasRepo.buscarAtivaPorId(rows[0].id);
  assert.strictEqual(encontrada, null, 'categoria legado não deve validar como escolha nova');
});

// liberarPapelNaConta é o caminho PRINCIPAL de "ponto nasce de candidatura"
// (candidatura pelo painel de uma conta já existente — o mais comum, ver
// docs/PENDENCIAS.md). Furo achado no mapeamento de 22/09/2026: o ponto
// nascia sem categoria_id NENHUMA, mesmo quando a conta que virou ponto já
// tinha uma — a regra de bloqueio ficava inoperante em todo ponto criado
// por aqui. src/anunciantes/routes.js#criarPontoDaCandidatura (caminho
// irmão, convite-na-hora-do-cadastro) tem o mesmo defeito e a mesma
// correção, não coberto por teste próprio aqui — é o caminho bem menos
// usado (convite com candidatura embutida), verificado manualmente.
test('liberarPapelNaConta propaga a categoria da conta pro ponto novo', async () => {
  const catBarbearia = await idDaCategoria('Barbearia');
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Dono Ponto ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `dono-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
    categoria_id: catBarbearia,
  });
  const cand = {
    tipo: 'ponto',
    nome_comercio: 'Barbearia do Zé',
    endereco: 'Rua Z, 10',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    segmento: 'Barbearia',
    nome: 'Zé',
    contato_telefone: '16988887777',
    fluxo_estimado_mensal: 1000,
  };
  // criarCupom usa SAVEPOINT por dentro — precisa de uma transação de
  // verdade, não dá pra chamar liberarPapelNaConta com o pool cru (mesmo
  // padrão de emTransacao em src/conta/modos.js).
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await liberarPapelNaConta(conta, 'ponto', cand, cliente);
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
  const { rows } = await pool.query('SELECT id, categoria_id FROM pontos WHERE anunciante_id = $1', [conta.id]);
  try {
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(
      rows[0].categoria_id,
      catBarbearia,
      'ponto nascido da candidatura devia herdar a categoria da conta',
    );
  } finally {
    const pontoId = rows[0]?.id;
    if (pontoId) {
      await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
      await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
    }
    await pool.query('DELETE FROM cupons_ponto WHERE conta_id = $1', [conta.id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
  }
});
