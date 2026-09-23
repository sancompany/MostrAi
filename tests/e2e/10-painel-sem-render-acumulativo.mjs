// Regressão: o painel não pode empilhar cards a cada resync do SSE.
//
// O bug (achado em produção pelo dono, 23/09/2026): `carregarBancoHoras()`
// criava o card com `insertAdjacentHTML('beforeend')` num `#kpiGrid` que
// ninguém limpava. Enquanto `carregar()` rodava uma vez por página isso não
// aparecia — mas a Fase 3 (SSE) registrou `carregar` em quatro eventos, e
// `resincronizarTudo()` dispara todos os handlers a cada `visibilitychange`.
// Resultado: cada volta pra aba empilhava quatro cópias de "Banco de horas".
//
// Duas correções, testadas aqui: card com lugar fixo no HTML (idempotente por
// construção) e dedupe por função no resync (a mesma `carregar` assinada em
// quatro eventos roda uma vez, não quatro).
//
// Assume banco zerado e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));

const email = `acumulativo-${Date.now()}@teste.com`;
const senha = 'Senha123!';
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Teste Render Acumulativo',
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
PG(`UPDATE anunciantes SET email_confirmado = true WHERE contato_email = '${email}'`);
// Plano de cortesia: sem plano o painel mostra o card de bloqueio e nem chega
// a carregar os KPIs, que é justamente o que este teste observa.
const plano = PG(`SELECT id FROM planos WHERE ativo = true ORDER BY id LIMIT 1`);
PG(`UPDATE anunciantes SET plano_id = '${plano}', plano_cortesia = true WHERE contato_email = '${email}'`);

const p = await ctx.newPage();
p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
p.on('console', (m) => {
  if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
});
await p.goto(`${B}/anunciante/login.html`, { waitUntil: 'networkidle' });
await p.fill('#email', email);
await p.fill('#senha', senha);
await p.click('button[type="submit"]');
await p.waitForURL(/painel\.html/, { timeout: 10000 });
await p.waitForTimeout(1500);

const contarCards = () => p.$$eval('#kpiGrid .kpi-card', (n) => n.length);
const contarBanco = () => p.$$eval('#kpiGrid [data-kpi="banco"]', (n) => n.length);
const contarErros = () => p.$$eval('#statusBanner .form-msg', (n) => n.length);

const cardsAntes = await contarCards();
check('grid começa com o conjunto fixo de cards', cardsAntes > 0, `veio ${cardsAntes}`);
check('banco de horas tem um lugar só no grid', (await contarBanco()) === 1, 'card fixo deveria existir uma vez');

// Cinco resyncs: é o que o dono fez sem perceber, alternando de aba.
for (let i = 0; i < 5; i++) {
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await p.waitForTimeout(400);
}
await p.waitForTimeout(1200);

const cardsDepois = await contarCards();
check(
  'nenhum card novo depois de 5 resyncs',
  cardsDepois === cardsAntes,
  `antes ${cardsAntes}, depois ${cardsDepois}`,
);
check('banco de horas continua único', (await contarBanco()) === 1, `veio ${await contarBanco()}`);
check('nenhuma mensagem de erro empilhada no banner', (await contarErros()) === 0, `veio ${await contarErros()}`);

// O dedupe do resync: `carregar` está em quatro eventos e deve rodar uma vez
// por resync, não quatro. Conta as buscas de exibições de um resync só.
let buscas = 0;
p.on('request', (r) => {
  if (/\/exibicoes/.test(r.url())) buscas++;
});
await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await p.waitForTimeout(1500);
check('resync busca exibições uma vez, não uma por evento', buscas <= 1, `foram ${buscas} buscas`);

check('sem erro de console', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
