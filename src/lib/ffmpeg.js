const { execFile } = require('node:child_process');
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
const PERFIL_SAIDA = ['-c:v', 'libx264', '-profile:v', 'main', '-pix_fmt', 'yuv420p', '-b:v', '4M', '-c:a', 'aac'];

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
async function subirParaStorage(caminhoLocal, nomeArquivo, contentType) {
  const buffer = fs.readFileSync(caminhoLocal);
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
// Retorna { arquivo_normalizado_url, thumbnail_url, duracao_segundos }.
async function normalizar(caminhoEntrada, criativoId) {
  const { width, height, duracao_segundos, ehImagem } = await probeMidia(caminhoEntrada);
  const jaVertical = height >= width;

  const filtro = jaVertical
    ? `scale=${LARGURA}:${ALTURA}:force_original_aspect_ratio=decrease,pad=${LARGURA}:${ALTURA}:(ow-iw)/2:(oh-ih)/2`
    : // horizontal: fundo é o próprio vídeo ampliado e desfocado, conteúdo
      // original centralizado por cima, sem cortar nada (vitrina-plano-completo.md 4.5)
      `split[bg][fg];[bg]scale=${LARGURA}:${ALTURA}:force_original_aspect_ratio=increase,crop=${LARGURA}:${ALTURA},boxblur=20:5[bg2];[fg]scale=${LARGURA}:-2[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2`;

  const saidaVideo = path.join(os.tmpdir(), `${criativoId}-normalizado.mp4`);
  const saidaThumb = path.join(os.tmpdir(), `${criativoId}-thumb.jpg`);

  // imagem: -loop 1 -t <duração> transforma a foto estática num vídeo com a
  // duração certa antes de aplicar o mesmo filtro de enquadramento do vídeo.
  const entradaArgs = ehImagem ? ['-loop', '1', '-t', String(duracao_segundos)] : [];
  await execFileAsync('ffmpeg', [
    '-y',
    ...entradaArgs,
    '-i',
    caminhoEntrada,
    '-vf',
    filtro,
    ...PERFIL_SAIDA,
    saidaVideo,
  ]);
  await execFileAsync('ffmpeg', ['-y', '-ss', '00:00:01', '-i', saidaVideo, '-frames:v', '1', saidaThumb]);

  const [arquivo_normalizado_url, thumbnail_url] = await Promise.all([
    subirParaStorage(saidaVideo, `${criativoId}.mp4`, 'video/mp4'),
    subirParaStorage(saidaThumb, `${criativoId}-thumb.jpg`, 'image/jpeg'),
  ]);

  fs.unlinkSync(saidaVideo);
  fs.unlinkSync(saidaThumb);

  return { arquivo_normalizado_url, thumbnail_url, duracao_segundos };
}

module.exports = { normalizar, probeMidia };
