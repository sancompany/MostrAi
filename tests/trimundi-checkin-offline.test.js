const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const apoio = require('./trimundi-apoio');
const { consultar } = require('../src/trimundi/db/conexao');
const { conteudoDoQr } = require('../src/trimundi/lib/qr');

// Check-in sem internet (pedido do dono, 10/11/2026): pacote da edição sem
// dado pessoal desnecessário, sincronização idempotente e conflitos entre
// aparelhos desconectados detectados no servidor — nunca "impedidos".

let srv;
let admin;
test.before(async () => {
  srv = await apoio.iniciarApp();
  admin = apoio.cliente(srv, { cookie: await apoio.entrarAdmin(srv) });
});
test.after(async () => {
  await srv.fechar();
  await apoio.encerrar();
});

const sha = (t) => crypto.createHash('sha256').update(t).digest('base64url');
const novoId = () => crypto.randomUUID();

async function cenario(n = 2) {
  const pronta = await apoio.edicaoPronta();
  const comprador = apoio.pessoa('Bia Souza');
  const ped = await apoio.novoPedido(pronta, apoio.itensDe(pronta.tipo, n), { comprador });
  await apoio.pagar(ped.pedido_id);
  const { rows: ingressos } = await consultar(
    `SELECT i.id, i.codigo, i.codigo_curto, pa.nome, pa.cpf, pa.email FROM ingressos i
       JOIN participantes pa ON pa.id = i.participante_id WHERE i.pedido_id = $1 ORDER BY i.id`,
    [ped.pedido_id],
  );
  const { rows: ed } = await consultar('SELECT codigo_publico FROM edicoes WHERE id = $1', [pronta.edicao.id]);
  const op1 = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  const op2 = await apoio.operadorLogado(srv, [pronta.edicao.id]);
  return {
    pronta,
    codigoPublico: ed[0].codigo_publico,
    ped,
    ingressos,
    a: apoio.cliente(srv, { cookie: op1.cookie }),
    b: apoio.cliente(srv, { cookie: op2.cookie }),
  };
}
const sincronizar = (op, edicaoId, aparelho, registros) =>
  op.post('/ticket/api/checkin/sincronizar', { edicao_id: edicaoId, aparelho_id: aparelho, registros });

test('16. pacote: hashes do código, situação, tipo e só o primeiro nome — sem CPF, e-mail nem código em claro', async () => {
  const { pronta, codigoPublico, ingressos, a } = await cenario();
  const r = await a.get(`/ticket/api/checkin/pacote?edicao=${pronta.edicao.id}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-store/);
  const p = r.json;
  assert.equal(p.edicao.id, Number(pronta.edicao.id));
  assert.equal(p.edicao.codigo_publico, codigoPublico);
  assert.match(p.chave_publica, /^[A-Za-z0-9_-]+$/);
  assert.equal(p.ingressos.length, 2);
  const i0 = p.ingressos.find((x) => x.i === Number(ingressos[0].id));
  assert.equal(i0.h, sha(ingressos[0].codigo));
  assert.equal(i0.c, sha(`${p.edicao.codigo_publico}:${ingressos[0].codigo_curto}`));
  assert.deepEqual([i0.s, i0.u, i0.t], ['valido', false, 'Pista']);
  assert.equal(i0.n, ingressos[0].nome.split(' ')[0], 'só o primeiro nome');
  for (const ing of ingressos) {
    for (const segredo of [ing.codigo, ing.codigo_curto, ing.cpf, ing.email, ing.nome]) {
      assert.equal(r.texto.includes(segredo), false, `o pacote não traz ${segredo}`);
    }
  }
  // A chave do pacote confere a assinatura do QR de verdade (o aparelho faz o mesmo com WebCrypto).
  const qr = conteudoDoQr(p.edicao.codigo_publico, ingressos[0].codigo);
  const [, cp, codigo, assinatura] = qr.split('.');
  const publica = crypto.createPublicKey({
    key: Buffer.from(p.chave_publica, 'base64url'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(
    crypto.verify(null, Buffer.from(`TM1.${cp}.${codigo}`), publica, Buffer.from(assinatura, 'base64url')),
    true,
  );

  // Sem sessão de operador, ou operador de outra edição: não baixa.
  assert.equal((await apoio.cliente(srv).get(`/ticket/api/checkin/pacote?edicao=${pronta.edicao.id}`)).status, 401);
  const outra = await apoio.edicaoPronta();
  const deFora = await apoio.operadorLogado(srv, [outra.edicao.id]);
  assert.equal(
    (await apoio.cliente(srv, { cookie: deFora.cookie }).get(`/ticket/api/checkin/pacote?edicao=${pronta.edicao.id}`))
      .status,
    403,
  );
});

test('16. sincronização: entrada offline vira check-in; reenviar não duplica; o pacote seguinte diz "já entrou"', async () => {
  const { pronta, ingressos, a } = await cenario();
  const reg = {
    registro_id: novoId(),
    ingresso_id: ingressos[0].id,
    lido_em: new Date(Date.now() - 60000).toISOString(),
  };
  const r1 = await sincronizar(a, pronta.edicao.id, 'aparelho-aaaa1111', [reg]);
  assert.equal(r1.status, 200, r1.texto);
  assert.deepEqual(
    r1.json.resultados.map((x) => x.resultado),
    ['aceito'],
  );
  const r2 = await sincronizar(a, pronta.edicao.id, 'aparelho-aaaa1111', [reg]);
  assert.equal(r2.json.resultados[0].resultado, 'aceito');
  assert.equal(r2.json.resultados[0].repetido, true);
  const { rows } = await consultar(
    'SELECT resultado, modo, aparelho_id, lido_no_aparelho_em FROM checkins WHERE ingresso_id = $1',
    [ingressos[0].id],
  );
  assert.equal(rows.length, 1, 'uma linha só');
  assert.deepEqual([rows[0].resultado, rows[0].modo, rows[0].aparelho_id], ['aceito', 'offline', 'aparelho-aaaa1111']);
  assert.ok(rows[0].lido_no_aparelho_em, 'guarda a hora da leitura no aparelho');
  const p = (await a.get(`/ticket/api/checkin/pacote?edicao=${pronta.edicao.id}`)).json;
  assert.equal(p.ingressos.find((x) => x.i === Number(ingressos[0].id)).u, true);
  // Contador online soma a entrada offline.
  assert.equal((await a.get(`/ticket/api/checkin/contador?edicao=${pronta.edicao.id}`)).json.entradas, 1);
});

test('18. dois aparelhos sem internet liberam o mesmo ingresso: o primeiro a sincronizar vale, o outro é conflito no Admin', async () => {
  const { pronta, ingressos, a, b } = await cenario();
  const alvo = ingressos[0].id;
  const lidoA = new Date(Date.now() - 5 * 60000).toISOString();
  const lidoB = new Date(Date.now() - 4 * 60000).toISOString();
  const ra = await sincronizar(a, pronta.edicao.id, 'aparelho-aaaa1111', [
    { registro_id: novoId(), ingresso_id: alvo, lido_em: lidoA },
  ]);
  const rb = await sincronizar(b, pronta.edicao.id, 'aparelho-bbbb2222', [
    { registro_id: novoId(), ingresso_id: alvo, lido_em: lidoB },
  ]);
  assert.equal(ra.json.resultados[0].resultado, 'aceito');
  assert.equal(rb.json.resultados[0].resultado, 'conflito');
  assert.ok(rb.json.resultados[0].entrada, 'diz qual entrada valeu');
  const { rows } = await consultar(
    "SELECT count(*)::int AS n FROM checkins WHERE ingresso_id = $1 AND escopo = 'entrada' AND resultado = 'aceito'",
    [alvo],
  );
  assert.equal(rows[0].n, 1, 'o banco segue com uma entrada aceita');

  const c = (await admin.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/checkin/conflitos`)).json;
  assert.equal(c.length, 1);
  assert.equal(c[0].ingresso_id, Number(alvo));
  assert.match(c[0].motivo, /já tinha entrada/);
  assert.equal(c[0].aparelho, 'aparelho-bbbb2222');
  assert.equal(c[0].entrada_valida.modo, 'offline');
  assert.equal(new Date(c[0].entrada_valida.em).toISOString(), lidoA);
});

test('18. entrada online antes da sincronização e ingresso cancelado depois do pacote também viram conflito', async () => {
  const { pronta, ingressos, a, b } = await cenario();
  // Online pelo aparelho A; o B (sem internet) também liberou o mesmo.
  const online = await a.post('/ticket/api/checkin/confirmar', {
    edicao_id: pronta.edicao.id,
    ingresso_id: ingressos[0].id,
  });
  assert.equal(online.json.resultado, 'entrada_registrada');
  const rb = await sincronizar(b, pronta.edicao.id, 'aparelho-bbbb2222', [
    { registro_id: novoId(), ingresso_id: ingressos[0].id, lido_em: new Date().toISOString() },
  ]);
  assert.equal(rb.json.resultados[0].resultado, 'conflito');
  assert.equal(rb.json.resultados[0].entrada.modo, 'online');

  // Reembolso depois do pacote: o ingresso foi cancelado; a leitura offline é recusada.
  const outro = await cenario(1);
  await apoio.aplicarAviso(await apoio.aviso(outro.ped.pedido_id, 'estornado'));
  const rc = await sincronizar(outro.a, outro.pronta.edicao.id, 'aparelho-cccc3333', [
    { registro_id: novoId(), ingresso_id: outro.ingressos[0].id, lido_em: new Date().toISOString() },
  ]);
  assert.deepEqual([rc.json.resultados[0].resultado, rc.json.resultados[0].motivo], ['recusado', 'offline:cancelado']);
  const c = (await admin.get(`/admin/trimundi/edicoes/${outro.pronta.edicao.id}/checkin/conflitos`)).json;
  assert.match(c[0].motivo, /cancelado/);
});

test('sincronização confere tudo de novo: outra edição, id ruim, lote grande, aparelho sem id, hora absurda', async () => {
  const { pronta, ingressos, a } = await cenario();
  const outra = await cenario(1);
  const r = await sincronizar(a, pronta.edicao.id, 'aparelho-aaaa1111', [
    { registro_id: novoId(), ingresso_id: outra.ingressos[0].id, lido_em: new Date().toISOString() },
  ]);
  assert.equal(r.json.resultados[0].resultado, 'invalido', 'ingresso de outra edição não entra');
  assert.equal(
    (await sincronizar(a, pronta.edicao.id, 'x', [{ registro_id: novoId(), ingresso_id: ingressos[0].id }])).status,
    400,
  );
  assert.equal(
    (
      await sincronizar(a, pronta.edicao.id, 'aparelho-aaaa1111', [
        { registro_id: 'nao-e-uuid', ingresso_id: ingressos[0].id },
      ])
    ).status,
    400,
  );
  const muitos = Array.from({ length: 501 }, () => ({ registro_id: novoId(), ingresso_id: ingressos[0].id }));
  assert.equal((await sincronizar(a, pronta.edicao.id, 'aparelho-aaaa1111', muitos)).status, 400);
  // Relógio do celular no ano que vem: aceita a entrada, sem a hora do aparelho.
  const futuro = await sincronizar(a, pronta.edicao.id, 'aparelho-aaaa1111', [
    { registro_id: novoId(), ingresso_id: ingressos[1].id, lido_em: '2099-01-01T00:00:00Z' },
  ]);
  assert.equal(futuro.json.resultados[0].resultado, 'aceito');
  const { rows } = await consultar('SELECT lido_no_aparelho_em FROM checkins WHERE ingresso_id = $1', [
    ingressos[1].id,
  ]);
  assert.equal(rows[0].lido_no_aparelho_em, null);
  // Operador não abre a lista de conflitos do Admin.
  assert.equal((await a.get(`/admin/trimundi/edicoes/${pronta.edicao.id}/checkin/conflitos`)).status, 401);
});

test('15. check-in online continua igual (consultar → confirmar → já utilizado)', async () => {
  const { pronta, codigoPublico, ingressos, a } = await cenario(1);
  const qr = conteudoDoQr(codigoPublico, ingressos[0].codigo);
  const c = await a.post('/ticket/api/checkin/consultar', { edicao_id: pronta.edicao.id, entrada: qr });
  assert.equal(c.json.resultado, 'valido');
  const ok = await a.post('/ticket/api/checkin/confirmar', {
    edicao_id: pronta.edicao.id,
    ingresso_id: c.json.ingresso.id,
  });
  assert.equal(ok.json.resultado, 'entrada_registrada');
  const de = await a.post('/ticket/api/checkin/consultar', { edicao_id: pronta.edicao.id, entrada: qr });
  assert.equal(de.json.resultado, 'ja_utilizado');
  const { rows } = await consultar("SELECT modo FROM checkins WHERE ingresso_id = $1 AND resultado = 'aceito'", [
    ingressos[0].id,
  ]);
  assert.equal(rows[0].modo, 'online');
});
