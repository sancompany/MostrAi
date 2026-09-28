// Promoções — mídia separada do conteúdo (Estação 3, 28/09/2026).
//
//   Home e Planos com UMA promoção: arte e texto lado a lado no computador,
//   arte em cima e texto embaixo no celular, nunca texto sobre a imagem;
//   arte inteira (proporção real, sem recorte); sem seta, ponto ou "1/1";
//   Home com "Ver planos"; Planos com o desconto de cada ciclo levando ao
//   ciclo na grade e o prazo com o teto de adesões. Com DUAS promoções:
//   carrossel sem autoplay (setas, pontos, teclado, rolagem = swipe),
//   slide fora da vista inerte, altura estável ao trocar. Rascunho e janela
//   futura continuam fora do site. Prévia do admin é o mesmo componente.
//
// Assume servidor na 3999 (restart.sh) e o banco `mostrai`. Cria e apaga as
// próprias promoções (nome interno `e2e-promo-visual-*`); as artes são
// geradas aqui e servidas pela própria página (mesma origem, cabe na CSP).
//
//   PW_CHROME=... node tests/e2e/28-promocoes-visual.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = process.env.BASE || 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d ${process.env.PGDATABASE || 'mostrai'} -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const falhas = [];
const check = (t, cond, d) => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : d === undefined ? '' : JSON.stringify(d).slice(0, 300));
  if (!cond) falhas.push(t);
};

const PREFIXO = 'e2e-promo-visual';
const ARTE_H = '/e2e-promo-arte/horizontal.png';
const ARTE_Q = '/e2e-promo-arte/quadrada.png';

function limpar() {
  PG(`DELETE FROM promocoes WHERE nome_interno LIKE '${PREFIXO}-%'`);
}
function criarPromocao(sufixo, { titulo, selo, subtitulo, arte, formato, itens, criadaHa = '0 minutes', status = 'ativa', inicio = null }) {
  const id = PG(`INSERT INTO promocoes (nome_interno, titulo_publico, subtitulo, descricao, selo, imagem_url, formato_midia,
      compra_inicio, compra_fim, limite_adesoes, publico_elegivel, status, mostrar_home, mostrar_planos, created_at)
    VALUES ('${PREFIXO}-${sufixo}', '${titulo}', '${subtitulo}', 'O desconto permanece enquanto a mesma assinatura continuar ativa.',
      ${selo ? `'${selo}'` : 'NULL'}, '${arte}', '${formato}', ${inicio ? `now() + interval '${inicio}'` : "now() - interval '1 day'"},
      now() + interval '60 days', 30, 'todos', '${status}', true, true, now() - interval '${criadaHa}') RETURNING id`);
  for (const [tier, meses, desconto] of itens) {
    PG(`INSERT INTO promocoes_itens (promocao_id, tier, compromisso_meses, desconto_percentual) VALUES (${id}, '${tier}', ${meses}, ${desconto})`);
  }
  return id;
}
const TODOS = ['essencial', 'destaque', 'maximo'];
const PRE_VENDA = TODOS.flatMap((t) => [
  [t, 1, 10],
  [t, 3, 20],
  [t, 6, 25],
  [t, 12, 30],
]);

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));

async function gerarArte(largura, altura, fundo) {
  const p = await b.newPage({ viewport: { width: largura, height: altura } });
  await p.setContent(`<body style="margin:0"><div style="width:${largura}px;height:${altura}px;background:${fundo}"></div></body>`);
  const png = await p.screenshot();
  await p.close();
  return png;
}
const ARTES = {
  [ARTE_H]: await gerarArte(1916, 638, 'linear-gradient(90deg,#1d4ed8,#ff7a1a)'),
  [ARTE_Q]: await gerarArte(900, 900, 'linear-gradient(135deg,#0f172a,#c2570a)'),
};

async function abrir(caminho, [w, h], opcoes = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 800, hasTouch: w < 800, ...opcoes });
  await ctx.route('**/e2e-promo-arte/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ARTES[new URL(route.request().url()).pathname] }),
  );
  const p = await ctx.newPage();
  const erros = [];
  p.on('pageerror', (e) => erros.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') erros.push(m.text());
  });
  await irQuieto(p, `${B}${caminho}`);
  return { ctx, p, erros };
}

// Geometria da promoção visível: arranjo, sobreposição, recorte da arte.
const medir = (p) =>
  p.evaluate(() => {
    const promo = [...document.querySelectorAll('.campanha')].find((x) => !x.closest('[inert]'));
    if (!promo) return null;
    const r = (el) => el?.getBoundingClientRect();
    const midia = r(promo.querySelector('.campanha-midia'));
    const conteudo = r(promo.querySelector('.campanha-conteudo'));
    const img = promo.querySelector('.campanha-midia img');
    const ri = r(img);
    const cta = promo.querySelector('.campanha-cta');
    const hero = document.querySelector('.hero');
    return {
      sobrepoe: !!midia && !(conteudo.left >= midia.right - 1 || conteudo.top >= midia.bottom - 1),
      ladoALado: !!midia && conteudo.left >= midia.right - 1,
      empilhado: !!midia && conteudo.top >= midia.bottom - 1,
      recorte: img?.naturalWidth ? Math.abs(ri.width / ri.height - img.naturalWidth / img.naturalHeight) : null,
      titulo: promo.querySelector('.campanha-titulo')?.innerText,
      selo: promo.querySelector('.campanha-selo')?.innerText,
      // Nunca por cima da arte: embaixo dela (empilhado) ou ao lado.
      cta: cta
        ? (() => {
            const c = r(cta);
            const fora = !midia || c.top >= midia.bottom - 1 || c.left >= midia.right - 1;
            return { texto: cta.innerText.trim(), href: cta.getAttribute('href'), foraDaMidia: fora };
          })()
        : null,
      ciclos: [...promo.querySelectorAll('.campanha-ciclo')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
      validade: promo.querySelector('.campanha-validade')?.innerText || '',
      heroAbaixo: hero ? r(hero).top >= r(promo).bottom : null,
      navegacao: !!document.querySelector('.campanha-navegacao'),
      contador: /\b1\s*\/\s*1\b/.test(document.querySelector('#promocaoHome, #promocaoPlanosTopo')?.innerText || ''),
      rolagem: document.documentElement.scrollWidth - innerWidth,
    };
  });

limpar();
try {
  // -------------------------------------------------------------------------
  console.log('== uma promoção: Home e Planos ==');
  criarPromocao('pre-venda', {
    titulo: 'Pré-venda Mostraí: até 30% de desconto',
    selo: 'Pré-venda',
    subtitulo: 'Condição especial para quem entra primeiro na rede.',
    arte: ARTE_H,
    formato: 'horizontal',
    itens: PRE_VENDA,
    criadaHa: '1 hour',
  });
  for (const [w, h, arranjo] of [
    [1440, 900, 'ladoALado'],
    [390, 844, 'empilhado'],
  ]) {
    const { ctx, p, erros } = await abrir('/', [w, h]);
    await p.waitForSelector('#promocaoHome .campanha');
    const m = await medir(p);
    check(`home ${w}: arte e texto ${arranjo === 'ladoALado' ? 'lado a lado' : 'empilhados (arte em cima)'}`, m[arranjo], m);
    check(`home ${w}: nenhum texto sobre a imagem`, !m.sobrepoe, m);
    check(`home ${w}: arte inteira, sem recorte`, m.recorte !== null && m.recorte < 0.02, m.recorte);
    check(`home ${w}: selo e título sem repetir o selo`, m.selo === 'Pré-venda' && m.titulo === 'Até 30% de desconto', m);
    check(`home ${w}: CTA "Ver planos" → /planos.html, fora da arte`, m.cta?.texto === 'Ver planos' && m.cta.href === '/planos.html' && m.cta.foraDaMidia, m.cta);
    check(`home ${w}: uma promoção = sem seta, ponto ou 1/1`, !m.navegacao && !m.contador, m);
    check(`home ${w}: hero continua bloco à parte, abaixo`, m.heroAbaixo === true, m);
    check(`home ${w}: sem rolagem horizontal`, m.rolagem <= 0, m.rolagem);
    check(`home ${w}: sem erro de console`, !erros.length, erros);
    await p.screenshot({ path: `${SAIDA}promo-home-${w}.png` });
    await ctx.close();
  }
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ]) {
    const { ctx, p, erros } = await abrir('/planos.html', [w, h]);
    await p.waitForSelector('#promocaoPlanosTopo .campanha');
    const m = await medir(p);
    check(`planos ${w}: nenhum texto sobre a imagem`, !m.sobrepoe, m);
    check(`planos ${w}: descontos por ciclo na ordem`, JSON.stringify(m.ciclos) === JSON.stringify(['10% Mensal', '20% Trimestral', '25% Semestral', '30% Anual']), m.ciclos);
    check(`planos ${w}: prazo com o teto de adesões`, /Adesões até .+ ou até o limite de 30 adesões\./.test(m.validade), m.validade);
    check(`planos ${w}: sem "Ver condição na página de planos"`, !(await p.getByText('Ver condição na página de planos').count()));
    await p.click('.campanha-ciclo[data-campanha-ciclo="12"]');
    const anual = await p.evaluate(() => document.querySelector('#cycleToggle button[data-meses="12"]').getAttribute('aria-pressed'));
    check(`planos ${w}: tocar em "30% Anual" escolhe o Anual na grade`, anual === 'true', anual);
    check(`planos ${w}: sem rolagem horizontal`, m.rolagem <= 0, m.rolagem);
    check(`planos ${w}: sem erro de console`, !erros.length, erros);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: `${SAIDA}promo-planos-${w}.png` });
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  console.log('== duas promoções: carrossel ==');
  criarPromocao('comercio-local', {
    titulo: 'Semana do comércio local',
    selo: 'Novidade',
    subtitulo: 'Para quem anuncia no próprio bairro.',
    arte: ARTE_Q,
    formato: 'quadrado',
    itens: TODOS.map((t) => [t, 3, 22]),
  });
  for (const [w, h] of [
    [1440, 900],
    [390, 844],
  ]) {
    const { ctx, p, erros } = await abrir('/', [w, h]);
    await p.waitForSelector('[data-campanha-carrossel]');
    const estado = () =>
      p.evaluate(() => ({
        atual: [...document.querySelectorAll('[data-campanha-ir]')].findIndex((x) => x.getAttribute('aria-current') === 'true'),
        inertes: [...document.querySelectorAll('[data-campanha-slide]')].map((s) => s.inert),
        altura: Math.round(document.querySelector('[data-campanha-carrossel]').getBoundingClientRect().height),
      }));
    const inicio = await estado();
    check(`carrossel ${w}: 2 pontos, começa no 1º, o 2º inerte`, inicio.atual === 0 && JSON.stringify(inicio.inertes) === '[false,true]', inicio);
    check(`carrossel ${w}: ordem do servidor (a mais nova primeiro)`, (await p.textContent('[data-campanha-slide]:first-child .campanha-titulo')) === 'Semana do comércio local');
    check(`carrossel ${w}: seta "anterior" desligada no começo`, (await p.getAttribute('[data-campanha-anterior]', 'aria-disabled')) === 'true');
    await p.focus('[data-campanha-proxima]');
    await p.keyboard.press('Enter');
    await p.waitForTimeout(700);
    const depois = await estado();
    check(`carrossel ${w}: seta "próxima" vai pro 2º`, depois.atual === 1 && JSON.stringify(depois.inertes) === '[true,false]', depois);
    const foco = await p.evaluate(() => ({
      noBotao: document.activeElement?.hasAttribute('data-campanha-proxima'),
      desligado: document.activeElement?.getAttribute('aria-disabled'),
    }));
    check(`carrossel ${w}: no fim, o foco continua na seta (aria-disabled, não disabled)`, foco.noBotao && foco.desligado === 'true', foco);
    check(`carrossel ${w}: trocar de promoção não muda a altura`, depois.altura === inicio.altura, [inicio.altura, depois.altura]);
    await p.focus('[data-campanha-ir="1"]');
    await p.keyboard.press('ArrowLeft');
    await p.waitForTimeout(700);
    check(`carrossel ${w}: seta do teclado volta pro 1º`, (await estado()).atual === 0);
    // Swipe é a rolagem do próprio trilho: rolar o trilho troca o slide.
    await p.evaluate(() => {
      const t = document.querySelector('[data-campanha-trilho]');
      t.scrollTo({ left: t.scrollWidth, behavior: 'auto' });
    });
    await p.waitForTimeout(500);
    check(`carrossel ${w}: rolar o trilho (swipe) acompanha no ponto`, (await estado()).atual === 1);
    await p.click('[data-campanha-ir="0"]');
    await p.waitForTimeout(700);
    check(`carrossel ${w}: ponto leva direto ao slide`, (await estado()).atual === 0);
    await p.waitForTimeout(5000);
    check(`carrossel ${w}: sem autoplay`, (await estado()).atual === 0);
    const m = await medir(p);
    check(`carrossel ${w}: nenhum texto sobre a imagem`, !m.sobrepoe, m);
    check(`carrossel ${w}: sem rolagem horizontal da página`, m.rolagem <= 0, m.rolagem);
    check(`carrossel ${w}: sem erro de console`, !erros.length, erros);
    await p.screenshot({ path: `${SAIDA}promo-carrossel-${w}.png` });
    await ctx.close();
  }
  {
    // A promoção mais antiga não anuncia a célula que a mais nova ocupa: a
    // cobrança usa a primeira promoção vigente de cada produto × ciclo.
    const { ctx, p } = await abrir('/planos.html', [1440, 900]);
    await p.waitForSelector('[data-campanha-carrossel]');
    const ciclos = await p.evaluate(() =>
      [...document.querySelectorAll('[data-campanha-slide]')].map((s) =>
        [...s.querySelectorAll('.campanha-ciclo')].map((c) => c.innerText.replace(/\s+/g, ' ').trim()),
      ),
    );
    check(
      'planos: a pré-venda (mais antiga) não anuncia o Trimestral, que a mais nova ocupa',
      JSON.stringify(ciclos) === JSON.stringify([['22% Trimestral'], ['10% Mensal', '25% Semestral', '30% Anual']]),
      ciclos,
    );
    const titulos = await p.evaluate(() => [
      window.promocaoUtil.tituloSemSelo('Black Friday: 2026', 'Black Friday'),
      window.promocaoUtil.tituloSemSelo('Pré-venda - 3 meses', 'Pré-venda'),
      window.promocaoUtil.tituloSemSelo('Pré-venda Mostraí: até 30% de desconto', 'Pré-venda'),
    ]);
    check('título: só perde o selo quando sobra um título de verdade', JSON.stringify(titulos) === JSON.stringify(['Black Friday: 2026', 'Pré-venda - 3 meses', 'Até 30% de desconto']), titulos);
    await ctx.close();
  }
  {
    const { ctx, p } = await abrir('/', [390, 844], { reducedMotion: 'reduce' });
    await p.waitForSelector('[data-campanha-carrossel]');
    const comportamento = await p.evaluate(() => getComputedStyle(document.querySelector('[data-campanha-trilho]')).scrollBehavior);
    check('carrossel: prefers-reduced-motion desliga a rolagem suave', comportamento === 'auto', comportamento);
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  console.log('== regra de exibição intacta ==');
  PG(`UPDATE promocoes SET status = 'rascunho' WHERE nome_interno LIKE '${PREFIXO}-%'`);
  {
    const { ctx, p } = await abrir('/', [1440, 900]);
    await p.waitForTimeout(800);
    check('rascunho: nenhuma promoção na Home', await p.isHidden('#promocaoHomeSecao'));
    await ctx.close();
  }
  PG(`UPDATE promocoes SET status = 'ativa', compra_inicio = now() + interval '2 days' WHERE nome_interno LIKE '${PREFIXO}-%'`);
  {
    const { ctx, p } = await abrir('/planos.html', [1440, 900]);
    await p.waitForTimeout(800);
    check('janela futura: nenhuma promoção em Planos', await p.isHidden('#promocaoPlanosBanner'));
    await ctx.close();
  }
  PG(`UPDATE promocoes SET compra_inicio = now() - interval '1 day' WHERE nome_interno LIKE '${PREFIXO}-%'`);

  // -------------------------------------------------------------------------
  console.log('== prévia do admin = mesmo componente ==');
  {
    const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
    await ctx.route('**/e2e-promo-arte/**', (route) =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ARTES[new URL(route.request().url()).pathname] }),
    );
    const admin = await ctx.newPage();
    await irQuieto(admin, `${B}/admin/index.html`);
    await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
    await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
    await admin.click('button[type=submit]');
    await admin.waitForSelector('.admin-shell');
    await admin.evaluate(() => {
      location.hash = 'ofertas/promocoes';
    });
    await admin.waitForSelector('#btnNovaPromocao');
    await admin.click('#btnNovaPromocao');
    await admin.waitForSelector('#formPromocao');
    await admin.fill('#pTitulo', 'Pré-venda Mostraí: até 30% de desconto');
    await admin.fill('#pSelo', 'Pré-venda');
    // "Destaque na Home" é um interruptor visual sobre o checkbox.
    await admin.evaluate(() => {
      const c = document.querySelector('#formPromocao [name="mostrar_home"]');
      c.checked = true;
      c.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await admin.waitForTimeout(300);
    const previa = await admin.evaluate(() => {
      const el = document.getElementById('previaHome');
      return { promo: !!el.querySelector('.campanha'), titulo: el.querySelector('.campanha-titulo')?.innerText, inerte: el.inert, antigo: !!el.querySelector('.previa-banner') };
    });
    check('admin: prévia da Home usa o componente novo (sem o banner antigo)', previa.promo && !previa.antigo, previa);
    check('admin: prévia não é clicável (inert)', previa.inerte === true, previa);
    await admin.screenshot({ path: `${SAIDA}promo-admin-previa.png` });
    await ctx.close();
  }
} finally {
  limpar();
  await b.close();
}

if (falhas.length) {
  console.log(`\n${falhas.length} falha(s):`, falhas);
  process.exit(1);
}
console.log('\ntudo ok');
