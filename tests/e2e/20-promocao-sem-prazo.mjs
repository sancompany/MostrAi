// Promoção sem prazo no admin (26/09/2026): o San Checkout não altera o valor
// de uma assinatura de cartão já paga, então a tela não pode prometer "N
// meses de desconto e depois volta ao preço normal".
//
//   Ofertas → Promoções → + Nova promoção → sem campo de duração, com a
//   condição fixa "Enquanto a assinatura permanecer ativa" → janela de compra
//   explicada como "só adesões novas" → resumo lateral "Benefício" → salvar
//   → card da lista com "Benefício" → nenhum texto de volta/reajuste.
//
// Assume servidor na 3999 (restart.sh). Não depende de banco zerado.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const falhas = [];
const check = (t, cond, d) => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : d || '');
  if (!cond) falhas.push(t);
};
const PROIBIDO = /volta(r)? ao preço|preço normal depois|reajuste automático|meses de desconto|válido por \d+ m|Duração da condição/i;

const nome = `e2e-sem-prazo-${Date.now()}`;
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const admin = await (await b.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
const erros = [];
admin.on('pageerror', (e) => erros.push(e.message));
admin.on('console', (m) => {
  if (m.type() === 'error' && !/status of 40[0149]/.test(m.text())) erros.push(m.text());
});

console.log('== login admin → Promoções ==');
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

console.log('== formulário ==');
check('sem campo de duração', (await admin.locator('[name="duracao_beneficio_meses"], #pDuracao').count()) === 0);
const condicao = await admin.textContent('#promoCondicaoPreco');
check('condição fixa: "Enquanto a assinatura permanecer ativa"', /Enquanto a assinatura permanecer ativa/.test(condicao));
check(
  'texto auxiliar da condição',
  /mantém o preço promocional enquanto essa assinatura permanecer ativa/.test(condicao) &&
    /valerá o preço vigente na nova contratação/.test(condicao),
);
check('condição não é campo editável', (await admin.locator('#promoCondicaoPreco input, #promoCondicaoPreco select').count()) === 0);
const janela = await admin.getByRole('group', { name: 'Janela de compra' }).textContent();
check('janela mantém Começa em / Termina em', (await admin.locator('#pInicio').count()) === 1 && (await admin.locator('#pFim').count()) === 1);
check('janela explicada como "só adesões novas"', /até quando entram adesões novas/.test(janela));
check('limite de adesões continua', (await admin.locator('#pLimite').count()) === 1);
check('público elegível continua', (await admin.locator('[name="publico_elegivel"]').count()) === 3);

await admin.fill('#pNomeInterno', nome);
await admin.fill('#pTitulo', 'Promoção e2e sem prazo');
await admin.fill('#pFim', '2099-10-31T23:59');
await admin.fill('#pLimite', '50');
await admin.check('input[data-item-tier="destaque"][data-item-meses="3"]', { force: true });
await admin.fill('input[data-item-desconto][data-item-tier="destaque"][data-item-meses="3"]', '15');
await admin.dispatchEvent('#formPromocao', 'input');
await admin.waitForFunction(() => /Benefício/.test(document.querySelector('#promoResumo')?.textContent || ''));
const resumo = await admin.textContent('#promoResumo');
check('resumo: "Benefício: enquanto a assinatura permanecer ativa"', /Benefícioenquanto a assinatura permanecer ativa/.test(resumo), resumo);
check('resumo sem "Duração"', !/Duração/.test(resumo), resumo);
check('resumo mantém desconto e público', /Desconto15%/.test(resumo.replace(/\s/g, '')) && /Público/.test(resumo), resumo);
const textoForm = await admin.textContent('#formPromocao');
check('formulário sem frase de volta ao preço/reajuste/prazo', !PROIBIDO.test(textoForm), textoForm.match(PROIBIDO)?.[0]);
await admin.screenshot({ path: `${SAIDA}20-promocao-form.png`, fullPage: true });

console.log('== salvar → card da lista ==');
await admin.check('input[name="status"][value="rascunho"]', { force: true });
await admin.click('#btnSalvarPromocao');
await admin.waitForFunction((n) => document.body.textContent.includes('Promoção e2e sem prazo') && !document.querySelector('#formPromocao'), nome, {
  timeout: 8000,
});
const id = PG(`SELECT id FROM promocoes WHERE nome_interno = '${nome}'`);
check('promoção salva com janela e limite', PG(`SELECT (compra_fim IS NOT NULL AND limite_adesoes = 50)::text FROM promocoes WHERE id = ${id}`) === 'true');
const card = await admin.textContent(`[data-promocao="${id}"]`);
check('card: "Benefício enquanto a assinatura permanecer ativa"', /Benefício\s*enquanto a assinatura permanecer ativa/.test(card), card);
check('card sem "Duração"/"meses de desconto"', !PROIBIDO.test(card) && !/Duração/.test(card), card);
await admin.screenshot({ path: `${SAIDA}20-promocao-lista.png`, fullPage: true });

check('sem erro de console', erros.length === 0, erros.join(' | '));
PG(`DELETE FROM promocoes WHERE id = ${id}`);
await b.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
