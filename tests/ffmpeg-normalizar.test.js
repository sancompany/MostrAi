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

test('falha no FFmpeg limpa os temporários e devolve os tempos no erro', { skip: !temFfmpeg }, async () => {
  const lixo = path.join(os.tmpdir(), `lixo-${process.pid}.mp4`);
  fs.writeFileSync(lixo, 'isto não é vídeo');
  try {
    const err = await ffmpeg
      .normalizar(lixo, 'teste-lixo', null, { width: 1080, height: 1920, duracao_segundos: 5, ehImagem: false })
      .catch((e) => e);
    assert.ok(err instanceof Error);
    assert.ok(Number.isFinite(err.tempos.ffmpeg_ms));
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'teste-lixo-normalizado.mp4')));
  } finally {
    fs.rmSync(lixo, { force: true });
  }
});
