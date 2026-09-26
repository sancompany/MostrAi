// Estação da conta (26/09/2026): o painel se adapta ao estado real.
//   A — conta nova: onboarding + UM botão "Escolher meu plano"; sem créditos,
//       sem indicação, sem card de plano; "Quero ser um ponto" em pé.
//   B — anunciante compensado: créditos sim, indicação não.
//   C — ponto com saldo 0: créditos + indicação; Meus pontos sem convite.
//   D — ponto + benefício: plano "Benefício por créditos · Válido até".
// Troca crédito → crédito (aviso, manter, continuar) e crédito → pago (aviso
// na confirmação do plano; manter não muda nada). Desktop, tablet e celular
// (320/375/390) sem rolagem lateral; o convite de ponto nunca fica com uma
// palavra por linha. Nenhum pagamento real: /assinar só é chamado até o
// aviso (409), e "Manter plano atual" fecha antes do Checkout.
// Assume servidor na 3999 e o banco do .env.
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';
import { execSync } from 'node:child_process';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const falhas = [];
const erros = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) =>
  p.screenshot({ path: new URL(`./saida/conta-${n}.png`, import.meta.url).pathname, fullPage: true });

const senha = 'Senha123!';
const criadas = [];
async function novaConta(rotulo) {
  const email = `conta-${rotulo}-${Date.now()}@teste.com`;
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: `Teste Conta ${rotulo}`,
      cpf_cnpj: '52998224725',
      contato_email: email,
      contato_telefone: '16999998888',
      senha,
      aceitou_termos: true,
      endereco: 'Rua Teste, 123',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
    }),
  });
  if (!r.ok) throw new Error(`cadastro ${rotulo}: ${r.status}`);
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  criadas.push(id);
  return { id, email };
}
const creditar = (id, n) =>
  PG(`INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, observacao) VALUES (${id}, 'concessao_admin', ${n}, 'e2e')`);
const virarPonto = (id) =>
  PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato, anunciante_id) VALUES ('Padaria E2E', 'Rua Teste, 123', 'Matão', 'SP', '15990-000', 'outro', 'R', '16 9', ${id})`,
  );

async function entrar(conta, largura = 1366) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', conta.email);
  await p.fill('#senha', senha);
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForSelector('#modPontos:not([hidden])', { timeout: 10000 });
  await p.waitForTimeout(900);
  return { p, ctx };
}

// Palavras por linha de um elemento: nenhuma linha com uma palavra só num
// título de várias palavras (o defeito do card espremido).
async function linhasDoTitulo(p, seletor) {
  return p.$eval(seletor, (el) => {
    const altura = parseFloat(getComputedStyle(el).lineHeight) || 20;
    return Math.round(el.getBoundingClientRect().height / altura);
  });
}
const semRolagemLateral = (p) =>
  p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

// ---------------- A — conta nova ----------------
console.log('A — conta nova');
const A = await novaConta('a');
{
  const { p, ctx } = await entrar(A);
  await p.waitForSelector('#bloqueioPlano .onboarding-etapas', { timeout: 8000 });
  await shot(p, 'A-desktop');
  const bloco = await p.textContent('#bloqueioPlano');
  check('A: título "Comece sua primeira campanha"', /Comece sua primeira campanha/.test(bloco), bloco);
  check('A: sem "pra ver seus números"', !/ver seus números/.test(await p.textContent('body')));
  check('A: progresso 1 de 4', /1 de 4 — Escolha seu plano/.test(bloco));
  const ctas = await p.$$eval('a,button', (els) =>
    els.filter((e) => e.offsetParent && /Escolher (meu )?plano/.test(e.textContent)).map((e) => e.textContent.trim()),
  );
  check('A: um único CTA de plano na tela', ctas.length === 1, JSON.stringify(ctas));
  check('A: card de plano escondido', await p.isHidden('#modPlano'));
  check('A: nada de "Nenhum plano comercial"', !/Nenhum plano comercial/.test(await p.textContent('body')));
  check('A: créditos escondidos', await p.isHidden('#modCreditos'));
  check('A: indicação escondida', await p.isHidden('#modIndicacao'));
  check('A: chip de créditos ausente', !/Créditos/.test(await p.textContent('#resumoConta')));
  check('A: convite de ponto aparece', /Você também possui um comércio\?/.test(await p.textContent('#modPontos')));
  check('A: hero sem "dinheiro"', !/dinheiro/i.test(await p.textContent('#statusBanner')));
  check('A: hero com benefícios', /benefícios da sua conta/.test(await p.textContent('#statusBanner')));
  // Primeira dobra: o CTA aparece sem rolar.
  const cta = await p.$eval('#bloqueioPlano .onboarding-cta', (e) => e.getBoundingClientRect().bottom);
  check('A: CTA na primeira dobra (desktop)', cta < 900, String(cta));
  // Créditos/indicação nunca antes da ação principal.
  check('A: nenhum botão de indicação na tela', !(await p.$('text=Copiar link')));
  // Convite de ponto em pé.
  const btnPonto = await p.$eval('[data-acao="abrir-oportunidade"]', (e) => e.getBoundingClientRect().width);
  check('A: botão "Quero ser um ponto" com largura coerente', btnPonto >= 180, String(btnPonto));
  const linhas = await linhasDoTitulo(p, '.ponto-opportunity h3');
  check('A: título do convite em no máximo 2 linhas (desktop)', linhas <= 2, String(linhas));
  check('A: sem rolagem lateral (desktop)', await semRolagemLateral(p));
  await ctx.close();

  for (const largura of [320, 375, 390, 768]) {
    const { p: m, ctx: c } = await entrar(A, largura);
    await m.waitForSelector('#bloqueioPlano .onboarding-etapas', { timeout: 8000 });
    await shot(m, `A-${largura}`);
    check(`A ${largura}px: sem rolagem lateral`, await semRolagemLateral(m));
    const l = await linhasDoTitulo(m, '.ponto-opportunity h3');
    check(`A ${largura}px: convite sem uma palavra por linha`, l <= 3, String(l));
    const bb = await m.$eval('[data-acao="abrir-oportunidade"]', (e) => e.getBoundingClientRect());
    const card = await m.$eval('.ponto-opportunity', (e) => e.getBoundingClientRect());
    check(`A ${largura}px: botão do ponto abaixo do texto`, bb.top > card.top + 40, `${bb.top} ${card.top}`);
    const cm = await m.$eval('#bloqueioPlano .onboarding-cta', (e) => e.getBoundingClientRect());
    check(`A ${largura}px: CTA visível sem sair da tela`, cm.right <= largura + 1 && cm.width > 100, JSON.stringify(cm));
    await c.close();
  }
}

// ---------------- B — anunciante compensado ----------------
console.log('B — anunciante compensado');
const Bc = await novaConta('b');
creditar(Bc.id, 12);
{
  const { p, ctx } = await entrar(Bc);
  await p.waitForSelector('#modCreditos:not([hidden])', { timeout: 8000 });
  await shot(p, 'B-desktop');
  check('B: créditos aparecem', await p.isVisible('#modCreditos'));
  check('B: indicação NÃO aparece', await p.isHidden('#modIndicacao'));
  check('B: nada de link de indicação nos créditos', !/ref=PT-/.test(await p.textContent('#modCreditos')));
  check('B: texto neutro dos créditos', /participação na rede como ponto ou de compensações/.test(await p.textContent('#modCreditos')));
  check('B: saldo 12', (await p.textContent('#creditosSaldo')).trim() === '12');
  check('B: nada de "dinheiro" no painel', !/dinheiro|carteira|saque/i.test(await p.textContent('main')));
  await ctx.close();
}

// ---------------- C — ponto com saldo 0 ----------------
console.log('C — ponto, saldo 0');
const C = await novaConta('c');
virarPonto(C.id);
{
  const { p, ctx } = await entrar(C);
  await p.waitForSelector('#modIndicacao:not([hidden])', { timeout: 8000 });
  await shot(p, 'C-desktop');
  check('C: créditos aparecem com saldo 0', await p.isVisible('#modCreditos'));
  check('C: saldo 0', (await p.textContent('#creditosSaldo')).trim() === '0');
  check('C: indicação aparece', /ref=PT-/.test(await p.textContent('#modIndicacao')));
  check('C: indicação fora do card de créditos', !/ref=PT-/.test(await p.textContent('#modCreditos')));
  check('C: Meus pontos mostra o ponto, não convite', !/possui um comércio/.test(await p.textContent('#modPontos')));
  check('C: nome do ponto no card', /Padaria E2E/.test(await p.textContent('#modPontos')));
  await ctx.close();
  const { p: m, ctx: c } = await entrar(C, 375);
  await m.waitForSelector('#modIndicacao:not([hidden])', { timeout: 8000 });
  await shot(m, 'C-375');
  check('C 375px: sem rolagem lateral', await semRolagemLateral(m));
  await c.close();
}

// ---------------- D — ponto + benefício; troca crédito → crédito ----------------
console.log('D — ponto + benefício; crédito → crédito');
const D = await novaConta('d');
virarPonto(D.id);
creditar(D.id, 40);
{
  const { p, ctx } = await entrar(D);
  await p.waitForSelector('#creditosOpcoes button[data-tier="essencial"][data-meses="3"]', { timeout: 8000 });
  await p.click('#creditosOpcoes button[data-tier="essencial"][data-meses="3"]');
  await p.click('#btnConfirmarResgate');
  await p.waitForSelector('#modPlano:not([hidden])', { timeout: 8000 });
  await p.waitForTimeout(800);
  const plano = await p.textContent('#modPlano');
  check('D: plano como benefício temporário', /Benefício por créditos/.test(plano) && /Válido até/.test(plano), plano);
  check('D: sem linguagem de cobrança automática', /nada é cobrado automaticamente/.test(plano), plano);
  check('D: indicação continua', await p.isVisible('#modIndicacao'));
  await shot(p, 'D-beneficio');

  // Escolhe o Pro por créditos → aviso aparece
  await p.click('#creditosOpcoes button[data-tier="destaque"][data-meses="3"]');
  await p.waitForSelector('#dlgResgate[open] .aviso-troca', { timeout: 5000 });
  const aviso = await p.textContent('#dlgResgate');
  await shot(p, 'D-aviso-troca');
  check('troca: aviso de benefício ativo', /Você já possui um benefício ativo/.test(aviso), aviso);
  check('troca: mostra plano atual, validade e créditos gastos', /Essencial · Trimestral/.test(aviso) && /Válido até/.test(aviso) && /9 créditos/.test(aviso), aviso);
  check('troca: diz que não devolve', /não serão devolvidos/.test(aviso));
  check('troca: botões Manter / Continuar', (await p.textContent('#btnCancelarResgate')) === 'Manter plano atual' && (await p.textContent('#btnConfirmarResgate')) === 'Continuar com a troca');
  // Manter = nada muda
  await p.click('#btnCancelarResgate');
  await p.waitForTimeout(400);
  check('troca: manter não debita', PG(`SELECT COALESCE(SUM(quantidade),0) FROM creditos_ledger WHERE anunciante_id = ${D.id}`) === '31');
  check('troca: manter mantém o benefício', PG(`SELECT count(*) FROM planos_administrativos WHERE anunciante_id = ${D.id} AND status = 'ativo'`) === '1');
  // Continuar = troca uma vez
  await p.click('#creditosOpcoes button[data-tier="destaque"][data-meses="3"]');
  await p.waitForSelector('#dlgResgate[open]', { timeout: 5000 });
  await p.click('#btnConfirmarResgate');
  await p.waitForTimeout(1500);
  check('troca: saldo 31 − 21 = 10', PG(`SELECT COALESCE(SUM(quantidade),0) FROM creditos_ledger WHERE anunciante_id = ${D.id}`) === '10');
  check(
    'troca: Essencial encerrado (substituído), Pro ativo',
    PG(`SELECT string_agg(status || ':' || COALESCE(encerrado_motivo, '-'), ',' ORDER BY id) FROM planos_administrativos WHERE anunciante_id = ${D.id}`) ===
      'encerrado:substituido,ativo:-',
  );
  check('troca: nenhum estorno', PG(`SELECT count(*) FROM creditos_ledger WHERE anunciante_id = ${D.id} AND tipo = 'estorno_resgate'`) === '0');
  check('troca: card de plano mostra Pro', /Pro · Trimestral/.test(await p.textContent('#modPlano')));
  await ctx.close();

  // crédito → pago: o aviso na confirmação do plano; manter = nada muda.
  console.log('crédito → pago');
  const { p: q, ctx: c2 } = await entrar(D);
  await irQuieto(q, `${B}/anunciante/confirmar-plano.html?plano=maximo-1m`);
  await q.waitForTimeout(800);
  const botao = await q.$('button.btn.primary:not([disabled])');
  if (botao) await botao.click();
  const dlg = await q.waitForSelector('dialog[open]', { timeout: 8000 }).catch(() => null);
  if (dlg) {
    const t = await dlg.textContent();
    await shot(q, 'D-aviso-pago');
    check('pago: aviso de benefício ativo', /Você já possui um benefício ativo/.test(t), t);
    check('pago: plano, origem e créditos gastos', /Pro · Trimestral/.test(t) && /Benefício por créditos/.test(t) && /Créditos utilizados: 21/.test(t), t);
    check('pago: não devolve créditos', /não serão devolvidos/.test(t));
    await q.click('dialog[open] [data-voltar]');
    await q.waitForTimeout(500);
    check('pago: manter não muda o benefício', PG(`SELECT count(*) FROM planos_administrativos WHERE anunciante_id = ${D.id} AND status = 'ativo'`) === '1');
    check('pago: nenhuma assinatura criada', PG(`SELECT count(*) FROM assinaturas WHERE anunciante_id = ${D.id}`) === '0');
  } else {
    falha('pago: o diálogo de aviso não abriu');
  }
  await c2.close();
}

check('sem erro de console/página', erros.length === 0, erros.join(' | '));

// Limpeza completa: a conta D tem plano em vigor e entraria na playlist e
// nas métricas se ficasse (revisão Codex do PR #77) — apaga as contas também.
for (const id of criadas) {
  PG(`DELETE FROM notificacoes WHERE anunciante_id = ${id};
      DELETE FROM planos_administrativos WHERE anunciante_id = ${id};
      DELETE FROM creditos_ledger WHERE anunciante_id = ${id};
      DELETE FROM ciclos_contratados WHERE anunciante_id = ${id};
      DELETE FROM assinaturas WHERE anunciante_id = ${id};
      DELETE FROM eventos WHERE anunciante_id = ${id};
      DELETE FROM tokens_confirmacao_email WHERE anunciante_id = ${id};
      DELETE FROM cupons_ponto WHERE conta_id = ${id};
      DELETE FROM pontos WHERE anunciante_id = ${id};
      DELETE FROM anunciantes WHERE id = ${id}`);
}
await b.close();
console.log(falhas.length ? `\n${falhas.length} FALHA(S)` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
