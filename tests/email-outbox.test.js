const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');

// Outbox de e-mails (migration 097). O que este arquivo prova, com SMTP
// FALSO (nenhum e-mail sai de verdade):
//   · a mensagem entra na fila e sai pelo processador; o segredo (código,
//     link) é cifrado na fila e apagado quando ela termina;
//   · mesma chave de evento = um e-mail só (idempotência);
//   · falha de SMTP vira nova tentativa com espera crescente e erro sem
//     endereço; depois do limite, "abandonado" — visível no resumo do admin;
//   · código vencido antes de sair é descartado, não enviado;
//   · instância que morreu no meio do envio é retomada por outra;
//   · várias instâncias ao mesmo tempo nunca mandam a mesma mensagem 2×;
//   · cobrança falhada avisada pelo webhook E pela conciliação = 1 e-mail;
//   · e-mail que não entra na fila não quebra a operação de negócio.
process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-teste';
process.env.SAN_CHECKOUT_API_URL = process.env.SAN_CHECKOUT_API_URL || 'https://checkout.exemplo';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'segredo-de-teste-da-outbox';
const email = require('../src/financeiro/email');
const outbox = require('../src/email/outbox');
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const { conciliarAssinaturas } = require('../src/financeiro/conciliacao');

const rodada = randomUUID().slice(0, 8);
const para = (n) => `outbox-${rodada}-${n}@example.com`;

// SMTP falso: guarda o que "saiu"; `falharPara` simula recusa do servidor.
const enviados = [];
const falharPara = new Set();
email.usarTransporte({
  sendMail: async (m) => {
    if (falharPara.has(m.to)) throw new Error(`550 mailbox unavailable for ${m.to}`);
    enviados.push(m);
    return { messageId: 'falso' };
  },
});
const chegaram = (destino) => enviados.filter((m) => m.to === destino);

async function linha(chave) {
  const { rows } = await pool.query('SELECT * FROM email_outbox WHERE chave = $1', [chave]);
  return rows[0];
}
// Os arquivos de teste rodam em paralelo contra o mesmo banco: este só
// processa as mensagens dele (escopo = prefixo do destinatário).
async function processarTudo() {
  while ((await outbox.processarPendentes({ limite: 500, escopo: `outbox-${rodada}-` })) > 0);
  await outbox.aguardarRodadas();
}
const contas = [];

test.after(async () => {
  await pool.query('DELETE FROM email_outbox WHERE destinatario LIKE $1 OR chave LIKE $2', [
    `outbox-${rodada}-%`,
    `%${rodada}%`,
  ]);
  for (const id of contas) {
    await pool.query('DELETE FROM email_outbox WHERE anunciante_id = $1', [id]);
    await pool.query("DELETE FROM eventos_assinatura_pendentes WHERE payload->>'documento' = $1", ['52998224725']);
    await pool.query('DELETE FROM webhooks_processados WHERE id LIKE $1', [`%${rodada}%`]);
    await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  email.usarTransporte(null);
});

test('1. entra na fila, sai pelo processador; segredo cifrado e apagado depois', async () => {
  const chave = `codigo_confirmacao:t1:${rodada}`;
  const r = await outbox.enfileirar({
    tipo: 'codigo_confirmacao',
    chave,
    para: para(1),
    dados: { conta: { nome_empresa: 'Padaria Um' }, validadeMinutos: 10 },
    segredo: { codigo: '482913' },
  });
  assert.strictEqual(r.novo, true);
  let l = await linha(chave);
  assert.strictEqual(l.status, 'na_fila');
  assert.strictEqual(l.classe, 'critico');
  assert.ok(l.segredo && !l.segredo.includes('482913'), 'código cifrado na fila, nunca em claro');
  assert.ok(!JSON.stringify(l.dados).includes('482913'), 'código fora de `dados`');

  await processarTudo();
  l = await linha(chave);
  assert.strictEqual(l.status, 'enviado');
  assert.strictEqual(l.segredo, null, 'segredo apagado quando a mensagem termina');
  assert.ok(l.enviado_em);
  const [m] = chegaram(para(1));
  assert.ok(m.text.includes('482913') && m.html.includes('482913'), 'o código chega no e-mail');
  assert.ok(m.text.includes('10 minutos'));
});

test('2. mesma chave de evento = um e-mail só', async () => {
  const chave = `boas_vindas:t2:${rodada}`;
  const msg = { tipo: 'boas_vindas', chave, para: para(2), dados: { conta: { nome_empresa: 'Dois' } } };
  assert.strictEqual((await outbox.enfileirar(msg)).novo, true);
  assert.strictEqual((await outbox.enfileirar(msg)).novo, false);
  await processarTudo();
  assert.strictEqual((await outbox.enfileirar(msg)).novo, false, 'nem depois de enviado');
  await processarTudo();
  assert.strictEqual(chegaram(para(2)).length, 1);
});

test('3. falha de SMTP: nova tentativa com espera crescente, erro sem endereço; no limite, abandonado', async () => {
  const chave = `conta_reativada:t3:${rodada}`;
  falharPara.add(para(3));
  try {
    await outbox.enfileirar({
      tipo: 'conta_reativada',
      chave,
      para: para(3),
      dados: { conta: { nome_empresa: 'Três' } },
    });
    await processarTudo();
    let l = await linha(chave);
    assert.strictEqual(l.status, 'tentando_de_novo');
    assert.strictEqual(l.tentativas, 1);
    assert.ok(!l.ultimo_erro.includes('@'), `erro sanitizado: ${l.ultimo_erro}`);
    const espera1 = (new Date(l.proxima_tentativa_em) - new Date(l.atualizado_em)) / 1000;
    assert.ok(espera1 >= 29 && espera1 <= 31, `primeira espera ~30 s (foi ${espera1})`);

    for (let i = 2; i <= outbox.MAX_TENTATIVAS; i++) {
      await pool.query("UPDATE email_outbox SET proxima_tentativa_em = now() - interval '1 second' WHERE chave = $1", [
        chave,
      ]);
      await processarTudo();
      l = await linha(chave);
      if (i < outbox.MAX_TENTATIVAS) {
        const espera = Math.round((new Date(l.proxima_tentativa_em) - new Date(l.atualizado_em)) / 1000);
        assert.strictEqual(espera, outbox.ESPERAS_S[i - 1], `espera antes da tentativa ${i + 1}`);
      }
    }
    assert.strictEqual(l.status, 'abandonado');
    assert.strictEqual(l.tentativas, outbox.MAX_TENTATIVAS);
    assert.strictEqual(chegaram(para(3)).length, 0);

    // Não é retry infinito: abandonado não volta pra fila.
    await pool.query("UPDATE email_outbox SET proxima_tentativa_em = now() - interval '1 hour' WHERE chave = $1", [
      chave,
    ]);
    await processarTudo();
    assert.strictEqual((await linha(chave)).tentativas, outbox.MAX_TENTATIVAS);

    const resumo = await outbox.resumo();
    const visivel = resumo.problemas.find((p) => p.id === l.id);
    assert.ok(visivel, 'abandonado aparece na visão operacional');
    assert.strictEqual(visivel.destinatario, outbox.mascararEmail(para(3)), 'destinatário mascarado');
    assert.ok(!('segredo' in visivel) && !('dados' in visivel), 'conteúdo nunca sai no resumo');
  } finally {
    falharPara.delete(para(3));
  }
});

test('4. código vencido antes de sair é descartado, não enviado', async () => {
  const chave = `codigo_confirmacao:t4:${rodada}`;
  await outbox.enfileirar({
    tipo: 'codigo_confirmacao',
    chave,
    para: para(4),
    dados: { conta: { nome_empresa: 'Quatro' }, validadeMinutos: 10 },
    segredo: { codigo: '111222' },
    validoAte: new Date(Date.now() - 1000),
  });
  await processarTudo();
  const l = await linha(chave);
  assert.strictEqual(l.status, 'descartado');
  assert.strictEqual(l.segredo, null);
  assert.strictEqual(chegaram(para(4)).length, 0);
});

test('5. instância que morreu no meio do envio: outra retoma depois do prazo', async () => {
  const chave = `boas_vindas:t5:${rodada}`;
  await pool.query(
    `INSERT INTO email_outbox (chave, tipo, classe, destinatario, dados, status, tentativas, enviando_desde)
     VALUES ($1, 'boas_vindas', 'operacional', $2, $3, 'enviando', 1, now() - interval '10 minutes')`,
    [chave, para(5), { conta: { nome_empresa: 'Cinco' } }],
  );
  // Ainda dentro do prazo, ninguém mexe.
  const recente = `boas_vindas:t5b:${rodada}`;
  await pool.query(
    `INSERT INTO email_outbox (chave, tipo, classe, destinatario, dados, status, tentativas, enviando_desde)
     VALUES ($1, 'boas_vindas', 'operacional', $2, $3, 'enviando', 1, now())`,
    [recente, para(55), { conta: { nome_empresa: 'Cinco B' } }],
  );
  await processarTudo();
  const l = await linha(chave);
  assert.strictEqual(l.status, 'enviado');
  assert.strictEqual(l.tentativas, 2);
  assert.strictEqual((await linha(recente)).status, 'enviando', 'dentro do prazo continua com quem pegou');
});

test('6. várias instâncias ao mesmo tempo: cada mensagem sai UMA vez', async () => {
  const N = 30;
  for (let i = 0; i < N; i++) {
    await outbox.enfileirar({
      tipo: 'boas_vindas',
      chave: `boas_vindas:t6-${i}:${rodada}`,
      para: para(`6-${i}`),
      dados: { conta: { nome_empresa: `Seis ${i}` } },
    });
  }
  // 8 "instâncias": laços independentes, cada um com a própria conexão.
  const instancia = async () => {
    while (await outbox.enviarUma(`outbox-${rodada}-`));
  };
  await Promise.all(Array.from({ length: 8 }, instancia));
  for (let i = 0; i < N; i++) {
    assert.strictEqual(chegaram(para(`6-${i}`)).length, 1, `mensagem ${i}`);
    assert.strictEqual((await linha(`boas_vindas:t6-${i}:${rodada}`)).status, 'enviado');
  }
});

async function contaComAssinatura() {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, email_confirmado)
     VALUES ('Falha Ltda', '52998224725', $1, '16999990000', 'x', now(), true) RETURNING *`,
    [para(`conta-${randomUUID().slice(0, 6)}`)],
  );
  contas.push(rows[0].id);
  const assinatura = await assinaturasRepo.criar({ anuncianteId: rows[0].id, planoId: 'essencial-1m' });
  await pool.query("UPDATE assinaturas SET status = 'ativa' WHERE id = $1", [assinatura.id]);
  return { conta: rows[0], assinatura: await assinaturasRepo.buscarPorId(assinatura.id) };
}

test('7. cobrança falhada: webhook E conciliação avisam a MESMA cobrança = 1 e-mail', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const chargeId = `pay_falha_${rodada}`;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('o webhook v2 não consulta o Checkout');
  };
  try {
    await sc.processarWebhookAssinatura({
      versao: 2,
      tipo: 'assinatura',
      evento: 'cobranca_falhou',
      eventoId: `evt_falha_${rodada}`,
      planoId: assinatura.id,
      documento: conta.cpf_cnpj,
      chargeId,
      statusFinanceiro: 'recusado',
      valor: 99,
    });
  } finally {
    globalThis.fetch = original;
  }
  // Conciliação do dia seguinte vê a mesma cobrança recusada.
  globalThis.fetch = async (_url, opcoes) => {
    const pedido = opcoes?.body ? JSON.parse(opcoes.body) : {};
    if (pedido.planoId !== assinatura.id) return { ok: false, status: 404, json: async () => ({}) };
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: 'ativa', ultimaCobranca: { chargeId, status: 'recusado' } }),
    };
  };
  try {
    await conciliarAssinaturas({ apenasContas: [conta.id] });
    await conciliarAssinaturas({ apenasContas: [conta.id] });
  } finally {
    globalThis.fetch = original;
  }
  const { rows } = await pool.query(
    "SELECT chave FROM email_outbox WHERE anunciante_id = $1 AND tipo = 'cobranca_falhou'",
    [conta.id],
  );
  assert.deepStrictEqual(
    rows.map((r) => r.chave),
    [`cobranca_falhou:${chargeId}`],
    'uma linha, chave = o evento de negócio (não a fonte)',
  );
  await processarTudo();
  assert.strictEqual(chegaram(conta.contato_email).length, 1);
});

test('8. cobrança já avisada pela conciliação antiga (marca renovacao|) não é avisada de novo', async () => {
  const { conta, assinatura } = await contaComAssinatura();
  const chargeId = `pay_antiga_${rodada}`;
  await pool.query('INSERT INTO webhooks_processados (id) VALUES ($1)', [`renovacao|${chargeId}`]);
  const r = await sc.avisarCobrancaFalhou(assinatura, conta, chargeId);
  assert.strictEqual(r.novo, false);
  const { rows } = await pool.query('SELECT 1 FROM email_outbox WHERE chave = $1', [`cobranca_falhou:${chargeId}`]);
  assert.strictEqual(rows.length, 0);
});

test('9. e-mail que não entra na fila não quebra quem chamou', async () => {
  const r = await outbox.enfileirarSemFalhar({ tipo: 'tipo_que_nao_existe', chave: 'x', para: 'a@b.c' });
  assert.strictEqual(r, null);
  const semPara = await outbox.enfileirarSemFalhar({ tipo: 'boas_vindas', chave: `sem-para-${rodada}`, para: '' });
  assert.strictEqual(semPara, null);
});

test('10. em teste, SMTP real é bloqueado (sem transporte falso, o envio falha)', async () => {
  email.usarTransporte(null);
  try {
    await assert.rejects(
      email.enviarContaReativada({ nome_empresa: 'X', contato_email: 'nunca@example.com' }),
      /SMTP real bloqueado em teste/,
    );
  } finally {
    email.usarTransporte({
      sendMail: async (m) => {
        if (falharPara.has(m.to)) throw new Error('550');
        enviados.push(m);
        return { messageId: 'falso' };
      },
    });
  }
});

test('11. retenção: mensagem com segredo some em 2 dias; enviada, em 30', async () => {
  const velhoCodigo = `codigo_confirmacao:t11:${rodada}`;
  const velhoEnviado = `boas_vindas:t11:${rodada}`;
  const recente = `boas_vindas:t11b:${rodada}`;
  await pool.query(
    `INSERT INTO email_outbox (chave, tipo, classe, destinatario, status, criado_em, enviado_em)
     VALUES ($1, 'codigo_confirmacao', 'critico', $4, 'enviado', now() - interval '3 days', now() - interval '3 days'),
            ($2, 'boas_vindas', 'operacional', $4, 'enviado', now() - interval '31 days', now() - interval '31 days'),
            ($3, 'boas_vindas', 'operacional', $4, 'enviado', now() - interval '3 days', now() - interval '3 days')`,
    [velhoCodigo, velhoEnviado, recente, para(11)],
  );
  await outbox.expurgar();
  assert.strictEqual(await linha(velhoCodigo), undefined);
  assert.strictEqual(await linha(velhoEnviado), undefined);
  assert.ok(await linha(recente));
});

test('12. criativo aprovado: um aviso só, que fala de aprovação e nunca promete "no ar"', async () => {
  // Mesmo formato que o admin enfileira na transição para 'aprovado'; nenhum
  // proof-of-play existe — aprovado ≠ exibido, e o aviso sai mesmo assim.
  const msg = {
    tipo: 'criativo_aprovado',
    chave: `criativo_aprovado:t12:${rodada}`,
    para: para(12),
    dados: { conta: { nome_empresa: 'Doze' }, criativo: { duracao_segundos: 15 } },
  };
  assert.strictEqual((await outbox.enfileirar(msg)).novo, true);
  assert.strictEqual((await outbox.enfileirar(msg)).novo, false, 'segunda aprovação do mesmo criativo não duplica');
  await processarTudo();
  assert.strictEqual((await linha(msg.chave)).classe, 'operacional');
  const [m, ...resto] = chegaram(para(12));
  assert.strictEqual(resto.length, 0);
  assert.match(m.subject, /aprovado/i);
  for (const corpo of [m.subject, m.text, m.html]) {
    assert.doesNotMatch(corpo, /no ar|começou a rodar|sendo exibid|já entrou na playlist/i);
  }
  assert.ok(m.text.includes('liberado para entrar na programação'), m.text);
  assert.ok(m.text.includes('primeira exibição for confirmada'), 'remete ao painel para o estado real');
  assert.ok(m.text.includes('15 segundos'));
});
