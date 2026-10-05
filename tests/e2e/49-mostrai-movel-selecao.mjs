// MOSTRAÍ MÓVEL como opção de seleção (migration 115, 05/10/2026), curto e de
// ponta a ponta no navegador:
//   1. conta com direito ativo (Essencial, 3 posições) abre "Onde seu anúncio
//      aparece" com 0 unidades móveis alocadas: a opção Mostraí Móvel está
//      lá, marcável, com "Nenhuma tela móvel em operação agora";
//   2. marca → o contador vai de 0 para "1 de 3"; salva; recarrega → a
//      escolha continua (gravada como opção, nunca como unidade);
//   3. o Admin cria um móvel e põe num evento em andamento (24 h): a TV da
//      unidade recebe a campanha da conta, sem a conta editar nada, e o card
//      passa a dizer "1 tela móvel em operação agora".
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/49-mostrai-movel-selecao.mjs
import { execSync } from 'node:child_process';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto, recarregarQuieto, redeQuieta } from './espera.mjs';

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

// "2026-10-05T14:30" no relógio de Matão — o formato do datetime-local.
const parede = (deslocamentoMs) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(new Date(Date.now() + deslocamentoMs))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const HORA = 3600 * 1000;

async function pagina(largura, altura, rotulo) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  await ctx.route(/google\.com\/maps/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'mapa' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error' || /net::|ERR_FAILED|status of 401/.test(m.text())) return;
    erros.push(`[${rotulo}] console: ${m.text()}`);
  });
  return p;
}

// Conta com plano vigente (Essencial: 3 posições) e peça aprovada.
const email = `movel-sel-${marca}@teste.com`;
const r = await fetch(`${B}/anunciantes/cadastro`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    nome_empresa: 'Ótica Visão Clara',
    cpf_cnpj: '52998224725',
    contato_email: email,
    contato_telefone: '16999993333',
    senha: SENHA,
    aceitou_termos: true,
    endereco: 'Rua Nove, 90',
    cidade: 'Matão',
    uf: 'SP',
    cep: '15990000',
  }),
});
if (!r.ok) throw new Error(`cadastro: ${r.status} ${await r.text()}`);
const CONTA = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
PG(
  `UPDATE anunciantes SET email_confirmado = true, plano_id = 'essencial-1m', data_inicio_cobertura = now(),
          data_expiracao = now() + interval '20 days' WHERE id = ${CONTA}`,
);
const IMAGEM = `${B}/img/exemplo-ponto-completo-720.jpg`;
PG(
  `INSERT INTO criativos (anunciante_id, arquivo_original_url, arquivo_normalizado_url, thumbnail_url, duracao_segundos, status, aprovado_em)
   VALUES (${CONTA}, '${IMAGEM}', '${IMAGEM}', '${IMAGEM}', 10, 'aprovado', date_trunc('hour', now()) - interval '5 minutes')`,
);

async function entrarConta(largura, altura) {
  const p = await pagina(largura, altura, `conta ${largura}px`);
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', email);
  await p.fill('#senha', SENHA);
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await redeQuieta(p);
  await p.waitForSelector('[data-mostrai-movel]', { timeout: 10000 });
  return p;
}
const contador = (p) => p.locator('#contadorPontos').innerText();
const card = (p) => p.locator('[data-mostrai-movel]');

// ===========================================================================
console.log('== 1 e 2: a opção existe com 0 unidades; marcar, salvar, recarregar ==');
check('(preparo) nenhum móvel alocado', PG(`SELECT COUNT(*) FROM pontos WHERE tipo = 'movel'`) === '0');
const p = await entrarConta(1280, 1000);
let texto = await card(p).innerText();
check('card "Mostraí Móvel" · "Itinerante"', /Mostraí Móvel/.test(texto) && /Itinerante/i.test(texto), texto);
check('"Eventos e locais temporários"', /Eventos e locais temporários/.test(texto), texto);
check('0 unidades: "Nenhuma tela móvel em operação agora."', /Nenhuma tela móvel em operação agora\./.test(texto), texto);
check('sem "Sem alocação", endereço ou equipamento', !/Sem alocação|equipamento|#\d\d/.test(texto), texto);
check('marcável com 0 unidades', !(await card(p).locator('input').isDisabled()));
check('contador antes: "0 de 3"', /^0 de 3/.test(await contador(p)), await contador(p));
await card(p).scrollIntoViewIfNeeded();
await card(p).screenshot({ path: `${SAIDA}49-mostrai-movel-zero.png` });

await card(p).locator('input').check();
check('contador: "1 de 3 pontos selecionados"', /^1 de 3 pontos selecionados/.test(await contador(p)), await contador(p));
await p.waitForFunction(() => /Pronto/.test(document.getElementById('msgPontos')?.textContent || ''), null, {
  timeout: 8000,
});
check(
  'gravada como opção (nunca unidade)',
  PG(`SELECT mostrai_movel_escolhido_em IS NOT NULL FROM anunciantes WHERE id = ${CONTA}`) === 't' &&
    PG(`SELECT COUNT(*) FROM anunciantes_pontos WHERE anunciante_id = ${CONTA}`) === '0',
);
await recarregarQuieto(p);
await p.waitForSelector('[data-mostrai-movel]', { timeout: 10000 });
check('recarregou: continua marcada', await card(p).locator('input').isChecked());
check('recarregou: "1 de 3"', /^1 de 3/.test(await contador(p)), await contador(p));
const modo = await p.locator('#modoPontos').innerText();
check('com 0 unidades a campanha segue pela rede (texto do "no ar" é a realidade)', /Você escolheu/.test(modo), modo);
await p.locator('#painelPontos').screenshot({ path: `${SAIDA}49-selecao-com-mostrai-movel.png` });

// Celular: o card cabe, sem rolagem lateral.
const pM = await entrarConta(390, 844);
await card(pM).scrollIntoViewIfNeeded();
const medidas = await card(pM).evaluate((el) => {
  const r = el.getBoundingClientRect();
  return { cabe: r.left >= 0 && r.right <= window.innerWidth + 1, rolagem: document.documentElement.scrollWidth > window.innerWidth + 1 };
});
check('celular: card dentro da tela, sem rolagem lateral', medidas.cabe && !medidas.rolagem, JSON.stringify(medidas));
await card(pM).screenshot({ path: `${SAIDA}49-mostrai-movel-celular.png` });

// ===========================================================================
console.log('== 3: uma unidade entra em operação e entra na entrega ==');
const admin = await pagina(1400, 960, 'admin');
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
const apiAdmin = (caminho, metodo = 'GET', corpo) =>
  admin.evaluate(
    async ({ caminho, metodo, corpo }) => {
      const resp = await fetch(caminho, {
        method: metodo,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      return { status: resp.status, json: await resp.json().catch(() => null) };
    },
    { caminho, metodo, corpo },
  );
const criado = await apiAdmin('/admin/pontos-moveis', 'POST', { observacoes: 'Kit 1' });
check('(preparo) móvel criado com a Tela 1', criado.status === 201 && criado.json.telaId, JSON.stringify(criado.json));
const PONTO = criado.json.id;
await apiAdmin('/admin/player/pin-saida', 'PUT', { pin: '482715' });
const g = await apiAdmin(`/admin/dispositivos/${criado.json.telaId}/codigo-instalacao`, 'POST');
const prov = await (
  await fetch(`${B}/player/provisionar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' },
    body: JSON.stringify({ codigoTela: g.json.codigoTela, codigoInstalacao: g.json.codigo }),
  })
).json();
const playlist = async () =>
  (
    await fetch(`${B}/playlist/${prov.dispositivoId}`, {
      headers: { 'X-Player-Version': '1.2.0+12', 'X-Aparelho-Key': prov.chaveAparelho },
    })
  ).json();
const daConta = (pl) => (pl?.itens || []).some((i) => String(i.anuncianteId) === CONTA);
check('sem alocação: a TV da unidade não leva a campanha', !daConta(await playlist()));

const ev = await apiAdmin(`/admin/pontos/${PONTO}/eventos`, 'POST', {
  nome: 'Feira de Outubro',
  organizacao: 'Prefeitura',
  local: 'Praça da Matriz',
  inicio: parede(-HORA),
  fim: parede(24 * HORA),
  horario_operacao: '24h',
});
check('(preparo) evento cadastrado', ev.status === 201, JSON.stringify(ev.json));
const ini = await apiAdmin(`/admin/pontos/${PONTO}/eventos/${ev.json.id}/iniciar`, 'POST');
check('(preparo) evento em andamento', ini.status === 200, JSON.stringify(ini.json));
const pl = await playlist();
check('alocada e no horário: a TV da unidade leva a campanha, sem a conta editar nada', daConta(pl), JSON.stringify(pl?.itens?.slice(0, 3)));
check('a escolha da conta não mudou', PG(`SELECT COUNT(*) FROM anunciantes_pontos WHERE anunciante_id = ${CONTA}`) === '0');

await recarregarQuieto(p);
await p.waitForSelector('[data-mostrai-movel]', { timeout: 10000 });
texto = await card(p).innerText();
check('card: "1 tela móvel em operação agora."', /1 tela móvel em operação agora\./.test(texto), texto);
check('card: sem local, evento ou equipamento', !/Praça|Feira|Kit|#\d\d/.test(texto), texto);
check('contador continua "1 de 3"', /^1 de 3/.test(await contador(p)), await contador(p));
await card(p).screenshot({ path: `${SAIDA}49-mostrai-movel-ativa.png` });

check('sem erro de console/página', erros.length === 0, erros.join(' | '));
await navegador.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
