const { execFile } = require('node:child_process');
const crypto = require('node:crypto');
const util = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const supabase = require('./supabase');

const execFileAsync = util.promisify(execFile);

const LARGURA = 1080;
const ALTURA = 1920;

// Perfil de saída fixo (SPEC módulo 2) — todo criativo normalizado sai no
// mesmo codec/bitrate, decodifica em hardware em qualquer TV Stick
// homologado da rede, não importa o que o anunciante mandou.
//
// Velocidade (estação upload, 27/09/2026): a produção roda com 0,5 vCPU, e o
// processamento real passava dos 100 s do proxy da Cloudflare (criativos de
// 16 s e 24 s: 105,7 s e 131,8 s). Medido, com a saída idêntica em codec,
// perfil, resolução, fps e bitrate (H.264 Main, 1080x1920, yuv420p, 4 Mbps):
//   - `-preset veryfast` no lugar do padrão (medium): vertical de 30 s, 41 s
//     → 21 s por núcleo; na própria produção, 6,3 s → 3,4 s por 3 s de vídeo;
//   - `-fpsmax 30`: vídeo de celular a 60 fps codificava o dobro de quadros
//     que a TV precisa (a saída já era 30 fps pra fonte de 30);
//   - fundo desfocado do vídeo horizontal feito em 270x480 e ampliado: o
//     `boxblur` em 1080x1920 era o que mais pesava (horizontal 60 fps de 30 s:
//     153 s → 36 s por núcleo), e desfoque ampliado é visualmente o mesmo.
// `-fpsmax` só limita (fonte de 24/25 fps continua igual); conferido rodando
// na própria imagem de produção (FFmpeg 5.1) e aqui (6.1), 27/09/2026.
const PERFIL_SAIDA = [
  '-fpsmax',
  '30',
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-profile:v',
  'main',
  '-pix_fmt',
  'yuv420p',
  '-b:v',
  '4M',
  '-c:a',
  'aac',
];

// Criativo enviado como foto (accept="video/*,image/*" no painel): o
// ffprobe/ffmpeg dessa máquina devolve uma "duration" fictícia de ~0.04s (1
// frame a 25fps) pra imagem estática em vez de vazio — Math.round nisso dá
// 0, não erro, mas o criativo ficava com 0s de exibição. format_name é o
// jeito confiável de distinguir imagem de vídeo de verdade (demuxer
// "image2"/"*_pipe" vs "mov,mp4,..."/"matroska,..." etc). Duração fixa pra
// imagem enquanto não tiver campo configurável por criativo.
const DURACAO_PADRAO_IMAGEM = 10;

async function probeMidia(caminho) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:format=duration,format_name',
    '-of',
    'json',
    caminho,
  ]);
  const info = JSON.parse(stdout);
  const { width, height } = info.streams[0];
  const ehImagem = /image2|_pipe/.test(info.format.format_name || '');
  const duracao_segundos = ehImagem ? DURACAO_PADRAO_IMAGEM : Math.round(Number(info.format.duration));
  return { width, height, duracao_segundos, ehImagem };
}

// `origem = 'storage'` nos erros daqui: quem chama precisa distinguir "o
// arquivo do cliente e ruim" de "o nosso armazenamento esta fora do ar". As
// duas coisas caiam na mesma frase, e a frase culpava o cliente.
async function subirParaStorage(buffer, nomeArquivo, contentType) {
  // Roteiros e2e (tests/e2e/25-sessao-e-upload.mjs): com STORAGE_CAPTURA=<pasta>
  // e fora de produção, o arquivo vai pra essa pasta em vez do bucket — o
  // upload percorre o caminho real inteiro (multer, ffprobe, FFmpeg, banco,
  // SSE) sem tocar no Storage. Mesmo padrão do EMAIL_CAPTURA (financeiro/email.js).
  if (process.env.STORAGE_CAPTURA && process.env.NODE_ENV !== 'production') {
    fs.mkdirSync(process.env.STORAGE_CAPTURA, { recursive: true });
    fs.writeFileSync(path.join(process.env.STORAGE_CAPTURA, path.basename(nomeArquivo)), buffer);
    return `/e2e-storage/${path.basename(nomeArquivo)}`;
  }
  const bucket = process.env.SUPABASE_STORAGE_BUCKET;
  try {
    const { error } = await supabase.storage.from(bucket).upload(nomeArquivo, buffer, { contentType, upsert: true });
    if (error) throw error;
    const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
    return data.publicUrl;
  } catch (err) {
    err.origem = 'storage';
    throw err;
  }
}

// caminhoEntrada: arquivo temporário local já salvo pelo multer.
// `duracaoMaximaImagem` (19/09/2026, pedido do dono: "transformar imagem em
// anúncio de acordo com o tempo do plano da pessoa, se for 15 se for 30
// depende do plano") — só vale pra IMAGEM: vídeo tem duração real, não dá
// pra esticar; imagem é escolha nossa, então usa o teto inteiro que o
// plano já vende, em vez do padrão fixo. `null` (conta própria/plano sem
// duração cadastrada) cai no padrão de sempre.
// Retorna { arquivo_normalizado_url, thumbnail_url, duracao_segundos, conteudo_sha256, conteudo_bytes, tempos }.
// `probado`: o resultado do probeMidia que quem chama já fez (o upload
// confere a duração antes) — sem ele, lê de novo. `tempos` (ms por etapa) vai
// só pro log do upload: nenhum dado do arquivo, só números.
async function normalizar(caminhoEntrada, criativoId, duracaoMaximaImagem = null, probado = null) {
  const midia = probado || (await probeMidia(caminhoEntrada));
  const { width, height, ehImagem } = midia;
  const duracao_segundos = ehImagem ? duracaoMaximaImagem || DURACAO_PADRAO_IMAGEM : midia.duracao_segundos;
  const jaVertical = height >= width;

  const filtro = jaVertical
    ? `scale=${LARGURA}:${ALTURA}:force_original_aspect_ratio=decrease,pad=${LARGURA}:${ALTURA}:(ow-iw)/2:(oh-ih)/2`
    : // horizontal: fundo é o próprio vídeo ampliado e desfocado, conteúdo
      // original centralizado por cima, sem cortar nada (vitrina-plano-completo.md 4.5).
      // O fundo é desfocado em 1/4 da resolução e ampliado (ver PERFIL_SAIDA).
      `split[bg][fg];[bg]scale=${LARGURA / 4}:${ALTURA / 4}:force_original_aspect_ratio=increase,crop=${LARGURA / 4}:${ALTURA / 4},boxblur=5:2,scale=${LARGURA}:${ALTURA}[bg2];[fg]scale=${LARGURA}:-2[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2`;

  const saidaVideo = path.join(os.tmpdir(), `${criativoId}-normalizado.mp4`);
  const saidaThumb = path.join(os.tmpdir(), `${criativoId}-thumb.jpg`);
  const tempos = {};
  const medir = async (etapa, fn) => {
    const inicio = Date.now();
    try {
      return await fn();
    } finally {
      tempos[etapa] = Date.now() - inicio;
    }
  };

  try {
    // imagem: -loop 1 -t <duração> transforma a foto estática num vídeo com a
    // duração certa antes de aplicar o mesmo filtro de enquadramento do vídeo.
    const entradaArgs = ehImagem ? ['-loop', '1', '-t', String(duracao_segundos)] : [];
    await medir('ffmpeg_ms', () =>
      execFileAsync('ffmpeg', ['-y', ...entradaArgs, '-i', caminhoEntrada, '-vf', filtro, ...PERFIL_SAIDA, saidaVideo]),
    );
    await medir('thumb_ms', () =>
      execFileAsync('ffmpeg', ['-y', '-ss', '00:00:01', '-i', saidaVideo, '-frames:v', '1', saidaThumb]),
    );

    // contentHash (Player V2, contrato §6.1): SHA-256 dos MESMOS bytes que
    // vão para o Storage e que o Player baixa — o MP4 normalizado, nunca o
    // arquivo que o cliente subiu (que nem é guardado).
    const video = fs.readFileSync(saidaVideo);
    const conteudo_sha256 = crypto.createHash('sha256').update(video).digest('hex');
    const [arquivo_normalizado_url, thumbnail_url] = await medir('storage_ms', () =>
      Promise.all([
        subirParaStorage(video, `${criativoId}.mp4`, 'video/mp4'),
        subirParaStorage(fs.readFileSync(saidaThumb), `${criativoId}-thumb.jpg`, 'image/jpeg'),
      ]),
    );

    return {
      arquivo_normalizado_url,
      thumbnail_url,
      duracao_segundos,
      conteudo_sha256,
      conteudo_bytes: video.length,
      tempos,
    };
  } catch (err) {
    err.tempos = tempos;
    throw err;
  } finally {
    // Também no erro: antes um FFmpeg ou Storage que falhava deixava o MP4
    // normalizado (MBs) em /tmp.
    fs.rmSync(saidaVideo, { force: true });
    fs.rmSync(saidaThumb, { force: true });
  }
}

module.exports = { normalizar, probeMidia };
