const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const pool = require('../src/db/pool');
const gerador = require('../src/playlist/gerador');
const dispositivosRepo = require('../src/dispositivos/repository');
const anunciantesRepo = require('../src/anunciantes/repository');
const criativosRepo = require('../src/anunciantes/criativos-repository');
const assinaturasRepo = require('../src/financeiro/assinaturas-repository');
const { montarRespostaPlano } = require('../src/financeiro/san-checkout');
const { calcularValorMensal } = require('../src/financeiro/planos-repository');
const { horasDeTelaPorMes, exibicoesPorMes } = require('../src/lib/pacing');
const { instalarPlayer, novoPonto, tirarDoSorteio } = require('./apoio-player');

// Fechamento da página de Planos (26/09/2026). Duas regras provadas contra o
// código real, com a grade publicada em produção (os mesmos números abaixo):
//
// 1. Horas × exibições: o plano compra SEGUNDOS por hora; quantas inserções
//    isso vira depende da duração da peça (gerador.js#quantasInsercoes). O
//    mínimo anunciado ("Pelo menos N exibições por mês") é o pior caso — a
//    peça com a duração máxima do plano. Peça mais curta cabe mais vezes nas
//    MESMAS horas contratadas, nunca menos.
// 2. Paridade de preço: o que a vitrine mostra (public/planos.page.js
//    #montarPreco) é exatamente o que vai para o San Checkout no GET /plano
//    (san-checkout.js#montarRespostaPlano), nos 12 ciclos.

const GRADE = {
  essencial: { cheio: 159.99, sph: 90, pontos: 3, duracao: 15, horas: 27, minimo: 6480 },
  destaque: { cheio: 399.99, sph: 120, pontos: 7, duracao: 20, horas: 84, minimo: 15120 },
  maximo: { cheio: 699.99, sph: 180, pontos: 10, duracao: 30, horas: 180, minimo: 21600 },
};
const DESCONTO_DO_CICLO = { 1: 0, 3: 10, 6: 15, 12: 20 };
// Valor mensal publicado em produção por célula (consulta de 26/09/2026).
const MENSAL_PRODUCAO = {
  essencial: { 1: 159.99, 3: 143.99, 6: 135.99, 12: 127.99 },
  destaque: { 1: 399.99, 3: 359.99, 6: 339.99, 12: 319.99 },
  maximo: { 1: 699.99, 3: 629.99, 6: 594.99, 12: 559.99 },
};
const HORAS_ABERTO_DIA = 12;
const DIAS_MES = 30;

const criados = { planos: [], contas: [], dispositivos: [] };

async function planoDeTeste(tier, meses = 1) {
  const g = GRADE[tier];
  const id = `teste-grade-${tier}-${meses}m-${randomUUID().slice(0, 8)}`;
  const desconto = DESCONTO_DO_CICLO[meses];
  await pool.query(
    `INSERT INTO planos (id, tier, nome, valor_mensal, valor_mensal_cheio, desconto_percentual, compromisso_meses,
                         frequencia_hora, cobertura, segundos_por_hora, pontos_incluidos, duracao_maxima_segundos,
                         limite_criativos, ativo)
     VALUES ($1,$2,'Teste grade',$3,$4,$5,$6,0,'todos_pontos',$7,$8,$9,3,false)`,
    [id, tier, calcularValorMensal(g.cheio, desconto), g.cheio, desconto, meses, g.sph, g.pontos, g.duracao],
  );
  criados.planos.push(id);
  return (await pool.query('SELECT * FROM planos WHERE id = $1', [id])).rows[0];
}

async function contaDeTeste(planoId) {
  const conta = await anunciantesRepo.criar({
    nome_empresa: `Teste Grade ${randomUUID()}`,
    cpf_cnpj: randomUUID().replace(/-/g, '').slice(0, 11),
    endereco: 'Rua X, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
    contato_email: `grade-${randomUUID()}@example.com`,
    contato_telefone: '16999990000',
    senha: 'x',
  });
  await pool.query(`UPDATE anunciantes SET plano_id = $2, data_expiracao = now() + interval '30 days' WHERE id = $1`, [
    conta.id,
    planoId,
  ]);
  criados.contas.push(conta.id);
  return anunciantesRepo.buscarPorId(conta.id);
}

// Uma rede com pontos suficientes para o maior plano: a tela medida fica no
// primeiro; os outros só precisam estar em operação para a conta cobrir
// exatamente os pontos do plano (sem compensação da RN-49, que só existe
// enquanto a rede é menor que o plano).
let rede = null;
async function redeDeTeste() {
  if (rede) return rede;
  const pontos = [];
  for (let i = 0; i < GRADE.maximo.pontos; i++) pontos.push(await novoPonto({ status: 'em_operacao' }));
  await tirarDoSorteio(pontos[0]); // a tela gerada: só as contas deste teste
  const tela = await dispositivosRepo.criar(pontos[0], { apelido: `Grade ${randomUUID().slice(0, 6)}` });
  await dispositivosRepo.atualizar(tela.id, { status: 'ativo' });
  await instalarPlayer(tela.id);
  criados.dispositivos.push(tela.id);
  rede = { pontos, tela: await dispositivosRepo.buscarComPonto(tela.id) };
  return rede;
}

let proximaHora = Date.UTC(2031, 0, 1, 0);
// Inserções da conta numa hora cheia da tela medida, com UMA peça de
// `duracao` segundos. Cada caso usa uma hora própria (a hora congela).
async function insercoesPorHora(tier, duracao) {
  const { pontos, tela } = await redeDeTeste();
  const plano = await planoDeTeste(tier);
  const conta = await contaDeTeste(plano.id);
  for (const pontoId of pontos.slice(0, GRADE[tier].pontos)) {
    await pool.query('INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) VALUES ($1, $2)', [conta.id, pontoId]);
  }
  const criativo = await criativosRepo.criar({
    anunciante_id: conta.id,
    arquivo_original_url: 'original.mp4',
    arquivo_normalizado_url: `https://exemplo.test/${randomUUID()}.mp4`,
    thumbnail_url: null,
    duracao_segundos: duracao,
  });
  await criativosRepo.atualizar(criativo.id, { status: 'aprovado' });
  const hora = new Date(proximaHora);
  proximaHora += 3600 * 1000;
  const envelope = await gerador.gerarPlaylistDaHora(tela, hora);
  const quantas = envelope.itens.filter((i) => i.anuncianteId === conta.id).length;
  // Sai da rede depois de medida: a hora seguinte (outro caso) não pode ter
  // esta conta pedindo o déficit da hora que a TV "não confirmou" — isso
  // lotaria a hora e o corte proporcional (RN-30) mediria outra coisa.
  await pool.query(`UPDATE anunciantes SET data_expiracao = now() - interval '1 day' WHERE id = $1`, [conta.id]);
  return quantas;
}

// Projeção mensal com a mesma premissa da vitrine (src/lib/pacing.js
// #horasDeTelaPorMes): 12 h de comércio aberto por dia, 30 dias.
const porMes = (tier, porHora) => porHora * GRADE[tier].pontos * HORAS_ABERTO_DIA * DIAS_MES;

test.after(async () => {
  for (const id of criados.dispositivos) await dispositivosRepo.deletar(id).catch(() => {});
  await pool.query('DELETE FROM anunciantes_pontos WHERE anunciante_id = ANY($1::int[])', [criados.contas]);
  await pool.query('DELETE FROM assinaturas WHERE anunciante_id = ANY($1::int[])', [criados.contas]);
  await pool.query('DELETE FROM criativos WHERE anunciante_id = ANY($1::int[])', [criados.contas]);
  await pool.query('DELETE FROM anunciantes WHERE id = ANY($1::int[])', [criados.contas]);
  if (rede) await pool.query('DELETE FROM pontos WHERE id = ANY($1::int[])', [rede.pontos]);
  await pool.query('DELETE FROM planos WHERE id = ANY($1::text[])', [criados.planos]);
  await pool.end();
});

test('vitrine: horas de tela e mínimo de exibições da grade (duração máxima do plano)', () => {
  for (const [tier, g] of Object.entries(GRADE)) {
    const horas = horasDeTelaPorMes(g.sph, g.pontos);
    assert.strictEqual(horas, g.horas, `${tier}: horas de tela/mês`);
    assert.strictEqual(exibicoesPorMes(horas, g.duracao), g.minimo, `${tier}: mínimo de exibições/mês`);
  }
  // O exemplo do pedido: 27 h = 97.200 s; 97.200 / 15 s = 6.480.
  assert.strictEqual(27 * 3600, 97200);
  assert.strictEqual(97200 / 15, 6480);
});

for (const [tier, casos] of Object.entries({
  essencial: [15, 10, 5],
  destaque: [20, 15, 10],
  maximo: [30, 20, 15],
})) {
  test(`gerador real, ${tier}: duração máxima entrega o mínimo; peça mais curta entrega mais, nas mesmas horas`, async (t) => {
    const g = GRADE[tier];
    const medidos = [];
    for (const duracao of casos) {
      const porHora = await insercoesPorHora(tier, duracao);
      medidos.push({ duracao, porHora, mes: porMes(tier, porHora) });
      // Nunca passa das horas contratadas: segundos usados ≤ segundos da hora.
      assert.ok(porHora * duracao <= g.sph, `${tier} ${duracao}s: ${porHora * duracao}s > ${g.sph}s contratados`);
    }
    t.diagnostic(medidos.map((m) => `${m.duracao}s: ${m.porHora}/h por tela → ${m.mes}/mês`).join(' · '));
    const [maxima, media, curta] = medidos;
    assert.ok(maxima.mes >= g.minimo, `${tier} ${maxima.duracao}s: ${maxima.mes} < mínimo ${g.minimo}`);
    assert.strictEqual(maxima.mes, g.minimo, `${tier}: na duração máxima o mínimo anunciado é exato`);
    assert.ok(
      media.mes > maxima.mes,
      `${tier}: ${media.duracao}s (${media.mes}) devia passar ${maxima.duracao}s (${maxima.mes})`,
    );
    assert.ok(
      curta.mes > media.mes,
      `${tier}: ${curta.duracao}s (${curta.mes}) devia passar ${media.duracao}s (${media.mes})`,
    );
  });
}

// Espelho de public/planos.page.js#montarPreco (a página é script de
// navegador, sem módulo). O teste abaixo confere que a página ainda usa
// exatamente estas contas — se alguém mudar lá, este espelho quebra.
function precoDaVitrine(cheioBase, desconto, meses) {
  const porMes = desconto ? Math.round(cheioBase * (1 - desconto / 100) * 100) / 100 : cheioBase;
  const cheioCiclo = Math.round(cheioBase * meses * 100) / 100;
  const totalCiclo = Math.round(porMes * meses * 100) / 100;
  const economia = Math.round((cheioCiclo - totalCiclo) * 100) / 100;
  return { porMes, cheioCiclo, totalCiclo, economia };
}

test('a vitrine ainda calcula o preço com as mesmas contas do espelho do teste', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'planos.page.js'), 'utf8');
  for (const linha of [
    'const porMes = desconto ? Math.round(cheioBase * (1 - desconto / 100) * 100) / 100 : cheioBase;',
    'const cheioCiclo = Math.round(cheioBase * meses * 100) / 100;',
    'const totalCiclo = Math.round(porMes * meses * 100) / 100;',
    'const economia = Math.round((cheioCiclo - totalCiclo) * 100) / 100;',
  ]) {
    assert.ok(js.includes(linha), `planos.page.js mudou: ${linha}`);
  }
});

test('paridade vitrine × Checkout nos 12 ciclos (valor, desconto, economia, equivalente mensal)', async () => {
  const conta = await contaDeTeste(null);
  for (const tier of Object.keys(GRADE)) {
    for (const meses of [1, 3, 6, 12]) {
      const plano = await planoDeTeste(tier, meses);
      const desconto = Number(plano.desconto_percentual);
      const vitrine = precoDaVitrine(Number(plano.valor_mensal_cheio), desconto, meses);
      const rotulo = `${tier} ${meses}m`;

      assert.strictEqual(
        Number(plano.valor_mensal),
        MENSAL_PRODUCAO[tier][meses],
        `${rotulo}: mensal gravado = produção`,
      );
      assert.strictEqual(vitrine.porMes, Number(plano.valor_mensal), `${rotulo}: equivalente mensal da vitrine`);

      const assinatura = await assinaturasRepo.criar({ anuncianteId: conta.id, planoId: plano.id });
      const checkout = await montarRespostaPlano(assinatura.id);
      assert.strictEqual(
        checkout.valor,
        vitrine.totalCiclo,
        `${rotulo}: Checkout ${checkout.valor} ≠ vitrine ${vitrine.totalCiclo}`,
      );
      assert.strictEqual(
        Math.round((vitrine.cheioCiclo - checkout.valor) * 100) / 100,
        vitrine.economia,
        `${rotulo}: economia`,
      );
      await assinaturasRepo.marcarCancelada(assinatura.id);
    }
  }
  // O caso do pedido: Essencial anual, 159,99 × 80% = 127,992 → 127,99;
  // 127,99 × 12 = 1.535,88 na vitrine e no Checkout; economia 384,00.
  const anual = precoDaVitrine(159.99, 20, 12);
  assert.deepStrictEqual(anual, { porMes: 127.99, cheioCiclo: 1919.88, totalCiclo: 1535.88, economia: 384 });
});

test('textos da página de Planos: sem promessa que o produto não cumpre', async () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'planos.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'planos.page.js'), 'utf8');
  assert.match(
    html,
    /Escolha o plano, os pontos da rede e a duração do seu anúncio dentro das condições contratadas\./,
  );
  assert.doesNotMatch(html, /Personalize sua campanha/);
  assert.match(js, /<span class="badge">Recomendado<\/span>/);
  assert.doesNotMatch(js, /Mais escolhido/);
  // FAQ: preço, aprovação, créditos e o mínimo de exibições.
  assert.match(html, /O valor contratado permanece nas renovações dessa assinatura\./);
  assert.match(html, /Se você cancelar e contratar novamente, será aplicado o valor vigente naquele momento\./);
  assert.doesNotMatch(html, /mudança de preço ou de benefício vale só para quem assinar depois/);
  assert.match(html, /Você acompanha a aprovação pelo painel/);
  assert.doesNotMatch(html, /Você recebe um aviso/);
  assert.match(html, /Eventuais créditos já concedidos continuam disponíveis conforme as regras do benefício\./);
  assert.doesNotMatch(html, /créditos programado/);
  assert.match(html, /Criativos mais curtos podem gerar mais exibições dentro da mesma carga de tela\./);

  // Subtítulo do Prime vem do banco (migration 095).
  const { rows } = await pool.query(
    `SELECT DISTINCT rotulo FROM planos WHERE tier = 'maximo' AND ativo AND id NOT LIKE 'teste-grade-%'`,
  );
  for (const r of rows) assert.doesNotMatch(r.rotulo || '', /sem limitações/);
});
