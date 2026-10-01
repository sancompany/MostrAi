require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const { problemaNoEndereco, numeroSuspeito, colunasDoEndereco, LIMITES } = require('../src/lib/endereco');
const regrasDoNavegador = require('../public/endereco-regras');
const { varrerContas } = require('../src/pendencias/endereco');

// Estação de endereços (01/10/2026). O caso real: "Avenida Francisco
// Mastropietro, Av Francisco Mastrop - Barbearia - Vila Cardim" — a rua
// digitada no campo Número e cortada nos 20 caracteres do `maxlength`. Aqui:
// a regra única (limites, Número alfanumérico, Número suspeito), a edição do
// endereço da conta e do ponto (dono e Admin), o histórico do ponto, as
// pendências (ENDERECO_SUSPEITO, ENDERECO_PONTO_ALTERADO) e o isolamento
// entre contas — com as rotas de verdade montadas num app mínimo.

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-enderecos', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    if (req.headers['x-admin'] === '1') {
      req.session.isAdmin = true;
      req.session.adminUsuario = 'admin-teste';
    }
    proximo();
  });
  // Mesma guarda do server.js.
  app.use('/admin', (req, res, proximo) =>
    req.session.isAdmin ? proximo() : res.status(401).json({ erro: 'não autorizado' }),
  );
  app.use(require('../src/pontos/routes'));
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/pendencias/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const chamar = async (metodo, caminho, corpo, { conta, admin } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (conta) headers['x-conta'] = String(conta);
    if (admin) headers['x-admin'] = '1';
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    return { status: r.status, corpo: await r.json().catch(() => null) };
  };
  return { chamar, fechar: () => new Promise((r) => server.close(r)) };
}

const ENDERECO_OK = {
  cep: '15990-000',
  logradouro: 'Avenida Francisco Mastropietro',
  numero: '120',
  complemento: 'Barbearia',
  bairro: 'Vila Cardim',
  cidade: 'Matão',
  uf: 'SP',
};

const criadas = [];
async function criarConta(extra = {}) {
  const campos = {
    nome_empresa: `Endereço Teste ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
    contato_email: `enderecos-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha_hash: 'x',
    papeis: ['anunciante'],
    ...ENDERECO_OK,
    endereco: `${ENDERECO_OK.logradouro}, ${ENDERECO_OK.numero}`,
    ...extra,
  };
  const nomes = Object.keys(campos);
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, ${nomes.join(', ')})
     VALUES (now(), ${nomes.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
    Object.values(campos),
  );
  criadas.push(rows[0].id);
  return rows[0];
}

async function criarPonto(contaId, { status = 'a_instalar' } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, logradouro, numero, bairro, cidade, uf, cep, segmento,
                         responsavel_nome, responsavel_contato, anunciante_id, status)
     VALUES ($1, 'Rua Sete de Setembro, 45', 'Rua Sete de Setembro', '45', 'Centro', 'Matão', 'SP', '15990-000',
             'outro', 'R', '1', $2, $3) RETURNING *`,
    [`Padaria ${randomUUID().slice(0, 8)}`, contaId, status],
  );
  return rows[0];
}

async function pendenciasAtivas(filtro, valor) {
  const { rows } = await pool.query(
    `SELECT * FROM pendencias WHERE ${filtro} = $1 AND resolvido_em IS NULL ORDER BY id`,
    [valor],
  );
  return rows;
}

async function limpar() {
  for (const id of criadas) {
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query(
      'DELETE FROM pontos_enderecos_historico WHERE ponto_id IN (SELECT id FROM pontos WHERE anunciante_id = $1)',
      [id],
    );
    await pool.query('DELETE FROM pontos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM candidaturas WHERE conta_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
}

test.after(async () => {
  await limpar();
  await pool.end();
});

// ---------- Regra única ----------

test('Número alfanumérico: 123, 12A, T7, T10, 45-B, S/N e SN valem e não são suspeitos', () => {
  for (const numero of ['123', '12A', 'T7', 'T10', '45-B', 'S/N', 'SN', 'Km 12']) {
    assert.strictEqual(problemaNoEndereco({ numero }), null, numero);
    assert.strictEqual(numeroSuspeito(numero), false, numero);
  }
});

test('"Av Francisco Mastrop" (o caso real) é aceito, mas lido como suspeito', () => {
  assert.strictEqual(problemaNoEndereco({ numero: 'Av Francisco Mastrop' }), null);
  assert.strictEqual(numeroSuspeito('Av Francisco Mastrop'), true);
  assert.strictEqual(numeroSuspeito('Avenida Francisco Mastropietro'), true);
  assert.strictEqual(numeroSuspeito('Rua XV de Novembro'), true);
  // Na dúvida, não é suspeito.
  assert.strictEqual(numeroSuspeito('Fundos'), false);
  assert.strictEqual(numeroSuspeito('Bloco A Casa 3'), false);
});

test('limites: logradouro até 255, Número até 30, complemento até 255, bairro e cidade até 150, UF 2', () => {
  assert.deepStrictEqual(LIMITES, {
    cep: 9,
    logradouro: 255,
    numero: 30,
    complemento: 255,
    bairro: 150,
    cidade: 150,
    uf: 2,
  });
  assert.strictEqual(problemaNoEndereco({ logradouro: 'Avenida Francisco Mastropietro' }), null);
  assert.strictEqual(problemaNoEndereco({ logradouro: 'A'.repeat(255) }), null);
  assert.strictEqual(problemaNoEndereco({ logradouro: 'A'.repeat(256) })?.campo, 'logradouro');
  assert.strictEqual(problemaNoEndereco({ numero: '1'.repeat(30) }), null);
  assert.strictEqual(problemaNoEndereco({ numero: '1'.repeat(31) })?.campo, 'numero');
  assert.strictEqual(problemaNoEndereco({ complemento: 'c'.repeat(256) })?.campo, 'complemento');
  assert.strictEqual(problemaNoEndereco({ bairro: 'b'.repeat(151) })?.campo, 'bairro');
  assert.strictEqual(problemaNoEndereco({ cidade: 'c'.repeat(151) })?.campo, 'cidade');
  assert.strictEqual(problemaNoEndereco({ uf: 'SPX' })?.campo, 'uf');
  assert.strictEqual(problemaNoEndereco({ cep: '1599-000' })?.campo, 'cep');
});

test('Número recusa o que não é identificador (vírgula, sinal, HTML) e o que não é texto', () => {
  for (const numero of ['12, fundos', '<b>1</b>', "1'; DROP TABLE pontos;--", '#12']) {
    assert.strictEqual(problemaNoEndereco({ numero })?.campo, 'numero', numero);
  }
  assert.strictEqual(problemaNoEndereco({ logradouro: ['Rua'] })?.campo, 'logradouro');
  assert.strictEqual(problemaNoEndereco({ numero: { $ne: 1 } })?.campo, 'numero');
});

test('navegador e servidor leem o MESMO arquivo de regra (um limite só pros dois lados)', () => {
  assert.strictEqual(regrasDoNavegador.LIMITES, LIMITES);
  assert.strictEqual(regrasDoNavegador.numeroSuspeito, numeroSuspeito);
});

test('CEP gravado como 00000-000 quando chega só com dígitos', () => {
  assert.strictEqual(colunasDoEndereco({ cep: '15990000' }).cep, '15990-000');
  assert.strictEqual(colunasDoEndereco({ cep: '15990-000' }).cep, '15990-000');
});

// ---------- Conta ----------

test('conta: Número suspeito grava inteiro, abre UMA pendência e UM aviso; corrigir resolve', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const r = await app.chamar(
      'PATCH',
      '/anunciantes/me',
      { ...ENDERECO_OK, numero: 'Av Francisco Mastrop' },
      { conta: conta.id },
    );
    assert.strictEqual(r.status, 200);
    const { rows } = await pool.query('SELECT logradouro, numero FROM anunciantes WHERE id = $1', [conta.id]);
    assert.deepStrictEqual(rows[0], { logradouro: 'Avenida Francisco Mastropietro', numero: 'Av Francisco Mastrop' });

    // Ler o painel várias vezes não duplica a pendência nem o aviso.
    for (let i = 0; i < 3; i++) {
      const lista = await app.chamar('GET', '/anunciantes/me/pendencias', null, { conta: conta.id });
      assert.strictEqual(lista.corpo.total, 1);
      const [p] = lista.corpo.pendencias;
      assert.strictEqual(p.tipo, 'ENDERECO_SUSPEITO');
      assert.strictEqual(p.severidade, 'atencao');
      assert.strictEqual(p.titulo, 'Confira o endereço da sua empresa');
      assert.match(p.mensagem, /número do imóvel parece estar incorreto/);
      assert.strictEqual(p.cta_rotulo, 'Corrigir endereço');
      assert.strictEqual(p.cta_destino, 'endereco-conta');
    }
    const avisos = await pool.query(
      `SELECT count(*)::int AS n FROM notificacoes WHERE anunciante_id = $1 AND tipo = 'pendencia'`,
      [conta.id],
    );
    assert.strictEqual(avisos.rows[0].n, 1, 'um aviso só no sino');

    // A conta continua livre: nada é bloqueado.
    const { rows: c } = await pool.query('SELECT suspenso FROM anunciantes WHERE id = $1', [conta.id]);
    assert.strictEqual(c[0].suspenso, false);

    await app.chamar('PATCH', '/anunciantes/me', { ...ENDERECO_OK, numero: '120' }, { conta: conta.id });
    assert.strictEqual((await pendenciasAtivas('anunciante_id', conta.id)).length, 0);
    const { rows: hist } = await pool.query(`SELECT resolucao FROM pendencias WHERE anunciante_id = $1`, [conta.id]);
    assert.deepStrictEqual(
      hist.map((h) => h.resolucao),
      ['corrigido'],
      'resolvida fica no banco, nunca apagada',
    );
  } finally {
    await app.fechar();
  }
});

test('conta: quem confirma o Número no aviso não recebe pendência pra esse valor', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const r = await app.chamar(
      'PATCH',
      '/anunciantes/me',
      { ...ENDERECO_OK, numero: 'Casa Verde Grande Fundos', numero_confirmado: true },
      { conta: conta.id },
    );
    assert.strictEqual(r.status, 200);
    const lista = await app.chamar('GET', '/anunciantes/me/pendencias', null, { conta: conta.id });
    assert.strictEqual(lista.corpo.total, 0);
    await varrerContas();
    assert.strictEqual((await pendenciasAtivas('anunciante_id', conta.id)).length, 0, 'a varredura não reabre');
  } finally {
    await app.fechar();
  }
});

test('conta: limite e formato valem no servidor (o mesmo do formulário)', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const longo = await app.chamar(
      'PATCH',
      '/anunciantes/me',
      { ...ENDERECO_OK, numero: '1'.repeat(31) },
      { conta: conta.id },
    );
    assert.strictEqual(longo.status, 400);
    assert.strictEqual(longo.corpo.campo, 'numero');
    const ruaLonga = await app.chamar(
      'PATCH',
      '/anunciantes/me',
      { ...ENDERECO_OK, logradouro: `Avenida ${'Francisco Mastropietro '.repeat(10)}`.trim() },
      { conta: conta.id },
    );
    assert.strictEqual(ruaLonga.status, 200, 'logradouro longo (até 255) entra inteiro');
  } finally {
    await app.fechar();
  }
});

test('cadastro antigo (de antes da regra) ganha a pendência pela varredura, sem entrar no painel', async () => {
  const conta = await criarConta({
    numero: 'Av Francisco Mastrop',
    endereco: 'Avenida Francisco Mastropietro, Av Francisco Mastrop',
  });
  await varrerContas();
  const ativas = await pendenciasAtivas('anunciante_id', conta.id);
  assert.strictEqual(ativas.length, 1);
  assert.strictEqual(ativas[0].chave, `ENDERECO_SUSPEITO:conta:${conta.id}`);
  const { rows } = await pool.query('SELECT numero FROM anunciantes WHERE id = $1', [conta.id]);
  assert.strictEqual(rows[0].numero, 'Av Francisco Mastrop', 'nada é corrigido sozinho');
});

// ---------- Ponto ----------

test('ponto aguardando instalação: dono edita, histórico grava, sem pendência; conta não muda', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const ponto = await criarPonto(conta.id);
    const r = await app.chamar(
      'PATCH',
      `/anunciantes/me/pontos/${ponto.id}/endereco`,
      { ...ENDERECO_OK, logradouro: 'Rua Nova', numero: '12A' },
      { conta: conta.id },
    );
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corpo.mudou, true);
    const { rows } = await pool.query('SELECT logradouro, numero, endereco FROM pontos WHERE id = $1', [ponto.id]);
    assert.deepStrictEqual(rows[0], { logradouro: 'Rua Nova', numero: '12A', endereco: 'Rua Nova, 12A' });
    const hist = await pool.query('SELECT * FROM pontos_enderecos_historico WHERE ponto_id = $1', [ponto.id]);
    assert.strictEqual(hist.rows.length, 1);
    assert.strictEqual(hist.rows[0].origem, 'usuario');
    assert.strictEqual(hist.rows[0].alterado_por_conta, conta.id);
    assert.strictEqual(hist.rows[0].anterior.logradouro, 'Rua Sete de Setembro');
    assert.strictEqual(hist.rows[0].novo.logradouro, 'Rua Nova');
    assert.strictEqual(hist.rows[0].status_do_ponto, 'a_instalar');
    assert.strictEqual((await pendenciasAtivas('ponto_id', ponto.id)).length, 0);
    const { rows: c } = await pool.query('SELECT logradouro, numero FROM anunciantes WHERE id = $1', [conta.id]);
    assert.deepStrictEqual(c[0], { logradouro: ENDERECO_OK.logradouro, numero: '120' }, 'a conta não mudou');

    // Salvar igual não gera histórico novo.
    await app.chamar(
      'PATCH',
      `/anunciantes/me/pontos/${ponto.id}/endereco`,
      { ...ENDERECO_OK, logradouro: 'Rua Nova', numero: '12A' },
      { conta: conta.id },
    );
    const de_novo = await pool.query('SELECT count(*)::int AS n FROM pontos_enderecos_historico WHERE ponto_id = $1', [
      ponto.id,
    ]);
    assert.strictEqual(de_novo.rows[0].n, 1);
  } finally {
    await app.fechar();
  }
});

test('mudar o endereço da CONTA nunca muda o endereço do ponto', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const ponto = await criarPonto(conta.id);
    const r = await app.chamar(
      'PATCH',
      '/anunciantes/me',
      { ...ENDERECO_OK, logradouro: 'Rua da Conta', numero: '9' },
      { conta: conta.id },
    );
    assert.strictEqual(r.status, 200);
    const { rows } = await pool.query('SELECT logradouro, numero FROM pontos WHERE id = $1', [ponto.id]);
    assert.deepStrictEqual(rows[0], { logradouro: 'Rua Sete de Setembro', numero: '45' });
  } finally {
    await app.fechar();
  }
});

test('ponto ATIVO: a troca vale, a tela segue, e abre UMA pendência do admin até conferir', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const ponto = await criarPonto(conta.id, { status: 'em_operacao' });
    for (const numero of ['200', '201']) {
      const r = await app.chamar(
        'PATCH',
        `/anunciantes/me/pontos/${ponto.id}/endereco`,
        { ...ENDERECO_OK, numero },
        { conta: conta.id },
      );
      assert.strictEqual(r.status, 200);
    }
    const { rows } = await pool.query('SELECT status, numero FROM pontos WHERE id = $1', [ponto.id]);
    assert.deepStrictEqual(rows[0], { status: 'em_operacao', numero: '201' }, 'a tela continua; nada é desligado');
    const ativas = await pendenciasAtivas('ponto_id', ponto.id);
    assert.strictEqual(ativas.length, 1, 'duas trocas, uma pendência');
    assert.strictEqual(ativas[0].tipo, 'ENDERECO_PONTO_ALTERADO');
    assert.strictEqual(ativas[0].escopo, 'admin');
    assert.strictEqual(
      ativas[0].mensagem,
      'O endereço deste ponto foi alterado após a instalação e precisa ser conferido.',
    );

    // O cliente não vê pendência do admin.
    const doCliente = await app.chamar('GET', '/anunciantes/me/pendencias', null, { conta: conta.id });
    assert.strictEqual(doCliente.corpo.pendencias.filter((p) => p.tipo === 'ENDERECO_PONTO_ALTERADO').length, 0);

    const doAdmin = await app.chamar('GET', `/admin/pendencias?pontoId=${ponto.id}`, null, { admin: true });
    assert.strictEqual(doAdmin.corpo.length, 1);
    const conferir = await app.chamar('POST', `/admin/pendencias/${ativas[0].id}/conferir`, null, { admin: true });
    assert.strictEqual(conferir.status, 200);
    assert.strictEqual((await pendenciasAtivas('ponto_id', ponto.id)).length, 0);
    const de_novo = await app.chamar('POST', `/admin/pendencias/${ativas[0].id}/conferir`, null, { admin: true });
    assert.strictEqual(de_novo.status, 404);
    const hist = await pool.query('SELECT count(*)::int AS n FROM pontos_enderecos_historico WHERE ponto_id = $1', [
      ponto.id,
    ]);
    assert.strictEqual(hist.rows[0].n, 2, 'as duas trocas no histórico');
  } finally {
    await app.fechar();
  }
});

test('admin edita o endereço do ponto (com histórico) e o da conta; o PATCH genérico do ponto recusa endereço', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const ponto = await criarPonto(conta.id, { status: 'em_operacao' });
    const r = await app.chamar(
      'PATCH',
      `/admin/pontos/${ponto.id}/endereco`,
      { ...ENDERECO_OK, numero: 'S/N' },
      { admin: true },
    );
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.corpo.numero, 'S/N');
    const hist = await app.chamar('GET', `/admin/pontos/${ponto.id}/enderecos`, null, { admin: true });
    assert.strictEqual(hist.corpo.length, 1);
    assert.strictEqual(hist.corpo[0].origem, 'admin');
    assert.strictEqual(hist.corpo[0].alterado_por_admin, 'admin-teste');
    assert.strictEqual((await pendenciasAtivas('ponto_id', ponto.id)).length, 0, 'troca do admin não pede conferência');

    const generico = await app.chamar('PATCH', `/admin/pontos/${ponto.id}`, { numero: '1' }, { admin: true });
    assert.strictEqual(generico.status, 400, 'sem histórico não muda endereço');

    const daConta = await app.chamar(
      'PATCH',
      `/admin/anunciantes/${conta.id}`,
      { ...ENDERECO_OK, numero: 'T10', numero_confirmado: false },
      { admin: true },
    );
    assert.strictEqual(daConta.status, 200);
    const { rows } = await pool.query('SELECT numero FROM anunciantes WHERE id = $1', [conta.id]);
    assert.strictEqual(rows[0].numero, 'T10');
    const { rows: p } = await pool.query('SELECT numero FROM pontos WHERE id = $1', [ponto.id]);
    assert.strictEqual(p[0].numero, 'S/N', 'o ponto não mudou com a conta');
    const incompleto = await app.chamar(
      'PATCH',
      `/admin/anunciantes/${conta.id}`,
      { numero: '', logradouro: 'Rua X' },
      { admin: true },
    );
    assert.strictEqual(incompleto.status, 400);
  } finally {
    await app.fechar();
  }
});

test('histórico é auditável: o ponto com histórico não pode ser apagado por baixo', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const ponto = await criarPonto(conta.id);
    await app.chamar('PATCH', `/admin/pontos/${ponto.id}/endereco`, { ...ENDERECO_OK }, { admin: true });
    await assert.rejects(pool.query('DELETE FROM pontos WHERE id = $1', [ponto.id]), /foreign key|violates/);
  } finally {
    await app.fechar();
  }
});

// ---------- Isolamento e segurança ----------

test('conta A nunca edita o ponto nem o pedido da conta B (resposta igual a inexistente)', async () => {
  const app = await subirApp();
  try {
    const a = await criarConta();
    const b = await criarConta();
    const pontoA = await criarPonto(a.id);
    const r = await app.chamar(
      'PATCH',
      `/anunciantes/me/pontos/${pontoA.id}/endereco`,
      { ...ENDERECO_OK, numero: '999' },
      { conta: b.id },
    );
    assert.strictEqual(r.status, 404);
    const { rows } = await pool.query('SELECT numero FROM pontos WHERE id = $1', [pontoA.id]);
    assert.strictEqual(rows[0].numero, '45');
    const hist = await pool.query('SELECT count(*)::int AS n FROM pontos_enderecos_historico WHERE ponto_id = $1', [
      pontoA.id,
    ]);
    assert.strictEqual(hist.rows[0].n, 0);

    const { rows: cand } = await pool.query(
      `INSERT INTO candidaturas (tipo, nome, contato_telefone, conta_id, logradouro, numero, endereco, bairro, cidade, uf, cep, status)
       VALUES ('ponto', 'A', '1', $1, 'Rua A', '1', 'Rua A, 1', 'Centro', 'Matão', 'SP', '15990-000', 'nova') RETURNING id`,
      [a.id],
    );
    const outro = await app.chamar(
      'PATCH',
      `/anunciantes/me/candidaturas/${cand[0].id}/endereco`,
      { ...ENDERECO_OK },
      { conta: b.id },
    );
    assert.strictEqual(outro.status, 404);
    const dono = await app.chamar(
      'PATCH',
      `/anunciantes/me/candidaturas/${cand[0].id}/endereco`,
      { ...ENDERECO_OK, numero: '7' },
      { conta: a.id },
    );
    assert.strictEqual(dono.status, 200, 'pedido em análise: o dono edita normalmente');
    await pool.query(`UPDATE candidaturas SET status = 'recusada' WHERE id = $1`, [cand[0].id]);
    const decidido = await app.chamar(
      'PATCH',
      `/anunciantes/me/candidaturas/${cand[0].id}/endereco`,
      { ...ENDERECO_OK },
      { conta: a.id },
    );
    assert.strictEqual(decidido.status, 404, 'pedido já decidido não muda mais');

    // B não vê a pendência de A.
    await app.chamar('PATCH', '/anunciantes/me', { ...ENDERECO_OK, numero: 'Av Francisco Mastrop' }, { conta: a.id });
    const deB = await app.chamar('GET', '/anunciantes/me/pendencias', null, { conta: b.id });
    assert.strictEqual(deB.corpo.total, 0);
  } finally {
    await app.fechar();
  }
});

test('segurança: id forjado, dono no corpo, coordenada no corpo e rota de admin sem admin', async () => {
  const app = await subirApp();
  try {
    const a = await criarConta();
    const b = await criarConta();
    const ponto = await criarPonto(a.id);
    const forjado = await app.chamar('PATCH', `/anunciantes/me/pontos/${ponto.id}%20OR%201=1/endereco`, ENDERECO_OK, {
      conta: a.id,
    });
    assert.strictEqual(forjado.status, 404);
    const r = await app.chamar(
      'PATCH',
      `/anunciantes/me/pontos/${ponto.id}/endereco`,
      {
        ...ENDERECO_OK,
        anunciante_id: b.id,
        status: 'arquivado',
        latitude: -21.6,
        longitude: -48.3,
        endereco: 'forjado',
      },
      { conta: a.id },
    );
    assert.strictEqual(r.status, 200);
    const { rows } = await pool.query('SELECT anunciante_id, status, endereco FROM pontos WHERE id = $1', [ponto.id]);
    assert.deepStrictEqual(rows[0], {
      anunciante_id: a.id,
      status: 'a_instalar',
      endereco: `${ENDERECO_OK.logradouro}, ${ENDERECO_OK.numero}`,
    });
    const colunas = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'pontos' AND column_name ~ '^(lat|lon|lng)'`,
    );
    assert.strictEqual(colunas.rows.length, 0, 'nenhuma coordenada vinda do navegador é gravada');

    // Texto com HTML/SQL no logradouro é guardado como texto (parametrizado);
    // quem mostra escapa.
    const texto = `<script>alert(1)</script>'; DROP TABLE pontos;--`;
    const x = await app.chamar(
      'PATCH',
      `/anunciantes/me/pontos/${ponto.id}/endereco`,
      { ...ENDERECO_OK, logradouro: texto },
      { conta: a.id },
    );
    assert.strictEqual(x.status, 200);
    const { rows: g } = await pool.query('SELECT logradouro FROM pontos WHERE id = $1', [ponto.id]);
    assert.strictEqual(g[0].logradouro, texto);

    const semAdmin = await app.chamar('PATCH', `/admin/pontos/${ponto.id}/endereco`, ENDERECO_OK, { conta: a.id });
    assert.strictEqual(semAdmin.status, 401);
    const semLogin = await app.chamar('PATCH', `/anunciantes/me/pontos/${ponto.id}/endereco`, ENDERECO_OK);
    assert.strictEqual(semLogin.status, 401);
  } finally {
    await app.fechar();
  }
});

test('pedido confirmado vira ponto: o "está certo" do pedido vale pro mesmo Número no ponto', async () => {
  const app = await subirApp();
  try {
    const conta = await criarConta();
    const { rows: cand } = await pool.query(
      `INSERT INTO candidaturas (tipo, nome, contato_telefone, conta_id, logradouro, numero, endereco, bairro, cidade, uf, cep, status)
       VALUES ('ponto', 'A', '1', $1, 'Rua A', '1', 'Rua A, 1', 'Centro', 'Matão', 'SP', '15990-000', 'nova') RETURNING id`,
      [conta.id],
    );
    const numero = 'Galeria Central Loja Sete';
    const r = await app.chamar(
      'PATCH',
      `/anunciantes/me/candidaturas/${cand[0].id}/endereco`,
      { ...ENDERECO_OK, numero, numero_confirmado: true },
      { conta: conta.id },
    );
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await pendenciasAtivas('anunciante_id', conta.id)).length, 0);
    // O pedido vira ponto com o mesmo endereço (o que a aprovação faz).
    await pool.query(
      `INSERT INTO pontos (nome, endereco, logradouro, numero, bairro, cidade, uf, cep, segmento,
                           responsavel_nome, responsavel_contato, anunciante_id, candidatura_id)
       VALUES ('P', $1, 'Avenida Francisco Mastropietro', $2, 'Vila Cardim', 'Matão', 'SP', '15990-000', 'outro', 'R', '1', $3, $4)`,
      [`Avenida Francisco Mastropietro, ${numero}`, numero, conta.id, cand[0].id],
    );
    await pool.query(`UPDATE candidaturas SET status = 'aprovada' WHERE id = $1`, [cand[0].id]);
    await varrerContas();
    assert.strictEqual((await pendenciasAtivas('anunciante_id', conta.id)).length, 0, 'não reabre no ponto');
  } finally {
    await app.fechar();
  }
});
