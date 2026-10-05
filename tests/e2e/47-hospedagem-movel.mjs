// Hospedagem temporária de Ponto Móvel (migrations 113 e 114; V1.1 de
// 05/10/2026 — o móvel não tem base e o interesse é só de conta com direito
// ativo de veiculação), no navegador, de ponta a ponta:
//   · o site público mostra o percentual REAL (não escrito na página) e, para
//     o visitante, só o convite para entrar;
//   · a tabacaria (conta com plano) manda o interesse por /hospedar.html, no
//     endereço da conta;
//   · o Admin cria o móvel, muda o percentual (aviso de que só vale para
//     novas), volta para 20% e agenda a hospedagem a partir do interesse, com
//     início/fim em data e hora e o horário de funcionamento — revisão
//     "ficará vinculada a 20%";
//   · o anfitrião aceita o termo pelo painel (sem aceite o Admin não inicia);
//   · inicia (a tela chegou) registrando a entrega: o anunciante vê a opção
//     Mostraí Móvel (migration 115), sem local, conta, percentual nem saldo; o painel do
//     anfitrião mostra "Em andamento" com o benefício estimado;
//   · a tela opera; o Admin encerra (o móvel fica "Sem alocação"); o painel
//     mostra horas recebidas e o SALDO DE HOSPEDAGEM; sem plano, o saldo
//     sozinho mantém o painel e o direito; o Admin vê o saldo na ficha da conta.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/47-hospedagem-movel.mjs
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
const DIA = 24 * HORA;

async function cadastrar(nome, cpf, email) {
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: nome,
      cpf_cnpj: cpf,
      contato_email: email,
      contato_telefone: '16998765432',
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
const darPlano = (id) =>
  PG(
    `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${id}`,
  );

async function pagina(largura, altura, rotulo) {
  const ctx = await navegador.newContext({ viewport: { width: largura, height: altura } });
  await ctx.route(/google\.com\/maps|viacep/, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '{}' }));
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`[${rotulo}] pageerror: ${e.message}`));
  p.on('console', (m) => {
    // 400: as recusas de validação que o roteiro provoca de propósito (aceite
    // sem nome, entrega com avaria sem observação) — conferidas na tela.
    // 401: o visitante anônimo e a tela de login do Admin.
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
  // O painel assenta antes de o roteiro navegar (senão as buscas dele são
  // cortadas no meio e viram "Failed to fetch" no console).
  await redeQuieta(p);
  return p;
}

// ---------- 1. o site público ----------
console.log('== site público ==');
const site = await pagina(390, 844, 'site celular');
await irQuieto(site, `${B}/hospedar.html`);
await site.waitForFunction(() => /20%/.test(document.getElementById('hospPercentual')?.textContent || ''));
check(
  'o percentual vem do servidor (20%)',
  /20% do tempo de operação válido volta em horas de mídia/.test(await site.locator('#hospPercentual').innerText()),
);
check(
  'o exemplo do benefício aparece',
  /Com 20%: 30 h de operação válida geram 6 h de mídia/.test(await site.locator('#hospExemplo').innerText()),
);
check(
  'visitante: só o convite para entrar, sem formulário',
  /Entre na sua conta para pedir/.test(await site.locator('#hospedarConteudo').innerText()) &&
    (await site.locator('#formHospedar').count()) === 0,
);
check(
  'celular: sem rolagem lateral',
  await site.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
);
await site.screenshot({ path: `${SAIDA}47-hospedar-celular.png`, fullPage: true });

// ---------- 2. a tabacaria (com plano) manda o interesse ----------
console.log('== interesse da tabacaria ==');
const emailTab = `tabacaria-${marca}@teste.com`;
const TAB = await cadastrar('Tabacaria Central', '52998224725', emailTab);
darPlano(TAB);
const pTab = await entrarConta(emailTab);
await irQuieto(pTab, `${B}/hospedar.html`);
await pTab.waitForSelector('#formHospedar');
check(
  'formulário com os dados da conta',
  /Dados da conta[\s\S]*Tabacaria Central/i.test(await pTab.locator('#formHospedar').innerText()),
);
await pTab.fill('#hospObservacao', 'Balcão na entrada, tomada ao lado');
await pTab.click('#hospEnviar');
await pTab.waitForFunction(() =>
  /Interesse enviado/.test(document.getElementById('hospedarConteudo')?.textContent || ''),
);
const INTERESSE = PG(`SELECT id FROM hospedagem_interesses WHERE conta_id = ${TAB}`);
check(
  'interesse gravado no endereço da conta',
  PG(`SELECT local_tipo || ':' || origem FROM hospedagem_interesses WHERE id = ${INTERESSE}`) === 'conta:painel',
);
check(
  'interesse com o endereço do cadastro',
  /Rua Sete/.test(PG(`SELECT endereco FROM hospedagem_interesses WHERE id = ${INTERESSE}`)),
);
check('interesse não reserva nada', PG('SELECT COUNT(*) FROM pontos_moveis_hospedagens') === '0');

// ---------- 3. Admin: móvel, percentual, interesse → hospedagem ----------
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
await admin.fill('#cmNome', 'Móvel Centro');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForSelector('.movel-card', { timeout: 10000 });
const PONTO = PG(`SELECT id FROM pontos WHERE tipo = 'movel' ORDER BY id DESC LIMIT 1`);
check(
  'móvel criado com o nome dado, sem base',
  PG(`SELECT nome || ':' || COALESCE(base_conta_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) ===
    'Móvel Centro:nulo',
);

// Percentual: o aviso e o exemplo mudam; volta para 20%.
await admin.click('[data-alterar-percentual]');
await admin.waitForSelector('#formPercentual');
check(
  'aviso: vale só para novas hospedagens',
  /apenas para novas hospedagens confirmadas/.test(await admin.locator('dialog[open]').innerText()),
);
await admin.fill('#novoPercentual', '25');
check(
  'exemplo dinâmico',
  /Com 25%: 30 h de operação válida geram 7 h 30 min/.test(await admin.locator('[data-exemplo]').innerText()),
);
await admin.screenshot({ path: `${SAIDA}47-percentual.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /25%/.test(document.querySelector('[data-percentual-atual]')?.textContent || ''));
check(
  'percentual alterado e auditado',
  PG('SELECT novo FROM hospedagem_percentual_historico ORDER BY id DESC LIMIT 1') === '25.00',
);
await admin.click('[data-alterar-percentual]');
await admin.fill('#novoPercentual', '20');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /20%/.test(document.querySelector('[data-percentual-atual]')?.textContent || ''));

// Agendar a partir do interesse: data e hora + horário de funcionamento.
await admin.waitForSelector(`[data-interesse-id="${INTERESSE}"]`);
check(
  'interesse "Com direito"',
  /Com direito/.test(await admin.locator(`[data-interesse-id="${INTERESSE}"]`).innerText()),
);
await admin.click(`[data-interesse-acao="agendar"][data-interesse="${INTERESSE}"]`);
await admin.waitForSelector('#formHospedagem');
await admin.selectOption('#hoMovel', PONTO);
// Começou há 6 h (a tela já chegou), termina em 2 dias.
await admin.fill('#hoInicio', parede(-6 * HORA));
await admin.fill('#hoFim', parede(2 * DIA));
await admin.click('#formHospedagem [data-tudo-24h]');
check(
  'revisão: "ficará vinculada a 20%"',
  /ficará vinculada a 20%/.test(await admin.locator('[data-revisao-percentual]').innerText()),
);
await admin.screenshot({ path: `${SAIDA}47-programar-hospedagem.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(
  (id) => /Agendado/.test(document.querySelector(`[data-interesse-id="${id}"]`)?.textContent || ''),
  INTERESSE,
);
const HOSP = PG(`SELECT id FROM pontos_moveis_hospedagens WHERE ponto_id = ${PONTO}`);
check(
  'hospedagem programada com 20% congelado',
  PG(`SELECT percentual FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`) === '20.00',
);
check(
  'hospedagem no local "Tabacaria Central"',
  PG(`SELECT local FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`) === 'Tabacaria Central',
);

// Painel do anfitrião: programada.
await irQuieto(pTab, `${B}/anunciante/painel.html`);
await pTab.waitForSelector('#modHospedagem:not([hidden]) [data-hosp-termo]', { timeout: 10000 });
const programada = await pTab.locator('#modHospedagem').innerText();
check(
  'painel: "Ponto Móvel programado" / Agendado',
  /Agendado[\s\S]*Ponto Móvel programado/.test(programada),
  programada,
);
check('painel: o horário da hospedagem', /Horário:/.test(programada), programada);

// Sem o aceite do termo, o Admin não consegue iniciar.
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, PONTO);
await admin.waitForSelector('[data-hosp-acao="iniciar"]');
check('Admin: "Iniciar" travado sem aceite', await admin.locator('[data-hosp-acao="iniciar"]').isDisabled());
check(
  'Admin: aviso de termo pendente',
  /Aguardando o anfitrião aceitar o termo/.test(await admin.locator('#pontoMovel').innerText()),
);
check('Admin: ainda "Sem alocação"', /Sem alocação/.test(await admin.locator('[data-local-atual]').innerText()));

// O anfitrião lê e aceita o termo pelo painel.
await pTab.click('[data-hosp-termo]');
await pTab.waitForSelector('dialog.dlg-termo[open]');
const termoTexto = await pTab.locator('dialog.dlg-termo[open]').innerText();
check(
  'termo: título e dados da hospedagem',
  /Termo de Hospedagem Temporária[\s\S]*Tabacaria Central[\s\S]*Horário de funcionamento[\s\S]*20%/.test(termoTexto),
  termoTexto.slice(0, 300),
);
check('termo: avisa que é minuta', /minuta/i.test(termoTexto));
await pTab.locator('dialog.dlg-termo[open]').screenshot({ path: `${SAIDA}47-termo.png` });
await pTab.click('dialog.dlg-termo[open] button[type="submit"]');
await pTab.waitForFunction(() =>
  /nome|concord/i.test(document.querySelector('dialog.dlg-termo[open] [data-msg]')?.textContent || ''),
);
check(
  'termo: sem nome/concordo não aceita',
  PG(`SELECT COUNT(*) FROM hospedagem_aceites WHERE hospedagem_id = ${HOSP}`) === '0',
);
await pTab.fill('#termoResponsavel', 'Joana Souza');
await pTab.check('dialog.dlg-termo[open] input[name="concordo"]');
await pTab.click('dialog.dlg-termo[open] button[type="submit"]');
await pTab.waitForFunction(() => !document.querySelector('dialog.dlg-termo[open]'));
await pTab.waitForFunction(() =>
  /Termo de hospedagem aceito/.test(document.getElementById('modHospedagem')?.textContent || ''),
);
check(
  'aceite gravado com versão, hash, IP, período e horário',
  PG(
    `SELECT termo_versao || ':' || length(termo_hash) || ':' || (ip IS NOT NULL) || ':' || (inicio IS NOT NULL AND fim IS NOT NULL AND horario_operacao IS NOT NULL) FROM hospedagem_aceites WHERE hospedagem_id = ${HOSP}`,
  ) === 'minuta-2:64:true:true',
);

// Iniciar pela ficha, registrando a entrega do equipamento.
await recarregarQuieto(admin);
await admin.waitForSelector('[data-hosp-acao="iniciar"]:not([disabled])', { timeout: 10000 });
await admin.click('[data-hosp-acao="iniciar"]');
await admin.waitForSelector('#formAcaoHosp');
await admin.selectOption('#mvCond', 'com_avarias');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() =>
  /observa/i.test(document.querySelector('dialog[open] [data-msg]')?.textContent || ''),
);
check(
  'entrega: avaria sem observação é recusada',
  PG(`SELECT estado FROM pontos_moveis_hospedagens WHERE id = ${HOSP}`) === 'programada',
);
await admin.fill('#mvObs', 'Risco leve na moldura');
await admin.screenshot({ path: `${SAIDA}47-entrega.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() =>
  /Hospedado · Tabacaria Central/.test(document.querySelector('[data-local-atual]')?.textContent || ''),
);
check(
  'Admin: agora "Hospedado · Tabacaria Central até …"',
  /até \d\d\/\d\d \d\d:\d\d/.test(await admin.locator('[data-local-atual]').innerText()),
);
await admin.screenshot({ path: `${SAIDA}47-ficha-hospedado.png`, fullPage: true });

// Anunciante: a opção MOSTRAÍ MÓVEL (migration 115) — nunca o anfitrião, o
// local, o percentual ou a hospedagem.
const emailAnun = `anun-${marca}@teste.com`;
const ANUN = await cadastrar('Loja Bem Vestir', '11144477735', emailAnun);
darPlano(ANUN);
const pA = await entrarConta(emailAnun);
await pA.waitForSelector('[data-mostrai-movel]', { timeout: 10000 });
const cardTexto = await pA.locator('[data-mostrai-movel]').innerText();
check('card: "Mostraí Móvel" em operação agora', /Mostraí Móvel[\s\S]*em operação agora/.test(cardTexto), cardTexto);
check(
  'card: sem anfitrião, percentual, saldo ou hospedagem',
  !/Tabacaria|%|saldo|hospedagem/i.test(cardTexto),
  cardTexto,
);
await pA.locator('[data-mostrai-movel]').screenshot({ path: `${SAIDA}47-card-hospedado.png` });

// A tela operou 3 h desde que chegou (horário 24 h: tudo dentro).
PG(`UPDATE pontos_moveis_hospedagens SET iniciada_em = now() - interval '4 hours' WHERE id = ${HOSP}`);
const TELA = PG(`SELECT id FROM dispositivos WHERE ponto_id = ${PONTO} LIMIT 1`);
PG(
  `INSERT INTO tela_operacao (dispositivo_id, ponto_id, origem, inicio, fim) SELECT id, ponto_id, 'heartbeat', now() - interval '3 hours 30 minutes', now() - interval '30 minutes' FROM dispositivos WHERE id = ${TELA}`,
);
await recarregarQuieto(pTab);
await pTab.waitForSelector('#modHospedagem:not([hidden])');
let painel = await pTab.locator('#modHospedagem').innerText();
check(
  'painel: em andamento com tempo e estimado',
  /Em andamento[\s\S]*3 h 00 min[\s\S]*20%[\s\S]*36 min/.test(painel),
  painel,
);
check('painel: "Valor estimado enquanto…"', /Valor estimado enquanto a hospedagem estiver em andamento/.test(painel));
await pTab.locator('#modHospedagem').screenshot({ path: `${SAIDA}47-painel-andamento.png` });

check(
  'entrega registrada com avaria',
  PG(
    `SELECT condicao || ':' || (itens->>'tela') FROM hospedagem_movimentacoes WHERE hospedagem_id = ${HOSP} AND tipo = 'entrega'`,
  ) === 'com_avarias:true',
);

// Encerrar, registrando a retirada junto.
await admin.click('[data-hosp-acao="encerrar"]');
await admin.waitForSelector('#formAcaoHosp');
check('encerrar: retirada desmarcada por padrão', !(await admin.isChecked('#formAcaoHosp input[name="registrar"]')));
await admin.check('#formAcaoHosp input[name="registrar"]');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() => /Sem alocação/.test(document.querySelector('[data-local-atual]')?.textContent || ''));
check(
  'Admin: "Sem alocação" depois de encerrar (nunca "volta à base")',
  !/base/i.test(await admin.locator('[data-local-atual]').innerText()),
);
check(
  'benefício de 36 min no livro',
  PG(`SELECT segundos FROM saldo_hospedagem_lancamentos WHERE hospedagem_id = ${HOSP}`) === '2160',
);
check(
  'retirada registrada no encerramento',
  PG(`SELECT condicao FROM hospedagem_movimentacoes WHERE hospedagem_id = ${HOSP} AND tipo = 'retirada'`) === 'ok',
);
const ficha = await admin.locator('#pontoMovel').textContent();
check(
  'Admin: termo, entrega e retirada na ficha',
  /Termo aceito por Joana Souza[\s\S]*Entrega[\s\S]*com avarias[\s\S]*Retirada/.test(ficha),
  ficha,
);
await recarregarQuieto(pTab);
await pTab.waitForSelector('#modHospedagem:not([hidden])');
painel = await pTab.locator('#modHospedagem').innerText();
check(
  'painel: SALDO DE HOSPEDAGEM com as horas',
  /Saldo de hospedagem[\s\S]*36 min[\s\S]*disponíveis/i.test(painel),
  painel,
);
check('painel: concluída com horas recebidas', /Concluída[\s\S]*Horas recebidas[\s\S]*36 min/.test(painel), painel);
check('painel: nunca chama de créditos', !/crédito/i.test(painel), painel);
check('painel: "Usar minhas horas"', (await pTab.locator('#modHospedagem [data-hosp-usar]').count()) > 0);
await pTab.locator('#modHospedagem').screenshot({ path: `${SAIDA}47-painel-saldo.png` });

// Sem plano, o saldo sozinho segura o painel e o direito de veiculação
// (direito ≠ plano): nada de "Escolha seu plano", e a ação de hospedar segue.
PG(`UPDATE anunciantes SET plano_id = NULL, data_expiracao = NULL WHERE id = ${TAB}`);
await recarregarQuieto(pTab);
await pTab.waitForSelector('#modHospedagem:not([hidden])');
check('sem plano: painel sem "Escolha seu plano"', (await pTab.locator('#bloqueioPlano').count()) === 0);
const direito = await pTab.evaluate(
  async () => (await (await fetch('/anunciantes/me/hospedagem', { credentials: 'include' })).json()).elegivel,
);
check(
  'sem plano: o direito vem do saldo de hospedagem',
  direito.possui === true && direito.origem === 'saldo_hospedagem',
  JSON.stringify(direito),
);
await pTab.waitForSelector('#modPontos:not([hidden]) #pontosLista > *', { timeout: 10000 });
check(
  'sem plano: "Hospedar um Ponto Móvel" continua em Meus pontos',
  (await pTab.locator('#modPontos .ponto-movel-convite').count()) === 1,
);

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
