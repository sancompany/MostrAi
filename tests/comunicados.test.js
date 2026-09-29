const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// Comunicados por e-mail (Admin → Visão geral, migration 108). Roda o `app`
// REAL (src/server.js) com SMTP FALSO — nenhum e-mail sai de verdade. O que
// este arquivo prova (a lista A–N é a do pedido da estação, 29/09/2026):
//   A–D · a contagem de cada público é o tamanho da MESMA lista do envio;
//   E   · endereço repetido sai uma vez só;
//   F   · excluída, anonimizada, suspensa, não confirmada, quem revogou e
//         e-mail inválido ficam de fora (e a conta da Mostraí também);
//   G   · o teste vai só pra caixa da equipe, marcado, e não entra no histórico;
//   H   · o envio real sai um por destinatário, só o endereço dele no "Para";
//   I   · duplo clique, nova tentativa e página recarregada não mandam 2×;
//   J   · falha parcial aparece como tal, e "Reenviar falhas" pega só quem falhou;
//   K   · sem sessão de admin nada funciona — nem com a conta de cliente logada;
//   L   · o histórico traz as contagens e nenhum endereço;
//   M   · o que o admin escreve é texto: sem HTML, sem script, sem link perigoso;
//   N   · público sem destinatário bloqueia o envio real.
// E ainda: o ritmo espalha o envio, comunicado não atrasa código de
// verificação, conta que sai do público antes da vez dela não recebe, e
// nenhuma resposta carrega a senha do SMTP.
process.env.SITE_URL = 'https://mostrai.test';
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-comunicados';
const SENHA_SMTP = `senha-smtp-${randomUUID()}`;
process.env.SMTP_PASS = SENHA_SMTP;

const rodada = randomUUID().slice(0, 8);
const PREFIXO = `com-${rodada}-`;
const EQUIPE = `${PREFIXO}equipe@mostrai.test`;
process.env.MOSTRAI_EMAIL_CONTATO = EQUIPE;

const app = require('../src/server');
const email = require('../src/financeiro/email');
const outbox = require('../src/email/outbox');
const publicos = require('../src/comunicados/publicos');
const conteudo = require('../src/comunicados/conteudo');
const repo = require('../src/comunicados/repository');

// Os arquivos de teste rodam em paralelo contra o mesmo banco: o público
// deste arquivo são só as contas que ele criou, e ele só processa a fila
// delas (mesmo desenho do escopo da outbox).
publicos.config.escopo = PREFIXO;
repo.config.intervaloS = 0;

// SMTP falso: guarda o que "saiu"; `falharPara` simula recusa do servidor.
const saidas = [];
const falharPara = new Set();
const enderecoDe = (to) => (typeof to === 'string' ? to : to?.address);
email.usarTransporte({
  sendMail: async (m) => {
    if (falharPara.has(enderecoDe(m.to))) throw new Error(`550 mailbox unavailable for ${enderecoDe(m.to)}`);
    saidas.push(m);
    return { messageId: 'falso' };
  },
});
const recebidos = (endereco, assunto) =>
  saidas.filter((m) => enderecoDe(m.to) === endereco && (!assunto || m.subject === assunto));

async function processarTudo() {
  while ((await outbox.processarPendentes({ limite: 500, escopo: PREFIXO })) > 0);
  await outbox.aguardarRodadas();
}

const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
let base;
let servidor;
let admin;
const criados = { contas: [], pontos: [], comunicados: [] };

// Pote de cookies com o `Path` respeitado (o do admin só vai pro /admin).
// Toda resposta passa pela conferência de segredo: a senha do SMTP não
// aparece em corpo nenhum, de rota nenhuma.
function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo, cabecalhos = {}) {
    const cookie = [...potes.entries()]
      .filter(([, c]) => caminho.startsWith(c.path))
      .map(([nome, c]) => `${nome}=${c.valor}`)
      .join('; ');
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': IP,
        ...(cookie ? { cookie } : {}),
        ...cabecalhos,
      },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const path = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor: resto.join('='), path });
    }
    const texto = await r.text();
    assert.ok(!texto.includes(SENHA_SMTP), `a senha do SMTP vazou em ${metodo} ${caminho}`);
    let json = null;
    try {
      json = JSON.parse(texto);
    } catch {}
    if (json?.comunicado?.id) criados.comunicados.push(json.comunicado.id);
    return { status: r.status, texto, json };
  };
}

// Um hash só pro arquivo (bcrypt é lento de propósito; 13 contas = 5 s).
let hashDaSenha;
async function conta(nome, o = {}) {
  hashDaSenha ||= await gerarHash('Senha12@teste');
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, plano_id, data_expiracao, suspenso, excluido_em,
                              anonimizada_em, comunicacoes_revogado_em)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], $5, $6,
             CASE WHEN $7::int IS NULL THEN NULL ELSE current_date + $7::int END,
             $8, CASE WHEN $9 THEN now() END, CASE WHEN $10 THEN now() END, CASE WHEN $11 THEN now() END)
     RETURNING id, contato_email`,
    [
      `Comunicado ${nome} ${rodada}`,
      randomUUID().replace(/\D/g, '').padEnd(14, '7').slice(0, 14),
      o.email || `${PREFIXO}${nome}@example.com`,
      hashDaSenha,
      o.confirmado !== false,
      o.plano ? 'destaque-1m' : null,
      o.expiraEmDias ?? null,
      !!o.suspenso,
      !!o.excluida,
      !!o.anonimizada,
      !!o.revogou,
    ],
  );
  criados.contas.push(rows[0].id);
  return { id: rows[0].id, email: rows[0].contato_email, senha: 'Senha12@teste' };
}

async function ponto(contaId, { arquivado = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
                         anunciante_id, escolha_bloqueada_em, status, arquivado_em, motivo_arquivamento)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2, now(),
             $3, CASE WHEN $4 THEN now() END, CASE WHEN $4 THEN 'teste de comunicados' END)
     RETURNING id`,
    [`Ponto ${rodada} ${randomUUID().slice(0, 6)}`, contaId, arquivado ? 'arquivado' : 'a_instalar', arquivado],
  );
  criados.pontos.push(rows[0].id);
  return rows[0].id;
}

const C = {};
test.before(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  admin = navegador();
  const r = await admin('POST', '/admin/login', { usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD });
  assert.strictEqual(r.status, 200, 'login do admin');

  C.plano = await conta('plano', { plano: true, expiraEmDias: 30 });
  C.semPlano = await conta('semplano');
  C.vencido = await conta('vencido', { plano: true, expiraEmDias: -10 });
  C.dono = await conta('dono');
  C.dono2 = await conta('dono2', { plano: true, expiraEmDias: 30 });
  C.arquivado = await conta('soarquivado');
  C.suspensa = await conta('suspensa', { plano: true, expiraEmDias: 30, suspenso: true });
  C.excluida = await conta('excluida', { excluida: true });
  C.anonimizada = await conta('anon', {
    email: `${PREFIXO}anon@anonimo.mostrai.invalid`,
    excluida: true,
    anonimizada: true,
    revogou: true,
  });
  C.naoConfirmada = await conta('naoconfirmada', { confirmado: false });
  C.revogou = await conta('revogou', { revogou: true });
  C.invalida = await conta('invalida', { email: `${PREFIXO}invalida@semdominio` });
  C.lista = await conta('lista', { email: `${PREFIXO}lista@example.com,outra` });

  await ponto(C.dono.id);
  await ponto(C.dono2.id);
  await ponto(C.dono2.id);
  await ponto(C.arquivado.id, { arquivado: true });
});

test.after(async () => {
  const ids = [...new Set(criados.comunicados)];
  const { rows } = await pool.query(
    `SELECT DISTINCT comunicado_id AS id FROM comunicados_destinatarios WHERE anunciante_id = ANY($1)`,
    [criados.contas],
  );
  const todos = [...new Set([...ids, ...rows.map((r) => Number(r.id))])];
  await pool.query('DELETE FROM email_outbox WHERE destinatario LIKE $1 OR anunciante_id = ANY($2)', [
    `${PREFIXO}%`,
    criados.contas,
  ]);
  await pool.query('DELETE FROM comunicados WHERE id = ANY($1)', [todos]);
  for (const t of ['eventos', 'notificacoes', 'cupons_ponto']) {
    const coluna = t === 'cupons_ponto' ? 'conta_id' : 'anunciante_id';
    await pool.query(`DELETE FROM ${t} WHERE ${coluna} = ANY($1)`, [criados.contas]).catch(() => {});
  }
  await pool.query('DELETE FROM pontos WHERE id = ANY($1)', [criados.pontos]);
  await pool.query('DELETE FROM anunciantes WHERE id = ANY($1)', [criados.contas]);
  email.usarTransporte(null);
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

const ids = (lista) => lista.map((d) => d.anuncianteId).sort((a, b) => a - b);
const deContas = (...cs) => cs.map((c) => c.id).sort((a, b) => a - b);
const texto = (n) => ({
  assunto: `Aviso ${n} ${rodada}`,
  titulo: `Título ${n}`,
  mensagem: `Olá!\n\nMensagem ${n} da Mostraí.`,
});
const chave = () => randomUUID();

async function enviar(corpo, { chaveEnvio = chave() } = {}) {
  return admin('POST', '/admin/comunicados', corpo, { 'Idempotency-Key': chaveEnvio });
}
async function contagem(publico) {
  const r = await admin('GET', `/admin/comunicados/destinatarios?publico=${publico}`);
  assert.strictEqual(r.status, 200, r.texto);
  return { ...r.json, texto: r.texto };
}

// ---------------------------------------------------------------------------

test('A–D. cada público conta exatamente a lista do envio — e a resposta não traz endereço', async () => {
  const esperado = {
    todas: deContas(C.plano, C.semPlano, C.vencido, C.dono, C.dono2, C.arquivado),
    com_plano: deContas(C.plano, C.dono2),
    sem_plano: deContas(C.semPlano, C.vencido, C.dono, C.arquivado),
    donos_de_ponto: deContas(C.dono, C.dono2),
  };
  for (const [publico, contas] of Object.entries(esperado)) {
    const lista = await publicos.listarDestinatarios(publico);
    assert.deepStrictEqual(ids(lista), contas, `quem entra em "${publico}"`);
    const r = await contagem(publico);
    assert.strictEqual(r.destinatarios, contas.length, `contagem de "${publico}" = tamanho da lista do envio`);
    assert.ok(!r.texto.includes('@'), `a contagem de "${publico}" não traz endereço nenhum`);
  }
  // Ponto arquivado não faz de ninguém dono de ponto; plano vencido é "sem plano".
  const donos = ids(await publicos.listarDestinatarios('donos_de_ponto'));
  assert.ok(!donos.includes(C.arquivado.id));
  assert.ok(ids(await publicos.listarDestinatarios('sem_plano')).includes(C.vencido.id));

  assert.strictEqual((await admin('GET', '/admin/comunicados/destinatarios?publico=qualquer')).status, 400);
});

test('F. excluída, anonimizada, suspensa, não confirmada, quem revogou e e-mail inválido ficam de fora', async () => {
  const fora = [C.suspensa, C.excluida, C.anonimizada, C.naoConfirmada, C.revogou, C.invalida, C.lista];
  for (const publico of Object.keys(publicos.PUBLICOS)) {
    const dentro = new Set(ids(await publicos.listarDestinatarios(publico)));
    for (const c of fora) assert.ok(!dentro.has(c.id), `${c.email} fora de "${publico}"`);
  }
  // O "fora do envio" explica a diferença — só números, por motivo. Conta
  // excluída/anonimizada não é mais conta de cliente: nem aparece.
  const r = await contagem('todas');
  assert.deepStrictEqual(r.foraDoEnvio, { suspensas: 1, emailNaoConfirmado: 1, naoQueremReceber: 1, emailInvalido: 2 });
  assert.deepStrictEqual((await contagem('com_plano')).foraDoEnvio.suspensas, 1);

  // A conta própria da Mostraí nunca é destinatária (é a caixa da empresa).
  const { rows } = await pool.query('SELECT id, contato_email FROM anunciantes WHERE conta_propria LIMIT 1');
  if (rows[0]) assert.strictEqual(await publicos.contaAindaRecebe(rows[0].id, rows[0].contato_email), false);
});

test('E. endereço repetido sai uma vez só', async () => {
  // O banco já não aceita dois logins iguais (anunciantes_email_lower_uk) —
  // a trava daqui é a segunda: mesma caixa com caixa-alta e espaço é 1.
  const lista = publicos.semRepetidos([
    { anuncianteId: 1, email: 'Fulano@Exemplo.com' },
    { anuncianteId: 2, email: ' fulano@exemplo.com ' },
    { anuncianteId: 3, email: 'outro@exemplo.com' },
    { anuncianteId: 4, email: '' },
  ]);
  assert.deepStrictEqual(
    lista.map((d) => d.anuncianteId),
    [1, 3],
  );
  // Dono de DOIS pontos e com plano: aparece uma vez em cada público.
  for (const publico of ['todas', 'com_plano', 'donos_de_ponto']) {
    const vezes = (await publicos.listarDestinatarios(publico)).filter((d) => d.anuncianteId === C.dono2.id).length;
    assert.strictEqual(vezes, 1, `dono2 uma vez em "${publico}"`);
  }
});

test('M. o que o admin escreve é texto: sem HTML, sem script, sem link perigoso', async () => {
  const perigoso = {
    assunto: 'Aviso <b>importante</b>\r\nBcc: roubo@golpe.com',
    titulo: '<script>alert(1)</script>Manutenção',
    mensagem: 'Linha 1 <img src=x onerror=alert(1)>\nLinha 2 "aspas" & \'apóstrofo\'\n\n\n\nParágrafo 2',
  };
  const v = conteudo.validar(perigoso);
  assert.ok(!v.erro, v.erro);
  assert.strictEqual(
    v.conteudo.assunto,
    'Aviso <b>importante</b> Bcc: roubo@golpe.com',
    'CR/LF do assunto vira espaço',
  );
  const m = conteudo.montar(v.conteudo);
  assert.ok(!/<script/i.test(m.html) && !/<img/i.test(m.html) && !/<b>/i.test(m.html), 'nenhuma marcação do admin');
  assert.ok(m.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;Manutenção'));
  assert.ok(m.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(m.html.includes('&quot;aspas&quot; &amp; &#39;apóstrofo&#39;'));
  assert.ok(m.html.includes('Linha 1 &lt;img src=x onerror=alert(1)&gt;<br>Linha 2'), 'quebra simples vira <br>');
  assert.strictEqual((m.html.match(/<p style/g) || []).length >= 3, true, 'parágrafos separados');
  assert.ok(m.text.includes('Linha 1 <img src=x onerror=alert(1)>\nLinha 2'), 'o texto puro é o texto');
  assert.ok(!m.text.includes('\n\n\n'), 'no máximo uma linha em branco seguida');

  // Link do botão: só https, sem usuário/senha, com domínio.
  const comBotao = (url) => conteudo.validar({ ...texto('m'), botaoTexto: 'Abrir', botaoUrl: url });
  for (const ruim of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://mostrai.test/planos.html',
    'https://mostrai.com.br@golpe.com/pix',
    'https://usuario:senha@mostrai.test',
    'https://localhost/x',
    'https://mostrai.test/a b',
    'ftp://mostrai.test/arquivo',
  ]) {
    const r = comBotao(ruim);
    assert.strictEqual(r.campo, 'botaoUrl', `recusado: ${ruim}`);
  }
  assert.strictEqual(
    comBotao('https://mostrai.test/planos.html').conteudo.botao.url,
    'https://mostrai.test/planos.html',
  );
  assert.strictEqual(conteudo.validar({ ...texto('m'), botaoUrl: 'https://mostrai.test' }).campo, 'botaoTexto');
  assert.strictEqual(conteudo.validar({ ...texto('m'), assunto: ' a ' }).campo, 'assunto');
  assert.strictEqual(conteudo.validar({ ...texto('m'), mensagem: '   ' }).campo, 'mensagem');
  assert.strictEqual(conteudo.validar({ ...texto('m'), titulo: 'x'.repeat(151) }).campo, 'titulo');

  // A prévia da rota é o e-mail montado pelo mesmo `montar` do envio.
  const previa = await admin('POST', '/admin/comunicados/previa', perigoso);
  assert.strictEqual(previa.status, 200, previa.texto);
  assert.strictEqual(previa.json.html, m.html, 'prévia = e-mail de verdade');
  assert.strictEqual(previa.json.texto, m.text);
  assert.ok(!/<script/i.test(previa.json.html));
  const invalida = await admin('POST', '/admin/comunicados/previa', {
    ...texto('m'),
    botaoTexto: 'x',
    botaoUrl: 'javascript:alert(1)',
  });
  assert.strictEqual(invalida.status, 400);
  assert.strictEqual(invalida.json.campo, 'botaoUrl');
});

test('K. sem sessão de admin nada funciona — nem com a conta de cliente logada', async () => {
  const anonimo = navegador();
  const cliente = navegador();
  assert.strictEqual(
    (await cliente('POST', '/anunciantes/login', { email: C.plano.email, senha: C.plano.senha })).status,
    200,
    'a conta de cliente loga normalmente',
  );
  const antes = saidas.length;
  for (const pedir of [anonimo, cliente]) {
    const tentativas = [
      ['GET', '/admin/comunicados'],
      ['GET', '/admin/comunicados/destinatarios?publico=todas'],
      ['POST', '/admin/comunicados/previa', texto('k')],
      ['POST', '/admin/comunicados/teste', { ...texto('k'), para: EQUIPE }],
      ['POST', '/admin/comunicados', { ...texto('k'), publico: 'todas', destinatariosConfirmados: 6 }],
      ['GET', '/admin/comunicados/1'],
      ['POST', '/admin/comunicados/1/reenviar-falhas', { paraReenviarConfirmados: 1 }],
    ];
    for (const [metodo, caminho, corpo] of tentativas) {
      const r = await pedir(metodo, caminho, corpo, { 'Idempotency-Key': chave() });
      assert.strictEqual(r.status, 401, `${metodo} ${caminho} sem admin`);
    }
  }
  assert.strictEqual(saidas.length, antes, 'nenhum e-mail saiu');
  const { rows: meus } = await pool.query('SELECT COUNT(*)::int AS n FROM comunicados WHERE assunto = $1', [
    texto('k').assunto,
  ]);
  assert.strictEqual(meus[0].n, 0, 'nenhum comunicado criado');
});

test('N. público sem destinatário bloqueia o envio real', async () => {
  publicos.config.escopo = `nenhuma-conta-${rodada}-`;
  try {
    const r = await contagem('todas');
    assert.strictEqual(r.destinatarios, 0);
    const envio = await enviar({ ...texto('n'), publico: 'todas', destinatariosConfirmados: 1 });
    assert.strictEqual(envio.status, 400, envio.texto);
    assert.strictEqual(envio.json.motivo, 'sem_destinatarios');
    const semConfirmar = await enviar({ ...texto('n'), publico: 'todas', destinatariosConfirmados: 0 });
    assert.strictEqual(semConfirmar.status, 400);
  } finally {
    publicos.config.escopo = PREFIXO;
  }
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM comunicados WHERE assunto = $1', [
    texto('n').assunto,
  ]);
  assert.strictEqual(rows[0].n, 0, 'nada gravado');
});

test('G. envio de teste: só pra caixa da equipe, marcado, fora do histórico', async () => {
  const destino = `${PREFIXO}teste@mostrai.test`;
  const r = await admin('POST', '/admin/comunicados/teste', { ...texto('g'), para: destino });
  assert.strictEqual(r.status, 200, r.texto);
  assert.strictEqual(r.json.para, outbox.mascararEmail(destino));
  const [m] = recebidos(destino);
  assert.ok(m, 'o teste chegou');
  assert.strictEqual(m.subject, `[TESTE] ${texto('g').assunto}`);
  assert.ok(m.text.includes(conteudo.AVISO_TESTE) && m.html.includes('ENVIO DE TESTE'));
  assert.ok(!m.cc && !m.bcc, 'sem cópia');

  // Sem endereço: vai pra caixa da equipe (MOSTRAI_EMAIL_CONTATO).
  const padrao = await admin('POST', '/admin/comunicados/teste', texto('g'));
  assert.strictEqual(padrao.status, 200, padrao.texto);
  assert.strictEqual(recebidos(EQUIPE).length, 1);

  // Nunca pra uma conta de cliente.
  const cliente = await admin('POST', '/admin/comunicados/teste', { ...texto('g'), para: C.plano.email });
  assert.strictEqual(cliente.status, 400);
  assert.strictEqual(cliente.json.campo, 'testePara');
  assert.strictEqual(recebidos(C.plano.email).length, 0);
  assert.strictEqual(
    (await admin('POST', '/admin/comunicados/teste', { ...texto('g'), para: 'a@b.com,c@d.com' })).status,
    400,
  );

  // SMTP recusou: o erro volta sem a senha e sem o endereço inteiro.
  falharPara.add(destino);
  try {
    const falha = await admin('POST', '/admin/comunicados/teste', { ...texto('g'), para: destino });
    assert.strictEqual(falha.status, 502);
    assert.ok(!falha.texto.includes(destino), 'erro sem o endereço');
  } finally {
    falharPara.delete(destino);
  }

  // Não virou comunicado nem histórico.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM comunicados WHERE assunto = $1', [
    texto('g').assunto,
  ]);
  assert.strictEqual(rows[0].n, 0);
});

test('H. envio real: um e-mail por destinatário, só o endereço dele no "Para"', async () => {
  const conteudoH = {
    ...texto('h'),
    botaoTexto: 'Abrir o painel',
    botaoUrl: 'https://mostrai.test/anunciante/painel.html',
  };
  const { destinatarios } = await contagem('todas');
  assert.strictEqual(destinatarios, 6);
  const r = await enviar({ ...conteudoH, publico: 'todas', destinatariosConfirmados: destinatarios });
  assert.strictEqual(r.status, 201, r.texto);
  const c = r.json.comunicado;
  assert.strictEqual(c.previstos, 6);
  assert.strictEqual(c.criadoPor, process.env.ADMIN_USER, 'quem enviou fica registrado');
  assert.strictEqual(c.situacao, 'em_andamento');

  // Fila: uma linha por destinatário, e a linha guarda só o id do comunicado.
  const { rows: fila } = await pool.query(
    `SELECT destinatario, tipo, classe, dados FROM email_outbox WHERE chave LIKE $1`,
    [`comunicado:${c.id}:%`],
  );
  assert.strictEqual(fila.length, 6);
  assert.strictEqual(new Set(fila.map((l) => l.destinatario)).size, 6, 'um endereço por linha, sem repetir');
  for (const l of fila) {
    assert.strictEqual(l.tipo, 'comunicado');
    assert.strictEqual(l.classe, 'operacional');
    assert.deepStrictEqual(l.dados, { comunicadoId: c.id }, 'texto não é copiado na fila');
  }

  await processarTudo();
  const esperados = [C.plano, C.semPlano, C.vencido, C.dono, C.dono2, C.arquivado].map((x) => x.email);
  const deste = saidas.filter((m) => m.subject === conteudoH.assunto);
  assert.strictEqual(deste.length, 6);
  assert.deepStrictEqual(deste.map((m) => enderecoDe(m.to)).sort(), [...esperados].sort());
  for (const m of deste) {
    assert.strictEqual(typeof m.to, 'object', 'um endereço, como objeto — nunca uma lista em texto');
    assert.ok(!m.cc && !m.bcc, 'ninguém em cópia');
    assert.ok(m.html.includes(conteudoH.titulo) && m.html.includes('https://mostrai.test/anunciante/painel.html'));
    assert.ok(m.text.includes('Mensagem h da Mostraí.') && m.text.includes('Abrir o painel: https://mostrai.test'));
    assert.ok(m.text.includes('desmarque "Quero receber novidades e ofertas'), 'rodapé diz como parar');
    for (const outro of esperados) {
      if (outro !== enderecoDe(m.to))
        assert.ok(!m.html.includes(outro) && !m.text.includes(outro), 'nada de outro destinatário');
    }
  }
  const depois = await repo.buscarResumo(c.id);
  assert.strictEqual(depois.enviados, 6);
  assert.strictEqual(depois.falharam, 0);
  assert.strictEqual(depois.situacao, 'concluido');
  const { rows: regs } = await pool.query(
    "SELECT COUNT(*)::int AS n FROM comunicados_destinatarios WHERE comunicado_id = $1 AND situacao = 'enviado'",
    [c.id],
  );
  assert.strictEqual(regs[0].n, 6, 'resultado por destinatário registrado');
});

test('I. duplo clique, nova tentativa e página recarregada não mandam duas vezes', async () => {
  const corpo = { ...texto('i'), publico: 'donos_de_ponto', destinatariosConfirmados: 2 };
  const k = chave();
  // Duplo clique: as duas chegam juntas, com a mesma chave.
  const [a, b] = await Promise.all([enviar(corpo, { chaveEnvio: k }), enviar(corpo, { chaveEnvio: k })]);
  assert.deepStrictEqual([a.status, b.status].sort(), [200, 201], `${a.texto} / ${b.texto}`);
  assert.strictEqual(a.json.comunicado.id, b.json.comunicado.id, 'o mesmo comunicado');
  const id = a.json.comunicado.id;
  const repetida = a.status === 200 ? a : b;
  assert.strictEqual(repetida.json.repetido, true);

  // Tempo esgotado → a tela tenta de novo com a MESMA chave.
  const denovo = await enviar(corpo, { chaveEnvio: k });
  assert.strictEqual(denovo.status, 200);
  assert.strictEqual(denovo.json.comunicado.id, id);

  // Página recarregada (chave nova), mesmo conteúdo e público: barrado.
  const recarregada = await enviar(corpo);
  assert.strictEqual(recarregada.status, 409, recarregada.texto);
  assert.strictEqual(recarregada.json.motivo, 'repetido');
  assert.strictEqual(recarregada.json.comunicadoId, id);

  // A mesma chave com OUTRO conteúdo não vira envio novo nem devolve o antigo.
  const outra = await enviar({ ...corpo, mensagem: 'Outra mensagem' }, { chaveEnvio: k });
  assert.strictEqual(outra.status, 409);

  // Sem chave: recusado antes de qualquer coisa.
  const semChave = await admin('POST', '/admin/comunicados', corpo);
  assert.strictEqual(semChave.status, 400);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM comunicados WHERE assunto = $1', [corpo.assunto]);
  assert.strictEqual(rows[0].n, 1, 'um comunicado só');
  const { rows: fila } = await pool.query('SELECT COUNT(*)::int AS n FROM email_outbox WHERE chave LIKE $1', [
    `comunicado:${id}:%`,
  ]);
  assert.strictEqual(fila[0].n, 2, 'uma mensagem por destinatário na fila');
  await processarTudo();
  for (const c of [C.dono, C.dono2]) assert.strictEqual(recebidos(c.email, corpo.assunto).length, 1, c.email);
});

test('público que mudou entre a confirmação e o clique: nada sai, a tela recebe o número novo', async () => {
  const corpo = { ...texto('mudou'), publico: 'com_plano', destinatariosConfirmados: 3 };
  const r = await enviar(corpo);
  assert.strictEqual(r.status, 409, r.texto);
  assert.strictEqual(r.json.motivo, 'publico_mudou');
  assert.strictEqual(r.json.destinatarios, 2);
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM comunicados WHERE assunto = $1', [corpo.assunto]);
  assert.strictEqual(rows[0].n, 0);
});

test('J. falha parcial aparece como tal, e "Reenviar falhas" pega só quem falhou', async () => {
  const corpo = { ...texto('j'), publico: 'sem_plano', destinatariosConfirmados: 4 };
  falharPara.add(C.vencido.email);
  let id;
  try {
    const r = await enviar(corpo);
    assert.strictEqual(r.status, 201, r.texto);
    id = r.json.comunicado.id;
    await processarTudo();
    let resumo = await repo.buscarResumo(id);
    assert.strictEqual(resumo.enviados, 3);
    assert.strictEqual(resumo.tentandoDeNovo, 1, 'a recusada fica tentando de novo');
    assert.strictEqual(resumo.situacao, 'em_andamento');

    // Esgota as tentativas da fila (como o tempo faria).
    for (let i = 1; i < outbox.MAX_TENTATIVAS; i++) {
      await pool.query(
        "UPDATE email_outbox SET proxima_tentativa_em = now() - interval '1 second' WHERE chave LIKE $1 AND status = 'tentando_de_novo'",
        [`comunicado:${id}:%`],
      );
      await processarTudo();
    }
    resumo = await repo.buscarResumo(id);
    assert.deepStrictEqual(
      { enviados: resumo.enviados, falharam: resumo.falharam, naFila: resumo.naFila, situacao: resumo.situacao },
      { enviados: 3, falharam: 1, naFila: 0, situacao: 'concluido_com_falhas' },
    );
    const detalhe = await admin('GET', `/admin/comunicados/${id}`);
    assert.strictEqual(detalhe.status, 200);
    assert.strictEqual(detalhe.json.paraReenviar, 1);
    assert.strictEqual(detalhe.json.problemas.length, 1);
    const [p] = detalhe.json.problemas;
    assert.strictEqual(p.situacao, 'falhou');
    assert.strictEqual(p.email, outbox.mascararEmail(C.vencido.email), 'endereço mascarado');
    assert.ok(!detalhe.texto.includes(C.vencido.email), 'o endereço inteiro não aparece');
    assert.ok(p.erro.includes('550') && !p.erro.includes(C.vencido.email), 'motivo sem endereço');
  } finally {
    falharPara.delete(C.vencido.email);
  }

  const antes = Object.fromEntries(
    [C.semPlano, C.dono, C.arquivado].map((c) => [c.email, recebidos(c.email, corpo.assunto).length]),
  );
  const confirmacaoErrada = await admin('POST', `/admin/comunicados/${id}/reenviar-falhas`, {
    paraReenviarConfirmados: 2,
  });
  assert.strictEqual(confirmacaoErrada.status, 409);
  const reenvio = await admin('POST', `/admin/comunicados/${id}/reenviar-falhas`, { paraReenviarConfirmados: 1 });
  assert.strictEqual(reenvio.status, 200, reenvio.texto);
  assert.strictEqual(reenvio.json.reenfileirados, 1);
  const { rows: rodada2 } = await pool.query('SELECT destinatario FROM email_outbox WHERE chave = $1', [
    `comunicado:${id}:${C.vencido.id}:2`,
  ]);
  assert.strictEqual(rodada2.length, 1, 'rodada nova, chave nova na fila');
  await processarTudo();

  assert.strictEqual(recebidos(C.vencido.email, corpo.assunto).length, 1, 'quem falhou agora recebeu');
  for (const [endereco, n] of Object.entries(antes)) {
    assert.strictEqual(recebidos(endereco, corpo.assunto).length, n, `${endereco} não recebeu de novo`);
    assert.strictEqual(n, 1);
  }
  const final = await repo.buscarResumo(id);
  assert.deepStrictEqual(
    { enviados: final.enviados, falharam: final.falharam, reenvios: final.reenvios, situacao: final.situacao },
    { enviados: 4, falharam: 0, reenvios: 1, situacao: 'concluido' },
  );
  const { rows: trilha } = await pool.query(
    'SELECT quantidade, criado_por FROM comunicados_reenvios WHERE comunicado_id = $1',
    [id],
  );
  assert.deepStrictEqual(
    trilha,
    [{ quantidade: 1, criado_por: process.env.ADMIN_USER }],
    'quem reenviou fica registrado',
  );

  // Segundo clique em "Reenviar": não há mais falha — nada volta pra fila.
  const segundo = await admin('POST', `/admin/comunicados/${id}/reenviar-falhas`, { paraReenviarConfirmados: 1 });
  assert.strictEqual(segundo.status, 409);
  assert.strictEqual(segundo.json.paraReenviar, 0);
});

test('conta que sai do público antes da vez dela não recebe (descartado, não é falha)', async () => {
  const corpo = { ...texto('descarte'), publico: 'com_plano', destinatariosConfirmados: 2 };
  const r = await enviar(corpo);
  assert.strictEqual(r.status, 201, r.texto);
  const id = r.json.comunicado.id;
  // Entre o clique e a vez dela, a conta desmarca "receber novidades".
  await pool.query('UPDATE anunciantes SET comunicacoes_revogado_em = now() WHERE id = $1', [C.plano.id]);
  try {
    await processarTudo();
  } finally {
    await pool.query('UPDATE anunciantes SET comunicacoes_revogado_em = NULL WHERE id = $1', [C.plano.id]);
  }
  assert.strictEqual(recebidos(C.plano.email, corpo.assunto).length, 0, 'quem saiu não recebeu');
  assert.strictEqual(recebidos(C.dono2.email, corpo.assunto).length, 1);
  const resumo = await repo.buscarResumo(id);
  assert.deepStrictEqual(
    {
      enviados: resumo.enviados,
      descartados: resumo.descartados,
      falharam: resumo.falharam,
      situacao: resumo.situacao,
    },
    { enviados: 1, descartados: 1, falharam: 0, situacao: 'concluido' },
  );
  const detalhe = await admin('GET', `/admin/comunicados/${id}`);
  assert.strictEqual(detalhe.json.paraReenviar, 0, 'descartado não volta pela porta do reenvio');
});

test('ritmo: cada destinatário ganha a vez dele, e comunicado não atrasa código de verificação', async () => {
  repo.config.intervaloS = 2;
  let id;
  try {
    const r = await enviar({ ...texto('ritmo'), publico: 'sem_plano', destinatariosConfirmados: 4 });
    assert.strictEqual(r.status, 201, r.texto);
    id = r.json.comunicado.id;
  } finally {
    repo.config.intervaloS = 0;
  }
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM proxima_tentativa_em - MIN(proxima_tentativa_em) OVER ())::float AS s
       FROM email_outbox WHERE chave LIKE $1 ORDER BY proxima_tentativa_em`,
    [`comunicado:${id}:%`],
  );
  assert.deepStrictEqual(
    rows.map((x) => Math.round(x.s)),
    [0, 2, 4, 6],
  );

  // Tudo pronto pra sair, e um código de verificação entra DEPOIS: sai antes.
  await pool.query("UPDATE email_outbox SET proxima_tentativa_em = now() - interval '1 minute' WHERE chave LIKE $1", [
    `comunicado:${id}:%`,
  ]);
  await outbox.enfileirar({
    tipo: 'codigo_confirmacao',
    chave: `codigo_confirmacao:comunicados:${rodada}`,
    para: `${PREFIXO}codigo@example.com`,
    dados: { conta: { nome_empresa: 'Código' }, validadeMinutos: 10 },
    segredo: { codigo: '123456' },
  });
  const primeira = await outbox.pegarProxima(PREFIXO);
  assert.strictEqual(primeira.tipo, 'codigo_confirmacao', 'o código passa na frente do comunicado');
  await pool.query("UPDATE email_outbox SET status = 'na_fila', enviando_desde = NULL, tentativas = 0 WHERE id = $1", [
    primeira.id,
  ]);
  await processarTudo();
  assert.strictEqual((await repo.buscarResumo(id)).enviados, 4);
});

test('L. histórico: contagens, quem enviou, e nenhum endereço', async () => {
  const r = await admin('GET', '/admin/comunicados');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(
    r.json.publicos.map((p) => p.id),
    ['todas', 'com_plano', 'sem_plano', 'donos_de_ponto'],
  );
  assert.strictEqual(r.json.testePadrao, outbox.mascararEmail(EQUIPE));
  const meus = r.json.comunicados.filter((c) => c.assunto.endsWith(rodada));
  assert.ok(meus.length >= 4, 'os comunicados deste arquivo estão no histórico');
  for (const c of meus) {
    for (const campo of [
      'id',
      'assunto',
      'publico',
      'publicoRotulo',
      'previstos',
      'enviados',
      'falharam',
      'criadoPor',
      'criadoEm',
      'situacao',
    ]) {
      assert.ok(c[campo] !== undefined, `${campo} no histórico`);
    }
  }
  const h = meus.find((c) => c.assunto === texto('h').assunto);
  assert.deepStrictEqual(
    {
      previstos: h.previstos,
      enviados: h.enviados,
      falharam: h.falharam,
      situacao: h.situacao,
      publicoRotulo: h.publicoRotulo,
    },
    { previstos: 6, enviados: 6, falharam: 0, situacao: 'concluido', publicoRotulo: 'Todas as contas ativas' },
  );
  // O mais recente vem primeiro.
  const datas = r.json.comunicados.map((c) => Date.parse(c.criadoEm));
  assert.deepStrictEqual(
    datas,
    [...datas].sort((a, b) => b - a),
  );
  for (const c of Object.values(C)) assert.ok(!r.texto.includes(c.email), `histórico sem ${c.email}`);
  assert.strictEqual((await admin('GET', '/admin/comunicados/999999999')).status, 404);
  assert.strictEqual((await admin('GET', '/admin/comunicados/abc')).status, 404);
});
