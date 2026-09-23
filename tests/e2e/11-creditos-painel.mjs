// Créditos e benefícios na rota real (/anunciante/painel.html), Fatia 1.
// Conta sem plano (dashboard bloqueado) enxerga o módulo, resgata com
// preview "agora → ativado → depois", e o painel destrava sem F5. A página
// antiga do ponto não pode mais mostrar o cupom de indicação.
// Assume servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const falhas = [];
const erros = [];
const respostasRuins = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) =>
  p.screenshot({ path: new URL(`./saida/creditos-${n}.png`, import.meta.url).pathname, fullPage: true });

const email = `creditos-${Date.now()}@teste.com`;
const senha = 'Senha123!';
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Teste Créditos',
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999998888',
    senha,
    aceitou_termos: true,
    endereco: 'Rua Teste, 123',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
  }),
});
const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao) VALUES (${id}, 'concessao_admin', 12, 'e2e')`);

const p = await ctx.newPage();
p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
p.on('console', (m) => {
  if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
});
p.on('response', (r) => {
  if (r.status() >= 400 && r.url().startsWith(B)) respostasRuins.push(`${r.status()} ${r.url()}`);
});
await p.goto(`${B}/anunciante/login.html`, { waitUntil: 'networkidle' });
await p.fill('#email', email);
await p.fill('#senha', senha);
await p.click('button[type="submit"]');
await p.waitForURL(/painel\.html/, { timeout: 10000 });
await p.waitForSelector('#modCreditos:not([hidden])', { timeout: 10000 });
await p.waitForTimeout(800);
await shot(p, '1-sem-plano');

check('conta sem plano vê o painel bloqueado', !!(await p.$('#bloqueioPlano')));
for (let i = 0; i < 3; i++) {
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(400);
}
await p.waitForTimeout(600);
check('resync não empilha cards de bloqueio', (await p.$$('#bloqueioPlano')).length === 1, `${(await p.$$('#bloqueioPlano')).length}`);
check('e ainda assim vê Créditos e benefícios', await p.isVisible('#modCreditos'));
check('saldo mostra os 12 créditos', (await p.textContent('#creditosSaldo')).trim() === '12');
const link = await p.textContent('#creditosIndicacao code');
check('link de indicação próprio da conta', /cadastro\.html\?ref=PT-/.test(link), link);
check('tabela com 3 planos × 4 períodos', (await p.$$('.creditos-tabela tbody td')).length === 12);
check(
  'botões só onde o saldo alcança (3, 7, 9, 10)',
  (await p.$$('[data-acao="resgatar"]')).length === 4,
  `vieram ${(await p.$$('[data-acao="resgatar"]')).length}`,
);
const texto = await p.textContent('body');
check('nenhum resquício do modelo antigo', !/indicados pagantes|de graça/i.test(texto));

await p.click('[data-acao="resgatar"][data-tier="essencial"][data-meses="3"]');
await p.waitForSelector('#dlgResgate[open]');
const preview = await p.textContent('#previewResgate');
check('preview mostra o agora', /Agora[\s\S]*Sem plano ativo/.test(preview), preview);
check('preview mostra o que será ativado', /Será ativado[\s\S]*Essencial por 3 meses/.test(preview), preview);
check('preview mostra o depois', /Depois[\s\S]*termina/.test(preview), preview);
check('preview mostra o saldo antes e depois', /12 créditos[\s\S]*3 créditos/.test(preview), preview);
await shot(p, '2-preview');
await p.click('#btnConfirmarResgate');
await p.waitForFunction(() => !document.getElementById('dlgResgate').open, null, { timeout: 10000 });
await p.waitForTimeout(1500);

check('saldo cai para 3 sem recarregar', (await p.textContent('#creditosSaldo')).trim() === '3');
check('benefício aparece em vigor', /Em vigor[\s\S]*Essencial/.test(await p.textContent('#creditosSituacao')));
check('com benefício aberto, nenhum botão de resgate', (await p.$$('[data-acao="resgatar"]')).length === 0);
check('dashboard destravou sem F5', !(await p.$('#bloqueioPlano')));
await shot(p, '3-apos-resgate');

for (let i = 0; i < 3; i++) {
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(400);
}
await p.waitForTimeout(800);
check('resync não duplica linhas da tabela', (await p.$$('.creditos-tabela tbody tr')).length === 3);
check('resync não duplica o histórico', (await p.$$('.creditos-movimentos li')).length === 2);

await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(400);
const larguraExtra = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const culpados = await p.evaluate(() =>
  [...document.querySelectorAll('body *')]
    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1 && el.offsetParent !== null)
    .filter((el) => ![...el.children].some((f) => f.getBoundingClientRect().right > window.innerWidth + 1))
    .slice(0, 5)
    .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${[...el.classList].join('.')}`),
);
check('celular: a página não rola na horizontal', larguraExtra <= 1, `${larguraExtra}px sobrando: ${culpados.join(', ')}`);
await shot(p, '4-celular');

await p.goto(`${B}/anunciante/ponto.html`, { waitUntil: 'networkidle' });
const ponto = await p.textContent('body');
check('página do ponto sem o cupom antigo', !/Meu cupom de indicação|indicados pagantes/.test(ponto));

check('sem erro de console', erros.length === 0, erros.join(' | '));
check('nenhuma resposta 4xx/5xx inesperada', respostasRuins.length === 0, respostasRuins.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
