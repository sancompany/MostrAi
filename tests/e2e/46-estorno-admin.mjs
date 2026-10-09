// Estorno pelo Admin (estação Pagamentos, 09/10/2026, ADR-046), pela tela:
//   duas contas pagas (webhook assinado `criada`, v2) — uma agora, outra há 8
//   dias → Admin → Financeiro → Cobranças: "Estornar pagamento" só aparece
//   dentro dos 7 dias; fora, só "Fora da janela de estorno pelo painel." →
//   modal com o aviso ESTORNO NÃO É CANCELAMENTO, motivo obrigatório e
//   confirmação explícita → pedido 'solicitado' (a assinatura continua
//   ativa) → webhook `cobranca_estornada` → "Estornada" / "Confirmado pela
//   Asaas" → o cliente vê a cobrança como estornada (sem poder pedir nada).
// Pré-condições: banco zerado (reset-db.sh) e servidor na 3999 (restart.sh).
import { execSync } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/46-', import.meta.url).pathname;
fs.mkdirSync(new URL('./saida/', import.meta.url).pathname, { recursive: true });
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
const check = (t, cond, d = '') => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : typeof d === 'string' ? d : JSON.stringify(d));
  if (!cond) falhas.push(t);
};
const esperar = async (fn, ms = 15000) => {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const marca = Date.now();
const PLANO = 'essencial-1m';

async function webhook(corpo) {
  const cru = JSON.stringify(corpo);
  const ts = String(Math.floor(Date.now() / 1000));
  const assinatura = `sha256=${createHmac('sha256', process.env.SAN_CHECKOUT_KEY).update(`${ts}.${cru}`).digest('hex')}`;
  const r = await fetch(`${B}/webhook/san-checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Checkout-Signature': assinatura, 'X-Checkout-Timestamp': ts },
    body: cru,
  });
  return r.status;
}

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME, args: ['--lang=pt-BR'] }));

// Conta + assinatura paga pelo caminho real (POST /assinar → webhook `criada`).
async function contaPaga(rotulo, ocorridoEm) {
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, locale: 'pt-BR' });
  const email = `e2e46-${rotulo}-${marca}@teste.dev`;
  const cad = await ctx.request.post(`${B}/anunciantes/cadastro`, {
    data: {
      nome_empresa: `Estorno ${rotulo} E2E`,
      cpf_cnpj: '52998224725',
      cep: '15990-000',
      logradouro: 'Avenida Habib Gabriel',
      numero: '1200',
      bairro: 'Centro',
      cidade: 'Matão',
      uf: 'SP',
      contato_email: email,
      contato_telefone: '(16) 99999-0046',
      senha: 'Senha@Forte1',
      aceitou_termos: true,
    },
  });
  check(`${rotulo}: cadastro`, cad.status() === 201, String(cad.status()));
  const id = PG(`WITH u AS (UPDATE anunciantes SET email_confirmado = true WHERE contato_email = '${email}' RETURNING id) SELECT id FROM u`);
  const assinar = await ctx.request.post(`${B}/anunciantes/${id}/assinar`, { data: { planoId: PLANO } });
  check(`${rotulo}: link do checkout`, assinar.status() === 200, String(assinar.status()));
  const ass = PG(`SELECT id FROM assinaturas WHERE anunciante_id = ${id} ORDER BY created_at DESC LIMIT 1`);
  const chargeId = `pay_e2e46_${rotulo}_${marca}`;
  const status = await webhook({
    versao: 2,
    tipo: 'assinatura',
    eventoId: `evt_${randomUUID()}`,
    ocorridoEm,
    evento: 'criada',
    planoId: ass,
    documento: '52998224725',
    chargeId,
    statusFinanceiro: 'confirmado',
    valor: 134.99,
  });
  check(`${rotulo}: webhook criada aceito`, status === 200, String(status));
  const cob = await esperar(() => PG(`SELECT id FROM cobrancas_confirmadas WHERE charge_id = '${chargeId}'`));
  check(`${rotulo}: cobrança registrada com o chargeId`, !!cob);
  return { ctx, id, ass, chargeId, cob };
}

console.log('== 1. duas cobranças: dentro e fora dos 7 dias ==');
const dentro = await contaPaga('dentro', new Date(Date.now() - 60_000).toISOString());
const fora = await contaPaga('fora', new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString());

console.log('== 2. Admin → Financeiro → Cobranças ==');
const ctxAdmin = await b.newContext({ viewport: { width: 1366, height: 900 }, locale: 'pt-BR' });
const admin = await ctxAdmin.newPage();
admin.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
admin.on('console', (m) => m.type() === 'error' && !/status of (401|404|409)/.test(m.text()) && erros.push(`console: ${m.text()}`));
admin.on('dialog', async (d) => {
  erros.push(`diálogo nativo: ${d.message()}`);
  await d.dismiss();
});
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');
await admin.evaluate(() => {
  location.hash = 'financeiro/cobrancas';
});
const linhaDentro = admin.locator(`tr[data-cobranca="${dentro.cob}"]`);
const linhaFora = admin.locator(`tr[data-cobranca="${fora.cob}"]`);
await linhaDentro.waitFor({ timeout: 15000 });
check('dentro da janela: "Estornar pagamento" aparece', (await linhaDentro.locator('[data-estornar]').count()) === 1);
check('dentro: prazo mostrado', /Até \d{2}\/\d{2}\/\d{4}/.test(await linhaDentro.innerText()), await linhaDentro.innerText());
check('fora da janela: o botão ordinário NÃO aparece', (await linhaFora.locator('[data-estornar]').count()) === 0);
check('fora: só a informação', (await linhaFora.innerText()).includes('Fora da janela de estorno pelo painel.'), await linhaFora.innerText());
check('estorno excepcional fica separado (fora das linhas)', (await admin.locator('[data-estorno-excepcional]').count()) === 1);
await admin.screenshot({ path: `${SAIDA}1-cobrancas.png`, fullPage: true });

console.log('== 3. modal: aviso, motivo obrigatório, confirmação explícita ==');
await linhaDentro.locator('[data-estornar]').click();
const modal = admin.locator('dialog.modal-admin');
await modal.waitFor();
const textoModal = await modal.innerText();
check('modal diz que ESTORNO NÃO É CANCELAMENTO', textoModal.includes('ESTORNO NÃO É CANCELAMENTO'));
check('modal diz que a assinatura não será cancelada', /não\s+será cancelada automaticamente/.test(textoModal));
check('modal mostra cliente, valor e plano', /Estorno dentro E2E/.test(textoModal) && /134,99/.test(textoModal));
const registrar = modal.locator('button[type="submit"]');
check('sem marcar "Entendi", não registra', await registrar.isDisabled());
await modal.locator('[data-entendi]').check();
await registrar.click();
await admin.waitForTimeout(400);
check('sem motivo, não registra', PG(`SELECT count(*) FROM estornos WHERE cobranca_id = ${dentro.cob}`) === '0');
await modal.locator('#estornoMotivo').fill('cliente pediu na primeira semana (e2e)');
await admin.screenshot({ path: `${SAIDA}2-modal.png` });
await registrar.click();
await esperar(() => PG(`SELECT status FROM estornos WHERE cobranca_id = ${dentro.cob}`) === 'solicitado');
check('pedido registrado como solicitado', PG(`SELECT status FROM estornos WHERE cobranca_id = ${dentro.cob}`) === 'solicitado');
check('a assinatura continua ativa (estorno não cancela)', PG(`SELECT status FROM assinaturas WHERE id = '${dentro.ass}'`) === 'ativa');
check('a cobrança continua paga até a Asaas confirmar', PG(`SELECT status_financeiro FROM cobrancas_confirmadas WHERE id = ${dentro.cob}`) === 'confirmado');
await linhaDentro.locator('text=Solicitado').first().waitFor({ timeout: 10000 });
check('linha mostra o pedido aguardando a Asaas', /Solicitado/.test(await linhaDentro.innerText()));

console.log('== 4. a Asaas confirma (webhook) ==');
const st = await webhook({
  versao: 2,
  tipo: 'assinatura',
  eventoId: `evt_${randomUUID()}`,
  ocorridoEm: new Date().toISOString(),
  evento: 'cobranca_estornada',
  planoId: dentro.ass,
  documento: '52998224725',
  chargeId: dentro.chargeId,
  statusFinanceiro: 'estornado',
  valor: 134.99,
  valorEstornado: 134.99,
  estornoParcial: false,
});
check('webhook cobranca_estornada aceito', st === 200, String(st));
check(
  'confirmado pelo PSP',
  !!(await esperar(() => PG(`SELECT status FROM estornos WHERE cobranca_id = ${dentro.cob}`) === 'confirmado')),
);
await admin.evaluate(() => {
  location.hash = 'financeiro/trocas';
});
await admin.waitForTimeout(500);
await admin.evaluate(() => {
  location.hash = 'financeiro/cobrancas';
});
await linhaDentro.waitFor({ timeout: 15000 });
await admin.waitForFunction((id) => /Estornada/.test(document.querySelector(`tr[data-cobranca="${id}"]`)?.innerText || ''), dentro.cob, {
  timeout: 15000,
});
const depois = await linhaDentro.innerText();
check('linha: Estornada + Confirmado pela Asaas', /Estornada/.test(depois) && /Confirmado pela Asaas/.test(depois), depois);
check('nenhuma ação de estorno sobra', (await linhaDentro.locator('[data-estornar]').count()) === 0);
check('assinatura segue ativa depois da confirmação', PG(`SELECT status FROM assinaturas WHERE id = '${dentro.ass}'`) === 'ativa');
await admin.screenshot({ path: `${SAIDA}3-estornada.png`, fullPage: true });

console.log('== 5. o cliente vê, não pede ==');
const fin = await (await dentro.ctx.request.get(`${B}/anunciantes/me/financeiro`)).json();
check('cliente: cobrança aparece como estornada', fin?.pagamentos?.cobrancas?.[0]?.situacao === 'estornado', fin?.pagamentos);
const painel = await dentro.ctx.newPage();
await irQuieto(painel, `${B}/anunciante/painel.html#modFinanceiro`);
await painel.waitForTimeout(1200);
const textoPainel = await painel.locator('body').innerText();
check('cliente: nenhuma ação de estorno no painel', !/Estornar/i.test(textoPainel));

console.log('== 6. desistência: vira devolução na fila, sem "Registrar" à mão ==');
// O POST /titular/arrependimento cancela no San Checkout de verdade; aqui o
// pedido nasce pelas MESMAS funções de domínio que a rota usa (sem rede).
const desiste = await contaPaga('desiste', new Date(Date.now() - 60_000).toISOString());
const fixture = `
  const pool = require('./src/db/pool');
  const repo = require('./src/titular/repository');
  const estornos = require('./src/financeiro/estornos');
  (async () => {
    const c = await pool.connect();
    await c.query('BEGIN');
    const p = await repo.registrarArrependimento({ anuncianteId: ${desiste.id}, assinaturaId: '${desiste.ass}',
      planoId: '${PLANO}', valor: 134.99, contratadoEm: new Date() }, c);
    await estornos.solicitarDevolucoesDaDesistencia(c, { anuncianteId: ${desiste.id}, arrependimentoId: p.id,
      motivo: 'desistência em 7 dias (CDC art. 49), pedido ' + p.id });
    await c.query('COMMIT');
    c.release();
    await pool.end();
  })();`;
execSync(`node -e "${fixture.replace(/\s*\n\s*/g, ' ')}"`);
check('desistência gerou um pedido de estorno', PG(`SELECT tipo || ':' || status FROM estornos WHERE cobranca_id = ${desiste.cob}`) === 'desistencia:solicitado');
await admin.evaluate(() => {
  location.hash = 'financeiro/devolucoes';
});
const filaDev = admin.locator('tr[data-linha]');
await filaDev.first().waitFor({ timeout: 15000 });
const textoFila = await filaDev.first().innerText();
check('Devoluções: a conta aparece com o pedido aguardando a Asaas', /Estorno desiste E2E/.test(textoFila) && /aguardando a Asaas/.test(textoFila), textoFila);
check('Devoluções: não há botão "Registrar"', (await admin.locator('main button', { hasText: /Registrar/ }).count()) === 0);
await admin.screenshot({ path: `${SAIDA}4-devolucoes.png`, fullPage: true });
await admin.evaluate(() => {
  location.hash = 'financeiro/cobrancas';
});
const linhaDesiste = admin.locator(`tr[data-cobranca="${desiste.cob}"]`);
await linhaDesiste.waitFor({ timeout: 15000 });
check('Cobranças: pedido da desistência não se cancela pelo Admin', (await linhaDesiste.locator('[data-cancelar-estorno]').count()) === 0);
const st2 = await webhook({
  versao: 2,
  tipo: 'assinatura',
  eventoId: `evt_${randomUUID()}`,
  ocorridoEm: new Date().toISOString(),
  evento: 'cobranca_estornada',
  planoId: desiste.ass,
  documento: '52998224725',
  chargeId: desiste.chargeId,
  statusFinanceiro: 'estornado',
  valor: 134.99,
  valorEstornado: 134.99,
  estornoParcial: false,
});
check('webhook da devolução aceito', st2 === 200, String(st2));
check(
  'a desistência fecha sozinha quando a Asaas confirma',
  !!(await esperar(() => PG(`SELECT status FROM arrependimentos WHERE anunciante_id = ${desiste.id}`) === 'estornado')),
);

check('sem erro de console nem diálogo nativo', erros.length === 0, erros.join(' | '));
await b.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
