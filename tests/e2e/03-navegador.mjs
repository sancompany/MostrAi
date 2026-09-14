// Fluxo v2 no navegador, contra o servidor local real (porta 3999):
// candidatura → admin gera convite → cadastro por convite → painel do ponto,
// painel do vendedor, planos com fundador, player + PIN, abas novas do admin.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) => execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
// Admin e usuários em contextos separados: o cookie de sessão é um só por
// navegador, e o cadastro por convite regenera a sessão (derrubaria o admin).
const ctxAdmin = await b.newContext({ viewport: { width: 1280, height: 900 } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => { console.log('  FALHA', t, d || ''); falhas.push(t); };
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
async function pagina(url, vp, contexto = ctx) {
  const p = await contexto.newPage();
  if (vp) await p.setViewportSize(vp);
  p.on('pageerror', (e) => erros.push(`${url}: ${e.message}`));
  // 401/404 esperados (sem login, convite usado, PIN errado) não contam.
  p.on('console', (m) => { if (m.type() === 'error' && !/status of (401|404)/.test(m.text())) erros.push(`${url} console: ${m.text()}`); });
  p.on('dialog', async (d) => { d.type() === 'prompt' ? await d.accept(d.defaultValue()) : await d.accept(); });
  await p.goto(B + url, { waitUntil: 'networkidle' });
  return p;
}
async function abaAdmin(adm, nome, esperado) {
  await adm.click(`.nav-item[data-aba="${nome}"]`);
  await adm.waitForFunction((t) => document.getElementById('conteudo').textContent.includes(t), esperado, { timeout: 8000 }).catch(() => {});
  await adm.waitForTimeout(200);
}
async function shot(p, nome) { await p.screenshot({ path: new URL(`./saida/v2-${nome}.png`, import.meta.url).pathname, fullPage: true }); }

console.log('== candidatura de ponto pelo site ==');
{
  const p = await pagina('/seja-um-ponto.html');
  await p.fill('#nome_comercio', 'Farmácia Central');
  await p.waitForFunction(() => document.querySelectorAll('#categoria_id option').length > 1);
  await p.selectOption('#categoria_id', { index: 1 });
  await p.fill('#cep', '15990-000'); await p.fill('#endereco', 'Rua Sete de Setembro'); await p.fill('#numero', '100');
  await p.fill('#nome', 'Carla'); await p.fill('#contato_telefone', '16 99999-1111');
  await p.check('#aceite');
  await p.click('button[type=submit]');
  await p.waitForSelector('#enviado:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('candidatura enviada e confirmação aparece', !(await p.$eval('#enviado', (e) => e.hidden)), await p.$eval('#msg', (e) => e.textContent));
  await shot(p, 'seja-um-ponto');
  await p.close();
}

console.log('== candidatura de vendedor ==');
{
  const p = await pagina('/seja-um-vendedor.html');
  await p.fill('#nome', 'Marcos'); await p.fill('#contato_telefone', '16 98888-2222'); await p.check('#aceite');
  await p.click('button[type=submit]');
  await p.waitForSelector('#enviado:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('candidatura de vendedor enviada', !(await p.$eval('#enviado', (e) => e.hidden)));
  await p.close();
}

console.log('== admin: candidaturas → convite ==');
const adm = await pagina('/admin/', null, ctxAdmin);
await adm.fill('#usuario', 'admin'); await adm.fill('#senha', 'Admin12@teste'); await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');
await adm.waitForTimeout(600);
check('visão geral mostra custos fixos', (await adm.textContent('#conteudo')).includes('Custos fixos'));
check('alerta de candidaturas novas', (await adm.textContent('#conteudo')).includes('candidatura'));
await shot(adm, 'admin-resumo');
await abaAdmin(adm, 'candidaturas', 'Farmácia Central');
check('aba candidaturas lista a farmácia', (await adm.textContent('#conteudo')).includes('Farmácia Central'));
await shot(adm, 'admin-candidaturas');
// gera convite (prompt confirm → aceita = também anunciante; prompt do link → aceita)
let linkConvite = null;
adm.removeAllListeners('dialog');
adm.on('dialog', async (d) => {
  if (d.type() === 'confirm') return d.dismiss(); // só dono de ponto
  if (d.type() === 'prompt') { linkConvite = d.defaultValue(); return d.accept(); }
  return d.accept();
});
await adm.locator('tr', { hasText: 'Farmácia Central' }).first().locator('[data-convidar]').click(); await adm.waitForTimeout(800);
check('convite gerado com link', !!linkConvite && linkConvite.includes('/convite.html?t='), linkConvite);
check('candidatura virou aprovada', (await adm.textContent('#conteudo')).includes('Convite aberto'));
await adm.click('.nav-item[data-aba="convites"]'); await adm.waitForTimeout(600);
check('aba convites lista o convite aberto', (await adm.textContent('#conteudo')).includes('Dono de ponto'));
await shot(adm, 'admin-convites');

console.log('== cadastro por convite ==');
{
  const p = await pagina(linkConvite.replace(/^https?:\/\/[^/]+/, ''));
  await p.waitForSelector('#formConvite:not([hidden])', { timeout: 5000 }).catch(() => {});
  check('página de convite abre o formulário', !(await p.$eval('#formConvite', (e) => e.hidden)));
  check('mostra papel dono de ponto', (await p.textContent('#papeis')).includes('Dono de ponto'));
  check('seção de Pix escondida (não é vendedor)', await p.$eval('#secaoPix', (e) => e.hidden));
  check('seção de plano do ponto visível', !(await p.$eval('#secaoPlanoPonto', (e) => e.hidden)));
  await shot(p, 'convite');
  await p.fill('#cpf_cnpj', '111.444.777-35'); await p.fill('#contato_telefone', '16 99999-1111');
  await p.fill('#contato_email', 'carla@x.com'); await p.fill('#senha', 'Senha12@'); await p.fill('#senha_confirma', 'Senha12@');
  await p.check('#aceitou_termos');
  await p.click('button[type=submit]');
  await p.waitForURL('**/anunciante/ponto.html', { timeout: 8000 }).catch(() => {});
  check('após cadastro vai pro painel do ponto', p.url().includes('/anunciante/ponto.html'), p.url());
  await p.waitForTimeout(800);
  const txt = await p.textContent('body');
  check('painel do ponto lista a Tela 1', txt.includes('Tela 1'), txt.slice(0, 200));
  check('menu: "Meu ponto" liberado e "Anúncios" bloqueado', await p.$eval('#navMeuPonto', (e) => !e.classList.contains('bloqueado')) && await p.$eval('#navDashboard', (e) => e.classList.contains('bloqueado')));
  await shot(p, 'ponto');
  await p.close();
}

console.log('== convite é de uso único ==');
{
  const p = await pagina(linkConvite.replace(/^https?:\/\/[^/]+/, ''));
  await p.waitForTimeout(500);
  check('segunda abertura mostra inválido', !(await p.$eval('#invalido', (e) => e.hidden)));
  await p.close();
}

console.log('== admin: telas (chave + PIN) ==');
await abaAdmin(adm, 'telas', 'Farmácia Central');
check('aba telas lista a tela da farmácia', (await adm.textContent('#conteudo')).includes('Farmácia Central'), (await adm.textContent('#conteudo')).slice(0, 300) + ' | hash=' + adm.url() + ' | erros=' + JSON.stringify(erros));
let linkPlayer = null;
adm.removeAllListeners('dialog');
adm.on('dialog', async (d) => {
  if (d.type() === 'prompt' && /PIN/.test(d.message())) return d.accept('4321');
  if (d.type() === 'prompt') { linkPlayer = d.defaultValue(); return d.accept(); }
  return d.accept();
});
const linhaFarm = adm.locator('tr', { hasText: 'Farmácia Central' }).first();
await linhaFarm.locator('[data-chave]').click(); await adm.waitForTimeout(800);
check('chave gerada e link do player mostrado', !!linkPlayer && /player\.html\?tela=\d+&chave=/.test(linkPlayer), linkPlayer);
await adm.locator('tr', { hasText: 'Farmácia Central' }).first().locator('[data-pin]').click(); await adm.waitForTimeout(800);
check('PIN definido', (await adm.locator('tr', { hasText: 'Farmácia Central' }).first().textContent()).includes('definido'));
await shot(adm, 'admin-telas');

// ativa ponto + tela pra playlist responder
const telaId = Number(new URL(linkPlayer).searchParams.get('tela'));
const pontoId = Number(PG(`select ponto_id from dispositivos where id=${telaId}`));
PG(`update pontos set status='ativo' where id=${pontoId}`);

console.log('== player + painel por PIN ==');
{
  const p = await pagina(linkPlayer.replace(/^https?:\/\/[^/]+/, ''), { width: 1920, height: 1080 });
  await p.waitForTimeout(1200);
  const msg = await p.textContent('#msg');
  check('player carregou a playlist (ok ou sem anúncios)', /playlist ok|sem anúncios/.test(msg), msg);
  await p.keyboard.press('p'); await p.waitForTimeout(300);
  check('tecla P abre o painel da tela', !!(await p.$('.painel-tela')));
  // scrypt do PIN leva ~0,5–1 s — espera o texto, não um tempo fixo.
  await p.fill('#pin', '0000'); await p.click('#formPin button');
  await p.waitForFunction(() => document.getElementById('erroPin').textContent.includes('PIN'), null, { timeout: 8000 }).catch(() => {});
  check('PIN errado é recusado', (await p.textContent('#erroPin')).includes('PIN'));
  await p.fill('#pin', '4321'); await p.click('#formPin button');
  await p.waitForFunction(() => document.getElementById('conteudoPainel').textContent.includes('Exibições'), null, { timeout: 8000 }).catch(() => {});
  check('PIN certo mostra o painel', (await p.textContent('#conteudoPainel')).includes('Exibições em 30 dias'));
  await shot(p, 'player-painel');
  await p.close();
}

console.log('== vendedor: convite só vendedor → painel de vendas ==');
adm.removeAllListeners('dialog');
let linkVend = null;
adm.on('dialog', async (d) => { if (d.type() === 'confirm') return d.dismiss(); if (d.type() === 'prompt') { linkVend = d.defaultValue(); return d.accept(); } return d.accept(); });
await abaAdmin(adm, 'candidaturas', 'Marcos');
await adm.locator('tr', { hasText: 'Marcos' }).first().locator('[data-convidar]').click(); await adm.waitForTimeout(800);
check('convite de vendedor gerado', !!linkVend);
{
  // Contexto novo: a Carla continua logada no `ctx`, e convite aberto por
  // conta logada agora oferece "liberar na minha conta" em vez do formulário.
  const ctxVend = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await pagina(linkVend.replace(/^https?:\/\/[^/]+/, ''), null, ctxVend);
  await p.waitForSelector('#formConvite:not([hidden])');
  check('seção de Pix visível pra vendedor', !(await p.$eval('#secaoPix', (e) => e.hidden)));
  await p.fill('#cpf_cnpj', '529.982.247-25'); await p.fill('#contato_telefone', '16 98888-2222'); await p.fill('#chave_pix', 'marcos@pix');
  await p.fill('#contato_email', 'marcos@x.com'); await p.fill('#senha', 'Senha12@'); await p.fill('#senha_confirma', 'Senha12@');
  await p.check('#aceitou_termos'); await p.click('button[type=submit]');
  await p.waitForURL('**/anunciante/vendedor.html', { timeout: 8000 }).catch(() => {});
  check('vendedor cai no painel de vendas', p.url().includes('/anunciante/vendedor.html'), p.url());
  await p.waitForTimeout(800);
  const t = await p.textContent('body');
  check('painel mostra cupom e link', t.includes('Seu cupom') && t.includes('cadastro.html?ref='), t.slice(0, 120));
  check('menu mostra Vendas', await p.$eval('#navVendas', (e) => !e.hidden));
  await shot(p, 'vendedor');
  await p.close();
}
await abaAdmin(adm, 'vendedores', 'Marcos');
check('aba vendedores lista Marcos com cupom', (await adm.textContent('#conteudo')).includes('Marcos') && await adm.$eval('#conteudo input[data-vendedor="chave_pix"]', (e) => e.value === 'marcos@pix'));

console.log('== planos: fundador ==');
{
  const p = await pagina('/planos.html');
  await p.waitForTimeout(600);
  const t = await p.textContent('body');
  check('vitrine mostra o bloco fundador', t.includes('Programa fundador aberto') && t.includes('Quero ser fundador'), t.slice(0, 100));
  check('grade normal continua com 3 planos', (await p.$$('#plansGrid .plan-card')).length === 3);
  await shot(p, 'planos');
  await p.close();
}
await abaAdmin(adm, 'planos', 'Programa fundador');
{
  const t = await adm.textContent('#conteudo');
  check('admin planos mostra programa fundador aberto', t.includes('ABERTO no site'));
  check('admin planos tem colunas novas', t.includes('Mín. telas') && t.includes('Vagas'));
}
await abaAdmin(adm, 'custos', 'DAS MEI');
check('aba custos lista DAS MEI', (await adm.textContent('#conteudo')).includes('DAS MEI'));
await shot(adm, 'admin-custos');
await abaAdmin(adm, 'anunciantes', 'Dono de ponto');
check('anunciantes mostra badge de papel', (await adm.textContent('#conteudo')).includes('Dono de ponto'));

console.log('== mobile: convite e ponto ==');
{
  const p = await pagina('/seja-um-ponto.html', { width: 390, height: 800 });
  const larguraDoc = await p.evaluate(() => document.documentElement.scrollWidth);
  check('seja-um-ponto não estoura no celular', larguraDoc <= 390, larguraDoc);
  await p.close();
}

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
