// Sessão estável e upload confiável no painel do anunciante (estação de
// 27/09/2026). Assume servidor na 3999 subido com STORAGE_CAPTURA (o upload
// percorre multer → ffprobe → FFmpeg → banco → SSE de verdade, só o bucket é
// uma pasta local) e banco zerado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh STORAGE_CAPTURA=$PWD/tests/e2e/saida/storage
//   PW_CHROME=... node tests/e2e/25-sessao-e-upload.mjs
// Nenhum page.reload(): a página marca `window.__semReload` e o roteiro
// confere que a marca sobrevive.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const RAIZ = new URL('../..', import.meta.url).pathname;
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
let fase = 'início';
const etapa = (t) => {
  fase = t;
  console.log(t);
};
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (p, n) => p.screenshot({ path: `${SAIDA}sessao-upload-${n}.png`, fullPage: true });

// Mídia de teste gerada na hora (pequena: o que importa é o caminho, não o peso).
fs.mkdirSync(SAIDA, { recursive: true });
const MIDIA = {
  valido: path.join(SAIDA, 'e2e-valido.mp4'),
  longo: path.join(SAIDA, 'e2e-longo.mp4'),
  lixo: path.join(SAIDA, 'e2e-lixo.mp4'),
};
execSync(
  `ffmpeg -v error -y -f lavfi -i testsrc2=size=360x640:rate=30 -t 5 -c:v libx264 -preset ultrafast ${MIDIA.valido}`,
);
execSync(
  `ffmpeg -v error -y -f lavfi -i testsrc2=size=180x320:rate=15 -t 35 -c:v libx264 -preset ultrafast ${MIDIA.longo}`,
);
fs.writeFileSync(MIDIA.lixo, 'isto não é um vídeo');

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await navegador.newContext({ viewport: { width: 1280, height: 900 } });

const email = `sessao-${Date.now()}@teste.com`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Loja Sessão',
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999996666',
    senha: 'Senha123!',
    aceitou_termos: true,
    endereco: 'Rua Um, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
  }),
});
const CONTA = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(
  `UPDATE anunciantes SET email_confirmado = true, plano_id = 'maximo-1m', data_inicio_cobertura = now(),
   data_expiracao = now() + interval '20 days' WHERE id = ${CONTA}`,
);
const contarCriativos = () => Number(PG(`SELECT COUNT(*) FROM criativos WHERE anunciante_id = ${CONTA}`));
const limparCriativos = () => PG(`DELETE FROM criativos WHERE anunciante_id = ${CONTA}`);

function vigiar(p) {
  p.on('pageerror', (e) => erros.push(`[${fase}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    // Falhas provocadas pelo próprio roteiro (500/401/502/524 simulados,
    // rede cortada) e a mídia que a pasta de captura não serve.
    if (/status of (400|401|404|500|502|524)|ERR_FAILED|e2e-storage|net::/.test(m.text())) return;
    // Só nas fases que provocam falha de propósito: o 503 simulado (B2), a
    // lista que o roteiro derruba (C) e a sessão apagada (E: os módulos
    // recebem 401 e a ida pro login cancela leituras em voo). Fora delas,
    // essas mesmas mensagens contam como erro.
    if (
      /SESSÃO B2|UPLOAD C|SESSÃO E/.test(fase) &&
      /status of 503|falha ao carregar os criativos/.test(m.text())
    )
      return;
    erros.push(`[${fase}] console: ${m.text()}`);
  });
  return p;
}

async function entrar() {
  const p = vigiar(await ctx.newPage());
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForSelector('#statusBanner .hero-kicker', { timeout: 10000 });
  return p;
}
const marcarSemReload = (p) =>
  p.evaluate(() => {
    window.__semReload = true;
  });
const semReload = (p) => p.evaluate(() => window.__semReload === true);
const voltarPraAba = (p) =>
  p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
const meStatus = (p) =>
  p.evaluate(async () => (await fetch('/anunciantes/me', { credentials: 'include' })).status);

// ===========================================================================
etapa('== SESSÃO A/G: login normal, navegação repetida, perfil, espera ==');
let p = await entrar();
check('A. login normal abre o painel', (await p.textContent('#statusBanner')).includes('Sua conta'));
await p.click('a[href="/planos.html"]');
await p.waitForURL(/planos\.html/);
await p.click('#navanunciante');
await p.waitForURL(/painel\.html/);
await p.waitForSelector('#statusBanner .hero-kicker');
await p.click('#btnPerfil');
check('perfil abre', await p.isVisible('#dlgPerfil[open]'));
await p.click('#btnFecharPerfil');
await p.click('a[href="/planos.html"]');
await p.waitForURL(/planos\.html/);
await p.goBack();
await p.waitForSelector('#statusBanner .hero-kicker');
await espera(2000);
check('G. depois de navegar e esperar, a conta segue logada', (await meStatus(p)) === 200);
check('G. sem ter voltado pro login', /painel\.html/.test(p.url()));

etapa('== SESSÃO H: entrar no ADMIN no mesmo navegador não derruba o anunciante (o bug) ==');
await marcarSemReload(p);
const admin = await ctx.request.post(`${B}/admin/login`, { data: { usuario: 'admin', senha: 'Admin12@teste' } });
check('admin entra no mesmo navegador', admin.status() === 200);
await voltarPraAba(p); // o resync que antes recebia 401 e ia pro login
await espera(1500);
check('H. volta pra aba do painel: continua no painel', /painel\.html/.test(p.url()));
check('H. conta continua logada (antes: 401)', (await meStatus(p)) === 200);
check('H. admin continua logado também', (await ctx.request.get(`${B}/admin/resumo`)).status() === 200);
check('H. resync sem reload', await semReload(p));
await ctx.request.post(`${B}/admin/logout`);
check('sair do admin não sai da conta', (await meStatus(p)) === 200);

etapa('== SESSÃO F: reinício do servidor (sessão no Postgres) ==');
execSync(`bash ${RAIZ}tests/e2e/restart.sh STORAGE_CAPTURA=${SAIDA}storage`);
await voltarPraAba(p);
await espera(2500);
check('F. depois do restart a conta segue logada', (await meStatus(p)) === 200);
check('F. e o painel não mandou pro login', /painel\.html/.test(p.url()));
await p.close();

// Uma página nova por caso: a primeira leitura de /anunciantes/me falha do
// jeito pedido; as seguintes passam.
async function aberturaComFalha(nome, falhar) {
  const q = vigiar(await ctx.newPage());
  let primeira = true;
  await q.route('**/anunciantes/me', async (route) => {
    if (primeira && route.request().method() === 'GET') {
      primeira = false;
      return falhar(route);
    }
    return route.continue();
  });
  await q.goto(`${B}/anunciante/painel.html`);
  const achou = await q.waitForSelector('#btnTentarConta', { timeout: 30000 }).catch(() => null);
  if (!achou) {
    falha(`${nome}: botão [Tentar novamente] não apareceu`, (await q.textContent('#statusBanner')).trim().slice(0, 120));
    await q.close();
    return;
  }
  check(`${nome}: mostra "Não foi possível carregar sua conta agora"`, (await q.textContent('#erroConta')).includes('Não foi possível carregar sua conta agora'));
  check(`${nome}: NÃO desloga`, /painel\.html/.test(q.url()));
  await q.evaluate(() => {
    window.__semReload = true;
  });
  await q.click('#btnTentarConta');
  await q.waitForSelector('#statusBanner .hero-kicker', { timeout: 10000 });
  check(`${nome}: [Tentar novamente] carrega a conta sem F5`, await semReload(q));
  await q.close();
}

etapa('== SESSÃO B/C/D: 500, rede e prazo na abertura não deslogam ==');
await aberturaComFalha('B. 500 transitório', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"erro":"erro interno"}' }));
await aberturaComFalha('D. rede caiu', (r) => r.abort('failed'));
await aberturaComFalha('C. prazo (20 s sem resposta)', () => {}); // nunca responde

etapa('== SESSÃO B2: recarga em segundo plano com 500 mantém a tela ==');
p = await entrar();
await marcarSemReload(p);
await p.route('**/anunciantes/me', (r) => r.fulfill({ status: 503, body: 'indisponível' }));
await voltarPraAba(p);
await espera(1500);
check('B2. resync com 503: tela continua (hero)', await p.isVisible('#statusBanner .hero-kicker'));
check('B2. e não foi pro login', /painel\.html/.test(p.url()) && (await semReload(p)));
await p.unroute('**/anunciantes/me');

// ===========================================================================
etapa('== UPLOAD A: envio válido cria exatamente 1 criativo, card aparece sem F5 ==');
await p.waitForSelector('#modCriativos:not([hidden])');
// I. Segunda aba na mesma conta: recebe o card pelo SSE, sem F5.
const outra = vigiar(await ctx.newPage());
await irQuieto(outra, `${B}/anunciante/painel.html`);
await outra.waitForSelector('#modCriativos:not([hidden])');
await outra.evaluate(() => {
  window.__semReload = true;
});
const msg = () => p.textContent('#uploadMsg');
const esperarMsg = (re, teto = 30000) =>
  p.waitForFunction((r) => new RegExp(r).test(document.getElementById('uploadMsg').textContent), re.source, {
    timeout: teto,
  });
await p.evaluate(() => {
  const el = document.getElementById('uploadMsg');
  window.__msgs = [];
  new MutationObserver(() => window.__msgs.push(el.textContent)).observe(el, {
    childList: true,
    characterData: true,
    subtree: true,
  });
});
const inicioA = Date.now();
await p.setInputFiles('#arquivoCriativo', MIDIA.valido);
await esperarMsg(/Criativo enviado!/);
const totalA = Date.now() - inicioA;
const sequencia = await p.evaluate(() => window.__msgs);
check(
  'A. estados na ordem: ENVIANDO → PROCESSANDO → ENVIADO',
  /Enviando/.test(sequencia[0] || '') &&
    sequencia.some((m) => /Processando o vídeo/.test(m)) &&
    /Criativo enviado!/.test(sequencia.at(-1)),
  sequencia.join(' | '),
);
check('A. mensagem "Criativo enviado!"', (await msg()).includes('Criativo enviado!'));
check('A. exatamente 1 criativo', contarCriativos() === 1, contarCriativos());
await p.waitForSelector('.criativo-card');
check('A. card aparece na lista sem F5', (await p.$$('.criativo-card')).length === 1 && (await semReload(p)));
await outra.waitForSelector('.criativo-card', { timeout: 10000 }).catch(() => null);
check('I. a OUTRA aba recebe o card pelo SSE, sem F5', (await outra.$$('.criativo-card')).length === 1 && (await outra.evaluate(() => window.__semReload === true)));
const refreshMs = await p.evaluate(() => window.__tempoRefreshCriativosMs);
console.log(`  (medida) TOTAL_UPLOAD_MS no navegador: ${totalA} · FRONT_REFRESH_MS: ${refreshMs}`);
await shot(p, 'upload-ok');
limparCriativos();

// Interceptar o POST do upload (o GET da lista passa direto).
async function interceptarUpload(fn) {
  // `fallback`, não `continue`: o GET da lista segue para a próxima rota
  // registrada (a que simula a lista falhando, no caso C).
  await p.route('**/anunciantes/*/criativos', (route) =>
    route.request().method() === 'POST' ? fn(route) : route.fallback(),
  );
}
const soltarUpload = () => p.unroute('**/anunciantes/*/criativos');

// O Playwright não entrega o corpo multipart com o arquivo na interceptação
// (vem truncado), então `route.fetch()` não serve pra "deixar o servidor
// processar e trocar a resposta". Este encaminhador faz o envio REAL pelo
// Node — mesmo arquivo, mesmo cookie de sessão, mesma Idempotency-Key que o
// painel gerou — e devolve a resposta; o roteiro decide o que o navegador vê
// (a resposta com atraso, um 524 do proxy, a conexão caindo).
async function encaminhar(route, arquivo = MIDIA.valido) {
  const cookie = (await ctx.cookies(B))
    .filter((c) => c.path === '/')
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  const form = new FormData();
  form.append('arquivo', new Blob([fs.readFileSync(arquivo)], { type: 'video/mp4' }), path.basename(arquivo));
  const r = await fetch(route.request().url(), {
    method: 'POST',
    headers: { cookie, 'idempotency-key': route.request().headers()['idempotency-key'] },
    body: form,
  });
  return { status: r.status, contentType: 'application/json', body: await r.text() };
}

etapa('== UPLOAD B: processamento demorado mostra progresso, não erro ==');
await interceptarUpload(async (route) => {
  const resposta = await encaminhar(route);
  await espera(4000);
  await route.fulfill(resposta);
});
await p.setInputFiles('#arquivoCriativo', MIDIA.valido);
await espera(2500);
check(
  'B. durante a espera: enviando/processando, nunca erro',
  /Enviando o arquivo|Processando o vídeo/.test(await msg()) && !/Não foi possível/.test(await msg()),
  await msg(),
);
await esperarMsg(/Criativo enviado!/);
check('B. termina em "Criativo enviado!"', true);
await soltarUpload();
check('B. 1 criativo', contarCriativos() === 1);
limparCriativos();

etapa('== UPLOAD D: 524 da Cloudflare DEPOIS de o servidor concluir — o bug de produção ==');
await interceptarUpload(async (route) => {
  await encaminhar(route); // o servidor processa e cria
  await route.fulfill({ status: 524, contentType: 'text/html', body: '<html><h1>524 A timeout occurred</h1></html>' });
});
await p.setInputFiles('#arquivoCriativo', MIDIA.valido);
await esperarMsg(/Criativo enviado!|não foi concluído|Não conseguimos confirmar/);
check('D. NÃO diz "Não foi possível enviar"', !/Não foi possível enviar/.test(await msg()), await msg());
check('D. reconcilia e diz "Criativo enviado!"', (await msg()).includes('Criativo enviado!'), await msg());
check('D. exatamente 1 criativo (sem duplicata)', contarCriativos() === 1, contarCriativos());
await soltarUpload();
await shot(p, 'upload-524-reconciliado');
limparCriativos();

etapa('== UPLOAD D2: conexão cai depois do commit ==');
await interceptarUpload(async (route) => {
  await encaminhar(route);
  await route.abort('connectionreset');
});
await p.setInputFiles('#arquivoCriativo', MIDIA.valido);
await esperarMsg(/Criativo enviado!|não foi concluído|Não conseguimos confirmar/);
check('D2. reconcilia e diz "Criativo enviado!"', (await msg()).includes('Criativo enviado!'), await msg());
check('D2. exatamente 1 criativo', contarCriativos() === 1);
await soltarUpload();
limparCriativos();

etapa('== UPLOAD E: nada chegou (rede caiu antes) — "não concluído", [Tentar de novo] com a MESMA chave ==');
const chaves = [];
await interceptarUpload(async (route) => {
  chaves.push(route.request().headers()['idempotency-key']);
  await route.abort('failed');
});
await p.setInputFiles('#arquivoCriativo', MIDIA.valido);
await esperarMsg(/não foi concluído/);
check('E. diz "O envio não foi concluído" (verdade: nada foi criado)', contarCriativos() === 0);
check('E. oferece [Tentar de novo]', await p.isVisible('#uploadAcao'));
await soltarUpload();
await p.route('**/anunciantes/*/criativos', (route) => {
  if (route.request().method() === 'POST') chaves.push(route.request().headers()['idempotency-key']);
  return route.continue();
});
await p.click('#uploadAcao');
await esperarMsg(/Criativo enviado!/);
check('E. tentar de novo usa a MESMA chave', chaves.length === 2 && chaves[0] === chaves[1], chaves.join(' / '));
check('E. exatamente 1 criativo', contarCriativos() === 1);
// Repetir a MESMA tentativa (mesma chave) de novo, direto: não duplica.
const repetido = await p.evaluate(
  async ({ conta, chave }) => {
    const form = new FormData();
    form.append('arquivo', new Blob(['x'], { type: 'video/mp4' }), 'x.mp4');
    const r = await fetch(`/anunciantes/${conta}/criativos`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Idempotency-Key': chave },
      body: form,
    });
    return r.status;
  },
  { conta: CONTA, chave: chaves[0] },
);
check('E. repetir a mesma tentativa devolve o existente (200)', repetido === 200, repetido);
check('E. continua 1 criativo', contarCriativos() === 1);
await soltarUpload();
limparCriativos();

etapa('== UPLOAD C: upload concluído + lista que falha ≠ "envio falhou" ==');
// A lista passa a falhar exatamente quando a resposta do envio volta (e o
// SSE que chega no meio não consome a falha): quem desenha a mensagem é a
// atualização que vem DEPOIS do upload concluído.
let listaFalha = false;
await p.route('**/anunciantes/me/criativos', (route) =>
  listaFalha ? route.fulfill({ status: 500, body: '{}' }) : route.continue(),
);
await interceptarUpload(async (route) => {
  const resposta = await encaminhar(route);
  listaFalha = true;
  await route.fulfill(resposta);
});
await p.setInputFiles('#arquivoCriativo', MIDIA.valido);
await esperarMsg(/Não conseguimos atualizar a lista agora/);
check('C. diz que ENVIOU', (await msg()).includes('Criativo enviado!'), await msg());
check('C. e que só a lista não atualizou', (await msg()).includes('Não conseguimos atualizar a lista agora'));
check('C. nunca "Não foi possível enviar"', !/Não foi possível enviar/.test(await msg()));
check('C. 1 criativo', contarCriativos() === 1);
listaFalha = false;
await p.click('#uploadAcao');
await p.waitForSelector('.criativo-card');
check('C. [Atualizar lista] traz o card', (await p.$$('.criativo-card')).length === 1);
await p.unroute('**/anunciantes/me/criativos');
await soltarUpload();
limparCriativos();

etapa('== UPLOAD F/G/H: erros reais continuam erros reais, sem registro residual ==');
await p.setInputFiles('#arquivoCriativo', MIDIA.lixo);
await esperarMsg(/Não foi possível ler esse arquivo|não foi possível ler esse arquivo/i);
check('F. arquivo inválido: mensagem do servidor', /ler esse arquivo/i.test(await msg()), await msg());
check('F. nenhum registro residual', contarCriativos() === 0);

await interceptarUpload((route) =>
  route.fulfill({
    status: 502,
    contentType: 'application/json',
    body: JSON.stringify({
      erro: 'o problema foi nosso: o armazenamento não respondeu agora. Tente de novo em alguns minutos — o seu arquivo está ok',
    }),
  }),
);
await p.setInputFiles('#arquivoCriativo', MIDIA.valido);
await esperarMsg(/armazenamento não respondeu/i);
check('G. storage 502: mensagem certa (o problema foi nosso)', /armazenamento não respondeu/i.test(await msg()));
check('G. nenhum criativo', contarCriativos() === 0);
await soltarUpload();

await p.setInputFiles('#arquivoCriativo', MIDIA.longo);
await esperarMsg(/até 30s/);
check('H. vídeo de 35 s num plano de 30 s: bloqueio continua', /seu plano aceita peça de até 30s/i.test(await msg()), await msg());
check('H. nenhum criativo', contarCriativos() === 0);
check('upload inteiro sem F5', await semReload(p));
await shot(p, 'upload-erros-reais');

etapa('== SESSÃO E: 401 de verdade (sessão apagada no servidor) ==');
PG(`DELETE FROM session WHERE sess->>'anuncianteId' = '${CONTA}'`);
await voltarPraAba(p);
await p.waitForURL(/login\.html\?expirou=1/, { timeout: 10000 }).catch(() => null);
check('E. sessão realmente expirada vai pro login', /login\.html\?expirou=1/.test(p.url()), p.url());
check('E. com o aviso "Sua sessão expirou"', ((await p.textContent('#msg')) || '').includes('Sua sessão expirou'));
await espera(2000);
check('E. sem loop (continua no login)', /login\.html/.test(p.url()));
await shot(p, 'sessao-expirada');

await navegador.close();
console.log(`\nerros de console/página: ${erros.length}`);
for (const e of erros) console.log('  ', e);
if (falhas.length || erros.length) {
  console.log(`\n${falhas.length} FALHA(S)`);
  process.exit(1);
}
console.log('\nTUDO OK');
