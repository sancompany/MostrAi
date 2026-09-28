// Admin → Mídia Mostraí: histórico e exclusão (finalização, 28/09/2026).
//   · a lista vem em grupos: "No ar e agendadas", "Pausadas", "Histórico —
//     retiradas do ar" (dobrado) e "Excluídas" (dobrado);
//   · Retirar do ar move o card pro histórico, sem F5; retirada não oferece
//     Retomar;
//   · Excluir abre o modal Mostraí com a consequência; cancelar não chama a
//     rota; confirmar move o card pra "Excluídas", sem ações, sem F5;
//   · o comprovante (exibições confirmadas) continua no card excluído;
//   · celular: sem rolagem lateral.
// Assume servidor na 3999 e o banco do .env.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const RAIZ = new URL('../../', import.meta.url).pathname;
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
  p.screenshot({ path: new URL(`./saida/midia-historico-${n}.png`, import.meta.url).pathname, fullPage: true });

// Três mídias direto pelo repositório (sem ffmpeg): uma ativa, uma pausada,
// uma já retirada.
const IMAGEM = `${B}/img/exemplo-ponto-completo-720.jpg`;
const ids = JSON.parse(
  execSync(
    `node -e "
    const a = require('./src/anunciantes/repository');
    const c = require('./src/anunciantes/criativos-repository');
    const m = require('./src/midias/repository');
    (async () => {
      const conta = await a.ensureContaMostrai();
      const out = {};
      for (const [chave, nome, situacao] of [['ativa','Hist ativa (e2e)','ativa'],['pausada','Hist pausada (e2e)','pausada'],['retirada','Hist retirada (e2e)','encerrada']]) {
        const cr = await c.criar({ anunciante_id: conta.id, arquivo_original_url: '${IMAGEM}', arquivo_normalizado_url: '${IMAGEM}', thumbnail_url: '${IMAGEM}', duracao_segundos: 10 });
        await c.atualizar(cr.id, { status: 'aprovado' });
        const midia = await m.criar({ criativoId: cr.id, nomeInterno: nome, frequenciaHora: 1, coberturaTipo: 'rede', pontosIds: [] });
        if (situacao !== 'ativa') await m.definirSituacao(midia.id, situacao);
        out[chave] = midia.id;
      }
      console.log(JSON.stringify(out));
      process.exit(0);
    })();"`,
    { cwd: RAIZ, env: process.env },
  )
    .toString()
    .trim()
    .split('\n')
    .pop(),
);
// Comprovante na ativa, pra provar que sobrevive à exclusão.
const tela = PG('SELECT id FROM dispositivos ORDER BY id LIMIT 1');
if (tela) {
  PG(
    `INSERT INTO midias_exibicoes_contador (midia_id, dispositivo_id, janela_hora, vezes_programadas, vezes_confirmadas) VALUES (${ids.ativa}, ${tela}, date_trunc('hour', now()), 3, 3) ON CONFLICT DO NOTHING`,
  );
}

async function admin(largura = 1366) {
  const ctx = await b.newContext({ viewport: { width: largura, height: 900 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => erros.push(`pageerror: ${e.message}`));
  p.on('console', (m) => {
    if (m.type() === 'error' && !/status of (401|404|409)/.test(m.text())) erros.push(`console: ${m.text()}`);
  });
  p.on('dialog', (d) => {
    falha('diálogo nativo do navegador', d.message());
    d.dismiss().catch(() => {});
  });
  await irQuieto(p, `${B}/admin/index.html`);
  await p.fill('#usuario', process.env.ADMIN_USER || 'admin');
  await p.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
  await p.click('#formLogin button[type=submit]');
  await p.waitForSelector('#conteudo .panel, #conteudo .visao-geral-colunas', { timeout: 15000 });
  await p.evaluate(() => {
    window.__semReload = true;
    window.addEventListener('beforeunload', () => {
      window.__semReload = false;
    });
    location.hash = 'midiamostrai';
  });
  await p.waitForSelector('[data-mm-grupo]', { timeout: 10000 });
  return { p, ctx };
}

const card = (p, id) => p.locator(`.mm-item[data-mm-id="${id}"]`);
const grupoDe = (p, id) => card(p, id).evaluate((el) => el.closest('[data-mm-grupo]')?.dataset.mmGrupo);

const { p, ctx } = await admin();
console.log('== grupos ==');
check('ativa em "No ar e agendadas"', (await grupoDe(p, ids.ativa)) === 'ar');
check('pausada em "Pausadas"', (await grupoDe(p, ids.pausada)) === 'pausadas');
check('retirada no histórico', (await grupoDe(p, ids.retirada)) === 'historico');
check('histórico nasce dobrado', !(await p.$eval('details[data-mm-grupo="historico"]', (d) => d.open)));
check('retirada não oferece Retomar', !(await card(p, ids.retirada).locator('[data-retomar-midia]').count()));
check('retirada oferece Excluir', (await card(p, ids.retirada).locator('[data-excluir-midia]').count()) === 1);
check('rótulo "Retirada do ar"', /Retirada do ar/.test(await card(p, ids.retirada).textContent()));
check('resumo conta o histórico', /no histórico/.test(await p.textContent('.mini-indicadores')));
await shot(p, 'grupos');

console.log('== retirar do ar move pro histórico, sem F5 ==');
await card(p, ids.pausada).locator('[data-encerrar-midia]').click();
await p.waitForSelector('dialog.modal-admin[open] [data-confirmar]');
check('modal explica que não volta', /não volta/.test(await p.textContent('dialog.modal-admin[open]')));
await p.click('dialog.modal-admin[open] [data-confirmar]');
await p.waitForFunction(
  (id) => document.querySelector(`.mm-item[data-mm-id="${id}"]`)?.closest('[data-mm-grupo]')?.dataset.mmGrupo === 'historico',
  ids.pausada,
  { timeout: 8000 },
);
check('pausada retirada foi pro histórico', (await grupoDe(p, ids.pausada)) === 'historico');

console.log('== excluir: cancelar não chama; confirmar move pra Excluídas ==');
let deletes = 0;
p.on('request', (r) => {
  if (r.method() === 'DELETE' && r.url().includes('/admin/midias-proprias/')) deletes += 1;
});
await card(p, ids.ativa).locator('[data-excluir-midia]').click();
await p.waitForSelector('dialog.modal-admin[open] [data-confirmar]');
const texto = await p.textContent('dialog.modal-admin[open]');
check('modal: título com o nome', /Excluir "Hist ativa \(e2e\)"/.test(texto), texto);
check('modal: consequência (sai das telas, comprovante fica, sem desfazer)', /próxima hora/.test(texto) && /comprovante/.test(texto) && /Não dá pra desfazer/.test(texto));
await shot(p, 'modal-excluir');
await p.click('dialog.modal-admin[open] [data-fechar].btn');
await p.waitForTimeout(300);
check('cancelar não chamou DELETE', deletes === 0);
check('cancelar: card continua no ar', (await grupoDe(p, ids.ativa)) === 'ar');
await card(p, ids.ativa).locator('[data-excluir-midia]').click();
await p.waitForSelector('dialog.modal-admin[open] [data-confirmar]');
await p.click('dialog.modal-admin[open] [data-confirmar]');
await p.waitForFunction(
  (id) => document.querySelector(`.mm-item[data-mm-id="${id}"]`)?.closest('[data-mm-grupo]')?.dataset.mmGrupo === 'excluidas',
  ids.ativa,
  { timeout: 8000 },
);
check('DELETE chamado uma vez', deletes === 1, String(deletes));
check('card foi pra "Excluídas"', (await grupoDe(p, ids.ativa)) === 'excluidas');
check('excluída sem nenhuma ação', (await card(p, ids.ativa).locator('button').count()) === 0);
check('rótulo "Excluída"', /Excluída/.test(await card(p, ids.ativa).textContent()));
if (tela) check('comprovante continua no card excluído', /3 exibições confirmadas/.test(await card(p, ids.ativa).textContent()), await card(p, ids.ativa).textContent());
check('banco: situacao excluida', PG(`SELECT situacao FROM midias_proprias WHERE id = ${ids.ativa}`) === 'excluida');
check('sem F5', await p.evaluate(() => window.__semReload === true));
await shot(p, 'excluida');
await ctx.close();

console.log('== celular ==');
{
  const { p: m, ctx: c2 } = await admin(390);
  check('celular: sem rolagem lateral', await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await m.$eval('details[data-mm-grupo="excluidas"]', (d) => {
    d.open = true;
  });
  await m.waitForTimeout(200);
  check('celular: histórico aberto sem rolagem lateral', await m.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await shot(m, 'celular');
  await c2.close();
}

await b.close();
check('sem erro de console', erros.length === 0, erros.join(' | '));
console.log(falhas.length ? `\n${falhas.length} falha(s)` : '\ntudo ok');
process.exit(falhas.length ? 1 : 0);
