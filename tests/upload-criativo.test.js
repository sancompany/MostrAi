require('express-async-errors');
const test = require('node:test');
const assert = require('node:assert');
const { randomUUID } = require('node:crypto');
const express = require('express');
const session = require('express-session');
const pool = require('../src/db/pool');
const ffmpeg = require('../src/lib/ffmpeg');

// Upload confiável de criativo (estação sessão + upload, 27/09/2026).
//
// Em produção o processamento (FFmpeg a 0,5 vCPU + Storage) passava dos 100 s
// do proxy da Cloudflare: o navegador recebia 524 e mostrava "Não foi
// possível enviar", e o servidor terminava e criava o criativo mesmo assim.
// Tentar de novo criava outro. Aqui: o mesmo envio (mesma Idempotency-Key)
// nunca cria dois criativos, a resposta perdida é reconciliável pela chave,
// e erro de verdade não deixa linha pra trás.
//
// FFmpeg e Storage são falsos (o CI não tem FFmpeg; o teste do FFmpeg real
// fica em tests/ffmpeg-normalizar.test.js): `normalizar` espera uma "trava"
// que o teste solta — é assim que o teste segura o servidor NO MEIO do
// processamento, que é exatamente onde o 524 acontecia.

// Vídeo de 10 s a 30 fps: o ffprobe real conta os quadros (pacotes) e dá o
// pix_fmt, que a recusa por custo lê (src/lib/ffmpeg.js#recusaPorCusto).
let midiaFalsa = { width: 1080, height: 1920, duracao_segundos: 10, ehImagem: false, quadros: 300, pix_fmt: 'yuv420p' };
let travaNormalizar = null;
let falhaNormalizar = null;
let chamadasNormalizar = 0;
// A espera da vez do ffprobe (fila do FFmpeg, src/lib/ffmpeg.js): o teste
// segura o probe como a fila seguraria, e solta quando quiser.
let travaProbe = null;
let falhaProbe = null;
let chamadasProbe = 0;
let temposDoProbe = null;
ffmpeg.probeMidia = async (_caminho, tempos) => {
  chamadasProbe += 1;
  if (temposDoProbe && tempos) Object.assign(tempos, temposDoProbe);
  if (travaProbe) await travaProbe.promessa;
  if (falhaProbe) throw falhaProbe;
  return midiaFalsa;
};
ffmpeg.normalizar = async (_caminho, criativoId) => {
  chamadasNormalizar += 1;
  if (travaNormalizar) await travaNormalizar.promessa;
  if (falhaNormalizar) throw falhaNormalizar;
  return {
    arquivo_normalizado_url: `https://storage.teste/${criativoId}.mp4`,
    thumbnail_url: `https://storage.teste/${criativoId}-thumb.jpg`,
    duracao_segundos: midiaFalsa.duracao_segundos,
    conteudo_sha256: 'a'.repeat(64),
    conteudo_bytes: 1234,
    tempos: { ffmpeg_ms: 1, thumb_ms: 1, storage_ms: 1 },
  };
};
function travar() {
  let soltar;
  const promessa = new Promise((r) => {
    soltar = r;
  });
  travaNormalizar = { promessa, soltar };
  return () => {
    travaNormalizar = null;
    soltar();
  };
}

async function subirApp() {
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 'teste-upload', resave: false, saveUninitialized: false }));
  app.use((req, _res, proximo) => {
    if (req.headers['x-conta']) req.session.anuncianteId = Number(req.headers['x-conta']);
    proximo();
  });
  app.use(require('../src/anunciantes/routes').router);
  app.use((err, _req, res, _next) => res.status(500).json({ erro: err.message }));
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    enviar: async (conta, chave, { sinal } = {}) => {
      const form = new FormData();
      form.append('arquivo', new Blob([Buffer.from('video-de-teste')], { type: 'video/mp4' }), 'peca.mp4');
      const r = await fetch(`${base}/anunciantes/${conta.id}/criativos`, {
        method: 'POST',
        headers: { 'x-conta': String(conta.id), ...(chave ? { 'idempotency-key': chave } : {}) },
        body: form,
        signal: sinal,
      });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    envio: async (conta, chave) => {
      const r = await fetch(`${base}/anunciantes/me/criativos/envios/${chave}`, {
        headers: { 'x-conta': String(conta.id) },
      });
      return { status: r.status, corpo: await r.json().catch(() => null) };
    },
    lista: async (conta) => {
      const r = await fetch(`${base}/anunciantes/me/criativos`, { headers: { 'x-conta': String(conta.id) } });
      return r.json();
    },
    fechar: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

async function criarConta(plano = 'maximo-1m') {
  const { rows } = await pool.query(
    `INSERT INTO anunciantes (aceitou_termos_em, nome_empresa, cpf_cnpj, contato_email, contato_telefone, senha_hash,
                              papeis, email_confirmado, plano_id, data_inicio_cobertura, data_expiracao)
     VALUES (now(), $1, $2, $3, '16999990000', 'x', ARRAY['anunciante'], true, $4, now(), now() + interval '20 days')
     RETURNING *`,
    [
      `UP ${randomUUID().slice(0, 8)}`,
      randomUUID().replace(/\D/g, '').padEnd(11, '1').slice(0, 11),
      `up-${randomUUID()}@example.com`,
      plano,
    ],
  );
  return rows[0];
}

const contar = async (conta) =>
  (await pool.query('SELECT COUNT(*)::int AS n FROM criativos WHERE anunciante_id = $1', [conta.id])).rows[0].n;

async function esperarLinha(conta) {
  for (let i = 0; i < 100; i++) {
    if ((await contar(conta)) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('a linha temporária não apareceu');
}

async function limpar(conta) {
  await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [conta.id]);
  await pool.query('DELETE FROM anunciantes WHERE id = $1', [conta.id]);
}

function preparar() {
  midiaFalsa = { width: 1080, height: 1920, duracao_segundos: 10, ehImagem: false, quadros: 300, pix_fmt: 'yuv420p' };
  travaNormalizar = null;
  falhaNormalizar = null;
  chamadasNormalizar = 0;
  travaProbe = null;
  falhaProbe = null;
  chamadasProbe = 0;
  temposDoProbe = null;
}

async function esperarProbe(n = 1) {
  for (let i = 0; i < 100; i++) {
    if (chamadasProbe >= n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('o envio não chegou ao ffprobe');
}

test('A/E. upload válido cria exatamente 1 criativo; repetir a mesma chave devolve o mesmo, sem criar outro', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    const primeiro = await app.enviar(conta, chave);
    assert.strictEqual(primeiro.status, 201);
    assert.strictEqual(await contar(conta), 1);

    const repetido = await app.enviar(conta, chave);
    assert.strictEqual(repetido.status, 200);
    assert.strictEqual(repetido.corpo.repetido, true);
    assert.strictEqual(repetido.corpo.id, primeiro.corpo.id);
    assert.strictEqual(await contar(conta), 1, 'mesma chave nunca cria outro');

    // A mesma peça de novo, de propósito, é OUTRO envio (outra chave).
    assert.strictEqual((await app.enviar(conta, randomUUID())).status, 201);
    assert.strictEqual(await contar(conta), 2);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('D. resposta perdida depois do commit: o servidor conclui, a chave reconcilia, e o reenvio não duplica', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    const soltar = travar();
    // O navegador desiste no meio do processamento (é o 524 da Cloudflare).
    const aborto = new AbortController();
    const perdido = app.enviar(conta, chave, { sinal: aborto.signal }).catch((e) => e);
    await esperarLinha(conta);
    aborto.abort();
    assert.strictEqual((await perdido).name, 'AbortError');

    // Enquanto processa: a chave diz "processando", e repetir não cria outro.
    assert.deepStrictEqual((await app.envio(conta, chave)).corpo.estado, 'processando');
    const repetidoNoMeio = await app.enviar(conta, chave);
    assert.strictEqual(repetidoNoMeio.status, 202);
    assert.strictEqual(repetidoNoMeio.corpo.processando, true);
    assert.strictEqual(await contar(conta), 1);
    // O card aparece como processando na lista (sem arquivo ainda).
    const durante = await app.lista(conta);
    assert.strictEqual(durante.criativos.length, 1);
    assert.strictEqual(durante.criativos[0].arquivoUrl, null);

    // O servidor termina mesmo sem ninguém ouvindo.
    soltar();
    for (let i = 0; i < 100; i++) {
      if ((await app.envio(conta, chave)).corpo.estado === 'pronto') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.strictEqual((await app.envio(conta, chave)).corpo.estado, 'pronto');
    const reenvio = await app.enviar(conta, chave);
    assert.strictEqual(reenvio.status, 200);
    assert.strictEqual(await contar(conta), 1, 'resposta perdida + reenvio = um criativo só');
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('criativo processando não pode ser excluído; se a linha sumir no meio, o upload nunca responde 201', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  const removidos = [];
  const supabase = require('../src/lib/supabase');
  const storageDeVerdade = Object.getOwnPropertyDescriptor(supabase, 'storage');
  Object.defineProperty(supabase, 'storage', {
    configurable: true,
    get: () => ({ from: () => ({ remove: async (nomes) => removidos.push(...nomes) }) }),
  });
  try {
    let soltar = travar();
    const envio = app.enviar(conta, randomUUID());
    await esperarLinha(conta);
    const [{ id }] = (await pool.query('SELECT id FROM criativos WHERE anunciante_id = $1', [conta.id])).rows;
    const r = await fetch(`${app.base}/anunciantes/${conta.id}/criativos/${id}`, {
      method: 'DELETE',
      headers: { 'x-conta': String(conta.id) },
    });
    assert.strictEqual(r.status, 409, 'excluir no meio do FFmpeg é recusado');
    soltar();
    assert.strictEqual((await envio).status, 201);
    assert.strictEqual(await contar(conta), 1);

    // Rede de segurança: a linha sai por outro caminho no meio do trabalho.
    await pool.query('DELETE FROM criativos WHERE anunciante_id = $1', [conta.id]);
    soltar = travar();
    const outro = app.enviar(conta, randomUUID());
    await esperarLinha(conta);
    const [{ id: idOutro }] = (await pool.query('SELECT id FROM criativos WHERE anunciante_id = $1', [conta.id])).rows;
    await pool.query('DELETE FROM criativos WHERE id = $1', [idOutro]);
    soltar();
    const resposta = await outro;
    assert.strictEqual(resposta.status, 409, 'nunca 201 de um criativo que não existe');
    assert.match(resposta.corpo.erro, /excluído enquanto era processado/);
    assert.deepStrictEqual(
      removidos,
      [`${idOutro}.mp4`, `${idOutro}-thumb.jpg`],
      'arquivos que subiram não ficam órfãos',
    );
  } finally {
    Object.defineProperty(supabase, 'storage', storageDeVerdade);
    await app.fechar();
    await limpar(conta);
  }
});

test('duas requisições com a mesma chave ao mesmo tempo: o índice único deixa uma só criar', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    const soltar = travar();
    const a = app.enviar(conta, chave);
    const b = app.enviar(conta, chave);
    await esperarLinha(conta);
    await new Promise((r) => setTimeout(r, 100));
    soltar();
    const status = [(await a).status, (await b).status];
    const criou = status.indexOf(201);
    assert.ok(criou >= 0, `uma cria (${status})`);
    const outra = status[1 - criou];
    assert.ok(outra === 200 || outra === 202, `a outra devolve o existente (${status})`);
    assert.strictEqual(await contar(conta), 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('F/H. arquivo ilegível e vídeo acima do plano: erro real, nenhuma linha, e a chave continua livre', async () => {
  preparar();
  const conta = await criarConta('essencial-1m'); // até 15 s
  const app = await subirApp();
  try {
    const chave = randomUUID();
    midiaFalsa = null; // ffprobe não leu
    const ilegivel = await app.enviar(conta, chave);
    assert.strictEqual(ilegivel.status, 400);
    assert.match(ilegivel.corpo.erro, /não foi possível ler esse arquivo/);
    assert.strictEqual(await contar(conta), 0);
    assert.strictEqual((await app.envio(conta, chave)).status, 404);

    midiaFalsa = { width: 1080, height: 1920, duracao_segundos: 20, ehImagem: false, quadros: 600, pix_fmt: 'yuv420p' };
    const longo = await app.enviar(conta, randomUUID());
    assert.strictEqual(longo.status, 400);
    assert.match(longo.corpo.erro, /seu plano aceita peça de até 15s/);
    assert.strictEqual(await contar(conta), 0, 'bloqueio de duração do plano continua valendo');
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

// AUD-017: o custo do FFmpeg cresce com os pixels — um PNG de 771 KB em
// 16000x16000 levava 2-3 min e 5-6 GB de RAM numa instância de 1 GB. A
// recusa vem do ffprobe, antes de criar linha e antes do FFmpeg.
test('AUD-017. imagem de 16000x16000 é recusada (400) antes do FFmpeg: normalizar não roda, nenhuma linha', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    midiaFalsa = { width: 16000, height: 16000, duracao_segundos: 10, ehImagem: true };
    const gigante = await app.enviar(conta, randomUUID());
    assert.strictEqual(gigante.status, 400);
    assert.match(gigante.corpo.erro, /imagem grande demais/);
    assert.match(gigante.corpo.erro, /32 megapixels/);
    assert.strictEqual(chamadasNormalizar, 0, 'o FFmpeg não pode nem começar');
    assert.strictEqual(await contar(conta), 0);

    // ffprobe com -max_pixels devolve 0x0 pra imagem acima do teto: também
    // não chega ao FFmpeg.
    midiaFalsa = { width: 0, height: 0, duracao_segundos: 10, ehImagem: true };
    const semDimensao = await app.enviar(conta, randomUUID());
    assert.strictEqual(semDimensao.status, 400);
    assert.match(semDimensao.corpo.erro, /não foi possível ler esse arquivo/);
    assert.strictEqual(chamadasNormalizar, 0);

    // No teto (8000x4000 = 32 MP) ainda passa.
    midiaFalsa = { width: 8000, height: 4000, duracao_segundos: 10, ehImagem: true };
    assert.strictEqual((await app.enviar(conta, randomUUID())).status, 201);
    assert.strictEqual(chamadasNormalizar, 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

// Revisão do AUD-017: com um FFmpeg por vez, o envio espera a vez do ffprobe
// (até o FFmpeg de outro cliente terminar). A linha temporária nascia DEPOIS
// dessa espera: GET /envios/:chave dizia "não chegou" (o painel mostrava
// "nenhum criativo foi criado", falso) e um segundo envio passava pelas
// contagens — dois criativos num plano de uma vaga.
test('AUD-017 (revisão). envio esperando a vez do ffprobe já tem linha: /envios diz processando e o segundo envio esbarra no limite', async () => {
  preparar();
  const conta = await criarConta('essencial-1m'); // limite 1
  const app = await subirApp();
  const chave = randomUUID();
  let soltar = null;
  try {
    let liberar;
    travaProbe = { promessa: new Promise((r) => (liberar = r)) };
    soltar = () => {
      travaProbe = null;
      liberar();
    };
    // Sem catch, uma falha aqui viraria "fetch failed" e esconderia a asserção.
    const resposta = (envio) => envio.catch((err) => ({ status: `falhou: ${err.message}` }));
    const primeiro = resposta(app.enviar(conta, chave));
    await esperarProbe(1);

    const consulta = await app.envio(conta, chave);
    assert.strictEqual(
      consulta.status,
      200,
      `GET /envios respondeu ${consulta.status} enquanto o envio esperava a vez`,
    );
    assert.strictEqual(consulta.corpo.estado, 'processando');

    const segundo = resposta(app.enviar(conta, randomUUID()));
    // Em pé o primeiro: o segundo não pode chegar ao ffprobe.
    await new Promise((r) => setTimeout(r, 200));
    soltar();
    soltar = null;
    const [r1, r2] = await Promise.all([primeiro, segundo]);
    assert.strictEqual(r1.status, 201);
    assert.strictEqual(r2.status, 400, `o segundo envio respondeu ${r2.status}`);
    assert.match(r2.corpo.erro, /seu plano permite até 1/);
    assert.strictEqual(await contar(conta), 1, 'um plano de uma vaga ficou com dois criativos');
  } finally {
    soltar?.();
    await app.fechar();
    await limpar(conta);
  }
});

// A espera na fila tem teto (ffmpeg.js): passou, 503 com a frase da fila —
// não "arquivo inválido" —, a linha temporária sai e a chave fica livre.
test('AUD-017 (revisão). fila cheia no ffprobe ou no FFmpeg: 503, nenhuma linha, e a chave volta a valer', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  const erroFila = () =>
    Object.assign(new Error('muitos envios sendo processados agora — tente de novo'), { status: 503, origem: 'fila' });
  try {
    const chave = randomUUID();
    falhaProbe = erroFila();
    const noProbe = await app.enviar(conta, chave);
    assert.strictEqual(noProbe.status, 503);
    assert.match(noProbe.corpo.erro, /muitos envios/);
    assert.strictEqual(chamadasNormalizar, 0);
    assert.strictEqual(await contar(conta), 0);
    assert.strictEqual((await app.envio(conta, chave)).status, 404);

    falhaProbe = null;
    falhaNormalizar = erroFila();
    const noFfmpeg = await app.enviar(conta, chave);
    assert.strictEqual(noFfmpeg.status, 503);
    assert.match(noFfmpeg.corpo.erro, /muitos envios/);
    assert.strictEqual(await contar(conta), 0);

    falhaNormalizar = null;
    assert.strictEqual((await app.enviar(conta, chave)).status, 201);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

// Revisão do AUD-017: a espera da vez do ffprobe entrava em `ffprobe_ms`, e
// o sinal do RUNBOOK (`fila_ms`) não a mostrava — uma espera de 2 min parecia
// um ffprobe de 2 min. O log traz as duas separadas.
test('AUD-017 (revisão). o log do upload separa a espera da vez do ffprobe (fila_probe_ms) do ffprobe em si', async (t) => {
  preparar();
  temposDoProbe = { fila_probe_ms: 4321, ffprobe_ms: 12 };
  const conta = await criarConta();
  const app = await subirApp();
  const log = t.mock.method(console, 'log', () => {});
  try {
    assert.strictEqual((await app.enviar(conta, randomUUID())).status, 201);
    const linha = log.mock.calls.map((c) => c.arguments).find((a) => a[0] === 'upload de criativo');
    assert.ok(linha, 'sem a linha "upload de criativo" no log');
    const tempos = JSON.parse(linha[1]);
    assert.strictEqual(tempos.fila_probe_ms, 4321, `log: ${linha[1]}`);
    assert.strictEqual(tempos.ffprobe_ms, 12, `log: ${linha[1]}`);
  } finally {
    log.mock.restore();
    await app.fechar();
    await limpar(conta);
  }
});

// Revisão 2 do AUD-017: foto com cabeçalho legível e corpo que não
// decodifica (cortada, corrompida) — o FFmpeg recusa no único quadro que lê
// (ffmpeg.js). O cliente recebe a frase, não o "não foi possível processar"
// genérico, e o log diz o que foi.
test('AUD-017 (revisão 2). imagem que não decodifica: 400 "não conseguimos ler esta imagem", nenhuma linha, log imagem_ilegivel', async (t) => {
  preparar();
  midiaFalsa = { width: 1080, height: 1920, duracao_segundos: 10, ehImagem: true };
  falhaNormalizar = Object.assign(new Error('não conseguimos ler esta imagem — o arquivo parece corrompido'), {
    status: 400,
    origem: 'imagem',
  });
  const conta = await criarConta();
  const app = await subirApp();
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  try {
    const chave = randomUUID();
    const r = await app.enviar(conta, chave);
    assert.strictEqual(r.status, 400);
    assert.match(r.corpo.erro, /não conseguimos ler esta imagem/);
    assert.strictEqual(await contar(conta), 0, 'a linha temporária saiu');
    assert.strictEqual((await app.envio(conta, chave)).status, 404, 'a chave volta a valer');
    const linha = log.mock.calls.map((c) => c.arguments).find((a) => a[0] === 'upload de criativo');
    assert.strictEqual(JSON.parse(linha[1]).resultado, 'imagem_ilegivel', `log: ${linha[1]}`);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

// Revisão 3 do AUD-017: o teto de pixels mede UM quadro, e o FFmpeg processa
// todos — um MP4 de 5,6 MB com 3000 quadros de 7680x4096 (200 fps, 15 s, cabe
// no Essencial) passava em tudo e segurava a única vaga do FFmpeg até o
// SIGKILL dos 15 min; e o vídeo de 10 bits acima de 9 MP (drone 5.1K em HDR)
// estourava o teto de memória DEPOIS de processar o arquivo. Os dois voltam
// 400 com a frase, antes do FFmpeg.
test('AUD-017 (revisão 3). vídeo de quadros demais, ou de 10 bits acima de 9 MP: 400 antes do FFmpeg, nenhuma linha', async () => {
  preparar();
  const conta = await criarConta('essencial-1m'); // até 15 s
  const app = await subirApp();
  try {
    midiaFalsa = {
      width: 7680,
      height: 4096,
      duracao_segundos: 15,
      ehImagem: false,
      quadros: 3000,
      pix_fmt: 'yuv420p',
    };
    const lento = await app.enviar(conta, randomUUID());
    assert.strictEqual(lento.status, 400);
    assert.match(lento.corpo.erro, /vídeo pesado demais pra processar: 3000 quadros de 7680x4096/);

    midiaFalsa = {
      width: 5120,
      height: 2700,
      duracao_segundos: 10,
      ehImagem: false,
      quadros: 300,
      pix_fmt: 'yuv420p10le',
    };
    const hdr = await app.enviar(conta, randomUUID());
    assert.strictEqual(hdr.status, 400);
    assert.match(hdr.corpo.erro, /vídeo de 10 bits \(HDR\) grande demais: 5120x2700/);
    assert.strictEqual(chamadasNormalizar, 0, 'o FFmpeg não pode nem começar');
    assert.strictEqual(await contar(conta), 0);

    // 4K HDR de celular (10 bits, 30 fps, 15 s) passa.
    midiaFalsa = {
      width: 2160,
      height: 3840,
      duracao_segundos: 15,
      ehImagem: false,
      quadros: 450,
      pix_fmt: 'yuv420p10le',
    };
    assert.strictEqual((await app.enviar(conta, randomUUID())).status, 201);
    assert.strictEqual(chamadasNormalizar, 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

// Revisão 3 do AUD-017: o FFmpeg que estoura o teto de memória do processo
// (prlimit) não é "arquivo inválido" — antes o cliente lia "confira se é um
// vídeo válido" e o log dizia falha_midia, sem pista do teto.
test('AUD-017 (revisão 3). FFmpeg sem memória no teto: 400 com a frase dele, nenhuma linha, log teto_memoria', async (t) => {
  preparar();
  falhaNormalizar = Object.assign(
    new Error('esse arquivo pede mais memória do que o servidor reserva pra processá-lo'),
    {
      status: 400,
      origem: 'memoria',
    },
  );
  const conta = await criarConta();
  const app = await subirApp();
  const log = t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'error', () => {});
  try {
    const chave = randomUUID();
    const r = await app.enviar(conta, chave);
    assert.strictEqual(r.status, 400);
    assert.match(r.corpo.erro, /pede mais memória do que o servidor reserva/);
    assert.strictEqual(await contar(conta), 0, 'a linha temporária saiu');
    assert.strictEqual((await app.envio(conta, chave)).status, 404, 'a chave volta a valer');
    const linha = log.mock.calls.map((c) => c.arguments).find((a) => a[0] === 'upload de criativo');
    assert.strictEqual(JSON.parse(linha[1]).resultado, 'teto_memoria', `log: ${linha[1]}`);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('G. Storage fora (502) e FFmpeg que falha: erro real, a linha temporária sai, e tentar de novo funciona', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    const chave = randomUUID();
    falhaNormalizar = Object.assign(new Error('storage caiu'), { origem: 'storage' });
    const storage = await app.enviar(conta, chave);
    assert.strictEqual(storage.status, 502);
    assert.match(storage.corpo.erro, /armazenamento não respondeu/);
    assert.strictEqual(await contar(conta), 0, 'sem criativo fantasma ocupando cota');

    falhaNormalizar = new Error('ffmpeg: arquivo corrompido');
    const ffmpegFalhou = await app.enviar(conta, chave);
    assert.strictEqual(ffmpegFalhou.status, 400);
    assert.strictEqual(await contar(conta), 0);

    // Mesma chave depois das falhas: processa de novo e cria.
    falhaNormalizar = null;
    assert.strictEqual((await app.enviar(conta, chave)).status, 201);
    assert.strictEqual(await contar(conta), 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('repetir um envio concluído com a conta no limite devolve o criativo, não "limite atingido"', async () => {
  preparar();
  const conta = await criarConta('essencial-1m'); // limite 1
  const app = await subirApp();
  try {
    const chave = randomUUID();
    assert.strictEqual((await app.enviar(conta, chave)).status, 201);
    assert.strictEqual((await app.enviar(conta, chave)).status, 200);
    const outro = await app.enviar(conta, randomUUID());
    assert.strictEqual(outro.status, 400, 'limite do plano continua valendo pra envio novo');
    assert.match(outro.corpo.erro, /seu plano permite até 1/);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('chave inválida é recusada; upload sem chave continua funcionando', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    assert.strictEqual((await app.enviar(conta, 'curta')).status, 400);
    assert.strictEqual((await app.envio(conta, 'x;drop')).status, 400);
    assert.strictEqual((await app.enviar(conta, null)).status, 201);
    assert.strictEqual(await contar(conta), 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test('processamento interrompido por restart (linha sem arquivo há mais de 30 min) não fica "processando" pra sempre', async () => {
  preparar();
  const conta = await criarConta();
  const app = await subirApp();
  try {
    await pool.query(
      `INSERT INTO criativos (anunciante_id, arquivo_original_url, created_at)
       VALUES ($1, 'orfa.mp4', now() - interval '31 minutes'), ($1, 'recente.mp4', now() - interval '5 minutes')`,
      [conta.id],
    );
    const lista = await app.lista(conta);
    assert.strictEqual(lista.criativos.length, 1, 'a órfã saiu; a recente (pode estar processando) fica');
    assert.strictEqual(lista.emUso, 1);
  } finally {
    await app.fechar();
    await limpar(conta);
  }
});

test.after(() => pool.end());
