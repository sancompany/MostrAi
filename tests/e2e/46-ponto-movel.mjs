// Ponto móvel (migrations 112 a 114; V1.1 de 05/10/2026 — o móvel NÃO tem
// base), de ponta a ponta no navegador:
//   · uma conta pede pra ser ponto: a aprovação NÃO oferece tipo — nasce fixo
//     (candidatura sempre gera fixo);
//   · o Admin cria o móvel em Rede › Pontos móveis só como EQUIPAMENTO (nome,
//     foto, nota): sem base, sem endereço, sem horário — "Sem alocação";
//   · a ficha do Admin mostra AGORA/PRÓXIMO; cadastrar evento pede início e
//     fim com data e hora e o horário de funcionamento (padrão 08:00–18:00);
//   · evento só programado não põe o móvel no inventário: o anunciante não o
//     vê na escolha de pontos;
//   · o evento inicia → "Em evento"; o anunciante vê o card "Ponto móvel"
//     (compacto, também no celular) com "Agora em" e o próximo evento, e
//     escolhe o PONTO;
//   · o evento encerra → "Sem alocação" (nunca "volta para a base"); quem já
//     tinha escolhido vê o aviso e pode desmarcar;
//   · a conta que pediu pra ser ponto vê só o próprio ponto fixo em
//     "Meus pontos" — o móvel não é de ninguém.
// Banco zerado, servidor na 3999 e o .env carregado:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/46-ponto-movel.mjs
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

// `permitir`: os status que o roteiro provoca de propósito naquela página.
async function pagina(largura, altura, rotulo, permitir = /status of (401|404)/) {
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

// ---------- 1. a conta pede pra ser ponto (candidatura genérica) ----------
console.log('== candidatura ==');
const emailDona = `academia-${marca}@teste.com`;
const DONA = await cadastrar('Academia Movimento LTDA', '52998224725', emailDona);
const pDona = await entrarConta(emailDona);
const pedido = await pDona.evaluate(async () => {
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
// 410: o PUT da base, provocado de propósito na ficha.
const admin = await pagina(1400, 960, 'admin', /status of (401|404|410)/);
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
check(
  'a aprovação não oferece tipo de ponto',
  (await admin.locator('dialog[open] input[name="tipo_ponto"]').count()) === 0,
);
await admin.screenshot({ path: `${SAIDA}46-movel-aprovacao.png` });
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => location.hash === '#rede/candidaturas');
const FIXO = PG(`SELECT id FROM pontos WHERE candidatura_id = ${CAND}`);
check(
  'a candidatura virou ponto FIXO da conta',
  PG(`SELECT tipo || ':' || anunciante_id FROM pontos WHERE id = ${FIXO}`) === `fixo:${DONA}`,
);

await admin.evaluate(() => {
  location.hash = 'rede/moveis';
});
await admin.waitForSelector('[data-beneficio-hospedagem]');
check(
  'card do benefício com o percentual real',
  /20%/.test(await admin.locator('[data-percentual-atual]').innerText()),
);
await admin.click('[data-criar-movel]');
await admin.waitForSelector('#formCriarMovel');
check(
  'criar móvel: só nome, foto e nota (sem base, conta, endereço ou horário)',
  JSON.stringify(await admin.$$eval('#formCriarMovel [name]', (els) => els.map((e) => e.name).sort())) ===
    '["foto","nome","observacoes"]',
);
await admin.fill('#cmNota', 'Totem com rodinhas');
await admin.screenshot({ path: `${SAIDA}46-movel-criar.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForSelector('.movel-card', { timeout: 10000 });
const PONTO = PG(`SELECT id FROM pontos WHERE tipo = 'movel' ORDER BY id DESC LIMIT 1`);
check('ponto criado', Boolean(PONTO));
check(
  'sem dono (é da Mostraí)',
  PG(`SELECT COALESCE(anunciante_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo',
);
check(
  'não vem de candidatura',
  PG(`SELECT COALESCE(candidatura_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo',
);
check(
  'sem base (migration 114)',
  PG(`SELECT COALESCE(base_conta_id::text, base_nome, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo',
);
check(
  'sem endereço próprio',
  PG(`SELECT COALESCE(endereco, cidade, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo',
);
check('a Tela 1 nasceu junto', PG(`SELECT COUNT(*) FROM dispositivos WHERE ponto_id = ${PONTO}`) === '1');
const NOME = PG(`SELECT nome FROM pontos WHERE id = ${PONTO}`);
check('nome de móvel', /^Mostraí Móvel #\d+$/.test(NOME), NOME);
const card = await admin.locator(`.movel-card[data-movel-id="${PONTO}"]`).innerText();
check(
  'card do Admin: "Sem alocação" e "Nenhum compromisso agendado"',
  /AGORA\s+Sem alocação[\s\S]*PRÓXIMO\s+Nenhum compromisso agendado/.test(card),
  card,
);

// ---------- 3. ficha do Admin: agora, próximo, sem base ----------
console.log('== ficha do móvel no Admin ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, PONTO);
await admin.waitForSelector('#pontoMovel [data-local-atual]');
check('agora: "Sem alocação"', /Sem alocação/.test(await admin.locator('[data-local-atual]').innerText()));
check(
  'próximo: "Nenhum compromisso agendado"',
  /Nenhum compromisso agendado/.test(await admin.locator('[data-proximo]').innerText()),
);
check('fora do inventário', /Inventário\s+Não/.test(await admin.locator('#pontoMovel').innerText()));
check('sem "Transformar" na ficha do móvel', !/Transformar/.test(await admin.locator('#pontoInformacoes').innerText()));
check('proprietário Mostraí', /Mostraí/.test(await admin.locator('#pontoInformacoes').innerText()));
check('sem bloco de endereço do ponto', (await admin.locator('#pontoEndereco').count()) === 0);
check('sem "base" na ficha', !/\bbase\b/i.test(await admin.locator('#pontoMovel').innerText()));
const base410 = await admin.evaluate(async (id) => {
  const r = await fetch(`/admin/pontos/${id}/base`, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  return r.status;
}, PONTO);
check('PUT /admin/pontos/:id/base → 410 (o móvel não tem base)', base410 === 410, String(base410));

// Cadastrar o evento pela tela: data e hora + horário de funcionamento.
await admin.click('[data-novo-evento]');
await admin.waitForSelector('#formEventoMovel');
check(
  'evento: início e fim com data e hora',
  (await admin.locator('#evInicio[type="datetime-local"], #evFim[type="datetime-local"]').count()) === 2,
);
check(
  'evento: horário 08:00–18:00 por padrão',
  (await admin.$$eval('#formEventoMovel .horario-editor-linha', (ls) =>
    ls.every(
      (l) =>
        l.querySelector('select').value === 'faixa' &&
        l.querySelector('[data-abre]').value === '08:00' &&
        l.querySelector('[data-fecha]').value === '18:00',
    ),
  )) === true,
);
await admin.fill('#evNome', 'Campeonato Regional de Jiu-Jitsu');
await admin.fill('#evOrg', 'Federação Regional');
await admin.fill('#evLocal', 'Ginásio Municipal');
await admin.fill('#evInicio', parede(HORA));
await admin.fill('#evFim', parede(DIA));
await admin.fill('#evPublico', '600');
// Domingo fechado: o horário é escolha do Admin, dia a dia.
await admin.selectOption('#formEventoMovel .horario-editor-linha[data-dia="dom"] select', 'fechado');
await admin.screenshot({ path: `${SAIDA}46-movel-form-evento.png` });
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() =>
  /Campeonato Regional/.test(document.querySelector('[data-proximo]')?.textContent || ''),
);
check('o próximo compromisso aparece na ficha', true);
const EVENTO = PG(`SELECT id FROM pontos_moveis_eventos WHERE ponto_id = ${PONTO}`);
check(
  'evento gravado com período e horário (domingo fechado)',
  PG(
    `SELECT concat_ws('|', estado, (fim > inicio), horario_operacao->'seg'->>'abre', COALESCE(horario_operacao->>'dom', 'fechado')) FROM pontos_moveis_eventos WHERE id = ${EVENTO}`,
  ) === 'programado|t|08:00|fechado',
);
check(
  'evento programado não aloca: ainda "Sem alocação"',
  /Sem alocação/.test(await admin.locator('[data-local-atual]').innerText()),
);
await admin.screenshot({ path: `${SAIDA}46-movel-ficha-admin.png`, fullPage: true });

// ---------- 4. o anunciante: fora da escolha enquanto não está alocado ----------
console.log('== anunciante: sem alocação, fora da escolha ==');
const emailAnunciante = `anunciante-${marca}@teste.com`;
const ANUNCIANTE = await cadastrar('Loja Bem Vestir', '11144477735', emailAnunciante);
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${ANUNCIANTE}`,
);
const pA = await entrarConta(emailAnunciante);
await pA.waitForSelector(`.ponto-escolha[data-ponto-id="${FIXO}"]`, { timeout: 10000 });
check('o fixo aparece na escolha', true);
check(
  'o móvel sem alocação (evento só programado) não aparece',
  (await pA.locator(`.ponto-escolha[data-ponto-id="${PONTO}"]`).count()) === 0,
);

// ---------- 5. o evento inicia: "Em evento" e o card do anunciante ----------
console.log('== evento em andamento ==');
await admin.click('[data-evento-acao="iniciar"]');
await admin.waitForSelector('dialog[open] [data-confirmar]');
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() =>
  /Em evento · Campeonato Regional/.test(document.querySelector('[data-local-atual]')?.textContent || ''),
);
check('Admin: agora "Em evento · Campeonato Regional de Jiu-Jitsu"', true);
check('Admin: no inventário', /Inventário\s+Sim — alocado/.test(await admin.locator('#pontoMovel').innerText()));
// Um segundo evento, depois deste: vira o "Próximo evento" do card.
await admin.click('[data-novo-evento]');
await admin.waitForSelector('#formEventoMovel');
await admin.fill('#evNome', 'Feira do Produtor');
await admin.fill('#evOrg', 'Prefeitura');
await admin.fill('#evLocal', 'Praça da Matriz');
await admin.fill('#evInicio', parede(3 * DIA));
await admin.fill('#evFim', parede(4 * DIA));
await admin.fill('#evPublico', '1200');
await admin.click('dialog[open] button[type="submit"]');
await admin.waitForFunction(() =>
  /Feira do Produtor/.test(document.querySelector('[data-proximo]')?.textContent || ''),
);
check('Admin: próximo = "Feira do Produtor"', true);

await recarregarQuieto(pA);
await pA.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`, { timeout: 10000 });
const cardA = pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`);
let texto = await cardA.innerText();
check('selo "Ponto móvel"', /Ponto móvel/.test(texto), texto);
check('nome do móvel', texto.includes(NOME), texto);
check(
  '"Agora em: Ginásio Municipal · Campeonato…"',
  /Agora em: Ginásio Municipal · Campeonato Regional de Jiu-Jitsu/.test(texto),
  texto,
);
check(
  'próximo evento com local e público estimado',
  /Próximo evento[\s\S]*Feira do Produtor[\s\S]*Praça da Matriz[\s\S]*~1\.200 pessoas/i.test(texto),
  texto,
);
check('sem ocupação/horário/base no card do móvel', !/vendido|Horário|base/i.test(texto), texto);
await cardA.scrollIntoViewIfNeeded();
await cardA.screenshot({ path: `${SAIDA}46-movel-card-desktop.png` });

// Escolher o PONTO (não o evento): a seleção grava o ponto.
await cardA.locator('input[type="checkbox"]').check();
await pA.waitForFunction(() => /Pronto/.test(document.getElementById('msgPontos')?.textContent || ''), null, {
  timeout: 8000,
});
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
  };
});
check('celular: card dentro da tela', medidas.cabe, JSON.stringify(medidas));
check('celular: sem rolagem lateral', !medidas.rolagem, JSON.stringify(medidas));
await cardM.screenshot({ path: `${SAIDA}46-movel-card-celular.png` });

// ---------- 6. o evento encerra: "Sem alocação" ----------
console.log('== sem alocação de novo ==');
await admin.click(`[data-evento-acao="encerrar"][data-evento="${EVENTO}"]`);
await admin.waitForSelector('dialog[open] [data-confirmar]');
check('confirmação: fica sem alocação', /sem alocação/i.test(await admin.locator('dialog[open]').innerText()));
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => /Sem alocação/.test(document.querySelector('[data-local-atual]')?.textContent || ''));
check('Admin: "Sem alocação" (nunca "Na base")', !/base/i.test(await admin.locator('[data-local-atual]').innerText()));
const fichaTexto = await admin.locator('#pontoMovel').innerText();
check(
  'Admin: o encerrado vai para "Eventos"',
  /Eventos[\s\S]*Campeonato Regional de Jiu-Jitsu[\s\S]*Encerrado/.test(fichaTexto),
  fichaTexto,
);
check(
  'Admin: a agenda continua com a feira',
  /Agenda[\s\S]*Feira do Produtor[\s\S]*Programado/.test(fichaTexto),
  fichaTexto,
);
await admin.screenshot({ path: `${SAIDA}46-movel-ficha-sem-alocacao.png`, fullPage: true });

await recarregarQuieto(pA);
await pA.waitForSelector(`.ponto-movel[data-ponto-id="${PONTO}"]`);
texto = await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"]`).innerText();
check(
  'quem já escolheu vê "Sem alocação no momento — volta a veicular…"',
  /Sem alocação no momento — volta a veicular quando for alocado/.test(texto),
  texto,
);
check('sem "Agora em"', !/Agora em/.test(texto), texto);
check(
  'continua marcado (pode desmarcar)',
  await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"] input`).isChecked(),
);
await pA
  .locator(`.ponto-movel[data-ponto-id="${PONTO}"]`)
  .screenshot({ path: `${SAIDA}46-movel-card-sem-alocacao.png` });
await pA.locator(`.ponto-movel[data-ponto-id="${PONTO}"] input`).uncheck();
await pA.waitForFunction(() => /Pronto/.test(document.getElementById('msgPontos')?.textContent || ''), null, {
  timeout: 8000,
});
check(
  'desmarcado: a escolha sai do banco',
  PG(`SELECT COUNT(*) FROM anunciantes_pontos WHERE anunciante_id = ${ANUNCIANTE} AND ponto_id = ${PONTO}`) === '0',
);
await recarregarQuieto(pA);
await pA.waitForSelector(`.ponto-escolha[data-ponto-id="${FIXO}"]`);
check(
  'desmarcado e sem alocação: o móvel some da escolha',
  (await pA.locator(`.ponto-escolha[data-ponto-id="${PONTO}"]`).count()) === 0,
);

// ---------- 7. a conta que virou ponto: só o próprio fixo ----------
console.log('== Meus pontos da conta-ponto ==');
await recarregarQuieto(pDona);
await pDona.waitForSelector('#modPontos:not([hidden]) #pontosLista > *', { timeout: 10000 });
const meus = await pDona.locator('#pontosLista').innerText();
check('Meus pontos: o próprio ponto fixo', /Academia Movimento/.test(meus), meus);
check(
  'Meus pontos: nada do móvel',
  !meus.includes(NOME) && (await pDona.locator('.estab-base-movel').count()) === 0,
  meus,
);
check(
  'o móvel continua sem dono',
  PG(`SELECT COALESCE(anunciante_id::text, 'nulo') FROM pontos WHERE id = ${PONTO}`) === 'nulo',
);
check(
  'nenhum Plano Básico nem crédito pelo móvel',
  PG(
    `SELECT (SELECT COUNT(*) FROM beneficios_basico_ponto WHERE ponto_id = ${PONTO}) + (SELECT COUNT(*) FROM creditos_ledger WHERE ponto_id = ${PONTO})`,
  ) === '0',
);

check('sem erro de console/página', erros.length === 0, erros.join(' | '));
await navegador.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
