require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');

// A OBRIGAÇÃO DE VEICULAÇÃO NASCE DO CICLO CONTRATADO (01/10/2026, correção
// estrutural achada na auditoria Review-Master — migration 111). Os números
// (§37 do pedido do dono) estão no nome de cada teste.
//
// Antes: a obrigação nascia por TELA e por hora aberta — com a rede vazia,
// quem comprava um Pro pagava, recebia 0 h, devia-se 0 h e via "Em dia".
process.env.SAN_CHECKOUT_KEY = process.env.SAN_CHECKOUT_KEY || 'chave-teste';
process.env.SAN_CHECKOUT_API_URL = process.env.SAN_CHECKOUT_API_URL || 'https://checkout.exemplo';
const pool = require('../src/db/pool');
const sc = require('../src/financeiro/san-checkout');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const dispositivosRepo = require('../src/dispositivos/repository');
const planoAdministrativo = require('../src/financeiro/plano-administrativo');
const gerador = require('../src/playlist/gerador');
const { confirmarComDedup } = require('../src/playlist/execucoes-repository');
const obrigacao = require('../src/bancohoras/obrigacao-do-ciclo');
const { instalarPlayer } = require('./apoio-player');
const { fimDaCobertura } = require('../src/lib/vigencia');

const H = 3600;
const DIA = 86_400_000;

// ===========================================================================
// 1. A conta (função pura `calcularSaldo`)
// ===========================================================================
const T0 = new Date('2026-08-01T03:00:00Z').getTime();
const em = (dias) => new Date(T0 + dias * DIA);
let seq = 1;
const lote = (segundos, { inicio = 0, dias = 30, tipo = 'ciclo', criado = inicio } = {}) => ({
  id: seq++,
  tipo,
  segundos,
  inicio: em(inicio),
  fim: em(inicio + dias),
  criado_em: em(criado),
  motivo: `${tipo} de teste`,
});
const reembolso = (alvo, quando) => ({
  id: seq++,
  tipo: 'reembolso',
  segundos: -alvo.segundos,
  referencia_id: alvo.id,
  inicio: alvo.inicio,
  fim: alvo.fim,
  criado_em: em(quando),
});
const entrega = (dia, segundos) => ({ dia: em(dia), entregue: segundos, basico: 0 });
const saldo = (lancamentos, dias = [], agora = em(400), indisponibilidades = []) =>
  obrigacao.calcularSaldo({ lancamentos, dias, agora, indisponibilidades });

test('§7 nenhuma entrega: Pro contratado = 84 h devidas, 0 entregue', () => {
  const s = saldo([lote(84 * H)], [], em(1));
  assert.strictEqual(s.devidoSegundos, 84 * H);
  assert.strictEqual(s.entregueSegundos, 0);
  assert.strictEqual(s.saldoSegundos, 84 * H);
});

test('§6 entrega parcial: 30 h confirmadas de 84 h → 54 h a entregar', () => {
  const s = saldo([lote(84 * H)], [entrega(10, 30 * H)]);
  assert.strictEqual(s.entregueSegundos, 30 * H);
  assert.strictEqual(s.saldoSegundos, 54 * H);
});

test('§8 renovação com saldo zero: o ciclo novo começa com as 84 h dele', () => {
  const s = saldo([lote(84 * H), lote(84 * H, { inicio: 30 })], [entrega(20, 84 * H)], em(31));
  assert.strictEqual(s.saldoSegundos, 84 * H);
  assert.strictEqual(s.saldoAnteriorSegundos, 0);
  assert.strictEqual(s.cicloAtual.contratadoSegundos, 84 * H);
});

test('§9/§29 renovação com saldo positivo ACUMULA: 54 h + 84 h = 138 h', () => {
  const s = saldo([lote(84 * H), lote(84 * H, { inicio: 30 })], [entrega(20, 30 * H)], em(31));
  assert.strictEqual(s.saldoSegundos, 138 * H);
  assert.strictEqual(s.saldoAnteriorSegundos, 54 * H, 'a dívida anterior não some dentro do ciclo atual');
  assert.strictEqual(s.cicloAtual.pendenteSegundos, 84 * H);
});

test('§9 renovação paga adiantada: soma já, mas não é "saldo anterior" (o lote ainda vai começar)', () => {
  const s = saldo([lote(84 * H), lote(84 * H, { inicio: 30, criado: 10 })], [entrega(5, 20 * H)], em(11));
  assert.strictEqual(s.saldoSegundos, 148 * H, '64 h do ciclo em curso + 84 h do próximo');
  assert.strictEqual(s.cicloAtual.pendenteSegundos, 64 * H);
  assert.strictEqual(s.saldoAnteriorSegundos, 0);
});

test('§10 duas renovações seguidas sem capacidade: 84 + 84 + 84 = 252 h', () => {
  const s = saldo([lote(84 * H), lote(84 * H, { inicio: 30 }), lote(84 * H, { inicio: 60 })], [], em(61));
  assert.strictEqual(s.saldoSegundos, 252 * H);
});

test('§30 entrega acima do ciclo atual recupera saldo anterior (não é overdelivery)', () => {
  const s = saldo([lote(50 * H), lote(84 * H, { inicio: 30 })], [entrega(40, 100 * H)], em(41));
  assert.strictEqual(s.saldoSegundos, 34 * H);
  assert.strictEqual(s.excedenteSegundos, 0, '100 h > 84 h do ciclo atual, mas < 134 h devidas');
});

test('§25/§31 overdelivery até 45 min é bônus: não reduz o ciclo seguinte', () => {
  const um = lote(27 * H);
  let s = saldo([um], [entrega(20, 27 * H + 12 * 60)], em(29));
  assert.strictEqual(s.saldoSegundos, 0);
  assert.strictEqual(s.excedenteSegundos, 12 * 60);
  assert.deepStrictEqual(s.anomalias, [], 'até 45 min não é anomalia');
  s = saldo([um, lote(27 * H, { inicio: 30 })], [entrega(20, 27 * H + 12 * 60)], em(31));
  assert.strictEqual(s.saldoSegundos, 27 * H, 'os 12 min de bônus não descontam do ciclo novo');
});

test('§31 excedente acima de 45 min vira anomalia (alerta interno), sem compensação', () => {
  const um = lote(27 * H);
  const s = saldo([um, lote(27 * H, { inicio: 30 })], [entrega(20, 28 * H)], em(31));
  assert.deepStrictEqual(s.anomalias, [{ loteId: um.id, excedenteSegundos: H }]);
  assert.strictEqual(s.saldoSegundos, 27 * H, 'nada é descontado do ciclo seguinte');
});

test('§23/§32 reembolso integral depois de 2 h entregues: saldo técnico −2 h; recontratação começa em 25 h', () => {
  const um = lote(27 * H);
  let s = saldo([um, reembolso(um, 5)], [entrega(3, 2 * H)], em(6));
  assert.strictEqual(s.saldoSegundos, -2 * H);
  assert.strictEqual(s.negativoTecnicoSegundos, 2 * H);
  assert.strictEqual(s.pendenteSegundos, 0, 'o ciclo reembolsado some');
  s = saldo([um, reembolso(um, 5), lote(27 * H, { inicio: 40 })], [entrega(3, 2 * H)], em(41));
  assert.strictEqual(s.saldoSegundos, 25 * H, 'exemplo da spec: recebeu 2 h, reembolso, contrata 27 h → 25 h');
  assert.strictEqual(s.negativoTecnicoSegundos, 0);
  // O que o cliente vê fecha a conta: 27 h contratadas − 2 h entregues = 25 h.
  assert.strictEqual(s.devidoSegundos, 27 * H);
  assert.strictEqual(s.entregueSegundos, 2 * H);
});

test('§23 reembolso no meio de um dia com entrega: o que o dia entregou vira negativo técnico, não bônus', () => {
  const um = lote(27 * H);
  const s = saldo([um, reembolso(um, 3.5)], [entrega(3, 2 * H)], em(4));
  assert.strictEqual(s.negativoTecnicoSegundos, 2 * H);
  assert.strictEqual(s.excedenteSegundos, 0);
});

test('§23 reembolso integral sem entrega: o ciclo some, sem negativo', () => {
  const um = lote(27 * H);
  const s = saldo([um, reembolso(um, 2)], [], em(3));
  assert.strictEqual(s.saldoSegundos, 0);
  assert.strictEqual(s.negativoTecnicoSegundos, 0);
});

test('§15/§16 campanha indisponível por responsabilidade do cliente 15 de 30 dias: deve só metade', () => {
  const um = lote(84 * H);
  const janela = [{ inicio: em(10), fim: em(25) }];
  const s = saldo([um], [], em(31), janela);
  assert.strictEqual(s.devidoSegundos, 42 * H);
  assert.strictEqual(s.saldoSegundos, 42 * H);
});

test('§16 indisponibilidade depois de tudo entregue não cria dívida do cliente', () => {
  const s = saldo([lote(84 * H)], [entrega(5, 84 * H)], em(31), [{ inicio: em(10), fim: em(30) }]);
  assert.strictEqual(s.saldoSegundos, 0);
  assert.strictEqual(s.negativoTecnicoSegundos, 0);
});

test('§24 troca: subida soma a diferença; rebaixamento reduz o lote em curso e nunca fica negativo', () => {
  const pro = lote(84 * H);
  const subida = lote(48 * H, { inicio: 15, dias: 15, tipo: 'troca' });
  assert.strictEqual(saldo([pro, subida], [], em(16)).saldoSegundos, 132 * H);
  const prime = lote(180 * H);
  const desce = { ...lote(0, { inicio: 15, dias: 15, tipo: 'troca' }), segundos: -76.5 * H, referencia_id: prime.id };
  assert.strictEqual(saldo([prime, desce], [], em(16)).saldoSegundos, 103.5 * H);
  const quaseTudo = saldo([prime, desce], [entrega(10, 170 * H)], em(16));
  assert.strictEqual(quaseTudo.saldoSegundos, 0, 'entregue além do que o rebaixamento deixou: bônus, não dívida');
  assert.strictEqual(quaseTudo.negativoTecnicoSegundos, 0);
  assert.strictEqual(quaseTudo.devidoSegundos, 170 * H, 'o rebaixamento só tira o que ainda faltava (10 h)');
  assert.strictEqual(quaseTudo.entregueSegundos, 170 * H);
});

test('§24 duas trocas no mesmo ciclo (Pro → Prime → Essencial): o rebaixamento alcança o lote do Pro', () => {
  const pro = lote(84 * H);
  // Dia 10: Pro → Prime (+96 h/mês × 20 dias ÷ 30 = 64 h).
  const sobe = lote(64 * H, { inicio: 10, dias: 20, tipo: 'troca' });
  // Dia 20: Prime → Essencial (−153 h/mês × 10 dias ÷ 30 = −51 h), referenciando o lote mais novo.
  const desce = {
    ...lote(0, { inicio: 20, dias: 10, tipo: 'troca' }),
    segundos: -51 * H,
    referencia_id: sobe.id,
  };
  const s = saldo([pro, sobe, desce], [], em(21));
  assert.strictEqual(s.saldoSegundos, (84 + 64 - 51) * H, 'os 51 h saem inteiros, não só os 64 h da subida');
  assert.strictEqual(s.devidoSegundos, 97 * H);
  sobe.plano_id = 'maximo-1m';
  desce.plano_id = 'essencial-1m';
  assert.strictEqual(
    saldo([pro, sobe, desce], [], em(21)).cicloAtual.planoId,
    'essencial-1m',
    'o rebaixamento é o plano em vigor',
  );
});

test('troca é ajuste do ciclo: o "ciclo atual" soma ciclo + troca; nada vira "ciclos anteriores"', () => {
  const pro = lote(84 * H);
  const sobe = lote(48 * H, { inicio: 15, dias: 15, tipo: 'troca' });
  sobe.plano_id = 'maximo-1m';
  const s = saldo([pro, sobe], [], em(16));
  assert.strictEqual(s.cicloAtual.tipo, 'ciclo');
  assert.strictEqual(s.cicloAtual.contratadoSegundos, 132 * H);
  assert.strictEqual(s.cicloAtual.planoId, 'maximo-1m', 'o plano do ciclo é o da troca mais recente');
  assert.strictEqual(s.saldoAnteriorSegundos, 0);
});

test('ritmo: tempo fora por culpa do cliente não vira atraso (metade do ciclo sem peça)', () => {
  const um = lote(84 * H);
  const janela = [{ inicio: em(0), fim: em(15) }];
  const s = saldo([um], [], em(15), janela);
  assert.strictEqual(s.saldoSegundos, 42 * H, 'deve metade');
  assert.strictEqual(s.atrasoSegundos, 0, 'nada atrasado: o tempo que passou foi do cliente');
  const depois = saldo([um], [], em(22.5), janela);
  assert.strictEqual(depois.atrasoSegundos, 21 * H, 'metade do tempo disponível passou sem entrega');
});

test('ritmo: no começo do ciclo nada está atrasado; na metade sem entrega, metade está', () => {
  const um = lote(84 * H);
  assert.strictEqual(saldo([um], [], em(0)).atrasoSegundos, 0);
  assert.strictEqual(saldo([um], [], em(15)).atrasoSegundos, 42 * H);
  assert.strictEqual(saldo([um], [entrega(10, 30 * H)], em(15)).atrasoSegundos, 12 * H);
});

test('Plano Básico (benefício da tela) entra no mesmo saldo: obrigação do dia, paga por FIFO', () => {
  const s = obrigacao.calcularSaldo({
    lancamentos: [lote(27 * H)],
    dias: [{ dia: em(2), basico: 2 * H, entregue: 10 * H }],
    agora: em(3),
  });
  assert.strictEqual(s.devidoSegundos, 29 * H);
  assert.strictEqual(s.saldoSegundos, 19 * H);
});

// ===========================================================================
// 2. Pela porta de verdade: webhook, rotas, gerador, Proof-of-Play
// ===========================================================================
const criados = { contas: [], pontos: [] };
test.after(async () => {
  await require('../src/lib/eventos').aguardarGravacoes();
  for (const pontoId of criados.pontos) {
    const telas = 'SELECT id FROM dispositivos WHERE ponto_id = $1';
    await pool.query(`DELETE FROM execucoes_confirmadas WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM midias_exibicoes_contador WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query(`DELETE FROM playlist_hora_congelada WHERE dispositivo_id IN (${telas})`, [pontoId]);
    await pool.query('DELETE FROM anunciantes_pontos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM creditos_ledger WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM beneficios_basico_ponto WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM dispositivos WHERE ponto_id = $1', [pontoId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
  for (const id of criados.contas) {
    await pool.query(
      "DELETE FROM eventos_assinatura_pendentes WHERE payload->>'planoId' IN (SELECT id FROM assinaturas WHERE anunciante_id = $1)",
      [id],
    );
    for (const t of [
      'exibicoes_contador',
      'anunciantes_pontos',
      'eventos',
      'notificacoes',
      'creditos_ledger',
      'criativos',
      'pendencias',
      'arrependimentos',
    ]) {
      await pool.query(`DELETE FROM ${t} WHERE anunciante_id = $1`, [id]).catch(() => {});
    }
    await pool.query('DELETE FROM obrigacoes_veiculacao WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM ciclos_contratados WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM planos_administrativos WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
  }
  await pool.end();
});

async function novaConta({ criativo = true, duracao = 15 } = {}) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Obrigação ${randomUUID().slice(0, 8)}`,
    cpf_cnpj: '52998224725',
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `obrigacao-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  criados.contas.push(conta.id);
  let criativoId = null;
  if (criativo) {
    const c = await criativosRepo.criar({
      anunciante_id: conta.id,
      arquivo_original_url: 'original.mp4',
      arquivo_normalizado_url: `https://exemplo.test/obrigacao-${randomUUID()}.mp4`,
      thumbnail_url: null,
      duracao_segundos: duracao,
    });
    await criativosRepo.atualizar(c.id, { status: 'aprovado' });
    criativoId = c.id;
  }
  return { ...(await anunciantesRepo.buscarPorId(conta.id)), criativoId };
}

function semCheckout() {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    throw new Error(`o webhook v2 não deveria consultar o checkout: ${url}`);
  };
  return () => {
    globalThis.fetch = original;
  };
}

const eventoV2 = (assinatura, conta, extras) => ({
  versao: 2,
  tipo: 'assinatura',
  eventoId: `evt_${randomUUID()}`,
  ocorridoEm: new Date().toISOString(),
  planoId: assinatura.id,
  documento: conta.cpf_cnpj,
  assinaturaId: `sub_${randomUUID().slice(0, 8)}`,
  statusFinanceiro: 'confirmado',
  ciclo: 'MONTHLY',
  cicloCanonico: 'mensal',
  metodoPagamento: 'assinatura',
  valorEstornado: null,
  estornoParcial: false,
  chargeId: `pay_${randomUUID().slice(0, 8)}`,
  valor: 100,
  ...extras,
});

async function processar(evento) {
  const restaurar = semCheckout();
  try {
    await sc.processarWebhookAssinatura(evento);
  } finally {
    restaurar();
  }
}

// Compra paga pelo caminho real: assinatura → webhook v2 `criada`.
async function comprar(conta, planoId) {
  const assinatura = await assinaturasRepo.criar({ anuncianteId: conta.id, planoId });
  const evento = eventoV2(assinatura, conta, { evento: 'criada' });
  await processar(evento);
  return { assinatura, evento };
}

const lancamentos = async (contaId) =>
  (await pool.query('SELECT * FROM obrigacoes_veiculacao WHERE anunciante_id = $1 ORDER BY id', [contaId])).rows;
const planoDb = async (id) => (await pool.query('SELECT * FROM planos WHERE id = $1', [id])).rows[0];

// Ponto 24 h (sem horário) em operação, com uma tela, fora do sorteio.
async function novoPonto() {
  const { rows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, escolha_bloqueada_em)
     VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', now()) RETURNING id`,
    [`Obrigação ${randomUUID().slice(0, 8)}`],
  );
  const pontoId = rows[0].id;
  criados.pontos.push(pontoId);
  const tela = await dispositivosRepo.criar(pontoId, {});
  await instalarPlayer(tela.id);
  return { pontoId, telaId: tela.id };
}
const escolher = (contaId, pontoId) =>
  pool.query(
    'INSERT INTO anunciantes_pontos (anunciante_id, ponto_id, escolhido_em) VALUES ($1, $2, clock_timestamp())',
    [contaId, pontoId],
  );

test('§1/§27 compra Pro com a rede vazia: plano ativo, 84 h devidas, 0 entregue, venda não bloqueada', async () => {
  const conta = await novaConta();
  const { assinatura } = await comprar(conta, 'destaque-1m');
  assert.strictEqual((await assinaturasRepo.buscarPorId(assinatura.id)).status, 'ativa', 'plano comprado e ativo');
  const depois = await anunciantesRepo.buscarPorId(conta.id);
  assert.strictEqual(depois.plano_id, 'destaque-1m');
  const [l] = await lancamentos(conta.id);
  assert.strictEqual(l.tipo, 'ciclo');
  assert.strictEqual(
    Number(l.segundos),
    84 * H,
    'Pro = 84 h, lido do próprio plano (120 s/h × 7 pontos × 12 h × 30 dias)',
  );
  assert.strictEqual(
    Number(l.segundos),
    obrigacao.segundosPorMesDoPlano(await planoDb('destaque-1m')),
    'fonte = o plano, não número fixo',
  );
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.saldoSegundos, 84 * H);
  assert.strictEqual(s.entregueSegundos, 0);
  assert.strictEqual(s.devidoSegundos, 84 * H);
});

test('§2/§28 Essencial com 3 pontos cadastrados aguardando instalação (0 telas): 27 h, nada conta como entrega', async () => {
  const dono = await novaConta({ criativo: false });
  for (let i = 0; i < 3; i++) {
    const { rows } = await pool.query(
      `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
       VALUES ($1, 'R', 'Matão', 'SP', '1', 'outro', 'R', '1', $2, 'a_instalar') RETURNING id`,
      [`A instalar ${randomUUID().slice(0, 6)}`, dono.id],
    );
    criados.pontos.push(rows[0].id);
  }
  const conta = await novaConta();
  await comprar(conta, 'essencial-1m');
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.devidoSegundos, 27 * H);
  assert.strictEqual(s.saldoSegundos, 27 * H);
});

test('§3/§4/§5 a obrigação não depende de quantos pontos existem: 1 ponto no ar ou nenhum, Pro = 84 h', async () => {
  const conta = await novaConta();
  const ponto = await novoPonto();
  await escolher(conta.id, ponto.pontoId);
  await comprar(conta, 'destaque-1m');
  assert.strictEqual((await obrigacao.saldoDaConta(conta.id)).devidoSegundos, 84 * H, 'Pro com 1 de 7 pontos: 84 h');
});

test('§13/§14/§9 webhook repetido e retry não duplicam; ciclo novo acumula (84 + 84)', async () => {
  const conta = await novaConta();
  const { assinatura, evento } = await comprar(conta, 'destaque-1m');
  await processar({ ...evento }); // mesmo eventoId
  await processar({ ...evento, eventoId: `evt_${randomUUID()}` }); // retry com o mesmo chargeId
  assert.strictEqual((await lancamentos(conta.id)).length, 1, 'uma cobrança, uma obrigação');
  const [compra] = await lancamentos(conta.id);
  assert.ok(
    new Date(compra.inicio) <= new Date(),
    'a compra vale desde já (o último dia inclusivo não a empurra pra amanhã)',
  );
  await processar(eventoV2(assinatura, conta, { evento: 'cobranca_confirmada' })); // renovação
  const ls = await lancamentos(conta.id);
  assert.strictEqual(ls.length, 2);
  assert.strictEqual(
    new Date(ls[1].inicio).getTime(),
    new Date(compra.fim).getTime(),
    'a renovação começa no fim da compra',
  );
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.saldoSegundos, 168 * H, 'renovação ACRESCENTA');
  assert.strictEqual(s.cicloAtual.pendenteSegundos, 84 * H, 'o ciclo atual continua o da compra');
  assert.strictEqual(s.saldoAnteriorSegundos, 0);
});

test('§26 concorrência: dois processos registrando o mesmo ciclo gravam uma obrigação só', async () => {
  const conta = await novaConta();
  await comprar(conta, 'essencial-1m');
  const { rows: ciclos } = await pool.query('SELECT * FROM ciclos_contratados WHERE anunciante_id = $1', [conta.id]);
  const plano = await planoDb('essencial-1m');
  const resultados = await Promise.all(
    [1, 2, 3].map(() => obrigacao.registrarCiclo(pool, { anuncianteId: conta.id, plano, ciclo: ciclos[0] })),
  );
  assert.ok(
    resultados.every((r) => r === null),
    'o fato já estava registrado: ninguém soma',
  );
  assert.strictEqual((await lancamentos(conta.id)).length, 1);
});

test('§11/§12/§21 Proof-of-Play confirmado abate; o mesmo POP duas vezes abate uma vez', async () => {
  const conta = await novaConta({ duracao: 15 });
  const ponto = await novoPonto();
  await escolher(conta.id, ponto.pontoId);
  await comprar(conta, 'destaque-1m');
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  const playlist = await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(ponto.telaId), hora);
  const meus = playlist.itens.filter((i) => i.anuncianteId === conta.id);
  assert.ok(meus.length >= 2, 'a capacidade voltou: o gerador programa a conta');
  assert.strictEqual((await obrigacao.saldoDaConta(conta.id)).saldoSegundos, 84 * H, 'programar não abate');
  const execucaoId = randomUUID();
  const pop = { execucaoId, janelaId: playlist.janelaId, itemProgramacaoId: meus[0].itemProgramacaoId };
  assert.strictEqual((await confirmarComDedup(ponto.telaId, pop, new Date())).status, 'contabilizado');
  await confirmarComDedup(ponto.telaId, pop, new Date()); // repetido
  await confirmarComDedup(
    ponto.telaId,
    { execucaoId: randomUUID(), janelaId: playlist.janelaId, itemProgramacaoId: meus[1].itemProgramacaoId },
    new Date(),
  );
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.entregueSegundos, 30, 'duas exibições de 15 s, não três');
  assert.strictEqual(s.saldoSegundos, 84 * H - 30);
});

test('§18/§19/§20 ponto fechado, tela offline, rede sem capacidade: a obrigação não muda (nem some, nem cresce)', async () => {
  const conta = await novaConta();
  const ponto = await novoPonto();
  await escolher(conta.id, ponto.pontoId);
  await comprar(conta, 'essencial-1m');
  await pool.query(`UPDATE pontos SET horario_semanal = $2 WHERE id = $1`, [
    ponto.pontoId,
    JSON.stringify({ seg: null, ter: null, qua: null, qui: null, sex: null, sab: null, dom: null }),
  ]);
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(ponto.telaId), hora); // fechado
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.devidoSegundos, 27 * H, 'o ponto fechado não cria nem apaga dívida');
  assert.strictEqual(s.saldoSegundos, 27 * H, 'e sem Proof-of-Play nada é abatido');
});

test('§15 compra sem criativo: a janela de indisponibilidade do cliente abre; aprovar fecha; o tempo fora sai da dívida', async () => {
  const conta = await novaConta({ criativo: false });
  await comprar(conta, 'destaque-1m');
  let { rows: janelas } = await pool.query('SELECT * FROM indisponibilidade_cliente WHERE anunciante_id = $1', [
    conta.id,
  ]);
  assert.strictEqual(janelas.length, 1);
  assert.strictEqual(janelas[0].motivo, 'sem_criativo_disponivel');
  assert.strictEqual(janelas[0].fim, null);
  // O cliente envia a peça: a análise é da Mostraí — a janela do cliente fecha
  // já no envio, não na aprovação.
  const c = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'o.mp4',
    arquivo_normalizado_url: `https://exemplo.test/${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: 15,
  });
  await obrigacao.avaliarDisponibilidade(conta.id);
  ({ rows: janelas } = await pool.query('SELECT * FROM indisponibilidade_cliente WHERE anunciante_id = $1', [
    conta.id,
  ]));
  assert.ok(janelas[0].fim, 'peça em análise da Mostraí: o tempo volta a ser dívida dela');
  // Recusada (e nenhuma outra): de novo sem peça válida — janela nova do cliente.
  await criativosRepo.atualizar(c.id, { status: 'reprovado' });
  await obrigacao.avaliarDisponibilidade(conta.id);
  ({ rows: janelas } = await pool.query(
    'SELECT * FROM indisponibilidade_cliente WHERE anunciante_id = $1 AND fim IS NULL',
    [conta.id],
  ));
  assert.strictEqual(janelas.length, 1, 'peça recusada: sem peça válida, tempo do cliente');
  await criativosRepo.atualizar(c.id, { status: 'aprovado' });
  await obrigacao.avaliarDisponibilidade(conta.id);
  ({ rows: janelas } = await pool.query(
    'SELECT * FROM indisponibilidade_cliente WHERE anunciante_id = $1 AND fim IS NULL',
    [conta.id],
  ));
  assert.strictEqual(janelas.length, 0, 'criativo aprovado fecha a janela');
  // A conta abaixo usa uma janela só: a primeira, esticada pra metade do ciclo.
  await pool.query(
    'DELETE FROM indisponibilidade_cliente WHERE anunciante_id = $1 AND id <> (SELECT min(id) FROM indisponibilidade_cliente WHERE anunciante_id = $1)',
    [conta.id],
  );
  // Metade do período do ciclo sem criativo: deve metade.
  const [l] = await lancamentos(conta.id);
  const meio = new Date((new Date(l.inicio).getTime() + new Date(l.fim).getTime()) / 2);
  await pool.query('UPDATE indisponibilidade_cliente SET inicio = $2, fim = $3 WHERE anunciante_id = $1', [
    conta.id,
    l.inicio,
    meio,
  ]);
  const s = await obrigacao.saldoDaConta(conta.id, { agora: new Date(new Date(l.fim).getTime() + DIA) });
  assert.ok(Math.abs(s.devidoSegundos - 42 * H) <= 1, `metade das 84 h (${s.devidoSegundos})`);
});

// Rotas do anunciante montadas com sessão de teste (cabeçalho x-conta).
function appDoAnunciante() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-obrigacao', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use(require('../src/bancohoras/routes'));
  return app;
}
async function comServidor(fn) {
  const server = appDoAnunciante().listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('§16 cliente pausa todas as peças: tempo dele (janela "pausado_pelo_cliente"); retomar fecha', async () => {
  const conta = await novaConta();
  await comprar(conta, 'essencial-1m');
  await comServidor(async (base) => {
    const post = (caminho) => fetch(base + caminho, { method: 'POST', headers: { 'x-conta': String(conta.id) } });
    assert.strictEqual((await post(`/anunciantes/me/criativos/${conta.criativoId}/pausar`)).status, 200);
    let { rows } = await pool.query('SELECT * FROM indisponibilidade_cliente WHERE anunciante_id = $1', [conta.id]);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].motivo, 'pausado_pelo_cliente');
    assert.strictEqual((await post(`/anunciantes/me/criativos/${conta.criativoId}/retomar`)).status, 200);
    ({ rows } = await pool.query('SELECT * FROM indisponibilidade_cliente WHERE anunciante_id = $1', [conta.id]));
    assert.ok(rows[0].fim, 'retomou: a campanha voltou, a janela fecha');
  });
});

test('§17 Mostraí (admin) retira a peça: a dívida continua dela — nenhuma janela do cliente', async () => {
  const conta = await novaConta();
  await comprar(conta, 'essencial-1m');
  await pool.query(`UPDATE criativos SET status = 'retirado', retirado_por = 'admin' WHERE id = $1`, [
    conta.criativoId,
  ]);
  await obrigacao.avaliarDisponibilidade(conta.id);
  const { rows } = await pool.query('SELECT * FROM indisponibilidade_cliente WHERE anunciante_id = $1', [conta.id]);
  assert.strictEqual(rows.length, 0);
  assert.strictEqual((await obrigacao.saldoDaConta(conta.id)).saldoSegundos, 27 * H);
});

test('§22 cancelamento com saldo: a dívida sobrevive ao fim do plano e o gerador continua entregando (só o saldo)', async () => {
  const conta = await novaConta({ duracao: 15 });
  const ponto = await novoPonto();
  await escolher(conta.id, ponto.pontoId);
  const { assinatura } = await comprar(conta, 'essencial-1m');
  // Cancelou e o ciclo acabou sem nada entregue (rede sem capacidade no período).
  await pool.query(`UPDATE assinaturas SET status = 'cancelada' WHERE id = $1`, [assinatura.id]);
  await pool.query(
    `UPDATE obrigacoes_veiculacao SET inicio = now() - interval '40 days', fim = now() - interval '10 days',
            criado_em = now() - interval '40 days' WHERE anunciante_id = $1`,
    [conta.id],
  );
  await pool.query(`UPDATE anunciantes SET data_expiracao = now() - interval '10 days' WHERE id = $1`, [conta.id]);
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.saldoSegundos, 27 * H, 'cancelar não apaga o que foi contratado');
  assert.strictEqual(s.atrasoSegundos, 27 * H, 'e todo ele está atrasado');
  const hora = new Date();
  hora.setMinutes(0, 0, 0);
  await gerador.gerarPlaylistDaHora(await dispositivosRepo.buscarComPonto(ponto.telaId), hora);
  const { rows } = await pool.query(
    'SELECT vezes_programadas, vezes_banco FROM exibicoes_contador WHERE anunciante_id = $1 AND dispositivo_id = $2',
    [conta.id, ponto.telaId],
  );
  assert.strictEqual(rows.length, 1, 'plano vencido com saldo continua no ar');
  assert.ok(rows[0].vezes_banco > 0, 'só pela devolução do saldo (capacidade ociosa)');
  assert.strictEqual(rows[0].vezes_programadas, rows[0].vezes_banco, 'sem base nem compensação de plano vencido');
});

test('§23 reembolso (arrependimento): ciclo some; cliente vê 0; o negativo técnico desconta a recontratação', async () => {
  const conta = await novaConta();
  await comprar(conta, 'essencial-1m');
  // Já tinham sido entregues 2 h desse ciclo.
  const ponto = await novoPonto();
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas,
                                     vezes_confirmadas, duracao_segundos)
     VALUES ($1, $2, date_trunc('hour', now()), 480, 480, 480, 15)`,
    [conta.id, ponto.telaId],
  );
  await obrigacao.registrarReembolsoDaConta(pool, { anuncianteId: conta.id, motivo: 'teste de reembolso' });
  await obrigacao.registrarReembolsoDaConta(pool, { anuncianteId: conta.id, motivo: 'repetido' });
  const ls = await lancamentos(conta.id);
  assert.strictEqual(ls.filter((l) => l.tipo === 'reembolso').length, 1, 'reembolso idempotente');
  let s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.negativoTecnicoSegundos, 2 * H);
  await comServidor(async (base) => {
    const r = await fetch(`${base}/anunciantes/me/banco-horas`, { headers: { 'x-conta': String(conta.id) } });
    const corpo = await r.json();
    assert.strictEqual(corpo.segundos, 0, 'o cliente nunca vê "você deve"');
  });
  // Recontrata (no mesmo dia, o caso mais apertado da ordem): a nova
  // obrigação já vem descontada. Dias diferentes: teste puro de §23 acima.
  await comprar(conta, 'essencial-1m');
  s = await obrigacao.saldoDaConta(conta.id);
  assert.strictEqual(s.saldoSegundos, 25 * H, '27 h − 2 h já recebidas de graça');
});

test('§23/§13 reembolso que não chegou a ser lançado: a conciliação lança, uma vez, só o que veio antes do pedido', async () => {
  const conta = await novaConta();
  await comprar(conta, 'essencial-1m');
  // O pedido foi gravado e o lançamento do reembolso falhou logo depois.
  await pool.query(
    `INSERT INTO arrependimentos (anunciante_id, plano_id, valor_a_estornar, contratado_em, pedido_em)
     VALUES ($1, 'essencial-1m', 100, now(), clock_timestamp())`,
    [conta.id],
  );
  assert.ok((await obrigacao.conferirReembolsos()) >= 1);
  await obrigacao.conferirReembolsos();
  let ls = await lancamentos(conta.id);
  assert.strictEqual(ls.filter((l) => l.tipo === 'reembolso').length, 1, 'idempotente');
  // Recontratou depois do pedido: o ciclo novo nunca é reembolsado.
  await comprar(conta, 'essencial-1m');
  await obrigacao.conferirReembolsos();
  ls = await lancamentos(conta.id);
  assert.strictEqual(ls.filter((l) => l.tipo === 'reembolso').length, 1);
  assert.strictEqual((await obrigacao.saldoDaConta(conta.id)).saldoSegundos, 27 * H);
});

test('§24 troca de plano (Essencial → Pro) no meio do ciclo: soma só a diferença pelos dias que faltavam', async () => {
  const conta = await novaConta();
  const { assinatura: antiga } = await comprar(conta, 'essencial-1m');
  const { rows: exp } = await pool.query('SELECT data_expiracao FROM anunciantes WHERE id = $1', [conta.id]);
  const nova = await assinaturasRepo.criar({
    anuncianteId: conta.id,
    planoId: 'destaque-1m',
    status: 'pendente_troca',
  });
  const antes = Date.now();
  await sc.processarWebhookAssinatura({
    versao: 1,
    tipo: 'assinatura',
    planoId: nova.id,
    planoAnterior: antiga.id,
    documento: conta.cpf_cnpj,
    evento: 'plano_trocado',
    valor: 160,
    ciclo: 'MONTHLY',
    acertoCobrado: 30,
  });
  const troca = (await lancamentos(conta.id)).find((l) => l.tipo === 'troca');
  assert.ok(troca, 'a troca registra a mudança de obrigação');
  // O vencimento é o último dia, inclusivo, em Matão (src/lib/vigencia.js).
  const dias = (fimDaCobertura(exp[0].data_expiracao).getTime() - antes) / DIA;
  const esperado = ((84 - 27) * H * dias) / 30;
  assert.ok(Math.abs(Number(troca.segundos) - esperado) < 60, `(84 − 27) h × ${dias.toFixed(2)} ÷ 30`);
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.ok(Math.abs(s.devidoSegundos - (27 * H + esperado)) < 60, 'a dívida anterior continua; a troca só soma');
});

test('benefício por créditos/cortesia: nasce a obrigação do plano pelos dias; encerrado antes, sai o que faltava', async () => {
  const conta = await novaConta();
  const validoAte = new Date(Date.now() + 29 * DIA).toISOString().slice(0, 10);
  const plano = await planoDb('essencial-1m');
  const r = await planoAdministrativo.conceder({ conta, plano, validoAte, observacao: 'teste', adminUsuario: 'teste' });
  let ls = await lancamentos(conta.id);
  assert.strictEqual(ls[0].tipo, 'beneficio');
  const dias = (new Date(ls[0].fim) - new Date(ls[0].inicio)) / DIA;
  assert.ok(Math.abs(Number(ls[0].segundos) - (27 * H * dias) / 30) < 60);
  await planoAdministrativo.encerrar({ conta: r.conta, adminUsuario: 'teste' });
  ls = await lancamentos(conta.id);
  const fim = ls.find((l) => l.tipo === 'beneficio_encerrado');
  assert.ok(fim && Number(fim.segundos) < 0, 'o tempo que faltava sai da obrigação');
  const s = await obrigacao.saldoDaConta(conta.id);
  assert.ok(s.saldoSegundos < 60, `encerrado logo depois de começar: quase nada devido (${s.saldoSegundos} s)`);
});

test('painel: GET /anunciantes/me/banco-horas mostra contratado × entregue × saldo (nunca "Em dia" com dívida)', async () => {
  const conta = await novaConta();
  await comprar(conta, 'destaque-1m');
  await comServidor(async (base) => {
    const corpo = await (
      await fetch(`${base}/anunciantes/me/banco-horas`, { headers: { 'x-conta': String(conta.id) } })
    ).json();
    assert.strictEqual(corpo.segundos, 84 * H, 'saldo a entregar');
    assert.strictEqual(corpo.contratadoSegundos, 84 * H);
    assert.strictEqual(corpo.entregueSegundos, 0);
    assert.strictEqual(corpo.cicloAtual.contratadoSegundos, 84 * H);
    assert.strictEqual(corpo.cicloAtual.planoId, 'destaque-1m');
  });
});

test('§31 anomalia de sobre-entrega vira pendência do admin, uma vez por ciclo, sem desconto', async () => {
  const conta = await novaConta();
  await comprar(conta, 'essencial-1m');
  const ponto = await novoPonto();
  await pool.query(
    `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_pedidas,
                                     vezes_confirmadas, duracao_segundos)
     VALUES ($1, $2, date_trunc('hour', now()), 7000, 7000, 7000, 15)`,
    [conta.id, ponto.telaId],
  ); // 29 h 10 min entregues de 27 h — na hora em curso: a hora anterior,
  // entre 00:00 e 00:59 de Matão, cai no dia ANTERIOR ao ciclo comprado agora
  // (a entrega é agrupada por dia de Matão) e o teste falhava nessa janela.
  const um = await obrigacao.registrarAnomaliasDeSobreentrega({ apenasContas: [conta.id] });
  const dois = await obrigacao.registrarAnomaliasDeSobreentrega({ apenasContas: [conta.id] });
  assert.strictEqual(um.abertas, 1);
  assert.strictEqual(dois.abertas, 0, 'rodar de novo não repete o aviso');
  const { rows } = await pool.query(
    `SELECT escopo FROM pendencias WHERE anunciante_id = $1 AND tipo = 'SOBREENTREGA_ANOMALA' AND resolvido_em IS NULL`,
    [conta.id],
  );
  assert.deepStrictEqual(
    rows.map((r) => r.escopo),
    ['admin'],
  );
  assert.strictEqual((await obrigacao.saldoDaConta(conta.id)).saldoSegundos, 0, 'bônus: nunca dívida do cliente');
});
