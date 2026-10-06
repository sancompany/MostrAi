// Estação final do painel do usuário (29/09/2026). Roteiro do pedido do dono:
//   A — os 4 indicadores (horas, exibições com a média dentro, custo por
//       exibição, saldo de veiculação) em plano pago, plano por créditos,
//       campanha sem exibição e conta só com o Básico; o número que passava da
//       borda ao alargar a janela (PENDENCIAS U2); o gráfico do período
//       (0, 1, 2, 7 e 30 dias, vários pontos), filtros sem recarregar nem
//       duplicar, cor estável por ponto, dica por foco/toque, tabela
//       simplificada e o comprovante do mesmo recorte;
//   B — Meus pontos nos estados do ponto, com telas, alerta e benefícios;
//   C — Indicações: QR decodificado da própria tela = link à vista; cadastro
//       por ele indica o mesmo ponto; histórico e resumo;
//   D — "Indicado por" em laranja; sem indicação, sem linha;
//   e as 8 larguras sem rolagem lateral.
// Pré-condições: banco zerado (reset-db.sh), servidor na 3999 (restart.sh).
import { chromium } from 'playwright';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { acompanharRede } from './espera.mjs';

const B = 'http://localhost:3999';
const DB = process.env.PGDATABASE || 'mostrai';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d ${DB} -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const SAIDA = new URL('./saida/37-', import.meta.url).pathname;
fs.mkdirSync(new URL('./saida/', import.meta.url).pathname, { recursive: true });

const falhas = [];
const check = (t, cond, d = '') => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : typeof d === 'string' ? d : JSON.stringify(d));
  if (!cond) falhas.push(t);
};
const marca = Date.now();
const categoria = Number(PG("SELECT id FROM categorias WHERE ativo AND nome ILIKE 'Padaria%' LIMIT 1"));

// ---------- dados ----------
async function conta(nome, extra = {}) {
  PG('DELETE FROM tentativas_acesso'); // o roteiro cadastra mais que o limite de 10 por 15 min
  const email = `e2e37-${nome.toLowerCase().replace(/[^a-z]/g, '').slice(0, 10)}-${marca}@teste.dev`;
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: '52998224725',
      categoria_id: categoria,
      cep: '15990-000',
      logradouro: 'Avenida Habib Gabriel',
      numero: '1200',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
      contato_email: email,
      contato_telefone: '(16) 99999-0001',
      senha: 'Senha@Forte1',
      aceitou_termos: true,
      ...extra,
    }),
  });
  if (r.status !== 201) throw new Error(`cadastro ${nome}: ${r.status} ${await r.text()}`);
  const [k, v] = r.headers.getSetCookie()[0].split(';')[0].split('=');
  const id = Number(PG(`WITH u AS (UPDATE anunciantes SET email_confirmado = true WHERE contato_email = '${email}' RETURNING id) SELECT id FROM u`));
  return { id, nome, email, cookie: { name: k, value: v, domain: 'localhost', path: '/', httpOnly: true } };
}
function planoPago(c, planoId) {
  PG(`UPDATE anunciantes SET plano_id = '${planoId}', plano_cortesia = false, data_inicio_cobertura = now() - interval '40 days',
      data_expiracao = current_date + 60 WHERE id = ${c.id}`);
  const p = PG(`SELECT valor_mensal, compromisso_meses, segundos_por_hora, pontos_incluidos, duracao_maxima_segundos FROM planos WHERE id = '${planoId}'`).split('|').map(Number);
  const [valorMensal, meses, sph, pontos, dur] = p;
  const valor = Math.round(valorMensal * 100 * meses) / 100;
  const mes = Math.floor((Math.round((sph * pontos * 12 * 30) / 3600) * 3600) / dur);
  const cc = PG(`WITH ins AS (INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES (${c.id}, '${planoId}', ${valor}) RETURNING id) SELECT id FROM ins`);
  PG(`INSERT INTO ciclos_contratados (anunciante_id, plano_id, cobranca_confirmada_id, origem, ciclo_meses, valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo)
      VALUES (${c.id}, '${planoId}', ${cc}, 'compra', ${meses}, ${valor}, ${mes}, ${mes * meses})`);
  return { valor, previstasCiclo: mes * meses };
}
function planoPorCreditos(c, planoId) {
  PG(`UPDATE anunciantes SET plano_id = '${planoId}', plano_cortesia = true, cortesia_motivo = 'Benefício por créditos',
      data_inicio_cobertura = now(), data_expiracao = current_date + 180 WHERE id = ${c.id}`);
  PG(`INSERT INTO planos_administrativos (anunciante_id, plano_id, valido_ate, status, origem, ativado_em)
      VALUES (${c.id}, '${planoId}', current_date + 180, 'ativo', 'indicacao', now())`);
}
function ponto(nome, { dono = null, status = 'em_operacao', cidade = 'Matão' } = {}) {
  return Number(
    PG(`WITH ins AS (INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, status, anunciante_id)
        VALUES ('${nome}', 'Rua Sinharinha Frota, 450', '${cidade}', 'SP', '15990-000', 'comercio', 'R', '16999990000', '${status}', ${dono ?? 'NULL'}) RETURNING id)
        SELECT id FROM ins`),
  );
}
// no_ar: sinal agora; sem_comunicacao: 29 h calada; sem_player: nunca instalado.
function tela(pontoId, situacao) {
  const chave = situacao === 'sem_player' ? 'NULL' : `'e2e37-${pontoId}-${situacao}-${marca}'`;
  const sinal = situacao === 'no_ar' ? 'now()' : situacao === 'sem_comunicacao' ? "now() - interval '29 hours'" : 'NULL';
  return Number(
    PG(`WITH ins AS (INSERT INTO dispositivos (ponto_id, apelido, status, chave_hash, provisionado_em, primeiro_sinal_em, ultima_vez_online, player_estado)
        VALUES (${pontoId}, 'Tela', 'ativo', ${chave}, now() - interval '90 days', now() - interval '90 days', ${sinal}, ${situacao === 'sem_player' ? 'NULL' : "'PLAYING'"}) RETURNING id)
        SELECT id FROM ins`),
  );
}
// Uma linha por dia (14 h em Matão), de `de` a `ate` dias atrás; confirmadas
// determinísticas pra tela e contas conferirem.
function exibicoes(c, dispositivo, de, ate, valor = (d) => 100 + ((d * 37) % 50)) {
  const linhas = [];
  for (let d = de; d >= ate; d -= 1)
    linhas.push(
      `(${c.id}, ${dispositivo}, ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') - interval '${d} days' + interval '14 hours') AT TIME ZONE 'America/Sao_Paulo'), ${valor(d) + 5}, ${valor(d)}, ${valor(d) + 5})`,
    );
  PG(`INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas, vezes_pedidas) VALUES ${linhas.join(',')}`);
}
// A obrigação nasce do ciclo contratado (migration 111): um ciclo lançado no
// começo de hoje, já vencido. As entregas de hoje entram depois dele no FIFO
// (as de antes, sem ciclo nenhum, não pagam nada) — o ciclo leva o saldo
// pedido mais o que hoje já confirmou (duração nula = 20 s, src/lib/pacing.js).
function saldoAEntregar(c, planoId, segundos) {
  PG(`WITH h AS (SELECT (date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo') AS hoje)
      INSERT INTO obrigacoes_veiculacao (anunciante_id, tipo, chave, segundos, plano_id, inicio, fim, motivo, criado_em)
      SELECT ${c.id}, 'ciclo', 'e2e37:' || gen_random_uuid(),
             ${segundos} + COALESCE((SELECT SUM(vezes_confirmadas * COALESCE(duracao_segundos, 20)) FROM exibicoes_contador
                                     WHERE anunciante_id = ${c.id} AND janela_hora >= h.hoje), 0),
             '${planoId}', h.hoje - interval '3 months', h.hoje, 'e2e', h.hoje
        FROM h`);
}
function sincronizarPonto(id) {
  execSync(`node -e "require('dotenv').config(); require('./src/pontos/repository').sincronizarStatusPonto(${id}).then(() => process.exit(0))"`, {
    cwd: new URL('../../', import.meta.url).pathname,
    env: process.env,
  });
}

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME, args: ['--lang=pt-BR'] }));
const erros = [];
async function abrir(c, { largura = 1440, altura = 900, escala = 1, url = '/anunciante/painel.html' } = {}) {
  const ctx = await b.newContext({
    viewport: { width: largura, height: altura },
    deviceScaleFactor: escala,
    isMobile: largura < 800,
    hasTouch: largura < 800,
    locale: 'pt-BR',
  });
  if (c) await ctx.addCookies([c.cookie]);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`${c?.nome} ${largura}: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && !/status of (401|404)/.test(m.text()) && erros.push(`${c?.nome} ${largura}: ${m.text()}`));
  await p.goto(`${B}${url}`, { waitUntil: 'load' });
  if (url.startsWith('/anunciante/painel')) {
    await p.waitForFunction(() => document.querySelector('#kpiGrid [data-kpi="exibicoes"] b')?.textContent.trim() !== '-', null, { timeout: 15000 }).catch(() => {});
    await p.waitForTimeout(500);
  }
  return { ctx, p };
}
const kpis = (p) =>
  p.$$eval('#kpiGrid .kpi-card:not([hidden])', (cards) =>
    cards.map((c) => ({
      kpi: c.dataset.kpi,
      numero: c.querySelector(':scope > b').innerText.trim(),
      legenda: c.querySelector('.kpi-caption')?.innerText.trim() || '',
      media: c.querySelector('[data-kpi-media]')?.innerText.trim() || null,
    })),
  );
// Número do card passando da borda interna do card (o bug U2).
const vazamentos = (p) =>
  p.$$eval('#kpiGrid .kpi-card:not([hidden])', (cards) =>
    cards
      .map((c) => {
        const b = c.querySelector(':scope > b');
        const rc = c.getBoundingClientRect();
        const limite = rc.right - parseFloat(getComputedStyle(c).paddingRight);
        const faixa = document.createRange();
        faixa.selectNodeContents(b);
        const direita = Math.max(...[...faixa.getClientRects()].map((r) => r.right));
        return { kpi: c.dataset.kpi, sobra: Math.round((limite - direita) * 10) / 10 };
      })
      .filter((x) => x.sobra < -0.5),
  );
const barras = (p) => p.$$eval('#graficoPerformance .barra-col', (x) => x.length);
const coresDaLegenda = (p) =>
  p.$$eval('#legendaPerformance .chip', (chips) =>
    Object.fromEntries(chips.map((c) => [c.textContent.trim(), c.querySelector('.swatch').className.replace('swatch', '').trim()])),
  );
const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const [aHoje, mHoje, dHoje] = hoje.split('-');

// ---------- cenários ----------
// Plano pago (Pro · Trimestral) em 3 pontos da rede, 14 meses de histórico,
// 4h 32min a entregar.
const pago = await conta('Padaria Estrela E2E');
const cicloPago = planoPago(pago, 'destaque-3m');
const pontosPago = [ponto('Mercado Bom Preço E2E'), ponto('Academia Forma E2E'), ponto('Barbearia Zé E2E', { cidade: 'Araraquara' })];
const telasPago = [tela(pontosPago[0], 'no_ar'), tela(pontosPago[1], 'sem_comunicacao'), tela(pontosPago[2], 'sem_player')];
exibicoes(pago, telasPago[0], 420, 0);
exibicoes(pago, telasPago[1], 200, 2);
exibicoes(pago, telasPago[2], 20, 0, (d) => 40 + ((d * 13) % 25));
saldoAEntregar(pago, 'destaque-3m', 16320);

// Plano obtido por créditos (Prime · Semestral), conta que também é ponto,
// com indicados (só cadastro; 1 pagamento).
const dono = await conta('San & Co E2E');
PG(`UPDATE anunciantes SET papeis = '{anunciante,ponto}' WHERE id = ${dono.id}`);
planoPorCreditos(dono, 'maximo-6m');
const proprio = ponto('San & Co Loja Centro E2E', { dono: dono.id });
const telaOk = tela(proprio, 'no_ar');
tela(proprio, 'sem_comunicacao');
sincronizarPonto(proprio);
ponto('San & Co Instalando E2E', { dono: dono.id, status: 'a_instalar' });
ponto('San & Co Primeiro Sinal E2E', { dono: dono.id, status: 'aguardando_primeiro_sinal' });
exibicoes(dono, telaOk, 12, 0);

// Casos do gráfico: sem exibição, 1 dia, 2 dias, 7 dias, 30 dias.
const casos = {};
for (const [nome, dias] of [
  ['zero', null],
  ['um', 0],
  ['dois', 1],
  ['sete', 6],
  ['trinta', 29],
]) {
  const c = await conta(`Grafico ${nome} E2E`);
  planoPago(c, 'essencial-1m');
  if (dias !== null) {
    const t = tela(ponto(`Ponto ${nome} E2E`), 'no_ar');
    exibicoes(c, t, dias, 0);
  }
  casos[nome] = c;
}

// ---------- A. Indicadores ----------
console.log('== A. quatro indicadores: plano pago, vários pontos, saldo a entregar ==');
{
  const { ctx, p } = await abrir(pago);
  const k = await kpis(p);
  check('exatamente 4 indicadores, na ordem: horas, exibições, custo, saldo', k.map((x) => x.kpi).join() === 'horas,exibicoes,custo,banco', k.map((x) => x.kpi));
  check('o card "Média diária" saiu', !(await p.$('#kpiGrid [data-kpi="media"]')));
  const exib = k.find((x) => x.kpi === 'exibicoes');
  check('Exibições: número grande e "de N previstas no mês"', /^[\d.]+$/.test(exib.numero) && /^de [\d.]+ previstas no mês$/.test(exib.legenda), exib);
  check('Exibições: "Média diária: X" pequena dentro do card', /^Média diária: [\d.]+(,\d)?$/.test(exib.media), exib.media);
  const horas = k.find((x) => x.kpi === 'horas');
  check('Horas: "de 84h contratadas"', /^de 84h contratadas/.test(horas.legenda), horas.legenda);
  const custo = k.find((x) => x.kpi === 'custo');
  const esperado = (cicloPago.valor / cicloPago.previstasCiclo).toFixed(4).replace('.', ',');
  check(`Custo: R$ ${esperado} (4 casas, valor do plano ÷ previstas no ciclo)`, custo.numero.replace(/\s/g, ' ') === `R$ ${esperado}`, custo);
  check('Custo: nunca arredondado pra R$ 0,01', custo.numero !== 'R$ 0,01');
  const saldo = k.find((x) => x.kpi === 'banco');
  check('Saldo: "4h 32min" a entregar', saldo.numero === '4h 32min' && /^a entregar/.test(saldo.legenda), saldo);
  const texto = await p.textContent('#kpiGrid');
  check('sem NaN, Infinity nem termo do mecanismo', !/NaN|Infinity|janela_hora|delta|recomposi|pacing|carry/i.test(texto), texto);
  await (await p.$('#kpiGrid')).screenshot({ path: `${SAIDA}kpis-pago.png` });
  await ctx.close();
}
{
  const { ctx, p } = await abrir(dono);
  const k = await kpis(p);
  const custo = k.find((x) => x.kpi === 'custo');
  check('créditos: custo de referência R$ 0,0177 do Prime · Semestral', /^R\$\s0,0177$/.test(custo.numero) && /Referência do Prime · Semestral · sem cobrança/.test(custo.legenda), custo);
  check('créditos: nada de "Benefício por créditos / Sem valor monetário" no custo', !/Sem valor monetário/i.test(custo.legenda) && custo.numero !== 'Benefício por créditos');
  const saldo = k.find((x) => x.kpi === 'banco');
  check('saldo sem pendência: "Em dia"', saldo.numero === 'Em dia', saldo);
  check('horas com as duas origens (plano + Básico)', /180h do plano \+ 14h do Básico/.test(k.find((x) => x.kpi === 'horas').legenda));
  await ctx.close();
}
{
  const { ctx, p } = await abrir(casos.zero);
  const k = await kpis(p);
  const exib = k.find((x) => x.kpi === 'exibicoes');
  check('sem exibição: "0" e "Média diária: 0"', exib.numero === '0' && exib.media === 'Média diária: 0', exib);
  check('sem exibição: nenhum NaN ou Infinity', !/NaN|Infinity/.test(await p.textContent('#kpiGrid')));
  await ctx.close();
}

console.log('== A. número do card não passa da borda ao alargar a janela (U2) ==');
{
  const { ctx, p } = await abrir(pago, { largura: 1280 });
  check('1280: nada vaza', (await vazamentos(p)).length === 0, await vazamentos(p));
  for (const w of [1400, 1920, 1100, 1334]) {
    await p.setViewportSize({ width: w, height: 900 });
    await p.waitForTimeout(400);
    const v = await vazamentos(p);
    check(`1280 → ${w} sem recarregar: nada vaza`, v.length === 0, v);
  }
  await ctx.close();
}

// ---------- A. Gráfico ----------
console.log('== A. gráfico do período: filtros, cores, dica, tabela, comprovante ==');
{
  const { ctx, p } = await abrir(pago);
  let buscas = 0;
  p.on('request', (r) => {
    if (/\/anunciantes\/\d+\/exibicoes$/.test(new URL(r.url()).pathname)) buscas += 1;
  });
  await p.evaluate(() => {
    window.__semRecarga = true;
  });
  const coresBase = await coresDaLegenda(p);
  check('3 pontos na legenda, cada um com uma cor', Object.keys(coresBase).length === 3 && new Set(Object.values(coresBase)).size === 3, coresBase);
  const primeiroMes = PG("SELECT to_char(date_trunc('month', (now() AT TIME ZONE 'America/Sao_Paulo') - interval '420 days'), 'YYYY-MM')");
  const [ah, mh] = hoje.split('-').map(Number);
  const [ap, mp] = primeiroMes.split('-').map(Number);
  const mesesMax = (ah * 12 + mh) - (ap * 12 + mp) + 1;
  // Primeiro dia de cada período (o comprovante começa nele, 00:00 em Matão).
  const dia = (n) => new Date(n * 86400000).toISOString().slice(0, 10);
  const hojeN = Date.UTC(ah, mh - 1, Number(dHoje)) / 86400000;
  const segunda = hojeN - ((new Date(hojeN * 86400000).getUTCDay() + 6) % 7);
  for (const [periodo, n, desde] of [
    ['7d', 7, dia(hojeN - 6)],
    ['3m', 13, dia(segunda - 84)],
    ['1a', 12, dia(Date.UTC(ah, mh - 1 - 11, 1) / 86400000)],
    ['max', mesesMax, `${primeiroMes}-01`],
    ['30d', 30, dia(hojeN - 29)],
  ]) {
    await p.click(`[data-periodo="${periodo}"]`);
    await p.waitForTimeout(150);
    check(`${periodo}: ${n} barras`, (await barras(p)) === n, await barras(p));
    check(`${periodo}: botão marcado (aria-pressed)`, (await p.getAttribute(`[data-periodo="${periodo}"]`, 'aria-pressed')) === 'true');
    const href = await p.getAttribute('#btnComprovante', 'href');
    check(`${periodo}: comprovante desde ${desde} (o mesmo período do gráfico)`, href.endsWith(`/anunciantes/${pago.id}/exibicoes.csv?desde=${desde}`), href);
    // O arquivo soma o mesmo que a tela diz.
    const csv = await p.evaluate(async (u) => (await fetch(u, { credentials: 'include' })).text(), href);
    const totalCsv = Number(csv.trim().split('\r\n').pop().split(';').pop());
    const totalTela = Number((await p.textContent('#performanceTotal')).match(/^[\d.]+/)[0].replace(/\./g, ''));
    check(`${periodo}: total do comprovante = total da tela (${totalTela})`, totalCsv === totalTela, { totalCsv, totalTela });
    const cores = await coresDaLegenda(p);
    check(`${periodo}: mesma cor de cada ponto`, Object.entries(cores).every(([nome, cor]) => coresBase[nome] === cor), cores);
    check(`${periodo}: um gráfico, uma tabela, sem duplicar`, (await p.$$('#graficoPerformance .grafico-area')).length === 1 && (await p.$$('#exibicoesDetalhe table')).length === 1);
  }
  check('trocar de período não recarrega a página', await p.evaluate(() => window.__semRecarga === true));
  check('trocar de período não busca de novo no servidor', buscas === 0, `buscas: ${buscas}`);
  // Dica: foco na barra de hoje (teclado), seta pra esquerda, Esc.
  await p.focus('#graficoPerformance .barra-col[tabindex="0"]');
  await p.waitForTimeout(100);
  const dica = await p.$eval('#dicaPerformance', (d) => ({ visivel: !d.hidden, texto: d.innerText, caixa: d.getBoundingClientRect().toJSON(), card: d.closest('.painel-performance').getBoundingClientRect().toJSON() }));
  check('dica abre no foco com a data, os pontos e o total', dica.visivel && dica.texto.includes(`${dHoje}/${mHoje}/${aHoje}`) && /Total/.test(dica.texto) && /Mercado Bom Preço E2E/.test(dica.texto), dica.texto);
  check('dica dentro do card', dica.caixa.left >= dica.card.left && dica.caixa.right <= dica.card.right && dica.caixa.top >= dica.card.top, dica);
  await p.keyboard.press('ArrowLeft');
  await p.waitForTimeout(100);
  check('seta move a dica pro dia anterior', !(await p.textContent('#dicaPerformance')).includes(`${dHoje}/${mHoje}/${aHoje}`));
  await p.keyboard.press('Escape');
  check('Esc fecha a dica', await p.$eval('#dicaPerformance', (x) => x.hidden));
  const cabecalho = (await p.$$eval('#exibicoesDetalhe thead th', (ths) => ths.map((t) => t.textContent.trim()))).join('|');
  check('tabela: PONTO | CIDADE | STATUS | EXIBIÇÕES', cabecalho === 'Ponto|Cidade|Status|Exibições', cabecalho);
  check('sem Programadas e sem Entrega % na tela do cliente', !/Programadas|Entrega/i.test(await p.textContent('#painelPerformance')));
  const status = await p.$$eval('#exibicoesDetalhe .tabela-status', (x) => x.map((t) => t.textContent.trim()));
  // §8: tela que parou de falar é "Sem comunicação", nunca "Fora do ar".
  check('status reais (No ar / Fora do horário / Sem comunicação / Fora do ar)', status.length === 3 && status.every((s) => ['No ar', 'Fora do horário', 'Sem comunicação', 'Fora do ar'].includes(s)), status);
  const empilhada = await p.$$eval('#graficoPerformance .barra-pilha', (ps) => Math.max(...ps.map((x) => x.children.length)));
  check('barras empilhadas por ponto (até 3 segmentos)', empilhada === 3, empilhada);
  await p.reload({ waitUntil: 'load' });
  await p.waitForSelector('#legendaPerformance .chip');
  check('recarregado: mesmas cores', JSON.stringify(await coresDaLegenda(p)) === JSON.stringify(coresBase));
  await (await p.$('#painelPerformance')).screenshot({ path: `${SAIDA}grafico-pago-30d.png` });
  await ctx.close();
}
for (const [nome, esperado] of [
  ['zero', 0],
  ['um', 1],
  ['dois', 2],
  ['sete', 7],
  ['trinta', 30],
]) {
  const { ctx, p } = await abrir(casos[nome]);
  if (!esperado) {
    const vazio = await p.textContent('#graficoPerformance');
    check(
      'sem dados: a frase, sem gráfico',
      vazio.trim() === 'Ainda não há exibições confirmadas neste período. Assim que sua campanha começar a rodar, os dados aparecerão aqui.' &&
        (await barras(p)) === 0 &&
        (await p.$eval('#legendaPerformance', (x) => x.hidden)),
      vazio,
    );
  } else {
    check(`${nome} dia(s) de campanha: ${esperado} barra(s)`, (await barras(p)) === esperado, await barras(p));
  }
  if (esperado && esperado <= 3) {
    const larguras = await p.$$eval('#graficoPerformance .barra-pilha', (ps) => ps.map((x) => Math.round(x.getBoundingClientRect().width)));
    check(`${esperado} período(s): barras equilibradas (≤ 44 px, centralizadas)`, larguras.every((w) => w <= 44) && (await p.$('.grafico-barras.poucas')) !== null, larguras);
    await (await p.$('#painelPerformance')).screenshot({ path: `${SAIDA}grafico-${nome}.png` });
  }
  await ctx.close();
}

// ---------- B. Meus pontos ----------
console.log('== B. Meus pontos: estados, telas, alerta e benefícios ==');
{
  const { ctx, p } = await abrir(dono);
  await p.waitForSelector('#pontosLista .estab-card', { timeout: 10000 });
  const cards = await p.$$eval('#pontosLista .estab-card', (cs) =>
    cs.map((c) => ({
      classe: c.className,
      nome: c.querySelector('h3')?.textContent.trim(),
      estado: c.querySelector('.estab-estado')?.textContent.trim(),
      etapas: c.querySelectorAll('.estab-etapas li').length,
      atual: c.querySelector('.estab-etapas li[aria-current="step"]')?.textContent.trim(),
      telas: c.querySelectorAll('.tela-linha').length,
      texto: c.innerText,
    })),
  );
  const ativo = cards.find((c) => /estado-ativo/.test(c.classe));
  check('ponto ativo: nome, estado sobre a foto e andamento', ativo && ativo.nome === 'San & Co Loja Centro E2E' && ativo.estado === 'Ativo' && ativo.etapas === 4 && ativo.atual === 'Ativo', ativo);
  check('ponto ativo: 2 telas, uma sem comunicação — sem horário de sinal (§8)', ativo.telas === 2 && /Precisa de atenção/.test(ativo.texto) && /Sem comunicação com a Mostraí/.test(ativo.texto) && !/último sinal/.test(ativo.texto), ativo.texto);
  check('ponto ativo: Plano Básico e +1 crédito, em blocos', /PLANO BÁSICO\s*14 h\/mês neste ponto/i.test(ativo.texto) && /BENEFÍCIO DO PONTO\s*\+1 crédito por mês/i.test(ativo.texto), ativo.texto);
  check('aguardando instalação', cards.some((c) => /estado-aguardando_instalacao/.test(c.classe) && c.atual === 'Aguardando instalação'));
  check('aguardando primeiro sinal', cards.some((c) => /estado-aguardando_primeiro_sinal/.test(c.classe) && c.atual === 'Aguardando primeiro sinal'));
  await p.click('#pontosLista .estado-ativo [data-acao="ver-tela"]');
  await p.waitForSelector('#modalTela[open]');
  check('"Ver o que rodou" abre a tela', await p.isVisible('#modalTelaCorpo'));
  await p.click('#fecharModalTela');
  await (await p.$('#modPontos')).screenshot({ path: `${SAIDA}meus-pontos.png` });
  await ctx.close();
}

// ---------- C. Indicações ----------
console.log('== C. Indicações: QR = link à vista; cadastro por ele; histórico ==');
{
  const { ctx, p } = await abrir(dono, { escala: 2 });
  await p.waitForSelector('#modIndicacao .indicacao-qr img', { timeout: 10000 });
  await p.waitForFunction(() => document.querySelector('#modIndicacao .indicacao-qr img')?.complete);
  const link = (await p.textContent('#modIndicacao .indicacao-link')).trim();
  const png = PNG.sync.read(await (await p.$('#modIndicacao .indicacao-qr img')).screenshot());
  const lido = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
  check('QR decodificado da tela = link à vista', lido === link, { lido, link });
  const url = new URL(lido);
  check('QR: só o cadastro com o cupom do ponto', url.pathname === '/anunciante/cadastro.html' && [...url.searchParams.keys()].join() === 'ref' && url.searchParams.get('ref') === PG(`SELECT codigo FROM cupons_ponto WHERE conta_id = ${dono.id}`), lido);
  check('Copiar link e WhatsApp com o MESMO link', (await p.getAttribute('#modIndicacao [data-acao="copiar"]', 'data-texto')) === link && decodeURIComponent(await p.getAttribute('#modIndicacao a[href^="https://wa.me/"]', 'href')).includes(link));
  check('legenda do QR com o nome de quem indica', /Escaneie para criar uma conta indicada por San & Co E2E\./.test(await p.textContent('#modIndicacao .indicacao-compartilhar')));
  check('sem indicado ainda: "Ninguém se cadastrou pelo seu link ainda."', /Ninguém se cadastrou pelo seu link ainda/.test(await p.textContent('#modIndicacao')));
  await ctx.close();

  // Quem escaneia abre o cadastro com o ref (aqui no servidor local) e vê
  // quem indica — em laranja.
  const ref = url.searchParams.get('ref');
  const cad = await abrir(null, { url: `/anunciante/cadastro.html?ref=${encodeURIComponent(ref)}` });
  await cad.p.waitForSelector('#indicadoPor:not([hidden])', { timeout: 8000 });
  const linha = await cad.p.$eval('#indicadoPor', (el) => {
    // O laranja de texto da página (no site público, o tom com AA também
    // sobre o fundo cinza), resolvido do próprio token.
    const sonda = document.createElement('span');
    sonda.style.color = 'var(--brand-text)';
    el.append(sonda);
    const laranja = getComputedStyle(sonda).color;
    sonda.remove();
    const nome = el.querySelector('b');
    return { texto: el.textContent.trim(), cor: getComputedStyle(nome).color, laranja, peso: getComputedStyle(nome).fontWeight, rotulo: getComputedStyle(el).color };
  });
  check('cadastro pelo QR: "Indicado por: San & Co E2E"', linha.texto === 'Indicado por: San & Co E2E', linha.texto);
  check(
    'nome no laranja de texto da marca, mais pesado; "Indicado por:" na cor secundária',
    linha.cor === linha.laranja && /^rgb\((179, 80|194, 87), 10\)$/.test(linha.cor) && Number(linha.peso) >= 700 && linha.rotulo === 'rgb(91, 100, 114)',
    linha,
  );
  await cad.p.screenshot({ path: `${SAIDA}cadastro-com-indicacao.png` });
  await cad.ctx.close();
  // O envio do cadastro leva o ref (cadastro.page.js) — o mesmo corpo.
  const indicadoPago = await conta('Farmácia Vida E2E', { indicado_por_cupom: ref });
  await conta('Pizzaria Bella E2E', { indicado_por_cupom: ref });
  // Um ciclo pago do indicado: cobrança + ciclo + crédito, como o
  // aplicarCicloPago grava (o caminho real é coberto no teste de unidade).
  const cc = PG(`WITH ins AS (INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES (${indicadoPago.id}, 'essencial-1m', 99) RETURNING id) SELECT id FROM ins`);
  PG(`INSERT INTO ciclos_contratados (anunciante_id, plano_id, cobranca_confirmada_id, origem, ciclo_meses, valor_ciclo, exibicoes_previstas_mes, exibicoes_previstas_ciclo) VALUES (${indicadoPago.id}, 'essencial-1m', ${cc}, 'compra', 1, 99, 6480, 6480)`);
  PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, origem_conta_id, cobranca_confirmada_id) VALUES (${dono.id}, 'indicacao_primeiro_pagamento', 1, ${indicadoPago.id}, ${cc})`);
  PG(`UPDATE anunciantes SET plano_id = 'essencial-1m', data_expiracao = current_date + 20 WHERE id = ${indicadoPago.id}`);

  const h = await abrir(dono);
  await h.p.waitForSelector('#modIndicacao .tabela-indicados', { timeout: 10000 });
  const resumo = (await h.p.textContent('#modIndicacao .indicacao-resumo')).replace(/\s+/g, ' ').trim();
  check('resumo: 2 contas indicadas · 1 já contratou · 1 crédito gerado', /2 contas indicadas/.test(resumo) && /1 já contratou/.test(resumo) && /1 crédito gerado/.test(resumo), resumo);
  const linhas = await h.p.$$eval('#modIndicacao .tabela-indicados tbody tr', (trs) =>
    trs.map((tr) => ({
      nome: tr.querySelector('.ind-nome-texto').textContent.trim(),
      situacao: tr.querySelector('.badge').textContent.trim(),
      ...Object.fromEntries([...tr.querySelectorAll('td[data-rotulo]')].map((td) => [td.dataset.rotulo, td.textContent.trim()])),
    })),
  );
  const farmacia = linhas.find((l) => l.nome === 'Farmácia Vida E2E');
  const pizzaria = linhas.find((l) => l.nome === 'Pizzaria Bella E2E');
  check(
    'pagou: "Gerou crédito", cadastro de hoje, Essencial · Mensal, 1 pagamento, 1 crédito',
    farmacia?.situacao === 'Gerou crédito' && farmacia.Cadastro === `${dHoje}/${mHoje}/${aHoje}` && farmacia.Plano === 'Essencial · Mensal' && farmacia.Pagamentos === '1' && farmacia['Créditos'] === '1',
    farmacia,
  );
  check(
    'só cadastro: "Cadastrou pelo seu link", sem plano, 0 pagamento, 0 crédito',
    pizzaria?.situacao === 'Cadastrou pelo seu link' && pizzaria.Plano === 'Sem plano' && pizzaria.Pagamentos === '0' && pizzaria['Créditos'] === '0',
    pizzaria,
  );
  check('histórico sem e-mail, telefone ou documento', !/@teste\.dev|99999-0001|52998224725/.test(await h.p.textContent('#modIndicacao')));
  await h.p.click('#modIndicacao .indicacao-detalhes summary');
  check('expansão: data do crédito', new RegExp(`${dHoje}/${mHoje}/${aHoje} · \\+1 crédito · primeiro pagamento`).test(await h.p.textContent('#modIndicacao .indicacao-detalhes[open]')));
  await (await h.p.$('#modIndicacao')).screenshot({ path: `${SAIDA}indicacoes.png` });
  await h.ctx.close();
}
{
  const cad = await abrir(null, { url: '/anunciante/cadastro.html' });
  await cad.p.waitForTimeout(800);
  check('cadastro sem ref: sem linha "Indicado por"', await cad.p.$eval('#indicadoPor', (x) => x.hidden));
  await cad.ctx.close();
  const inv = await abrir(null, { url: '/anunciante/cadastro.html?ref=PT-NAOHA999' });
  await inv.p.waitForTimeout(800);
  check('cadastro com ref inválido: sem linha falsa', await inv.p.$eval('#indicadoPor', (x) => x.hidden));
  await inv.ctx.close();
}

// ---------- Larguras ----------
console.log('== larguras: sem rolagem lateral, nada vazando, dica na tela ==');
for (const w of [1920, 1440, 1280, 1024, 768, 430, 390, 360]) {
  for (const c of [pago, dono]) {
    const { ctx, p } = await abrir(c, { largura: w, altura: w >= 1024 ? 900 : 844 });
    await p.waitForSelector('#graficoPerformance .barra-col', { timeout: 10000 }).catch(() => {});
    const m = await p.evaluate(() => {
      const fora = (sel) =>
        [...document.querySelectorAll(sel)].filter((el) => el.offsetParent && el.getBoundingClientRect().right > document.documentElement.clientWidth + 1).length;
      return {
        rolX: document.documentElement.scrollWidth - innerWidth,
        fora: fora('#painelPerformance *, #modPontos *, #modIndicacao *, #kpiGrid *'),
      };
    });
    const v = await vazamentos(p);
    const ultima = await p.$('#graficoPerformance .barra-col[tabindex="0"]');
    let dicaOk = true;
    if (ultima) {
      if (w < 800) await ultima.tap();
      else await ultima.focus();
      await p.waitForTimeout(120);
      dicaOk = await p.$eval('#dicaPerformance', (dd) => {
        const r = dd.getBoundingClientRect();
        return !dd.hidden && r.left >= 0 && r.right <= document.documentElement.clientWidth;
      });
    }
    check(`${c.nome} @${w}: sem rolagem lateral, nada fora, KPI inteiro, dica na tela`, m.rolX <= 0 && m.fora === 0 && v.length === 0 && dicaOk, { ...m, v, dicaOk });
    if (c === pago && [1440, 390].includes(w)) await p.screenshot({ path: `${SAIDA}painel-${w}.png`, fullPage: true });
    await ctx.close();
  }
}

check('sem erro de console', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
