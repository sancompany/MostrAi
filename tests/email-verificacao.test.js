require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');

// Verificação e troca do e-mail de login (estação de e-mail, 27/09/2026),
// pelas rotas REAIS e com SMTP FALSO. O que este arquivo prova:
//   · cadastro manda UM e-mail só (o código); boas-vindas só depois de
//     confirmar, uma vez;
//   · o prazo (10 min) vem do servidor e recarregar não reinicia;
//   · reenviar tem intervalo e teto por hora, gera código novo e mata o antigo;
//   · código errado 5 vezes morre; código vencido não confirma;
//   · o código nunca é gravado em claro, logado nem devolvido;
//   · corrigir o e-mail antes de confirmar (com a senha) manda código pro
//     endereço novo e invalida o antigo;
//   · trocar depois de confirmado: o login só muda com o código, e o endereço
//     antigo é avisado;
//   · o admin troca com trilha, pede confirmação do novo e avisa o antigo;
//   · redefinição de senha: link pela fila, e-mail da conta pro gerenciador
//     de senhas, aviso de senha alterada;
//   · e-mail que falha nunca derruba cadastro nem concessão de crédito.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'segredo-de-teste-da-verificacao';
const email = require('../src/financeiro/email');
const outbox = require('../src/email/outbox');
const codigos = require('../src/email/codigos');
const { gerarHash } = require('../src/lib/senha');

const rodada = randomUUID().slice(0, 8);
const endereco = (n) => `verif-${rodada}-${n}@example.com`;

const enviados = [];
email.usarTransporte({
  sendMail: async (m) => {
    enviados.push(m);
    return { messageId: 'falso' };
  },
});
const doCodigo = (texto) => (String(texto).match(/^\d{6}$/m) || [])[0];
async function processar() {
  while ((await outbox.processarPendentes({ limite: 500, escopo: `verif-${rodada}-` })) > 0);
  await outbox.aguardarRodadas();
}
function ultimoCodigoPara(destino) {
  const m = enviados.filter((e) => e.to === destino && doCodigo(e.text));
  return m.length ? doCodigo(m.at(-1).text) : null;
}
async function naFila(contaId, tipo) {
  const { rows } = await pool.query(
    'SELECT chave, destinatario, status FROM email_outbox WHERE anunciante_id = $1 AND tipo = $2 ORDER BY id',
    [contaId, tipo],
  );
  return rows;
}

let base;
let servidor;
test.before(async () => {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-verif', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    if (req.headers['x-admin']) req.session.adminUsuario = 'admin-teste';
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/conta/routes'));
  app.use(require('../src/creditos/routes'));
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  await pool.query("DELETE FROM tentativas_acesso WHERE chave LIKE '%127.0.0.1%' OR chave LIKE '%::1%'");
});

const criadas = [];
test.after(async () => {
  for (const id of criadas) {
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM notificacoes WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM creditos_ledger WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM tokens_senha WHERE usuario_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.query('DELETE FROM email_outbox WHERE destinatario LIKE $1', [`verif-${rodada}-%`]);
  email.usarTransporte(null);
  await new Promise((r) => servidor.close(r));
});

async function chamar(metodo, caminho, { conta, corpo, admin } = {}) {
  // Cada chamada com IP "novo" pro limite por IP não interferir entre testes.
  await pool.query('DELETE FROM tentativas_acesso');
  const r = await fetch(`${base}${caminho}`, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(conta ? { 'x-conta': String(conta) } : {}),
      ...(admin ? { 'x-admin': '1' } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  return { status: r.status, corpo: await r.json().catch(() => null) };
}

const SENHA = 'Senha12@certa';
async function contaPronta(n, extra = {}) {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em,
                              papeis, email_confirmado, endereco, cidade, uf, cep)
     VALUES ($1, '11144477735', $2, '16999990000', $3, now(), '{anunciante}', $4, 'Rua X, 1', 'Matão', 'SP', '15990000')
     RETURNING *`,
    [`Conta ${n}`, endereco(n), await gerarHash(SENHA), extra.email_confirmado ?? false],
  );
  criadas.push(rows[0].id);
  return rows[0];
}

test('1. cadastro: UM e-mail (o código); boas-vindas só depois de confirmar, uma vez', async () => {
  const r = await chamar('POST', '/anunciantes/cadastro', {
    corpo: {
      nome_empresa: 'Padaria Cadastro',
      cpf_cnpj: '390.533.447-05',
      contato_email: endereco('cad'),
      contato_telefone: '16 99463-5946',
      senha: SENHA,
      aceitou_termos: true,
      cep: '15990-000',
      logradouro: 'Rua A',
      numero: '1',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
    },
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.corpo));
  const id = r.corpo.id;
  criadas.push(id);

  const { rows: todas } = await pool.query('SELECT tipo FROM email_outbox WHERE anunciante_id = $1', [id]);
  assert.deepStrictEqual(
    todas.map((t) => t.tipo),
    ['codigo_confirmacao'],
    'no cadastro sai só o código',
  );
  const { rows: guardado } = await pool.query('SELECT * FROM codigos_email WHERE anunciante_id = $1', [id]);
  assert.strictEqual(guardado.length, 1);
  assert.match(guardado[0].codigo_hash, /^[0-9a-f]{64}$/, 'só o hash no banco');

  await processar();
  const codigo = ultimoCodigoPara(endereco('cad'));
  assert.ok(codigo, 'o primeiro código chega sem precisar reenviar');
  assert.notStrictEqual(guardado[0].codigo_hash, codigo);

  assert.strictEqual(
    (await chamar('POST', '/anunciantes/me/confirmar-email', { conta: id, corpo: { codigo } })).status,
    200,
  );
  const { rows: conta } = await pool.query('SELECT email_confirmado FROM anunciantes WHERE id = $1', [id]);
  assert.strictEqual(conta[0].email_confirmado, true);
  assert.strictEqual((await naFila(id, 'boas_vindas')).length, 1, 'boas-vindas depois da confirmação');
  // Confirmar de novo não manda outra.
  await chamar('POST', '/anunciantes/me/confirmar-email', { conta: id, corpo: { codigo } });
  assert.strictEqual((await naFila(id, 'boas_vindas')).length, 1);
});

test('2. prazo de 10 min vem do servidor; recarregar não reinicia', async () => {
  const c = await contaPronta('prazo');
  await codigos.emitir(c, { respeitarIntervalo: false });
  const a = await chamar('GET', '/anunciantes/me/verificacao-email', { conta: c.id });
  assert.strictEqual(a.status, 200);
  assert.strictEqual(a.corpo.validadeMinutos, 10);
  const minutos = (new Date(a.corpo.cadastro.expiraEm) - Date.now()) / 60000;
  assert.ok(minutos > 9.8 && minutos <= 10, `vale ~10 min (${minutos})`);
  assert.ok(!JSON.stringify(a.corpo).match(/"codigo/), 'o código nunca vem na resposta');
  await new Promise((r) => setTimeout(r, 1100));
  const b = await chamar('GET', '/anunciantes/me/verificacao-email', { conta: c.id });
  assert.strictEqual(b.corpo.cadastro.expiraEm, a.corpo.cadastro.expiraEm, 'mesmo prazo depois de "recarregar"');
});

test('3. reenviar: intervalo de 60 s; código novo mata o antigo', async () => {
  const c = await contaPronta('reenvio');
  await codigos.emitir(c, { respeitarIntervalo: false });
  await processar();
  const antigo = ultimoCodigoPara(c.contato_email);

  const cedo = await chamar('POST', '/anunciantes/me/reenviar-codigo-email', { conta: c.id });
  assert.strictEqual(cedo.status, 429);
  assert.ok(cedo.corpo.podeReenviarEm, 'diz quando pode pedir de novo');

  await pool.query("UPDATE codigos_email SET criado_em = now() - interval '61 seconds' WHERE anunciante_id = $1", [
    c.id,
  ]);
  const ok = await chamar('POST', '/anunciantes/me/reenviar-codigo-email', { conta: c.id });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.corpo.expiraEm && ok.corpo.podeReenviarEm);
  await processar();
  const novo = ultimoCodigoPara(c.contato_email);
  assert.ok(novo);

  if (novo !== antigo) {
    const velho = await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: antigo } });
    assert.strictEqual(velho.status, 400, 'código anterior não vale mais');
  }
  assert.strictEqual(
    (await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: novo } })).status,
    200,
  );
});

test('4. teto de 5 códigos por hora', async () => {
  const c = await contaPronta('teto');
  for (let i = 0; i < codigos.MAX_POR_HORA; i++) {
    await codigos.emitir(c, { respeitarIntervalo: false });
  }
  await assert.rejects(codigos.emitir(c, { respeitarIntervalo: false }), (e) => e.status === 429);
});

test('5. código errado 5 vezes morre; código vencido não confirma', async () => {
  const c = await contaPronta('erros');
  await codigos.emitir(c, { respeitarIntervalo: false });
  await processar();
  const certo = ultimoCodigoPara(c.contato_email);
  const errado = certo === '000000' ? '111111' : '000000';
  for (let i = 1; i < codigos.MAX_ERROS; i++) {
    const r = await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: errado } });
    assert.strictEqual(r.corpo.motivo, 'errado');
  }
  const ultimo = await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: errado } });
  assert.strictEqual(ultimo.corpo.motivo, 'esgotado');
  const depois = await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: certo } });
  assert.strictEqual(depois.status, 400, 'nem o certo vale depois de esgotar');

  await pool.query("UPDATE email_outbox SET criado_em = now() - interval '2 hours' WHERE anunciante_id = $1", [c.id]);
  await codigos.emitir(c, { respeitarIntervalo: false });
  await processar();
  const novo = ultimoCodigoPara(c.contato_email);
  await pool.query("UPDATE codigos_email SET expira_em = now() - interval '1 second' WHERE anunciante_id = $1", [c.id]);
  const vencido = await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: novo } });
  assert.strictEqual(vencido.corpo.motivo, 'expirado');
});

test('6. o código nunca vai pra log', async () => {
  const c = await contaPronta('log');
  const linhas = [];
  const originais = { log: console.log, error: console.error, warn: console.warn };
  for (const k of Object.keys(originais)) console[k] = (...a) => linhas.push(a.join(' '));
  try {
    await codigos.emitir(c, { respeitarIntervalo: false });
    await processar();
    const codigo = ultimoCodigoPara(c.contato_email);
    await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: '999999' } });
    await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo } });
    assert.ok(linhas.length > 0, 'houve log (o envio é registrado)');
    assert.ok(!linhas.some((l) => l.includes(codigo)), 'nenhuma linha de log traz o código');
    assert.ok(!linhas.some((l) => l.includes(c.contato_email)), 'nem o endereço completo');
  } finally {
    Object.assign(console, originais);
  }
});

test('7. corrigir e-mail ANTES de confirmar: com senha; código novo pro endereço certo; antigo invalidado', async () => {
  const c = await contaPronta('errado');
  await codigos.emitir(c, { respeitarIntervalo: false });
  await processar();
  const doErrado = ultimoCodigoPara(c.contato_email);

  const semSenha = await chamar('POST', '/anunciantes/me/corrigir-email', {
    conta: c.id,
    corpo: { email: endereco('certo'), senha: 'outra' },
  });
  assert.strictEqual(semSenha.status, 401);

  const ok = await chamar('POST', '/anunciantes/me/corrigir-email', {
    conta: c.id,
    corpo: { email: endereco('certo'), senha: SENHA },
  });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.corpo));
  assert.strictEqual(ok.corpo.email, endereco('certo'));
  assert.ok(ok.corpo.expiraEm);

  const velho = await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: doErrado } });
  assert.strictEqual(velho.status, 400, 'código do endereço errado não vale mais');
  await processar();
  const doCerto = ultimoCodigoPara(endereco('certo'));
  assert.ok(doCerto, 'código chega no endereço corrigido');
  assert.strictEqual(
    (await chamar('POST', '/anunciantes/me/confirmar-email', { conta: c.id, corpo: { codigo: doCerto } })).status,
    200,
  );

  const { rows } = await pool.query(
    'SELECT origem, email_anterior, email_novo FROM alteracoes_email WHERE anunciante_id = $1',
    [c.id],
  );
  assert.deepStrictEqual(rows, [
    { origem: 'correcao_antes_de_confirmar', email_anterior: endereco('errado'), email_novo: endereco('certo') },
  ]);
  const confirmada = await chamar('POST', '/anunciantes/me/corrigir-email', {
    conta: c.id,
    corpo: { email: endereco('outro'), senha: SENHA },
  });
  assert.strictEqual(confirmada.status, 409, 'depois de confirmado, correção direta não vale');
});

test('8. corrigir para e-mail de outra conta é recusado', async () => {
  const dono = await contaPronta('ocupado', { email_confirmado: true });
  const c = await contaPronta('quer-ocupado');
  const r = await chamar('POST', '/anunciantes/me/corrigir-email', {
    conta: c.id,
    corpo: { email: dono.contato_email.toUpperCase(), senha: SENHA },
  });
  assert.strictEqual(r.status, 409);
});

test('9. trocar e-mail DEPOIS de confirmado: login só muda com o código; o antigo é avisado', async () => {
  const c = await contaPronta('troca-antigo', { email_confirmado: true });
  const semSenha = await chamar('POST', '/anunciantes/me/trocar-email', {
    conta: c.id,
    corpo: { email: endereco('troca-novo'), senha: 'errada' },
  });
  assert.strictEqual(semSenha.status, 401, 'reautenticação obrigatória');

  const pedido = await chamar('POST', '/anunciantes/me/trocar-email', {
    conta: c.id,
    corpo: { email: endereco('troca-novo'), senha: SENHA },
  });
  assert.strictEqual(pedido.status, 200, JSON.stringify(pedido.corpo));
  assert.strictEqual(pedido.corpo.emailPendente, endereco('troca-novo'));
  let { rows } = await pool.query('SELECT contato_email FROM anunciantes WHERE id = $1', [c.id]);
  assert.strictEqual(rows[0].contato_email, endereco('troca-antigo'), 'login continua o antigo até o código');

  const estado = await chamar('GET', '/anunciantes/me/verificacao-email', { conta: c.id });
  assert.strictEqual(estado.corpo.troca.email, endereco('troca-novo'));

  await processar();
  const codigo = ultimoCodigoPara(endereco('troca-novo'));
  assert.ok(codigo, 'código vai pro endereço NOVO');
  assert.ok(!ultimoCodigoPara(endereco('troca-antigo')), 'nenhum código pro antigo');

  const ok = await chamar('POST', '/anunciantes/me/confirmar-troca-email', { conta: c.id, corpo: { codigo } });
  assert.strictEqual(ok.status, 200);
  ({ rows } = await pool.query('SELECT contato_email, email_confirmado FROM anunciantes WHERE id = $1', [c.id]));
  assert.deepStrictEqual(rows[0], { contato_email: endereco('troca-novo'), email_confirmado: true });

  const aviso = await naFila(c.id, 'email_alterado');
  assert.strictEqual(aviso.length, 1);
  assert.strictEqual(aviso[0].destinatario, endereco('troca-antigo'), 'o aviso vai pro endereço ANTIGO');
  await processar();
  const m = enviados.find((e) => e.to === endereco('troca-antigo') && e.subject.includes('alterado'));
  assert.ok(m && !m.text.includes(endereco('troca-novo')), 'o antigo vê o novo só mascarado');

  const trilha = await pool.query(
    "SELECT 1 FROM alteracoes_email WHERE anunciante_id = $1 AND origem = 'troca_confirmada'",
    [c.id],
  );
  assert.strictEqual(trilha.rows.length, 1);
});

test('10. admin troca o e-mail: trilha, novo precisa confirmar, antigo avisado', async () => {
  const c = await contaPronta('admin-antigo', { email_confirmado: true });
  const r = await chamar('PATCH', `/admin/anunciantes/${c.id}`, {
    admin: true,
    corpo: { contato_email: endereco('admin-novo') },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.corpo));
  assert.strictEqual(r.corpo.contato_email, endereco('admin-novo'));
  assert.strictEqual(r.corpo.email_confirmado, false, 'endereço novo precisa ser confirmado');
  const { rows } = await pool.query('SELECT origem, admin_usuario FROM alteracoes_email WHERE anunciante_id = $1', [
    c.id,
  ]);
  assert.deepStrictEqual(rows, [{ origem: 'admin', admin_usuario: 'admin-teste' }]);
  assert.strictEqual((await naFila(c.id, 'email_alterado'))[0].destinatario, endereco('admin-antigo'));
  assert.strictEqual((await naFila(c.id, 'codigo_confirmacao'))[0].destinatario, endereco('admin-novo'));

  // Salvar outro campo sem mexer no e-mail não gera trilha nem aviso.
  await chamar('PATCH', `/admin/anunciantes/${c.id}`, { admin: true, corpo: { nome_empresa: 'Outro nome' } });
  assert.strictEqual((await naFila(c.id, 'email_alterado')).length, 1);
});

test('11. redefinir senha: link pela fila, e-mail da conta pro gerenciador de senhas, aviso de senha alterada', async () => {
  const c = await contaPronta('senha', { email_confirmado: true });
  assert.strictEqual(
    (await chamar('POST', '/anunciantes/esqueci-senha', { corpo: { email: c.contato_email } })).status,
    200,
  );
  await new Promise((r) => setTimeout(r, 200));
  const [pedido] = await naFila(c.id, 'redefinir_senha');
  assert.ok(pedido, 'link na fila');
  const { rows } = await pool.query('SELECT segredo, dados FROM email_outbox WHERE chave = $1', [pedido.chave]);
  const { rows: tokens } = await pool.query('SELECT token FROM tokens_senha WHERE usuario_id = $1', [c.id]);
  assert.ok(!rows[0].segredo.includes(tokens[0].token), 'token cifrado na fila');
  assert.ok(!JSON.stringify(rows[0].dados).includes(tokens[0].token));

  const conta = await chamar('GET', `/redefinir-senha/conta?token=${tokens[0].token}`);
  assert.strictEqual(conta.corpo.email, c.contato_email);
  assert.strictEqual((await chamar('GET', '/redefinir-senha/conta?token=nao-existe')).status, 400);

  const troca = await chamar('POST', '/redefinir-senha', { corpo: { token: tokens[0].token, senha: 'Nova12@senha' } });
  assert.strictEqual(troca.status, 200);
  assert.strictEqual((await naFila(c.id, 'senha_alterada')).length, 1, 'aviso de senha alterada');
  const reuso = await chamar('POST', '/redefinir-senha', { corpo: { token: tokens[0].token, senha: 'Outra12@senha' } });
  assert.strictEqual(reuso.status, 400, 'link não vale duas vezes');
});

test('12. e-mail que falha não derruba o cadastro', async () => {
  const original = outbox.enfileirar;
  outbox.enfileirar = async () => {
    throw new Error('banco da fila fora');
  };
  try {
    const r = await chamar('POST', '/anunciantes/cadastro', {
      corpo: {
        nome_empresa: 'Sem Fila',
        cpf_cnpj: '390.533.447-05',
        contato_email: endereco('sem-fila'),
        contato_telefone: '16 99463-5946',
        senha: SENHA,
        aceitou_termos: true,
        cep: '15990-000',
        logradouro: 'Rua A',
        numero: '1',
        bairro: 'Centro',
        cidade: 'Matão',
        uf: 'SP',
      },
    });
    assert.strictEqual(r.status, 201, 'a conta nasce mesmo com a fila fora');
    criadas.push(r.corpo.id);
  } finally {
    outbox.enfileirar = original;
  }
});

test('13. notificação que falha não vira 500 de crédito já concedido', async () => {
  const c = await contaPronta('credito', { email_confirmado: true });
  const notificacoes = require('../src/creditos/notificacoes');
  const original = notificacoes.registrar;
  notificacoes.registrar = async () => {
    throw new Error('notificações fora');
  };
  try {
    const r = await chamar('POST', `/admin/anunciantes/${c.id}/creditos/conceder`, {
      admin: true,
      corpo: { quantidade: 2, motivo: 'teste da estação de e-mail' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.corpo));
  } finally {
    notificacoes.registrar = original;
  }
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(quantidade),0)::int AS s FROM creditos_ledger WHERE anunciante_id = $1',
    [c.id],
  );
  assert.strictEqual(rows[0].s, 2, 'o crédito ficou');
});
