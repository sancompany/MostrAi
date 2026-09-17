const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

// Token de renovação do San Checkout (API.md 7.3 dele, mudança incompatível
// de 16/09/2026). É caminho de dinheiro com falha SILENCIOSA: token que não
// bate não dá erro — o Checkout cria uma assinatura NOVA e não cancela a
// antiga, e o cliente passa a pagar duas.
//
// Por isso o teste não confere o token contra a minha própria fórmula (isso
// só provaria que eu sou consistente comigo mesmo). Ele reimplementa a
// VERIFICAÇÃO do lado do Checkout, copiada de `src/utils/tokenRenovacao.js`
// dele, e confere o token contra ela.
const JANELA_SEGUNDOS = 7 * 24 * 60 * 60;

function tokenValidoNoCheckout(token, apiKey, { contratanteId, planoId, documento }) {
  if (typeof token !== 'string' || !apiKey) return false;
  const ponto = token.indexOf('.');
  if (ponto === -1) return false;
  const tsBruto = token.slice(0, ponto);
  const ts = Number(tsBruto);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > JANELA_SEGUNDOS) return false;
  const esperado = `${tsBruto}.${crypto
    .createHmac('sha256', apiKey)
    .update(`${tsBruto}.${contratanteId}.${planoId}.${documento}`)
    .digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(esperado), Buffer.from(token));
}

const CHAVE = 'chave-de-teste-do-contratante';
const CONTRATANTE = 'mostrai';
function comAmbiente(extra = {}) {
  process.env.SAN_CHECKOUT_KEY = CHAVE;
  process.env.SAN_CHECKOUT_CONTRATANTE_ID = CONTRATANTE;
  process.env.SAN_CHECKOUT_BASE_URL = 'https://checkout.exemplo';
  Object.assign(process.env, extra);
  delete require.cache[require.resolve('../src/financeiro/san-checkout')];
  return require('../src/financeiro/san-checkout');
}

const tokenDoLink = (link) => new URL(link).searchParams.get('renovar');

test('o token que geramos passa na verificação do Checkout', () => {
  const sc = comAmbiente();
  const link = sc.linkRenovarAssinatura('assin-123', '111.444.777-35');
  assert.ok(link, 'com chave e documento, o link tem que existir');
  assert.ok(
    tokenValidoNoCheckout(tokenDoLink(link), CHAVE, {
      contratanteId: CONTRATANTE,
      planoId: 'assin-123',
      // a pop-up do Checkout manda só dígitos — é contra isso que ele confere
      documento: '11144477735',
    }),
    'o Checkout tem que aceitar o token que montamos',
  );
});

// O `limpar()` do projeto PRESERVA letras (CNPJ alfanumérico desde julho/2026);
// a pop-up do Checkout não. Usar o `limpar()` aqui faria o token nunca bater
// pra empresa com letra no CNPJ — e o sintoma seria cobrança dobrada, calada.
test('CNPJ alfanumérico entra no token só com os dígitos, como a pop-up manda', () => {
  const sc = comAmbiente();
  const link = sc.linkRenovarAssinatura('assin-9', '12.ABC.345/01DE-35');
  assert.ok(
    tokenValidoNoCheckout(tokenDoLink(link), CHAVE, {
      contratanteId: CONTRATANTE,
      planoId: 'assin-9',
      documento: '1234501 35'.replace(/\D/g, ''),
    }),
    'o token tem que bater com o documento reduzido a dígitos',
  );
});

test('token de um assinante não serve pra outro, nem pra outra assinatura', () => {
  const sc = comAmbiente();
  const token = tokenDoLink(sc.linkRenovarAssinatura('assin-1', '11144477735'));
  const base = { contratanteId: CONTRATANTE, planoId: 'assin-1', documento: '11144477735' };
  assert.ok(tokenValidoNoCheckout(token, CHAVE, base));
  assert.ok(!tokenValidoNoCheckout(token, CHAVE, { ...base, documento: '52998224725' }), 'outro documento');
  assert.ok(!tokenValidoNoCheckout(token, CHAVE, { ...base, planoId: 'assin-2' }), 'outra assinatura');
  assert.ok(!tokenValidoNoCheckout(token, 'chave-errada', base), 'sem a chave certa não forja');
});

// Sem token o Checkout NÃO recusa: ele cria uma assinatura nova e deixa a
// antiga viva. Mandar o link assim é pior que não mandar link nenhum.
test('sem chave no ambiente, não existe link — nunca um link sem token', () => {
  const sc = comAmbiente();
  process.env.SAN_CHECKOUT_KEY = '';
  assert.strictEqual(sc.linkRenovarAssinatura('assin-1', '11144477735'), null);
});

test('sem documento na conta, não existe link', () => {
  const sc = comAmbiente();
  assert.strictEqual(sc.linkRenovarAssinatura('assin-1', null), null);
  assert.strictEqual(sc.linkRenovarAssinatura('assin-1', '   '), null);
});

// `renovar=1` era o formato antigo. Garante que ninguém volte a ele por
// engano num merge — o teste falha se o literal reaparecer no link.
test('o link nunca volta a usar o formato antigo `renovar=1`', () => {
  const sc = comAmbiente();
  const link = sc.linkRenovarAssinatura('assin-1', '11144477735');
  assert.ok(!link.includes('renovar=1&') && !link.endsWith('renovar=1'), 'formato antigo não pode voltar');
  assert.match(tokenDoLink(link), /^\d+\.[0-9a-f]{64}$/, 'token é "{epoch}.{hmac hex}"');
});

// ---------------------------------------------------------------------------
// Conciliação: a resposta de `consultar-assinatura` tem DUAS metades
// ---------------------------------------------------------------------------
// Até 17/09/2026 a conciliação lia só `ultimaCobranca` e jogava `status` fora.
// Os dois buracos eram de dinheiro, e o primeiro é o pior: a Asaas NÃO manda
// evento de assinatura (o Checkout mediu: zero `SUBSCRIPTION_*` entre os 53
// configurados), então esta rota é o único caminho pelo qual "cancelada por
// fora" chega até nós.
const { decidirPorEstado } = require('../src/financeiro/conciliacao');

const cobranca = (status, chargeId = 'pay_1') => ({ status, chargeId });

test('assinatura cancelada fora do nosso fluxo é detectada e cancelada aqui', () => {
  const d = decidirPorEstado({ status: 'cancelada', ultimaCobranca: cobranca('confirmado') });
  assert.strictEqual(d.acao, 'vinculo_encerrado');
  assert.strictEqual(d.cancelar, true);
});

// O vínculo vem antes do ciclo de propósito: assinatura encerrada não tem
// ciclo a creditar, por mais confirmada que a última cobrança dela esteja —
// e era exatamente esse par que o código antigo lia ao contrário.
test('vínculo encerrado vence a última cobrança confirmada', () => {
  assert.strictEqual(
    decidirPorEstado({ status: 'cancelada', ultimaCobranca: cobranca('confirmado') }).acao,
    'vinculo_encerrado',
  );
  assert.strictEqual(
    decidirPorEstado({ status: 'pausada', ultimaCobranca: cobranca('confirmado') }).acao,
    'vinculo_encerrado',
  );
});

// `pausada` não tem estado local (a tabela só aceita ativa/cancelada), então
// ela é registrada mas NÃO derruba o registro.
test('pausada é registrada sem cancelar o registro local', () => {
  const d = decidirPorEstado({ status: 'pausada', ultimaCobranca: null });
  assert.strictEqual(d.acao, 'vinculo_encerrado');
  assert.strictEqual(d.cancelar, false);
  assert.strictEqual(d.status, 'pausada');
});

test('vínculo ativo com ciclo confirmado credita o ciclo, como antes', () => {
  const d = decidirPorEstado({ status: 'ativa', ultimaCobranca: cobranca('confirmado', 'pay_9') });
  assert.strictEqual(d.acao, 'aplicar_ciclo');
  assert.strictEqual(d.ultima.chargeId, 'pay_9');
});

// Este é o caso que a skill do Checkout nomeia: vínculo vivo, último ciclo
// falhado. É quem precisa do link de renovação — e quem passava despercebido
// quando o webhook `cobranca_falhou` se perdia na fila em memória.
test('vínculo ativo com ciclo vencido ou recusado pede o aviso de renovação', () => {
  for (const s of ['vencido', 'recusado']) {
    assert.strictEqual(decidirPorEstado({ status: 'ativa', ultimaCobranca: cobranca(s) }).acao, 'avisar_renovacao', s);
  }
});

// Cobrança ainda em aberto não é falha: avisar aqui mandaria o cliente trocar
// um cartão que ainda pode passar.
test('cobrança pendente ou em análise não vira aviso de renovação', () => {
  for (const s of ['pendente', 'em_analise']) {
    assert.strictEqual(decidirPorEstado({ status: 'ativa', ultimaCobranca: cobranca(s) }).acao, 'nada', s);
  }
});

test('sem chargeId não decide nada — nunca inventa chave de dedupe', () => {
  assert.strictEqual(decidirPorEstado({ status: 'ativa', ultimaCobranca: { status: 'vencido' } }).acao, 'nada');
  assert.strictEqual(decidirPorEstado({ status: 'ativa', ultimaCobranca: { status: 'confirmado' } }).acao, 'nada');
});

// 404 do Checkout devolve null. Não é "cancelada": é "não sei", e tratar como
// cancelamento tiraria do ar quem está pagando por causa de uma instabilidade.
test('sem resposta não vira cancelamento', () => {
  assert.strictEqual(decidirPorEstado(null).acao, 'sem_resposta');
  assert.strictEqual(decidirPorEstado(undefined).acao, 'sem_resposta');
});

// Status desconhecido (o Checkout promete ADICIONAR valores novos) não pode
// virar erro nem ser ignorado: é vínculo que não está ativo, e fica visível.
test('status novo que o Checkout invente não é ignorado nem quebra', () => {
  const d = decidirPorEstado({ status: 'inadimplente', ultimaCobranca: cobranca('confirmado') });
  assert.strictEqual(d.acao, 'vinculo_encerrado');
  assert.strictEqual(d.cancelar, false, 'status desconhecido não cancela o registro por conta própria');
});
