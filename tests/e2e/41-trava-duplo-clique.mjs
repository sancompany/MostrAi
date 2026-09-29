// Trava de duplo clique (config.js, finalização 28/09/2026), numa página
// sintética servida por rota do Playwright — não precisa do servidor.
// Cobre: ação com requisição lenta (3 cliques → 1 handler, classe em-voo
// enquanto pede, libera ao terminar), botão sem requisição não trava,
// cadeia POST → json → segunda requisição fica travada até o fim, submit de
// formulário desabilita e reabilita, e validação que devolve sem pedir nada
// não prende o botão. Uma requisição de fundo que nunca termina não segura
// botão nenhum (era o defeito da trava global).
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const cfg = readFileSync(new URL('../../public/config.js', import.meta.url), 'utf8');
const b = await chromium.launch({ executablePath: process.env.PW_CHROME });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('pageerror:', e.message));
p.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
await p.route('**/lento', async (r) => {
  await new Promise((x) => setTimeout(x, 800));
  r.fulfill({ status: 200, body: 'ok' });
});
await p.route('**/rapido', (r) => r.fulfill({ status: 200, body: 'ok' }));
await p.route('**/eterno', () => {});
const html = `<html><body>
<button id="a">acao</button><button id="b">abre-modal</button><button id="c">encadeado</button>
<form id="f"><button type="submit">enviar</button></form>
<button id="d" type="button">valida</button>
<script>window.API_BASE_URL='';</script>
<script>${cfg}</script>
<script>
window.n = {a:0,b:0,c:0,f:0,d:0};
fetch('/eterno'); // requisição de fundo que nunca termina (não é de botão nenhum)
document.getElementById('a').onclick = async () => { n.a++; await fetch('/lento'); };
document.getElementById('b').onclick = () => { n.b++; };
document.getElementById('c').onclick = async () => { n.c++; const r = await fetch('/rapido'); await r.text(); await fetch('/lento'); };
document.getElementById('f').onsubmit = async (e) => { e.preventDefault(); n.f++; await fetch('/lento'); };
document.getElementById('d').onclick = () => { n.d++; if (n.d < 3) return; fetch('/rapido'); };
</script></body></html>`;
await p.route('http://x.test/', (r) => r.fulfill({ contentType: 'text/html', body: html }));
await p.goto('http://x.test/');
const n = () => p.evaluate(() => window.n);
const cls = (id) => p.$eval(`#${id}`, (b) => b.className);
let ok = true;
const check = (t, c) => { console.log(c ? '  ok ' : '  FALHA', t); if (!c) ok = false; };

await p.click('#a'); await p.click('#a'); await p.click('#a');
check('ação com requisição lenta: 3 cliques, 1 handler', (await n()).a === 1);
check('botão marcado em-voo enquanto pede', (await cls('a')).includes('em-voo'));
await p.waitForTimeout(1100);
check('libera quando a requisição termina', !(await cls('a')).includes('em-voo'));
await p.click('#a'); check('e aceita clique de novo', (await n()).a === 2);

await p.click('#b'); await p.waitForTimeout(30); await p.click('#b');
check('botão sem requisição não trava', (await n()).b === 2);

await p.click('#c'); await p.waitForTimeout(200); await p.click('#c'); await p.waitForTimeout(200); await p.click('#c');
check('encadeado: segundo clique engolido entre a 1ª e a 2ª requisição', (await n()).c === 1);
await p.waitForTimeout(1200);
check('encadeado: libera no fim da cadeia', !(await cls('c')).includes('em-voo'));

await p.click('#f button'); await p.click('#f button', { timeout: 300 }).catch(() => {});
check('formulário: 1 submit', (await n()).f === 1);
check('formulário: botão disabled', await p.$eval('#f button', (b) => b.disabled));
await p.waitForTimeout(1100);
check('formulário: reabilita', !(await p.$eval('#f button', (b) => b.disabled)));

await p.click('#d'); await p.waitForTimeout(30); await p.click('#d'); await p.waitForTimeout(30); await p.click('#d');
check('validação que devolve sem pedir não trava', (await n()).d === 3);
await b.close();
console.log(ok ? 'tudo ok' : 'FALHOU');
process.exit(ok ? 0 : 1);
