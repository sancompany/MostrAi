// Página de Planos — fechamento (26/09/2026). Só confere, não redesenha:
//
//   textos novos (frase principal, "Recomendado" no Pro, subtítulo do Prime,
//   FAQ) → mínimo de exibições nos cards → botão Assinar de cada plano →
//   aviso de rede em montagem nos três estados (0 pontos, rede pequena,
//   rede completa) → desktop e celular sem rolagem lateral nem erro de console.
//
// O aviso é dinâmico e vem de GET /pontos; aqui a resposta é fixada por
// estado (page.route) para testar o componente sem mexer na rede do banco.
// Assume servidor na 3999 (restart.sh).
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const falhas = [];
const check = (t, cond, d) => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : d || '');
  if (!cond) falhas.push(t);
};
const pontos = (n, emOperacao) =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, nome: `P${i + 1}`, status: i < emOperacao ? 'em_operacao' : 'a_instalar' }));

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));

async function abrir(largura, altura, respostaPontos) {
  const ctx = await b.newContext({ viewport: { width: largura, height: altura } });
  const pagina = await ctx.newPage();
  const erros = [];
  pagina.on('pageerror', (e) => erros.push(e.message));
  pagina.on('console', (m) => m.type() === 'error' && erros.push(m.text()));
  if (respostaPontos) {
    await pagina.route(/\/pontos$/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(respostaPontos) }));
  }
  await irQuieto(pagina, `${B}/planos.html`);
  await pagina.waitForSelector('.plan-card');
  return { pagina, ctx, erros };
}

console.log('== desktop: textos, cards e CTA ==');
{
  const { pagina, ctx, erros } = await abrir(1366, 900, pontos(0, 0));
  const lead = await pagina.textContent('.lead');
  check('frase principal nova', /Escolha o plano, os pontos da rede e a duração do seu anúncio dentro das condições contratadas\./.test(lead), lead);
  const cards = await pagina.$$eval('.plan-card', (els) => els.map((e) => e.innerText));
  const pro = cards.find((c) => /Pro/.test(c)) || '';
  const prime = cards.find((c) => /Prime/.test(c)) || '';
  check('Pro com selo "Recomendado"', /Recomendado/.test(pro) && !/Mais escolhido/.test(pro), pro.slice(0, 80));
  check('Pro mantém o destaque (card popular)', (await pagina.locator('.plan-card.popular').count()) === 1);
  check('Prime: "A experiência mais completa da Mostraí."', /A experiência mais completa da Mostraí\./.test(prime), prime.slice(0, 120));
  check('nenhum "sem limitações"', !/sem limitações/i.test(await pagina.textContent('body')));
  for (const [nome, minimo] of [['Essencial', '6.480'], ['Pro', '15.120'], ['Prime', '21.600']]) {
    const card = cards.find((c) => c.includes(nome)) || '';
    check(`${nome}: "Pelo menos ${minimo} exibições por mês"`, card.includes(`Pelo menos ${minimo} exibições por mês`), card.slice(0, 200));
  }
  const ctas = await pagina.$$eval('.plan-card a.btn', (els) => els.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
  check(
    'CTA "Assinar <plano>" leva ao cadastro com o plano escolhido',
    ctas.length === 3 && ctas.every(([t, h]) => /^Assinar /.test(t) && /\/anunciante\/cadastro\.html\?plano=/.test(h)),
    JSON.stringify(ctas),
  );
  const faq = await pagina.textContent('.faq');
  check('FAQ: preço permanece nas renovações', /O valor contratado permanece nas renovações dessa assinatura\./.test(faq));
  check('FAQ: aprovação pelo painel', /Você acompanha a aprovação pelo painel/.test(faq) && !/Você recebe um aviso/.test(faq));
  check('FAQ: créditos em linguagem simples', /Eventuais créditos já concedidos/.test(faq) && !/créditos programado/.test(faq));
  check('FAQ: mínimo de exibições explicado', /Criativos mais curtos podem gerar mais exibições/.test(faq));
  check('desktop sem rolagem lateral', await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await pagina.screenshot({ path: `${SAIDA}21-planos-desktop.png`, fullPage: true });
  check('desktop sem erro de console', erros.length === 0, erros.join(' | '));
  await ctx.close();
}

console.log('== aviso da rede ==');
for (const [rotulo, lista, espera] of [
  ['0 pontos', pontos(0, 0), { visivel: true, texto: /Rede em montagem: nenhum ponto ainda\./, bonus: false }],
  ['2 pontos, 1 no ar', pontos(2, 1), { visivel: true, texto: /Rede em montagem: 2 pontos hoje\./, bonus: true }],
  ['10 pontos', pontos(10, 10), { visivel: false }],
]) {
  const { pagina, ctx } = await abrir(1366, 900, lista);
  await pagina.waitForTimeout(400);
  const visivel = await pagina.isVisible('#avisoRede');
  check(`${rotulo}: aviso ${espera.visivel ? 'aparece' : 'some'}`, visivel === espera.visivel);
  if (espera.visivel) {
    const texto = await pagina.textContent('#avisoRede');
    check(`${rotulo}: texto certo`, espera.texto.test(texto), texto.slice(0, 80));
    check(`${rotulo}: bônus ${espera.bonus ? 'explicado' : 'ausente'}`, /horas bônus/.test(texto) === espera.bonus);
  }
  await ctx.close();
}

console.log('== celular ==');
{
  const { pagina, ctx, erros } = await abrir(390, 844, pontos(0, 0));
  check('celular sem rolagem lateral', await pagina.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  const lead = await pagina.locator('.lead').boundingBox();
  check('frase principal cabe na largura', lead && lead.x >= 0 && lead.x + lead.width <= 390, JSON.stringify(lead));
  await pagina.screenshot({ path: `${SAIDA}21-planos-celular.png`, fullPage: true });
  check('celular sem erro de console', erros.length === 0, erros.join(' | '));
  await ctx.close();
}

await b.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
