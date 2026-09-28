// Plano Básico como benefício do ponto (migration 103, ADR-025, 28/09/2026):
//   · conta que vira ponto ativo vê "Benefício de ponto · Plano Básico"
//     (14 h/mês, 1 ponto — o próprio, até 15 s) e o painel NÃO fica
//     bloqueado sem plano contratado;
//   · quando entra um plano comercial (Essencial), os dois aparecem
//     SEPARADOS, e o total diz 4 pontos e 41 h (14 h + 27 h);
//   · o admin vê, na ficha da conta, a seção "Benefício de ponto" com o ponto
//     de origem, e o plano comercial à parte;
//   · celular sem rolagem lateral; nenhum diálogo nativo; console limpo.
// Assume servidor na 3999 e o banco do .env.
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const RAIZ = new URL('../../', import.meta.url).pathname;
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
const shot = (p, n) => p.screenshot({ path: `${SAIDA}basico-${n}.png`, fullPage: true });

const marca = Date.now();
const email = `basico-${marca}@teste.com`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: `Padaria Exemplo ${marca}`,
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999997777',
    senha: 'Senha123!',
    aceitou_termos: true,
    endereco: 'Rua Um, 1',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
  }),
});
const CONTA = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(`UPDATE anunciantes SET email_confirmado = true, papeis = '{anunciante,ponto}' WHERE id = ${CONTA}`);
// Ponto da conta com uma tela provisionada e ativa (o que o Player instalado
// deixa), e a sincronização que a instalação real dispara.
const NOME_PONTO = `Padaria Exemplo Ponto ${marca}`;
const PONTO = PG(
  `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id)
   VALUES ('${NOME_PONTO}', 'Rua Um, 1', 'Matão', 'SP', '15990000', 'outro', 'R', '1', ${CONTA}) RETURNING id`,
).split('\n')[0];
PG(
  `INSERT INTO dispositivos (ponto_id, apelido, status, chave_hash, provisionado_em, primeiro_sinal_em)
   VALUES (${PONTO}, 'Tela 1', 'ativo', 'e2e-basico-${marca}', now(), now())`,
);
execSync(
  `node -e "require('./src/pontos/repository').sincronizarStatusPonto(${PONTO}).then(() => require('./src/db/pool').end())"`,
  { cwd: RAIZ, env: process.env },
);
check('banco: Básico ativo pro ponto', PG(`SELECT horas_por_mes FROM beneficios_basico_ponto WHERE ponto_id = ${PONTO} AND fim IS NULL`) === '14');

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
function vigiar(p) {
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|404|409)/.test(m.text()) && !/net::|ERR_FAILED/.test(m.text()))
      erros.push(`console: ${m.text()}`);
  });
  p.on('dialog', (d) => {
    falha('diálogo nativo do navegador', d.message());
    d.dismiss().catch(() => {});
  });
}
async function entrar(largura = 1280) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  vigiar(p);
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForSelector('#modBasico:not([hidden])', { timeout: 10000 });
  return { p, ctx };
}

console.log('== só o Básico: benefício de ponto, painel liberado ==');
{
  const { p, ctx } = await entrar();
  const card = await p.textContent('#modBasico');
  check('card "Benefício de ponto"', /Benefício de ponto/.test(card) && /Plano Básico/.test(card), card);
  check('14 h/mês', /14 h\/mês/.test(card));
  check('1 ponto — o próprio estabelecimento', card.includes(`1 ponto — ${NOME_PONTO}`), card);
  check('anúncio de até 15 s', /até 15 s/.test(card));
  check('sem custo enquanto o ponto estiver ativo', /enquanto seu ponto estiver ativo/.test(card));
  check('+1 crédito/mês dito à parte', /\+1 crédito por mês/.test(card));
  check('sem bloqueio de plano', !(await p.$('#bloqueioPlano')));
  check('sem CTA de comprar Básico', !/Comprar Básico|Assinar Básico/i.test(await p.textContent('body')));
  check('card "Seu plano" escondido (não há plano contratado)', await p.$eval('#modPlano', (e) => e.hidden));
  await p.waitForSelector('#modCriativos:not([hidden])', { timeout: 10000 });
  check('pode enviar criativo (limite 1)', /0 de 1/.test(await p.textContent('#contadorCriativos')));
  await shot(p, 'so-basico');
  await ctx.close();
}

console.log('== Básico + Essencial: os dois, separados, e o total ==');
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${CONTA}`,
);
{
  const { p, ctx } = await entrar();
  await p.waitForSelector('#modPlano:not([hidden])', { timeout: 10000 });
  const basico = await p.textContent('#modBasico');
  const plano = await p.textContent('#modPlano');
  check('Básico continua', /14 h\/mês/.test(basico));
  check('Essencial no card do plano contratado', /Plano contratado/.test(plano) && /Essencial/.test(plano), plano);
  check('Básico não aparece como "Básico + Essencial"', !/Básico \+ Essencial|Essencial \+ Básico/.test(await p.textContent('body')));
  check('total: 4 pontos e 41 h (14 h + 27 h)', /4 pontos/.test(basico) && /41 h\/mês/.test(basico) && /14 h do Básico \+ 27 h do plano/.test(basico), basico);
  await p.waitForSelector('#kpiGrid [data-kpi="horas"]:not([hidden])', { timeout: 10000 }).catch(() => {});
  const horas = (await p.$('#kpiGrid [data-kpi="horas"]:not([hidden])')) ? await p.textContent('#kpiGrid [data-kpi="horas"]') : '';
  check('horas do mês por origem', /41h no mês \(27h do plano \+ 14h do Básico\)/.test(horas), horas);
  await shot(p, 'basico-mais-essencial');
  await ctx.close();
}

console.log('== admin: ficha da conta ==');
{
  const ctx = await b.newContext({ viewport: { width: 1366, height: 900 } });
  const admin = await ctx.newPage();
  await admin.goto(`${B}/admin/index.html`);
  await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
  await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
  await admin.click('button[type=submit]');
  await admin.waitForSelector('.admin-shell');
  vigiar(admin);
  await admin.evaluate((h) => {
    location.hash = h;
  }, `contas/contas/${CONTA}`);
  await admin.waitForSelector('#contaBasico', { timeout: 10000 });
  const secao = await admin.textContent('#contaBasico');
  check('seção "Benefício de ponto"', /Benefício de ponto/.test(secao));
  check('Básico ativo, 14 h/mês', /Básico · 14 h\/mês/.test(secao) && /Ativo/.test(secao));
  check('ponto de origem', secao.includes(NOME_PONTO));
  check('total com o plano comercial', /4 pontos e 41 h\/mês/.test(secao), secao);
  check('plano comercial separado', /Essencial/.test(await admin.textContent('#contaPlano')));
  await shot(admin, 'admin-ficha');
  await ctx.close();
}

console.log('== celular ==');
{
  const { p, ctx } = await entrar(390);
  check('celular: sem rolagem lateral', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await shot(p, 'celular');
  await ctx.close();
}

await b.close();
check('sem erro de console', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
