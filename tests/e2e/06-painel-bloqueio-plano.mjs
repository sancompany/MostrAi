// Bloqueio do painel do anunciante por falta de plano (19/09/2026, pedido do
// dono): conta nova (nasce só com o papel anunciante, sem "pedir" nada) vê o
// dashboard inteiro — KPIs, gráficos e upload de criativo — escondido atrás
// de um card com CTA pra escolher plano. Depois que o admin libera um plano
// (cortesia, via /admin/anunciantes/:id/liberar-plano — mesmo efeito de um
// plano pago pra essa tela), o bloqueio some e os KPIs novos aparecem, entre
// eles "Horas entregues no mês" (só existe com plano). Assume banco zerado
// e servidor na 3999.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
const B = 'http://localhost:3999';
const PG = (sql) => execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`).toString().trim();
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const ctxAdmin = await b.newContext({ viewport: { width: 1280, height: 900 } });
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const falhas = [];
const erros = [];
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
const shot = (p, n) => p.screenshot({ path: new URL(`./saida/v22-${n}.png`, import.meta.url).pathname, fullPage: true });

const adm = await pagina('/admin/', ctxAdmin);
await adm.fill('#usuario', 'admin'); await adm.fill('#senha', 'Admin12@teste'); await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');

console.log('== conta nova, sem plano, direto no painel de anúncios ==');
const cadastro = await pagina('/');
const conta = await cadastro.evaluate(async () => (await (await fetch('/anunciantes/cadastro', {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Padaria Lu', cpf_cnpj: '390.533.447-05', endereco: 'Rua Lu, 5', cidade: 'Matão', uf: 'SP',
    cep: '15990-000', contato_email: 'lu@x.com', contato_telefone: '16 99463-5946', senha: 'Senha12@', aceitou_termos: true,
  }),
})).json()));
check('conta nasce só com anunciante, sem plano', JSON.stringify(conta.papeis) === '["anunciante"]' && !conta.plano_id, JSON.stringify(conta));

// Confirma o e-mail pra tirar o modal de "Confirme seu e-mail" do caminho —
// senão ele fica por cima do dashboard nos dois estados e atrapalha a
// screenshot (a checagem por texto continuaria passando, mas a foto não
// mostraria o redesenho de verdade).
const codigo = PG(`SELECT codigo FROM tokens_confirmacao_email WHERE anunciante_id=${conta.id}`);
await cadastro.evaluate(async (codigo) => (await fetch('/anunciantes/me/confirmar-email', {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codigo }),
})).json(), codigo);

const p = await pagina('/anunciante/painel.html', ctx);
await p.waitForTimeout(800);
check('dashboard de anúncios escondido', await p.$eval('#dashboardAnuncios', (e) => e.hidden));
check('card de bloqueio de plano aparece', !!(await p.$('#bloqueioPlano')));
check('card convida a escolher plano', (await p.textContent('#bloqueioPlano')).includes('Escolha um plano'));
check('CTA leva pra vitrine de planos', await p.$eval('#bloqueioPlano a.btn', (e) => e.getAttribute('href')) === '/planos.html');
check('grid de KPIs não é visível nesse estado', !(await p.isVisible('#kpiGrid')));
await shot(p, 'bloqueado');

console.log('== admin libera plano de cortesia; bloqueio some, KPIs de horas aparecem ==');
const liberado = await adm.evaluate(async (id) => (await (await fetch(`/admin/anunciantes/${id}/liberar-plano`, {
  method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ plano_id: 'essencial-1m', meses: 1, motivo: 'teste e2e (script 06)' }),
})).json()), conta.id);
check('admin liberou o plano de cortesia', liberado.plano_id === 'essencial-1m', JSON.stringify(liberado));

await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(1000);
check('bloqueio de plano some', !(await p.$('#bloqueioPlano')));
check('dashboard de anúncios reaparece', !(await p.$eval('#dashboardAnuncios', (e) => e.hidden)));
check('card "Horas entregues no mês" aparece no grid', (await p.textContent('#kpiGrid')).includes('Horas entregues no mês'));
check('upload de criativo liberado na tela', !!(await p.$('#arquivoCriativo')));
await shot(p, 'com-plano');

console.log('\nerros de página:', erros.length ? erros : 'nenhum');
console.log('falhas:', falhas.length);
await b.close();
process.exit(falhas.length || erros.length ? 1 : 0);
