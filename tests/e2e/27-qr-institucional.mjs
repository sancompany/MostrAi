// QR Code institucional (27/09/2026; desde o refino da Mídia Mostraí,
// 29/09/2026, mora na Visão geral — compacto, com [Gerenciar] abrindo os
// controles de sempre num modal): preview, link permanente copiado, destino
// trocado pela tela, o MESMO /q/anuncie seguido por um navegador de verdade
// até o destino novo, os três downloads lidos por um decodificador
// independente (jsqr), a Visão geral de pé mesmo com o bloco do QR falhando,
// e a Mídia Mostraí sem QR. Banco zerado, servidor na 3999:
//   tests/e2e/reset-db.sh && tests/e2e/restart.sh
//   set -a; . ./.env; set +a; PW_CHROME=... node tests/e2e/27-qr-institucional.mjs
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
import pngjs from 'pngjs';
import { chromium } from 'playwright';
import { acompanharRede, irQuieto } from './espera.mjs';

const B = 'http://localhost:3999';
const SAIDA = new URL('./saida/', import.meta.url).pathname;
const LINK = `${process.env.SITE_URL}/q/anuncie`;
const PG = (sql) =>
  execSync(`psql "${process.env.DATABASE_URL}" -tAc "${sql.replace(/"/g, '\\"')}"`)
    .toString()
    .trim();
const falhas = [];
const erros = [];
let fase = 'início';
const etapa = (t) => {
  fase = t;
  console.log(t);
};
const ok = (t) => console.log('  ok ', t);
const falha = (t, d) => {
  console.log('  FALHA', t, d || '');
  falhas.push(t);
};
const check = (t, cond, d) => (cond ? ok(t) : falha(t, d));

const lerPng = (bytes) => {
  const img = pngjs.PNG.sync.read(bytes);
  const codigo = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return { largura: img.width, conteudo: codigo?.data ?? null };
};

// Sem destino gravado: começa no padrão, como em produção antes do primeiro uso.
PG(`DELETE FROM configuracoes_site WHERE chave = 'qr_institucional'`);

const navegador = acompanharRede(await chromium.launch({ executablePath: process.env.PW_CHROME }));
const ctx = await navegador.newContext({
  viewport: { width: 1280, height: 900 },
  acceptDownloads: true,
  permissions: ['clipboard-read', 'clipboard-write'],
});
const p = await ctx.newPage();
let esperado500 = false;
p.on('pageerror', (e) => erros.push(`[${fase}] pageerror: ${e.message}`));
p.on('console', (m) => {
  if (m.type() !== 'error') return;
  if (fase === 'login' && /status of 401/.test(m.text())) return;
  // A falha simulada: o 500 e o registro do bloco que caiu sozinho.
  if (esperado500 && /status of 500|falha simulada/.test(m.text())) return;
  // A recusa do destino inválido é um 400 de propósito.
  if (fase === '== destino inválido ==' && /status of 400/.test(m.text())) return;
  erros.push(`[${fase}] console: ${m.text()}`);
});

etapa('login');
await irQuieto(p, `${B}/admin/index.html`);
await p.fill('#usuario', process.env.ADMIN_USER || 'admin');
await p.fill('#senha', process.env.ADMIN_PASSWORD || 'Admin12@teste');
await p.click('#formLogin button[type=submit]');
await p.waitForSelector('#conteudo .visao-geral-colunas');

// ---------------------------------------------------------------------------
etapa('== preview e link permanente ==');
await p.waitForSelector('#qrResumo [data-qr-resumo]');
check(
  'Visão geral: resumo mostra o destino atual',
  (await p.textContent('#qrResumo [data-qr-destino]')) === `${process.env.SITE_URL}/planos.html`,
  await p.textContent('#qrResumo [data-qr-destino]'),
);
await (await p.$('#qrResumo')).screenshot({ path: `${SAIDA}27-qr-visao-geral-resumo.png` });
await p.click('#qrResumo [data-gerenciar-qr]');
await p.waitForSelector('dialog [data-qr-controles] .qr-inst');
await p.waitForFunction(() => {
  const img = document.getElementById('qrInstPreview');
  return img?.complete && img.naturalWidth > 0;
});
check('preview do QR carregou', true);
check('link permanente na tela', (await p.inputValue('#qrLink')) === LINK, await p.inputValue('#qrLink'));
check('destino começa na página de planos', (await p.inputValue('#qrDestino')) === `${process.env.SITE_URL}/planos.html`);
check('diz que é o padrão', /Padrão: a página de planos/.test(await p.textContent('#qrQuando')));

// O preview é lido de volta pelos pixels: o que o admin vê é o que o celular lê.
const pixels = await p.evaluate(() => {
  const img = document.getElementById('qrInstPreview');
  const lado = 410; // 41 módulos × 10 px
  const c = document.createElement('canvas');
  c.width = lado;
  c.height = lado;
  const g = c.getContext('2d');
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, lado, lado);
  return Array.from(g.getImageData(0, 0, lado, lado).data);
});
const doPreview = jsQR(new Uint8ClampedArray(pixels), 410, 410);
check('o preview lê o link permanente', doPreview?.data === LINK, doPreview?.data);

await p.click('#btnCopiarQr');
await p.waitForSelector('#toast:not([hidden])');
check('copiar entrega o link permanente', (await p.evaluate(() => navigator.clipboard.readText())) === LINK);
check('toast de copiado', /Link copiado/.test(await p.textContent('#toast')));

await p.screenshot({ path: `${SAIDA}27-qr-institucional-padrao.png`, fullPage: true });

// ---------------------------------------------------------------------------
etapa('== trocar o destino ==');
const novo = `${process.env.SITE_URL}/pontos.html`;
await p.fill('#qrDestino', novo);
await p.click('#formQrDestino button[type=submit]');
await p.waitForFunction(() => /Destino salvo/.test(document.getElementById('toast')?.textContent || ''));
check('destino novo na tela', (await p.inputValue('#qrDestino')) === novo);
check('mostra quando e quem trocou', /Alterado em .+ por /.test(await p.textContent('#qrQuando')));
check('o resumo da Visão geral acompanha', (await p.textContent('#qrResumo [data-qr-destino]')) === novo);
check('o link permanente é o mesmo', (await p.inputValue('#qrLink')) === LINK);

const redir = await fetch(`${B}/q/anuncie`, { redirect: 'manual' });
check('/q/anuncie responde 302', redir.status === 302, String(redir.status));
check('302 aponta pro destino novo', redir.headers.get('location') === novo, redir.headers.get('location'));
check('302 nunca em cache', /no-store/.test(redir.headers.get('cache-control') || ''));

// Um navegador de verdade seguindo o link que está dentro do QR.
const leitor = await ctx.newPage();
await leitor.goto(`${B}/q/anuncie`);
check('o navegador chega no destino novo', leitor.url() === novo, leitor.url());
await leitor.close();

etapa('== destino inválido ==');
await p.fill('#qrDestino', 'javascript:alert(1)');
await p.click('#formQrDestino button[type=submit]');
await p.waitForFunction(() => document.getElementById('qrMsg')?.classList.contains('err'));
check('recusa com o motivo', /https?:\/\//.test(await p.textContent('#qrMsg')), await p.textContent('#qrMsg'));
const depois = await fetch(`${B}/q/anuncie`, { redirect: 'manual' });
check('o destino salvo continua o mesmo', depois.headers.get('location') === novo);

// ---------------------------------------------------------------------------
etapa('== downloads ==');
async function baixar(texto) {
  const [download] = await Promise.all([p.waitForEvent('download'), p.click(`dialog [data-qr-controles] a:text-is("${texto}")`)]);
  const caminho = `${SAIDA}${download.suggestedFilename()}`;
  await download.saveAs(caminho);
  return { nome: download.suggestedFilename(), bytes: readFileSync(caminho) };
}
const png = await baixar('Baixar PNG');
const lidoPng = lerPng(png.bytes);
check('PNG: nome do arquivo', png.nome === 'mostrai-qr-anuncie-1024px.png', png.nome);
check('PNG: 1024 px e lê o link permanente', lidoPng.largura === 1024 && lidoPng.conteudo === LINK, JSON.stringify(lidoPng));

const impressao = await baixar('Baixar PNG de impressão');
const lidoImpressao = lerPng(impressao.bytes);
check('PNG de impressão: nome', impressao.nome === 'mostrai-qr-anuncie-2048px.png', impressao.nome);
check(
  'PNG de impressão: 2048 px e lê o link',
  lidoImpressao.largura === 2048 && lidoImpressao.conteudo === LINK,
  JSON.stringify(lidoImpressao),
);

const svg = await baixar('Baixar SVG');
const textoSvg = svg.bytes.toString('utf8');
check('SVG: nome', svg.nome === 'mostrai-qr-anuncie.svg', svg.nome);
check('SVG: é um SVG', textoSvg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'));
const doPreviewSvg = await p.evaluate(async () => (await fetch('/admin/qr-institucional/svg')).text());
check('SVG baixado = o do preview (que foi lido acima)', textoSvg === doPreviewSvg);

etapa('== telas ==');
await (await p.$('dialog .modal-caixa')).screenshot({ path: `${SAIDA}27-qr-institucional-desktop.png` });
await p.setViewportSize({ width: 390, height: 844 });
await p.waitForTimeout(300);
const larguraSobra = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
check('celular: sem rolagem horizontal', larguraSobra <= 0, `sobra ${larguraSobra}px`);
await (await p.$('dialog .modal-caixa')).screenshot({ path: `${SAIDA}27-qr-institucional-celular.png` });
await p.click('dialog [data-fechar]');
await p.setViewportSize({ width: 1280, height: 900 });

// ---------------------------------------------------------------------------
etapa('== a Visão geral continua de pé ==');
// O bloco do QR falha sozinho: o resto da Visão geral não pode cair junto.
esperado500 = true;
await p.route('**/admin/qr-institucional', (rota) =>
  rota.fulfill({ status: 500, contentType: 'application/json', body: '{"erro":"falha simulada"}' }),
);
await p.click('#btnRecarregar');
await p.waitForSelector('#qrResumo [data-tentar-de-novo]', { timeout: 15000 });
check('QR com erro mostra [Tentar novamente]', true);
check('Pendências operacionais continua na tela', await p.isVisible('.pend-grade'));
check('Ocupação da rede continua na tela', await p.isVisible('#ocupacaoRede'));
await p.unroute('**/admin/qr-institucional');
await p.click('#qrResumo [data-tentar-de-novo]');
await p.waitForSelector('#qrResumo [data-qr-resumo]');
check('tentar de novo traz o QR sem recarregar a página', (await p.textContent('#qrResumo [data-qr-destino]')) === novo);
esperado500 = false;

etapa('== a Mídia Mostraí não tem mais QR nem capacidade ==');
await p.evaluate(() => {
  location.hash = 'midiamostrai';
});
await p.waitForSelector('[data-mm-vi]');
check('sem QR na Mídia Mostraí', !(await p.isVisible('text=QR Code institucional')) && !(await p.$('#qrLink')));
check('sem tabela de capacidade da rede', !(await p.isVisible('text=Capacidade da rede')));
check('Mídias próprias na tela', await p.isVisible('#btnNovaMidia'));

PG(`DELETE FROM configuracoes_site WHERE chave = 'qr_institucional'`);
check('sem erro de console ou de página', erros.length === 0, erros.join(' | '));
await navegador.close();
console.log(falhas.length ? `\nFALHAS: ${falhas.length}` : '\nTUDO OK');
process.exit(falhas.length ? 1 : 0);
