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
import { acompanharRede, irQuieto } from './espera.mjs';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
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
await irQuieto(p, `${B}/anunciante/login.html`);
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

// Saldo de Veiculação (27/09/2026): sem saldo o card fica escondido; com
// saldo, o TEMPO é o número principal e as exibições equivalentes (peça de
// hoje) vão na legenda. 30 h pendentes com peça de 15 s = 7.200 exibições.
check('sem saldo, o card do saldo fica escondido', await p.$eval('#kpiGrid [data-kpi="banco"]', (c) => c.hidden));
const contaId = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(
  `INSERT INTO criativos (anunciante_id, status, arquivo_normalizado_url, arquivo_original_url, duracao_segundos) VALUES (${contaId}, 'aprovado', '/e2e-saldo-inexistente.mp4', '/e2e-saldo-inexistente-orig.mp4', 15)`,
);
PG(
  `INSERT INTO banco_horas (anunciante_id, mes_referencia, exibicoes_pedidas, exibicoes_entregues, exibicoes_banco, segundos_obrigacao, segundos_entregues, segundos_banco, apurado_em) VALUES (${contaId}, '2026-08-01', 7200, 0, 7200, 108000, 0, 108000, now())`,
);
await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await p.waitForTimeout(1500);
const saldo = await p.$eval('#kpiGrid [data-kpi="banco"]', (c) => ({
  visivel: !c.hidden,
  rotulo: c.querySelector('.kpi-label').textContent,
  numero: c.querySelector('b').textContent,
  legenda: c.querySelector('[data-kpi-banco-legenda]').textContent,
}));
check('com saldo, o card aparece', saldo.visivel);
check('rótulo "Saldo de veiculação"', saldo.rotulo === 'Saldo de veiculação', saldo.rotulo);
check('tempo pendente é o número principal', /30\s*h pendentes/.test(saldo.numero), saldo.numero);
check('exibições equivalentes na legenda', /7\.200 exibições equivalentes \(peça de 15s\)/.test(saldo.legenda), saldo.legenda);
check('banco de horas continua único depois do saldo', (await contarBanco()) === 1);
const grid = await p.$('#kpiGrid');
await grid.screenshot({ path: new URL('./saida/10-saldo-de-veiculacao.png', import.meta.url).pathname });

check('sem erro de console', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
