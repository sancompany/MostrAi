// REDE / ADMIN V2 sobre a REDE MÓVEL DA CIDADE (migrations 115 e 116). O
// roteiro principal da estação, no navegador, de ponta a ponta:
//   A. Admin — Rede tem só [Pontos] [Candidaturas]; #rede/moveis abre Pontos
//     com o filtro Móveis; fixos e móveis no MESMO grid; o filtro Móveis
//     mostra a barra (+ Nova rede móvel, Agenda móvel); cria a rede com Nome,
//     Cidade e UF separados e a foto ENQUADRADA (16:9); duas telas (um único
//     "Adicionar tela" na ficha); pelo "+ Novo compromisso" (Rede Front V3,
//     06/10/2026 — um formulário só): em outro local com a tela A, na conta
//     com a B (termo físico, entrega); a mesma tela nunca pega dois
//     compromissos; a Agenda móvel abre sob demanda (agora + próximos,
//     histórico à parte); Candidaturas → Interesses em hospedar com o
//     benefício numa linha e o "Agendar compromisso" pré-preenchido;
//     "Alterar foto" de um ponto fixo (no "⋯" do cabeçalho).
//   B. Conta — "+ Criar ponto" na ficha da conta: formulário pré-preenchido,
//     salva um ponto FIXO da conta (origem admin), sem candidatura.
//   C. Anunciante — o card do Mostraí Móvel: foto real (nunca a faixa azul),
//     MÓVEL, cidade, "Local atual" / "Próxima localização", sem dado técnico;
//     com 0 tela em operação, 0 evento e 0 alocação a caixa está HABILITADA
//     (nunca "Indisponível para escolha") e a escolha conta 1 posição;
//     "Ver agenda" mostra só presente e futuro; 390px sem rolagem lateral.
//   D. Site público "Onde estamos" — UM card da rede (selo MÓVEL, foto da rede),
//     "Ver no mapa" só nos locais reais de agora; sem alocação, "Sem
//     localização no momento" e nenhum mapa; o card fixo continua.
// Banco zerado, servidor na 3999 (o roteiro o reinicia com STORAGE_CAPTURA)
// e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/50-rede-movel.mjs
import { execSync } from 'node:child_process';
import path from 'node:path';
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
const shot = (alvo, nome, opcoes = {}) => alvo.screenshot({ path: `${SAIDA}rede-movel-${nome}.png`, ...opcoes });
const RAIZ = new URL('../../', import.meta.url).pathname;
// Fotos enviadas vão para esta pasta (STORAGE_CAPTURA) e o navegador as
// busca daqui — o caminho real inteiro (enquadrar, enviar, validar, gravar).
const STORAGE = `${SAIDA}storage-rede/`;
execSync(`bash ${RAIZ}tests/e2e/restart.sh STORAGE_CAPTURA=${STORAGE}`);
// Foto EM PÉ (720 de largura) — o caso que virava "foto minúscula no meio".
const FOTO_EM_PE = `${RAIZ}public/img/exemplo-ponto-completo-720.jpg`;

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const marca = Date.now();
const SENHA = 'Senha123!';
const CIDADE = 'Matão';

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
const DIA = 24 * HORA;

async function cadastrar(nome, cpf, email) {
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: cpf,
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
  if (!r.ok) throw new Error(`cadastro ${email}: ${r.status} ${await r.text()}`);
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return id;
}

async function pagina(largura, altura, rotulo, permitir = /status of 401/) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  await ctx.route(/google\.com\/maps/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: 'mapa' }));
  await ctx.route('**/e2e-storage/**', (rota) =>
    rota.fulfill({ path: path.join(STORAGE, path.basename(new URL(rota.request().url()).pathname)) }),
  );
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() !== 'error' || /net::|ERR_FAILED/.test(m.text()) || permitir.test(m.text())) return;
    erros.push(`[${rotulo}] console: ${m.text()}`);
  });
  return p;
}

const semRolagemLateral = (p) => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// ---------------------------------------------------------------------------
// Contas
// ---------------------------------------------------------------------------
const emailAnf = `padaria-${marca}@teste.com`;
const ANF = await cadastrar('Padaria Central', '52998224725', emailAnf);
// Endereço completo na conta: sem ponto fixo, o compromisso "na conta" usa
// o endereço dela (origem padrão do formulário).
PG(
  `UPDATE anunciantes SET logradouro = 'Rua Nove', numero = '90', bairro = 'Centro', cep = '15990-000', cidade = 'Matão', uf = 'SP' WHERE id = ${ANF}`,
);
const emailAnun = `loja-${marca}@teste.com`;
const ANUN = await cadastrar('Loja do Anunciante', '11144477735', emailAnun);
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ANUN}`,
);
const LIMITE = PG(`SELECT pontos_incluidos FROM planos WHERE id = 'essencial-1m'`);
const emailCom = `mercado-${marca}@teste.com`;
const COM = await cadastrar('Mercado Bom Preço', '39053344705', emailCom);
PG(
  `UPDATE anunciantes SET logradouro = 'Rua das Flores', numero = '120', bairro = 'Centro', cep = '15990-000', cidade = 'Matão', uf = 'SP', responsavel_nome = 'Ana Souza', responsavel_telefone = '16988887777' WHERE id = ${COM}`,
);

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
// 400/404/409/410: provocados de propósito abaixo (rede sem nome, rota antiga
// da central, cidade repetida, ponto repetido, termo eletrônico).
const admin = await pagina(1400, 960, 'admin', /status of (400|401|404|409|410)/);
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
const apiAdmin = (caminho, metodo = 'GET', corpo) =>
  admin.evaluate(
    async ({ caminho, metodo, corpo }) => {
      const r = await fetch(caminho, {
        method: metodo,
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: corpo ? JSON.stringify(corpo) : undefined,
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    { caminho, metodo, corpo },
  );
const irAdmin = async (hash, seletor) => {
  await admin.evaluate((h) => {
    location.hash = h;
  }, hash);
  await admin.waitForSelector(seletor, { timeout: 10000 });
  await redeQuieta(admin);
};
const modal = () => admin.locator('dialog[open]').last();
// Escolhe a foto em pé e confirma o enquadramento (arrasta um pouco antes).
async function enquadrar() {
  await admin.waitForSelector('dialog[open] [data-recorte]', { timeout: 10000 });
  const tela = modal().locator('[data-recorte]');
  check('enquadrar: moldura 16:9', await tela.evaluate((c) => Math.abs(c.clientWidth / c.clientHeight - 16 / 9) < 0.02));
  const caixa = await tela.boundingBox();
  await admin.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2);
  await admin.mouse.down();
  await admin.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2 - 40, { steps: 4 });
  await admin.mouse.up();
  await modal().locator('[data-zoom]').fill('1.3');
  await shot(modal(), 'enquadrar-foto');
  await modal().locator('[data-usar-foto]').click();
  await admin.waitForFunction(() => !document.querySelector('dialog[open] [data-recorte]'), null, { timeout: 10000 });
}
// O arquivo enviado: JPEG 1280×720 (o recorte, não a foto original).
const dimensoesDoArquivo = (arquivo) =>
  execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${arquivo}"`)
    .toString()
    .trim();

console.log('== B. Conta: + Criar ponto ==');
await irAdmin(`#contas/contas/${COM}`, '[data-criar-ponto]');
await admin.click('[data-criar-ponto]');
await modal().waitFor();
check('criar ponto: nome pré-preenchido', (await admin.inputValue('#cpNome')) === 'Mercado Bom Preço');
check('criar ponto: responsável pré-preenchido', (await admin.inputValue('#cpResp')) === 'Ana Souza');
check('criar ponto: telefone pré-preenchido', (await admin.inputValue('#cpTel')) === '16988887777');
check('criar ponto: logradouro pré-preenchido', (await admin.inputValue('#cp_logradouro')) === 'Rua das Flores');
check('criar ponto: número pré-preenchido', (await admin.inputValue('#cp_numero')) === '120');
check('criar ponto: cidade/UF pré-preenchidas', (await admin.inputValue('#cp_cidade')) === 'Matão' && (await admin.inputValue('#cp_uf')) === 'SP');
check('criar ponto: CEP pré-preenchido', (await admin.inputValue('#cp_cep')) === '15990-000');
await shot(modal(), 'modal-criar-ponto');
await modal().locator('button[type=submit]').click();
await admin.waitForURL(/rede\/pontos\/\d+/, { timeout: 10000 });
// Rede Front V3: "Alterar foto" mora no "⋯" do cabeçalho da ficha.
await admin.waitForSelector('#pontoCabecalho [data-alterar-foto]', { state: 'attached', timeout: 10000 });
await redeQuieta(admin);
const FIXO = PG(`SELECT id FROM pontos WHERE anunciante_id = ${COM}`);
check(
  'criar ponto: fixo da conta, aguardando instalação, origem admin, sem candidatura',
  PG(`SELECT tipo || '|' || status || '|' || origem || '|' || (candidatura_id IS NULL) FROM pontos WHERE id = ${FIXO}`) ===
    'fixo|a_instalar|admin|true',
);
check('criar ponto: nenhuma candidatura nasceu', PG(`SELECT COUNT(*) FROM candidaturas WHERE conta_id = ${COM}`) === '0');
check('criar ponto: conta virou dona de ponto', PG(`SELECT 'ponto' = ANY(papeis) FROM anunciantes WHERE id = ${COM}`) === 't');
const repetido = await apiAdmin(`/admin/anunciantes/${COM}/pontos`, 'POST', {
  nome: 'Mercado Bom Preço',
  responsavel_nome: 'Ana',
  responsavel_contato: '16988887777',
  cep: '15990-000',
  logradouro: 'Rua das Flores',
  numero: '120',
  bairro: 'Centro',
  cidade: 'Matão',
  uf: 'SP',
});
check('criar ponto repetido: 409 com o motivo', repetido.status === 409 && /já é um ponto/.test(repetido.json?.erro), JSON.stringify(repetido.json));

console.log('== A. Admin: Alterar foto de um ponto FIXO ==');
await admin.click('#pontoCabecalho .menu-mais > summary');
const [seletorFixo] = await Promise.all([
  admin.waitForEvent('filechooser'),
  admin.click('#pontoCabecalho [data-alterar-foto]'),
]);
await seletorFixo.setFiles(FOTO_EM_PE);
await enquadrar();
await admin.waitForFunction(() => !!document.querySelector('#pontoCabecalho .ficha-foto img'), null, { timeout: 10000 });
check('foto do fixo gravada (/e2e-storage, ?v=)', /^\/e2e-storage\/ponto-\d+\.jpg\?v=\d+$/.test(PG(`SELECT foto_instalacao_url FROM pontos WHERE id = ${FIXO}`)));
check('foto do fixo: 1280×720', dimensoesDoArquivo(`${STORAGE}ponto-${FIXO}.jpg`) === '1280,720');

console.log('== A. Admin: Rede só com Pontos e Candidaturas ==');
await irAdmin('#rede/pontos', '.colecao');
const abas = await admin.locator('.modulo-aba').allInnerTexts();
check('Rede: abas Pontos e Candidaturas', JSON.stringify(abas.map((a) => a.replace(/\s*\d+$/, '').trim())) === JSON.stringify(['Pontos', 'Candidaturas']), JSON.stringify(abas));
const chips = await admin.locator('.colecao .chip').allInnerTexts();
for (const c of ['Todos', 'Fixos', 'Móveis', 'Com problema', 'Sem comunicação', 'Aguardando instalação', 'Aguardando primeiro sinal', 'Ativos', 'Em reparo', 'Inativos']) {
  check(`filtro "${c}"`, chips.includes(c), JSON.stringify(chips));
}
check('barra Móveis escondida em "Todos"', !(await admin.locator('[data-barra-moveis]').isVisible()));

console.log('== A. Admin: #rede/moveis → Pontos com o filtro Móveis ==');
await irAdmin('#rede/moveis', '[data-barra-moveis]');
check('hash antigo vira #rede/pontos', (await admin.evaluate(() => location.hash)) === '#rede/pontos');
check('filtro Móveis ativo', (await admin.locator('.colecao .chip.active').innerText()) === 'Móveis');
check('barra Móveis visível', await admin.locator('[data-barra-moveis]').isVisible());

console.log('== A. Admin: cria a rede (nome, cidade, UF separados; foto enquadrada) ==');
await admin.click('[data-barra-moveis] [data-criar-movel]');
await modal().waitFor();
const textoModal = await modal().innerText();
check('modal: Nome, Cidade e UF', /Nome/.test(textoModal) && /Cidade/.test(textoModal) && /UF/.test(textoModal));
check('modal: sem nome composto automático', !/Mostraí Móvel —/.test(textoModal));
await admin.fill('#cmNome', 'Mostraí Móvel');
await admin.fill('#cmCidade', CIDADE);
await admin.selectOption('#cmUf', 'SP');
const [seletorRede] = await Promise.all([admin.waitForEvent('filechooser'), admin.click('label[for="cmFoto"]')]);
await seletorRede.setFiles(FOTO_EM_PE);
await enquadrar();
await admin.waitForFunction(() => /enquadrada/.test(document.querySelector('dialog[open] [data-foto-nome]')?.textContent || ''), null, {
  timeout: 8000,
});
check('modal: foto enquadrada', true);
await shot(modal(), 'modal-nova-rede');
await modal().locator('button[type=submit]').click();
await admin.waitForSelector('[data-resumo-rede]', { timeout: 10000 });
await redeQuieta(admin);
const REDE = PG(`SELECT id FROM pontos WHERE tipo = 'movel' AND cidade = '${CIDADE}' AND uf = 'SP'`);
check('rede: nome sem a cidade', PG(`SELECT nome FROM pontos WHERE id = ${REDE}`) === 'Mostraí Móvel');
check('rede criada sem tela', PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${REDE}`) === '0');
check('rede: foto gravada', /^\/e2e-storage\/ponto-\d+\.jpg\?v=\d+$/.test(PG(`SELECT foto_instalacao_url FROM pontos WHERE id = ${REDE}`)));
check('rede: foto 1280×720', dimensoesDoArquivo(`${STORAGE}ponto-${REDE}.jpg`) === '1280,720');
const cabecalho = await admin.locator('[data-rede-cabecalho]').innerText();
check('cabeçalho: "Mostraí Móvel" e "Matão/SP" separados', /MOSTRAÍ MÓVEL/i.test(cabecalho) && cabecalho.includes('Matão/SP') && !/Móvel — Matão/i.test(cabecalho), cabecalho.slice(0, 120));
const selosRede = await admin.locator('[data-rede-cabecalho] .ponto-cabecalho-selos').innerText();
check('cabeçalho: MÓVEL e Ativa (sem ITINERANTE)', /MÓVEL/i.test(selosRede) && /Ativa/i.test(selosRede) && !/Itinerante/i.test(cabecalho), selosRede);
check('cabeçalho: 0 telas · 0 operando · 0 compromissos futuros', /0 telas · 0 operando · 0 compromissos futuros/.test(cabecalho), cabecalho);
check('ficha: um único "Adicionar tela"', (await admin.locator('[data-nova-tela]').count()) === 1);
const dup = await apiAdmin('/admin/pontos-moveis', 'POST', { nome: 'Outra', cidade: 'matão', uf: 'SP' });
check('mesma cidade + UF de novo: 409', dup.status === 409, JSON.stringify(dup.json));
const semNome = await apiAdmin('/admin/pontos-moveis', 'POST', { cidade: 'Araraquara', uf: 'SP' });
check('rede sem nome: 400', semNome.status === 400 && semNome.json?.campo === 'nome', JSON.stringify(semNome.json));

console.log('== A. Admin: o grid com fixo e móvel ==');
await irAdmin('#rede/pontos', '.colecao');
const cardAdmin = admin.locator(`.ponto-card[href="#rede/pontos/${REDE}"]`);
const textoCardAdmin = await cardAdmin.innerText();
check(
  'card admin: MÓVEL · Ativa · Matão/SP',
  /MÓVEL/.test(await cardAdmin.locator('.selo-movel').innerText()) && !/Itinerante/i.test(textoCardAdmin) && /Ativa/.test(textoCardAdmin) && textoCardAdmin.includes('Matão/SP'),
  textoCardAdmin,
);
check('card admin: Local atual / Próximo', /Local atual/i.test(textoCardAdmin) && /Próximo/i.test(textoCardAdmin), textoCardAdmin);
check('card admin: [Abrir]', /Abrir/.test(textoCardAdmin));
check('card admin: foto real', await cardAdmin.locator('.ponto-card-media img').evaluate((i) => i.complete && i.naturalWidth === 1280));
const larguras = await admin.locator('.colecao .ponto-card:not([hidden])').evaluateAll((cs) => cs.map((c) => Math.round(c.getBoundingClientRect().width)));
check('card móvel e fixo com a mesma largura', new Set(larguras).size === 1, JSON.stringify(larguras));
const proporcoes = await admin.locator('.colecao .ponto-card-media').evaluateAll((ms) => ms.map((m) => m.clientWidth / m.clientHeight));
check('molduras 16:9', proporcoes.every((r) => Math.abs(r - 16 / 9) < 0.03), JSON.stringify(proporcoes));
await admin.locator('.colecao .chip', { hasText: 'Fixos' }).click();
check('filtro Fixos: só o fixo', (await admin.locator('.colecao .ponto-card:not([hidden])').count()) === 1 && !(await cardAdmin.isVisible()));
await admin.locator('.colecao .chip', { hasText: 'Móveis' }).click();
check('filtro Móveis: só a rede', (await admin.locator('.colecao .ponto-card:not([hidden])').count()) === 1 && (await cardAdmin.isVisible()));
await shot(admin.locator('#conteudo'), 'grid-moveis', { animations: 'disabled' });

console.log('== A. Admin: duas telas ==');
await irAdmin(`#rede/pontos/${REDE}`, '[data-rede-cabecalho] [data-nova-tela]');
await admin.click('[data-rede-cabecalho] [data-nova-tela]');
await admin.waitForURL(/telas\/\d+/, { timeout: 10000 });
await admin.waitForSelector('.tela-ficha');
await redeQuieta(admin);
const fichaTela = await admin.locator('.tela-ficha').innerText();
check('ficha da tela: "Instalada em"', /Instalada em/.test(fichaTela));
check('ficha da tela: sem custo/amortização', !/Custo|amortiza|R\$/i.test(fichaTela), fichaTela);
const TELA_A = PG(`SELECT min(id) FROM dispositivos WHERE ponto_id = ${REDE}`);
await irAdmin(`#rede/pontos/${REDE}`, '#pontoTelas');
await admin.click('[data-rede-cabecalho] [data-nova-tela]');
await admin.waitForURL(/telas\/\d+/, { timeout: 10000 });
const TELA_B = PG(`SELECT max(id) FROM dispositivos WHERE ponto_id = ${REDE}`);
check('duas telas na rede', PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${REDE}`) === '2');
const CODIGO_A = `M-${String(TELA_A).padStart(4, '0')}`;
const CODIGO_B = `M-${String(TELA_B).padStart(4, '0')}`;
await apiAdmin('/admin/player/pin-saida', 'PUT', { pin: '482715' });
for (const tela of [TELA_A, TELA_B]) {
  const g = await apiAdmin(`/admin/dispositivos/${tela}/codigo-instalacao`, 'POST');
  const r = await fetch(`${B}/player/provisionar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Player-Version': '1.2.0+12' },
    body: JSON.stringify({ codigoTela: g.json.codigoTela, codigoInstalacao: g.json.codigo }),
  });
  check(`Player instalado na tela ${tela}`, r.ok);
}
PG(`UPDATE dispositivos SET primeiro_sinal_em = now(), ultima_vez_online = now() WHERE ponto_id = ${REDE}`);
PG(`UPDATE pontos SET status = 'em_operacao' WHERE id = ${REDE}`);

// ---------------------------------------------------------------------------
console.log('== C. Anunciante: rede sem localização, sem evento, 0 tela em operação ==');
const anun = await pagina(1280, 1000, 'anunciante');
await irQuieto(anun, `${B}/anunciante/login.html`);
await anun.fill('#email', emailAnun);
await anun.fill('#senha', SENHA);
await anun.click('button[type="submit"]');
await anun.waitForURL(/painel\.html/, { timeout: 10000 });
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
await redeQuieta(anun);
const cardRede = anun.locator(`.ponto-escolha[data-ponto-id="${REDE}"]`);
let textoCard = await cardRede.innerText();
check('card: nome "Mostraí Móvel" (sem cidade colada)', textoCard.includes('Mostraí Móvel') && !/Móvel — /.test(textoCard), textoCard);
check('card: cidade separada', textoCard.includes('Matão/SP'));
check('card: selo MÓVEL (sem ITINERANTE)', /MÓVEL/.test(await cardRede.locator('.selo-movel').innerText()) && !/itinerante/i.test(textoCard), textoCard);
check('card: Local atual — Sem localização no momento', /Local atual\s*Sem localização no momento/i.test(textoCard), textoCard);
check('card: Próxima localização — Nenhuma programada', /Próxima localização\s*Nenhuma programada/i.test(textoCard), textoCard);
check(
  'card: nada técnico',
  !/telas na rede|em operação agora|inventário|volta automaticamente|Sem alocação|Indisponível/i.test(textoCard),
  textoCard,
);
check('card: foto real da rede (não a faixa azul)', await cardRede.locator('.ponto-card-media img').evaluate((i) => i.complete && i.naturalWidth === 1280));
check('card: sem .cheio', !(await cardRede.evaluate((c) => c.classList.contains('cheio'))));
check('card: caixa HABILITADA', await cardRede.locator('input').isEnabled());
check('card: "Selecionar"', (await cardRede.locator('.ponto-acao-texto').innerText()).trim() === 'Selecionar');
check('card: moldura 16:9', await cardRede.locator('.ponto-card-media').evaluate((m) => Math.abs(m.clientWidth / m.clientHeight - 16 / 9) < 0.03));
await cardRede.scrollIntoViewIfNeeded();
await shot(cardRede, 'card-sem-localizacao');
await anun.evaluate(() => {
  document.getElementById('msgPontos').textContent = '';
});
await cardRede.locator('.ponto-nome').click();
await anun.waitForFunction(() => /Pronto/.test(document.getElementById('msgPontos').textContent), null, {
  timeout: 8000,
});
check(
  'escolheu a rede: 1 posição',
  PG(`SELECT string_agg(ponto_id::text, ',') FROM anunciantes_pontos WHERE anunciante_id = ${ANUN}`) === REDE,
);
check(
  `contador "1 de ${LIMITE}"`,
  (await anun.textContent('#contadorPontos')) === `1 de ${LIMITE} pontos selecionados`,
  await anun.textContent('#contadorPontos'),
);
await cardRede.locator('[data-agenda-rede]').click();
await anun.waitForSelector('#dlgAgendaMovel[open] .agenda-movel-bloco', { timeout: 8000 });
const agendaVazia = await anun.locator('#dlgAgendaMovel').innerText();
check('Ver agenda: vazia — "Sem localização no momento" e "Nenhuma localização programada."', /Sem localização no momento/.test(agendaVazia) && /Nenhuma localização programada\./.test(agendaVazia), agendaVazia);
check('Ver agenda não marca/desmarca a caixa', await cardRede.locator('input').isChecked());
await anun.locator('#dlgAgendaMovel [data-fechar-agenda]').click();
await recarregarQuieto(anun);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"] input:checked`, { timeout: 10000 });
check('recarregar mantém a escolha', true);

// ---------------------------------------------------------------------------
console.log('== A. Admin: compromisso em outro local (tela A), um futuro e um na conta (tela B) ==');
// Rede Front V3: "+ Novo evento" e "+ Nova hospedagem" viraram UM formulário
// (#formCompromisso) — o contexto diz se é numa conta ou em outro local.
// Envia o formulário e espera fechar; se não fechar, diz o porquê.
async function enviarCompromisso(rotulo) {
  await modal().locator('button[type=submit]').click();
  try {
    await admin.waitForFunction(() => !document.querySelector('dialog[open] #formCompromisso'), null, { timeout: 10000 });
    return true;
  } catch {
    const msg = await modal().locator('[data-msg]').innerText().catch(() => '?');
    check(`${rotulo}: o modal fechou`, false, msg);
    await admin.keyboard.press('Escape');
    return false;
  }
}
const telaLivre = (id) =>
  admin.waitForFunction(
    (t) => /livre/.test(document.querySelector(`dialog[open] [name="telas"][value="${t}"]`)?.closest('label')?.textContent || ''),
    id,
    { timeout: 8000 },
  );
await irAdmin(`#rede/pontos/${REDE}`, '[data-rede-cabecalho] [data-novo-compromisso]');
check('compromissos: vazio, com o botão', /Nenhum compromisso agora ou programado/.test(await admin.locator('[data-compromissos]').innerText()));
await admin.click('[data-rede-cabecalho] [data-novo-compromisso]');
await modal().waitFor();
await admin.click('label:has([name="contexto"][value="externo"])');
check('outro local: sem conta e sem benefício', !(await admin.isVisible('#cmpConta')) && !(await admin.isVisible('[data-beneficio]')));
check('outro local: "Telas" (várias)', (await modal().locator('[data-telas-titulo]').innerText()) === 'Telas');
await admin.fill('#cmpNome', 'Feira de Negócios');
await admin.fill('#cmpLocal', 'Parque de Exposições');
await admin.fill('#cmp_cep', '15990-000');
await admin.fill('#cmp_logradouro', 'Avenida das Feiras');
await admin.fill('#cmp_numero', '100');
await admin.fill('#cmp_bairro', 'Jardim');
// Já começou há 1 h e vai até daqui a 23 h: período de até 24 h.
await admin.fill('#cmpInicio', parede(-1 * HORA));
await admin.fill('#cmpFim', parede(23 * HORA));
await admin.dispatchEvent('#cmpFim', 'change');
await telaLivre(TELA_A);
check('período curto: "Operar durante todo o período" marcado', await admin.isChecked('[name="horario_modo"][value="periodo"]'));
check('outro local: telas em caixas (várias)', (await admin.getAttribute(`[name="telas"][value="${TELA_A}"]`, 'type')) === 'checkbox');
await admin.check(`[name="telas"][value="${TELA_A}"]`);
await shot(modal(), 'compromisso-externo');
await enviarCompromisso('compromisso em outro local');
await redeQuieta(admin);
const EVENTO = PG(`SELECT id FROM pontos_moveis_eventos WHERE ponto_id = ${REDE}`);
check('outro local: evento com a tela A, durante todo o período', PG(`SELECT nome || '|' || (horario_operacao IS NULL) FROM pontos_moveis_eventos WHERE id = ${EVENTO}`) === 'Feira de Negócios|true');
check(
  'outro local: endereço composto das partes',
  /Avenida das Feiras, 100/.test(PG(`SELECT endereco FROM pontos_moveis_eventos WHERE id = ${EVENTO}`)),
);
await admin.waitForSelector(`[data-proximos] [data-compromisso="e${EVENTO}"][data-contexto="externo"]`, { timeout: 10000 });
await admin.click(`[data-comp-acao="iniciar"][data-ref="e${EVENTO}"]`);
await admin.waitForSelector('dialog[open] [data-confirmar]');
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForSelector(`[data-agora] [data-compromisso="e${EVENTO}"]`, { timeout: 10000 });
await redeQuieta(admin);
const futuro = await apiAdmin(`/admin/pontos/${REDE}/compromissos`, 'POST', {
  contexto: 'externo',
  nome: 'Festa do Peão',
  local: 'Recinto de Rodeios',
  endereco_origem: 'outro',
  endereco_partes: { cep: '15990-000', logradouro: 'Rodovia SP-310', numero: '300', bairro: 'Zona Rural', cidade: 'Matão', uf: 'SP' },
  inicio: parede(3 * DIA),
  fim: parede(3 * DIA + 5 * HORA),
  horario_modo: 'periodo',
  telas: [Number(TELA_A)],
});
check('compromisso futuro cadastrado', futuro.status === 201, JSON.stringify(futuro.json));

// Na conta: busca a conta, o endereço dela, a tela B; a A está ocupada.
await admin.click('[data-rede-cabecalho] [data-novo-compromisso]');
await modal().waitFor();
check('na conta: contexto padrão', await admin.isChecked('[name="contexto"][value="conta"]'));
await admin.fill('#cmpConta', 'Padaria');
await admin.waitForSelector('#cmpContaLista [role="option"]');
const opcoes = await admin.$$eval('#cmpContaLista [role="option"]', (ls) => ls.map((l) => l.innerText));
check('busca de conta: a Padaria Central, com a cidade', opcoes.length === 1 && /Padaria Central/.test(opcoes[0]) && /Matão\/SP/.test(opcoes[0]), opcoes.join(' | '));
await admin.click('#cmpContaLista [role="option"]');
await admin.waitForSelector('[data-conta-escolhida]:not([hidden]) b');
check('conta escolhida: Padaria Central', (await modal().locator('[data-conta-escolhida] b').innerText()) === 'Padaria Central');
await admin.waitForSelector('[name="endereco_origem"]');
check('endereço da conta já escolhido', await admin.isChecked('[name="endereco_origem"][value="conta"]'));
check('benefício na conta', /Benefício/.test(await modal().locator('[data-beneficio]').innerText()));
await admin.fill('#cmpInicio', parede(-1 * HORA));
await admin.fill('#cmpFim', parede(2 * DIA));
await admin.dispatchEvent('#cmpFim', 'change');
await telaLivre(TELA_B);
check('na conta: a tela A (no outro local) aparece ocupada', await admin.isDisabled(`[name="telas"][value="${TELA_A}"]`));
check('na conta: uma tela só (rádio)', (await admin.getAttribute(`[name="telas"][value="${TELA_B}"]`, 'type')) === 'radio');
check('vários dias sem horário do local: nada marcado', (await admin.$$eval('[name="horario_modo"]:checked', (r) => r.length)) === 0 && !(await admin.isVisible('[data-modo-local]')));
await admin.check(`[name="telas"][value="${TELA_B}"]`);
await admin.check('[name="horario_modo"][value="periodo"]');
await shot(modal(), 'compromisso-conta');
await enviarCompromisso('compromisso na conta');
await redeQuieta(admin);
const HOSP = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = ${REDE}`);
check(
  'na conta: hospedagem programada da Padaria na tela B, endereço da conta',
  PG(`SELECT conta_id || '|' || dispositivo_id || '|' || estado || '|' || local || '|' || endereco FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`).startsWith(
    `${ANF}|${TELA_B}|programada|Padaria Central|Rua Nove, 90`,
  ),
  PG(`SELECT conta_id || '|' || dispositivo_id || '|' || estado || '|' || local || '|' || endereco FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`),
);
const linhaHosp = admin.locator(`[data-compromisso="h${HOSP}"]`);
await linhaHosp.waitFor({ timeout: 10000 });
check('termo físico: Pendente', (await linhaHosp.locator('[data-termo-fisico]').innerText()) === 'Pendente');
check('iniciar travado sem o termo', await linhaHosp.locator('[data-comp-acao="iniciar"]').isDisabled());
await linhaHosp.locator('[data-comp-acao="termo"]').click();
await modal().waitFor();
await modal().locator('[name="assinado"]').check();
await modal().locator('button[type=submit]').click();
await admin.waitForSelector(`[data-compromisso="h${HOSP}"] [data-termo-fisico="assinado"]`, { timeout: 10000 });
await redeQuieta(admin);
await admin.click(`[data-comp-acao="iniciar"][data-ref="h${HOSP}"]`);
await modal().waitFor();
check('iniciar na conta: registra a entrega do equipamento', /Itens/.test(await modal().innerText()) && /Condição/.test(await modal().innerText()));
await modal().locator('button[type=submit]').click();
await admin.waitForSelector(`[data-agora] [data-compromisso="h${HOSP}"]`, { timeout: 10000 });
await redeQuieta(admin);
check(
  'hospedagem em curso, com a entrega registrada',
  PG(
    `SELECT h.estado || '|' || (SELECT COUNT(*) FROM hospedagem_movimentacoes m WHERE m.hospedagem_id = h.id AND m.tipo = 'entrega') FROM pontos_moveis_hospedagens h WHERE h.id = ${HOSP}`,
  ) === 'ativa|1',
);
// As duas TVs comunicando agora (o Player bate a cada 15 s) — o estado
// "operando" não depende de quanto tempo o roteiro levou até aqui.
PG(
  `UPDATE dispositivos SET ultima_vez_online = now(), player_estado = 'PLAYING', config_versao_aplicada = config_versao_desejada WHERE ponto_id = ${REDE}`,
);
await admin.reload();
await admin.waitForSelector('[data-rede-cabecalho]');
await redeQuieta(admin);
const linhaA = await admin.locator(`[data-tela-linha="${TELA_A}"]`).innerText();
const linhaB = await admin.locator(`[data-tela-linha="${TELA_B}"]`).innerText();
check('tela A: operando, no outro local', linhaA.includes(CODIGO_A) && /Operando/.test(linhaA) && /Em Parque de Exposições até/.test(linhaA), linhaA);
check('tela B: operando, na conta', linhaB.includes(CODIGO_B) && /Operando/.test(linhaB) && /Em Padaria Central até/.test(linhaB), linhaB);
const agora = await admin.locator('[data-agora]').innerText();
check('Agora: os dois compromissos', /Feira de Negócios/.test(agora) && /Padaria Central/.test(agora), agora);
check('Próximos: a Festa do Peão', /Festa do Peão/.test(await admin.locator('[data-proximos]').innerText()));
check(
  'cabeçalho: 2 telas · 2 operando · 1 compromisso futuro',
  /2 telas · 2 operando · 1 compromisso futuro/.test(await admin.locator('[data-rede-cabecalho]').innerText()),
  await admin.locator('[data-rede-cabecalho]').innerText(),
);
await shot(admin.locator('#conteudo'), 'ficha-rede', { animations: 'disabled' });
const conflito = await apiAdmin(`/admin/pontos/${REDE}/compromissos`, 'POST', {
  contexto: 'externo',
  nome: 'Outro evento',
  local: 'Ginásio',
  endereco_origem: 'outro',
  endereco_partes: { cep: '15990-000', logradouro: 'Rua X', numero: '1', bairro: 'Centro', cidade: 'Matão', uf: 'SP' },
  inicio: parede(2 * HORA),
  fim: parede(5 * HORA),
  horario_modo: 'periodo',
  telas: [Number(TELA_B)],
});
check('compromisso com a tela B ocupada: 409 na tela', conflito.status === 409 && conflito.json?.campo === 'telas', JSON.stringify(conflito.json));

console.log('== A. Admin: Agenda móvel sob demanda ==');
await irAdmin('#rede/pontos', '.colecao');
await admin.locator('.colecao .chip', { hasText: 'Móveis' }).click();
await admin.click('[data-barra-moveis] [data-agenda-movel]');
await admin.waitForSelector('dialog[open] [data-agenda-admin]', { timeout: 10000 });
const agendaAdmin = await modal().innerText();
check('agenda móvel: colunas (Onde no lugar de Tipo)', ['Data', 'Horário', 'Rede', 'Tela(s)', 'Onde', 'Local', 'Estado'].every((c) => agendaAdmin.includes(c)) && !/\bTipo\b/.test(agendaAdmin), agendaAdmin.slice(0, 200));
check('agenda móvel: evento, hospedagem e o futuro', /Feira de Negócios/.test(agendaAdmin) && /Padaria Central/.test(agendaAdmin) && /Festa do Peão/.test(agendaAdmin));
check('agenda móvel: 3 linhas (agora + futuro)', (await modal().locator('[data-agenda-admin] tbody tr').count()) === 3);
const onde = await modal().locator('[data-agenda-admin] tbody tr').evaluateAll((trs) => trs.map((tr) => `${tr.dataset.agendaTipo}:${tr.children[4].textContent.trim()}`).sort());
check('agenda móvel: "Na conta" e "Outro local"', JSON.stringify(onde) === JSON.stringify(['evento:Outro local', 'evento:Outro local', 'hospedagem:Na conta']), JSON.stringify(onde));
check('agenda móvel: rede com a cidade', /Mostraí Móvel\s*Matão\/SP/.test(await modal().locator('[data-agenda-admin] tbody tr').first().locator('td').nth(2).innerText()));
await shot(modal(), 'agenda-movel-admin');
await modal().locator('[data-agenda-modo="1"]').click();
await admin.waitForSelector('dialog[open] [data-agenda-corpo] .empty-state, dialog[open] [data-agenda-admin]', { timeout: 10000 });
check('agenda móvel: histórico vazio por enquanto', /Nenhum compromisso encerrado/.test(await modal().innerText()));
await modal().locator('[data-fechar]').first().click();

// ---------------------------------------------------------------------------
console.log('== C. Anunciante: rede em operação ==');
await recarregarQuieto(anun);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
textoCard = await anun.locator(`.ponto-escolha[data-ponto-id="${REDE}"]`).innerText();
check('card: "2 locais em operação"', /Local atual\s*2 locais em operação/i.test(textoCard), textoCard);
check('card: próxima localização = o evento futuro', /Próxima localização\s*Festa do Peão · Recinto de Rodeios ·/i.test(textoCard), textoCard);
check('card: sem público estimado', !/pessoas|público/i.test(textoCard));
await anun.locator(`.ponto-escolha[data-ponto-id="${REDE}"] [data-agenda-rede]`).click();
await anun.waitForSelector('#dlgAgendaMovel[open] .agenda-movel-item', { timeout: 8000 });
const agenda = await anun.locator('#dlgAgendaMovel').innerText();
check('Ver agenda: agora tem os dois locais', /Feira de Negócios/.test(agenda) && /Padaria Central/.test(agenda), agenda);
check('Ver agenda: futuro tem a Festa do Peão', /Festa do Peão/.test(agenda) && /Recinto de Rodeios/.test(agenda));
check('Ver agenda: sem público, conta, tela ou termo', !/600|5000|5\.000|pessoas|Termo|M-\d{4}|Padaria Central \(#|percentual/i.test(agenda), agenda);
await shot(anun.locator('#dlgAgendaMovel'), 'agenda-publica');
await anun.locator('#dlgAgendaMovel [data-fechar-agenda]').click();
const cel = await pagina(390, 844, 'anunciante 390');
await irQuieto(cel, `${B}/anunciante/login.html`);
await cel.fill('#email', emailAnun);
await cel.fill('#senha', SENHA);
await cel.click('button[type="submit"]');
await cel.waitForURL(/painel\.html/, { timeout: 10000 });
await cel.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
await redeQuieta(cel);
check('390px: sem rolagem lateral', await semRolagemLateral(cel));
await cel.locator(`.ponto-escolha[data-ponto-id="${REDE}"]`).scrollIntoViewIfNeeded();
await shot(cel.locator(`.ponto-escolha[data-ponto-id="${REDE}"]`), 'card-em-operacao-390');

// ---------------------------------------------------------------------------
console.log('== A. Admin: Candidaturas → Interesses em hospedar ==');
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ANF}`,
);
const anf = await pagina(1280, 1000, 'anfitriao');
await irQuieto(anf, `${B}/anunciante/login.html`);
await anf.fill('#email', emailAnf);
await anf.fill('#senha', SENHA);
await anf.click('button[type="submit"]');
await anf.waitForURL(/painel\.html/, { timeout: 10000 });
await redeQuieta(anf);
const interesse = await anf.evaluate(async () => {
  const r = await fetch('/hospedagem/interesse', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ local_tipo: 'conta', observacao: 'Temos espaço na entrada' }),
  });
  return r.status;
});
check('interesse enviado pela conta com direito', interesse === 201, String(interesse));
await irAdmin('#rede/candidaturas', '.subabas');
const subabas = await admin.locator('.subabas .chip').allInnerTexts();
check('Candidaturas: subabas', JSON.stringify(subabas) === JSON.stringify(['Candidaturas de ponto', 'Interesses em hospedar']), JSON.stringify(subabas));
await admin.click('.subabas .chip:has-text("Interesses em hospedar")');
await admin.waitForSelector('[data-interesse-acao="agendar"]', { timeout: 10000 });
await redeQuieta(admin);
check('interesses: hash #rede/candidaturas/interesses', (await admin.evaluate(() => location.hash)) === '#rede/candidaturas/interesses');
check('benefício numa linha', /Benefício padrão da hospedagem:\s*\d+%/.test(await admin.locator('[data-beneficio-hospedagem]').innerText()));
check('interesse: "Recebido"', /Recebido/.test(await admin.locator('[data-interesse-id]').first().innerText()));
await shot(admin.locator('#conteudo'), 'interesses', { animations: 'disabled' });
await admin.click('[data-alterar-percentual]');
await modal().waitFor();
check('alterar benefício: explicação no modal', /novas hospedagens/.test(await modal().innerText()));
await modal().locator('[data-fechar]').first().click();
await modal().waitFor({ state: 'detached' }).catch(() => {});
await admin.click('[data-historico-percentual]');
await modal().waitFor();
check('ver histórico do benefício (mesmo sem alteração)', /Histórico do benefício/.test(await modal().innerText()));
await modal().locator('[data-fechar]').first().click();
await modal().waitFor({ state: 'detached' }).catch(() => {});
check('interesse: botão "Agendar compromisso"', (await admin.locator('[data-interesse-acao="agendar"]').first().innerText()).trim() === 'Agendar compromisso');
await admin.click('[data-interesse-acao="agendar"]');
await admin.waitForSelector('dialog[open] #formCompromisso');
await admin.waitForSelector('dialog[open] [data-conta-escolhida]:not([hidden]) b');
await admin.waitForSelector('dialog[open] [name="endereco_origem"]');
await admin.waitForSelector('dialog[open] [name="telas"]');
check('agendar: contexto "Numa conta"', await admin.isChecked('[name="contexto"][value="conta"]'));
check('agendar: conta pré-preenchida', (await modal().locator('[data-conta-escolhida] b').innerText()) === 'Padaria Central');
check(
  'agendar: endereço da conta pré-escolhido (o local do interesse)',
  (await admin.isChecked('[name="endereco_origem"][value="conta"]')) &&
    /Rua Nove, 90/.test(await modal().locator('label:has([name="endereco_origem"][value="conta"])').innerText()),
);
check(
  'agendar: rede escolhida (única, sem seletor) com as telas dela',
  !(await modal().locator('#cmpRede').count()) && (await modal().locator('[name="telas"]').count()) === 2,
);
await shot(modal(), 'agendar-interesse');
await modal().locator('[data-fechar]').first().click();

// ---------------------------------------------------------------------------
console.log('== Onde estamos e dados ==');
// UM card por rede (estação "Onde estamos", 08/10/2026): com os locais
// reais de agora, sem endereço-base nem status técnico.
const publico = await (await fetch(`${B}/pontos`)).json();
const linhasDaRede = publico.filter((p) => String(p.id) === REDE);
check('"Onde estamos": UMA linha da rede', linhasDaRede.length === 1, JSON.stringify(linhasDaRede));
const daRede = (linhasDaRede[0]?.movel?.agora || []).map((l) => l.nome).sort();
check('"Onde estamos": os dois locais reais', JSON.stringify(daRede) === JSON.stringify(['Padaria Central', 'Parque de Exposições']), JSON.stringify(daRede));
check(
  '"Onde estamos": sem endereço-base nem dado técnico',
  linhasDaRede[0]?.endereco === null && linhasDaRede[0]?.status === 'em_operacao' && !/heartbeat|player|versao|online|telas/i.test(JSON.stringify(linhasDaRede[0])),
);
const site = await pagina(1280, 900, 'onde-estamos');
await irQuieto(site, `${B}/pontos.html`);
await site.waitForSelector('#pontosGrid .ponto-card');
const cardMovelSite = site.locator('#pontosGrid .ponto-card-movel');
check('site: UM card do Mostraí Móvel', (await cardMovelSite.count()) === 1);
check('site: selo MÓVEL e foto da rede', (await cardMovelSite.locator('.ponto-card-media .selo-movel').count()) === 1 && (await cardMovelSite.locator('.ponto-card-media img').count()) === 1);
const textoRede = (await cardMovelSite.innerText()).replace(/\s+/g, ' ');
check('site: Local atual com os dois locais', /Padaria Central/.test(textoRede) && /Parque de Exposições/.test(textoRede), textoRede);
check('site: "Ver no mapa" só nos locais reais (2)', (await cardMovelSite.locator('.mapa-link').count()) === 2);
check('site: card fixo continua, com "Ver no mapa"', (await site.locator('#pontosGrid .ponto-card:not(.ponto-card-movel) .mapa-link').count()) >= 1);
await shot(site, 'onde-estamos-com-local', { fullPage: true });
// Encerrados os dois compromissos: a rede continua, sem localização e sem mapa.
const hospAtiva = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = ${REDE} AND estado = 'ativa'`);
const eventoEmCurso = PG(`SELECT id FROM pontos_moveis_eventos WHERE ponto_id = ${REDE} AND estado = 'em_andamento'`);
check('encerra a hospedagem', (await apiAdmin(`/admin/pontos/${REDE}/hospedagens/${hospAtiva}/encerrar`, 'POST', {})).status === 200);
check('encerra o evento', (await apiAdmin(`/admin/pontos/${REDE}/eventos/${eventoEmCurso}/encerrar`, 'POST', {})).status === 200);
await irQuieto(site, `${B}/pontos.html`);
await site.waitForSelector('#pontosGrid .ponto-card-movel');
const semLocal = (await cardMovelSite.innerText()).replace(/\s+/g, ' ');
check('site sem alocação: o card continua, "Sem localização no momento"', /Sem localização no momento/.test(semLocal), semLocal);
check('site sem alocação: nenhum "Ver no mapa" na rede', (await cardMovelSite.locator('.mapa-link').count()) === 0);
const celular = await pagina(390, 844, 'onde-estamos-390');
await irQuieto(celular, `${B}/pontos.html`);
await celular.waitForSelector('#pontosGrid .ponto-card-movel');
check('site 390px: sem rolagem lateral', await semRolagemLateral(celular));
await shot(celular, 'onde-estamos-sem-local-390', { fullPage: true });
check('rota antiga da central: 404', (await apiAdmin('/admin/pontos-moveis')).status === 404);
check('rota do termo eletrônico: 410', (await apiAdmin('/admin/hospedagem/termos')).status === 410);

await navegador.close();
console.log(`\n${falhas.length ? `${falhas.length} FALHA(S)` : 'tudo ok'}; ${erros.length} erro(s) de console`);
for (const e of erros) console.log('  ', e);
process.exit(falhas.length || erros.length ? 1 : 0);
