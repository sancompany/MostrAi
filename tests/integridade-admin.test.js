const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');

// Rodada de integridade do admin (23/09/2026) — as correções de backend que
// mudam dado, com linha real no banco (mesmo padrão de troca-de-plano.test.js).

function comAmbiente() {
  process.env.SAN_CHECKOUT_KEY = 'chave-de-teste-do-contratante';
  process.env.SAN_CHECKOUT_CONTRATANTE_ID = 'mostrai';
  process.env.SAN_CHECKOUT_BASE_URL = 'https://checkout.exemplo';
  process.env.SAN_CHECKOUT_API_URL = 'https://checkout.exemplo';
  delete require.cache[require.resolve('../src/financeiro/san-checkout')];
  return require('../src/financeiro/san-checkout');
}

async function apagarConta(id) {
  const pool = require('../src/db/pool');
  // eventos.registrar é fire-and-forget (ver troca-de-plano.test.js).
  await new Promise((resolve) => setTimeout(resolve, 100));
  await pool.query('DELETE FROM eventos WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM comissoes WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM cobrancas_confirmadas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = $1', [id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [id]);
}

// Quem tinha o Básico do comodato (cortesia, motivo 'comodato') e pagou o Pro
// ficava com o Pro gravado MAS ainda marcado como cortesia — fora da receita
// recorrente, sem o botão "Cancelar assinatura", e casando com a guarda de
// `ajustarPlanoIncluido`, que podia trocar o Pro pago pelo Básico de volta.
test('ciclo pago tira a marca de cortesia de quem vinha do comodato', async () => {
  const sc = comAmbiente();
  const pool = require('../src/db/pool');
  const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em,
                              papeis, plano_id, plano_cortesia, cortesia_motivo, credito_comodato_mensal)
     VALUES ('Integridade Cortesia', '11144477735', $1, '16999990000', 'x', now(),
             '{anunciante,ponto}', 'comodato-basico', true, 'comodato', 50)
     RETURNING id`,
    [`integridade-${randomUUID()}@example.com`],
  );
  const contaId = rows[0].id;
  try {
    const assinatura = await assinaturasRepo.criar({ anuncianteId: contaId, planoId: 'destaque-1m', status: 'ativa' });
    await sc.aplicarCicloPago(assinatura, `teste-integridade-${randomUUID()}`);

    const { rows: depois } = await pool.query(
      'SELECT plano_id, plano_cortesia, cortesia_motivo FROM anunciantes WHERE id = $1',
      [contaId],
    );
    assert.strictEqual(depois[0].plano_id, 'destaque-1m', 'o plano pago fica gravado');
    assert.strictEqual(depois[0].plano_cortesia, false, 'pagou: não é mais cortesia');
    assert.strictEqual(depois[0].cortesia_motivo, null, 'motivo de cortesia sai junto');

    // A guarda de ajustarPlanoIncluido não pode mais casar com a conta que paga.
    const { rows: guarda } = await pool.query(
      `SELECT (plano_id IS NULL OR (plano_cortesia AND cortesia_motivo = 'comodato')) AS sobrescreveria
         FROM anunciantes WHERE id = $1`,
      [contaId],
    );
    assert.strictEqual(guarda[0].sobrescreveria, false, 'plano pago não pode ser trocado pelo Básico');
  } finally {
    await apagarConta(contaId);
  }
});

// Inicial e Básico sumiram da UI quando Configurações > Comodato saiu. Agora
// vêm de `listarProdutosComodato` pela mesma ligação que o comodato usa pra
// dar o plano (planos_ponto.plano_incluido_id), com as horas da vitrine.
test('Ofertas lista os 2 produtos de comodato com as características fixas', async () => {
  const planosRepo = require('../src/financeiro/planos-repository');
  const produtos = await planosRepo.listarProdutosComodato();
  const porPlano = Object.fromEntries(produtos.map((p) => [p.planoId, p]));

  const inicial = porPlano['inicial-1m'];
  assert.ok(inicial, 'Inicial aparece');
  assert.strictEqual(inicial.compravel, false, 'Inicial não é comprável');
  assert.strictEqual(inicial.segundosPorHora, 60);
  assert.strictEqual(inicial.pontosIncluidos, 1);
  assert.strictEqual(inicial.duracaoMaximaSegundos, 15);
  assert.strictEqual(inicial.limiteCriativos, 1);
  assert.strictEqual(inicial.horasMes, 6);
  assert.strictEqual(inicial.ajudaCustoMensal, 50, 'quem tem o Inicial recebe os R$ 50');
  assert.strictEqual(inicial.permiteAssinar, false, 'Inicial não compra plano pago');

  const basico = porPlano['comodato-basico'];
  assert.ok(basico, 'Básico aparece');
  assert.strictEqual(basico.compravel, false, 'Básico não é comprável');
  assert.strictEqual(basico.segundosPorHora, 45);
  assert.strictEqual(basico.pontosIncluidos, 3);
  assert.strictEqual(basico.duracaoMaximaSegundos, 15);
  assert.strictEqual(basico.limiteCriativos, 1);
  assert.strictEqual(basico.horasMes, 14);
  assert.strictEqual(basico.ajudaCustoMensal, 0, 'quem tem o Básico abriu mão dos R$ 50');
  assert.strictEqual(basico.permiteAssinar, true, 'Básico pode ter plano pago junto');
  assert.strictEqual(basico.creditoAssinatura, 50);
});

// Régua 80/20 única (src/lib/capacidade.js): os dois saldos nunca se somam
// num "livre" só, e a soma das partes sempre fecha em 100%.
test('capacidade 80/20: comercial e reserva Mostraí são saldos separados', () => {
  const { quebraCapacidade } = require('../src/lib/capacidade');

  // O caso que o dono viu: 3,3% comercial, nada de Mostraí. Era "Livre 96,7%".
  const inicio = quebraCapacidade(120, 0);
  assert.strictEqual(inicio.comercialPct, 3.3);
  assert.strictEqual(inicio.comercialRestantePct, 76.7);
  assert.strictEqual(inicio.mostraiPct, 0);
  assert.strictEqual(inicio.reservaRestantePct, 20);
  assert.strictEqual(inicio.totalPct, 3.3);
  assert.strictEqual(inicio.excede, false);

  // Mostraí dentro da reserva consome só a reserva.
  const dentro = quebraCapacidade(1800, 360);
  assert.strictEqual(dentro.comercialRestantePct, 30);
  assert.strictEqual(dentro.reservaRestantePct, 10);
  assert.strictEqual(dentro.mostraiAcimaDaReservaPct, 0);

  // Mostraí acima de 20% come comercial ainda não vendido — e aparece.
  const acima = quebraCapacidade(1800, 1080);
  assert.strictEqual(acima.mostraiAcimaDaReservaPct, 10);
  assert.strictEqual(acima.comercialRestantePct, 20);
  assert.strictEqual(acima.reservaRestantePct, 0);

  // Venda antiga acima de 80% come a reserva.
  const comercialAlto = quebraCapacidade(3240, 180);
  assert.strictEqual(comercialAlto.comercialRestantePct, 0);
  assert.strictEqual(comercialAlto.reservaRestantePct, 5);

  // Total nunca "cabe" acima de 100%.
  assert.strictEqual(quebraCapacidade(2880, 721).excede, true);
  assert.strictEqual(quebraCapacidade(2880, 720).excede, false);

  // As partes sempre fecham a hora inteira quando nada estoura.
  for (const [c, m] of [
    [120, 0],
    [1800, 360],
    [1800, 1080],
    [3240, 180],
  ]) {
    const q = quebraCapacidade(c, m);
    const soma = Math.round((q.comercialPct + q.comercialRestantePct + q.mostraiPct + q.reservaRestantePct) * 10) / 10;
    assert.strictEqual(soma, 100, `fecha 100% com comercial=${c}s e Mostraí=${m}s`);
  }
});

// Os produtos pagos não carregam mais o percentual de comodato legado.
test('Ofertas não expõe mais o desconto comodato em percentual', async () => {
  const planosRepo = require('../src/financeiro/planos-repository');
  const produtos = await planosRepo.listarProdutos();
  assert.deepStrictEqual(produtos.map((p) => p.tier).sort(), ['destaque', 'essencial', 'maximo']);
  for (const p of produtos) assert.ok(!('descontoComodato' in p), `${p.tier} sem descontoComodato`);
});

// marcarOnline com erro (migration 074 + player heartbeat, seção 2 do
// pedido): o player manda `erro` só quando algo real deu errado (ex.: 403
// "tela fora do ar"); o próximo heartbeat limpo (sem `erro`) tem que apagar
// o que ficou gravado — senão a tela fica presa em "erro_do_player" mesmo
// depois de o player voltar a funcionar.
test('marcarOnline: erro grava junto do heartbeat, heartbeat limpo apaga o erro', async () => {
  const pool = require('../src/db/pool');
  const dispositivosRepo = require('../src/dispositivos/repository');
  const { rows: pontoRows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ('Ponto Heartbeat Integridade', 'Rua Teste', 'Matão', 'SP', '00000000', 'teste', 'Fulano', '16999990000', 'em_operacao')
     RETURNING id`,
  );
  const pontoId = pontoRows[0].id;
  const dispositivo = await dispositivosRepo.criar(pontoId, { apelido: 'Tela Integridade' });
  try {
    await dispositivosRepo.marcarOnline(dispositivo.id, 'falha ao baixar playlist');
    const comErro = await dispositivosRepo.buscarPorId(dispositivo.id);
    assert.strictEqual(comErro.ultimo_erro, 'falha ao baixar playlist');
    assert.ok(comErro.ultimo_erro_em, 'ultimo_erro_em fica preenchido junto');

    await dispositivosRepo.marcarOnline(dispositivo.id, null);
    const semErro = await dispositivosRepo.buscarPorId(dispositivo.id);
    assert.strictEqual(semErro.ultimo_erro, null, 'heartbeat limpo apaga o erro anterior');
    assert.strictEqual(semErro.ultimo_erro_em, null, 'e a data do erro junto — nada fica preso');
  } finally {
    await dispositivosRepo.deletar(dispositivo.id);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
});

// MRR (seção 6.1 da revisão final da Visão geral, 23/09/2026): somar
// `planos.valor_mensal` direto ignorava promoção travada na adesão, desconto
// de parceiro e crédito de comodato — os três reduzem o que a conta paga de
// verdade sem mexer no preço de tabela do plano. `agregarReceitaPorCiclo`
// (src/admin/routes.js) resolve linha a linha via `valorMensalDaConta`
// (mesma função que gera a cobrança real), não reimplementa a conta.
test('MRR: promoção travada usa o valor real da condição, nunca o preço-base atual', () => {
  const { agregarReceitaPorCiclo } = require('../src/admin/routes');
  const linhas = [
    // Sem promoção: paga o preço de tabela do ciclo mensal (Essencial 1m).
    { compromisso_meses: 1, tier: 'essencial', valor_mensal: 99, valor_mensal_cheio: 99, papeis: [] },
    // Promoção trimestral ainda válida: 30% sobre o CHEIO, travado — mesmo
    // que o preço de tabela atual (valor_mensal) já tenha mudado.
    {
      compromisso_meses: 3,
      tier: 'essencial',
      valor_mensal: 89.1,
      valor_mensal_cheio: 99,
      papeis: [],
      promocao_valido_ate: new Date(Date.now() + 86400000),
      promocao_desconto_percentual: 30,
    },
    // Promoção já vencida: cai pro preço de tabela normal do ciclo (semestral).
    {
      compromisso_meses: 6,
      tier: 'essencial',
      valor_mensal: 84.15,
      valor_mensal_cheio: 99,
      papeis: [],
      promocao_valido_ate: new Date(Date.now() - 86400000),
      promocao_desconto_percentual: 50,
    },
  ];
  const porCiclo = agregarReceitaPorCiclo(linhas);
  assert.strictEqual(porCiclo[1], 99, 'sem promoção: preço de tabela');
  assert.strictEqual(porCiclo[3], 99 - 99 * 0.3, 'promoção ativa: 30% sobre o CHEIO, não o preço-base atual');
  assert.strictEqual(porCiclo[6], 84.15, 'promoção vencida: preço de tabela do ciclo, não mais o desconto');
  assert.strictEqual(porCiclo[12], 0, 'ciclo sem nenhuma conta continua zerado');
});

// Bug real reportado na Visão geral (rodada final do admin, 23/09/2026): um
// ponto 'a_instalar' (0 telas) aparecia com ocupação comercial > 0% só
// porque um anunciante já tinha escolhido a vaga (RN-49 permite reservar
// antes da instalação). ocupacaoPorPonto agora só conta segundos_comercial
// pra ponto com pelo menos uma tela ativa (status 'em_operacao') — o ponto
// continua na lista (alocação planejada visível), só não conta como
// capacidade de veiculação real.
test('ocupacaoPorPonto: ponto a_instalar não conta ocupação comercial mesmo com anunciante escolhido', async () => {
  const pool = require('../src/db/pool');
  const midiasRepo = require('../src/midias/repository');
  const { rows: pontoRows } = await pool.query(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status)
     VALUES ('Ponto Aguardando Integridade', 'Rua Teste', 'Matão', 'SP', '00000000', 'teste', 'Fulano', '16999990000', 'a_instalar')
     RETURNING id`,
  );
  const pontoId = pontoRows[0].id;
  const { rows: contaRows } = await pool.query(
    `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, plano_id)
     VALUES ('Conta Integridade Ocupação', '11122233344456', 'ocupacao@teste.com', '16999990001', 'x', now(), 'essencial-1m')
     RETURNING id`,
  );
  const contaId = contaRows[0].id;
  await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [contaId, pontoId]);
  try {
    // status=null reproduz `?escopo=rede` (a chamada que a Visão geral faz).
    const linhas = await midiasRepo.ocupacaoPorPonto([pontoId], null, null);
    const linha = linhas.find((l) => l.pontoId === pontoId);
    assert.ok(linha, 'ponto aparece na listagem (alocação continua visível)');
    assert.strictEqual(linha.segundosComercial, 0, 'sem tela, ocupação comercial real é zero');
    assert.strictEqual(linha.comercialPct, 0);
  } finally {
    await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = $1', [contaId]);
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [contaId]);
    await pool.query('DELETE FROM pontos WHERE id = $1', [pontoId]);
  }
});
