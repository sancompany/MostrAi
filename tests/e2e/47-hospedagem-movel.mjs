// Hospedagem temporária de Ponto Móvel (02/10/2026, migration 113), no
// navegador, de ponta a ponta:
//   · o site público mostra o percentual REAL (não escrito na página) e
//     recebe o interesse de uma tabacaria;
//   · o Admin vê o interesse em Rede › Pontos móveis, muda o percentual
//     (aviso de que só vale para novas), volta para 20% e agenda a
//     hospedagem a partir do interesse — revisão "ficará vinculada a 20%";
//   · o anfitrião aceita o termo pelo painel (sem aceite o Admin não inicia);
//   · inicia (a tela chegou) registrando a entrega: o card do anunciante diz "Agora em: <tabacaria>",
//     sem conta, percentual nem saldo; o painel do anfitrião mostra
//     "Em andamento" com o benefício estimado;
//   · a tela opera; o Admin encerra; o painel mostra horas recebidas e o
//     SALDO DE HOSPEDAGEM; o Admin vê o saldo na ficha da conta.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/47-hospedagem-movel.mjs
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
      contato_telefone: '16999994444',
      senha: SENHA,
      aceitou_termos: true,
      endereco: 'Rua Sete, 70',
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
  await ctx.route(/google\.com\/maps|viacep/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '{}' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    // 400: as recusas de validação que o roteiro provoca de propósito (aceite
    // sem nome, entrega com avaria sem observação) — conferidas na tela.
    if (m.type() !== 'error' || /net::|ERR_FAILED|status of (400|401|404)/.test(m.text())) return;
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

const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const hojeMais = (dias) => {
  const d = new Date(`${hoje}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

// ---------- 1. o site público ----------
console.log('== site público ==');
const site = await pagina(390, 844, 'site celular');
await irQuieto(site, `${B}/hospedar.html`);
await site.waitForFunction(() => /20%/.test(document.getElementById('hospPercentual')?.textContent || ''));
check('o percentual vem do servidor (20%)', true);
check('o exemplo do benefício aparece', /30 h de operação geram 6 h/.test(await site.locator('#hospExemplo').innerText()));
const rolagem = await site.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('celular: sem rolagem lateral', !rolagem);
const emailTab = `tabacaria-${marca}@teste.com`;
const TAB = await cadastrar('Tabacaria Central', '52998224725', emailTab);
await site.fill('#empresa', 'Tabacaria Central');
await site.fill('#responsavel', 'Joana');
await site.fill('#contato_telefone', '(16) 99876-5432');
await site.fill('#h_cep', '15990-000');
await site.fill('#h_logradouro', 'Rua Sete');
await site.fill('#h_numero', '70');
await site.fill('#h_bairro', 'Centro');
await site.fill('#h_cidade', 'Matão');
await site.fill('#h_uf', 'SP');
await site.fill('#segmento', 'tabacaria');
await site.screenshot({ path: `${SAIDA}47-hospedar-celular.png`, fullPage: true });
await site.click('#formHospedar button[type="submit"]');
await site.waitForFunction(() => /Recebemos seu interesse/.test(document.getElementById('msg')?.textContent || ''));
const INTERESSE = PG(`SELECT id FROM hospedagem_interesses WHERE contato_telefone = '16998765432' ORDER BY id DESC LIMIT 1`);
check('interesse gravado', Boolean(INTERESSE));
check('interesse não reserva nada', PG('SELECT COUNT(*) FROM pontos_moveis_hospedagens') === '0');
// O interesse do visitante não tem conta: o Admin liga à conta da tabacaria.
PG(`UPDATE hospedagem_interesses SET conta_id = ${TAB} WHERE id = ${INTERESSE}`);

// ---------- 2. Admin: móvel, percentual, interesse → hospedagem ----------
console.log('== Admin ==');
const admin = await pagina(1400, 960, 'admin');
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
await admin.evaluate(() => {
  location.hash = 'rede/moveis';
});
await admin.waitForSelector('[data-beneficio-hospedagem]');
await admin.click('[data-criar-movel]');
await admin.waitForSelector('#formCriarMovel');
await admin.fill('#cmBase', 'Depósito Mostraí');
await admin.fill('#cm_cep', '15990-000');
await admin.fill('#cm_logradouro', 'Rua do Depósito');
await admin.fill('#cm_numero', '1');
await admin.fill('#cm_bairro', 'Distrito');
await admin.fill('#cm_cidade', 'Matão');
await admin.fill('#cm_uf', 'SP');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForSelector('.movel-card', { timeout: 10000 });
const PONTO = PG(`SELECT id FROM pontos WHERE tipo = 'movel' ORDER BY id DESC LIMIT 1`);
const NOME = PG(`SELECT nome FROM pontos WHERE id = ${PONTO}`);
check('móvel criado sem conta de base', PG(`SELECT COALESCE(base_conta_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo');
// A tela opera 24 h (sem horário) e está na rede.
PG(`UPDATE pontos SET horario_semanal = NULL WHERE id = ${PONTO}`);

// Percentual: o aviso e o exemplo mudam; volta para 20%.
await admin.click('[data-alterar-percentual]');
await admin.waitForSelector('#formPercentual');
check(
  'aviso: vale só para novas hospedagens',
  /apenas para novas hospedagens confirmadas/.test(await admin.locator('dialog[open]').innerText()),
);
await admin.fill('#novoPercentual', '25');
check('exemplo dinâmico', /Com 25%: 30 h de operação geram 7 h 30 min/.test(await admin.locator('[data-exemplo]').innerText()));
await admin.screenshot({ path: `${SAIDA}47-percentual.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /25%/.test(document.querySelector('[data-percentual-atual]')?.textContent || ''));
check('percentual alterado e auditado', PG('SELECT novo FROM hospedagem_percentual_historico ORDER BY id DESC LIMIT 1') === '25.00');
await admin.click('[data-alterar-percentual]');
await admin.fill('#novoPercentual', '20');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /20%/.test(document.querySelector('[data-percentual-atual]')?.textContent || ''));

// Agendar a partir do interesse.
await admin.waitForSelector(`[data-interesse-id="${INTERESSE}"]`);
await admin.click(`[data-interesse-acao="agendar"][data-interesse="${INTERESSE}"]`);
await admin.waitForSelector('#formHospedagem');
await admin.selectOption('#hoMovel', PONTO);
await admin.fill('#hoInicio', hojeMais(0));
await admin.fill('#hoFim', hojeMais(2));
check('revisão: "ficará vinculada a 20%"', /ficará vinculada a 20%/.test(await admin.locator('[data-revisao-percentual]').innerText()));
await admin.screenshot({ path: `${SAIDA}47-programar-hospedagem.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(
  (id) => /Agendada/.test(document.querySelector(`[data-interesse-id="${id}"]`)?.textContent || ''),
  INTERESSE,
);
const HOSP = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = ${PONTO}`);
check('hospedagem programada com 20% congelado', PG(`SELECT percentual FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`) === '20.00');

// Painel do anfitrião: programada.
const pTab = await entrarConta(emailTab);
await pTab.waitForSelector('#modHospedagem:not([hidden])', { timeout: 10000 });
check('painel: "Ponto Móvel programado" / Agendado', /Ponto Móvel programado[\s\S]*|Agendado/.test(await pTab.locator('#modHospedagem').innerText()));

// Sem o aceite do termo, o Admin não consegue iniciar.
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, PONTO);
await admin.waitForSelector('[data-hosp-acao="iniciar"]');
check('Admin: "Iniciar" travado sem aceite', await admin.locator('[data-hosp-acao="iniciar"]').isDisabled());
check('Admin: aviso de termo pendente', /Aguardando o anfitrião aceitar o termo/.test(await admin.locator('#pontoMovel').innerText()));

// O anfitrião lê e aceita o termo pelo painel.
await pTab.click('[data-hosp-termo]');
await pTab.waitForSelector('dialog.dlg-termo[open]');
const termoTexto = await pTab.locator('dialog.dlg-termo[open]').innerText();
check('termo: título e dados da hospedagem', /Termo de Hospedagem Temporária[\s\S]*Tabacaria Central[\s\S]*20%/.test(termoTexto), termoTexto.slice(0, 300));
check('termo: avisa que é minuta', /minuta/i.test(termoTexto));
await pTab.locator('dialog.dlg-termo[open]').screenshot({ path: `${SAIDA}47-termo.png` });
await pTab.click('dialog.dlg-termo[open] button[type="submit"]');
await pTab.waitForFunction(() => /nome|concord/i.test(document.querySelector('dialog.dlg-termo[open] [data-msg]')?.textContent || ''));
check('termo: sem nome/concordo não aceita', PG(`SELECT COUNT(*) FROM hospedagem_aceites WHERE hospedagem_id = ${HOSP}`) === '0');
await pTab.fill('#termoResponsavel', 'Joana Souza');
await pTab.check('dialog.dlg-termo[open] input[name="concordo"]');
await pTab.click('dialog.dlg-termo[open] button[type="submit"]');
await pTab.waitForFunction(() => !document.querySelector('dialog.dlg-termo[open]'));
await pTab.waitForFunction(() => /Termo de hospedagem aceito/.test(document.getElementById('modHospedagem')?.textContent || ''));
check('aceite gravado com versão, hash e IP', PG(`SELECT termo_versao || ':' || length(termo_hash) || ':' || (ip IS NOT NULL) FROM hospedagem_aceites WHERE hospedagem_id = ${HOSP}`) === 'minuta-1:64:true');

// Iniciar pela ficha, registrando a entrega do equipamento.
await recarregarQuieto(admin);
await admin.waitForSelector('[data-hosp-acao="iniciar"]:not([disabled])', { timeout: 10000 });
await admin.click('[data-hosp-acao="iniciar"]');
await admin.waitForSelector('#formAcaoHosp');
await admin.selectOption('#mvCond', 'com_avarias');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /observa/i.test(document.querySelector('dialog[open] [data-msg]')?.textContent || ''));
check('entrega: avaria sem observação é recusada', PG(`SELECT pontos_moveis_hospedagens.estado FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`) === 'programada');
await admin.fill('#mvObs', 'Risco leve na moldura');
await admin.screenshot({ path: `${SAIDA}47-entrega.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /Hospedado/.test(document.querySelector('[data-local-atual]')?.textContent || ''));
check('Admin: local atual = hospedado', true);
await admin.screenshot({ path: `${SAIDA}47-ficha-hospedado.png`, fullPage: true });

// Anunciante: "Agora em: Tabacaria Central", sem dados do anfitrião.
const emailAnun = `anun-${marca}@teste.com`;
const ANUN = await cadastrar('Loja Bem Vestir', '11144477735', emailAnun);
PG(`UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ANUN}`);
const pA = await entrarConta(emailAnun);
await pA.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`, { timeout: 10000 });
const cardTexto = await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`).innerText();
check('card: "Agora em: Tabacaria Central"', /Agora em: Tabacaria Central/.test(cardTexto), cardTexto);
check('card: sem percentual, saldo ou conta', !/%|saldo|hospedagem/i.test(cardTexto), cardTexto);
await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`).screenshot({ path: `${SAIDA}47-card-hospedado.png` });

// A tela operou 3 h desde que chegou.
PG(`UPDATE pontos_moveis_hospedagens SET iniciada_em = now() - interval '4 hours' WHERE id = ${HOSP}`);
const TELA = PG(`SELECT id FROM dispositivos WHERE ponto_id = ${PONTO} LIMIT 1`);
PG(`INSERT INTO tela_operacao (dispositivo_id, ponto_id, origem, inicio, fim) SELECT id, ponto_id, 'heartbeat', now() - interval '3 hours 30 minutes', now() - interval '30 minutes' FROM dispositivos WHERE id = ${TELA}`);
await recarregarQuieto(pTab);
await pTab.waitForSelector('#modHospedagem:not([hidden])');
let painel = await pTab.locator('#modHospedagem').innerText();
check('painel: em andamento com tempo e estimado', /Em andamento[\s\S]*3 h 00 min[\s\S]*20%[\s\S]*36 min/.test(painel), painel);
check('painel: "Valor estimado enquanto…"', /Valor estimado enquanto a hospedagem estiver em andamento/.test(painel));
await pTab.locator('#modHospedagem').screenshot({ path: `${SAIDA}47-painel-andamento.png` });

check('entrega registrada com avaria', PG(`SELECT condicao || ':' || (itens->>'tela') FROM hospedagem_movimentacoes WHERE hospedagem_id = ${HOSP} AND tipo = 'entrega'`) === 'com_avarias:true');

// Encerrar, registrando a retirada junto.
await admin.click('[data-hosp-acao="encerrar"]');
await admin.waitForSelector('#formAcaoHosp');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /Na base/.test(document.querySelector('[data-local-atual]')?.textContent || ''));
check('Admin: de volta à base', true);
check('benefício de 36 min no livro', PG(`SELECT segundos FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = ${HOSP}`) === '2160');
check('retirada registrada no encerramento', PG(`SELECT condicao FROM hospedagem_movimentacoes WHERE hospedagem_id = ${HOSP} AND tipo = 'retirada'`) === 'ok');
// A encerrada vai para o histórico (recolhido): lê o texto, aberto ou não.
const ficha = await admin.locator('#pontoMovel').textContent();
check('Admin: termo, entrega e retirada na ficha', /Termo aceito por Joana Souza[\s\S]*Entrega[\s\S]*com avarias[\s\S]*Retirada/.test(ficha), ficha);
await recarregarQuieto(pTab);
await pTab.waitForSelector('#modHospedagem:not([hidden])');
painel = await pTab.locator('#modHospedagem').innerText();
check('painel: SALDO DE HOSPEDAGEM com as horas', /Saldo de hospedagem[\s\S]*36 min[\s\S]*disponíveis/i.test(painel), painel);
check('painel: concluída com horas recebidas', /Concluída[\s\S]*Horas recebidas[\s\S]*36 min/.test(painel), painel);
check('painel: nunca chama de créditos', !/crédito/i.test(painel), painel);
check('painel: "Usar minhas horas"', (await pTab.locator('#modHospedagem [data-hosp-usar]').count()) > 0);
await pTab.locator('#modHospedagem').screenshot({ path: `${SAIDA}47-painel-saldo.png` });

// Sem plano, o painel não bloqueia (direito de veiculação ≠ plano).
check('painel sem "Escolha seu plano"', (await pTab.locator('#bloqueioPlano').count()) === 0);

// Ficha da conta no Admin.
await admin.evaluate((id) => {
  location.hash = `contas/contas/${id}`;
}, TAB);
await admin.waitForSelector('#contaHospedagem', { timeout: 10000 });
await admin.waitForFunction(() => /36 min/.test(document.querySelector('#contaHospedagem')?.textContent || ''));
check('Admin: saldo de hospedagem na ficha da conta', true);
await admin.locator('#contaHospedagem').screenshot({ path: `${SAIDA}47-admin-conta-saldo.png` });

check('sem erro de console/página', erros.length === 0, erros.join(' | '));
await navegador.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
