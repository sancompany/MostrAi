// Monta o favicon novo: o simbolo da Mostrai dentro de um circulo branco com
// contorno preto, e rasteriza nos tamanhos que o site pede.
//
// O desenho NAO e redesenhado aqui: le o `simbolo-lampada.svg` que ja existe
// (tracado do dono, vetorizado por ele) e reaproveita os mesmos paths. Copiar
// o desenho a mao criaria uma segunda versao da marca pra manter em sincronia.
//
// E o enquadramento nao e chutado: o script MEDE a caixa de tinta do simbolo
// no proprio navegador antes de montar. Isso importa porque a tinta nao esta
// centrada no viewBox de origem — ela ocupa 95% da altura e o centro dela cai
// 25 unidades ACIMA do centro do quadro. Centrar pelo viewBox, que era o que
// eu estava fazendo, deixa o desenho subido dentro do circulo.
import fs from 'node:fs';
import { chromium } from 'playwright';

const RAIZ = '/home/user/MostrAi/public/img';
const fonte = fs.readFileSync(`${RAIZ}/simbolo-lampada.svg`, 'utf8');
const defs = fonte.match(/<defs>[\s\S]*?<\/defs>/)[0];

const LADO = 512;
const CENTRO = LADO / 2;
const RAIO = 250;
const TRACO = 4;
// Quanto do diametro interno a tinta ocupa. 0,92 deixa a ponta dos raios
// respirando dentro do traco em vez de encostar nele.
const OCUPACAO = 0.92;

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });

// 1. Mede a tinta de verdade.
const medidor = await (await nav.newContext()).newPage();
await medidor.setContent(`<html><body style="margin:0">${fonte}</body></html>`);
await medidor.waitForTimeout(200);
const tinta = await medidor.evaluate(() => {
  const svg = document.querySelector('svg');
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  for (const u of svg.querySelectorAll('use')) g.appendChild(u.cloneNode(true));
  svg.appendChild(g);
  const b = g.getBBox();
  g.remove();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
});
console.log(`tinta medida: ${tinta.w.toFixed(0)}x${tinta.h.toFixed(0)}, centro (${(tinta.x + tinta.w / 2).toFixed(0)}, ${(tinta.y + tinta.h / 2).toFixed(0)})`);

// 2. Escala pelo maior lado da TINTA, e posiciona pelo centro dela.
const interno = 2 * RAIO - TRACO;
const escala = (interno * OCUPACAO) / Math.max(tinta.w, tinta.h);
const tx = CENTRO - (tinta.x + tinta.w / 2) * escala;
const ty = CENTRO - (tinta.y + tinta.h / 2) * escala;
console.log(`escala ${escala.toFixed(5)} · tinta final ${(tinta.w * escala).toFixed(0)}x${(tinta.h * escala).toFixed(0)} num circulo de ${interno} de diametro interno`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LADO} ${LADO}" width="${LADO}" height="${LADO}" role="img" aria-label="Mostraí">
  <title>Mostraí</title>
  <!--
    Favicon: o simbolo da Mostrai (as tres copias — preta no lugar, azul
    deslocada pra cima, laranja um tico maior e mais pra baixo) dentro de um
    circulo BRANCO com contorno PRETO, como o dono pediu em 17/09/2026.

    O fundo branco e solido de proposito, nao transparente: a aba do navegador
    pode ser clara ou escura, e o simbolo tem partes pretas que somem no
    escuro. Com o disco branco, o icone e o mesmo nos dois temas.

    GERADO por scripts/favicon.mjs a partir de simbolo-lampada.svg — os paths sao os
    mesmos, e o enquadramento sai de uma medicao da caixa de tinta, nao de
    numero chutado. Mexeu no simbolo, rode o script de novo.
  -->
  ${defs}
  <circle cx="${CENTRO}" cy="${CENTRO}" r="${RAIO}" fill="#ffffff" stroke="#14171f" stroke-width="${TRACO}"/>
  <g transform="translate(${tx.toFixed(3)} ${ty.toFixed(3)}) scale(${escala.toFixed(6)})">
    <use href="#simbolo-lampada" transform="translate(-30 -21) scale(1.03)" fill="#ff7a1a"/>
    <use href="#simbolo-lampada" transform="translate(0 -18)" fill="#1d4ed8"/>
    <use href="#simbolo-lampada" fill="#14171f"/>
  </g>
</svg>
`;
fs.writeFileSync(`${RAIZ}/favicon.svg`, svg);
console.log(`\nfavicon.svg escrito (${(svg.length / 1024).toFixed(0)} KB)`);

const b64 = Buffer.from(svg).toString('base64');
for (const [nome, px] of [
  ['favicon-512.png', 512],
  ['favicon-192.png', 192],
  ['apple-touch-icon.png', 180],
  ['favicon-32.png', 32],
  ['favicon-16.png', 16],
]) {
  const ctx = await nav.newContext({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  const pg = await ctx.newPage();
  await pg.setContent(
    `<html><body style="margin:0"><img src="data:image/svg+xml;base64,${b64}" width="${px}" height="${px}"></body></html>`,
  );
  await pg.waitForTimeout(150);
  await pg.screenshot({ path: `${RAIZ}/${nome}` });
  await ctx.close();
  console.log(`  ${nome}`);
}

// Folha de prova: os tamanhos reais lado a lado, e o 16px ampliado — que e
// onde favicon de traco fino morre.
const ctx = await nav.newContext({ viewport: { width: 860, height: 300 } });
const pg = await ctx.newPage();
await pg.setContent(`<html><body style="margin:0;font:13px sans-serif;background:#fff;display:flex;gap:26px;align-items:flex-end;padding:22px">
  ${[16, 32, 48, 64, 180]
    .map(
      (px) =>
        `<div style="text-align:center"><img src="data:image/svg+xml;base64,${b64}" width="${px}" height="${px}"><div>${px}px</div></div>`,
    )
    .join('')}
  <div style="text-align:center;padding-left:18px;border-left:1px solid #ddd">
    <img src="data:image/svg+xml;base64,${b64}" style="width:128px;height:128px;image-rendering:pixelated">
    <div>16px ampliado</div>
  </div>
</body></html>`);
await pg.waitForTimeout(250);
await pg.screenshot({ path: '/var/tmp/shots/favicon-prova.png' });
await ctx.close();
await nav.close();
console.log('\nfolha de prova: /var/tmp/shots/favicon-prova.png');
