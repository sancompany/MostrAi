// Gera os ícones do site.
//
// O FAVICON É O "M" DA MARCA, sozinho, sem disco (decisão do dono,
// 17/09/2026: "pode retirar o disco, isso era só para a lâmpada").
//
// Por que o M e não a lâmpada: um favicon tem 16 pixels. A lâmpada com raios,
// reduzida a esse tamanho, vira um cinza indistinto — foi a reclamação que
// abriu o assunto ("o antigo fica totalmente apagado, quase não dá pra ver
// ele"). Uma letra sólida, em laranja, é a forma que sobrevive: alto
// contraste, um traço só, reconhecível de relance.
//
// O M SAI DO WORDMARK, não é redesenhado: `logo-mostrai-wordmark.png` tem a
// letra no serif exato da marca. O script acha os limites dela varrendo os
// pixels (não por coordenada chutada, que quebra se o logo for reexportado),
// recorta, e recolore pelo canal alfa — o desenho é o do dono, só muda a cor.
//
// limite: a fonte é raster de 900x203, então o M tem ~180px de altura. Isso
// cobre 16, 32, 180 e 192 com folga, mas o de 512 (ícone de PWA) sai macio.
// O caminho de upgrade é o dono subir o M em SVG no repositório; aí este
// script passa a usar o vetor e o 512 fica duro. Marcado aqui pra não virar
// surpresa quando alguém instalar o app no celular.
//
// O SÍMBOLO DA MARCA (a lâmpada, `simbolo-lampada.svg`) é OUTRA PEÇA e não
// entra aqui: ele vive na hero da home e no cartão do player. Confundir as
// duas já custou um retrabalho — está registrado em docs/PENDENCIAS.md.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

// Servidor estático mínimo: o canvas precisa ler os pixels do wordmark, e
// `file://` bloqueia `getImageData` por política de origem.
const srv = http.createServer((req, res) => {
  // Página em branco própria: carregar a home de verdade traria os scripts
  // dela pra dentro da medição, e um deles já atrapalhou uma vez.
  if (req.url === '/branco.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><html><body></body></html>');
  }
  const arq = path.join('public', decodeURIComponent(req.url.split('?')[0]));
  if (!fs.existsSync(arq)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': arq.endsWith('.png') ? 'image/png' : 'image/svg+xml' });
  fs.createReadStream(arq).pipe(res);
});
await new Promise((ok) => srv.listen(8091, ok));

const RAIZ = 'public/img';
const LARANJA = '#ff7a1a';
const LADO = 512;
const C = LADO / 2;
// Quanto do quadro a letra ocupa. Alguma margem é obrigatória: sistema
// operacional e navegador recortam cantos em alguns contextos (atalho no
// celular, ícone arredondado), e letra encostada na borda perde a perna.
const OCUPACAO = 0.86;

const nav = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const pg = await (await nav.newContext({ viewport: { width: 1000, height: 700 } })).newPage();
await pg.goto('http://localhost:8091/branco.html');

// Recorta o M e devolve um PNG só dele, já na cor da marca. Os limites saem
// de uma varredura de pixels: a primeira letra do wordmark é o M, e ela
// termina onde vem a primeira coluna vazia depois dela.
const m = await pg.evaluate(async ({ cor }) => {
  const img = new Image();
  img.src = 'http://localhost:8091/img/logo-mostrai-wordmark.png';
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;

  // Uma coluna tem tinta se algum pixel dela é opaco e escuro o bastante.
  const temTinta = (x) => {
    for (let y = 0; y < c.height; y++) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] > 40 && d[i] + d[i + 1] + d[i + 2] < 600) return true;
    }
    return false;
  };
  let x0 = 0;
  while (x0 < c.width && !temTinta(x0)) x0++;
  let x1 = x0;
  while (x1 < c.width && temTinta(x1)) x1++;

  // Linhas, dentro da faixa do M.
  const temTintaLinha = (y) => {
    for (let x = x0; x < x1; x++) {
      const i = (y * c.width + x) * 4;
      if (d[i + 3] > 40 && d[i] + d[i + 1] + d[i + 2] < 600) return true;
    }
    return false;
  };
  let y0 = 0;
  while (y0 < c.height && !temTintaLinha(y0)) y0++;
  let y1 = c.height - 1;
  while (y1 > y0 && !temTintaLinha(y1)) y1--;

  const larg = x1 - x0;
  const alt = y1 - y0 + 1;
  const saida = document.createElement('canvas');
  saida.width = larg;
  saida.height = alt;
  const sc = saida.getContext('2d');
  sc.drawImage(img, x0, y0, larg, alt, 0, 0, larg, alt);
  // Recolore pelo ALFA: mantém a forma e as bordas suavizadas da letra, troca
  // só a cor. `source-in` pinta onde já existe tinta.
  sc.globalCompositeOperation = 'source-in';
  sc.fillStyle = cor;
  sc.fillRect(0, 0, larg, alt);
  return { dados: saida.toDataURL('image/png'), larg, alt };
}, { cor: LARANJA });

console.log(`M extraído do wordmark: ${m.larg}x${m.alt}px`);

const alturaAlvo = LADO * OCUPACAO;
const escala = alturaAlvo / m.alt;
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LADO} ${LADO}" width="${LADO}" height="${LADO}" role="img" aria-label="Mostraí">
  <title>Mostraí</title>
  <image href="${m.dados}" x="${(C - (m.larg * escala) / 2).toFixed(2)}" y="${(C - alturaAlvo / 2).toFixed(2)}" width="${(m.larg * escala).toFixed(2)}" height="${alturaAlvo.toFixed(2)}"/>
</svg>`;
fs.writeFileSync(`${RAIZ}/favicon.svg`, `${favicon}\n`);

const b64 = (s) => `data:image/svg+xml;base64,${Buffer.from(s).toString('base64')}`;

// `opaco`: o ícone de tela inicial do iOS é o único que precisa de fundo.
// A Apple não suporta transparência nele e compõe o que for transparente
// sobre PRETO — o M laranja apareceria num quadrado preto no celular de quem
// instalasse o site. Fundo branco CHAPADO, sem disco e sem contorno: não é
// trazer de volta o que o dono tirou, é o que a plataforma exige.
// (Conferido contra a orientação da Apple para `apple-touch-icon`, que pede
// imagem opaca e sem canal alfa. nao-conferido: link oficial não acessado
// nesta sessão — reconferir na próxima mexida em ícone.)
for (const [nome, px, opaco] of [
  ['favicon-512.png', 512, false],
  ['favicon-192.png', 192, false],
  ['apple-touch-icon.png', 180, true],
  ['favicon-32.png', 32, false],
  ['favicon-16.png', 16, false],
]) {
  const ctx = await nav.newContext({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
  const p = await ctx.newPage();
  await p.setContent(
    `<html><body style="margin:0;${opaco ? 'background:#fff' : ''}"><img src="${b64(favicon)}" width="${px}" height="${px}"></body></html>`,
  );
  await p.waitForTimeout(200);
  // `omitBackground` nos de aba: sem isso o branco do body entra no PNG e o
  // ícone volta a ter um quadrado branco atrás — que é o que o dono tirou.
  await p.screenshot({ path: `${RAIZ}/${nome}`, omitBackground: !opaco });
  await ctx.close();
  console.log(`  ${nome} (${px}px)${opaco ? ' · fundo branco (exigência do iOS)' : ''}`);
}

// Folha de prova: na aba, que é onde se decide. Com fundo transparente o que
// importa é o contraste nos dois temas — é o que a folha mostra.
const prova = await (await nav.newContext({ viewport: { width: 1000, height: 460 } })).newPage();
const aba = (fundo, cor, rotulo) => `
  <div style="background:${fundo};color:${cor};padding:14px 18px;border-radius:10px;margin-bottom:12px">
    <div style="font:600 12px sans-serif;opacity:.65;margin-bottom:9px">${rotulo}</div>
    <div style="display:flex;gap:34px;align-items:center;font:13px sans-serif">
      <span style="display:flex;gap:7px;align-items:center"><img src="${b64(favicon)}" width="16" height="16">Planos da Mostraí</span>
      <span style="display:flex;gap:7px;align-items:center"><img src="${b64(favicon)}" width="32" height="32">32px</span>
    </div>
  </div>`;
await prova.setContent(`<html><body style="margin:0;padding:20px;background:#f2f3f5;font:13px sans-serif">
  <div style="font:700 15px sans-serif;margin-bottom:11px">Na aba, 16px real</div>
  ${aba('#ffffff', '#202124', 'Chrome tema claro')}
  ${aba('#35363a', '#e8eaed', 'Chrome tema escuro')}
  <div style="font:700 15px sans-serif;margin:20px 0 9px">Ampliado</div>
  <div style="display:flex;gap:22px">
    ${[
      ['sobre branco', favicon],
      ['sobre escuro', favicon],
    ]
      .map(
        ([n, s]) =>
          `<div style="text-align:center"><img src="${b64(s)}" style="width:150px;height:150px;border:1px solid #ddd;background:${n === 'sobre escuro' ? '#35363a' : '#fff'}"><div style="font:11px sans-serif;margin-top:5px">${n}</div></div>`,
      )
      .join('')}
  </div>
</body></html>`);
await prova.waitForTimeout(500);
await prova.screenshot({ path: '/var/tmp/shots/favicon-prova.png', fullPage: true });
await nav.close();
srv.close();
console.log('\nfolha de prova: /var/tmp/shots/favicon-prova.png');
