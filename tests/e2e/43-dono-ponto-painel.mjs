// Dono de ponto não fica bloqueado pelo onboarding de plano (01/10/2026).
//
// O caso real: conta sem plano comercial, dona de um ponto já aprovado que
// está "Aguardando instalação" — o painel mostrava "Comece sua primeira
// campanha / Escolha seu plano" e travava a conta inteira. ACESSO ao painel
// ≠ DIREITO de veicular (src/anunciantes/acesso-painel.js):
//   1. conta sem plano e sem ponto → bloqueio "Escolha seu plano" (controle);
//   2. pedido de ponto em análise → continua bloqueada (pedido não é ponto);
//   3. admin aprova → ponto a_instalar → painel inteiro, sem obrigação de
//      plano; Meus pontos "Aguardando instalação"; Básico "Aguardando
//      instalação da tela" (nunca ativo); criativos com envio fechado e o
//      motivo; "0 de 1 em operação"; Planos continua no menu; nada de dado
//      de entrega inventado; o servidor segue recusando criativo;
//   4. ponto arquivado → volta a ser conta sem direito nenhum (bloqueio).
//
// Assume banco zerado (tests/e2e/reset-db.sh) e servidor na 3999.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto, recarregarQuieto, redeQuieta } from './espera.mjs';
import { execSync } from 'node:child_process';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim()
    .split('\n')[0];
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) =>
  p.screenshot({ path: new URL(`./saida/v43-${n}.png`, import.meta.url).pathname, fullPage: true });

const email = `dono-ponto-${Date.now()}@teste.com`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Mercearia do Caso Real',
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999994444',
    senha: 'Senha123!',
    aceitou_termos: true,
    endereco: 'Rua José Bonifácio, 100',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990040',
  }),
});
const contaId = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${contaId}`);
check('conta nasce sem plano', PG(`SELECT plano_id IS NULL FROM anunciantes WHERE id = ${contaId}`) === 't');

async function entrar(largura = 1280) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(e.message));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (400|401|404)/.test(m.text())) erros.push(m.text());
  });
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await redeQuieta(p);
  await p.waitForTimeout(600);
  return { p, ctx };
}
const acesso = (p) =>
  p.evaluate(async () => (await (await fetch('/anunciantes/me', { credentials: 'include' })).json()).acesso_painel);

console.log('== 1. sem plano e sem ponto: o bloqueio de sempre ==');
let { p, ctx } = await entrar();
check('bloqueio "Escolha seu plano" aparece', await p.isVisible('#bloqueioPlano'));
check('dashboard escondido', !(await p.isVisible('#dashboardAnuncios')));
check('servidor: acesso não completo, sem motivo', (await acesso(p))?.completo === false);
await shot(p, '1-sem-ponto');

console.log('== 2. pedido de ponto em análise: ainda não é ponto ==');
const candId = PG(
  `INSERT INTO candidaturas (tipo, nome, nome_comercio, contato_telefone, conta_id, logradouro, numero, endereco, bairro, cidade, uf, cep, segmento, fluxo_estimado_mensal, origem)
   VALUES ('ponto', 'Dono', 'Mercearia do Caso Real', '16999994444', ${contaId}, 'Rua José Bonifácio', '100', 'Rua José Bonifácio, 100', 'Centro', 'Matão', 'SP', '15990-040', 'Mercearia', 800, 'painel')
   RETURNING id`,
);
await recarregarQuieto(p);
await p.waitForTimeout(400);
check('pedido em análise não libera o painel', await p.isVisible('#bloqueioPlano'));
check('servidor: pedido não faz dono de ponto', (await acesso(p))?.donoDePonto === false);

console.log('== 3. admin aprova com o painel do dono aberto: ponto aguardando instalação ==');
// Sem F5 (revisão Codex do #108): o painel fica aberto e muda pelo SSE.
await p.evaluate(() => {
  window.__semReload = true;
});
const adminCtx = await b.newContext();
const adm = await adminCtx.newPage();
await irQuieto(adm, `${B}/admin/`);
await adm.fill('#usuario', 'admin');
await adm.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await adm.click('#formLogin button[type=submit]');
await adm.waitForSelector('#app:not([hidden])');
const liberou = await adm.evaluate(
  async (id) => (await fetch(`/admin/candidaturas/${id}/liberar`, { method: 'POST', credentials: 'include' })).ok,
  candId,
);
check('admin aprovou o pedido', liberou);
await adminCtx.close();
const pontoId = PG(`SELECT id FROM pontos WHERE candidatura_id = ${candId}`);
check('ponto materializado aguardando instalação', PG(`SELECT status FROM pontos WHERE id = ${pontoId}`) === 'a_instalar');
check('nenhum plano foi dado à conta', PG(`SELECT plano_id IS NULL FROM anunciantes WHERE id = ${contaId}`) === 't');

const semF5 = await p
  .waitForSelector('[data-criativos-aguardando]', { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
await redeQuieta(p);
await p.waitForTimeout(600);
check('sem F5: o painel aberto abre o dashboard e o "aguardando" dos criativos', semF5 && (await p.evaluate(() => window.__semReload === true)));
const a = await acesso(p);
check('servidor: acesso completo pelo ponto, sem direito de veicular', a?.completo && a.motivo === 'ponto' && !a.podeVeicular, JSON.stringify(a));
check('dashboard completo aparece', await p.isVisible('#dashboardAnuncios'));
check('sem bloqueio de plano', !(await p.$('#bloqueioPlano')));
const textoMain = await p.textContent('main');
check('sem "Escolha seu plano" / "Comece sua primeira campanha"', !/Escolh(a|er) (seu|meu) plano|Comece sua primeira campanha/.test(textoMain));
const faixa = (await p.isVisible('#primeirosPassos')) ? await p.textContent('#primeirosPassos') : '';
check('onboarding do dono: o ponto entrando na rede', /Seu ponto está entrando na rede/.test(faixa), faixa);
check('onboarding não marca plano como feito nem pede plano', !/plano/i.test(faixa.replace(/Plano Básico/g, '')), faixa);
check('Meus pontos: aguardando instalação', /Aguardando instalação/.test(await p.textContent('#modPontos')));
const basico = (await p.isVisible('#modBasico')) ? await p.textContent('#modBasico') : '';
check('Básico: aguardando instalação da tela', /Aguardando instalação da tela/.test(basico), basico);
check('Básico: nunca "Ativo" antes da hora', !/\bAtivo\b/.test(basico));
const resumo = await p.textContent('#resumoConta');
check('chip de plano: "Básico aguardando instalação"', /Básico aguardando instalação/.test(resumo) && !/Sem plano/.test(resumo), resumo);
check('chip de pontos: "0 de 1 em operação"', /0 de 1 em operação/.test(resumo), resumo);
check(
  'criativos: módulo com o envio fechado e o motivo',
  (await p.isVisible('[data-criativos-aguardando]')) &&
    (await p.locator('#botaoEnviarCriativo').count()) === 1 &&
    !(await p.isVisible('#botaoEnviarCriativo')) &&
    !(await p.isVisible('#botaoSubstituirCriativo')) &&
    /Aguardando ativação do benefício/.test(await p.textContent('#modCriativos')),
);
check('Planos continua no menu (opcional, não obrigação)', await p.isVisible('header a[href="/planos.html"]'));
const exib = await p.evaluate(async (id) => (await (await fetch(`/anunciantes/${id}/exibicoes`, { credentials: 'include' })).json()), contaId);
check('nada de entrega inventada (zero exibições)', !exib?.total && !exib?.porPonto?.length, JSON.stringify(exib).slice(0, 200));
const upload = await p.evaluate(async (id) => {
  const fd = new FormData();
  fd.append('arquivo', new Blob([new Uint8Array(10)], { type: 'image/png' }), 'x.png');
  return (await fetch(`/anunciantes/${id}/criativos`, { method: 'POST', body: fd, credentials: 'include' })).status;
}, contaId);
check('servidor continua recusando criativo sem plano/Básico', upload === 400, String(upload));
await shot(p, '2-dono-aguardando-instalacao');
await ctx.close();

console.log('== 3b. mesmo caso no celular ==');
({ p, ctx } = await entrar(390));
check('celular: dashboard sem bloqueio', (await p.isVisible('#dashboardAnuncios')) && !(await p.$('#bloqueioPlano')));
check('celular: sem rolagem horizontal', (await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1);
await shot(p, '3-dono-celular');
await ctx.close();

console.log('== 4. ponto arquivado: sem direito nenhum, volta o bloqueio ==');
PG(`UPDATE pontos SET status = 'arquivado', arquivado_em = now(), motivo_arquivamento = 'e2e' WHERE id = ${pontoId}`);
({ p, ctx } = await entrar());
check('arquivado: bloqueio de plano volta', await p.isVisible('#bloqueioPlano'));
check('servidor: arquivado não dá acesso', (await acesso(p))?.completo === false);
await ctx.close();

check('sem erro de console', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
