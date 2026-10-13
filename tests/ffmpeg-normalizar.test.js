const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Normalização com o FFmpeg DE VERDADE (estação upload, 27/09/2026): o perfil
// de saída ficou mais rápido (preset veryfast, teto de 30 fps, fundo do
// horizontal desfocado em baixa resolução) e NÃO pode ter mudado o que a TV
// recebe — H.264 Main, 1080x1920, yuv420p, no máximo 30 fps. O Storage é
// falso (guarda os bytes aqui). Sem FFmpeg na máquina (o CI não instala), o
// teste é pulado — a regra fica conferida em quem roda local.

let temFfmpeg = true;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
} catch {
  temFfmpeg = false;
}

const guardados = new Map();
const caminhoSupabase = require.resolve('../src/lib/supabase');
require.cache[caminhoSupabase] = {
  id: caminhoSupabase,
  filename: caminhoSupabase,
  loaded: true,
  exports: {
    storage: {
      from: () => ({
        upload: async (nome, buffer) => {
          guardados.set(nome, buffer);
          return { error: null };
        },
        getPublicUrl: (nome) => ({ data: { publicUrl: `https://storage.teste/${nome}` } }),
      }),
    },
  },
};
const ffmpeg = require('../src/lib/ffmpeg');

function sondar(buffer) {
  const arquivo = path.join(os.tmpdir(), `sonda-${process.pid}-${Date.now()}.mp4`);
  fs.writeFileSync(arquivo, buffer);
  try {
    const saida = execFileSync('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,profile,width,height,pix_fmt,r_frame_rate',
      '-of',
      'json',
      arquivo,
    ]);
    return JSON.parse(saida).streams[0];
  } finally {
    fs.rmSync(arquivo, { force: true });
  }
}

function gerar(nome, argumentos) {
  const arquivo = path.join(os.tmpdir(), `${nome}-${process.pid}.mp4`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...argumentos, arquivo]);
  return arquivo;
}

test('vídeo horizontal a 60 fps sai vertical 1080x1920, H.264 Main, 30 fps, com tempos por etapa', {
  skip: !temFfmpeg,
}, async () => {
  const entrada = gerar('horizontal60', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=60',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
  ]);
  try {
    const r = await ffmpeg.normalizar(entrada, 'teste-horizontal');
    const video = sondar(guardados.get('teste-horizontal.mp4'));
    assert.strictEqual(video.codec_name, 'h264');
    assert.strictEqual(video.profile, 'Main');
    assert.strictEqual(video.width, 1080);
    assert.strictEqual(video.height, 1920);
    assert.strictEqual(video.pix_fmt, 'yuv420p');
    assert.strictEqual(video.r_frame_rate, '30/1', 'fonte a 60 fps sai a 30');
    assert.ok(guardados.has('teste-horizontal-thumb.jpg'));
    assert.match(r.conteudo_sha256, /^[0-9a-f]{64}$/);
    for (const etapa of ['ffmpeg_ms', 'thumb_ms', 'storage_ms']) assert.ok(Number.isFinite(r.tempos[etapa]), etapa);
    // Nada fica pra trás em /tmp.
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'teste-horizontal-normalizado.mp4')));
  } finally {
    fs.rmSync(entrada, { force: true });
  }
});

test('vídeo vertical a 25 fps mantém os 25 fps (o teto só limita)', { skip: !temFfmpeg }, async () => {
  const entrada = gerar('vertical25', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=360x640:rate=25',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
  ]);
  try {
    await ffmpeg.normalizar(entrada, 'teste-vertical');
    const video = sondar(guardados.get('teste-vertical.mp4'));
    assert.strictEqual(video.width, 1080);
    assert.strictEqual(video.height, 1920);
    assert.strictEqual(video.r_frame_rate, '25/1');
  } finally {
    fs.rmSync(entrada, { force: true });
  }
});

// AUD-017: o ffprobe roda com -max_pixels — acima do teto ele não decodifica
// a imagem inteira (PNG de 256 MP: 781 MB), o tamanho vem do aviso dele, e a
// recusa vem antes do FFmpeg, inclusive pra quem chama normalizar sem
// conferir.
test('teto de resolução: PNG de 36 MP é recusado pelo ffprobe real, sem FFmpeg', { skip: !temFfmpeg }, async () => {
  const png = path.join(os.tmpdir(), `teto-${process.pid}.png`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=6000x6000', '-frames:v', '1', png]);
  try {
    const midia = await ffmpeg.probeMidia(png);
    assert.deepStrictEqual([midia.width, midia.height, midia.ehImagem], [6000, 6000, true]);
    assert.match(ffmpeg.recusaPorCusto(midia), /imagem grande demais: 6000x6000 \(36 megapixels\).*32 megapixels/);
    const err = await ffmpeg.normalizar(png, 'teste-teto').catch((e) => e);
    assert.strictEqual(err.status, 400);
    assert.ok(!guardados.has('teste-teto.mp4'), 'o FFmpeg não rodou');
    // Sem dimensão (arquivo truncado) também não roda; no teto, passa.
    assert.match(ffmpeg.recusaPorCusto({ width: 0, height: 0, ehImagem: true }), /não foi possível ler/);
    assert.strictEqual(ffmpeg.recusaPorCusto({ width: 8000, height: 4000, ehImagem: true }), null);
  } finally {
    fs.rmSync(png, { force: true });
  }
});

// Cor do centro de cada quadro do MP4 normalizado: os arquivos abaixo têm o
// conteúdo medido pelo ffprobe em vermelho e o gigante em azul.
function coresDosQuadros(buffer) {
  const arquivo = path.join(os.tmpdir(), `cores-${process.pid}-${Date.now()}.mp4`);
  fs.writeFileSync(arquivo, buffer);
  try {
    const px = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      arquivo,
      '-vf',
      'crop=2:2:539:959,scale=1:1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      '-',
    ]);
    const cores = { vermelho: 0, azul: 0 };
    for (let i = 0; i + 2 < px.length; i += 3) {
      if (px[i] > 150 && px[i + 2] < 100) cores.vermelho += 1;
      if (px[i + 2] > 150 && px[i] < 100) cores.azul += 1;
    }
    return cores;
  } finally {
    fs.rmSync(arquivo, { force: true });
  }
}

// Revisão do AUD-017: o ffprobe mede o primeiro stream de vídeo no começo do
// arquivo; o FFmpeg do normalizar escolhia o stream de MAIOR resolução e
// decodificava sem teto (v:1 de 16000x16000: 1,6 GB). Aqui o v:1 tem 36 MP,
// acima do teto, e não pode chegar à saída.
test('teto no FFmpeg: MKV com um segundo stream acima do teto processa só o stream medido', {
  skip: !temFfmpeg,
}, async () => {
  const mkv = path.join(os.tmpdir(), `dois-streams-${process.pid}.mkv`);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=red:s=320x240:r=1',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=6000x6000:r=1',
    '-t',
    '4',
    '-map',
    '0',
    '-map',
    '1',
    '-c:v',
    'png',
    mkv,
  ]);
  try {
    const midia = await ffmpeg.probeMidia(mkv);
    assert.deepStrictEqual([midia.width, midia.height], [320, 240], 'o ffprobe mede o v:0');
    assert.strictEqual(ffmpeg.recusaPorCusto(midia), null);
    await ffmpeg.normalizar(mkv, 'teste-dois-streams', null, midia);
    const cores = coresDosQuadros(guardados.get('teste-dois-streams.mp4'));
    assert.strictEqual(cores.azul, 0, `o stream de 36 MP foi decodificado: ${JSON.stringify(cores)}`);
    assert.ok(cores.vermelho > 0, JSON.stringify(cores));
  } finally {
    fs.rmSync(mkv, { force: true });
  }
});

// Mesmo furo com um stream só: o ffprobe lê o começo (320x240) e o quadro
// cresce para 36 MP a partir do terceiro.
test('teto no FFmpeg: quadro que cresce acima do teto no meio do stream não é decodificado', {
  skip: !temFfmpeg,
}, async () => {
  const base = path.join(os.tmpdir(), `muda-tamanho-${process.pid}`);
  const lista = `${base}.txt`;
  const mkv = `${base}.mkv`;
  const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  try {
    ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=1', '-frames:v', '2', '-c:v', 'png', `${base}-a.mkv`]);
    ff(['-f', 'lavfi', '-i', 'color=c=blue:s=6000x6000:r=1', '-frames:v', '3', '-c:v', 'png', `${base}-b.mkv`]);
    fs.writeFileSync(lista, `file '${base}-a.mkv'\nfile '${base}-b.mkv'\n`);
    ff(['-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', mkv]);
    const midia = await ffmpeg.probeMidia(mkv);
    assert.deepStrictEqual([midia.width, midia.height], [320, 240], 'o ffprobe só vê o começo');
    await ffmpeg.normalizar(mkv, 'teste-muda-tamanho', null, midia);
    const cores = coresDosQuadros(guardados.get('teste-muda-tamanho.mp4'));
    assert.strictEqual(cores.azul, 0, `os quadros de 36 MP foram decodificados: ${JSON.stringify(cores)}`);
    assert.ok(cores.vermelho > 0, JSON.stringify(cores));
  } finally {
    for (const f of [lista, mkv, `${base}-a.mkv`, `${base}-b.mkv`]) fs.rmSync(f, { force: true });
  }
});

// O decodificador confere a largura alinhada a 64: o teto do FFmpeg tem
// folga pra foto no limite (6532 → 6592) — sem ela o -loop 1 girava até o
// timeout —, e a recusa faz a mesma conta (imagem estreita e altíssima, que
// o decodificador recusaria, é barrada antes).
test('teto no limite: foto de 31,99 MP com largura fora do múltiplo de 64 normaliza; estreita e alta é recusada', {
  skip: !temFfmpeg,
}, async () => {
  const jpg = path.join(os.tmpdir(), `limite-${process.pid}.jpg`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=6532x4898', '-frames:v', '1', jpg]);
  try {
    const midia = await ffmpeg.probeMidia(jpg);
    assert.strictEqual(ffmpeg.recusaPorCusto(midia), null);
    const r = await ffmpeg.normalizar(jpg, 'teste-limite', 2, midia);
    assert.strictEqual(r.duracao_segundos, 2);
    const video = sondar(guardados.get('teste-limite.mp4'));
    assert.deepStrictEqual([video.width, video.height], [1080, 1920]);
    assert.match(
      ffmpeg.recusaPorCusto({ width: 100, height: 320000, ehImagem: true }),
      /imagem estreita demais pra altura: 100x320000/,
    );
  } finally {
    fs.rmSync(jpg, { force: true });
  }
});

test('um FFmpeg por vez: a segunda normalização simultânea espera a primeira terminar', {
  skip: !temFfmpeg,
}, async () => {
  const entrada = gerar('fila', ['-f', 'lavfi', '-i', 'testsrc2=size=360x640:rate=25', '-t', '2', '-c:v', 'libx264']);
  const midia = { width: 360, height: 640, duracao_segundos: 2, ehImagem: false, quadros: 50 };
  try {
    const [primeira, segunda] = await Promise.all([
      ffmpeg.normalizar(entrada, 'teste-fila-1', null, midia),
      ffmpeg.normalizar(entrada, 'teste-fila-2', null, midia),
    ]);
    assert.ok(primeira.tempos.fila_ms < primeira.tempos.ffmpeg_ms, 'a primeira não espera');
    assert.ok(
      segunda.tempos.fila_ms >= primeira.tempos.ffmpeg_ms,
      `a segunda esperou ${segunda.tempos.fila_ms} ms; o FFmpeg da primeira levou ${primeira.tempos.ffmpeg_ms} ms`,
    );
  } finally {
    fs.rmSync(entrada, { force: true });
  }
});

// Revisão do AUD-017: a linha "processando" do upload nasce antes da fila, e
// o descarte de órfãs a apaga aos 30 min. A espera tem teto (5 min): passou,
// 503 com a frase da fila em vez de seguir esperando — e a vaga não vaza.
test('fila com teto: quem espera mais de 5 min pela vez volta com 503, e a vaga não vaza', {
  skip: !temFfmpeg,
}, async (t) => {
  const entrada = gerar('fila-teto', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=360x640:rate=25',
    '-t',
    '2',
    '-c:v',
    'libx264',
  ]);
  const midia = { width: 360, height: 640, duracao_segundos: 2, ehImagem: false, quadros: 50 };
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    // Pega a vaga na hora (com `probado`, normalizar não passa pelo ffprobe).
    const ocupando = ffmpeg.normalizar(entrada, 'teste-fila-teto', null, midia);
    const esperando = ffmpeg.probeMidia(entrada).catch((e) => e);
    t.mock.timers.tick(5 * 60 * 1000);
    const err = await esperando;
    assert.strictEqual(err.status, 503, `a espera não tem teto: ${JSON.stringify(err)}`);
    assert.strictEqual(err.origem, 'fila');
    assert.match(err.message, /muitos envios sendo processados agora/);
    t.mock.timers.reset();
    await ocupando;
    // A vaga voltou: o próximo entra sem esperar.
    assert.strictEqual((await ffmpeg.probeMidia(entrada)).width, 360);
  } finally {
    fs.rmSync(entrada, { force: true });
  }
});

// Revisão do AUD-017: a espera da vez do ffprobe vai pra `fila_probe_ms`, e
// `ffprobe_ms` é só o ffprobe — somadas, a espera parecia um ffprobe lento.
test('ffprobe na fila: a espera da vez vai pra fila_probe_ms, não pra ffprobe_ms', { skip: !temFfmpeg }, async () => {
  const entrada = gerar('fila-probe', [
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=360x640:rate=25',
    '-t',
    '2',
    '-c:v',
    'libx264',
  ]);
  const midia = { width: 360, height: 640, duracao_segundos: 2, ehImagem: false, quadros: 50 };
  try {
    const ocupando = ffmpeg.normalizar(entrada, 'teste-fila-probe', null, midia);
    const tempos = {};
    await ffmpeg.probeMidia(entrada, tempos);
    const { tempos: doFfmpeg } = await ocupando;
    assert.ok(
      tempos.fila_probe_ms >= doFfmpeg.ffmpeg_ms,
      `esperou ${tempos.fila_probe_ms} ms; o FFmpeg que ocupava a vaga levou ${doFfmpeg.ffmpeg_ms} ms`,
    );
    assert.ok(tempos.ffprobe_ms < tempos.fila_probe_ms, JSON.stringify(tempos));
  } finally {
    fs.rmSync(entrada, { force: true });
  }
});

// Revisão 2 do AUD-017: PNG com o cabeçalho certo e o corpo que não
// decodifica passa no ffprobe e no teto de pixels. Com `-loop 1` na foto do
// cliente o FFmpeg relia o arquivo a cada quadro — cortado, o parser acumulava
// o arquivo a cada volta (1 GB em segundos, 2 GB até o kill); corrompido,
// girava até o timeout de 15 min segurando a vaga da fila. Decodificada uma
// vez só, a imagem falha na hora, com a frase. Sem extensão, como o multer
// grava: o FFmpeg lê pelo demuxer png_pipe, o caminho da produção.
test('imagem com cabeçalho legível e corpo que não decodifica: 400 em segundos, sem girar no -loop 1', {
  skip: !temFfmpeg,
  timeout: 30_000,
}, async () => {
  const base = path.join(os.tmpdir(), `ilegivel-${process.pid}`);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1080x1920',
    '-frames:v',
    '1',
    `${base}.png`,
  ]);
  const inteira = fs.readFileSync(`${base}.png`);
  // Download interrompido: os primeiros 20 KB de 245 KB.
  fs.writeFileSync(`${base}-cortada`, inteira.subarray(0, 20_000));
  // 64 bytes do IDAT trocados: o zlib recusa ("inflate returned error -3").
  const corrompida = Buffer.from(inteira);
  const idat = corrompida.indexOf('IDAT') + 4 + 64;
  for (let i = idat; i < idat + 64; i++) corrompida[i] ^= 0xff;
  fs.writeFileSync(`${base}-corrompida`, corrompida);
  try {
    for (const tipo of ['cortada', 'corrompida']) {
      const midia = await ffmpeg.probeMidia(`${base}-${tipo}`);
      assert.deepStrictEqual(
        [midia.width, midia.height, midia.ehImagem],
        [1080, 1920, true],
        'o ffprobe lê o cabeçalho',
      );
      assert.strictEqual(ffmpeg.recusaPorCusto(midia), null);
      const inicio = Date.now();
      const err = await ffmpeg.normalizar(`${base}-${tipo}`, `teste-ilegivel-${tipo}`, 10, midia).catch((e) => e);
      const ms = Date.now() - inicio;
      assert.strictEqual(err.status, 400, `${tipo}: ${err.message}`);
      assert.strictEqual(err.origem, 'imagem');
      assert.match(err.message, /não conseguimos ler esta imagem/);
      assert.ok(ms < 10_000, `${tipo}: levou ${ms} ms`);
      assert.ok(!guardados.has(`teste-ilegivel-${tipo}.mp4`));
      const sobras = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`teste-ilegivel-${tipo}-`));
      assert.deepStrictEqual(sobras, [], 'os temporários saíram');
    }
  } finally {
    for (const f of [`${base}.png`, `${base}-cortada`, `${base}-corrompida`]) fs.rmSync(f, { force: true });
  }
});

// O ffmpeg.js lê o `execFile` quando carrega: aqui ele é carregado de novo
// com um falso, que grava o que seria executado e responde como o processo
// (o FFmpeg grava o arquivo de saída, o último argumento). Roda no CI, sem
// FFmpeg. `falhar(args)`: o erro com que o processo responde, ou null.
function ffmpegComExecFalso({ temPrlimit, saneamentoSemQuadro = false, falhar = () => null }) {
  const childProcess = require('node:child_process');
  const caminho = require.resolve('../src/lib/ffmpeg');
  const anteriores = { execFile: childProcess.execFile, modulo: require.cache[caminho] };
  const chamadas = [];
  childProcess.execFile = (arquivo, args, opcoes, responder) => {
    chamadas.push({ arquivo, args, opcoes });
    if (arquivo === 'prlimit' && !temPrlimit) {
      return responder(Object.assign(new Error('spawn prlimit ENOENT'), { code: 'ENOENT' }));
    }
    const programa = arquivo === 'prlimit' ? args[args.indexOf('--') + 1] : arquivo;
    if (args.at(-1) === '-version') return responder(null, { stdout: `${programa} version 5.1`, stderr: '' });
    if (programa === 'ffprobe') {
      const info = {
        streams: [{ width: 1080, height: 1920, pix_fmt: 'rgb24', nb_read_packets: '1' }],
        format: { format_name: 'png_pipe' },
      };
      return responder(null, { stdout: JSON.stringify(info), stderr: '' });
    }
    const erro = falhar(args);
    if (erro) return responder(erro);
    // Há versão do FFmpeg que sai com 0 sem gravar nada quando o quadro não
    // decodifica ("Output file is empty").
    if (!(saneamentoSemQuadro && args.includes('-frames:v'))) fs.writeFileSync(args[args.length - 1], 'saída');
    return responder(null, { stdout: '', stderr: '' });
  };
  delete require.cache[caminho];
  try {
    return { modulo: require(caminho), chamadas };
  } finally {
    childProcess.execFile = anteriores.execFile;
    require.cache[caminho] = anteriores.modulo;
  }
}

test('com prlimit: ffprobe e FFmpeg nascem com teto de memória e CPU do sistema; a imagem é decodificada uma vez', async () => {
  const { modulo, chamadas } = ffmpegComExecFalso({ temPrlimit: true });
  const foto = await modulo.probeMidia('/tmp/foto-do-cliente');
  await modulo.normalizar('/tmp/foto-do-cliente', `teste-prlimit-${process.pid}`, 15, foto);
  await modulo.normalizar('/tmp/video-do-cliente', `teste-prlimit-video-${process.pid}`, null, {
    width: 1080,
    height: 1920,
    duracao_segundos: 20,
    ehImagem: false,
    quadros: 600,
  });
  // Confere uma vez, rodando o próprio ffprobe com o teto dele.
  const [conferencia, ...processos] = chamadas;
  assert.strictEqual(conferencia.arquivo, 'prlimit');
  assert.deepStrictEqual(conferencia.args.slice(2), ['--', 'ffprobe', '-version']);
  assert.strictEqual(conferencia.args[0], processos[0].args[0], 'com o mesmo teto do ffprobe');
  const programa = (c) => c.args[c.args.indexOf('--') + 1];
  assert.deepStrictEqual(processos.map(programa), ['ffprobe', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg', 'ffmpeg']);
  for (const c of processos) {
    assert.strictEqual(c.arquivo, 'prlimit', 'o processo nasce pelo prlimit');
    assert.match(c.args[0], /^--as=\d+$/);
    assert.strictEqual(c.args[1], `--cpu=${c.opcoes.timeout / 1000}`, 'CPU nos mesmos segundos do timeout');
    assert.strictEqual(c.args[2], '--');
    assert.strictEqual(c.opcoes.killSignal, 'SIGKILL');
    assert.strictEqual(c.opcoes.env.MALLOC_ARENA_MAX, '1', 'uma arena só: o --as mede o trabalho, não reservas');
  }
  const memoria = (c) => Number(c.args[0].slice('--as='.length));
  assert.ok(memoria(processos[0]) < memoria(processos[1]), 'o ffprobe tem teto menor que o FFmpeg');
  assert.ok(memoria(processos[1]) < 1024 ** 3, 'abaixo do 1 GB da instância');

  // Imagem: um quadro só da foto do cliente, e o vídeo sai do BMP saneado.
  const [saneamento, deImagem, , deVideo] = processos.slice(1).map((c) => c.args.slice(3));
  assert.strictEqual(saneamento[saneamento.indexOf('-i') + 1], '/tmp/foto-do-cliente');
  assert.strictEqual(saneamento[saneamento.indexOf('-frames:v') + 1], '1');
  assert.ok(!saneamento.includes('-loop'), 'a foto do cliente não entra no -loop');
  const saneada = saneamento.at(-1);
  assert.strictEqual(deImagem[deImagem.indexOf('-i') + 1], saneada, 'o -loop 1 relê o BMP saneado');
  assert.strictEqual(deImagem[deImagem.indexOf('-loop') + 1], '1');
  assert.strictEqual(deImagem[deImagem.indexOf('-t') + 1], '15');
  assert.ok(!fs.existsSync(saneada), 'o BMP saneado saiu de /tmp');
  assert.strictEqual(deVideo[deVideo.indexOf('-i') + 1], '/tmp/video-do-cliente');
  // Imagem tem timeouts próprios, mais curtos que o do vídeo.
  const [, tSaneamento, tImagem, , tVideo] = processos.map((c) => c.opcoes.timeout);
  assert.ok(tSaneamento < tImagem && tImagem < tVideo, JSON.stringify({ tSaneamento, tImagem, tVideo }));
});

test('saneamento que sai com 0 sem gravar o quadro também é imagem ilegível, e o vídeo não roda', async () => {
  const { modulo, chamadas } = ffmpegComExecFalso({ temPrlimit: true, saneamentoSemQuadro: true });
  const foto = await modulo.probeMidia('/tmp/foto-vazia');
  const err = await modulo.normalizar('/tmp/foto-vazia', `teste-sem-quadro-${process.pid}`, 10, foto).catch((e) => e);
  assert.strictEqual(err.status, 400);
  assert.strictEqual(err.origem, 'imagem');
  assert.match(err.message, /não conseguimos ler esta imagem/);
  assert.ok(!chamadas.some((c) => c.args.includes('-loop')), 'nenhum -loop sem o quadro saneado');
});

test('sem prlimit no PATH: roda direto, avisa uma vez por processo, e o upload segue', async (t) => {
  const aviso = t.mock.method(console, 'warn', () => {});
  const { modulo, chamadas } = ffmpegComExecFalso({ temPrlimit: false });
  await Promise.all([modulo.probeMidia('/tmp/a'), modulo.probeMidia('/tmp/b')]);
  const r = await modulo.normalizar('/tmp/a', `teste-sem-prlimit-${process.pid}`, null, {
    width: 1080,
    height: 1920,
    duracao_segundos: 5,
    ehImagem: false,
    quadros: 150,
  });
  assert.match(r.conteudo_sha256, /^[0-9a-f]{64}$/);
  assert.strictEqual(chamadas.filter((c) => c.arquivo === 'prlimit').length, 1, 'conferido uma vez');
  assert.deepStrictEqual(
    chamadas.filter((c) => c.arquivo !== 'prlimit').map((c) => c.arquivo),
    ['ffprobe', 'ffprobe', 'ffmpeg', 'ffmpeg'],
  );
  assert.strictEqual(aviso.mock.callCount(), 1);
  assert.match(aviso.mock.calls[0].arguments[0], /prlimit indisponível \(ENOENT\)/);
});

// Revisão 3 do AUD-017: o teto de pixels mede UM quadro, e o FFmpeg decodifica
// e enquadra todos. O custo é quadros × pixels (quadro pequeno conta como a
// tela, 1080x1920, que o filtro monta de qualquer jeito); vídeo de 10 bits
// acima de 9 MP não cabe no teto de memória; e vídeo sem quadros contados ou
// sem duração não se lê. Função pura: roda no CI.
test('recusa por custo: quadros × pixels, 10 bits acima de 9 MP e vídeo sem quadros ou sem duração', () => {
  const video = (campos) => ({ ehImagem: false, duracao_segundos: 30, pix_fmt: 'yuv420p', ...campos });
  const quatroK = video({ width: 3840, height: 2160 });
  assert.strictEqual(ffmpeg.recusaPorCusto({ ...quatroK, quadros: 1800 }), null, '4K a 30 fps por 60 s cabe');
  assert.strictEqual(ffmpeg.recusaPorCusto({ ...quatroK, quadros: 2400 }), null, '4K a 60 fps por 40 s cabe');
  assert.match(
    ffmpeg.recusaPorCusto({ ...quatroK, quadros: 3600 }),
    /vídeo pesado demais pra processar: 3600 quadros de 3840x2160/,
  );
  // O arquivo do revisor: 3000 quadros de 7680x4096 (200 fps, 15 s, 5,6 MB).
  assert.match(ffmpeg.recusaPorCusto(video({ width: 7680, height: 4096, quadros: 3000 })), /pesado demais/);
  // Quadro miúdo a 1000 fps: cada um passa pelo filtro que monta 1080x1920.
  assert.match(ffmpeg.recusaPorCusto(video({ width: 320, height: 240, quadros: 10000 })), /pesado demais/);
  assert.strictEqual(ffmpeg.recusaPorCusto(video({ width: 1080, height: 1920, quadros: 3600 })), null);
  // 10 bits (HDR): 4K passa; 5.1K de drone e 7680x4096 não.
  for (const pix_fmt of ['yuv420p10le', 'yuv422p10le', 'p010le', 'yuv444p12le']) {
    assert.strictEqual(ffmpeg.recusaPorCusto({ ...quatroK, quadros: 900, pix_fmt }), null, pix_fmt);
    assert.match(
      ffmpeg.recusaPorCusto(video({ width: 5120, height: 2700, quadros: 60, pix_fmt })),
      /vídeo de 10 bits \(HDR\) grande demais: 5120x2700 \(14 megapixels\).*9 megapixels/,
      pix_fmt,
    );
  }
  // RGB empacotado em 16 bits por pixel é 8 bits (ou menos) por amostra.
  assert.strictEqual(
    ffmpeg.recusaPorCusto(video({ width: 5120, height: 2700, quadros: 60, pix_fmt: 'rgb565le' })),
    null,
  );
  // Foto de 16 bits no teto de 32 MP passa: decodificada uma vez só.
  assert.strictEqual(
    ffmpeg.recusaPorCusto({ width: 8000, height: 4000, ehImagem: true, quadros: 1, pix_fmt: 'rgba64be' }),
    null,
  );
  // Sem quadros contados, ou sem duração (WebM do navegador, H.264 cru): não se lê.
  for (const campos of [
    { quadros: undefined },
    { quadros: Number.NaN },
    { quadros: 0 },
    { duracao_segundos: Number.NaN },
  ]) {
    assert.match(
      ffmpeg.recusaPorCusto(video({ width: 1080, height: 1920, quadros: 300, ...campos })),
      /não foi possível ler esse arquivo/,
      JSON.stringify(campos),
    );
  }
});

// O arquivo da revisão 3 de verdade: MP4 de 7680x4096 a 200 fps, 1000 quadros
// (20 codificados e repetidos por cópia), 5 s. O ffprobe conta os pacotes sem
// decodificar, e a recusa vem antes do FFmpeg — também pra quem chama
// normalizar sem conferir.
test('vídeo de 7680x4096 a 200 fps: o ffprobe conta 1000 quadros e a recusa vem antes do FFmpeg', {
  skip: !temFfmpeg,
}, async () => {
  const base = path.join(os.tmpdir(), `lento-${process.pid}`);
  const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
  ff(
    ['-f', 'lavfi', '-i', 'color=c=red:s=7680x4096:r=200', '-frames:v', '20', '-c:v', 'libx264'].concat([
      '-preset',
      'ultrafast',
      '-threads',
      '1',
      '-f',
      'mp4',
      `${base}-20`,
    ]),
  );
  ff(['-stream_loop', '49', '-i', `${base}-20`, '-c', 'copy', '-f', 'mp4', base]);
  try {
    const midia = await ffmpeg.probeMidia(base);
    assert.deepStrictEqual(
      [midia.width, midia.height, midia.quadros, midia.duracao_segundos, midia.ehImagem],
      [7680, 4096, 1000, 5, false],
    );
    assert.match(ffmpeg.recusaPorCusto(midia), /vídeo pesado demais pra processar: 1000 quadros de 7680x4096/);
    const err = await ffmpeg.normalizar(base, 'teste-lento', null, midia).catch((e) => e);
    assert.strictEqual(err.status, 400);
    assert.match(err.message, /pesado demais/);
    assert.ok(!guardados.has('teste-lento.mp4'), 'o FFmpeg não rodou');
  } finally {
    for (const f of [base, `${base}-20`]) fs.rmSync(f, { force: true });
  }
});

// Revisão 3 do AUD-017: HEVC Main10 5120x2700 (drone 5.1K em HDR) passava no
// teto de 32 MP e morria por falta de memória no teto do processo DEPOIS de
// processar o arquivo, com a frase de arquivo inválido. O ffprobe dá o pix_fmt
// e a recusa vem antes; o 4K de 10 bits (HDR de celular) passa.
test('vídeo de 10 bits: 5120x2700 recusado antes do FFmpeg, 4K passa', { skip: !temFfmpeg }, async () => {
  const base = path.join(os.tmpdir(), `hdr-${process.pid}`);
  const gerar10Bits = (tamanho, arquivo) =>
    execFileSync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=red:s=${tamanho}`,
      '-frames:v',
      '1',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-x265-params',
      'log-level=error',
      '-pix_fmt',
      'yuv420p10le',
      '-f',
      'mp4',
      arquivo,
    ]);
  gerar10Bits('5120x2700', `${base}-5k`);
  gerar10Bits('3840x2160', `${base}-4k`);
  try {
    const midia5k = await ffmpeg.probeMidia(`${base}-5k`);
    assert.strictEqual(midia5k.pix_fmt, 'yuv420p10le');
    assert.match(ffmpeg.recusaPorCusto(midia5k), /vídeo de 10 bits \(HDR\) grande demais: 5120x2700/);
    const err = await ffmpeg.normalizar(`${base}-5k`, 'teste-hdr-5k', null, midia5k).catch((e) => e);
    assert.strictEqual(err.status, 400);
    assert.ok(!guardados.has('teste-hdr-5k.mp4'), 'o FFmpeg não rodou');
    assert.strictEqual(ffmpeg.recusaPorCusto(await ffmpeg.probeMidia(`${base}-4k`)), null);
  } finally {
    for (const f of [`${base}-5k`, `${base}-4k`]) fs.rmSync(f, { force: true });
  }
});

// Revisão 3 do AUD-017: a peça feita de foto sai convertida em BT.709 e
// marcada assim. O BMP saneado é RGB; sem dizer a matriz, o swscale convertia
// em BT.601 e a saída nascia sem marca — o player que trata HD sem marca como
// BT.709 mostrava o vermelho (224,16,32) como (239,37,28).
test('foto vira vídeo marcado em BT.709 (tv), com a cor certa lida assim', { skip: !temFfmpeg }, async () => {
  const jpg = path.join(os.tmpdir(), `cor-${process.pid}.jpg`);
  const saida = path.join(os.tmpdir(), `cor-saida-${process.pid}.mp4`);
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0xE01020:s=1080x1920',
    '-frames:v',
    '1',
    jpg,
  ]);
  try {
    await ffmpeg.normalizar(jpg, 'teste-cor', 2, await ffmpeg.probeMidia(jpg));
    fs.writeFileSync(saida, guardados.get('teste-cor.mp4'));
    const lido = JSON.parse(
      execFileSync('ffprobe', [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=color_space,color_range',
        '-of',
        'json',
        saida,
      ]),
    ).streams[0];
    assert.deepStrictEqual([lido.color_space, lido.color_range], ['bt709', 'tv']);
    const filtro = 'crop=2:2:539:959,scale=1:1:in_color_matrix=bt709:in_range=tv,format=rgb24';
    const pixel = [
      ...execFileSync('ffmpeg', ['-v', 'error', '-i', saida, '-frames:v', '1', '-vf', filtro, '-f', 'rawvideo', '-']),
    ];
    assert.ok(
      pixel.every((v, i) => Math.abs(v - [224, 16, 32][i]) <= 4),
      `lido como BT.709: ${pixel} (a foto é 224,16,32)`,
    );
  } finally {
    for (const f of [jpg, saida]) fs.rmSync(f, { force: true });
  }
});

// Revisão 3 do AUD-017 (argumentos, roda no CI): o vídeo sai cortado na
// duração lida + 1 s (opção de SAÍDA) — um MKV com a duração do contêiner
// forjada em 10 s e 600 s de áudio saía com 600 s —, e o vídeo da foto é
// convertido e marcado em BT.709.
test('vídeo cortado na duração lida (+1 s); a foto vira vídeo em BT.709 marcado', async () => {
  const { modulo, chamadas } = ffmpegComExecFalso({ temPrlimit: true });
  await modulo.normalizar('/tmp/video-do-cliente', `teste-duracao-${process.pid}`, null, {
    width: 1080,
    height: 1920,
    duracao_segundos: 10,
    ehImagem: false,
    quadros: 300,
  });
  const foto = await modulo.probeMidia('/tmp/foto-do-cliente');
  await modulo.normalizar('/tmp/foto-do-cliente', `teste-cor-${process.pid}`, 15, foto);
  const video = chamadas.find((c) => c.args.includes('/tmp/video-do-cliente')).args;
  assert.ok(video.indexOf('-t') > video.indexOf('-i'), 'o -t é opção de saída');
  assert.strictEqual(video[video.indexOf('-t') + 1], '11');
  const deFoto = chamadas.find((c) => c.args.includes('-loop')).args;
  assert.strictEqual(deFoto[deFoto.indexOf('-vf') + 1], 'scale=out_color_matrix=bt709:out_range=tv');
  assert.strictEqual(deFoto[deFoto.indexOf('-colorspace') + 1], 'bt709');
  assert.strictEqual(deFoto[deFoto.indexOf('-color_range') + 1], 'tv');
});

// Revisão 3 do AUD-017: estourar o teto de memória do processo não é arquivo
// ruim. Abaixo do teto o FFmpeg morre com "Cannot allocate memory" (ENOMEM,
// saída 244), "malloc of size N failed" (x264), saída 245 ou SIGSEGV (medido
// em 12/10/2026): o erro sai com origem 'memoria' e a frase do teto —
// na foto também, que não é "ilegível". Sem prlimit não há teto: é queda.
test('teto de memória: ENOMEM, malloc do x264 ou SIGSEGV viram origem memoria com a frase; sem prlimit, não', async (t) => {
  const video = { width: 3840, height: 2160, duracao_segundos: 20, ehImagem: false, quadros: 600 };
  const falhaDoFfmpeg = (campos) => Object.assign(new Error('Command failed: prlimit ... ffmpeg'), campos);
  const casos = [
    falhaDoFfmpeg({ code: 244, stderr: '[hevc @ 0x1] Cannot allocate memory\nConversion failed!' }),
    falhaDoFfmpeg({ code: 187, stderr: '[libx264 @ 0x1] malloc of size 33177600 failed\nConversion failed!' }),
    falhaDoFfmpeg({ code: null, signal: 'SIGSEGV', stderr: 'Stream mapping:' }),
    falhaDoFfmpeg({ code: 245, stderr: 'Conversion failed!' }),
  ];
  for (const erro of casos) {
    const { modulo } = ffmpegComExecFalso({
      temPrlimit: true,
      falhar: (args) => (args.includes('/tmp/video-grande') ? erro : null),
    });
    const err = await modulo
      .normalizar('/tmp/video-grande', `teste-memoria-${process.pid}`, null, video)
      .catch((e) => e);
    assert.strictEqual(err.origem, 'memoria', erro.stderr);
    assert.strictEqual(err.status, 400);
    assert.match(err.message, /pede mais memória do que o servidor reserva/);
    assert.strictEqual(err.cause, erro, 'a causa vai pro log');
  }
  const { modulo: comFoto } = ffmpegComExecFalso({
    temPrlimit: true,
    falhar: (args) => (args.includes('-frames:v') && args.includes('/tmp/foto-grande') ? casos[0] : null),
  });
  const foto = await comFoto.probeMidia('/tmp/foto-grande');
  const errFoto = await comFoto
    .normalizar('/tmp/foto-grande', `teste-memoria-foto-${process.pid}`, 10, foto)
    .catch((e) => e);
  assert.strictEqual(errFoto.origem, 'memoria', 'teto de memória na foto não é imagem ilegível');
  // Arquivo ruim continua arquivo ruim.
  const ruim = falhaDoFfmpeg({ code: 183, stderr: 'Invalid data found when processing input' });
  const { modulo: comRuim } = ffmpegComExecFalso({
    temPrlimit: true,
    falhar: (args) => (args.includes('/tmp/video-ruim') ? ruim : null),
  });
  assert.strictEqual(
    await comRuim.normalizar('/tmp/video-ruim', `teste-ruim-${process.pid}`, null, video).catch((e) => e),
    ruim,
  );
  const { modulo: semTeto } = ffmpegComExecFalso({
    temPrlimit: false,
    falhar: (args) => (args.includes('/tmp/video-grande') ? casos[2] : null),
  });
  t.mock.method(console, 'warn', () => {});
  const queda = await semTeto
    .normalizar('/tmp/video-grande', `teste-queda-${process.pid}`, null, video)
    .catch((e) => e);
  assert.strictEqual(queda, casos[2], 'sem prlimit, SIGSEGV é queda, não teto');
});

test('falha no FFmpeg limpa os temporários e devolve os tempos no erro', { skip: !temFfmpeg }, async () => {
  const lixo = path.join(os.tmpdir(), `lixo-${process.pid}.mp4`);
  fs.writeFileSync(lixo, 'isto não é vídeo');
  try {
    const err = await ffmpeg
      .normalizar(lixo, 'teste-lixo', null, {
        width: 1080,
        height: 1920,
        duracao_segundos: 5,
        ehImagem: false,
        quadros: 150,
      })
      .catch((e) => e);
    assert.ok(err instanceof Error);
    assert.ok(Number.isFinite(err.tempos.ffmpeg_ms));
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'teste-lixo-normalizado.mp4')));
  } finally {
    fs.rmSync(lixo, { force: true });
  }
});
