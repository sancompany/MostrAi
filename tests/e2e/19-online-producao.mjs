// Validação ONLINE, contra a produção de verdade (consolidação final,
// 24/09/2026). Só leitura fora do admin: nenhuma conta, pedido, cobrança ou
// tela é criada — o que se prova aqui é que o que está no ar responde com a
// regra canônica, recusa o que deve recusar, e desenha sem estourar a tela.
//
//   BASE=https://mostrai.sancocore.com.br PW_CHROME=... node tests/e2e/19-online-producao.mjs
//
// Admin (opcional): com CF_ACCESS_CLIENT_ID/CF_ACCESS_CLIENT_SECRET (service
// token TEMPORÁRIO do Cloudflare Access) e ADMIN_USER_PROD/ADMIN_PASSWORD_PROD,
// entra no /admin e percorre as telas SEM gravar nada (só GETs e a sessão).
// Sem essas variáveis, o bloco do admin é pulado e o roteiro prova que o
// Access está fechado (302 pra página de login do Cloudflare).
import { chromium } from 'playwright';
import { createHmac } from 'node:crypto';

const BASE = (process.env.BASE || 'https://mostrai.sancocore.com.br').replace(/\/+$/, '');
const TOKEN_ID = process.env.CF_ACCESS_CLIENT_ID || '';
const TOKEN_SECRET = process.env.CF_ACCESS_CLIENT_SECRET || '';
const ADMIN_USER = process.env.ADMIN_USER_PROD || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD_PROD || '';
const ACCESS_HEADERS = TOKEN_ID ? { 'CF-Access-Client-Id': TOKEN_ID, 'CF-Access-Client-Secret': TOKEN_SECRET } : {};

const falhas = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d === undefined ? '' : String(d).slice(0, 200));
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const saida = (n) => new URL(`./saida/online-${n}.png`, import.meta.url).pathname;

// fetch sem seguir redirect, pra provar 301/302 de verdade.
const http = (caminho, opts = {}) =>
  fetch(`${BASE}${caminho}`, { redirect: 'manual', ...opts, headers: { ...(opts.headers || {}) } });

// ---------------------------------------------------------------------------
console.log('== saúde, cabeçalhos, sessão pública ==');
{
  const r = await http('/health');
  check('/health → ok:true', r.status === 200 && (await r.json()).ok === true);
  const home = await http('/');
  check('/ → 200', home.status === 200, home.status);
  const csp = home.headers.get('content-security-policy') || home.headers.get('content-security-policy-report-only');
  check('CSP presente e sem unsafe-inline em script-src', !!csp && /script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp), csp);
  check('HSTS presente', /max-age/.test(home.headers.get('strict-transport-security') || ''));
  check('X-Content-Type-Options nosniff', home.headers.get('x-content-type-options') === 'nosniff');
  const sessao = await http('/conta/sessao');
  check('/conta/sessao anônimo → 200 {logado:false} (sem 401 no console)', sessao.status === 200 && (await sessao.json()).logado === false);
  const planos = await (await http('/planos')).json();
  const tiers = new Set(planos.map((p) => p.tier));
  check('GET /planos: só Essencial/Pro/Prime, 4 ciclos cada (12 planos)', planos.length === 12 && [...tiers].sort().join() === 'destaque,essencial,maximo', `${planos.length} planos: ${[...tiers].join()}`);
  check('GET /planos: nenhum plano Inicial/Básico/fundador', !planos.some((p) => /inicial|basico|comodato/.test(p.id) || p.fundador));
  const promos = await http('/promocoes/vigentes');
  check('GET /promocoes/vigentes → 200 lista', promos.status === 200 && Array.isArray(await promos.json()));
  const pontos = await http('/pontos');
  check('GET /pontos público → 200', pontos.status === 200);
}

console.log('== rotas aposentadas respondem 410 (não 200, não 500) ==');
// As duas últimas exigem sessão antes do 410 (o middleware de login vem
// primeiro): anônimo recebe 401 — o que importa é nunca 200 nem 500.
for (const [m, c, aceitos] of [
  ['GET', '/planos-ponto', [410]],
  ['GET', '/vendedor/painel', [410]],
  ['PATCH', '/vendedor/me', [410]],
  ['POST', '/afiliados/login', [410]],
  ['POST', '/afiliados/esqueci-senha', [410]],
  ['POST', '/candidaturas', [410]],
  ['POST', '/conta/bonus/anuncio/resgatar', [401, 410]],
  ['POST', '/anunciantes/me/comodato/trocar-por-tela', [401, 410]],
]) {
  const r = await http(c, { method: m, headers: { 'Content-Type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
  check(`${m} ${c} → ${aceitos.join('/')}`, aceitos.includes(r.status), r.status);
}

console.log('== redirecionamentos 301 de endereços aposentados ==');
for (const [de, para] of [
  ['/anunciante/vendedor.html', '/anunciante/painel.html'],
  ['/anunciante/ponto.html', '/anunciante/painel.html'],
]) {
  const r = await http(de);
  check(`${de} → 301 ${para}`, r.status === 301 && (r.headers.get('location') || '').startsWith(para), `${r.status} ${r.headers.get('location')}`);
}

console.log('== adversarial (sem efeito colateral): tudo que exige credencial recusa ==');
{
  const semAssin = await http('/webhook/san-checkout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tipo":"assinatura"}' });
  check('webhook sem assinatura → 401', semAssin.status === 401, semAssin.status);
  const ts = String(Math.floor(Date.now() / 1000));
  const assinaturaFalsa = `sha256=${createHmac('sha256', 'chave-errada').update(`${ts}.{"tipo":"assinatura"}`).digest('hex')}`;
  const assinErrada = await http('/webhook/san-checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Checkout-Signature': assinaturaFalsa, 'X-Checkout-Timestamp': ts },
    body: '{"tipo":"assinatura"}',
  });
  check('webhook com assinatura errada → 401', assinErrada.status === 401, assinErrada.status);
  check('GET /anunciantes/me sem sessão → 401', (await http('/anunciantes/me')).status === 401);
  check('GET /anunciantes/me/creditos sem sessão → 401', (await http('/anunciantes/me/creditos')).status === 401);
  check('GET /playlist/12345 sem credencial → 401', (await http('/playlist/12345')).status === 401);
  check('POST /player/12345/heartbeat sem credencial → 401', (await http('/player/12345/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status === 401);
  check('GET /plano/x sem X-Checkout-Key → 401', (await http('/plano/nao-existe')).status === 401);
  check('GET /convites/token-invalido → 404', (await http('/convites/nao-existe')).status === 404);
  const admSemAccess = await http('/admin/pontos', { headers: {} });
  check('GET /admin/pontos sem Access → 302 pro login do Cloudflare (Access LIGADO)', admSemAccess.status === 302 && /cloudflareaccess\.com/.test(admSemAccess.headers.get('location') || ''), `${admSemAccess.status} ${admSemAccess.headers.get('location')}`);
  const admHtml = await http('/admin/', { headers: {} });
  check('GET /admin/ sem Access → 302', admHtml.status === 302, admHtml.status);
}

// ---------------------------------------------------------------------------
console.log('== visual: site público em 5 tamanhos, sem overflow nem erro de console ==');
// Ambiente com proxy de saída (HTTPS_PROXY com credenciais): o Chromium não
// lê a variável sozinho, então ela vira opção explícita; fora dele, direto.
const proxyEnv = process.env.HTTPS_PROXY || process.env.https_proxy;
const proxy = proxyEnv
  ? (() => {
      const u = new URL(proxyEnv);
      return {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
    })()
  : undefined;
const b = await chromium.launch({
  executablePath: process.env.PW_CHROME,
  proxy,
  args: proxy ? ['--ignore-certificate-errors'] : [],
});
const VIEWPORTS = [
  ['1366x768', 1366, 768],
  ['1440x900', 1440, 900],
  ['1920x1080', 1920, 1080],
  ['390x844', 390, 844],
  ['360x800', 360, 800],
];
const PAGINAS = ['/', '/planos.html', '/pontos.html', '/contato.html', '/anunciante/login.html', '/anunciante/cadastro.html'];
for (const [nome, width, height] of VIEWPORTS) {
  const ctx = await b.newContext({ viewport: { width, height }, isMobile: width < 500, ignoreHTTPSErrors: !!proxy });
  const p = await ctx.newPage();
  const erros = [];
  p.on('console', (m) => {
    if (m.type() === 'error') erros.push(m.text());
  });
  p.on('pageerror', (e) => erros.push(String(e)));
  for (const caminho of PAGINAS) {
    await p.goto(`${BASE}${caminho}`, { waitUntil: 'networkidle', timeout: 45000 }).catch((e) => erros.push(`goto ${caminho}: ${e.message}`));
    await p.waitForTimeout(400);
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`${nome} ${caminho}: sem rolagem horizontal`, overflow <= 1, `sobra ${overflow}px`);
    if (caminho === '/' || caminho === '/planos.html') await p.screenshot({ path: saida(`${nome}-${caminho.replace(/[^a-z]/g, '') || 'home'}`), fullPage: true });
  }
  // Mapa do Google e ViaCEP não passam pelo proxy deste ambiente — ruído conhecido, não é bug.
  const reais = erros.filter((e) => !/maps\.googleapis|viacep|net::ERR_|Failed to load resource: net::/.test(e));
  check(`${nome}: sem erro de console nas páginas públicas`, reais.length === 0, reais.slice(0, 3).join(' | '));
  await ctx.close();
}

// ---------------------------------------------------------------------------
if (TOKEN_ID && ADMIN_USER) {
  console.log('== admin (service token temporário do Access): só leitura ==');
  const ctx = await b.newContext({ viewport: { width: 1366, height: 768 }, extraHTTPHeaders: ACCESS_HEADERS });
  const p = await ctx.newPage();
  const erros = [];
  p.on('console', (m) => {
    if (m.type() === 'error') erros.push(m.text());
  });
  p.on('pageerror', (e) => erros.push(String(e)));
  await p.goto(`${BASE}/admin/`, { waitUntil: 'networkidle', timeout: 45000 });
  check('admin: com o token o gate de login do Mostraí aparece (não o do Cloudflare)', await p.locator('#gate').count() === 1);
  await p.fill('#usuario', ADMIN_USER);
  await p.fill('#senha', ADMIN_PASSWORD);
  await p.click('#formLogin button[type="submit"]');
  await p.waitForTimeout(3000);
  // O 401 de /admin/resumo ANTES do login é o que mostra o gate — não é erro.
  erros.length = 0;
  check('admin: login entra na Visão geral (gate some)', (await p.locator('#gate').isHidden()) && /Visão geral|Pendências/i.test(await p.locator('body').innerText()));
  await p.screenshot({ path: saida('admin-1366-visaogeral'), fullPage: true });
  for (const [hash, esperado] of [
    ['#rede/pontos', /Pontos|Rede/],
    ['#contas/contas', /Contas/],
    ['#ofertas/precos', /Essencial|Pro|Prime/],
    ['#ofertas/promocoes', /Promo/],
    ['#financeiro/eventos', /Eventos do Checkout|Nenhum evento/i],
    ['#midiamostrai', /Mídia Mostraí/],
  ]) {
    await p.goto(`${BASE}/admin/${hash}`, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
    await p.waitForTimeout(1200);
    const texto = await p.locator('body').innerText().catch(() => '');
    check(`admin ${hash} renderiza`, esperado.test(texto), texto.slice(0, 120));
    const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(`admin ${hash}: sem rolagem horizontal`, overflow <= 1, `sobra ${overflow}px`);
  }
  await p.goto(`${BASE}/admin/#rede/pontos`, { waitUntil: 'networkidle' }).catch(() => {});
  await p.waitForTimeout(1200);
  await p.screenshot({ path: saida('admin-1366-rede'), fullPage: true });
  // Ficha do primeiro ponto e da primeira tela (só GET).
  const primeiroPonto = p.locator('a[href^="#rede/pontos/"]').first();
  if (await primeiroPonto.count()) {
    await primeiroPonto.click();
    await p.waitForTimeout(1500);
    const ficha = await p.locator('body').innerText().catch(() => '');
    check('admin: ficha do ponto sem "ID do Ponto #" nem chave em texto', !/ID do Ponto #/.test(ficha) && !/chaveAparelho/.test(ficha));
    await p.screenshot({ path: saida('admin-1366-ponto'), fullPage: true });
    const primeiraTela = p.locator('a.tela-card').first();
    if (await primeiraTela.count()) {
      await primeiraTela.click();
      await p.waitForTimeout(1500);
      const fichaTela = await p.locator('body').innerText().catch(() => '');
      // Tela ainda sem credencial mostra o bloco Player com "Preparar Player"
      // e Operação; Conexão/PIN só aparecem depois de preparada.
      check('admin: ficha da Tela nos blocos canônicos (Player / Operação; Conexão e PIN quando preparada)', /Preparar Player|Conex/.test(fichaTela) && /Opera/.test(fichaTela), fichaTela.slice(-300));
      check('admin: ficha da Tela não mostra o PIN em claro nem a chave', !/\b\d{4}\b(?=[^\n]*PIN)/.test(fichaTela.split('PIN de manutenção')[1] || '') && !/chaveAparelho/.test(fichaTela));
      await p.screenshot({ path: saida('admin-1366-tela'), fullPage: true });
    }
  }
  const mobile = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, extraHTTPHeaders: ACCESS_HEADERS, storageState: await ctx.storageState() });
  const pm = await mobile.newPage();
  await pm.goto(`${BASE}/admin/`, { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
  await pm.waitForTimeout(1500);
  const overflowM = await pm.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check('admin 390x844: sem rolagem horizontal', overflowM <= 1, `sobra ${overflowM}px`);
  await pm.screenshot({ path: saida('admin-390-visaogeral'), fullPage: true });
  await mobile.close();
  const reais = erros.filter((e) => !/maps\.googleapis|viacep|net::ERR_/.test(e));
  check('admin: sem erro de console', reais.length === 0, reais.slice(0, 3).join(' | '));
  await ctx.close();
} else {
  console.log('== admin: sem service token/credencial no ambiente — bloco pulado (Access provado fechado acima) ==');
}

await b.close();
console.log(`\nfalhas: ${falhas.length}${falhas.length ? `\n  - ${falhas.join('\n  - ')}` : ''}`);
process.exit(falhas.length ? 1 : 0);
