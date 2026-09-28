// Lote PONTOS/REDE (finalização, 28/09/2026):
//   · "Quero ser um ponto" e "Cadastrar outro estabelecimento" abrem numa
//     linha da largura toda do painel (≈65% formulário / 35% preview e
//     contexto), não na coluna lateral estreita; celular: uma coluna, nada
//     vaza, sem rolagem lateral;
//   · "Onde seu anúncio aparece": um card por ponto (foto, nome quebrando em
//     linhas, estado, endereço, horário, ocupação, "Seu ponto", mapa), grade
//     no desktop e uma coluna no celular; nome comprido não é cortado;
//   · a escolha salva um pedido por vez (dois cliques seguidos nunca viram
//     dois PUTs em paralelo) e, se o servidor recusar, as caixas voltam ao
//     que estava salvo;
//   · Admin → Rede → Ponto: a linha secundária de um dado (contato, benefício)
//     quebra em vez de vazar do card; sem rolagem lateral no celular.
// Assume servidor na 3999 e o banco do .env (sem dado de produção).
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
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
const shot = (p, n) => p.screenshot({ path: `${SAIDA}pontos-rede-${n}.png`, fullPage: true });
const IMAGEM = `${B}/img/exemplo-ponto-completo-720.jpg`;
const semRolagemLateral = (p) =>
  p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
// Nada dentro do elemento passa da borda direita dele (o que vazava antes:
// input do CEP, "Fechado" do horário, nome do ponto). Ignora só o que está
// dentro de uma caixa que rola de propósito (.u-ox-auto) — o próprio
// overflow do elemento não conta: o Chrome dá `overflow: clip` a todo <input>.
const nadaVaza = (p, sel) =>
  p.$eval(sel, (raiz) => {
    const lim = raiz.getBoundingClientRect().right + 1;
    const rola = (el) => {
      for (let a = el.parentElement; a && a !== raiz; a = a.parentElement) {
        if (/auto|scroll|hidden/.test(getComputedStyle(a).overflowX)) return true;
      }
      return false;
    };
    const ruins = [...raiz.querySelectorAll('*')]
      .filter((el) => el.getClientRects().length && !rola(el) && el.getBoundingClientRect().right > lim)
      .map((el) => `${el.tagName.toLowerCase()}#${el.id}.${[...el.classList].join('.')}@${Math.round(el.getBoundingClientRect().right)}`);
    return ruins.length ? ruins.slice(0, 5).join(' ') : true;
  });

// ---------------------------------------------------------------------------
// Dados: conta A (plano + ponto próprio) e conta B (sem nada); quatro pontos
// no ar, um deles com nome comprido e um com foto.
// ---------------------------------------------------------------------------
const marca = Date.now();
async function cadastrar(nome, email) {
  await fetch(`${B}/anunciantes/cadastro`, {
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
    }),
  });
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return id;
}
const emailA = `pontos-a-${marca}@teste.com`;
const emailB = `pontos-b-${marca}@teste.com`;
const CONTA_A = await cadastrar('Padaria Pontos A', emailA);
const CONTA_B = await cadastrar('Loja Pontos B', emailB);
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${CONTA_A}`,
);
const H24 = JSON.stringify(
  Object.fromEntries(['seg', 'ter', 'qua', 'qui', 'sex', 'sab', 'dom'].map((d) => [d, { abre: '00:00', fecha: '24:00' }])),
);
function ponto({ nome, dono = 'NULL', horario = `'${H24}'::jsonb`, foto = 'NULL', contato = "'1'" }) {
  const id = PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, horario_semanal, anunciante_id, foto_instalacao_url, status)
     VALUES ('${nome}', 'Avenida Presidente Getúlio Vargas Filho Sobrinho, 1234 - Sala 56', 'Matão', 'SP', '15990000', 'outro', 'Carla', ${contato}, ${horario}, ${dono}, ${foto}, 'em_operacao') RETURNING id`,
  )
    .split('\n')[0]
    .trim();
  PG(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES (${id}, 'Tela 1', 'ativo')`);
  return Number(id);
}
const PROPRIO = ponto({
  nome: `Padaria Pontos A (loja) ${marca}`,
  dono: CONTA_A,
  contato: "'16 99999-0003 / 16 3382-0000 (recepção) / WhatsApp 16 99999-0004 (gerência)'",
});
const LONGO = ponto({
  nome: `Academia Corpo em Movimento Studio de Pilates e Musculação Unidade Centro Matão ${marca}`,
  foto: `'${IMAGEM}'`,
});
const PALAVRAO = ponto({ nome: `Supermercadoextraordinariamentegrandedobairro${marca}`, horario: 'NULL' });
const CURTO = ponto({ nome: `Farmácia ${marca}` });

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
function vigiar(p, nome) {
  p.on('pageerror', (e) => erros.push(`[${nome}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409|500)/.test(m.text()) && !/net::|ERR_FAILED/.test(m.text()))
      erros.push(`[${nome}] console: ${m.text()}`);
  });
  p.on('dialog', (d) => {
    falha('diálogo nativo do navegador', d.message());
    d.dismiss().catch(() => {});
  });
  return p;
}
async function entrar(email, largura) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = vigiar(await ctx.newPage(), email.split('-')[1]);
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForSelector('#modPontos:not([hidden])', { timeout: 10000 });
  await p.evaluate(() => {
    window.__semReload = true;
  });
  return { p, ctx };
}

// Formulário aberto: linha própria da grade, formulário largo, preview ao lado.
async function conferirFormLargo(p, formSel, rotulo) {
  await p.waitForSelector(formSel);
  const m = await p.evaluate((sel) => {
    const raiz = document.getElementById('pontosNovo');
    const form = document.querySelector(sel).getBoundingClientRect();
    const prev = document.querySelector('#pontosNovo .candidatura-preview').getBoundingClientRect();
    const grade = document.querySelector('.painel-grid');
    const est = getComputedStyle(grade);
    return {
      naGrade: raiz.parentElement === grade,
      largura: raiz.getBoundingClientRect().width,
      grade: grade.clientWidth - Number.parseFloat(est.paddingLeft) - Number.parseFloat(est.paddingRight),
      form,
      prev,
      contexto: !!document.querySelector('#pontosNovo .ponto-form-depois'),
    };
  }, formSel);
  check(`${rotulo}: abre numa linha própria da grade do painel`, m.naGrade);
  check(`${rotulo}: ocupa a largura toda`, m.largura >= m.grade - 2, `${m.largura} de ${m.grade}`);
  check(`${rotulo}: formulário com ≥ 55% da largura`, m.form.width >= m.largura * 0.55, `${Math.round(m.form.width)} de ${Math.round(m.largura)}`);
  check(`${rotulo}: preview ao lado (à direita)`, m.prev.left >= m.form.right - 1, JSON.stringify({ form: m.form.right, prev: m.prev.left }));
  check(`${rotulo}: "o que acontece depois" ao lado`, m.contexto);
  { const v = await nadaVaza(p, '#pontosNovo'); check(`${rotulo}: nada vaza do formulário`, v === true, v); }
  check(`${rotulo}: sem rolagem lateral`, await semRolagemLateral(p));
}

// ===========================================================================
console.log('== conta sem ponto: "Quero ser um ponto" ==');
{
  const { p, ctx } = await entrar(emailB, 1366);
  await p.click('[data-acao="abrir-oportunidade"]');
  await conferirFormLargo(p, '#formCardPonto', 'compacto');
  await shot(p, 'compacto-desktop');
  await p.click('#pontosNovo .panel-head [data-acao="fechar-form"]');
  await p.waitForSelector('[data-acao="abrir-oportunidade"]');
  check('Fechar no cabeçalho fecha e devolve o convite', await p.evaluate(() => document.getElementById('pontosNovo').hidden));

  await p.setViewportSize({ width: 390, height: 844 });
  await p.click('[data-acao="abrir-oportunidade"]');
  await p.waitForSelector('#formCardPonto');
  await p.waitForTimeout(300);
  const mob = await p.evaluate(() => {
    const form = document.getElementById('formCardPonto').getBoundingClientRect();
    const prev = document.querySelector('#pontosNovo .candidatura-preview').getBoundingClientRect();
    return { form, prev };
  });
  check('celular: uma coluna (preview embaixo do formulário)', mob.prev.top >= mob.form.bottom - 1);
  { const v = await nadaVaza(p, '#pontosNovo'); check('celular: nada vaza', v === true, v); }
  check('celular: sem rolagem lateral', await semRolagemLateral(p));
  await shot(p, 'compacto-celular');
  check('sem reload', await p.evaluate(() => window.__semReload === true));
  await ctx.close();
}

// ===========================================================================
console.log('== conta com plano e ponto próprio: cards + outro estabelecimento ==');
const { p, ctx } = await entrar(emailA, 1280);
await p.waitForSelector('#listaPontos .ponto-escolha', { timeout: 10000 });
const card = (id) => p.locator(`.ponto-escolha[data-ponto-id="${id}"]`);
check('grade com mais de uma coluna no desktop', await p.$eval('#listaPontos', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length > 1));
for (const id of [PROPRIO, LONGO, PALAVRAO, CURTO]) check(`ponto ${id} na lista`, (await card(id).count()) === 1);
const nome = await card(LONGO)
  .locator('.ponto-nome')
  .evaluate((el) => ({ linhas: Math.round(el.clientHeight / Number.parseFloat(getComputedStyle(el).lineHeight)), cabe: el.scrollWidth <= el.clientWidth + 1 }));
check('nome comprido quebra em linhas', nome.linhas >= 2, JSON.stringify(nome));
check('nome comprido não é cortado', nome.cabe);
check('palavra sem espaço não vaza do card', await card(PALAVRAO).evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
{ const v = await nadaVaza(p, '#listaPontos'); check('nada vaza da lista', v === true, v); }
check('foto do ponto no card', (await card(LONGO).locator('img[data-foto]').count()) === 1);
check('sem foto: placeholder', (await card(CURTO).locator('.ponto-foto-placeholder').count()) === 1);
check('estado no card', /Ativo/.test(await card(CURTO).locator('.ponto-estado').textContent()));
check('endereço com cidade/UF', /Matão\/SP/.test(await card(CURTO).locator('.ponto-end').textContent()));
check('horário 24h', /24h/.test(await card(CURTO).locator('.ponto-horario').textContent()));
check('sem horário cadastrado = "Aberto 24 horas" (como no admin)', (await card(PALAVRAO).locator('.ponto-horario').textContent()) === 'Aberto 24 horas');
check('link do mapa', /google\.com\/maps/.test(await card(CURTO).locator('.ponto-mapa').getAttribute('href')));
check('"Seu ponto" no próprio', (await card(PROPRIO).locator('.selo-seu-ponto').textContent()) === 'Seu ponto');
check('próprio nunca vem marcado', !(await card(PROPRIO).locator('input').isChecked()));
await shot(p, 'cards-desktop');

console.log('== um PUT por vez; recusa volta ao salvo ==');
let emVoo = 0;
let maxEmVoo = 0;
let puts = 0;
p.on('request', (r) => {
  if (r.method() === 'PUT' && r.url().endsWith('/anunciantes/me/pontos')) {
    puts += 1;
    emVoo += 1;
    maxEmVoo = Math.max(maxEmVoo, emVoo);
  }
});
p.on('requestfinished', (r) => {
  if (r.method() === 'PUT' && r.url().endsWith('/anunciantes/me/pontos')) emVoo -= 1;
});
p.on('requestfailed', (r) => {
  if (r.method() === 'PUT' && r.url().endsWith('/anunciantes/me/pontos')) emVoo -= 1;
});
// Dois cliques seguidos, sem esperar o primeiro salvar.
await card(CURTO).locator('input').click();
await card(LONGO).locator('input').click();
await p.waitForFunction(() => /Salvo/.test(document.getElementById('msgPontos').textContent), null, { timeout: 8000 });
await p.waitForTimeout(400);
check('nunca dois PUTs em paralelo', maxEmVoo === 1, `máximo em voo: ${maxEmVoo}`);
check('no máximo um PUT por clique', puts <= 2, String(puts));
check(
  'banco tem os dois escolhidos',
  PG(`SELECT string_agg(ponto_id::text, ',' ORDER BY ponto_id) FROM anunciantes_pontos WHERE anunciante_id = ${CONTA_A}`) ===
    [CURTO, LONGO].sort((a, c) => a - c).join(','),
);
check('contador "2 de 3"', (await p.textContent('#contadorPontos')) === '2 de 3 pontos selecionados');

await p.route('**/anunciantes/me/pontos', (rota) =>
  rota.request().method() === 'PUT'
    ? rota.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ erro: 'falhou de propósito' }) })
    : rota.continue(),
);
await card(PALAVRAO).locator('input').click();
await p.waitForFunction(() => document.getElementById('msgPontos').classList.contains('err'), null, { timeout: 8000 });
check('mensagem explica a recusa e a volta', /falhou de propósito/i.test(await p.textContent('#msgPontos')) && /voltou/.test(await p.textContent('#msgPontos')), await p.textContent('#msgPontos'));
check('caixa recusada voltou a desmarcada', !(await card(PALAVRAO).locator('input').isChecked()));
check('as salvas continuam marcadas', (await card(CURTO).locator('input').isChecked()) && (await card(LONGO).locator('input').isChecked()));
check('contador voltou pra "2 de 3"', (await p.textContent('#contadorPontos')) === '2 de 3 pontos selecionados');
await p.unroute('**/anunciantes/me/pontos');

console.log('== "Cadastrar outro estabelecimento" ==');
await p.click('#btnNovoPonto');
await conferirFormLargo(p, '#formNovoPonto', 'completo');
await shot(p, 'completo-desktop');
await p.click('#formNovoPonto [data-acao="fechar-form"]');
check('Cancelar fecha o formulário', await p.evaluate(() => document.getElementById('pontosNovo').hidden));
check('botão "Cadastrar outro" volta', await p.isVisible('#btnNovoPonto'));

console.log('== celular ==');
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(300);
check('celular: cards numa coluna', await p.$eval('#listaPontos', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').length === 1));
check('celular: foto pequena ao lado do texto', await card(CURTO).evaluate((el) => el.querySelector('.ponto-foto').getBoundingClientRect().width < 120));
{ const v = await nadaVaza(p, '#listaPontos'); check('celular: nada vaza dos cards', v === true, v); }
check('celular: sem rolagem lateral', await semRolagemLateral(p));
await shot(p, 'cards-celular');
await p.click('#btnNovoPonto');
await p.waitForSelector('#formNovoPonto');
await p.waitForTimeout(300);
{ const v = await nadaVaza(p, '#pontosNovo'); check('celular: formulário completo não vaza', v === true, v); }
check('celular: formulário completo sem rolagem lateral', await semRolagemLateral(p));
await shot(p, 'completo-celular');
check('sem reload', await p.evaluate(() => window.__semReload === true));
await ctx.close();

// ===========================================================================
console.log('== Admin → Rede → Ponto ==');
async function admin(largura) {
  const c = await b.newContext({ viewport: { width: largura, height: 900 } });
  const pg = vigiar(await c.newPage(), 'admin');
  await irQuieto(pg, `${B}/admin/index.html`);
  await pg.fill('#usuario', process.env.ADMIN_USER || 'admin');
  await pg.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
  await pg.click('#formLogin button[type=submit]');
  await pg.waitForSelector('#conteudo .panel, #conteudo .visao-geral-colunas', { timeout: 15000 }).catch(async (e) => {
    await shot(pg, `admin-login-falhou-${largura}`);
    throw e;
  });
  await pg.evaluate((id) => {
    location.hash = `rede/pontos/${id}`;
  }, PROPRIO);
  await pg.waitForSelector('[data-editar-horario]', { timeout: 10000 });
  await pg.waitForTimeout(300);
  return { pg, c };
}
for (const largura of [1366, 390]) {
  const { pg, c } = await admin(largura);
  const rotulo = largura === 390 ? 'admin celular' : 'admin desktop';
  check(`${rotulo}: contato do responsável não vaza do card`, await pg.$eval('.dado-sub', (el) => el.getBoundingClientRect().right <= el.closest('.panel, .card, article').getBoundingClientRect().right + 1));
  { const v = await nadaVaza(pg, '#conteudo'); check(`${rotulo}: nada vaza da ficha`, v === true, v); }
  check(`${rotulo}: sem rolagem lateral`, await semRolagemLateral(pg));
  await shot(pg, `admin-${largura}`);
  await c.close();
}

await b.close();
check('sem erro de console', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
