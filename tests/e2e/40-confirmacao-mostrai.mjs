// Confirmação Mostraí no painel (finalização, 28/09/2026): nenhuma ação de
// conta, plano ou criativo passa por confirm()/alert() nativo. Cada fluxo
// abre dialog.dlg-confirmar com TÍTULO → CONSEQUÊNCIA → Cancelar/Confirmar;
// cancelar não chama rota; confirmar trava os botões enquanto o pedido
// roda; erro fica escrito dentro do modal e o botão volta; sucesso fecha e
// a tela muda sem F5. Fluxos: apagar dados opcionais, desistir da
// contratação (rota interceptada — nunca chama o Checkout), cancelar
// assinatura (idem), sair, excluir conta. Celular sem rolagem lateral.
// Assume servidor na 3999 e o banco do .env.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const falhas = [];
const erros = [];
const nativos = [];
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));
const shot = (p, n) =>
  p.screenshot({ path: new URL(`./saida/confirmacao-${n}.png`, import.meta.url).pathname, fullPage: true });

const senha = 'Senha123!';
async function novaConta(rotulo) {
  const email = `confirma-${rotulo}-${Date.now()}@teste.com`;
  const r = await fetch(`${B}/anunciantes/cadastro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nome_empresa: `Teste Confirmação ${rotulo}`,
      cpf_cnpj: '52998224725',
      contato_email: email,
      contato_telefone: '16999998888',
      senha,
      aceitou_termos: true,
      endereco: 'Rua Teste, 123',
      cidade: 'Matão',
      uf: 'SP',
      cep: '15990000',
      responsavel_nome: 'Fulano Responsável',
      responsavel_contato: '16 99999-0000',
    }),
  });
  if (!r.ok) throw new Error(`cadastro ${rotulo}: ${r.status}`);
  const id = PG(`SELECT id FROM anunciantes WHERE contato_email = '${email}'`);
  PG(`UPDATE anunciantes SET email_confirmado = true WHERE id = ${id}`);
  return { id, email };
}

async function entrar(conta, largura = 1366) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409|500|502)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  // Qualquer diálogo nativo é regressão.
  p.on('dialog', (d) => {
    nativos.push(`${d.type()}: ${d.message().slice(0, 60)}`);
    d.dismiss().catch(() => {});
  });
  await irQuieto(p, `${B}/anunciante/login.html`);
  await p.fill('#email', conta.email);
  await p.fill('#senha', senha);
  await p.click('button[type="submit"]');
  await p.waitForURL(/painel\.html/, { timeout: 10000 });
  await p.waitForTimeout(900);
  return { p, ctx };
}

const MODAL = 'dialog.dlg-confirmar[open]';
// Abre o perfil e todos os blocos dobráveis dele ("Trocar e-mail", "Seus
// dados e seus direitos" — <details> que começam fechados).
const abrirPerfil = async (p) => {
  // No celular o avatar mora dentro do menu (hambúrguer), que abre e fecha
  // pelo mesmo botão — só clica se estiver fechado.
  const menu = await p.$('#btnMenu');
  if (menu && (await menu.isVisible()) && (await menu.getAttribute('aria-expanded')) !== 'true') {
    await menu.click();
    await p.waitForSelector('#btnPerfil', { state: 'visible', timeout: 5000 });
  }
  await p.click('#btnPerfil');
  await p.waitForSelector('#dlgPerfil[open]', { timeout: 5000 });
  await p.$$eval('#dlgPerfil details', (ds) => {
    for (const d of ds) d.open = true;
  });
};
const semRolagemLateral = (p) =>
  p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

// ---------------- conta com plano pago, cobrança de hoje ----------------
const conta = await novaConta('a');
PG(
  `UPDATE anunciantes SET plano_id = 'essencial-1m', data_inicio_cobertura = now(), data_expiracao = now() + interval '20 days' WHERE id = ${conta.id}`,
);
PG(`INSERT INTO assinaturas (id, anunciante_id, plano_id, status) VALUES ('${randomUUID()}', ${conta.id}, 'essencial-1m', 'ativa')`);
PG(`INSERT INTO cobrancas_confirmadas (anunciante_id, plano_id, valor) VALUES (${conta.id}, 'essencial-1m', 149)`);

const { p, ctx } = await entrar(conta);

console.log('== apagar dados opcionais: cancelar não chama rota ==');
await abrirPerfil(p);
let chamadas = 0;
p.on('request', (r) => {
  if (r.url().includes('/titular/consentimento') && r.method() === 'POST') chamadas += 1;
});
await p.click('#btnApagarOpcionais');
await p.waitForSelector(MODAL, { timeout: 5000 });
let texto = await p.textContent(MODAL);
check('modal com título e consequência', /Apagar os dados opcionais\?/.test(texto) && /Não dá pra desfazer/.test(texto), texto);
check('botão de confirmar em vermelho (perigo)', await p.$(`${MODAL} [data-confirmar].perigo`));
await shot(p, 'apagar-opcionais');
await p.click(`${MODAL} [data-fechar].btn`);
await p.waitForTimeout(300);
check('cancelar fecha o modal', !(await p.$(MODAL)));
check('cancelar não chamou a rota', chamadas === 0);
check('perfil continua aberto', await p.$('#dlgPerfil[open]'));

console.log('== apagar dados opcionais: confirmar roda o pedido e atualiza sem F5 ==');
await p.evaluate(() => {
  window.__semReload = true;
  window.addEventListener('beforeunload', () => {
    window.__semReload = false;
  });
});
await p.click('#btnApagarOpcionais');
await p.waitForSelector(MODAL, { timeout: 5000 });
await p.click(`${MODAL} [data-confirmar]`);
await p.waitForFunction(() => !document.querySelector('dialog.dlg-confirmar[open]'), null, { timeout: 8000 });
check('rota chamada uma vez', chamadas === 1, String(chamadas));
check('mensagem de sucesso na tela', /Dados opcionais apagados/.test(await p.textContent('#dlgPerfil')));
check(
  'responsável apagado no banco',
  PG(`SELECT coalesce(responsavel_nome,'') FROM anunciantes WHERE id = ${conta.id}`) === '',
);
check('sem reload', await p.evaluate(() => window.__semReload === true));

console.log('== desistir da contratação: erro do servidor fica dentro do modal ==');
await p.waitForSelector('#btnArrependimento:not([hidden])', { timeout: 5000 });
await p.route('**/titular/arrependimento', (rota) => {
  if (rota.request().method() !== 'POST') return rota.continue();
  rota.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ erro: 'estorno indisponível agora' }) });
});
await p.click('#btnArrependimento');
await p.waitForSelector(MODAL, { timeout: 5000 });
texto = await p.textContent(MODAL);
check('modal fala do valor e do anúncio saindo do ar', /R\$/.test(texto) && /sai do ar/.test(texto), texto);
await p.click(`${MODAL} [data-confirmar]`);
await p.waitForSelector(`${MODAL} [data-msg].err`, { timeout: 5000 });
check('erro escrito no modal, em português', /Estorno indisponível agora\./.test(await p.textContent(`${MODAL} [data-msg]`)));
check('modal continua aberto pra tentar de novo', await p.$(MODAL));
check('botão de confirmar liberado de novo', !(await p.$(`${MODAL} [data-confirmar][disabled]`)));
await shot(p, 'arrependimento-erro');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
check('Esc fecha depois do erro', !(await p.$(MODAL)));
check('pedido de desistência não foi criado', PG(`SELECT count(*) FROM arrependimentos WHERE anunciante_id = ${conta.id}`) === '0');
await p.unroute('**/titular/arrependimento');
await p.keyboard.press('Escape');

console.log('== cancelar assinatura: loading trava os botões; Checkout nunca é chamado ==');
let liberar;
await p.route('**/anunciantes/me/cancelar-assinatura', async (rota) => {
  await new Promise((r) => {
    liberar = r;
  });
  rota.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
});
await p.click('[data-acao="gerenciar-plano"]');
await p.waitForSelector('#dlgPlano[open]', { timeout: 5000 });
await p.click('#btnCancelarAssinatura');
await p.waitForSelector(MODAL, { timeout: 5000 });
texto = await p.textContent(MODAL);
check('consequência: período pago continua, sem devolução', /continua no ar/.test(texto) && /não devolve/.test(texto), texto);
check('botão de manter tem nome próprio', /Manter assinatura/.test(texto));
await p.click(`${MODAL} [data-confirmar]`);
await p.waitForSelector(`${MODAL} [data-confirmar][disabled]`, { timeout: 3000 });
check('em voo: botão travado e "Enviando…"', /Enviando/.test(await p.textContent(`${MODAL} [data-confirmar]`)));
check('em voo: cancelar também travado', await p.$(`${MODAL} [data-fechar].btn[disabled]`));
await p.keyboard.press('Escape');
await p.waitForTimeout(200);
check('em voo: Esc não fecha', await p.$(MODAL));
await shot(p, 'cancelar-loading');
liberar();
await p.waitForFunction(() => !document.querySelector('dialog.dlg-confirmar[open]'), null, { timeout: 8000 });
check('sucesso: modal fecha', true);
check('sucesso: mensagem no dialog do plano', /Assinatura cancelada/.test(await p.textContent('#dlgPlano')));
check('sucesso: botão de cancelar some', !(await p.$('#btnCancelarAssinatura')));
await p.unroute('**/anunciantes/me/cancelar-assinatura');
await p.keyboard.press('Escape');

console.log('== celular: modal cabe na tela ==');
await ctx.close();
{
  const { p: m, ctx: c2 } = await entrar(conta, 375);
  await abrirPerfil(m);
  await m.click('#btnApagarOpcionais');
  await m.waitForSelector(MODAL, { timeout: 5000 });
  check('celular: sem rolagem lateral com o modal aberto', await semRolagemLateral(m));
  const caixa = await m.$eval(MODAL, (el) => el.getBoundingClientRect().width);
  check('celular: modal mais estreito que a tela', caixa <= 375, String(caixa));
  await shot(m, 'celular');
  await m.keyboard.press('Escape');
  await m.keyboard.press('Escape');

  console.log('== sair: confirmação e volta pra home ==');
  await abrirPerfil(m);
  await m.click('#btnLogout');
  await m.waitForSelector(MODAL, { timeout: 5000 });
  await m.click(`${MODAL} [data-fechar].btn`);
  await m.waitForTimeout(200);
  check('sair: cancelar mantém a sessão', /painel\.html/.test(m.url()));
  await m.click('#btnLogout');
  await m.waitForSelector(MODAL, { timeout: 5000 });
  await m.click(`${MODAL} [data-confirmar]`);
  await m.waitForURL((u) => !/painel\.html/.test(u.toString()), { timeout: 8000 });
  check('sair: confirmar encerra a sessão', !/painel\.html/.test(m.url()), m.url());
  await c2.close();
}

console.log('== excluir conta: confirmação séria, conta fica recuperável ==');
{
  const outra = await novaConta('b');
  const { p: q, ctx: c3 } = await entrar(outra);
  await abrirPerfil(q);
  await q.click('#btnExcluirConta');
  await q.waitForSelector(MODAL, { timeout: 5000 });
  texto = await q.textContent(MODAL);
  check('excluir: fala dos 60 dias e do suporte', /60 dias/.test(texto) && /suporte/.test(texto), texto);
  check('excluir: botão nomeia a ação', /Excluir minha conta/.test(await q.textContent(`${MODAL} [data-confirmar]`)));
  await q.click(`${MODAL} [data-confirmar]`);
  await q.waitForURL((u) => !/painel\.html/.test(u.toString()), { timeout: 8000 });
  check('excluir: saiu do painel', !/painel\.html/.test(q.url()));
  check('excluir: conta marcada como excluída (recuperável)', PG(`SELECT excluido_em IS NOT NULL FROM anunciantes WHERE id = ${outra.id}`) === 't');
  await c3.close();
}

await b.close();
check('nenhum diálogo nativo do navegador', nativos.length === 0, nativos.join(' | '));
check('sem erro de console', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
