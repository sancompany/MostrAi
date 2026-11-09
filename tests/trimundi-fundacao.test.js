const test = require('node:test');
const assert = require('node:assert');
const apoio = require('./trimundi-apoio');
const config = require('../src/trimundi/config');
const { consultar } = require('../src/trimundi/db/conexao');
const { migrar } = require('../src/trimundi/db/migrate');
const qr = require('../src/trimundi/lib/qr');
const codigos = require('../src/trimundi/lib/codigos');
const { estadoDaCategoria, criarAlocador } = require('../src/trimundi/disponibilidade');
const poolMostrai = require('../src/db/pool');

// Trimundi, Etapa 1 — fundação: banco próprio e separado do da Mostraí,
// travas de segurança, migration idempotente, RLS, histórico imutável, QR
// assinado sem dado pessoal, códigos aleatórios e a regra de estoque por
// lote (função pura).

test.before(() => apoio.prepararBanco());
test.after(() => apoio.encerrar());

function comAmbiente(valores, fn) {
  const antes = {};
  for (const [k, val] of Object.entries(valores)) {
    antes[k] = process.env[k];
    if (val === undefined) delete process.env[k];
    else process.env[k] = val;
  }
  try {
    return fn();
  } finally {
    for (const [k, val] of Object.entries(antes)) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
}

test('a Trimundi mora no esquema `trimundi` do banco da Mostraí; o `public` não ganha nada', async () => {
  assert.equal(config.configurada(), true);
  assert.equal(config.identidadeDoBanco(config.urlDoBanco()), config.identidadeDoBanco(process.env.DATABASE_URL));
  const { rows: mostrai } = await poolMostrai.query(
    "SELECT to_regclass('public.ingressos') AS a, to_regclass('public.operador_permissoes') AS b, to_regclass('trimundi.ingressos')::text AS c",
  );
  assert.deepEqual(mostrai[0], { a: null, b: null, c: 'trimundi.ingressos' });
  const { rows: trimundi } = await consultar(
    "SELECT current_schema() AS s, (SELECT count(*) FROM schema_migrations WHERE filename = '001_fundacao.sql')::int AS m",
  );
  assert.deepEqual(trimundi[0], { s: 'trimundi', m: 1 });
  // A tabela de controle da Mostraí continua sendo só dela.
  const { rows: controle } = await poolMostrai.query(
    "SELECT count(*)::int AS n FROM public.schema_migrations WHERE filename LIKE '%fundacao%'",
  );
  assert.equal(controle[0].n, 0);
  // Toda tabela do esquema tem RLS; nenhuma do `public` foi mexida pela Trimundi.
  const { rows: semRls } = await poolMostrai.query(
    "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'trimundi' AND tablename <> 'schema_migrations' AND NOT rowsecurity",
  );
  assert.equal(semRls[0].n, 0);
});

test('o pooler de transação (porta 6543) desliga a Trimundi: o esquema por conexão não se sustentaria', () => {
  const u = new URL(process.env.DATABASE_URL);
  u.port = '6543';
  comAmbiente({ TRIMUNDI_DATABASE_URL: u.toString() }, () => {
    assert.equal(config.poolerDeTransacao(), true);
    assert.equal(config.configurada(), false);
  });
  comAmbiente({ TRIMUNDI_ATIVA: '', TRIMUNDI_DATABASE_URL: '' }, () => {
    assert.equal(config.configurada(), false, 'sem TRIMUNDI_ATIVA=1 o módulo fica desligado');
  });
});

test('conexão que não consegue entrar no esquema é recusada (falha fechado)', async () => {
  const { Pool } = require('pg');
  const conexao = require('../src/trimundi/db/conexao');
  const original = config.ESQUEMA;
  // Um SET que o servidor recusa: a conexão não pode seguir no `public`.
  const ClienteTrimundi = conexao.obterPool().options.Client;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, Client: ClienteTrimundi });
  try {
    config.ESQUEMA = 'esquema invalido';
    await assert.rejects(pool.query('SELECT 1'), /syntax|sintaxe/);
  } finally {
    config.ESQUEMA = original;
    await pool.end();
  }
});

test('em produção, sem segredo próprio, a Trimundi não liga; simulado e disco local nunca valem', () => {
  comAmbiente(
    { NODE_ENV: 'production', TRIMUNDI_SEGREDO: '', TRIMUNDI_PAGAMENTO_SIMULADO: '1', TRIMUNDI_ARMAZENAMENTO: 'local' },
    () => {
      assert.equal(config.segredoMestre(), null);
      assert.equal(config.configurada(), false);
      assert.equal(config.pagamentoSimulado(), false);
      assert.equal(config.armazenamento().tipo, null);
      assert.equal(config.email().captura, '');
    },
  );
  comAmbiente({ NODE_ENV: 'production', TRIMUNDI_SEGREDO: 'curto' }, () => {
    assert.equal(config.segredoMestre(), null, 'segredo com menos de 32 caracteres não serve');
  });
});

test('a migration roda de novo sem efeito (idempotente, com trava)', async () => {
  await Promise.all([migrar({ silencioso: true }), migrar({ silencioso: true })]);
  const { rows } = await consultar('SELECT count(*)::int AS n FROM schema_migrations');
  const arquivos = require('node:fs')
    .readdirSync(require('node:path').join(__dirname, '../src/trimundi/db/migrations'))
    .filter((f) => f.endsWith('.sql'));
  assert.equal(rows[0].n, arquivos.length, 'uma linha por arquivo, nenhuma em dobro');
});

test('toda tabela tem RLS ligada (a API pública do Supabase não lê nada)', async () => {
  const { rows } = await consultar("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity");
  assert.deepEqual(rows, []);
  const { rows: total } = await consultar("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
  assert.ok(total[0].n >= 30, `esperava as tabelas da fundação, achou ${total[0].n}`);
});

test('histórico não muda: auditoria, métricas e versão de termo gravada', async () => {
  const { edicao } = await apoio.edicaoPronta({ publicar: false });
  const { rows: a } = await consultar('SELECT id FROM auditoria WHERE entidade = $1 AND entidade_id = $2 LIMIT 1', [
    'edicao',
    String(edicao.id),
  ]);
  assert.ok(a[0], 'criar a edição grava a auditoria');
  await assert.rejects(
    consultar("UPDATE auditoria SET acao = 'outra' WHERE id = $1", [a[0].id]),
    /histórico e não muda/,
  );
  await assert.rejects(consultar('DELETE FROM auditoria WHERE id = $1', [a[0].id]), /histórico e não muda/);

  const termo = edicao.textos.termos_compra;
  await assert.rejects(consultar("UPDATE termos SET texto = 'trocado' WHERE id = $1", [termo.id]), /não muda/);
  await assert.rejects(consultar('DELETE FROM termos WHERE id = $1', [termo.id]), /não se apaga/);
  // Só a marca de vigente anda.
  await consultar('UPDATE termos SET vigente = false WHERE id = $1', [termo.id]);
});

test('QR: assinado por edição, sem dado pessoal, e qualquer alteração invalida', () => {
  const edicaoA = codigos.codigoPublico();
  const edicaoB = codigos.codigoPublico();
  const codigo = codigos.codigoIngresso();
  const conteudo = qr.conteudoDoQr(edicaoA, codigo);
  assert.match(conteudo, /^TM1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{86}$/);
  assert.deepEqual(qr.lerQr(conteudo), { codigoPublico: edicaoA, codigo });
  assert.deepEqual(qr.lerQr(`  ${conteudo}\n`), { codigoPublico: edicaoA, codigo }, 'leitor que manda espaço');

  const [prefixo, pub, cod, assinatura] = conteudo.split('.');
  const trocar = (s) => (s[5] === 'A' ? `${s.slice(0, 5)}B${s.slice(6)}` : `${s.slice(0, 5)}A${s.slice(6)}`);
  assert.equal(
    qr.lerQr([prefixo, pub, trocar(cod), assinatura].join('.')),
    null,
    'outro código com a mesma assinatura',
  );
  assert.equal(qr.lerQr([prefixo, pub, cod, trocar(assinatura)].join('.')), null, 'assinatura alterada');
  assert.equal(qr.lerQr([prefixo, edicaoB, cod, assinatura].join('.')), null, 'assinatura de outra edição');
  assert.equal(qr.lerQr(conteudo.slice(0, -1)), null, 'cortado');
  assert.equal(qr.lerQr('https://exemplo.com/?q=TM1'), null);
  assert.equal(qr.lerQr(''), null);
  // A assinatura confere com a chave pública da edição (validação sem internet).
  assert.match(qr.chavePublicaDaEdicao(edicaoA), /^[A-Za-z0-9_-]+$/);
  assert.notEqual(qr.chavePublicaDaEdicao(edicaoA), qr.chavePublicaDaEdicao(edicaoB));
});

test('códigos: aleatórios, no formato, e o curto aceita o que a portaria digita', () => {
  const vistos = new Set();
  for (let i = 0; i < 5000; i++) {
    const c = codigos.codigoCurto();
    assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    vistos.add(c);
  }
  assert.ok(vistos.size > 4990, 'sem repetição relevante');
  assert.equal(codigos.normalizarCodigoCurto('abcd efgh'), 'ABCD-EFGH');
  assert.equal(codigos.normalizarCodigoCurto(' k7m2-p9qx '), 'K7M2-P9QX');
  assert.equal(codigos.normalizarCodigoCurto('ABCD-EFG0'), null, 'zero não existe no alfabeto');
  assert.equal(codigos.normalizarCodigoCurto('ABCD-EFGI'), null, 'I não existe no alfabeto');
  assert.equal(codigos.normalizarCodigoCurto('ABCD-EFG'), null);
  assert.match(codigos.codigoIngresso(), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(codigos.codigoIngresso(), codigos.codigoIngresso());
  assert.match(codigos.token(), /^[A-Za-z0-9_-]{32}$/);
  assert.match(codigos.hashToken('x'), /^[0-9a-f]{64}$/);
});

// ---------------------------------------------------------------- estoque
const agora = new Date('2026-12-01T12:00:00Z');
const antes = (h) => new Date(agora.getTime() - h * 3600000);
const depois = (h) => new Date(agora.getTime() + h * 3600000);
const lote = (id, ordem, quantidade, extra = {}) => ({
  id,
  categoria_id: 1,
  ordem,
  preco_centavos: 1000 * ordem,
  quantidade,
  inicio_vendas: null,
  fim_vendas: null,
  encerrado_em: null,
  motivo_encerramento: null,
  pagos: 0,
  reservados: 0,
  ...extra,
});

test('estoque: lote cheio só de reservas deixa o seguinte vender, sem marca permanente', () => {
  const e = estadoDaCategoria([lote(1, 1, 10, { pagos: 6, reservados: 4 }), lote(2, 2, 20, { pagos: 1 })], agora);
  assert.deepEqual(
    e.lotes.map((l) => l.situacao),
    ['esgotado', 'a_venda'],
  );
  assert.equal(e.vigente.id, 2);
  assert.equal(e.disponivelAgora, 19);
  assert.deepEqual(e.semMarca, [], 'só PAGOS completam um lote; reserva pode vencer');
});

test('estoque: reserva vencida devolve a vaga ao próprio lote, que volta a ser o vigente', () => {
  // Antes: 6 pagos + 4 reservados no 1º. As 4 venceram: o 1º volta à venda.
  const e = estadoDaCategoria([lote(1, 1, 10, { pagos: 6 }), lote(2, 2, 20, { pagos: 1 })], agora);
  assert.deepEqual(
    e.lotes.map((l) => l.situacao),
    ['a_venda', 'aguardando_anterior'],
  );
  assert.equal(e.vigente.id, 1);
  assert.equal(e.lotes[0].disponivel, 4);
});

test('estoque: lote completo por pagos recebe a marca; sem ela ainda, entra em semMarca', () => {
  const e = estadoDaCategoria([lote(1, 1, 10, { pagos: 10 }), lote(2, 2, 5)], agora);
  assert.deepEqual(e.semMarca, [1]);
  assert.equal(e.vigente.id, 2);
});

test('estoque: o que não vendeu num lote encerrado NÃO passa para o próximo', () => {
  const e = estadoDaCategoria(
    [lote(1, 1, 10, { pagos: 7, encerrado_em: antes(1), motivo_encerramento: 'manual' }), lote(2, 2, 5)],
    agora,
  );
  assert.equal(e.lotes[0].situacao, 'encerrado');
  assert.equal(e.lotes[1].efetiva, 5, 'só a quantidade do próprio lote');
  assert.equal(e.disponivelAgora, 5);
});

test('estoque: lote fechado não reabre — nem esgotado por pagos, nem à mão, nem pela data', () => {
  const marca = { encerrado_em: antes(1), motivo_encerramento: 'esgotado' };
  const e = estadoDaCategoria([lote(1, 1, 2, { pagos: 1, ...marca }), lote(2, 2, 3, { pagos: 2, ...marca })], agora);
  assert.equal(e.disponivelAgora, 0);
  assert.equal(e.vigente, null);
  const manual = estadoDaCategoria(
    [lote(1, 1, 3, { pagos: 1, encerrado_em: antes(1), motivo_encerramento: 'manual' })],
    agora,
  );
  assert.equal(manual.disponivelAgora, 0);
  const porData = estadoDaCategoria([lote(1, 1, 3, { pagos: 1, fim_vendas: antes(1) })], agora);
  assert.equal(porData.disponivelAgora, 0);
});

test('estoque: fim de vendas passado fecha o lote; início no futuro deixa a categoria agendada', () => {
  const e = estadoDaCategoria(
    [lote(1, 1, 10, { fim_vendas: antes(2) }), lote(2, 2, 10, { inicio_vendas: depois(5) })],
    agora,
  );
  assert.deepEqual(
    e.lotes.map((l) => l.situacao),
    ['encerrado', 'agendado'],
  );
  assert.equal(e.disponivelAgora, 0);
  assert.equal(e.proximoInicio.getTime(), depois(5).getTime());
  assert.equal(e.lotes[1].efetiva, 10, 'sem sobra do lote fechado');
});

test('estoque: lote que começa no futuro não entra na cadeia do vigente', () => {
  const e = estadoDaCategoria([lote(1, 1, 3), lote(2, 2, 10, { inicio_vendas: depois(24) })], agora);
  assert.equal(e.vigente.id, 1);
  assert.equal(e.disponivelAgora, 3, 'o 2º lote só abre na data dele');
});

test('alocador: divide o pedido entre lotes e recusa o que não cabe', () => {
  const lotes = new Map([[1, [lote(1, 1, 2, { pagos: 1 }), lote(2, 2, 3)]]]);
  const a = criarAlocador(lotes, agora);
  const partes = a.tirar(1, 3, 'Pista');
  assert.deepEqual(
    partes.map((p) => [p.lote.id, p.quantidade]),
    [
      [1, 1],
      [2, 2],
    ],
  );
  assert.equal(a.disponivel(1), 1);
  assert.throws(
    () => a.tirar(1, 2, 'Pista'),
    (err) => err.status === 409 && err.extra?.disponivel === 1 && /Restam só 1 de Pista/.test(err.message),
  );
  assert.throws(
    () => a.tirar(99, 1, 'Outro'),
    (err) => err.status === 409,
  );
});

test('retenção (D2): ensaio não muda nada; com confirmação, anonimiza só o vencido e guarda o financeiro', async () => {
  const retencao = require('../src/trimundi/retencao');
  const eventos = require('../src/trimundi/eventos');
  const pronta = await apoio.edicaoPronta();
  const p = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, 1));
  await apoio.pagar(p.pedido_id);
  await eventos.mudarStatus(pronta.edicao.id, 'encerrado', apoio.AUTOR);
  // Prazo de teste: tudo que é desta edição já "venceu" (0 dias); o resto do
  // banco de teste pode vencer junto — por isso só se confere esta edição.
  const prazos = {
    participantesDiasAposEdicao: -1,
    emailsDiasAposEnvio: 100000,
    compradoresDiasAposPedido: 100000,
    operadoresDiasAposDesativar: 100000,
  };
  const ensaio = await retencao.anonimizarVencidos({ prazos });
  assert.equal(ensaio.ensaio, true);
  const antes = await consultar('SELECT nome FROM participantes WHERE edicao_id = $1', [pronta.edicao.id]);
  assert.ok(antes.rows[0].nome, 'ensaio não anonimiza');
  await retencao.anonimizarVencidos({ prazos, confirmar: true });
  const { rows } = await consultar(
    `SELECT pa.nome, pa.cpf, pa.email, pa.anonimizado_em, p.total_centavos, p.status
       FROM ingressos i JOIN participantes pa ON pa.id = i.participante_id JOIN pedidos p ON p.id = i.pedido_id
      WHERE i.edicao_id = $1`,
    [pronta.edicao.id],
  );
  assert.equal(rows[0].nome, null);
  assert.equal(rows[0].cpf, null);
  assert.equal(rows[0].email, null);
  assert.ok(rows[0].anonimizado_em);
  assert.equal(Number(rows[0].total_centavos), 5000, 'o financeiro fica');
  assert.equal(rows[0].status, 'pago');
  assert.equal(retencao.PRAZOS_PROVISORIOS.participantesDiasAposEdicao, 180);
  assert.equal(retencao.PRAZOS_PROVISORIOS.emailsDiasAposEnvio, 90);
});
