// Gera os icones do site a partir do simbolo da Mostrai.
//
// DUAS ARTES, e a razao de existirem duas e a unica que importa num favicon:
// ele tem 16 pixels pra fazer o trabalho dele.
//
//   COMPLETA  — o simbolo inteiro (lampada + raios, nas tres copias preta,
//               azul e laranja), dentro do disco branco com contorno preto.
//               Usada de 180px pra cima: icone de celular, PWA, atalho.
//   COMPACTA  — so a LAMPADA, com o traco engrossado, no mesmo disco. Usada
//               a 16 e 32px, que e a aba do navegador.
//
// Por que a compacta existe: o desenho completo tem traco fino e tres copias
// DESLOCADAS entre si. A 16px cada traco da meio pixel e as tres copias se
// fundem — o resultado e um borrao cinza, que foi exatamente a reclamacao do
// dono em 17/09/2026 ("o antigo fica totalmente apagado, quase nao da pra ver
// ele na aba"). Medido lado a lado antes de decidir, nao suposto.
//
// A compacta NAO e um desenho novo: e o mesmo path da lampada (o #0 do
// simbolo, medido — os outros nove sao os raios), com `stroke` na cor do
// `fill`. O traco engorda a linha original pra fora e pra dentro. Peso 550
// saiu de uma varredura: abaixo de ~400 ela some, acima de ~1000 a base vira
// blob e deixa de parecer lampada.
//
// E o SVG NAO entra como <link rel="icon">, de proposito. O Chrome prefere o
// SVG quando ele existe e o reduz sozinho pra 16px — o que traria a arte
// completa de volta pra aba e desfaria todo este trabalho. Os icones de aba
// sao PNG com `sizes` declarado, que e como o navegador escolhe por tamanho.
import fs from 'node:fs';
import { chromium } from 'playwright';

const RAIZ = 'public/img';
const fonte = fs.readFileSync(`${RAIZ}/simbolo-lampada.svg`, 'utf8');
const defs = fonte.match(/<defs>[\s\S]*?<\/defs>/)[0];
const lampada = [...defs.matchAll(/<path d="([\s\S]*?)"\/>/g)].map((m) => m[1])[0];

const LADO = 512;
const C = LADO / 2;
const RAIO = 250;
const TRACO_DISCO = 4;
const INTERNO = 2 * RAIO - TRACO_DISCO;
const PESO_COMPACTA = 550;

const disco = `<circle cx="${C}" cy="${C}" r="${RAIO}" fill="#ffffff" stroke="#14171f" stroke-width="${TRACO_DISCO}"/>`;
const cabecalho = (titulo) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LADO} ${LADO}" width="${LADO}" height="${LADO}" role="img" aria-label="Mostraí"><title>${titulo}</title>`;

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await (await nav.newContext({ viewport: { width: 1100, height: 800 } })).newPage();

// Enquadra pela CAIXA DE TINTA medida no navegador, nunca pelo viewBox: a
// tinta do simbolo nao esta centrada no quadro de origem (o centro dela cai
// 25 unidades acima), entao centrar pelo quadro deixa o desenho subido.
async function enquadrar(svg, ocupacao) {
  await pg.setContent(`<html><body style="margin:0">${svg}</body></html>`);
  await pg.waitForTimeout(110);
  const t = await pg.evaluate(() => {
    const b = document.querySelector('#alvo').getBBox();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });
  const esc = (INTERNO * ocupacao) / Math.max(t.w, t.h);
  return svg.replace(
    '<g id="alvo">',
    `<g id="alvo" transform="translate(${(C - (t.x + t.w / 2) * esc).toFixed(2)} ${(C - (t.y + t.h / 2) * esc).toFixed(2)}) scale(${esc.toFixed(5)})">`,
  );
}

const completa = await enquadrar(
  `${cabecalho('Mostraí')}
  ${disco}
  <g id="alvo">
    <use href="#simbolo-lampada" transform="translate(-30 -21) scale(1.03)" fill="#ff7a1a"/>
    <use href="#simbolo-lampada" transform="translate(0 -18)" fill="#1d4ed8"/>
    <use href="#simbolo-lampada" fill="#14171f"/>
  </g>
  ${defs}
</svg>`,
  0.92,
);

const compacta = await enquadrar(
  `${cabecalho('Mostraí')}
  ${disco}
  <g id="alvo"><g transform="translate(0,2000) scale(0.1,-0.1)">
    <path d="${lampada}" fill="#14171f" stroke="#14171f" stroke-width="${PESO_COMPACTA}" stroke-linejoin="round" stroke-linecap="round"/>
  </g></g>
</svg>`,
  0.94,
);

fs.writeFileSync(`${RAIZ}/favicon.svg`, `${completa}\n`);
fs.writeFileSync(`${RAIZ}/favicon-compacto.svg`, `${compacta}\n`);
console.log('favicon.svg (completa) e favicon-compacto.svg escritos');

const b64 = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;
async function png(svg, nome, px) {
  const ctx = await nav.newContext({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(`<html><body style="margin:0"><img src="${b64(svg)}" width="${px}" height="${px}"></body></html>`);
  await p.waitForTimeout(140);
  await p.screenshot({ path: `${RAIZ}/${nome}` });
  await ctx.close();
  console.log(`  ${nome} (${px}px)`);
}

for (const [nome, px] of [
  ['favicon-512.png', 512],
  ['favicon-192.png', 192],
  ['apple-touch-icon.png', 180],
])
  await png(completa, nome, px);
for (const [nome, px] of [
  ['favicon-32.png', 32],
  ['favicon-16.png', 16],
])
  await png(compacta, nome, px);

// Folha de prova: como fica NA ABA, que e o unico lugar que decide.
const antigo = fs.existsSync('/var/tmp/favicon-antigo.png')
  ? `data:image/png;base64,${fs.readFileSync('/var/tmp/favicon-antigo.png').toString('base64')}`
  : null;
const aba = (fundo, cor, rotulo) => `
  <div style="background:${fundo};color:${cor};padding:14px 18px;border-radius:10px;margin-bottom:12px">
    <div style="font:600 12px sans-serif;opacity:.65;margin-bottom:9px">${rotulo}</div>
    <div style="display:flex;gap:30px;align-items:center;font:13px sans-serif">
      ${antigo ? `<span style="display:flex;gap:7px;align-items:center"><img src="${antigo}" width="16" height="16">antigo</span>` : ''}
      <span style="display:flex;gap:7px;align-items:center"><img src="${b64(completa)}" width="16" height="16">completa</span>
      <span style="display:flex;gap:7px;align-items:center"><img src="${b64(compacta)}" width="16" height="16">COMPACTA (a que vai pra aba)</span>
    </div>
  </div>`;
await pg.setContent(`<html><body style="margin:0;padding:20px;background:#f2f3f5;font:13px sans-serif">
  <div style="font:700 15px sans-serif;margin-bottom:11px">Na aba, 16px real</div>
  ${aba('#ffffff', '#202124', 'Chrome tema claro')}
  ${aba('#35363a', '#e8eaed', 'Chrome tema escuro')}
  <div style="font:700 15px sans-serif;margin:20px 0 9px">Ampliado 8x</div>
  <div style="display:flex;gap:20px">
    ${[
      antigo ? ['antigo', antigo] : null,
      ['completa (180px+)', b64(completa)],
      ['COMPACTA (16/32px)', b64(compacta)],
    ]
      .filter(Boolean)
      .map(
        ([n, s]) =>
          `<div style="text-align:center"><img src="${s}" style="width:120px;height:120px;image-rendering:pixelated;border:1px solid #ddd;background:#fff"><div style="font:11px sans-serif;margin-top:5px">${n}</div></div>`,
      )
      .join('')}
  </div>
</body></html>`);
await pg.waitForTimeout(400);
await pg.screenshot({ path: '/var/tmp/shots/favicon-prova.png', fullPage: true });
await nav.close();
console.log('\nfolha de prova: /var/tmp/shots/favicon-prova.png');
