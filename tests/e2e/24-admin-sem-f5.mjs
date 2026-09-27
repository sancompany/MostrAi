// Estação Admin sem F5 (27/09/2026): loading/erro/retry do admin, no
// navegador, simulando as falhas pelo `page.route` do Playwright. O que o
// roteiro prova — sempre SEM page.reload():
//   · primeira leitura falha, a segunda funciona: erro → [Tentar novamente]
//     → dados (o bug que só o F5 resolvia);
//   · navegação rápida Visão geral → Rede → Contas → Ofertas → Mídia Mostraí
//     com a leitura da Rede LENTA: a resposta velha não pinta por cima;
//   · back/forward, rota direta e rota inválida;
//   · Atualizar várias vezes seguidas: uma tela só, sem duplicar;
//   · Atualizar que falha com dados na tela: os dados continuam, com aviso;
//   · vazio (200 + []) ≠ erro (500);
//   · Visão geral: falha da ocupação fica só no bloco dela;
//   · sessão do admin (401) e do Cloudflare Access (302) vencidas: pedem
//     entrar de novo, não "tentar de novo";
//   · entrar várias vezes na mesma tela: um clique = uma ação;
//   · prazo: leitura pendurada vira erro recuperável;
//   · campo de preço-base legível; texto da Mídia Mostraí.
// Assume servidor na 3999 (tests/e2e/restart.sh) e o banco do .env.
import { chromium } from 'playwright';

const B = 'http://localhost:3999';
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
const p = await ctx.newPage();
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (n) =>
  p.screenshot({ path: new URL(`./saida/admin-sem-f5-${n}.png`, import.meta.url).pathname, fullPage: false });
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Conta carregamentos de documento: qualquer reload/F5 dispara `load`
// (troca de hash não dispara — é navegação no mesmo documento).
let navegacoes = 0;
p.on('load', () => {
  navegacoes += 1;
});

await p.goto(`${B}/admin/index.html`);
await p.fill('#usuario', process.env.ADMIN_USER || 'admin');
await p.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await p.click('button[type=submit]');
await p.waitForSelector('.admin-shell');
await p.waitForSelector('#conteudo .visao-geral-colunas');
p.on('console', (m) => {
  // Os 500/401 simulados de propósito aparecem como erro de rede no console.
  if (m.type() === 'error' && !/status of (4\d\d|5\d\d)|falha ao|ocupação da rede|resumo/.test(m.text()))
    erros.push(m.text());
});
p.on('pageerror', (e) => erros.push(String(e)));
const navInicial = navegacoes;
const ir = (hash) => p.evaluate((h) => (location.hash = h), hash);
const titulo = () => p.textContent('#tituloSecao');

// Falha as próximas `n` respostas de `padrao` com `status` (depois deixa passar).
async function falharProximas(padrao, n, status = 500) {
  let restantes = n;
  await p.route(padrao, async (rota) => {
    if (restantes > 0) {
      restantes -= 1;
      return rota.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ erro: 'simulado' }) });
    }
    return rota.fallback();
  });
  return () => p.unroute(padrao);
}

console.log('== B18: primeira leitura falha, a segunda funciona — sem F5 ==');
{
  // 2 falhas = a leitura E a nova tentativa automática dela.
  const soltar = await falharProximas('**/admin/mensagens-contato', 2);
  await ir('mensagens/pendentes');
  await p.waitForSelector('#conteudo .erro-carga [data-tentar-de-novo]');
  check('erro aparece com [Tentar novamente]', true);
  check('não fica em "Carregando..."', !(await p.textContent('#abaConteudo')).includes('Carregando'));
  await shot('erro');
  await p.click('#conteudo [data-tentar-de-novo]');
  await p.waitForFunction(() => !document.querySelector('#conteudo .erro-carga'));
  check('Tentar novamente traz os dados', (await titulo()) === 'Mensagens');
  await soltar();
}

console.log('== vazio ≠ erro ==');
{
  await p.route('**/admin/mensagens-contato', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await ir('mensagens/historico');
  await p.waitForFunction(() => !document.querySelector('#abaConteudo')?.textContent.includes('Carregando'));
  const vazio = await p.textContent('#abaConteudo');
  check('200 + [] mostra vazio, sem erro', !(await p.$('#conteudo .erro-carga')), vazio.slice(0, 80));
  await p.unroute('**/admin/mensagens-contato');
  const soltar = await falharProximas('**/admin/mensagens-contato', 2);
  await p.click('#btnRecarregar');
  await p.waitForSelector('#conteudo .erro-carga');
  check('500 nunca vira "nenhum item"', !(await p.textContent('#conteudo')).match(/^Nenhum/m));
  await soltar();
}

console.log('== navegação rápida com a Rede lenta: resposta velha não pinta por cima ==');
{
  await p.route('**/admin/pontos**', async (rota) => {
    await esperar(1500);
    return rota.fallback().catch(() => {});
  });
  await ir('visaogeral');
  await ir('rede/pontos');
  await esperar(100);
  await ir('contas/contas');
  await esperar(100);
  await ir('ofertas/precos');
  await esperar(100);
  await ir('midiamostrai');
  await esperar(2500); // a leitura lenta da Rede já teria voltado
  check('título é o da última rota', (await titulo()) === 'Mídia Mostraí', await titulo());
  check('hash é o da última rota', (await p.evaluate(() => location.hash)) === '#midiamostrai');
  check('conteúdo da Rede não pintou por cima', !(await p.$('#conteudo .pontos-grade, #conteudo .rede-grade')));
  check('sem erro de leitura cancelada na tela', !(await p.$('#conteudo .erro-carga')));
  await p.unroute('**/admin/pontos**');

  await p.goBack();
  await p.waitForFunction(() => location.hash === '#ofertas/precos');
  await p.waitForSelector('.oferta-preco-base');
  check('voltar (back) abre Ofertas › Preços', (await titulo()) === 'Ofertas');
  await p.goForward();
  await p.waitForFunction(() => location.hash === '#midiamostrai');
  await p.waitForFunction(() => document.getElementById('tituloSecao').textContent === 'Mídia Mostraí');
  check('avançar (forward) volta pra Mídia Mostraí', true);
  check(
    'descrição nova da Mídia Mostraí',
    (await p.textContent('#subSecao')) === 'Conteúdo próprio e capacidade de veiculação da rede.',
    await p.textContent('#subSecao'),
  );
  await ir('rota-que-nao-existe');
  await p.waitForFunction(() => location.hash === '#visaogeral');
  check('rota inválida cai com segurança na Visão geral', (await titulo()) === 'Visão geral');
}

console.log('== Atualizar várias vezes: uma tela só; entrar várias vezes: um clique = uma ação ==');
{
  await ir('ofertas/precos');
  await p.waitForSelector('.oferta-preco-base');
  for (let i = 0; i < 4; i++) await p.click('#btnRecarregar');
  await p.waitForSelector('.oferta-preco-base');
  await esperar(800);
  check('uma fileira de abas só', (await p.$$('#conteudo .modulo-abas')).length === 1);
  check('um cartão por plano (nada duplicado)', (await p.$$('#conteudo .oferta-produto')).length === (await p.$$eval('#conteudo .oferta-produto', (e) => new Set(e.map((x) => x.dataset.produto)).size)));
  for (let i = 0; i < 3; i++) {
    await ir('visaogeral');
    await p.waitForSelector('#conteudo .visao-geral-colunas');
    await ir('contas/contas');
    await p.waitForFunction(() => !document.querySelector('#abaConteudo')?.textContent.includes('Carregando'));
  }
  await ir('visaogeral');
  await p.waitForSelector('#conteudo .visao-geral-colunas');
  await esperar(500);
  let leiturasResumo = 0;
  const contar = (r) => {
    if (r.url().includes('/admin/resumo')) leiturasResumo += 1;
  };
  p.on('request', contar);
  await p.click('#btnRecarregar');
  await p.waitForSelector('#conteudo .visao-geral-colunas');
  await esperar(800);
  p.off('request', contar);
  check('um clique em Atualizar = uma leitura', leiturasResumo === 1, String(leiturasResumo));
}

console.log('== Atualizar que falha com dados na tela: dados preservados ==');
{
  await ir('ofertas/precos');
  await p.waitForSelector('.oferta-preco-base');
  const soltar = await falharProximas('**/admin/resumo', 2);
  await p.click('#btnRecarregar');
  await p.waitForSelector('#conteudo .aviso-atualizacao');
  check('aviso de atualização falhou', (await p.textContent('#conteudo .aviso-atualizacao')).includes('Não foi possível atualizar'));
  check('os dados de antes continuam na tela', (await p.$$('#conteudo .oferta-produto')).length > 0);
  await shot('dados-preservados');
  await soltar();
  // Segunda falha seguida: os dados continuam (o aviso não conta como tela
  // em erro — revisão Codex do PR #81).
  const soltar2 = await falharProximas('**/admin/resumo', 2);
  await p.click('#conteudo .aviso-atualizacao [data-tentar-de-novo]');
  await p.waitForSelector('#conteudo .aviso-atualizacao');
  await esperar(300);
  check('segunda falha seguida: os dados continuam', (await p.$$('#conteudo .oferta-produto')).length > 0);
  check('um aviso só (não empilha)', (await p.$$('#conteudo .aviso-atualizacao')).length === 1);
  await soltar2();
  await p.click('#conteudo .aviso-atualizacao [data-tentar-de-novo]');
  await p.waitForFunction(() => !document.querySelector('#conteudo .aviso-atualizacao'));
  await p.waitForSelector('#conteudo .oferta-produto');
  check('Tentar novamente atualiza e tira o aviso', !(await p.$('#conteudo .aviso-atualizacao')));
}

console.log('== campo de preço-base legível ==');
{
  const cabe = await p.$eval('.oferta-preco-base', (i) => {
    i.value = '159.99';
    return i.scrollWidth <= i.clientWidth + 1;
  });
  check('"159,99" cabe no campo sem cortar', cabe);
  const caixa = await p.$eval('.oferta-preco-base', (i) => i.closest('.campo-moeda-caixa').textContent.replace(/\s+/g, ''));
  check('R$ … /mês ao redor do valor', caixa.startsWith('R$') && caixa.endsWith('/mês'), caixa);
  await (await p.$('.oferta-produto')).screenshot({ path: new URL('./saida/admin-sem-f5-preco.png', import.meta.url).pathname });
}

console.log('== Visão geral: falha da ocupação fica só no bloco ==');
{
  const soltar = await falharProximas('**/admin/pontos-ocupacao', 2);
  await ir('visaogeral');
  await p.waitForSelector('#ocupacaoRede .erro-carga [data-tentar-de-novo]');
  check('erro local no bloco de ocupação', true);
  check('o resto da Visão geral continua na tela', (await p.$$('#conteudo .coluna-negocio .panel')).length > 0);
  check('sem erro da tela inteira', !(await p.$('#conteudo > .erro-carga')));
  await shot('bloco-isolado');
  // Com o bloco em erro local, um Atualizar da tela que falha ainda
  // preserva a Visão geral (erro de bloco não é tela em erro).
  const soltarResumo = await falharProximas('**/admin/resumo', 2);
  await p.click('#btnRecarregar');
  await p.waitForSelector('#conteudo .aviso-atualizacao');
  check('Atualizar que falha com bloco em erro: Visão geral preservada', (await p.$$('#conteudo .coluna-negocio .panel')).length > 0);
  await soltarResumo();
  await soltar();
  await p.click('#ocupacaoRede [data-tentar-de-novo]');
  await p.waitForFunction(() => !document.querySelector('#ocupacaoRede .erro-carga'));
  check('Tentar novamente refaz só o bloco', !(await p.$('#ocupacaoRede .erro-carga')));
}

console.log('== prazo: leitura pendurada vira erro recuperável ==');
{
  await p.route('**/admin/categorias', () => {}); // nunca responde
  await ir('contas/categorias');
  await p.waitForSelector('#conteudo .erro-carga', { timeout: 30000 });
  check('não fica carregando pra sempre', (await p.textContent('#conteudo .erro-carga')).includes('demorou demais'));
  await p.unroute('**/admin/categorias');
  await p.click('#conteudo [data-tentar-de-novo]');
  await p.waitForFunction(() => !document.querySelector('#conteudo .erro-carga'));
  check('Tentar novamente carrega', true);
}

console.log('== sessão: Cloudflare Access (302) e admin (401) ==');
{
  await p.route('**/admin/resumo', (r) =>
    r.fulfill({ status: 302, headers: { location: 'https://exemplo.cloudflareaccess.com/login' } }),
  );
  await p.click('#btnRecarregar');
  await p.waitForSelector('#gate:not([hidden])');
  check('Access vencido: volta pro portão com "Entrar de novo"', !!(await p.$('#btnEntrarDeNovo')));
  check('explica que é a sessão de acesso', (await p.textContent('#gateMsg')).includes('sessão de acesso'));
  await shot('acesso-expirado');
  await p.unroute('**/admin/resumo');

  // Entra de novo pelo formulário (sessão do admin continua válida aqui).
  await p.fill('#usuario', process.env.ADMIN_USER || 'admin');
  await p.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
  await p.click('button[type=submit]');
  await p.waitForSelector('#app:not([hidden]) #conteudo .visao-geral-colunas, #app:not([hidden]) #conteudo .modulo-abas');
  check('entrou de novo sem recarregar a página', true);

  await p.route('**/admin/resumo', (r) => r.fulfill({ status: 401, contentType: 'application/json', body: '{"erro":"não autenticado"}' }));
  await p.click('#btnRecarregar');
  await p.waitForSelector('#gate:not([hidden])');
  check('401 do admin: volta pro login, sem retry infinito', (await p.textContent('#gateMsg')).includes('sessão do admin expirou'));
  await p.unroute('**/admin/resumo');
}

check('nenhum F5/reload durante o roteiro', navegacoes === navInicial, `${navInicial} → ${navegacoes}`);
check('sem erro inesperado no console', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
