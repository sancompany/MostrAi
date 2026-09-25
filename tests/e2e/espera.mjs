// Espera a página assentar SEM contar o SSE.
//
// `waitUntil: 'networkidle'` do Playwright espera 500 ms sem nenhuma
// requisição em voo — e o painel e o admin mantêm um EventSource aberto por
// desenho (public/eventos.js: /conta/eventos, /admin/eventos). Com o
// Playwright 1.56 o stream conta como em voo e a espera nunca termina: na
// rodada de 25/09/2026 os roteiros 05–18 paravam todos no mesmo `goto` do
// painel. A própria documentação do Playwright desaconselha `networkidle`.
// Aqui a regra é a mesma (500 ms sem requisição), menos o EventSource.

const pendentesPorPagina = new WeakMap();

function pendentes(pagina) {
  let s = pendentesPorPagina.get(pagina);
  if (!s) {
    s = new Set();
    pendentesPorPagina.set(pagina, s);
  }
  return s;
}

function paginaDa(requisicao) {
  try {
    return requisicao.frame().page();
  } catch {
    return null; // service worker e afins: sem página
  }
}

// Liga o acompanhamento em todo contexto que este navegador criar — chamar
// uma vez, no launch.
export function acompanharRede(navegador) {
  const criar = navegador.newContext.bind(navegador);
  navegador.newContext = async (...args) => {
    const ctx = await criar(...args);
    ctx.on('request', (r) => {
      if (r.resourceType() === 'eventsource') return;
      const p = paginaDa(r);
      if (p) pendentes(p).add(r);
    });
    const saiu = (r) => {
      const p = paginaDa(r);
      if (p) pendentes(p).delete(r);
    };
    ctx.on('requestfinished', saiu);
    ctx.on('requestfailed', saiu);
    return ctx;
  };
  return navegador;
}

export async function redeQuieta(pagina, { teto = 30000 } = {}) {
  await pagina.waitForLoadState('load', { timeout: teto });
  const s = pendentes(pagina);
  const inicio = Date.now();
  let calmaDesde = null;
  while (Date.now() - inicio < teto) {
    if (s.size) calmaDesde = null;
    else if (calmaDesde === null) calmaDesde = Date.now();
    else if (Date.now() - calmaDesde >= 500) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`rede não assentou em ${teto} ms: ${[...s].map((r) => r.url()).join(', ')}`);
}

export async function irQuieto(pagina, url, { timeout } = {}) {
  const resposta = await pagina.goto(url, timeout ? { timeout } : undefined);
  await redeQuieta(pagina, timeout ? { teto: timeout } : undefined);
  return resposta;
}

export async function recarregarQuieto(pagina) {
  const resposta = await pagina.reload();
  await redeQuieta(pagina);
  return resposta;
}
