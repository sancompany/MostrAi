// Gera os ícones do site a partir do símbolo da Mostraí.
//
// A ARTE É DO DONO e não é modificada aqui: `public/img/simbolo-mostrai.svg`
// já vem com o disco branco e o contorno preto que ele pediu. Este script só
// RECORTA e redimensiona.
//
// DUAS SAÍDAS, e a razão é a única que importa num favicon: ele tem 16 pixels
// pra fazer o trabalho dele.
//
//   COMPLETO  o símbolo inteiro, como o dono desenhou (lâmpada + raios dentro
//             do disco). Vai pra 180px+ — celular, PWA, atalho.
//   RECORTE   o MESMO desenho, com a moldura fechada em volta da lâmpada: os
//             raios ficam fora do quadro e a lâmpada ocupa o ícone todo. Vai
//             pra 16 e 32px, que é a aba do navegador.
//
// O recorte não é um desenho diferente: é o mesmo traço, o mesmo laranja, a
// mesma lâmpada — só enquadrada de perto. A alternativa era mandar o desenho
// inteiro pra aba, e aí os raios finos e o anel viram um cinza indistinto a
// 16px, que foi exatamente a reclamação que originou a troca do favicon
// ("o antigo fica totalmente apagado, quase não dá pra ver ele").
import fs from 'node:fs';
import { chromium } from 'playwright';

const RAIZ = 'public/img';
const FONTE = `${RAIZ}/simbolo-mostrai.svg`;
const completo = fs.readFileSync(FONTE, 'utf8');

// A janela do recorte, em coordenadas do viewBox do arquivo (0 0 1500 1500).
// Escolhida olhando seis janelas lado a lado, no tamanho de aba: mais fechada
// que esta corta a rosca da lâmpada; mais aberta traz os raios de volta e o
// ícone volta a embolar a 16px. Nesta, a lâmpada aparece inteira e os
// toquinhos de raio que sobram ficam simétricos em volta — assimetria, aqui,
// lê como defeito de recorte.
const RECORTE = { x: 350, y: 230, lado: 900 };
const LADO = 512;
const C = LADO / 2;

// O disco branco com contorno preto do tamanho de aba é redesenhado porque o
// recorte corta o disco original junto com os raios. Mesmas cores do arquivo
// do dono: branco no fundo, #14171f no traço.
function recortado() {
  const interno = completo
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '');
  const escala = (2 * 236) / RECORTE.lado;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${LADO} ${LADO}" width="${LADO}" height="${LADO}" role="img" aria-label="Mostraí">
  <title>Mostraí</title>
  <circle cx="${C}" cy="${C}" r="250" fill="#ffffff" stroke="#14171f" stroke-width="12"/>
  <g clip-path="url(#discoMostrai)">
    <clipPath id="discoMostrai"><circle cx="${C}" cy="${C}" r="244"/></clipPath>
    <g transform="translate(${C} ${C}) scale(${escala.toFixed(5)}) translate(${-(RECORTE.x + RECORTE.lado / 2)} ${-(RECORTE.y + RECORTE.lado / 2)})">
      ${interno}
    </g>
  </g>
</svg>`;
}

const compacto = recortado();
fs.writeFileSync(`${RAIZ}/favicon.svg`, `${completo.trim()}\n`);
fs.writeFileSync(`${RAIZ}/favicon-compacto.svg`, `${compacto}\n`);

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const b64 = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;

async function png(svg, nome, px) {
  const ctx = await nav.newContext({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(
    `<html><body style="margin:0;background:#fff"><img src="${b64(svg)}" width="${px}" height="${px}"></body></html>`,
  );
  await p.waitForTimeout(200);
  await p.screenshot({ path: `${RAIZ}/${nome}` });
  await ctx.close();
  console.log(`  ${nome} (${px}px)`);
}

for (const [nome, px] of [
  ['favicon-512.png', 512],
  ['favicon-192.png', 192],
  ['apple-touch-icon.png', 180],
])
  await png(completo, nome, px);
for (const [nome, px] of [
  ['favicon-32.png', 32],
  ['favicon-16.png', 16],
])
  await png(compacto, nome, px);

// Folha de prova: como fica NA ABA, que é o único lugar que decide.
const pg = await (await nav.newContext({ viewport: { width: 980, height: 420 } })).newPage();
const aba = (fundo, cor, rotulo) => `
  <div style="background:${fundo};color:${cor};padding:14px 18px;border-radius:10px;margin-bottom:12px">
    <div style="font:600 12px sans-serif;opacity:.65;margin-bottom:9px">${rotulo}</div>
    <div style="display:flex;gap:34px;align-items:center;font:13px sans-serif">
      <span style="display:flex;gap:7px;align-items:center"><img src="${b64(completo)}" width="16" height="16">desenho inteiro</span>
      <span style="display:flex;gap:7px;align-items:center"><img src="${b64(compacto)}" width="16" height="16">RECORTE (o que vai pra aba)</span>
    </div>
  </div>`;
await pg.setContent(`<html><body style="margin:0;padding:20px;background:#f2f3f5;font:13px sans-serif">
  <div style="font:700 15px sans-serif;margin-bottom:11px">Na aba, 16px real</div>
  ${aba('#ffffff', '#202124', 'Chrome tema claro')}
  ${aba('#35363a', '#e8eaed', 'Chrome tema escuro')}
  <div style="font:700 15px sans-serif;margin:20px 0 9px">Ampliado</div>
  <div style="display:flex;gap:22px">
    ${[
      ['inteiro — 180px+ (celular, PWA)', completo],
      ['recorte — 16/32px (aba)', compacto],
    ]
      .map(
        ([n, s]) =>
          `<div style="text-align:center"><img src="${b64(s)}" style="width:150px;height:150px;border:1px solid #ddd;background:#fff"><div style="font:11px sans-serif;margin-top:5px">${n}</div></div>`,
      )
      .join('')}
  </div>
</body></html>`);
await pg.waitForTimeout(500);
await pg.screenshot({ path: '/var/tmp/shots/favicon-prova.png', fullPage: true });
await nav.close();
console.log('\nfolha de prova: /var/tmp/shots/favicon-prova.png');
