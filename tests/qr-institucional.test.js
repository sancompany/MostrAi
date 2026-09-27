const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const { PNG } = require('pngjs');
const jsQR = require('jsqr');
const QRCode = require('qrcode');
const pool = require('../src/db/pool');
const { gerarHash } = require('../src/lib/senha');

// QR Code institucional (Admin → Mídia Mostraí, 27/09/2026). O QR impresso
// nunca muda: ele codifica a rota permanente /q/anuncie, e o admin muda só
// para onde essa rota leva. Aqui roda o `app` REAL (src/server.js): guarda do
// /admin, login do admin e da conta de verdade, e a rota pública.
//
// O conteúdo do QR é conferido DECODIFICANDO a imagem com um leitor
// independente (jsqr) — o PNG pelos pixels, o SVG pela geometria do desenho —,
// não comparando com a própria biblioteca que gerou.
//
// Endereço do site fixo e em https, como em produção: é o que vai dentro do
// QR, e é por ele que a validação decide se aceita destino http.
process.env.SITE_URL = 'https://mostrai.test';
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-qr-institucional';
const app = require('../src/server');
const pontosRepo = require('../src/pontos/repository');
const qr = require('../src/midias/qr-institucional');

const LINK = 'https://mostrai.test/q/anuncie';
const PADRAO = 'https://mostrai.test/planos.html';
const CHAVE = 'qr_institucional';

// IP próprio por execução: o limitador de tentativas de login conta por IP.
const IP = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

let base;
let servidor;
// Uma sessão de admin pro arquivo inteiro: o limitador de login conta toda
// tentativa (até as certas), 10 por 15 min por IP e rota.
let admin;
test.before(async () => {
  servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  base = `http://127.0.0.1:${servidor.address().port}`;
  await pontosRepo.definirConfiguracao(CHAVE, null);
  admin = navegador();
  const r = await admin('POST', '/admin/login', { usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD });
  assert.strictEqual(r.status, 200, 'login do admin');
});
test.after(async () => {
  await pontosRepo.definirConfiguracao(CHAVE, null);
  servidor.closeAllConnections();
  await new Promise((r) => servidor.close(r));
  await pool.end();
});

// Pote de cookies com o `Path` respeitado (o do admin só vai pro /admin) e
// sem seguir redirecionamento: o 302 da rota pública é o que se mede.
function navegador() {
  const potes = new Map();
  return async function pedir(metodo, caminho, corpo) {
    const cookie = [...potes.entries()]
      .filter(([, c]) => caminho.startsWith(c.path))
      .map(([nome, c]) => `${nome}=${c.valor}`)
      .join('; ');
    const r = await fetch(`${base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': IP, ...(cookie ? { cookie } : {}) },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    for (const linha of r.headers.getSetCookie()) {
      const [par, ...atributos] = linha.split(';').map((s) => s.trim());
      const [nome, ...resto] = par.split('=');
      const path = atributos.find((a) => /^path=/i.test(a))?.split('=')[1] || '/';
      potes.set(nome, { valor: resto.join('='), path });
    }
    const bytes = Buffer.from(await r.arrayBuffer());
    let json = null;
    try {
      json = JSON.parse(bytes.toString('utf8'));
    } catch {}
    return { status: r.status, headers: r.headers, bytes, texto: bytes.toString('utf8'), json };
  };
}

// Leitor independente: pixels do PNG → jsqr.
function lerPng(bytes) {
  const img = PNG.sync.read(bytes);
  const codigo = jsQR(new Uint8ClampedArray(img.data), img.width, img.height);
  return { largura: img.width, altura: img.height, conteudo: codigo ? codigo.data : null };
}

// Leitor independente do SVG: refaz a grade de módulos a partir do `path`
// escuro (linhas horizontais de 1 módulo de altura: M x y, m dx 0, h n),
// pinta 8 px por módulo e entrega pro jsqr. Se o desenho estiver errado, o
// QR não lê — é o mesmo que um celular faria com o arquivo impresso.
function lerSvg(svg) {
  const n = Number(svg.match(/viewBox="0 0 (\d+) \1"/)[1]);
  const d = svg.match(/<path stroke="[^"]+" d="([^"]+)"/)[1];
  const escuro = Array.from({ length: n }, () => new Array(n).fill(false));
  let x = 0;
  let y = 0;
  for (const [, cmd, args] of d.matchAll(/([Mmh])([^Mmh]*)/g)) {
    const nums = args
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (cmd === 'M') [x, y] = nums;
    else if (cmd === 'm') x += nums[0];
    else {
      for (let i = 0; i < nums[0]; i++) escuro[Math.floor(y)][x + i] = true;
      x += nums[0];
    }
  }
  const px = 8;
  const lado = n * px;
  const rgba = new Uint8ClampedArray(lado * lado * 4).fill(255);
  for (let i = 0; i < lado; i++) {
    for (let j = 0; j < lado; j++) {
      if (!escuro[Math.floor(i / px)][Math.floor(j / px)]) continue;
      const p = (i * lado + j) * 4;
      rgba[p] = 0;
      rgba[p + 1] = 0;
      rgba[p + 2] = 0;
    }
  }
  const codigo = jsQR(rgba, lado, lado);
  return { modulos: n, conteudo: codigo ? codigo.data : null };
}

async function criarConta() {
  const senha = 'Senha12@teste';
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado)
     VALUES (now(), $1, $2, $3, '16999990000', $4, ARRAY['anunciante'], true)
     RETURNING id, contato_email`,
    [
      `QR ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `qr-${randomUUID()}@example.com`,
      await gerarHash(senha),
    ],
  );
  return { ...rows[0], senha };
}

// ---------------------------------------------------------------------------
// 1. Redirecionamento
// ---------------------------------------------------------------------------

test('sem destino gravado, /q/anuncie leva à página de planos — 302 e nunca em cache', async () => {
  await pontosRepo.definirConfiguracao(CHAVE, null);
  const anonimo = navegador();
  for (const metodo of ['GET', 'HEAD']) {
    const r = await anonimo(metodo, '/q/anuncie');
    assert.strictEqual(r.status, 302, metodo);
    assert.strictEqual(r.headers.get('location'), PADRAO, metodo);
    // Um 301 ou um 302 guardado pela Cloudflare/navegador prenderia o QR
    // impresso no destino antigo — o requisito central desta estação.
    assert.match(r.headers.get('cache-control') || '', /no-store/, metodo);
  }
});

test('o admin troca o destino e o MESMO /q/anuncie passa a levar ao novo; o link permanente não muda', async () => {
  const anonimo = navegador();
  try {
    const antes = await admin('GET', '/admin/qr-institucional');
    assert.strictEqual(antes.status, 200);
    assert.strictEqual(antes.json.linkPermanente, LINK);
    assert.strictEqual(antes.json.destino, PADRAO);
    assert.strictEqual(antes.json.destinoPadrao, PADRAO);
    assert.strictEqual(antes.json.padrao, true);

    const novo = 'https://mostrai.test/pontos.html';
    const salvo = await admin('PUT', '/admin/qr-institucional', { destino: novo });
    assert.strictEqual(salvo.status, 200, salvo.texto);
    assert.strictEqual(salvo.json.destino, novo);
    assert.strictEqual(salvo.json.linkPermanente, LINK, 'o link do QR é o mesmo');
    assert.strictEqual(salvo.json.padrao, false);
    assert.strictEqual(salvo.json.atualizadoPor, process.env.ADMIN_USER);
    assert.ok(!Number.isNaN(Date.parse(salvo.json.atualizadoEm)), 'data da troca');
    assert.strictEqual((await anonimo('GET', '/q/anuncie')).headers.get('location'), novo);

    // Destino fora do site (campanha no WhatsApp, por exemplo) também vale.
    const externo = 'https://wa.me/5516999990000?text=Quero%20anunciar';
    assert.strictEqual((await admin('PUT', '/admin/qr-institucional', { destino: externo })).status, 200);
    assert.strictEqual((await anonimo('GET', '/q/anuncie')).headers.get('location'), externo);

    const depois = await admin('GET', '/admin/qr-institucional');
    assert.strictEqual(depois.json.linkPermanente, LINK, 'o link do QR continua o mesmo');
    assert.strictEqual(depois.json.destino, externo);
  } finally {
    await pontosRepo.definirConfiguracao(CHAVE, null);
  }
});

test('o destino é gravado limpo: sem espaços em volta e no formato canônico do endereço', async () => {
  try {
    const r = await admin('PUT', '/admin/qr-institucional', { destino: '  https://Exemplo.COM/Planos?x=1  ' });
    assert.strictEqual(r.status, 200, r.texto);
    assert.strictEqual(r.json.destino, 'https://exemplo.com/Planos?x=1');
    assert.strictEqual(
      (await navegador()('GET', '/q/anuncie')).headers.get('location'),
      'https://exemplo.com/Planos?x=1',
    );
  } finally {
    await pontosRepo.definirConfiguracao(CHAVE, null);
  }
});

// ---------------------------------------------------------------------------
// 2. O QR codifica a rota permanente — e não muda quando o destino muda
// ---------------------------------------------------------------------------

test('o QR (PNG e SVG) codifica /q/anuncie e continua idêntico depois de trocar o destino', async () => {
  try {
    const png1 = await admin('GET', '/admin/qr-institucional/png');
    const svg1 = await admin('GET', '/admin/qr-institucional/svg');
    assert.strictEqual(png1.status, 200);
    assert.strictEqual(svg1.status, 200);
    assert.strictEqual(lerPng(png1.bytes).conteudo, LINK, 'o PNG lê o link permanente');
    assert.strictEqual(lerSvg(svg1.texto).conteudo, LINK, 'o SVG lê o link permanente');

    assert.strictEqual(
      (await admin('PUT', '/admin/qr-institucional', { destino: 'https://exemplo.com/campanha' })).status,
      200,
    );

    const png2 = await admin('GET', '/admin/qr-institucional/png');
    const svg2 = await admin('GET', '/admin/qr-institucional/svg');
    assert.ok(png1.bytes.equals(png2.bytes), 'PNG idêntico');
    assert.strictEqual(svg1.texto, svg2.texto, 'SVG idêntico');
    assert.strictEqual(lerPng(png2.bytes).conteudo, LINK, 'o QR nunca leva o destino dentro');
    assert.ok(!svg2.texto.includes('exemplo.com'));
  } finally {
    await pontosRepo.definirConfiguracao(CHAVE, null);
  }
});

// ---------------------------------------------------------------------------
// 3. Arquivos: PNG e SVG válidos, preview e download
// ---------------------------------------------------------------------------

test('PNG: 1024 px por padrão e 2048 px para impressão, válidos e legíveis; outro tamanho é recusado', async () => {
  const ASSINATURA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (const [consulta, lado] of [
    ['', 1024],
    ['?tamanho=1024', 1024],
    ['?tamanho=2048', 2048],
  ]) {
    const r = await admin('GET', `/admin/qr-institucional/png${consulta}`);
    assert.strictEqual(r.status, 200, consulta);
    assert.strictEqual(r.headers.get('content-type'), 'image/png', consulta);
    assert.ok(r.bytes.subarray(0, 8).equals(ASSINATURA_PNG), `assinatura PNG ${consulta}`);
    const lido = lerPng(r.bytes);
    assert.strictEqual(lido.largura, lado, consulta);
    assert.strictEqual(lido.altura, lado, consulta);
    assert.strictEqual(lido.conteudo, LINK, consulta);
  }
  for (const tamanho of ['4096', '100', 'abc', '1024.5', '']) {
    const r = await admin('GET', `/admin/qr-institucional/png?tamanho=${tamanho}`);
    if (tamanho === '') assert.strictEqual(r.status, 200, 'vazio = padrão');
    else assert.strictEqual(r.status, 400, `tamanho ${tamanho}`);
  }
});

test('SVG: vetor limpo, sem script nem referência externa, com zona de silêncio de 4 módulos', async () => {
  const r = await admin('GET', '/admin/qr-institucional/svg');
  assert.strictEqual(r.status, 200);
  assert.match(r.headers.get('content-type'), /^image\/svg\+xml/);
  const svg = r.texto.trim();
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), svg.slice(0, 80));
  assert.ok(svg.endsWith('</svg>'));
  assert.doesNotMatch(svg, /<script|\son\w+=|href=|<foreignObject/i);
  // Módulos do símbolo + 4 de margem de cada lado (o mínimo da norma).
  const simbolo = QRCode.create(LINK, { errorCorrectionLevel: 'Q' }).modules.size;
  assert.ok(svg.includes(`viewBox="0 0 ${simbolo + 8} ${simbolo + 8}"`), 'margem de 4 módulos');
  assert.ok(svg.includes('fill="#ffffff"'), 'fundo branco');
  assert.ok(svg.includes('stroke="#14171f"'), 'módulos na cor de texto da marca');
  assert.strictEqual(lerSvg(svg).conteudo, LINK);
});

test('preview vem inline; "baixar" vem como anexo com nome de arquivo; nada disso vai pra cache', async () => {
  const preview = await admin('GET', '/admin/qr-institucional/svg');
  assert.ok(!/attachment/i.test(preview.headers.get('content-disposition') || ''), 'preview não baixa');
  for (const [caminho, arquivo] of [
    ['/admin/qr-institucional/svg?baixar=1', 'mostrai-qr-anuncie.svg'],
    ['/admin/qr-institucional/png?baixar=1', 'mostrai-qr-anuncie-1024px.png'],
    ['/admin/qr-institucional/png?tamanho=2048&baixar=1', 'mostrai-qr-anuncie-2048px.png'],
  ]) {
    const r = await admin('GET', caminho);
    assert.strictEqual(r.status, 200, caminho);
    assert.strictEqual(r.headers.get('content-disposition'), `attachment; filename="${arquivo}"`, caminho);
    assert.match(r.headers.get('cache-control') || '', /no-store/, caminho);
  }
});

// ---------------------------------------------------------------------------
// 4. Validação e permissão
// ---------------------------------------------------------------------------

test('destino inválido ou inseguro é recusado com o motivo, e nada muda', async () => {
  const anonimo = navegador();
  try {
    const valido = 'https://mostrai.test/planos.html?origem=qr';
    assert.strictEqual((await admin('PUT', '/admin/qr-institucional', { destino: valido })).status, 200);

    const invalidos = [
      undefined,
      null,
      123,
      ['https://exemplo.com'],
      { url: 'https://exemplo.com' },
      '',
      '   ',
      'planos.html',
      '/planos.html',
      'www.exemplo.com',
      '//exemplo.com/planos',
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'ftp://exemplo.com/arquivo',
      'http://exemplo.com/planos', // o site é https: o destino não pode ser menos seguro
      'https://usuario:senha@exemplo.com/',
      'https://usuario@exemplo.com/',
      'https://exemplo', // sem domínio de verdade
      'https://exemplo.com/com espaço',
      'https://exemplo.com/\u0000',
      'https://exemplo.com/\nlinha',
      `https://exemplo.com/${'a'.repeat(2048)}`,
      // O próprio link do QR: o celular ficaria em laço de redirecionamento.
      'https://mostrai.test/q/anuncie',
      'https://mostrai.test/q/anuncie/',
      'https://MOSTRAI.test/Q/Anuncie',
      'https://mostrai.test/q/anuncie?x=1',
      'https://mostrai.test/q/anuncie#topo',
      'https://mostrai.test/q/x/../anuncie',
    ];
    for (const destino of invalidos) {
      const r = await admin('PUT', '/admin/qr-institucional', { destino });
      assert.strictEqual(r.status, 400, `devia recusar ${JSON.stringify(destino)?.slice(0, 60)}`);
      assert.strictEqual(typeof r.json?.erro, 'string', 'com o motivo');
      assert.ok(r.json.erro.length > 5);
    }
    // Corpo que nem é objeto.
    const semCorpo = await admin('PUT', '/admin/qr-institucional');
    assert.strictEqual(semCorpo.status, 400);

    assert.strictEqual((await admin('GET', '/admin/qr-institucional')).json.destino, valido, 'nada mudou');
    assert.strictEqual((await anonimo('GET', '/q/anuncie')).headers.get('location'), valido);
  } finally {
    await pontosRepo.definirConfiguracao(CHAVE, null);
  }
});

test('só o admin mexe no QR: sem sessão ou com sessão de anunciante, 401 — e o destino fica como estava', async () => {
  const conta = await criarConta();
  const anonimo = navegador();
  const anunciante = navegador();
  try {
    assert.strictEqual(
      (await anunciante('POST', '/anunciantes/login', { email: conta.contato_email, senha: conta.senha })).status,
      200,
    );
    for (const pedir of [anonimo, anunciante]) {
      const r = await pedir('PUT', '/admin/qr-institucional', { destino: 'https://golpe.example/pix' });
      assert.strictEqual(r.status, 401);
      for (const caminho of ['/admin/qr-institucional', '/admin/qr-institucional/svg', '/admin/qr-institucional/png']) {
        assert.strictEqual((await pedir('GET', caminho)).status, 401, caminho);
      }
    }
    assert.strictEqual((await anonimo('GET', '/q/anuncie')).headers.get('location'), PADRAO, 'destino intocado');
  } finally {
    await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
  }
});

// ---------------------------------------------------------------------------
// 5. A rota pública nunca quebra e nunca leva a destino inseguro
// ---------------------------------------------------------------------------

test('valor gravado à mão errado nunca vira redirecionamento: cai no padrão', async () => {
  const anonimo = navegador();
  try {
    for (const bruto of [
      JSON.stringify({ destino: 'javascript:alert(1)' }),
      JSON.stringify({ destino: 'https://mostrai.test/q/anuncie' }),
      JSON.stringify({ destino: 42 }),
      'não é json',
    ]) {
      await pontosRepo.definirConfiguracao(CHAVE, bruto);
      const r = await anonimo('GET', '/q/anuncie');
      assert.strictEqual(r.status, 302, bruto);
      assert.strictEqual(r.headers.get('location'), PADRAO, bruto);
    }
  } finally {
    await pontosRepo.definirConfiguracao(CHAVE, null);
  }
});

test('quem/quando gravados à mão com tipo errado não vão pra tela; o destino válido continua valendo', async () => {
  try {
    const destino = 'https://mostrai.test/pontos.html';
    await pontosRepo.definirConfiguracao(CHAVE, JSON.stringify({ destino, atualizadoEm: { x: 1 }, atualizadoPor: 42 }));
    let r = await admin('GET', '/admin/qr-institucional');
    assert.strictEqual(r.json.destino, destino);
    assert.strictEqual(r.json.padrao, false);
    assert.strictEqual(r.json.atualizadoEm, null);
    assert.strictEqual(r.json.atualizadoPor, null);
    await pontosRepo.definirConfiguracao(
      CHAVE,
      JSON.stringify({ destino, atualizadoEm: 'ontem', atualizadoPor: '  ' }),
    );
    r = await admin('GET', '/admin/qr-institucional');
    assert.strictEqual(r.json.atualizadoEm, null, 'data que não é data');
    assert.strictEqual(r.json.atualizadoPor, null, 'nome em branco');
  } finally {
    await pontosRepo.definirConfiguracao(CHAVE, null);
  }
});

test('banco fora do ar: /q/anuncie não dá erro, leva à página de planos — e a falha fica no log', async () => {
  const original = pontosRepo.obterConfiguracao;
  const logOriginal = console.error;
  const logs = [];
  pontosRepo.obterConfiguracao = async () => {
    throw new Error('banco fora do ar');
  };
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const r = await navegador()('GET', '/q/anuncie');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), PADRAO);
    assert.ok(
      logs.some((l) => l.includes('banco fora do ar')),
      'a falha não some',
    );
  } finally {
    pontosRepo.obterConfiguracao = original;
    console.error = logOriginal;
  }
});

test('sem SITE_URL o admin avisa (503) em vez de gerar um QR sem endereço', async () => {
  const salvo = { SITE_URL: process.env.SITE_URL, CORS_ORIGIN: process.env.CORS_ORIGIN };
  delete process.env.SITE_URL;
  delete process.env.CORS_ORIGIN;
  try {
    for (const caminho of ['/admin/qr-institucional', '/admin/qr-institucional/svg', '/admin/qr-institucional/png']) {
      const r = await admin('GET', caminho);
      assert.strictEqual(r.status, 503, caminho);
      assert.match(r.json?.erro || '', /SITE_URL/, caminho);
    }
    // A rota pública continua levando a algum lugar útil.
    const r = await navegador()('GET', '/q/anuncie');
    assert.strictEqual(r.status, 302);
    assert.strictEqual(r.headers.get('location'), '/planos.html');
  } finally {
    // `process.env.X = undefined` grava a string "undefined": o que não
    // existia volta a não existir.
    for (const [nome, valor] of Object.entries(salvo)) {
      if (valor === undefined) delete process.env[nome];
      else process.env[nome] = valor;
    }
  }
});

// ---------------------------------------------------------------------------
// 6. Regras isoladas
// ---------------------------------------------------------------------------

test('validarDestino: em ambiente local (site em http) aceita http; o laço continua proibido', () => {
  const salvo = process.env.SITE_URL;
  process.env.SITE_URL = 'http://localhost:3999/';
  try {
    assert.strictEqual(qr.linkPermanente(), 'http://localhost:3999/q/anuncie', 'barra final do SITE_URL não duplica');
    assert.deepStrictEqual(qr.validarDestino('http://localhost:3999/planos.html'), {
      destino: 'http://localhost:3999/planos.html',
    });
    assert.ok(qr.validarDestino('http://localhost:3999/q/anuncie').erro);
    assert.ok(qr.validarDestino('javascript:alert(1)').erro);
  } finally {
    process.env.SITE_URL = salvo;
  }
  assert.ok(qr.validarDestino('http://exemplo.com/').erro, 'de volta ao site https, http é recusado');
});

// ---------------------------------------------------------------------------
// 7. A Mídia Mostraí continua igual
// ---------------------------------------------------------------------------

test('as rotas da Mídia Mostraí continuam respondendo com o QR montado no mesmo router', async () => {
  assert.strictEqual((await admin('GET', '/admin/midias-proprias')).status, 200);
  assert.strictEqual((await admin('GET', '/admin/capacidade-rede')).status, 200);
  assert.strictEqual((await admin('GET', '/admin/video-institucional')).status, 200);
});
