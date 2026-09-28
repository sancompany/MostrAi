// Reforço visual das promoções + barra promocional da área logada
// (28/09/2026).
//
//   Área pública (Home e Planos): a OFERTA é a manchete ("ATÉ 30% OFF"),
//   com selo, benefício, descontos por ciclo, ação e prazo — arte continua
//   fora do texto. Estados: sem arte, arte quadrada/vertical, título e
//   descrição longos, expirada fora do site, sem rolagem horizontal em
//   nenhuma largura.
//   Área logada (painel): o card grande saiu; no lugar, uma faixa fina logo
//   abaixo do cabeçalho, com X. Fechar tira a faixa do fluxo (o conteúdo
//   sobe), vale ao navegar e ao voltar, e numa sessão nova do MESMO
//   navegador (localStorage por id da promoção); outro navegador vê de novo,
//   e uma promoção NOVA aparece mesmo com a anterior dispensada.
//
// Banco zerado, servidor na 3999:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   PW_CHROME=... node tests/e2e/30-promocoes-reforco.mjs
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

const PREFIXO = 'e2e-promo-reforco';
function limpar() {
  PG(`DELETE FROM promocoes WHERE nome_interno LIKE '${PREFIXO}-%'`);
}
const TODOS = ['essencial', 'destaque', 'maximo'];
const PRE_VENDA = TODOS.flatMap((t) => [
  [t, 1, 10],
  [t, 3, 20],
  [t, 6, 25],
  [t, 12, 30],
]);
function criarPromocao(sufixo, { titulo, selo = 'Pré-venda', subtitulo, descricao = 'O desconto permanece enquanto a mesma assinatura continuar ativa.', arte = null, formato = 'horizontal', itens = PRE_VENDA, fim = "now() + interval '60 days'", criadaHa = '0 minutes' }) {
  const id = PG(`INSERT INTO promocoes (nome_interno, titulo_publico, subtitulo, descricao, selo, imagem_url, formato_midia,
      compra_inicio, compra_fim, limite_adesoes, publico_elegivel, status, mostrar_home, mostrar_planos, created_at)
    VALUES ('${PREFIXO}-${sufixo}', '${titulo}', '${subtitulo}', '${descricao}', ${selo ? `'${selo}'` : 'NULL'},
      ${arte ? `'${arte}'` : 'NULL'}, '${formato}', now() - interval '2 days', ${fim}, 30, 'todos', 'ativa', true, true,
      now() - interval '${criadaHa}') RETURNING id`);
  for (const [tier, meses, desconto] of itens) {
    PG(`INSERT INTO promocoes_itens (promocao_id, tier, compromisso_meses, desconto_percentual) VALUES (${id}, '${tier}', ${meses}, ${desconto}) RETURNING id`);
  }
  return Number(id);
}

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
async function gerarArte(largura, altura, fundo) {
  const p = await b.newPage({ viewport: { width: largura, height: altura } });
  await p.setContent(`<body style="margin:0"><div style="width:${largura}px;height:${altura}px;background:${fundo}"></div></body>`);
  const png = await p.screenshot();
  await p.close();
  return png;
}
const ARTES = {
  '/e2e-reforco-arte/h.png': await gerarArte(1916, 821, 'linear-gradient(90deg,#3b2414,#c2570a)'),
  '/e2e-reforco-arte/q.png': await gerarArte(900, 900, 'linear-gradient(135deg,#0f172a,#c2570a)'),
  '/e2e-reforco-arte/v.png': await gerarArte(720, 1280, 'linear-gradient(180deg,#1d4ed8,#ff7a1a)'),
};
async function contexto([w, h]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, isMobile: w < 800, hasTouch: w < 800 });
  await ctx.route('**/e2e-reforco-arte/**', (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: ARTES[new URL(route.request().url()).pathname] }),
  );
  return ctx;
}
async function abrir(ctx, caminho) {
  const p = await ctx.newPage();
  const erros = [];
  p.on('pageerror', (e) => erros.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error') erros.push(m.text());
  });
  await irQuieto(p, `${B}${caminho}`);
  return { p, erros };
}

// Leitura do bloco visível: a oferta domina? o que está onde?
const ler = (p) =>
  p.evaluate(() => {
    const promo = [...document.querySelectorAll('.campanha')].find((x) => !x.closest('[inert]'));
    if (!promo) return null;
    const r = (el) => el?.getBoundingClientRect();
    const px = (el) => (el ? Number.parseFloat(getComputedStyle(el).fontSize) : 0);
    const num = promo.querySelector('.campanha-oferta-num');
    const texto = promo.querySelector('.campanha-texto');
    const midia = r(promo.querySelector('.campanha-midia'));
    const conteudo = r(promo.querySelector('.campanha-conteudo'));
    const cta = promo.querySelector('.campanha-cta');
    const cor = (el) => (el ? getComputedStyle(el).color : '');
    return {
      selo: promo.querySelector('.campanha-selo')?.textContent,
      seloVermelho: getComputedStyle(promo.querySelector('.campanha-selo') || promo).backgroundColor,
      oferta: num?.textContent,
      ate: !!promo.querySelector('.campanha-oferta-ate'),
      ofertaPx: px(num),
      textoPx: px(texto),
      ofertaAmarela: cor(num),
      tituloFalado: promo.querySelector('.campanha-titulo')?.textContent.replace(/\s+/g, ' ').trim(),
      contexto: promo.querySelector('.campanha-contexto')?.textContent ?? null,
      beneficio: texto?.textContent,
      ciclos: [...promo.querySelectorAll('.campanha-ciclo')].map((c) => c.querySelector('b')?.textContent.replace(/\s+/g, ' ').trim()),
      melhor: (() => {
        const d = promo.querySelector('.campanha-ciclo-destaque');
        return d ? d.getAttribute('aria-label') || d.textContent.replace(/\s+/g, ' ') : '';
      })(),
      // Blocos só de leitura (Home): o leitor de tela lê o texto, não aria-label.
      ciclosFalados: [...promo.querySelectorAll('li.campanha-ciclo')].map((c) => (c.hasAttribute('aria-label') ? 'aria-label' : c.textContent.replace(/\s+/g, ' ').trim())),
      cta: cta ? { texto: cta.textContent.trim(), href: cta.getAttribute('href'), altura: Math.round(r(cta).height), largura: Math.round(r(cta).width) } : null,
      urgencia: promo.querySelector('.campanha-urgencia')?.textContent || '',
      validade: promo.querySelector('.campanha-validade')?.textContent.replace(/\s+/g, ' ') || '',
      sobrepoe: !!midia && !(conteudo.left >= midia.right - 1 || conteudo.top >= midia.bottom - 1),
      altura: Math.round(r(promo).height),
      rolagem: document.documentElement.scrollWidth - innerWidth,
      fundoEscuro: getComputedStyle(promo).backgroundImage.includes('gradient'),
    };
  });

limpar();
try {
  const preVenda = criarPromocao('pre-venda', {
    titulo: 'Pré-venda Mostraí: até 30% de desconto',
    subtitulo: 'Condição especial para quem entra primeiro na rede.',
    arte: '/e2e-reforco-arte/h.png',
    criadaHa: '1 hour',
  });

  // -------------------------------------------------------------------------
  console.log('== Home: a oferta domina ==');
  for (const tam of [
    [1920, 1000],
    [1440, 900],
    [1280, 800],
    [1024, 768],
    [768, 1024],
    [430, 932],
    [390, 844],
    [360, 780],
  ]) {
    const ctx = await contexto(tam);
    const { p, erros } = await abrir(ctx, '/');
    await p.waitForSelector('#promocaoHome .campanha');
    const m = await ler(p);
    const w = tam[0];
    check(`home ${w}: selo "Pré-venda" e oferta "ATÉ 30% OFF"`, m.selo === 'Pré-venda' && m.oferta === '30%' && m.ate, m);
    check(`home ${w}: o percentual é o maior texto do bloco (≥ 2,5× o benefício)`, m.ofertaPx >= m.textoPx * 2.5, [m.ofertaPx, m.textoPx]);
    const falado = await p.locator('#promocaoHome').getByRole('heading', { name: /^Até 30% de desconto$/ }).count();
    check(`home ${w}: leitor de tela ouve "Até 30% de desconto" (sem o "OFF")`, falado === 1, m.tituloFalado);
    check(`home ${w}: título que repete a oferta não aparece duas vezes`, m.contexto === null, m.contexto);
    check(`home ${w}: benefício logo abaixo`, m.beneficio === 'Condição especial para quem entra primeiro na rede.', m.beneficio);
    check(`home ${w}: os quatro descontos por ciclo`, JSON.stringify(m.ciclos) === '["10%","20%","25%","30%"]', m.ciclos);
    check(`home ${w}: Anual marcado como melhor desconto`, /Anual.*melhor desconto/.test(m.melhor), m.melhor);
    check(`home ${w}: cada bloco lido como frase ("10% de desconto no Mensal")`, m.ciclosFalados[0]?.includes('10% de desconto no Mensal') && !m.ciclosFalados.includes('aria-label'), m.ciclosFalados);
    check(`home ${w}: CTA "Ver planos" → /planos.html, alvo ≥ 44px`, m.cta?.texto === 'Ver planos' && m.cta.href === '/planos.html' && m.cta.altura >= 44, m.cta);
    check(`home ${w}: urgência moderada + prazo e limite`, m.urgencia === 'Tempo limitado' && /ou até o limite de 30 adesões/.test(m.validade), m.validade);
    check(`home ${w}: nenhum texto sobre a arte`, !m.sobrepoe, m);
    check(`home ${w}: cores de campanha (fundo em gradiente, selo vermelho, oferta amarela)`, m.fundoEscuro && m.seloVermelho === 'rgb(212, 32, 42)' && m.ofertaAmarela === 'rgb(255, 201, 60)', [m.seloVermelho, m.ofertaAmarela]);
    check(`home ${w}: bloco não vira card gigante (≤ ${w < 800 ? 640 : 480}px)`, m.altura <= (w < 800 ? 640 : 480), m.altura);
    check(`home ${w}: sem rolagem horizontal`, m.rolagem <= 0, m.rolagem);
    check(`home ${w}: sem erro de console`, !erros.length, erros);
    await p.screenshot({ path: `${SAIDA}reforco-home-${w}.png` });
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  console.log('== Planos: descontos por ciclo como oferta, levando à grade ==');
  for (const tam of [
    [1440, 900],
    [1024, 768],
    [390, 844],
    [360, 780],
  ]) {
    const ctx = await contexto(tam);
    const { p, erros } = await abrir(ctx, '/planos.html');
    await p.waitForSelector('#promocaoPlanosTopo .campanha');
    const m = await ler(p);
    const w = tam[0];
    check(`planos ${w}: oferta "ATÉ 30% OFF"`, m.oferta === '30%' && m.ate, m);
    check(`planos ${w}: 10/20/25/30%, percentuais intactos`, JSON.stringify(m.ciclos) === '["10%","20%","25%","30%"]', m.ciclos);
    check(`planos ${w}: "Melhor desconto" no Anual`, /Anual.*melhor desconto/.test(m.melhor), m.melhor);
    check(`planos ${w}: prazo com o teto de adesões`, /Adesões até .+ ou até o limite de 30 adesões\./.test(m.validade), m.validade);
    await p.click('.campanha-ciclo[data-campanha-ciclo="6"]');
    const semestral = await p.evaluate(() => document.querySelector('#cycleToggle button[data-meses="6"]').getAttribute('aria-pressed'));
    check(`planos ${w}: tocar no bloco Semestral escolhe o Semestral na grade`, semestral === 'true', semestral);
    check(`planos ${w}: sem rolagem horizontal`, m.rolagem <= 0, m.rolagem);
    check(`planos ${w}: sem erro de console`, !erros.length, erros);
    await p.evaluate(() => window.scrollTo(0, 0));
    await p.screenshot({ path: `${SAIDA}reforco-planos-${w}.png` });
    await ctx.close();
  }

  // -------------------------------------------------------------------------
  console.log('== estados: sem arte, quadrada, vertical, textos longos, expirada ==');
  const casos = [
    { sufixo: 'sem-arte', arte: null, formato: 'horizontal', titulo: 'Semana do comércio local', subtitulo: 'Para quem anuncia no próprio bairro.' },
    { sufixo: 'quadrada', arte: '/e2e-reforco-arte/q.png', formato: 'quadrado', titulo: 'Oferta de primavera', subtitulo: 'Planos com desconto na estação.' },
    { sufixo: 'vertical', arte: '/e2e-reforco-arte/v.png', formato: 'vertical', titulo: 'Campanha de lançamento da rede Mostraí no interior paulista com condição inédita para anunciantes', subtitulo: 'Um subtítulo propositalmente longo para conferir a quebra de linha do bloco promocional em telas estreitas, sem estourar a largura nem esconder o botão de ação da campanha.' },
  ];
  PG(`UPDATE promocoes SET status = 'encerrada' WHERE id = ${preVenda}`);
  for (const caso of casos) {
    const id = criarPromocao(caso.sufixo, { ...caso, itens: TODOS.map((t) => [t, 1, 18]) });
    for (const tam of [
      [1440, 900],
      [360, 780],
    ]) {
      const ctx = await contexto(tam);
      const { p, erros } = await abrir(ctx, '/');
      await p.waitForSelector('#promocaoHome .campanha');
      const m = await ler(p);
      const w = tam[0];
      check(`${caso.sufixo} ${w}: oferta "18% OFF" sem "até" (um desconto só)`, m.oferta === '18%' && !m.ate, m);
      check(`${caso.sufixo} ${w}: título diferente da oferta vira contexto`, m.contexto === caso.titulo, m.contexto);
      check(`${caso.sufixo} ${w}: sem "melhor desconto" com um ciclo só`, m.melhor === '', m.melhor);
      check(`${caso.sufixo} ${w}: CTA visível e inteiro`, m.cta?.largura >= 100 && m.cta.altura >= 44, m.cta);
      check(`${caso.sufixo} ${w}: nenhum texto sobre a arte`, !m.sobrepoe, m);
      check(`${caso.sufixo} ${w}: sem rolagem horizontal`, m.rolagem <= 0, m.rolagem);
      check(`${caso.sufixo} ${w}: sem erro de console`, !erros.length, erros);
      await p.screenshot({ path: `${SAIDA}reforco-${caso.sufixo}-${w}.png` });
      await ctx.close();
    }
    PG(`UPDATE promocoes SET status = 'encerrada' WHERE id = ${id}`);
  }
  // Expirada (prazo no passado) não aparece em lugar nenhum.
  const expirada = criarPromocao('expirada', { titulo: 'Oferta que já acabou', subtitulo: 'x', fim: "now() - interval '1 hour'" });
  {
    const ctx = await contexto([1440, 900]);
    const { p } = await abrir(ctx, '/');
    await p.waitForTimeout(400);
    check('expirada: nenhuma promoção na Home', !(await p.locator('#promocaoHome .campanha').count()));
    await ctx.close();
  }
  PG(`DELETE FROM promocoes WHERE id = ${expirada}`);
  PG(`UPDATE promocoes SET status = 'ativa' WHERE id = ${preVenda}`);

  // -------------------------------------------------------------------------
  console.log('== área logada: barra fina com X no lugar do card ==');
  const email = `reforco-${Date.now()}@teste.com`;
  await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: 'Padaria Reforço',
      cpf_cnpj: '52998224725',
      contato_email: email,
      contato_telefone: '16999995555',
      senha: 'Senha123!',
      aceitou_termos: true,
      cep: '15990000',
      logradouro: 'Rua Um',
      numero: '1',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
    }),
  });
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE contato_email = '${email}'`);
  async function entrar(ctx) {
    const { p, erros } = await abrir(ctx, '/anunciante/login.html');
    await p.fill('#email', email);
    await p.fill('#senha', 'Senha123!');
    await p.click('button[type="submit"]');
    await p.waitForURL(/painel\.html/, { timeout: 10000 });
    return { p, erros };
  }
  const medirBarra = (p) =>
    p.evaluate(() => {
      const barra = document.getElementById('barraPromo');
      const header = document.querySelector('header.site');
      const main = document.querySelector('main');
      const r = (el) => el?.getBoundingClientRect();
      const x = barra?.querySelector('.barra-promo-fechar');
      return {
        existe: !!barra,
        logoAbaixoDoHeader: barra ? Math.abs(r(barra).top - r(header).bottom) <= 1 : false,
        antesDoMain: barra ? !!(barra.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING) : false,
        altura: barra ? Math.round(r(barra).height) : 0,
        texto: barra?.querySelector('.barra-promo-texto')?.textContent.replace(/\s+/g, ' ').trim() || '',
        cta: barra?.querySelector('.barra-promo-cta')?.getAttribute('href') || null,
        xVisivel: x ? r(x).right <= innerWidth && r(x).width >= 32 : false,
        xRotulo: x?.getAttribute('aria-label') || '',
        regiao: barra?.getAttribute('aria-label') || '',
        cardAntigo: !!document.getElementById('promocaoLogado') || !!document.querySelector('.promo-logado, #dashboardAnuncios .campanha, .dashboard-hero-section .campanha'),
        mainTop: Math.round(r(main).top + scrollY),
        rolagem: document.documentElement.scrollWidth - innerWidth,
      };
    });

  for (const tam of [
    [1440, 900],
    [390, 844],
  ]) {
    const w = tam[0];
    const ctx = await contexto(tam);
    const { p, erros } = await entrar(ctx);
    await p.waitForSelector('#barraPromo', { timeout: 8000 });
    const antes = await medirBarra(p);
    check(`painel ${w}: card promocional grande não existe mais`, !antes.cardAntigo, antes);
    check(`painel ${w}: barra logo abaixo do cabeçalho, antes do conteúdo`, antes.existe && antes.logoAbaixoDoHeader && antes.antesDoMain, antes);
    check(`painel ${w}: barra fina (≤ ${w < 800 ? 72 : 56}px)`, antes.altura <= (w < 800 ? 72 : 56), antes.altura);
    check(`painel ${w}: selo + "Até 30% OFF" + "Ver planos"`, /Pré-venda/.test(antes.texto) && /Até 30% OFF/.test(antes.texto) && antes.cta === '/planos.html', antes);
    check(`painel ${w}: X visível e rotulado`, antes.xVisivel && antes.xRotulo === 'Fechar aviso da promoção', antes);
    check(`painel ${w}: barra é região rotulada`, antes.regiao === 'Promoção', antes.regiao);
    check(`painel ${w}: sem rolagem horizontal`, antes.rolagem <= 0, antes.rolagem);
    await p.screenshot({ path: `${SAIDA}reforco-painel-${w}-aberta.png` });

    // Teclado chega no X e fecha.
    await p.focus('.barra-promo-fechar');
    await p.keyboard.press('Enter');
    await p.waitForFunction(() => !document.getElementById('barraPromo'));
    const depois = await medirBarra(p);
    check(`painel ${w}: X fecha a barra`, !depois.existe, depois);
    check(`painel ${w}: o conteúdo sobe (sem espaço vazio)`, Math.abs(antes.mainTop - depois.mainTop - antes.altura) <= 1, [antes.mainTop, depois.mainTop, antes.altura]);
    check(`painel ${w}: o foco vai pro conteúdo, não se perde`, await p.evaluate(() => document.activeElement === document.querySelector('main')));
    await p.screenshot({ path: `${SAIDA}reforco-painel-${w}-fechada.png` });

    // Navegar e voltar: continua fechada.
    await irQuieto(p, `${B}/planos.html`);
    check(`painel ${w}: em Planos a promoção pública continua forte`, (await p.locator('#promocaoPlanosTopo .campanha').count()) === 1);
    await irQuieto(p, `${B}/anunciante/painel.html`);
    await p.waitForTimeout(1200);
    check(`painel ${w}: voltando ao painel, a barra continua fechada`, !(await medirBarra(p)).existe);
    // Aba nova no mesmo navegador (sessão nova de página): continua fechada.
    const { p: p2 } = await abrir(ctx, '/anunciante/painel.html');
    await p2.waitForTimeout(1200);
    check(`painel ${w}: aba nova do mesmo navegador também não mostra`, !(await medirBarra(p2)).existe);
    check(`painel ${w}: dispensa guardada por id da promoção`, (await p2.evaluate((id) => localStorage.getItem(`mostrai:promoDispensada:${id}`), preVenda)) === '1');
    check(`painel ${w}: sem erro de console`, !erros.length, erros);
    await ctx.close();
  }

  // Outro navegador (localStorage vazio): a barra volta.
  {
    const ctx = await contexto([1440, 900]);
    const { p } = await entrar(ctx);
    await p.waitForSelector('#barraPromo', { timeout: 8000 });
    check('outro navegador: a barra aparece de novo', (await medirBarra(p)).existe);
    await p.click('.barra-promo-fechar');
    // Outra promoção, MAIS ANTIGA que a pré-venda, disputando uma célula
    // que a pré-venda ocupa (Prime Anual): a cobrança aplica a pré-venda
    // (a mais nova), então a barra não pode anunciar os 35% dela — nem com a
    // pré-venda dispensada (revisão independente, 28/09/2026).
    criarPromocao('antiga', { titulo: 'Oferta antiga', selo: 'Novidade', subtitulo: 'Só para o Prime.', itens: [['maximo', 12, 35]], criadaHa: '3 hours' });
    await irQuieto(p, `${B}/anunciante/painel.html`);
    await p.waitForTimeout(1500);
    const disputada = await medirBarra(p);
    check('célula ocupada pela mais nova: a barra não anuncia o desconto da mais antiga', !disputada.existe, disputada.texto);
    // Sem a disputa (a pré-venda deixa de cobrir o Prime), a antiga é dona
    // da célula e aparece — mesmo sendo mais antiga que a dispensada: só a
    // dispensa explica a pré-venda não voltar.
    PG(`DELETE FROM promocoes_itens WHERE promocao_id = ${preVenda} AND tier = 'maximo'`);
    await irQuieto(p, `${B}/anunciante/painel.html`);
    await p.waitForSelector('#barraPromo', { timeout: 8000 });
    const nova = await medirBarra(p);
    check('outra promoção: aparece com a pré-venda dispensada, "35% OFF"', /Novidade/.test(nova.texto) && /35% OFF/.test(nova.texto) && !/Pré-venda/.test(nova.texto), nova.texto);
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
