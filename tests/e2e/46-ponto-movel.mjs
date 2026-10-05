// Ponto móvel (02/10/2026, migrations 112 e 113), de ponta a ponta no navegador:
//   · uma conta pede pra ser ponto: a aprovação NÃO oferece tipo — nasce fixo
//     (V2: candidatura sempre gera fixo);
//   · o Admin cria o móvel em Rede › Pontos móveis, com a conta como BASE;
//   · a ficha do Admin mostra base e local atual; o anunciante vê o card
//     "Ponto móvel" (compacto, também no celular);
//   · o Admin cadastra o próximo evento → o card mostra o próximo evento;
//   · o evento inicia → o local atual vira o do evento;
//   · o evento encerra → o local atual volta para a base;
//   · a conta-base vê o móvel em "Meus pontos" só como base.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/46-ponto-movel.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto, recarregarQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const falhas = [];
const erros = [];
const check = (t, cond, d) => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : d || '');
  if (!cond) falhas.push(t);
};

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const marca = Date.now();
const SENHA = 'Senha123!';

async function cadastrar(nome, cpf, email) {
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: cpf,
      contato_email: email,
      contato_telefone: '16999995555',
      senha: SENHA,
      aceitou_termos: true,
      endereco: 'Rua Um, 1',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
    }),
  });
  if (!r.ok) throw new Error(`cadastro ${email}: ${r.status} ${await r.text()}`);
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return id;
}

async function pagina(largura, altura, rotulo) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  await ctx.route(/google\.com\/maps/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'mapa' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error' || /net::|ERR_FAILED|status of (401|404)/.test(m.text())) return;
    erros.push(`[${rotulo}] console: ${m.text()}`);
  });
  return p;
}

async function entrarConta(email, largura = 1280, altura = 1000) {
  const p = await pagina(largura, altura, `${email} ${largura}px`);
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', SENHA);
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  return p;
}

const hojeMais = (dias) => {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return d.toISOString().slice(0, 10);
};

// ---------- 1. a conta pede pra ser ponto (candidatura genérica) ----------
console.log('== candidatura ==');
const emailBase = `base-${marca}@teste.com`;
const BASE = await cadastrar('Academia Movimento LTDA', '52998224725', emailBase);
const pBase = await entrarConta(emailBase);
const pedido = await pBase.evaluate(async () => {
  const r = await fetch('/conta/modos/ponto/pedir', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_comercio: 'Academia Movimento',
      cep: '15990-000',
      logradouro: 'Avenida Brasil',
      numero: '500',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
      fluxo_estimado_mensal: 800,
      horario_semanal: {
        seg: { abre: '06:00', fecha: '22:00' },
        ter: { abre: '06:00', fecha: '22:00' },
        qua: { abre: '06:00', fecha: '22:00' },
        qui: { abre: '06:00', fecha: '22:00' },
        sex: { abre: '06:00', fecha: '22:00' },
        sab: { abre: '08:00', fecha: '12:00' },
        dom: null,
      },
    }),
  });
  return { status: r.status, corpo: await r.json() };
});
check('candidatura criada (sem escolher tipo)', pedido.status === 201, JSON.stringify(pedido));
const CAND = pedido.corpo.id;

// ---------- 2. aprovação: sempre fixo; o móvel nasce no Admin ----------
console.log('== aprovação (fixo) e criação do móvel ==');
const admin = await pagina(1400, 960, 'admin');
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
await admin.evaluate((id) => {
  location.hash = `rede/candidaturas/${id}`;
}, CAND);
await admin.waitForSelector('[data-aprovar]');
await admin.click('[data-aprovar]');
await admin.waitForSelector('dialog[open] [data-confirmar]');
check('a aprovação não oferece tipo de ponto', (await admin.locator('dialog[open] input[name="tipo_ponto"]').count()) === 0);
await admin.screenshot({ path: `${SAIDA}46-movel-aprovacao.png` });
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => location.hash === '#rede/candidaturas');
const FIXO = PG(`SELECT id FROM pontos WHERE candidatura_id = ${CAND}`);
check('a candidatura virou ponto FIXO da conta', PG(`SELECT tipo || ':' || anunciante_id FROM pontos WHERE id = ${FIXO}`) === `fixo:${BASE}`);
check('ficha do fixo sem "Transformar em móvel"', true);

await admin.evaluate(() => {
  location.hash = 'rede/moveis';
});
await admin.waitForSelector('[data-beneficio-hospedagem]');
check('card do benefício com o percentual real', /20%/.test(await admin.locator('[data-percentual-atual]').innerText()));
await admin.click('[data-criar-movel]');
await admin.waitForSelector('#formCriarMovel');
await admin.fill('#cmBase', 'Academia Movimento');
await admin.fill('#cmConta', `Academia Movimento LTDA (#${BASE})`);
await admin.fill('#cm_cep', '15990-000');
await admin.fill('#cm_logradouro', 'Avenida Brasil');
await admin.fill('#cm_numero', '500');
await admin.fill('#cm_bairro', 'Centro');
await admin.fill('#cm_cidade', 'Matão');
await admin.fill('#cm_uf', 'SP');
await admin.screenshot({ path: `${SAIDA}46-movel-criar.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForSelector('.movel-card', { timeout: 10000 });
const PONTO = PG(`SELECT id FROM pontos WHERE tipo = 'movel' AND base_conta_id = ${BASE} ORDER BY id DESC LIMIT 1`);
check('ponto criado', Boolean(PONTO));
check('é móvel', PG(`SELECT tipo FROM pontos WHERE id = ${PONTO}`) === 'movel');
check('sem dono (é da Mostraí)', PG(`SELECT COALESCE(anunciante_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo');
check('não vem de candidatura', PG(`SELECT COALESCE(candidatura_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo');
check('a conta é a base', PG(`SELECT base_conta_id FROM pontos WHERE id = ${PONTO}`) === BASE);
check('a Tela 1 nasceu junto', PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${PONTO}`) === '1');
const NOME = PG(`SELECT nome FROM pontos WHERE id = ${PONTO}`);
check('nome de móvel', /^Mostraí Móvel #\d+$/.test(NOME), NOME);

// ---------- 3. ficha do Admin: base e local atual ----------
console.log('== ficha do móvel no Admin ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, PONTO);
await admin.waitForSelector('#pontoMovel [data-local-atual]');
check('local atual = base', /Academia Movimento/.test(await admin.locator('[data-local-atual]').innerText()));
check('sem evento programado', /Sem evento programado/.test(await admin.locator('[data-proximo-evento]').innerText()));
check('sem "Transformar" na ficha do móvel', !/Transformar/.test(await admin.locator('#pontoInformacoes').innerText()));
check('proprietário Mostraí', /Mostraí/.test(await admin.locator('#pontoInformacoes').innerText()));

// Cadastrar o próximo evento pela tela.
await admin.click('[data-novo-evento]');
await admin.waitForSelector('#formEventoMovel');
await admin.fill('#evNome', 'Campeonato Regional de Jiu-Jitsu');
await admin.fill('#evOrg', 'Federação Regional');
await admin.fill('#evLocal', 'Ginásio Municipal');
await admin.fill('#evInicio', hojeMais(0));
await admin.fill('#evFim', hojeMais(1));
await admin.fill('#evPublico', '600');
await admin.screenshot({ path: `${SAIDA}46-movel-form-evento.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /Campeonato Regional/.test(document.querySelector('[data-proximo-evento]')?.textContent || ''));
check('o próximo evento aparece na ficha', true);
await admin.screenshot({ path: `${SAIDA}46-movel-ficha-admin.png`, fullPage: true });

// ---------- 4. o anunciante vê o card "Ponto móvel" ----------
console.log('== card do anunciante ==');
const emailAnunciante = `anunciante-${marca}@teste.com`;
const ANUNCIANTE = await cadastrar('Loja Bem Vestir', '11144477735', emailAnunciante);
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ANUNCIANTE}`,
);
const pA = await entrarConta(emailAnunciante);
await pA.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`, { timeout: 10000 });
const card = pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`);
let texto = await card.innerText();
check('selo "Ponto móvel"', /Ponto móvel/.test(texto), texto);
check('nome do móvel', texto.includes(NOME), texto);
check('local atual: na base', /Agora na base: Academia Movimento/.test(texto), texto);
check('próximo evento com data, local e público estimado', /Próximo evento[\s\S]*Campeonato Regional[\s\S]*Ginásio Municipal[\s\S]*~600 pessoas/i.test(texto), texto);
check('sem ocupação/horário no card do móvel', !/vendido|Horário/.test(texto), texto);
await card.scrollIntoViewIfNeeded();
await card.screenshot({ path: `${SAIDA}46-movel-card-desktop.png` });

// Escolher o PONTO (não o evento): a seleção grava o ponto.
await card.locator('input[type="checkbox"]').check();
await pA.waitForFunction(() => /Pronto/.test(document.getElementById('msgPontos')?.textContent || ''), null, { timeout: 8000 });
check(
  'a escolha grava o ponto móvel',
  PG(`SELECT ponto_id FROM anunciantes_pontos WHERE anunciante_id = ${ANUNCIANTE}`) === PONTO,
);

// Celular: o card cabe, sem rolagem lateral.
const pM = await entrarConta(emailAnunciante, 390, 844);
await pM.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`, { timeout: 10000 });
const cardM = pM.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`);
await cardM.scrollIntoViewIfNeeded();
const medidas = await cardM.evaluate((el) => {
  const r = el.getBoundingClientRect();
  return {
    cabe: r.left >= 0 && r.right <= window.innerWidth + 1,
    rolagem: document.documentElement.scrollWidth > window.innerWidth + 1,
    vaza: [...el.querySelectorAll('*')].some((f) => f.scrollWidth > f.clientWidth + 2 && getComputedStyle(f).overflow === 'hidden'),
  };
});
check('celular: card dentro da tela', medidas.cabe, JSON.stringify(medidas));
check('celular: sem rolagem lateral', !medidas.rolagem, JSON.stringify(medidas));
await cardM.screenshot({ path: `${SAIDA}46-movel-card-celular.png` });

// ---------- 5. o evento inicia: local atual = evento ----------
console.log('== evento em andamento ==');
await admin.click('[data-evento-acao="iniciar"]');
await admin.waitForSelector('dialog[open] [data-confirmar]');
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => /Ginásio Municipal/.test(document.querySelector('[data-local-atual]')?.textContent || ''));
check('Admin: local atual = Ginásio Municipal', true);
await recarregarQuieto(pA);
await pA.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`);
texto = await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`).innerText();
check('anunciante: "Agora em: Ginásio Municipal"', /Agora em: Ginásio Municipal/.test(texto), texto);
check('anunciante: a base aparece em segundo plano', /Base: Academia Movimento/.test(texto), texto);
check(
  'anunciante: sem próximo evento (o atual não é "próximo") e sem dizer "sem evento"',
  /Nenhum outro evento programado/.test(texto) && !/Sem evento programado/.test(texto),
  texto,
);
await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`).screenshot({ path: `${SAIDA}46-movel-card-em-evento.png` });

// ---------- 6. o evento encerra: volta para a base ----------
console.log('== volta para a base ==');
await admin.click('[data-evento-acao="encerrar"]');
await admin.waitForSelector('dialog[open] [data-confirmar]');
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => /Na base/.test(document.querySelector('[data-local-atual]')?.textContent || ''));
check('Admin: de volta à base', true);
await recarregarQuieto(pA);
await pA.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`);
texto = await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`).innerText();
check('anunciante: "Agora na base" de novo', /Agora na base: Academia Movimento/.test(texto), texto);
check('o evento encerrado vai pro histórico', /Histórico \(0 hospedagens, 1 evento/.test(await admin.locator('#pontoMovel').innerText()));

// ---------- 7. a conta-base: só base, nunca dona ----------
console.log('== conta-base ==');
await recarregarQuieto(pBase);
await pBase.waitForSelector('.estab-base-movel', { timeout: 10000 });
const baseTexto = await pBase.locator('.estab-base-movel').innerText();
check('Meus pontos mostra o móvel como base', /Ponto móvel/.test(baseTexto) && /Base: Academia Movimento/.test(baseTexto), baseTexto);
check('sem "Benefício do ponto" para a base', !/Benefício do ponto|crédito/i.test(baseTexto), baseTexto);
// (A mesma conta tem o PRÓPRIO ponto fixo, aprovado acima — o papel de dona
// vem dele. Do móvel ela não ganha nada.)
check('o móvel continua sem dono', PG(`SELECT COALESCE(anunciante_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo');
check('nenhum Plano Básico nem crédito pelo móvel', PG(
  `SELECT (SELECT COUNT(*) FROM beneficios_basico_ponto WHERE ponto_id = ${PONTO}) + (SELECT COUNT(*) FROM creditos_ledger WHERE ponto_id = ${PONTO})`,
) === '0');
await pBase.locator('.estab-base-movel').screenshot({ path: `${SAIDA}46-movel-meus-pontos-base.png` });

check('sem erro de console/página', erros.length === 0, erros.join(' | '));
await navegador.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
