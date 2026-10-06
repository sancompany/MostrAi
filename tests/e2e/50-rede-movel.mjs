// REDE / ADMIN V2 sobre a REDE MÓVEL DA CIDADE (migrations 115 e 116). O
// roteiro principal da estação, no navegador, de ponta a ponta:
//   A. Admin — Rede tem só [Pontos] [Candidaturas]; #rede/moveis abre Pontos
//     com o filtro Móveis; fixos e móveis no MESMO grid; o filtro Móveis
//     mostra a barra (+ Nova rede móvel, Agenda móvel); cria a rede com Nome,
//     Cidade e UF separados e a foto ENQUADRADA (16:9); duas telas (um único
//     "+ Adicionar tela" na ficha); evento com a tela A, hospedagem com a B
//     (termo físico); a mesma tela nunca pega dois compromissos; a Agenda
//     móvel abre sob demanda (agora + próximos, histórico à parte);
//     Candidaturas → Interesses em hospedar com o benefício numa linha e o
//     "Agendar hospedagem" pré-preenchido; "Alterar foto" de um ponto fixo.
//   B. Conta — "+ Criar ponto" na ficha da conta: formulário pré-preenchido,
//     salva um ponto FIXO da conta (origem admin), sem candidatura.
//   C. Anunciante — o card do Mostraí Móvel: foto real (nunca a faixa azul),
//     ITINERANTE, cidade, "Atual" / "Próxima localização", sem dado técnico;
//     com 0 tela em operação, 0 evento e 0 alocação a caixa está HABILITADA
//     (nunca "Indisponível para escolha") e a escolha conta 1 posição;
//     "Ver agenda" mostra só presente e futuro; 390px sem rolagem lateral.
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
await admin.waitForSelector('#pontoInformacoes [data-alterar-foto]', { timeout: 10000 });
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
const [seletorFixo] = await Promise.all([
  admin.waitForEvent('filechooser'),
  admin.click('#pontoInformacoes [data-alterar-foto]'),
]);
await seletorFixo.setFiles(FOTO_EM_PE);
await enquadrar();
await admin.waitForFunction((id) => !!document.querySelector('#pontoInformacoes .ficha-foto img'), FIXO, { timeout: 10000 });
check('foto do fixo gravada (/e2e-storage, ?v=)', /^\/e2e-storage\/ponto-\d+\.jpg\?v=\d+$/.test(PG(`SELECT foto_instalacao_url FROM pontos WHERE id = ${FIXO}`)));
check('foto do fixo: 1280×720', dimensoesDoArquivo(`${STORAGE}ponto-${FIXO}.jpg`) === '1280,720');

console.log('== A. Admin: Rede só com Pontos e Candidaturas ==');
await irAdmin('#rede/pontos', '.colecao');
const abas = await admin.locator('.modulo-aba').allInnerTexts();
check('Rede: abas Pontos e Candidaturas', JSON.stringify(abas.map((a) => a.replace(/\s*\d+$/, '').trim())) === JSON.stringify(['Pontos', 'Candidaturas']), JSON.stringify(abas));
const chips = await admin.locator('.colecao .chip').allInnerTexts();
for (const c of ['Todos', 'Fixos', 'Móveis', 'Com problema', 'Aguardando instalação', 'Aguardando primeiro sinal', 'Ativos', 'Em reparo', 'Inativos']) {
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
const cabecalho = await admin.locator('#pontoInformacoes').innerText();
check('cabeçalho: "Mostraí Móvel" e "Matão/SP" separados', /MOSTRAÍ MÓVEL/i.test(cabecalho) && cabecalho.includes('Matão/SP') && !/Móvel — Matão/i.test(cabecalho), cabecalho.slice(0, 120));
check('cabeçalho: ITINERANTE e Ativa', /Itinerante/i.test(cabecalho) && /Ativa/.test(cabecalho));
check('ficha: um único "+ Adicionar tela"', (await admin.locator('[data-nova-tela]').count()) === 1);
const dup = await apiAdmin('/admin/pontos-moveis', 'POST', { nome: 'Outra', cidade: 'matão', uf: 'SP' });
check('mesma cidade + UF de novo: 409', dup.status === 409, JSON.stringify(dup.json));
const semNome = await apiAdmin('/admin/pontos-moveis', 'POST', { cidade: 'Araraquara', uf: 'SP' });
check('rede sem nome: 400', semNome.status === 400 && semNome.json?.campo === 'nome', JSON.stringify(semNome.json));

console.log('== A. Admin: o grid com fixo e móvel ==');
await irAdmin('#rede/pontos', '.colecao');
const cardAdmin = admin.locator(`.ponto-card[href="#rede/pontos/${REDE}"]`);
const textoCardAdmin = await cardAdmin.innerText();
check('card admin: ITINERANTE · Ativa · Matão/SP', /Itinerante/i.test(textoCardAdmin) && /Ativa/.test(textoCardAdmin) && textoCardAdmin.includes('Matão/SP'), textoCardAdmin);
check('card admin: Atual / Próximo', /Atual/i.test(textoCardAdmin) && /Próximo/i.test(textoCardAdmin));
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
await irAdmin(`#rede/pontos/${REDE}`, '#pontoTelas [data-nova-tela]');
await admin.click('#pontoTelas [data-nova-tela]');
await admin.waitForURL(/telas\/\d+/, { timeout: 10000 });
await admin.waitForSelector('.tela-ficha');
await redeQuieta(admin);
const fichaTela = await admin.locator('.tela-ficha').innerText();
check('ficha da tela: "Instalada em"', /Instalada em/.test(fichaTela));
check('ficha da tela: sem custo/amortização', !/Custo|amortiza|R\$/i.test(fichaTela), fichaTela);
const TELA_A = PG(`SELECT min(id) FROM dispositivos WHERE ponto_id = ${REDE}`);
await irAdmin(`#rede/pontos/${REDE}`, '#pontoTelas');
await admin.click('#pontoTelas [data-nova-tela]');
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
check('card: selo ITINERANTE', /ITINERANTE/i.test(textoCard));
check('card: Atual — Sem localização no momento', /Atual\s*Sem localização no momento/i.test(textoCard), textoCard);
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
console.log('== A. Admin: evento com a tela A, evento futuro e hospedagem da B ==');
await irAdmin(`#rede/pontos/${REDE}`, '[data-novo-evento]');
await admin.click('[data-novo-evento]');
await modal().waitFor();
check('evento: "Operar durante todo o período" marcado', await modal().locator('[data-todo-periodo]').isChecked());
check('evento: telas participantes', /Telas participantes/.test(await modal().innerText()));
await admin.fill('#evNome', 'Feira de Negócios');
await admin.fill('#evLocal', 'Parque de Exposições');
await admin.fill('#evEndereco', 'Av. das Feiras, 100');
await admin.fill('#evPublico', '600').catch(() => {});
await admin.fill('#evInicio', parede(-1 * HORA));
await admin.fill('#evFim', parede(DIA));
await admin.locator('#evFim').dispatchEvent('change');
await admin.waitForFunction(
  (id) => /livre/.test(document.querySelector(`[data-livre="${id}"]`)?.textContent || ''),
  TELA_A,
  { timeout: 8000 },
);
await modal().locator(`[name="telas"][value="${TELA_A}"]`).check();
await modal().locator('button[type=submit]').click();
await admin.waitForSelector('[data-agenda] [data-evento-id]', { timeout: 10000 });
await redeQuieta(admin);
const EVENTO = PG(`SELECT id FROM pontos_moveis_eventos WHERE ponto_id = ${REDE}`);
await admin.click(`[data-evento-acao="iniciar"][data-evento="${EVENTO}"]`);
await modal().waitFor();
await modal().locator('button.btn.primary, button[data-confirmar]').last().click();
await admin.waitForSelector('[data-operacao-agora]', { timeout: 10000 });
await redeQuieta(admin);
const futuro = await apiAdmin(`/admin/pontos/${REDE}/eventos`, 'POST', {
  nome: 'Festa do Peão',
  local: 'Recinto de Rodeios',
  endereco: 'Rod. SP-310, km 300',
  inicio: parede(3 * DIA),
  fim: parede(3 * DIA + 5 * HORA),
  telas: [Number(TELA_A)],
  publico_estimado: 5000,
});
check('evento futuro cadastrado', futuro.status === 201, JSON.stringify(futuro.json));
await irAdmin(`#rede/pontos/${REDE}`, '[data-nova-hospedagem]');
await admin.click('#pontoInformacoes [data-nova-hospedagem]');
await modal().waitFor();
await admin.fill('#hoInicio', parede(-1 * HORA));
await admin.fill('#hoFim', parede(2 * DIA));
await admin.locator('#hoFim').dispatchEvent('change');
await admin.waitForFunction(
  (id) => [...document.querySelectorAll('#hoTela option')].some((o) => o.value === String(id) && !o.disabled && /livre/.test(o.textContent)),
  TELA_B,
  { timeout: 8000 },
);
check(
  'hospedagem: a tela A (no evento) aparece ocupada',
  await admin.evaluate((id) => document.querySelector(`#hoTela option[value="${id}"]`)?.disabled === true, TELA_A),
);
check('hospedagem: rede listada com a cidade', /Mostraí Móvel · Matão\/SP/.test(await modal().locator('#hoRede').innerText()));
await admin.selectOption('#hoTela', String(TELA_B));
await admin.fill('#hoConta', `Padaria Central (#${ANF})`);
await admin.locator('#hoConta').dispatchEvent('change');
await admin.fill('#hoLocal', 'Padaria Central');
await admin.fill('#hoEndereco', 'Rua Nove, 90');
await modal().locator('button[type=submit]').click();
await admin.waitForSelector('[data-agenda] [data-hospedagem-id]', { timeout: 10000 });
await redeQuieta(admin);
const HOSP = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = ${REDE}`);
const linhaHosp = admin.locator(`[data-hospedagem-id="${HOSP}"]`);
check('termo físico: Pendente', (await linhaHosp.locator('[data-termo-fisico]').innerText()) === 'Pendente');
check('iniciar travado sem o termo', await linhaHosp.locator('[data-hosp-acao="iniciar"]').isDisabled());
await linhaHosp.locator('[data-hosp-acao="termo"]').click();
await modal().waitFor();
await modal().locator('[name="assinado"]').check();
await modal().locator('button[type=submit]').click();
await admin.waitForSelector(`[data-hospedagem-id="${HOSP}"] [data-termo-fisico="assinado"]`, { timeout: 10000 });
await redeQuieta(admin);
await admin.click(`[data-hospedagem-id="${HOSP}"] [data-hosp-acao="iniciar"]`);
await modal().waitFor();
await modal().locator('button[type=submit]').click();
await admin.waitForFunction(
  (id) => document.querySelector(`[data-hospedagem-id="${id}"]`)?.textContent.includes('Hospedado agora'),
  HOSP,
  { timeout: 10000 },
);
await redeQuieta(admin);
const operacao = await admin.locator('[data-operacao-agora]').innerText();
check('operação agora: A no evento', operacao.includes(CODIGO_A) && /Em evento · Feira de Negócios/.test(operacao), operacao);
check('operação agora: B hospedada', operacao.includes(CODIGO_B) && /Hospedada · Padaria Central/.test(operacao), operacao);
check('cabeçalho: "Telas comerciais ativas agora 2 de 2"', /Telas comerciais ativas agora\s*2 de 2/.test(await admin.locator('#pontoInformacoes').innerText()));
await shot(admin.locator('.ponto-detalhe-grid'), 'ficha-rede', { animations: 'disabled' });
const conflito = await apiAdmin(`/admin/pontos/${REDE}/eventos`, 'POST', {
  nome: 'Outro evento',
  local: 'Ginásio',
  endereco: 'Rua X, 1',
  inicio: parede(2 * HORA),
  fim: parede(5 * HORA),
  telas: [Number(TELA_B)],
});
check('evento com a tela B ocupada: 409', conflito.status === 409, JSON.stringify(conflito.json));

console.log('== A. Admin: Agenda móvel sob demanda ==');
await irAdmin('#rede/pontos', '.colecao');
await admin.locator('.colecao .chip', { hasText: 'Móveis' }).click();
await admin.click('[data-barra-moveis] [data-agenda-movel]');
await admin.waitForSelector('dialog[open] [data-agenda-admin]', { timeout: 10000 });
const agendaAdmin = await modal().innerText();
check('agenda móvel: colunas', ['Data', 'Horário', 'Rede', 'Tela(s)', 'Tipo', 'Local', 'Estado'].every((c) => agendaAdmin.includes(c)), agendaAdmin.slice(0, 200));
check('agenda móvel: evento, hospedagem e o futuro', /Feira de Negócios/.test(agendaAdmin) && /Padaria Central/.test(agendaAdmin) && /Festa do Peão/.test(agendaAdmin));
check('agenda móvel: 3 linhas (agora + futuro)', (await modal().locator('[data-agenda-admin] tbody tr').count()) === 3);
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
check('card: "2 locais em operação"', /Atual\s*2 locais em operação/i.test(textoCard), textoCard);
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
await admin.click('[data-interesse-acao="agendar"]');
await modal().waitFor();
await admin.waitForFunction(() => document.querySelector('#hoTela')?.options.length > 0);
check('agendar: conta pré-preenchida', (await admin.inputValue('#hoConta')) === `Padaria Central (#${ANF})`);
check('agendar: local pré-preenchido', (await admin.inputValue('#hoLocal')) === 'Padaria Central');
check('agendar: endereço pré-preenchido', (await admin.inputValue('#hoEndereco')).length > 0);
check('agendar: rede escolhida (única)', (await admin.inputValue('#hoRede')) === REDE);
await modal().locator('[data-fechar]').first().click();

// ---------------------------------------------------------------------------
console.log('== Onde estamos e dados ==');
const publico = await (await fetch(`${B}/pontos`)).json();
const daRede = publico.filter((p) => String(p.id) === REDE).map((p) => p.local_atual).sort();
check('"Onde estamos": os dois locais reais', JSON.stringify(daRede) === JSON.stringify(['Padaria Central', 'Parque de Exposições']), JSON.stringify(daRede));
check('rota antiga da central: 404', (await apiAdmin('/admin/pontos-moveis')).status === 404);
check('rota do termo eletrônico: 410', (await apiAdmin('/admin/hospedagem/termos')).status === 410);

await navegador.close();
console.log(`\n${falhas.length ? `${falhas.length} FALHA(S)` : 'tudo ok'}; ${erros.length} erro(s) de console`);
for (const e of erros) console.log('  ', e);
process.exit(falhas.length || erros.length ? 1 : 0);
