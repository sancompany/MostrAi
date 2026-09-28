// Indicações — finalização (28/09/2026):
//   · quem chega ao cadastro por ?ref= de um cupom válido vê "Você foi
//     indicado por: <nome>"; cupom inválido não mostra nada (e o cadastro
//     segue);
//   · o card Indicações do ponto lista quem se cadastrou pelo link — nome,
//     cidade, data, cadastro concluído ou não, plano, créditos — e nada de
//     e-mail, documento ou endereço;
//   · celular (375 px): sem rolagem lateral.
// Assume servidor na 3999 e o banco do .env.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const RAIZ = new URL('../../', import.meta.url).pathname;
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
const shot = (p, n) => p.screenshot({ path: `${SAIDA}indicacoes-${n}.png`, fullPage: true });

const marca = Date.now();
async function cadastrar(nome, email, extra = {}) {
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: '52998224725',
      contato_email: email,
      contato_telefone: '16999995555',
      senha: 'Senha123!',
      aceitou_termos: true,
      endereco: 'Rua Um, 1',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
      ...extra,
    }),
  });
  if (!r.ok) throw new Error(`cadastro ${nome}: ${r.status} ${await r.text()}`);
  return PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
}

// O ponto: conta confirmada, dona de um ponto (é o que libera o card).
const emailP = `indic-ponto-${marca}@teste.com`;
const PONTO = await cadastrar(`Padaria Indicadora ${marca}`, emailP);
PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${PONTO}`);
PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id, status)
   VALUES ('Ponto indicador ${marca}', 'Rua Dois, 2', 'Matão', 'SP', '15990000', 'outro', 'R', '1', ${PONTO}, 'em_operacao')`,
);

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
function vigiar(p, nome) {
  p.on('pageerror', (e) => erros.push(`[${nome}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text()) && !/net::|ERR_FAILED/.test(m.text()))
      erros.push(`[${nome}] console: ${m.text()}`);
  });
  p.on('dialog', (d) => {
    falha('diálogo nativo do navegador', d.message());
    d.dismiss().catch(() => {});
  });
  return p;
}
async function painelDoPonto(largura = 1280) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = vigiar(await ctx.newPage(), 'ponto');
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', emailP);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForSelector('#modIndicacao:not([hidden])', { timeout: 10000 });
  return { p, ctx };
}

console.log('== o link do ponto ==');
const { p, ctx } = await painelDoPonto();
const CODIGO = (await p.textContent('#modIndicacao')).match(/ref=(PT-[A-Z0-9]+)/)?.[1];
check('card Indicações mostra o link com o cupom', !!CODIGO, await p.textContent('#modIndicacao'));
check('sem indicado: sem lista', !(await p.$('.indicados-lista')));
await ctx.close();

console.log('== cadastro pelo link: "Você foi indicado por" ==');
{
  const c = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const pg = vigiar(await c.newPage(), 'cadastro');
  await irQuieto(pg, `${B}/anunciante/cadastro.html?ref=${CODIGO}`);
  await pg.waitForSelector('#avisoIndicacao:not([hidden])', { timeout: 8000 });
  const aviso = await pg.textContent('#avisoIndicacao');
  check('aviso com o nome do negócio que indicou', aviso === `Você foi indicado por: Padaria Indicadora ${marca}`, aviso);
  check('aviso não vaza e-mail', !aviso.includes('@'));
  await shot(pg, 'cadastro-indicado');
  await c.close();

  const c2 = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const pg2 = vigiar(await c2.newPage(), 'cadastro-invalido');
  await irQuieto(pg2, `${B}/anunciante/cadastro.html?ref=PT-NAOEXI999`);
  await pg2.waitForTimeout(800);
  check('cupom inválido: nenhum aviso', await pg2.evaluate(() => document.getElementById('avisoIndicacao').hidden));
  await c2.close();
}

// Duas contas indicadas: uma que parou no cadastro, outra que concluiu,
// contratou e pagou duas vezes.
const INICIADA = await cadastrar(`Loja Iniciada ${marca}`, `indic-a-${marca}@teste.com`, { indicado_por_cupom: CODIGO, cidade: 'Araraquara' });
const PAGANTE = await cadastrar(`Farmácia Pagante ${marca}`, `indic-b-${marca}@teste.com`, { indicado_por_cupom: CODIGO });
check('relação gravada no cadastro', PG(`SELECT indicado_por_cupom FROM anunciantes WHERE id = ${PAGANTE}`) === CODIGO);
PG(`UPDATE anunciantes SET email_confirmado = true, plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${PAGANTE}`);
execSync(
  `node -e "
  const c = require('./src/creditos/repository');
  (async () => { await c.registrarCreditoIndicacao(${PONTO}, ${PAGANTE}, null); await c.registrarCreditoIndicacao(${PONTO}, ${PAGANTE}, null); process.exit(0); })();"`,
  { cwd: RAIZ, env: process.env },
);

console.log('== histórico no card do ponto ==');
{
  const { p: pp, ctx: cc } = await painelDoPonto();
  await pp.waitForSelector('.indicados-lista', { timeout: 8000 });
  const texto = (await pp.textContent('#modIndicacao')).replace(/\s+/g, ' ');
  check('título do histórico', /Quem se cadastrou pelo seu link/.test(texto));
  check('duas contas listadas', (await pp.$$('.indicados-lista li')).length === 2);
  check('iniciada: nome, cidade e cadastro não concluído', new RegExp(`Loja Iniciada ${marca}.*Araraquara.*cadastro não concluído`).test(texto), texto);
  check('pagante: plano e 2 créditos', new RegExp(`Farmácia Pagante ${marca}.*2 créditos.*último em \\d\\d/\\d\\d/\\d{4}`).test(texto) && /plano Essencial/.test(texto), texto);
  check('mais recente primeiro', texto.indexOf('Farmácia Pagante') < texto.indexOf('Loja Iniciada'));
  check('sem e-mail, documento ou endereço de indicado', !/@teste\.com|529\.?982|Rua Um/.test(texto), texto);
  const corpo = await pp.textContent('body');
  check('nada do modelo antigo', !/indicados pagantes|de graça|\d+ indicados/i.test(corpo));
  await shot(pp, 'historico-desktop');
  await cc.close();

  const { p: m, ctx: cm } = await painelDoPonto(375);
  await m.waitForSelector('.indicados-lista', { timeout: 8000 });
  check('celular: sem rolagem lateral', await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  check(
    'celular: nada do card vaza',
    await m.$eval('#modIndicacao', (raiz) => {
      const lim = raiz.getBoundingClientRect().right + 1;
      return [...raiz.querySelectorAll('*')].filter((el) => el.getClientRects().length).every((el) => el.getBoundingClientRect().right <= lim);
    }),
  );
  await shot(m, 'historico-celular');
  await cm.close();
}

await b.close();
check('sem erro de console', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
