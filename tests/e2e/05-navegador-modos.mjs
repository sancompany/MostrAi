// Painel único no navegador: conta só-vendedor vê Anúncios e Meu ponto
// bloqueados com card de ativação; ativa anúncios pelo card; pede ponto;
// admin libera; bônus aparece. Assume banco zerado e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) => execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctxAdmin = await b.newContext({ viewport: { width: 1280, height: 900 } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const falhas = []; const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => { console.log('  FALHA', t, d || ''); falhas.push(t); };
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
async function pagina(url, contexto = ctx) {
  const p = await contexto.newPage();
  p.on('pageerror', (e) => erros.push(`${url}: ${e.message}`));
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`${url} console: ${m.text()}`); });
  p.on('dialog', async (d) => d.accept(d.defaultValue()));
  await p.goto(B + url, { waitUntil: 'networkidle' });
  return p;
}
const shot = (p, n) => p.screenshot({ path: new URL(`./saida/v21-${n}.png`, import.meta.url).pathname, fullPage: true });

// admin cria convite só-vendedor
const adm = await pagina('/admin/', ctxAdmin);
await adm.fill('#usuario', 'admin'); await adm.fill('#senha', 'Admin12@teste'); await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');
const r = await adm.evaluate(async () => (await (await fetch('/admin/convites', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ papeis: ['vendedor'], nome_sugerido: 'Nina' }) })).json()));
const link = r.link.replace(/^https?:\/\/[^/]+/, '');

console.log('== cadastro só-vendedor pelo convite ==');
{
  const p = await pagina(link);
  await p.waitForSelector('#formConvite:not([hidden])');
  await p.fill('#cpf_cnpj', '111.444.777-35'); await p.fill('#contato_telefone', '16 99463-5946'); await p.fill('#chave_pix', 'nina@pix');
  await p.fill('#contato_email', 'nina@x.com'); await p.fill('#senha', 'Senha12@'); await p.fill('#senha_confirma', 'Senha12@');
  await p.check('#aceitou_termos'); await p.click('button[type=submit]');
  await p.waitForURL('**/anunciante/vendedor.html', { timeout: 8000 }).catch(() => {});
  await p.waitForTimeout(700);
  check('cai no modo Vendas liberado', (await p.textContent('body')).includes('Seu cupom'));
  check('abas Anúncios e Meu ponto marcadas como bloqueadas', await p.$eval('#navDashboard', (e) => e.classList.contains('bloqueado')) && await p.$eval('#navMeuPonto', (e) => e.classList.contains('bloqueado')));
  await shot(p, 'vendas');

  console.log('== modo Anúncios bloqueado → card de ativação ==');
  await p.click('#navDashboard'); await p.waitForURL('**/anunciante/painel.html'); await p.waitForTimeout(800);
  check('dashboard de anúncios escondido', await p.$eval('#dashboardAnuncios', (e) => e.hidden));
  check('card de ativação aparece', !!(await p.$('form.modo-card#formModo')));
  await shot(p, 'anuncios-bloqueado');
  await p.fill('#m_cep', '15990-000'); await p.fill('#m_endereco', 'Rua Nova'); await p.fill('#m_numero', '9');
  await p.waitForFunction(() => document.querySelectorAll('#m_categoria_id option').length > 1);
  await p.selectOption('#m_categoria_id', { index: 1 });
  await p.click('.modo-card button[type=submit]');
  await p.waitForTimeout(1500);
  check('após ativar, dashboard de anúncios abre', !(await p.$eval('#dashboardAnuncios', (e) => e.hidden)));
  check('aba Anúncios desbloqueou', await p.$eval('#navDashboard', (e) => !e.classList.contains('bloqueado')));
  await shot(p, 'anuncios-ativado');

  console.log('== modo Meu ponto bloqueado → pedido ==');
  await p.click('#navMeuPonto'); await p.waitForURL('**/anunciante/ponto.html'); await p.waitForTimeout(800);
  check('card do modo ponto com opções de comodato', (await p.textContent('.modo-card')).includes('Como você quer ser recompensado') && (await p.$$('#modoEscolhaPlano .escolha')).length >= 1);
  await shot(p, 'ponto-bloqueado');
  await p.fill('#m_nome_comercio', 'Doceria Nina'); await p.fill('#m_cep', '15990-000'); await p.fill('#m_endereco', 'Rua Doce'); await p.fill('#m_numero', '1');
  await p.waitForFunction(() => document.querySelectorAll('#m_categoria_id option').length > 1);
  await p.selectOption('#m_categoria_id', { index: 1 });
  await p.click('.modo-card button[type=submit]'); await p.waitForTimeout(1500);
  check('depois do pedido mostra "Pedido enviado"', (await p.textContent('body')).includes('Pedido enviado'));
  await shot(p, 'ponto-pedido');

  console.log('== admin libera na conta ==');
  await adm.click('.nav-item[data-aba="candidaturas"]');
  await adm.waitForFunction(() => document.getElementById('conteudo').textContent.includes('Doceria Nina'), null, { timeout: 8000 });
  check('admin vê pedido do painel', (await adm.textContent('#conteudo')).includes('pedido do painel'));
  await adm.locator('tr', { hasText: 'Doceria Nina' }).first().locator('[data-liberar]').click();
  await adm.waitForTimeout(1000);
  await shot(adm, 'admin-candidaturas');
  await p.reload({ waitUntil: 'networkidle' }); await p.waitForTimeout(800);
  check('modo Meu ponto liberado com a Tela 1', (await p.textContent('body')).includes('Tela 1'));
  check('aba Meu ponto desbloqueou', await p.$eval('#navMeuPonto', (e) => !e.classList.contains('bloqueado')));
  await shot(p, 'ponto-liberado');

  // Bônus de tela após N meses removido em 17/09/2026 (migration 046).
  await p.close();
}

console.log('== admin: opções de comodato com módulo de bônus ==');
await adm.click('.nav-item[data-aba="comodato"]');
await adm.waitForFunction(() => document.getElementById('conteudo').textContent.includes('Bônus'), null, { timeout: 8000 }).catch(() => {});
check('aba comodato mostra colunas do bônus', (await adm.textContent('#conteudo')).includes('Bônus: plano de anúncio'));
await adm.click('.nav-item[data-aba="planos"]');
await adm.waitForFunction(() => document.getElementById('conteudo').textContent.includes('Tela após'), null, { timeout: 8000 }).catch(() => {});
check('aba planos mostra coluna "Tela após"', (await adm.textContent('#conteudo')).includes('Tela após'));

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
