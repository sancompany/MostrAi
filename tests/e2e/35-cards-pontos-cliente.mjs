// Cards de pontos do cliente (estação de 28/09/2026): "Onde seu anúncio
// aparece" com o mesmo molde do card de Rede > Pontos do admin — foto da
// fachada (ou placeholder), nome e estado, endereço, segmento, horário,
// ocupação, "Seu ponto" e a seleção no pé, dita em texto. Só a apresentação
// mudou; o roteiro confere que a escolha continua igual:
//   · lista inteira, card por card, com os dados da vitrine pública (GET /pontos);
//   · marcar e desmarcar clicando no card, na caixa e pelo teclado — salva no banco;
//   · selecionado destacado (borda da marca) e dito em texto;
//   · o próprio ponto primeiro, com o selo, o texto e nunca marcado sozinho;
//   · limite do plano trava os outros, ponto sem espaço/bloqueado fica apagado;
//   · o mapa abre sem marcar; a busca filtra; a vitrine fora do ar não quebra a escolha;
//   · desktop, tablet e celular sem rolagem lateral, sem texto vazando nem selo em cima do nome.
// Banco zerado, servidor na 3999 e o .env carregado (DATABASE_URL):
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/35-cards-pontos-cliente.mjs
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
const BRAND = 'rgb(255, 122, 26)';

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));

// ---------------------------------------------------------------------------
// Rede de teste. Fotos de fachada desenhadas aqui mesmo (data: URL, liberado
// pela CSP em img-src) — nenhum binário de teste no repositório.
// ---------------------------------------------------------------------------
async function fachada({ nome, parede, toldo }) {
  const p = await navegador.newPage({ viewport: { width: 640, height: 400 } });
  await p.setContent(`<body style="margin:0;font-family:Arial,sans-serif">
    <div style="position:relative;width:640px;height:400px;background:linear-gradient(#bfe3f7,#e9f5fc 55%)">
      <div style="position:absolute;left:40px;right:40px;top:40px;bottom:46px;background:${parede}"></div>
      <div style="position:absolute;left:70px;right:70px;top:62px;height:62px;background:#fff;border-radius:6px;display:flex;align-items:center;justify-content:center;color:${toldo};font-weight:800;font-size:30px;letter-spacing:2px;text-transform:uppercase">${nome}</div>
      <div style="position:absolute;left:52px;right:52px;top:140px;height:44px;background:repeating-linear-gradient(90deg,${toldo} 0 36px,#fff 36px 72px);clip-path:polygon(0 0,100% 0,97% 100%,3% 100%)"></div>
      <div style="position:absolute;left:78px;width:170px;top:206px;height:110px;background:linear-gradient(135deg,#9fd3e6,#e8f6fb 60%,#9fd3e6);border:6px solid #3a3a3a"></div>
      <div style="position:absolute;right:78px;width:170px;top:206px;height:110px;background:linear-gradient(135deg,#9fd3e6,#e8f6fb 60%,#9fd3e6);border:6px solid #3a3a3a"></div>
      <div style="position:absolute;left:284px;width:72px;top:196px;bottom:46px;background:#3b2d20;border:5px solid #3a3a3a;border-bottom:0"></div>
      <div style="position:absolute;left:0;right:0;bottom:0;height:46px;background:#b9bec6"></div>
    </div></body>`);
  const buf = await p.screenshot({ type: 'jpeg', quality: 70 });
  await p.close();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

const marca = Date.now();
const email = `cards-${marca}@teste.com`;
await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Padaria Pão Dourado',
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
const CONTA = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
// Essencial: 3 pontos no plano.
PG(
  `UPDATE anunciantes SET email_confirmado = true, plano_id = 'essencial-1m', data_inicio_cobertura = now(),
   data_expiracao = now() + interval '20 days' WHERE id = ${CONTA}`,
);
const cat = (nome) => PG(`SELECT id FROM categorias WHERE nome = '${nome}'`);
const dia = (abre, fecha) => ({ abre, fecha });
const horario = (semana, sab, dom) =>
  JSON.stringify({ seg: semana, ter: semana, qua: semana, qui: semana, sex: semana, sab, dom });
const H24 = horario(dia('00:00', '24:00'), dia('00:00', '24:00'), dia('00:00', '24:00'));

function ponto({ nome, rua, bairro, categoria, status, foto = null, h = H24, dono = 'NULL', tela = 'operando' }) {
  const id = Number(
    PG(
      `INSERT INTO pontos (nome, endereco, bairro, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato,
         horario_semanal, anunciante_id, categoria_id, foto_instalacao_url, status)
       VALUES ('${nome}', '${rua}', '${bairro}', 'Matão', 'SP', '15990000', 'outro', 'R', '1', '${h}'::jsonb,
         ${dono}, ${cat(categoria)}, ${foto ? `'${foto}'` : 'NULL'}, '${status}') RETURNING id`,
    ).split('\n')[0],
  );
  if (tela === 'operando')
    PG(
      `INSERT INTO dispositivos (ponto_id, apelido, status, chave_hash, provisionado_em, primeiro_sinal_em, ultima_vez_online)
       VALUES (${id}, 'Tela 1', 'ativo', md5(random()::text), now(), now(), now())`,
    );
  if (tela === 'sem_sinal')
    PG(
      `INSERT INTO dispositivos (ponto_id, apelido, status, chave_hash, provisionado_em)
       VALUES (${id}, 'Tela 1', 'ativo', md5(random()::text), now())`,
    );
  if (tela === 'reparo') PG(`INSERT INTO dispositivos (ponto_id, apelido, status) VALUES (${id}, 'Tela 1', 'reparo')`);
  return id;
}
// Ocupação: contas do Prime (180 s/h = 5% da hora) que escolheram o ponto.
function ocupar(pontoId, contas) {
  PG(
    `WITH n AS (
       INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em, plano_id, email_confirmado)
       SELECT 'Ocupação ' || g, '00000000000', 'ocupa-${pontoId}-' || g || '-${marca}@teste.com', '16999990000', 'x', now(), 'maximo-1m', true
         FROM generate_series(1, ${contas}) g RETURNING id)
     INSERT INTO anunciantes_pontos (anunciante_id, ponto_id) SELECT id, ${pontoId} FROM n`,
  );
}

const FOTO_MERCADO = await fachada({ nome: 'Mercado Central', parede: '#d9eadb', toldo: '#1f7a3f' });
const P = {};
P.proprio = ponto({
  nome: 'Padaria Pão Dourado',
  rua: 'Rua Sete de Setembro, 480',
  bairro: 'Centro',
  categoria: 'Padaria',
  status: 'em_operacao',
  dono: CONTA,
  foto: await fachada({ nome: 'Pão Dourado', parede: '#f3d9a4', toldo: '#8a4b12' }),
  h: horario(dia('06:00', '20:00'), dia('06:00', '14:00'), null),
});
P.mercado = ponto({
  nome: 'Mercado Central',
  rua: 'Avenida Sete de Setembro, 1200',
  bairro: 'Vila Santa Cruz',
  categoria: 'Mercado / Supermercado',
  status: 'em_operacao',
  foto: FOTO_MERCADO,
  h: horario(dia('07:00', '21:00'), dia('07:00', '21:00'), dia('08:00', '13:00')),
});
P.farmacia = ponto({
  nome: 'Farmácia Bem Estar',
  rua: 'Rua Narciso Baldan, 77',
  bairro: 'Jardim Paraíso',
  categoria: 'Farmácia / Drogaria',
  status: 'em_operacao',
});
P.sorveteria = ponto({
  nome: 'Sorveteria Gelato',
  rua: 'Praça da Matriz, 15',
  bairro: 'Centro',
  categoria: 'Sorveteria',
  status: 'em_operacao',
  foto: await fachada({ nome: 'Gelato', parede: '#fbe0ea', toldo: '#c2185b' }),
});
P.otica = ponto({
  nome: 'Ótica Visão Clara',
  rua: 'Rua Rui Barbosa, 950',
  bairro: 'Centro',
  categoria: 'Ótica',
  status: 'em_operacao',
  foto: await fachada({ nome: 'Visão Clara', parede: '#dde7f7', toldo: '#1d4ed8' }),
});
P.academia = ponto({
  nome: 'Academia Força Total',
  rua: 'Rua Brasil, 300',
  bairro: 'Jardim do Bosque',
  categoria: 'Academia',
  status: 'a_instalar',
  tela: 'nenhuma',
});
// Foto em pé: enquadrada no formato canônico 16:9 (object-fit: cover),
// como em todos os cards de ponto (estação Rede/Admin V2).
P.barbearia = ponto({
  nome: 'Barbearia do Zé',
  rua: 'Rua Tiradentes, 55',
  bairro: 'Centro',
  categoria: 'Barbearia',
  status: 'aguardando_primeiro_sinal',
  foto: '/img/exemplo-ponto-completo-720.jpg',
  tela: 'sem_sinal',
});
const NOME_LONGO = 'Pet Shop Amigo Fiel — Banho, Tosa e Hotel para Pets da Vila Santa Cruz';
P.pet = ponto({
  nome: NOME_LONGO,
  rua: 'Rua Joaquim Silveira Mello, 1234',
  bairro: 'Vila Santa Cruz',
  categoria: 'Pet shop',
  status: 'em_reparo',
  foto: await fachada({ nome: 'Amigo Fiel', parede: '#ffe4cc', toldo: '#e0640a' }),
  tela: 'reparo',
});
ocupar(P.mercado, 4); // 20%
ocupar(P.farmacia, 9); // 45%
ocupar(P.sorveteria, 20); // 100%: sem espaço
ocupar(P.otica, 17); // 85%: cruzou 80%, não aceita escolha nova
const NA_REDE = Number(
  PG(`SELECT COUNT(*) FROM pontos WHERE status IN ('em_operacao','aguardando_primeiro_sinal','a_instalar','em_reparo')`),
);
const escolhidos = () =>
  PG(
    `SELECT COALESCE(string_agg(ponto_id::text, ',' ORDER BY ponto_id), '') FROM anunciantes_pontos WHERE anunciante_id = ${CONTA}`,
  );
const ids = (...pontos) => pontos.sort((a, b) => a - b).join(',');

// ---------------------------------------------------------------------------
// Ajudantes de página
// ---------------------------------------------------------------------------
// `vitrine`: 'ok' (normal), 'falha' (GET /pontos responde 500) ou 'trava'
// (GET /pontos nunca responde — a lista não pode esperar pra sempre).
// PUT recusado de propósito (seção "recusa volta ao salvo"): o 500 no console é esperado.
let recusaSimulada = false;
async function entrar(largura, altura, { vitrine = 'ok' } = {}) {
  const semVitrine = vitrine !== 'ok';
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  // O mapa abre numa aba nova; aqui ele não sai pra internet.
  await ctx.route(/google\.com\/maps/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'mapa' }));
  const p = await ctx.newPage();
  const rotulo = `${largura}px${semVitrine ? ` vitrine ${vitrine}` : ''}`;
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/net::|ERR_FAILED/.test(m.text())) return;
    if (semVitrine && /status of 500/.test(m.text())) return; // a falha simulada
    if (recusaSimulada && /status of 500/.test(m.text())) return;
    erros.push(`[${rotulo}] console: ${m.text()}`);
  });
  if (vitrine === 'falha')
    await p.route((url) => url.pathname === '/pontos', (r) => r.fulfill({ status: 500, body: '{}' }));
  if (vitrine === 'trava') await p.route((url) => url.pathname === '/pontos', () => {});
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', 'Senha123!');
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForSelector('#listaPontos .ponto-escolha', { timeout: 10000 });
  return { p, ctx };
}
const card = (p, id) => p.locator(`.ponto-escolha[data-ponto-id="${id}"]`);
const acao = (p, id) => card(p, id).locator('.ponto-acao-texto').innerText();
// Espera o salvamento terminar (PUT + releitura do resumo).
async function salvou(p, fazer) {
  await p.evaluate(() => {
    document.getElementById('msgPontos').textContent = '';
  });
  await fazer();
  await p.waitForFunction(() => /Pronto/.test(document.getElementById('msgPontos').textContent), null, {
    timeout: 8000,
  });
}
// Recorte da página inteira: o cabeçalho fixo não se repete no meio da foto,
// e as fotos com loading="lazy" já passaram pela tela.
async function foto(p, seletor, arquivo) {
  for (const c of await p.locator('#listaPontos .ponto-escolha').all()) await c.scrollIntoViewIfNeeded();
  await p.waitForFunction(() => [...document.querySelectorAll('#listaPontos img')].every((i) => i.complete));
  await p.evaluate(() => {
    window.scrollTo(0, 0);
    document.getElementById('listaPontos').scrollTop = 0;
  });
  const caixa = await p.locator(seletor).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + window.scrollX, y: r.top + window.scrollY, width: r.width, height: r.height };
  });
  await p.screenshot({ path: `${SAIDA}cards-pontos-${arquivo}.png`, fullPage: true, clip: caixa });
}
// Nada vaza do card, o selo de estado não cobre o nome, a caixa de seleção
// está inteira dentro do card.
async function semVazamento(p) {
  return p.$$eval('#listaPontos .ponto-escolha:not([hidden])', (cards) => {
    const problemas = [];
    const dentro = (r, c) => r.left >= c.left - 0.5 && r.right <= c.right + 0.5;
    const cruza = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    for (const cardEl of cards) {
      const c = cardEl.getBoundingClientRect();
      const nome = cardEl.querySelector('.ponto-nome');
      for (const el of cardEl.querySelectorAll(
        '.ponto-nome, .ponto-linha, .badge, .selo-seu-ponto, .ponto-proprio, .ponto-escolha-acao, .ponto-mapa, input',
      )) {
        if (!dentro(el.getBoundingClientRect(), c)) problemas.push(`${cardEl.dataset.pontoId}: ${el.className || el.tagName} vaza`);
      }
      for (const linha of cardEl.querySelectorAll('.ponto-linha, .ponto-escolha-acao')) {
        if (linha.scrollWidth > linha.clientWidth + 1) problemas.push(`${cardEl.dataset.pontoId}: texto cortado`);
      }
      const selo = cardEl.querySelector('.ponto-card-topo .badge');
      if (selo && cruza(selo.getBoundingClientRect(), nome.getBoundingClientRect()))
        problemas.push(`${cardEl.dataset.pontoId}: estado em cima do nome`);
      const caixa = cardEl.querySelector('input').getBoundingClientRect();
      if (caixa.width < 18 || caixa.height < 18) problemas.push(`${cardEl.dataset.pontoId}: caixa pequena`);
    }
    return problemas;
  });
}
const colunas = (p) =>
  p.$eval('#listaPontos', (el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean).length);
const semRolagemLateral = (p) =>
  p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

// ===========================================================================
console.log('== referência: Admin → Rede continua com os cards dela ==');
{
  const ctx = await navegador.newContext({ viewport: { width: 1366, height: 900 } });
  const a = await ctx.newPage();
  a.on('pageerror', (e) => erros.push(`[admin] pageerror: ${e.message}`));
  await a.goto(`${B}/admin/index.html`);
  await a.fill('#usuario', process.env.ADMIN_USER || 'admin');
  await a.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
  await a.click('button[type=submit]');
  await a.waitForSelector('#conteudo .visao-geral-colunas');
  await a.goto(`${B}/admin/index.html#rede/pontos`);
  await a.waitForSelector('.ponto-card-link', { timeout: 10000 });
  check('admin: um card por ponto da rede', (await a.$$('.ponto-card-link')).length >= 8);
  await a.waitForTimeout(500);
  await a.locator('.colecao').screenshot({ path: `${SAIDA}cards-pontos-admin-rede.png` });
  await ctx.close();
}

// ===========================================================================
console.log('== desktop: lista e anatomia do card ==');
const { p, ctx } = await entrar(1366, 900);
await p.evaluate(() => {
  window.__semReload = true;
});
check('um card por ponto da rede', (await p.$$('#listaPontos .ponto-escolha')).length === NA_REDE, `${NA_REDE}`);
check(
  'o próprio ponto encabeça a lista',
  (await p.$eval('#listaPontos .ponto-escolha', (el) => el.dataset.pontoId)) === String(P.proprio),
);
check('mesmo molde do admin (ponto-card com corpo)', await card(p, P.mercado).evaluate((el) => el.matches('.ponto-card.com-corpo')));
check('3 cards por fileira no desktop', (await colunas(p)) === 3, String(await colunas(p)));

const mercado = card(p, P.mercado);
check('foto da fachada vem da vitrine', (await mercado.locator('.ponto-card-media img').getAttribute('src')) === FOTO_MERCADO);
check('nome', (await mercado.locator('.ponto-nome').innerText()) === 'Mercado Central');
check('estado ao lado do nome', (await mercado.locator('.ponto-card-topo .badge').innerText()) === 'Ativo');
check(
  'endereço com bairro e cidade',
  (await mercado.locator('.ponto-end').innerText()) === 'Avenida Sete de Setembro, 1200 - Vila Santa Cruz, Matão',
  await mercado.locator('.ponto-end').innerText(),
);
check('segmento', (await mercado.locator('.ponto-segmento').innerText()) === 'Mercado / Supermercado');
check(
  'horário resumido',
  (await mercado.locator('.ponto-horario').innerText()) === 'Seg-sex 07:00-21:00 · Sáb 07:00-21:00 · Dom 08:00-13:00',
  await mercado.locator('.ponto-horario').innerText(),
);
check('ocupação', (await mercado.locator('.ponto-ocupacao').innerText()) === '20% vendido');
check('pé diz "Selecionar ponto"', (await acao(p, P.mercado)) === 'Selecionar ponto');
check(
  'nome acessível da caixa é o nome do ponto',
  (await p.getByRole('checkbox', { name: 'Mercado Central', exact: true }).count()) === 1,
);

const farmacia = card(p, P.farmacia);
check('sem foto: placeholder oficial, sem <img>', (await farmacia.locator('.ponto-foto-placeholder').count()) === 1 && (await farmacia.locator('img').count()) === 0);
check('sem foto: resto do card igual', (await farmacia.locator('.ponto-ocupacao').innerText()) === '45% vendido');

await p.waitForFunction(
  (id) => document.querySelector(`.ponto-escolha[data-ponto-id="${id}"] img`)?.complete,
  P.barbearia,
);
check(
  'foto em pé: formato canônico (cover, sem foto-contida)',
  await card(p, P.barbearia)
    .locator('img')
    .evaluate((img) => getComputedStyle(img).objectFit === 'cover' && !img.classList.contains('foto-contida')),
);
check('aguardando primeiro sinal', (await card(p, P.barbearia).locator('.badge').innerText()) === 'Aguardando primeiro sinal');
check('em instalação: sem hora vendida', (await card(p, P.academia).locator('.ponto-ocupacao').innerText()) === 'Ainda sem hora vendida');
check('em reparo', (await card(p, P.pet).locator('.badge').innerText()) === 'Em reparo');
const nomeLongo = card(p, P.pet).locator('.ponto-nome');
check('nome longo inteiro no title', (await nomeLongo.getAttribute('title')) === NOME_LONGO);
check('nome longo em no máximo 2 linhas', await nomeLongo.evaluate((el) => el.getBoundingClientRect().height <= parseFloat(getComputedStyle(el).lineHeight) * 2 + 1));

console.log('== o próprio ponto ==');
const proprio = card(p, P.proprio);
check('selo "Seu ponto" na foto', (await proprio.locator('.ponto-card-media .selo-seu-ponto').innerText()) === 'Seu ponto');
check('rótulo "Veicular no próprio ponto"', /Veicular no próprio ponto/.test(await proprio.innerText()));
check(
  'texto de que é opcional',
  (await proprio.innerText()).includes(
    'Este estabelecimento pertence à sua conta. Você pode incluí-lo na cobertura da campanha ou anunciar somente em outros pontos da rede.',
  ),
);
check('nunca vem marcado', !(await proprio.locator('input').isChecked()));
check('destaque próprio (classe seu-ponto)', await proprio.evaluate((el) => el.classList.contains('seu-ponto')));

console.log('== sem espaço e bloqueado: apagados, sem escolha nova ==');
const sorveteria = card(p, P.sorveteria);
check('sem espaço: caixa desligada', await sorveteria.locator('input').isDisabled());
check('sem espaço: "Sem espaço agora"', (await sorveteria.locator('.ponto-ocupacao').innerText()) === 'Sem espaço agora');
check('sem espaço: pé diz "Indisponível para escolha"', (await acao(p, P.sorveteria)) === 'Indisponível para escolha');
check('sem espaço: apagado', await sorveteria.evaluate((el) => Number(getComputedStyle(el.querySelector('.ponto-card-corpo')).opacity) < 1));
const otica = card(p, P.otica);
check('bloqueado: caixa desligada', await otica.locator('input').isDisabled());
check('bloqueado: "não aceita novas escolhas"', /85% vendido · não aceita novas escolhas/.test(await otica.locator('.ponto-ocupacao').innerText()));
check('desktop: sem rolagem lateral', await semRolagemLateral(p));
check('desktop: nada vaza dos cards', (await semVazamento(p)).length === 0, (await semVazamento(p)).join(' | '));
check('desktop: a lista rola por dentro', (await p.$eval('#listaPontos', (el) => getComputedStyle(el).overflowY)) === 'auto');
await foto(p, '#painelPontos', 'desktop');

console.log('== marcar e desmarcar ==');
check('contador "0 de 3"', (await p.textContent('#contadorPontos')) === '0 de 3 pontos selecionados');
// Teclado: da busca, Tab cai na caixa do primeiro card; Espaço marca.
await p.focus('#buscaPontos');
await p.keyboard.press('Tab');
check(
  'Tab da busca vai pra caixa do primeiro card',
  (await p.evaluate(() => document.activeElement?.closest('.ponto-escolha')?.dataset.pontoId)) === String(P.proprio),
);
await salvou(p, () => p.keyboard.press('Space'));
check('Espaço marca e salva', escolhidos() === String(P.proprio), escolhidos());
await salvou(p, () => p.keyboard.press('Space'));
check('Espaço de novo desmarca e salva', escolhidos() === '', escolhidos());

// Clique em qualquer parte do card marca (aqui, no nome).
await salvou(p, () => mercado.locator('.ponto-nome').click());
check('clicar no card marca', await mercado.locator('input').isChecked());
check('salvou no banco', escolhidos() === String(P.mercado), escolhidos());
check('contador "1 de 3"', (await p.textContent('#contadorPontos')) === '1 de 3 pontos selecionados');
check('modo: você escolheu', /escolheu os pontos/.test(await p.textContent('#modoPontos')));
check('pé diz "Selecionado"', (await acao(p, P.mercado)) === 'Selecionado');
const estilo = await mercado.evaluate((el) => ({ borda: getComputedStyle(el).borderTopColor, sombra: getComputedStyle(el).boxShadow }));
check('selecionado: borda da marca com anel', estilo.borda === BRAND && estilo.sombra.includes(BRAND), JSON.stringify(estilo));
check(
  'não selecionado: borda neutra',
  (await farmacia.evaluate((el) => getComputedStyle(el).borderTopColor)) !== BRAND,
);

// O mapa abre em outra aba e NÃO mexe na escolha.
const [aba] = await Promise.all([ctx.waitForEvent('page'), mercado.locator('.ponto-mapa').click()]);
await aba.waitForLoadState();
check('mapa abre em outra aba', /google\.com\/maps/.test(aba.url()), aba.url());
await aba.close();
check('clicar no mapa não desmarca', await mercado.locator('input').isChecked());
check('nada foi salvo pelo clique no mapa', escolhidos() === String(P.mercado));

// Até o limite do plano: pela foto de um, pelo texto do pé do outro.
await salvou(p, () => farmacia.locator('.ponto-card-media').click());
await salvou(p, () => proprio.locator('.ponto-acao-texto').click());
check('três marcados, salvos', escolhidos() === ids(P.proprio, P.mercado, P.farmacia), escolhidos());
check('contador "3 de 3"', (await p.textContent('#contadorPontos')) === '3 de 3 pontos selecionados');
check('no limite: os outros travam', await card(p, P.pet).locator('input').isDisabled());
check('no limite: pé diz "Limite do plano atingido"', (await acao(p, P.pet)) === 'Limite do plano atingido');
check('no limite: o sem espaço segue "Indisponível para escolha"', (await acao(p, P.sorveteria)) === 'Indisponível para escolha');
check('o próprio ponto marcado conta no limite', (await acao(p, P.proprio)) === 'Selecionado');
await foto(p, '#painelPontos', 'desktop-selecionados');

await salvou(p, () => mercado.locator('input').click());
check('desmarcar solta o limite', !(await card(p, P.pet).locator('input').isDisabled()));
check('pé volta a "Selecionar ponto"', (await acao(p, P.pet)) === 'Selecionar ponto');
check('desmarcado saiu do banco', escolhidos() === ids(P.proprio, P.farmacia), escolhidos());

// PR #90 (integrado em 29/09/2026): um PUT por vez; recusa volta ao salvo.
console.log('== um PUT por vez; recusa volta ao salvo ==');
let emVoo = 0;
let maxEmVoo = 0;
let puts = 0;
const ehPut = (r) => r.method() === 'PUT' && r.url().endsWith('/anunciantes/me/pontos');
p.on('request', (r) => {
  if (!ehPut(r)) return;
  puts += 1;
  emVoo += 1;
  maxEmVoo = Math.max(maxEmVoo, emVoo);
});
p.on('requestfinished', (r) => {
  if (ehPut(r)) emVoo -= 1;
});
p.on('requestfailed', (r) => {
  if (ehPut(r)) emVoo -= 1;
});
// Dois cliques seguidos no mesmo card (marca e desmarca), sem esperar o
// primeiro salvar: a escolha final é a do segundo.
await mercado.locator('input').click();
await mercado.locator('input').click();
for (let i = 0; i < 40 && (emVoo > 0 || !/Pronto/.test(await p.textContent('#msgPontos'))); i++) await p.waitForTimeout(200);
await p.waitForTimeout(300);
check('nunca dois PUTs em paralelo', maxEmVoo === 1, `máximo em voo: ${maxEmVoo}`);
check('no máximo um PUT por clique', puts <= 2, String(puts));
check('o último clique vence no banco', escolhidos() === ids(P.proprio, P.farmacia), escolhidos());
recusaSimulada = true;
await p.route('**/anunciantes/me/pontos', (rota) =>
  rota.request().method() === 'PUT'
    ? rota.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ erro: 'falhou de propósito' }) })
    : rota.continue(),
);
await card(p, P.pet).locator('input').click();
await p.waitForFunction(() => document.getElementById('msgPontos').classList.contains('err'), null, { timeout: 8000 });
check(
  'recusa: mensagem com o motivo e a volta',
  /falhou de propósito/i.test(await p.textContent('#msgPontos')) && /voltou/.test(await p.textContent('#msgPontos')),
  await p.textContent('#msgPontos'),
);
check('recusa: a caixa voltou a desmarcada', !(await card(p, P.pet).locator('input').isChecked()));
check('recusa: as salvas seguem marcadas', (await proprio.locator('input').isChecked()) && (await farmacia.locator('input').isChecked()));
check('recusa: contador volta a "2 de 3"', (await p.textContent('#contadorPontos')) === '2 de 3 pontos selecionados');
check('recusa: nada mudou no banco', escolhidos() === ids(P.proprio, P.farmacia), escolhidos());
await p.unroute('**/anunciantes/me/pontos');
recusaSimulada = false;

console.log('== busca ==');
await p.fill('#buscaPontos', 'farm');
check(
  'busca filtra os cards',
  (await p.$$eval('#listaPontos .ponto-escolha', (els) => els.filter((e) => !e.hidden).map((e) => e.dataset.pontoId))).join(',') ===
    String(P.farmacia),
);
check('card filtrado some de verdade', await card(p, P.mercado).isHidden());
await p.fill('#buscaPontos', '');
check('limpar a busca volta todos', (await p.$$('#listaPontos .ponto-escolha:not([hidden])')).length === NA_REDE);

await salvou(p, () => farmacia.locator('input').click());
await salvou(p, () => proprio.locator('input').click());
check('tudo desmarcado: distribuição automática', escolhidos() === '' && /automática ativa/.test(await p.textContent('#modoPontos')));
check('sem F5 no caminho todo', await p.evaluate(() => window.__semReload === true));
await ctx.close();

// ===========================================================================
for (const [nome, largura, altura, esperadas] of [
  ['tablet', 820, 1100, 3],
  ['celular', 390, 844, 1],
]) {
  console.log(`== ${nome} (${largura}px) ==`);
  const t = await entrar(largura, altura);
  check(`${nome}: sem rolagem lateral`, await semRolagemLateral(t.p));
  check(`${nome}: ${esperadas} por fileira`, (await colunas(t.p)) === esperadas, String(await colunas(t.p)));
  const vazou = await semVazamento(t.p);
  check(`${nome}: nada vaza dos cards`, vazou.length === 0, vazou.join(' | '));
  if (nome === 'celular') {
    check('celular: a página rola, não a lista', (await t.p.$eval('#listaPontos', (el) => getComputedStyle(el).overflowY)) === 'visible');
    const media = await card(t.p, P.mercado).locator('.ponto-card-media').boundingBox();
    check('celular: foto no formato canônico (16:9)', Math.abs(media.width / media.height - 16 / 9) < 0.05, JSON.stringify(media));
    await salvou(t.p, () => card(t.p, P.mercado).locator('.ponto-nome').click());
    check('celular: tocar no card marca e salva', escolhidos() === String(P.mercado));
    await salvou(t.p, () => card(t.p, P.mercado).locator('input').click());
    check('celular: desmarca', escolhidos() === '');
    await t.p.locator('#buscaPontos').evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await t.p.evaluate(() => window.scrollBy(0, -70));
    await t.p.waitForTimeout(300);
    await t.p.screenshot({ path: `${SAIDA}cards-pontos-celular-tela.png` });
  }
  await foto(t.p, '#painelPontos', nome);
  await t.ctx.close();
}

// ===========================================================================
console.log('== vitrine fora do ar: a escolha continua ==');
{
  const t = await entrar(1366, 900, { vitrine: 'trava' });
  check('vitrine que não responde: a lista aparece mesmo assim', (await t.p.$$('#listaPontos .ponto-escolha')).length === NA_REDE);
  check('vitrine que não responde: placeholder no lugar da foto', (await t.p.$$('#listaPontos img')).length === 0);
  await t.ctx.close();
  const s = await entrar(1366, 900, { vitrine: 'falha' });
  check('cards desenhados mesmo assim', (await s.p.$$('#listaPontos .ponto-escolha')).length === NA_REDE);
  check('sem vitrine: placeholder, sem foto nem segmento', (await s.p.$$('#listaPontos img')).length === 0 && (await s.p.$$('#listaPontos .ponto-segmento')).length === 0);
  await salvou(s.p, () => card(s.p, P.mercado).locator('input').click());
  check('sem vitrine: marcar salva igual', escolhidos() === String(P.mercado));
  await salvou(s.p, () => card(s.p, P.mercado).locator('input').click());
  check('sem vitrine: desmarcar salva igual', escolhidos() === '');
  await s.ctx.close();
}

await navegador.close();
check('sem erro de console (inclui CSP)', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
