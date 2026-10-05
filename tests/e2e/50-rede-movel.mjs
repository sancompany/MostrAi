// MOSTRAÍ MÓVEL = REDE MÓVEL DA CIDADE (migration 115). No navegador, de
// ponta a ponta:
//   Admin — a central (redes, próximos compromissos, interesses, benefício;
//     sem o bloco do termo eletrônico); cria a rede por cidade/UF (sem Tela
//     1); adiciona duas telas; a ficha da tela tem "Instalada em" e nenhum
//     custo/amortização; cadastra um evento com a tela A (todo o período por
//     padrão) e inicia; agenda a hospedagem da tela B, marca o termo físico,
//     inicia com a entrega; "Operação agora" mostra as duas; a tela B ocupada
//     não é oferecida para outro evento no período (e a API recusa).
//   Anunciante — com 0 tela em operação a rede aparece ("Nenhuma tela móvel
//     em operação agora…") e é escolhível; a escolha conta 1 posição e
//     sobrevive ao recarregar; com as telas alocadas o card diz "2 telas na
//     rede · 2 em operação agora".
//   Dados — sem colunas de custo/amortização, sem tabelas do termo
//     eletrônico; termo físico gravado; "Onde estamos" mostra os dois locais
//     reais (nunca um pino da rede).
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/50-rede-movel.mjs
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
const shot = (alvo, nome, opcoes = {}) => alvo.screenshot({ path: `${SAIDA}rede-movel-${nome}.png`, ...opcoes });

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

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------
// 409/410: provocados de propósito abaixo (cidade repetida, termo eletrônico).
const admin = await pagina(1400, 960, 'admin', /status of (401|409|410)/);
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

console.log('== Admin: a central das redes ==');
await irAdmin('#rede/moveis', '[data-beneficio-hospedagem]');
const central = await admin.locator('#conteudo, main').first().innerText();
for (const secao of ['Redes móveis', 'Próximos compromissos', 'Interesses em hospedar', 'Configuração do benefício']) {
  check(`central: seção "${secao}"`, central.includes(secao));
}
check('central: sem o bloco do termo eletrônico', !/Termo de hospedagem|Publicar nova versão/.test(central));
check('central: "Benefício padrão de hospedagem"', /Benefício padrão de hospedagem/.test(central));

console.log('== Admin: cria a rede da cidade ==');
await admin.click('[data-criar-movel]');
await modal().waitFor();
const textoModal = await modal().innerText();
check('modal: Cidade e UF', /Cidade/.test(textoModal) && /UF/.test(textoModal));
check('modal: "Foto/capa da rede móvel"', /Foto\/capa da rede móvel/.test(textoModal));
check('modal: sem "1 ponto móvel = 1 tela" nem "Tela 1"', !/1 ponto móvel = 1 tela|Tela 1/.test(textoModal));
check(
  'modal: upload estilizado (sem "Escolher arquivo")',
  (await modal().locator('[data-foto-acao]').innerText()) === 'Selecionar foto' &&
    (await modal().locator('#cmFoto').getAttribute('class')) === 'u-sr',
);
await shot(modal(), 'modal-nova-rede');
await admin.fill('#cmCidade', CIDADE);
await admin.selectOption('#cmUf', 'SP');
await modal().locator('button[type=submit]').click();
await admin.waitForSelector('[data-resumo-rede]', { timeout: 10000 });
await redeQuieta(admin);
const REDE = PG(`SELECT id FROM pontos WHERE tipo = 'movel' AND cidade = '${CIDADE}' AND uf = 'SP'`);
check('rede criada sem tela', PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${REDE}`) === '0');
const cabecalho = await admin.locator('#pontoInformacoes').innerText();
check('cabeçalho: "MOSTRAÍ MÓVEL — MATÃO/SP"', cabecalho.includes('MOSTRAÍ MÓVEL — MATÃO/SP'), cabecalho.slice(0, 80));
check('cabeçalho: selos REDE ITINERANTE e Ativa', /Rede Itinerante/i.test(cabecalho) && /Ativa/.test(cabecalho));
check('cabeçalho: "Disponível para anunciantes" Sim', /Disponível para anunciantes\s*Sim/.test(cabecalho));
check(
  'cabeçalho: nada do modelo antigo',
  !/1 ponto móvel = 1 tela|Equipamento da Mostraí|Proprietário|Benefício do ponto|Inventário|fora da escolha|Primeiro sinal de tela/.test(
    cabecalho,
  ),
  cabecalho,
);
const dup = await apiAdmin('/admin/pontos-moveis', 'POST', { cidade: 'matão', uf: 'SP' });
check('mesma cidade + UF de novo: 409', dup.status === 409, JSON.stringify(dup.json));

console.log('== Admin: duas telas ==');
await admin.click('#pontoInformacoes [data-nova-tela]');
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

// TVs instaladas pelo contrato do Player (a rede entra em operação).
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
console.log('== Anunciante: rede com 0 tela em operação ==');
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
check('card: nome da rede', textoCard.includes(`Mostraí Móvel — ${CIDADE}`), textoCard);
check('card: selo ITINERANTE', /ITINERANTE/i.test(textoCard));
check('card: frase da cidade', textoCard.includes(`Rede móvel de eventos e ações em ${CIDADE}.`));
check('card: "2 telas na rede · 0 em operação agora"', textoCard.includes('2 telas na rede · 0 em operação agora'));
check(
  'card: aviso de volta automática',
  textoCard.includes(
    `Nenhuma tela móvel em operação agora. A campanha volta automaticamente para a rede móvel quando houver inventário ativo em ${CIDADE}.`,
  ),
);
check('card: seleção habilitada', await cardRede.locator('input').isEnabled());
await cardRede.scrollIntoViewIfNeeded();
await shot(cardRede, 'card-sem-operacao');
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
await recarregarQuieto(anun);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"] input:checked`, { timeout: 10000 });
check('recarregar mantém a escolha', true);

// ---------------------------------------------------------------------------
console.log('== Admin: evento com a tela A ==');
await irAdmin(`#rede/pontos/${REDE}`, '[data-novo-evento]');
await admin.click('[data-novo-evento]');
await modal().waitFor();
check('evento: "Operar durante todo o período" marcado', await modal().locator('[data-todo-periodo]').isChecked());
check('evento: editor semanal escondido', !(await modal().locator('[data-horario-personalizado]').isVisible()));
check('evento: telas participantes', /Telas participantes/.test(await modal().innerText()));
await admin.fill('#evNome', 'Feira de Negócios');
await admin.fill('#evLocal', 'Parque de Exposições');
await admin.fill('#evEndereco', 'Av. das Feiras, 100');
await admin.fill('#evInicio', parede(-1 * HORA));
await admin.fill('#evFim', parede(DIA));
await admin.locator('#evFim').dispatchEvent('change');
await admin.waitForFunction(
  (id) => /livre/.test(document.querySelector(`[data-livre="${id}"]`)?.textContent || ''),
  TELA_A,
  { timeout: 8000 },
);
await modal().locator(`[name="telas"][value="${TELA_A}"]`).check();
await shot(modal(), 'modal-evento');
await modal().locator('button[type=submit]').click();
await admin.waitForSelector('[data-agenda] [data-evento-id]', { timeout: 10000 });
await redeQuieta(admin);
const EVENTO = PG(`SELECT id FROM pontos_moveis_eventos WHERE ponto_id = ${REDE}`);
check(
  'evento: só a tela A',
  PG(`SELECT string_agg(dispositivo_id::text, ',') FROM pontos_moveis_evento_telas WHERE evento_id = ${EVENTO}`) ===
    TELA_A,
);
check('evento: todo o período (sem grade)', PG(`SELECT horario_operacao IS NULL FROM pontos_moveis_eventos WHERE id = ${EVENTO}`) === 't');
await admin.click(`[data-evento-acao="iniciar"][data-evento="${EVENTO}"]`);
await modal().waitFor();
await modal().locator('button.btn.primary, button[data-confirmar]').last().click();
await admin.waitForSelector('[data-operacao-agora]', { timeout: 10000 });
await redeQuieta(admin);

console.log('== Admin: hospedagem com a tela B ==');
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
await admin.selectOption('#hoTela', String(TELA_B));
await admin.fill('#hoConta', `Padaria Central (#${ANF})`);
await admin.locator('#hoConta').dispatchEvent('change');
await admin.fill('#hoLocal', 'Padaria Central');
await admin.fill('#hoEndereco', 'Rua Nove, 90');
check('hospedagem: todo o período por padrão', await modal().locator('[data-todo-periodo]').isChecked());
await shot(modal(), 'modal-hospedagem');
await modal().locator('button[type=submit]').click();
await admin.waitForSelector('[data-agenda] [data-hospedagem-id]', { timeout: 10000 });
await redeQuieta(admin);
const HOSP = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = ${REDE}`);
check('hospedagem: tela B', PG(`SELECT dispositivo_id FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`) === TELA_B);
const linhaHosp = admin.locator(`[data-hospedagem-id="${HOSP}"]`);
check('termo físico: Pendente', (await linhaHosp.locator('[data-termo-fisico]').innerText()) === 'Pendente');
check('iniciar travado sem o termo', await linhaHosp.locator('[data-hosp-acao="iniciar"]').isDisabled());
await linhaHosp.locator('[data-hosp-acao="termo"]').click();
await modal().waitFor();
await modal().locator('[name="assinado"]').check();
await modal().locator('button[type=submit]').click();
await admin.waitForSelector(`[data-hospedagem-id="${HOSP}"] [data-termo-fisico="assinado"]`, { timeout: 10000 });
await redeQuieta(admin);
check('termo físico gravado', PG(`SELECT termo_assinado FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`) === 't');
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
check(
  'cabeçalho: "Telas comerciais ativas agora 2 de 2"',
  /Telas comerciais ativas agora\s*2 de 2/.test(await admin.locator('#pontoInformacoes').innerText()),
);
await shot(admin.locator('.ponto-detalhe-grid'), 'ficha-rede', { animations: 'disabled' });

console.log('== Admin: a mesma tela não pega dois compromissos ==');
const conflito = await apiAdmin(`/admin/pontos/${REDE}/eventos`, 'POST', {
  nome: 'Outro evento',
  local: 'Ginásio',
  endereco: 'Rua X, 1',
  inicio: parede(2 * HORA),
  fim: parede(5 * HORA),
  telas: [Number(TELA_B)],
});
check('evento com a tela B ocupada: 409', conflito.status === 409, JSON.stringify(conflito.json));

// ---------------------------------------------------------------------------
console.log('== Anunciante: rede em operação ==');
await recarregarQuieto(anun);
await anun.waitForSelector(`.ponto-escolha[data-ponto-id="${REDE}"]`, { timeout: 10000 });
textoCard = await anun.locator(`.ponto-escolha[data-ponto-id="${REDE}"]`).innerText();
check('card: "2 telas na rede · 2 em operação agora"', textoCard.includes('2 telas na rede · 2 em operação agora'), textoCard);
check('card: sem o aviso de 0 tela', !/Nenhuma tela móvel em operação agora/.test(textoCard));
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
console.log('== Interesse → agendar: dados pré-preenchidos ==');
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
await irAdmin('#rede/moveis', '[data-interesse-acao="agendar"]');
check('interesse: "Recebido"', /Recebido/.test(await admin.locator('[data-interesse-id]').first().innerText()));
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
check(
  'sem colunas de custo/amortização',
  PG(
    `SELECT COUNT(*) FROM information_schema.columns WHERE table_name = 'dispositivos' AND column_name IN ('custo_equipamento','meses_amortizacao')`,
  ) === '0',
);
check('sem tabelas do termo eletrônico', PG(`SELECT to_regclass('hospedagem_aceites') IS NULL AND to_regclass('hospedagem_termos') IS NULL`) === 't');
check('rota do termo eletrônico: 410', (await apiAdmin('/admin/hospedagem/termos')).status === 410);
const resumo = await apiAdmin('/admin/resumo');
check('Visão geral sem amortização', resumo.json?.financeiro && !('amortizacaoMensal' in resumo.json.financeiro));

await navegador.close();
console.log(`\n${falhas.length ? `${falhas.length} FALHA(S)` : 'tudo ok'}; ${erros.length} erro(s) de console`);
for (const e of erros) console.log('  ', e);
process.exit(falhas.length || erros.length ? 1 : 0);
