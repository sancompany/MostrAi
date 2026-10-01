// Excluir ponto no admin (01/10/2026) — mesma regra de "Excluir tela": ponto
// sem histórico sai com as telas (modal de confirmação → toast → volta pra
// Rede › Pontos); ponto com exibição confirmada recusa (409) com o motivo e
// fica. Assume banco zerado e servidor na 3999 (NODE_ENV=test).
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';
import { execSync } from 'node:child_process';

const B = 'http://localhost:3999';
const PG = (sql) =>
  execSync(`PGPASSWORD=mostrai psql -h localhost -U mostrai -d mostrai -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .split('\n')[0]
    .trim();
const SAIDA = new URL('./saida/', import.meta.url).pathname;

const b = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await b.newContext({ viewport: { width: 1400, height: 960 } });
const falhas = [];
const erros = [];
const check = (t, cond, d) => {
  console.log(cond ? '  ok ' : '  FALHA', t, cond ? '' : d || '');
  if (!cond) falhas.push(t);
};

const ponto = (nome) =>
  PG(
    `INSERT INTO pontos (nome, endereco, cidade, uf, cep, segmento, responsavel_nome, responsavel_contato)
     VALUES ('${nome}', 'Rua Curta, 1', 'Matão', 'SP', '15990000', 'padaria', 'Ana', '16999990001') RETURNING id`,
  );
const tela = (pontoId) =>
  PG(`INSERT INTO dispositivos (ponto_id, instalado_em, status) VALUES (${pontoId}, current_date, 'ativo') RETURNING id`);

const idLivre = ponto('Padaria Sem Histórico');
const telaLivre = tela(idLivre);
const idHistorico = ponto('Bar Com Histórico');
const telaHistorico = tela(idHistorico);
const conta = PG(
  `INSERT INTO anunciantes (nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash, aceitou_termos_em)
   VALUES ('Loja E2E', '11144477735', 'e2e-excluir-ponto@example.com', '16999990000', 'x', now()) RETURNING id`,
);
PG(
  `INSERT INTO exibicoes_contador (anunciante_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas)
   VALUES (${conta}, ${telaHistorico}, date_trunc('hour', now()) - interval '1 hour', 3, 2)`,
);

const admin = await ctx.newPage();
admin.on('pageerror', (e) => erros.push(e.message));
admin.on('console', (m) => {
  if (m.type() === 'error' && !/status of (401|409)/.test(m.text())) erros.push(m.text());
});
await irQuieto(admin, `${B}/admin/index.html`);
await admin.fill('#usuario', process.env.ADMIN_USER || 'admin');
await admin.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await admin.click('button[type=submit]');
await admin.waitForSelector('.admin-shell');

console.log('== ponto sem histórico ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, idLivre);
await admin.waitForSelector('[data-excluir-ponto]');
await admin.click('[data-excluir-ponto]');
await admin.waitForSelector('dialog[open] [data-confirmar]');
const textoModal = await admin.locator('dialog[open]').innerText();
check('modal diz que a tela sai junto', /junto com a tela dele/.test(textoModal), textoModal);
check('modal explica a saída (Inativas)', /deixe as telas dele Inativas/.test(textoModal), textoModal);
await admin.screenshot({ path: `${SAIDA}45-excluir-ponto-modal.png` });
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => location.hash === '#rede/pontos');
check('toast de sucesso', /Ponto Padaria Sem Histórico excluído/.test(await admin.locator('#toast').innerText()));
check('ponto saiu do banco', PG(`SELECT count(*) FROM pontos WHERE id = ${idLivre}`) === '0');
check('tela saiu junto', PG(`SELECT count(*) FROM dispositivos WHERE id = ${telaLivre}`) === '0');
await admin.waitForTimeout(400);
check('card sumiu da grade', !(await admin.locator('.ponto-card', { hasText: 'Padaria Sem Histórico' }).count()));

console.log('== ponto com histórico ==');
await admin.evaluate((id) => {
  location.hash = `rede/pontos/${id}`;
}, idHistorico);
await admin.waitForSelector('[data-excluir-ponto]');
await admin.click('[data-excluir-ponto]');
await admin.waitForSelector('dialog[open] [data-confirmar]');
await admin.click('dialog[open] [data-confirmar]');
await admin.waitForFunction(() => /histórico de exibições/.test(document.getElementById('toast')?.textContent || ''));
check('toast com o motivo do 409', true);
await admin.screenshot({ path: `${SAIDA}45-excluir-ponto-recusa.png` });
check('continua na ficha do ponto', (await admin.evaluate(() => location.hash)) === `#rede/pontos/${idHistorico}`);
check('ponto ficou no banco', PG(`SELECT count(*) FROM pontos WHERE id = ${idHistorico}`) === '1');

check('sem erro de console/página', erros.length === 0, erros.join(' | '));
await b.close();
if (falhas.length) {
  console.log(`\n${falhas.length} falha(s)`);
  process.exit(1);
}
console.log('\ntudo ok');
