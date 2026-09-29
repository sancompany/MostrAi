// Meus criativos — pausar e retomar (finalização, 28/09/2026):
//   · peça aprovada tem Pausar (modal Mostraí com a consequência) — confirmar
//     vira "Pausado" com Retomar, sem F5; cancelar não chama a rota;
//   · Retomar devolve a peça à programação, com feedback escrito;
//   · o que o admin retirou aparece "Fora do ar" com o motivo e sem Retomar;
//   · celular: sem rolagem lateral.
// Assume servidor na 3999 e o banco do .env.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) => p.screenshot({ path: `${SAIDA}criativos-pausa-${n}.png`, fullPage: true });

const marca = Date.now();
const email = `pausa-${marca}@teste.com`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: `Loja Pausa ${marca}`,
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
  `UPDATE anunciantes SET email_confirmado = true, plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${CONTA}`,
);
const IMG = '/img/favicon-192.png';
const criativo = (status, extra = '') =>
  PG(
    `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, duracao_segundos, status${extra ? ', retirado_por' : ''})
     VALUES (${CONTA}, 'x.png', '${IMG}', 10, '${status}'${extra ? `, '${extra}'` : ''}) RETURNING id`,
  ).split('\n')[0];
const APROVADA = criativo('aprovado');
const PELO_ADMIN = criativo('retirado', 'admin');

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
async function entrar(largura = 1280) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|404|409)/.test(m.text()) && !/net::|ERR_FAILED/.test(m.text()))
      erros.push(`console: ${m.text()}`);
  });
  p.on('dialog', (d) => {
    falha('diálogo nativo do navegador', d.message());
    d.dismiss().catch(() => {});
  });
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForSelector('#modCriativos:not([hidden]) .criativo-card', { timeout: 10000 });
  await p.evaluate(() => {
    window.__semReload = true;
  });
  return { p, ctx };
}

const { p, ctx } = await entrar();
const card = (id) => p.locator(`.criativo-card[data-id="${id}"]`);
const badge = (id) => card(id).locator('.badge').first().textContent();

console.log('== retirada pelo admin: fora do ar, com o motivo, sem Retomar ==');
check('rótulo "Fora do ar"', (await badge(PELO_ADMIN)) === 'Fora do ar', await badge(PELO_ADMIN));
check('explica que foi a Mostraí', /Retirada do ar pela Mostraí/.test(await card(PELO_ADMIN).textContent()));
check('sem Retomar nem Pausar', (await card(PELO_ADMIN).locator('[data-acao="retomar"], [data-acao="pausar"]').count()) === 0);

console.log('== pausar: modal, cancelar não chama, confirmar pausa sem F5 ==');
let posts = 0;
p.on('request', (r) => {
  if (r.method() === 'POST' && /\/criativos\/\d+\/(pausar|retomar)$/.test(r.url())) posts += 1;
});
check('peça aprovada oferece Pausar', (await card(APROVADA).locator('[data-acao="pausar"]').count()) === 1);
await card(APROVADA).locator('[data-acao="pausar"]').click();
await p.waitForSelector('dialog.dlg-confirmar[open] [data-confirmar]');
const modal = await p.textContent('dialog.dlg-confirmar[open]');
check('modal: título e consequência', /Pausar/.test(modal) && /Nada é apagado/.test(modal), modal);
await shot(p, 'modal');
await p.click('dialog.dlg-confirmar[open] [data-fechar]');
await p.waitForTimeout(300);
check('cancelar não chamou a rota', posts === 0);
check('cancelar: peça segue aprovada', PG(`SELECT status FROM criativos WHERE id = ${APROVADA}`) === 'aprovado');
await card(APROVADA).locator('[data-acao="pausar"]').click();
await p.waitForSelector('dialog.dlg-confirmar[open] [data-confirmar]');
await p.click('dialog.dlg-confirmar[open] [data-confirmar]');
await p.waitForFunction(
  (id) => /Pausado/.test(document.querySelector(`.criativo-card[data-id="${id}"] .badge`)?.textContent || ''),
  APROVADA,
  { timeout: 8000 },
);
check('POST /pausar chamado uma vez', posts === 1, String(posts));
check('rótulo "Pausado"', (await badge(APROVADA)) === 'Pausado');
check('explica que foi você', /Pausada por você/.test(await card(APROVADA).textContent()));
check('banco: retirado pelo cliente', PG(`SELECT status || '/' || retirado_por FROM criativos WHERE id = ${APROVADA}`) === 'retirado/cliente');
check('feedback escrito', /Peça pausada/.test(await p.textContent('#uploadMsg')));
check('agora oferece Retomar (e não Pausar)', (await card(APROVADA).locator('[data-acao="retomar"]').count()) === 1 && (await card(APROVADA).locator('[data-acao="pausar"]').count()) === 0);
await shot(p, 'pausada');

console.log('== retomar ==');
await card(APROVADA).locator('[data-acao="retomar"]').click();
await p.waitForFunction(
  (id) => !/Pausado/.test(document.querySelector(`.criativo-card[data-id="${id}"] .badge`)?.textContent || ''),
  APROVADA,
  { timeout: 8000 },
);
check('POST /retomar chamado', posts === 2, String(posts));
check('banco: aprovada de novo, sem marca', PG(`SELECT status || '/' || COALESCE(retirado_por, '-') FROM criativos WHERE id = ${APROVADA}`) === 'aprovado/-');
check('feedback escrito', /de volta na programação/.test(await p.textContent('#uploadMsg')));
check('Pausar de volta', (await card(APROVADA).locator('[data-acao="pausar"]').count()) === 1);
check('sem F5', await p.evaluate(() => window.__semReload === true));
await shot(p, 'retomada');
await ctx.close();

console.log('== celular ==');
{
  const { p: m, ctx: cm } = await entrar(390);
  check('celular: sem rolagem lateral', await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  check('celular: ações cabem no card', await m.$eval('#listaCriativos', (raiz) => {
    const lim = raiz.getBoundingClientRect().right + 1;
    return [...raiz.querySelectorAll('.criativo-acoes .btn')].every((el) => el.getBoundingClientRect().right <= lim);
  }));
  await shot(m, 'celular');
  await cm.close();
}

await b.close();
check('sem erro de console', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
