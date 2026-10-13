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

// Teto de recursos do FFmpeg (AUD-017, auditoria 10/2026). O custo cresce
// com os PIXELS, não com os bytes: um PNG de 771 KB em 16000x16000 levou
// 164 s e 4,8 GB de RAM pra normalizar, e cada instância da produção tem
// 1 GB e 0,5 vCPU (RUNBOOK). Medido em 12/10/2026 (FFmpeg 6.1), com uma
// linha de execução: PNG de 16 bits em 64 MP (8000x8000, 754 KB) ainda
// passa de 1,1 GB; em 32 MP fica em ~0,7 GB, e JPEG de 32 MP em ~0,26 GB.
// Daí 32 MP: cabe a foto padrão de celular (12-24 MP) e o vídeo 4K (8 MP),
// e a tela exibe 1080x1920 (2 MP) de qualquer jeito. Subir o teto pede
// máquina maior — medir de novo antes.
const MAX_PIXELS = 32_000_000;
// O decodificador do FFmpeg confere a largura ALINHADA (a 64 pixels com
// AVX-512), não a real: o JPEG de 6532x4898 (31,99 MP) conta 6592x4898
// (32,3 MP). O normalizar passa este teto, com 5% de folga, ao decodificador
// (-max_pixels), e a recusa faz a mesma conta: o que passa nela o FFmpeg
// decodifica — imagem que ele recusasse ficava girando no -loop 1 até o
// timeout (100x320000, 32 MP: medido, 12/10/2026).
const ALINHAMENTO_DA_LINHA = 64;
const MAX_PIXELS_DECODIFICADOR = Math.ceil(MAX_PIXELS * 1.05);
// Vídeo com mais de 8 bits por amostra (HDR de celular, drone em D-Log/HLG,
// ProRes) guarda cada amostra em 2 bytes, e o decodificador e o filtro pedem
// bem mais memória (revisão 3 do AUD-017). Menor `--as` do FFmpeg do
// normalizar, medido em 12/10/2026 (FFmpeg 6.1, uma arena): HEVC Main10 4K
// 732-739 MB, 4K DCI 739, 12 MP 806, 5K (13,8 MP) 851 — acima do teto de
// 850, o FFmpeg morria por falta de memória depois de processar o arquivo —
// e 7680x4096 1259 (não cabe na instância). Em 8 bits, 7680x4096 pede 650.
// Até 9 MP cabe o 4K (UHD e DCI) com ~13% de folga.
const MAX_PIXELS_MAIS_DE_8_BITS = 9_000_000;
// Custo do VÍDEO inteiro (revisão 3 do AUD-017): o teto de pixels mede UM
// quadro, e o FFmpeg decodifica e enquadra todos — um MP4 de 5,6 MB com 3000
// quadros de 7680x4096 (200 fps, 15 s) passava em tudo e segurava a única vaga
// da fila até o SIGKILL dos 15 min. Custo = quadros (pacotes do stream: o
// ffprobe conta lendo o arquivo, sem decodificar, e a duração do contêiner
// pode mentir) × pixels do quadro, com piso de 1080x1920 (quadro pequeno
// ainda passa pelo filtro que monta a tela inteira). Medido em 12/10/2026
// (FFmpeg 6.1, um núcleo): 9,7 (H.264) a 14,6 (AV1) ns de CPU por
// pixel-quadro, 10 bits igual a 8; 4K60 H.264 de 60 s (30 G): 314 s. Com 20 G
// o pior codec fica em ~5 min de CPU, ~10 min a 0,5 vCPU, abaixo dos 15 min
// do timeout. Cabe 4K a 30 fps por 60 s e 4K a 60 fps por 40 s (a tela exibe
// 30 fps).
const MAX_PIXELS_PROCESSADOS = 20_000_000_000;
// Um processo FFmpeg/ffprobe por vez no contêiner: a 0,5 vCPU dois em
// paralelo não terminam antes (dividem o mesmo meio núcleo) e somam a RAM —
// o ffprobe junto: PNG de 16 bits no teto custa 0,3 GB nele e 0,7 GB no
// FFmpeg (medido 12/10/2026), e a instância tem 1 GB. Quem chega espera a vez
// (fila FIFO).
const PROCESSOS_SIMULTANEOS = 1;
// Espera máxima na fila (revisão do AUD-017). A linha "processando" do
// upload nasce antes da fila, e o descarte de órfãs a apaga aos 30 min
// (criativos-repository.js#descartarProcessamentosOrfaos): duas esperas
// (ffprobe e FFmpeg) de até 5 min + ffprobe 30 s + FFmpeg 15 min + miniatura
// 1 min = 26,5 min. Passou da espera, volta 503 (quem chama apaga a linha)
// em vez de seguir na fila.
const ESPERA_MAXIMA_NA_FILA_MS = 5 * 60 * 1000;
const ERRO_FILA = 'muitos envios sendo processados agora — tente de novo em alguns minutos (o seu arquivo está ok)';
// Tempos máximos por processo. 15 min cobre o VÍDEO mais caro que passa no
// MAX_PIXELS_PROCESSADOS (pior codec, ~5 min de CPU num núcleo: ~10 min a 0,5
// vCPU, um terço de folga — a CPU da produção não foi medida) e mata o que
// travar. IMAGEM tem os seus, bem menores (ver
// normalizar; medido 12/10/2026 com 1 núcleo): decodificar o único quadro da
// foto do cliente — PNG de 16 bits e 32 MP, o pior, 2 s — tem 60 s; codificar
// o vídeo a partir do quadro já saneado custa só pela duração (peça de 60 s, o
// teto dos planos: 57 s, ~2 min a 0,5 vCPU) e tem 4 min. A miniatura é 1
// quadro de um MP4 1080x1920; o ffprobe lê o cabeçalho (e, em PNG,
// decodifica 1 quadro, limitado pelo -max_pixels).
const TEMPO_MAXIMO_FFMPEG_MS = 15 * 60 * 1000;
const TEMPO_MAXIMO_SANEAMENTO_MS = 60 * 1000;
const TEMPO_MAXIMO_IMAGEM_MS = 4 * 60 * 1000;
const TEMPO_MAXIMO_MINIATURA_MS = 60 * 1000;
const TEMPO_MAXIMO_FFPROBE_MS = 30 * 1000;
const ERRO_IMAGEM_ILEGIVEL =
  'não conseguimos ler esta imagem — o arquivo parece corrompido ou incompleto; salve ou exporte a imagem de novo e envie';
const ERRO_TETO_MEMORIA =
  'esse arquivo pede mais memória do que o servidor reserva pra processá-lo — exporte em resolução menor (até 4K) e em 8 bits (SDR) e envie de novo';

// Teto do SISTEMA em cada FFmpeg/ffprobe (revisão 2 do AUD-017). O
// timeout acima mata pelo relógio, mas um arquivo montado — ou só corrompido —
// enche a memória antes: PNG com o cabeçalho certo e o corpo cortado passou de
// 1 GB em segundos e chegou a 2 GB antes do kill. Com `prlimit` (util-linux,
// pacote essencial do Debian da imagem node:22-slim) o processo nasce com
// teto de memória VIRTUAL (`--as`: a alocação falha, o FFmpeg sai com erro e
// a instância segue) e de CPU (`--cpu`: o kernel mata quem passou, mesmo que
// o timer do Node não rode). Memória virtual, não RSS: o FFmpeg mapeia ~0,25
// GB de bibliotecas que quase não ocupam RAM. Menor `--as` com que o processo
// ainda termina, medido em 12/10/2026 (FFmpeg 6.1, um núcleo): ffprobe 272 MB
// em qualquer arquivo (é só carregar as bibliotecas; acima do teto de pixels
// ele não decodifica e a resposta é a mesma); FFmpeg: miniatura 346, foto PNG
// de 16 bits e 32 MP 575, vídeo 4K60 H.264 628, 4K HEVC 643, 7680x4096 (31,5
// MP) 650; em 10 bits, 4K 739 (ver MAX_PIXELS_MAIS_DE_8_BITS). O teto é isso
// com folga — 31% em 8 bits, 13% no 4K de 10 bits — (FFmpeg 850, ffprobe 512 —
// o carregamento das bibliotecas muda de build pra build) e o RSS que sobra
// dele (~0,6 GB) cabe com o Node no 1 GB da instância. Estourou o teto, o
// erro sai como `origem: 'memoria'` (log teto_memoria), não como arquivo
// ruim. CPU: os mesmos segundos do timeout —
// com `-threads 1` o processo usa até um núcleo, então só quem perdeu o timer
// chega nele.
const TETO_MEMORIA_FFMPEG = 850 * 1024 * 1024;
const TETO_MEMORIA_FFPROBE = 512 * 1024 * 1024;
// Uma arena do malloc só: cada linha do FFmpeg (5 no normalizar) abria a sua,
// reservando 64 MB de memória virtual que nunca usa — e o `--as` conta
// reserva. Sem isso o teto media arenas vazias, não o trabalho (vídeo 4K: 851
// → 628 MB; RSS de 310 MB nos dois).
const ambienteDoFfmpeg = () => ({ ...process.env, MALLOC_ARENA_MAX: '1' });

// Conferido UMA vez por processo, rodando o próprio ffprobe com o teto: sem
// `prlimit` no PATH (máquina sem util-linux) — ou com um FFmpeg cujas
// bibliotecas não carregam nesse teto —, roda sem ele e avisa uma vez. O
// upload nunca falha por isso: o timeout e o teto de pixels continuam valendo.
let prlimitDisponivel = null;
function conferirPrlimit() {
  prlimitDisponivel ??= execFileAsync(
    'prlimit',
    [`--as=${TETO_MEMORIA_FFPROBE}`, '--cpu=10', '--', 'ffprobe', '-version'],
    { timeout: 10_000, killSignal: 'SIGKILL', env: ambienteDoFfmpeg() },
  ).then(
    () => true,
    (err) => {
      console.warn(
        `ffmpeg: prlimit indisponível (${err.code ?? err.message}) — FFmpeg e ffprobe rodam sem teto de memória e CPU do sistema, só com o timeout`,
      );
      return false;
    },
  );
  return prlimitDisponivel;
}

// Como o FFmpeg morre quando a alocação falha no teto (medido em 12/10/2026,
// HEVC 10 bits e H.264 4K com o `--as` abaixo do necessário): "Cannot
// allocate memory" ou "malloc of size N failed" (x264) no stderr; saída 244
// (ENOMEM) ou 245 (EAGAIN: a linha nova não ganha pilha) no FFmpeg 6 — o 5.1
// sai com 1, daí o texto —; ou SIGSEGV onde a falha não é conferida.
const SINAL_DE_MEMORIA = /Cannot allocate memory|malloc of size \d+ failed/;
const SAIDAS_DE_MEMORIA = [244, 245];
const SINAIS_DE_MEMORIA = ['SIGSEGV', 'SIGBUS', 'SIGABRT'];

// Todo FFmpeg/ffprobe passa por aqui, com os três tetos: tempo (timeout +
// SIGKILL — no SIGTERM o FFmpeg tenta fechar o arquivo de saída com calma, que
// é justamente o que não termina), memória e CPU (prlimit).
async function rodar(programa, args, { memoria, timeout }) {
  const limitado = await conferirPrlimit();
  const [arquivo, argumentos] = limitado
    ? ['prlimit', [`--as=${memoria}`, `--cpu=${Math.ceil(timeout / 1000)}`, '--', programa, ...args]]
    : [programa, args];
  try {
    return await execFileAsync(arquivo, argumentos, { timeout, killSignal: 'SIGKILL', env: ambienteDoFfmpeg() });
  } catch (err) {
    // Estourou o teto de memória (revisão 3 do AUD-017): não é arquivo ruim.
    // Antes caía no "confira se é um vídeo válido" e no log falha_midia.
    const semMemoria =
      SINAL_DE_MEMORIA.test(err.stderr) ||
      SAIDAS_DE_MEMORIA.includes(err.code) ||
      SINAIS_DE_MEMORIA.includes(err.signal);
    if (limitado && semMemoria) {
      throw Object.assign(new Error(ERRO_TETO_MEMORIA, { cause: err }), { status: 400, origem: 'memoria' });
    }
    throw err;
  }
}

let ocupados = 0;
const fila = [];
function esperarVez() {
  if (ocupados < PROCESSOS_SIMULTANEOS) {
    ocupados += 1;
    return Promise.resolve();
  }
  return new Promise((vez, desistir) => {
    const naFila = () => {
      clearTimeout(prazo);
      vez();
    };
    const prazo = setTimeout(() => {
      fila.splice(fila.indexOf(naFila), 1);
      desistir(Object.assign(new Error(ERRO_FILA), { status: 503, origem: 'fila' }));
    }, ESPERA_MAXIMA_NA_FILA_MS);
    fila.push(naFila);
  });
}
// A vaga passa direto pro próximo da fila (sem decrementar e incrementar),
// então nenhum recém-chegado fura a fila entre um e outro.
function liberarVez() {
  const proximo = fila.shift();
  if (proximo) proximo();
  else ocupados -= 1;
}

// pix_fmt com mais de 8 bits por amostra: o nome termina em número +
// endianness (yuv420p10le, p010le, rgba64be); as exceções, de 8 bits ou menos,
// são o RGB empacotado em 16 bits por pixel e o bayer. Conferido contra a
// tabela do FFmpeg 6.1 (`ffprobe -show_pixel_formats`: 214 formatos, nenhuma
// divergência). O ffprobe não dá bits_per_raw_sample em HEVC, VP9 nem AV1.
function maisDe8Bits(pixFmt = '') {
  return /\d(?:le|be)$/.test(pixFmt) && !/^(?:(?:rgb|bgr)(?:444|555|565)|bayer_)/.test(pixFmt);
}

// Recusa ANTES do FFmpeg pelo que o arquivo vai custar (quem chama responde
// 400 com esta frase); null quando cabe. Dimensão zerada é o ffprobe dizendo
// que não decodificou (arquivo truncado, ou acima do teto sem o aviso de
// tamanho), e vídeo sem quadros contados ou sem duração (WebM gravado no
// navegador, H.264 cru) também não se lê: sem duração não há como conferir os
// 3-60 s nem cortar a saída (o `-t` do normalizar), e a linha caía no banco
// depois do FFmpeg inteiro (`duracao_segundos` é int). O FFmpeg não roda.
// Imagem é decodificada uma vez só (ver normalizar): só o teto de pixels vale.
function recusaPorCusto({ width, height, ehImagem, quadros, pix_fmt, duracao_segundos }) {
  const ilegivel = `não foi possível ler esse arquivo — confira se é um vídeo ou imagem válido, de até ${MAX_PIXELS / 1e6} megapixels`;
  if (!(width > 0 && height > 0)) return ilegivel;
  const pixels = width * height;
  const megapixels = Math.round(pixels / 1e6);
  const larguraAlinhada = Math.ceil(width / ALINHAMENTO_DA_LINHA) * ALINHAMENTO_DA_LINHA;
  if (pixels > MAX_PIXELS) {
    return `${ehImagem ? 'imagem grande demais' : 'vídeo grande demais'}: ${width}x${height} (${megapixels} megapixels) — o limite é ${MAX_PIXELS / 1e6} megapixels (a tela exibe 1080x1920); reduza a resolução e envie de novo`;
  }
  if (larguraAlinhada * height > MAX_PIXELS_DECODIFICADOR) {
    return `${ehImagem ? 'imagem estreita' : 'vídeo estreito'} demais pra altura: ${width}x${height} — corte ou redimensione (a tela exibe 1080x1920) e envie de novo`;
  }
  if (ehImagem) return null;
  if (!(Number.isInteger(quadros) && quadros > 0 && Number.isFinite(duracao_segundos))) return ilegivel;
  if (maisDe8Bits(pix_fmt) && pixels > MAX_PIXELS_MAIS_DE_8_BITS) {
    return `vídeo de 10 bits (HDR) grande demais: ${width}x${height} (${megapixels} megapixels) — em 10 bits o limite é ${MAX_PIXELS_MAIS_DE_8_BITS / 1e6} megapixels (4K); exporte em 4K ou em 8 bits (SDR) e envie de novo`;
  }
  if (quadros * Math.max(pixels, LARGURA * ALTURA) > MAX_PIXELS_PROCESSADOS) {
    return `vídeo pesado demais pra processar: ${quadros} quadros de ${width}x${height} — o limite equivale a 60 s de 4K a 30 quadros por segundo (ou 40 s a 60); reduza a resolução, a duração ou os quadros por segundo (a tela exibe 30) e envie de novo`;
  }
  return null;
}

// `tempos` (opcional) recebe a espera da vez (`fila_probe_ms`) separada do
// ffprobe em si (`ffprobe_ms`): somadas, a espera pelo FFmpeg de outro envio
// parecia um ffprobe de minutos no log do upload (revisão do AUD-017).
async function probeMidia(caminho, tempos = {}) {
  let inicio = Date.now();
  try {
    await esperarVez();
  } finally {
    tempos.fila_probe_ms = Date.now() - inicio;
  }
  inicio = Date.now();
  let stdout;
  let stderr;
  try {
    // -max_pixels: o decodificador recusa quadro acima do teto em vez de
    // alocá-lo (PNG de 256 MP: 781 MB → 49 MB, medido 12/10/2026).
    // -count_packets: conta os pacotes do stream lendo o arquivo, sem
    // decodificar — os quadros que o FFmpeg vai processar (revisão 3).
    ({ stdout, stderr } = await rodar(
      'ffprobe',
      [
        '-v',
        'error',
        '-max_pixels',
        String(MAX_PIXELS),
        '-count_packets',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,pix_fmt,nb_read_packets:format=duration,format_name',
        '-of',
        'json',
        caminho,
      ],
      { memoria: TETO_MEMORIA_FFPROBE, timeout: TEMPO_MAXIMO_FFPROBE_MS },
    ));
  } finally {
    tempos.ffprobe_ms = Date.now() - inicio;
    liberarVez();
  }
  const info = JSON.parse(stdout);
  let { width, height } = info.streams[0];
  const { pix_fmt, nb_read_packets } = info.streams[0];
  // Recusado pelo -max_pixels, o stream vem 0x0 e o tamanho real só aparece
  // no aviso do FFmpeg ("Picture size WxH exceeds ..."): com ele a recusa
  // diz "imagem grande demais" em vez de "não foi possível ler".
  const acimaDoTeto = !width && /Picture size (\d+)x(\d+) exceeds/.exec(stderr);
  if (acimaDoTeto) [width, height] = [Number(acimaDoTeto[1]), Number(acimaDoTeto[2])];
  const ehImagem = /image2|_pipe/.test(info.format.format_name || '');
  const duracao_segundos = ehImagem ? DURACAO_PADRAO_IMAGEM : Math.round(Number(info.format.duration));
  return { width, height, duracao_segundos, ehImagem, quadros: Number(nb_read_packets), pix_fmt };
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
  // Rede de segurança pra quem chama sem conferir antes (as rotas de upload
  // conferem e respondem com a frase).
  const recusa = recusaPorCusto(midia);
  if (recusa) throw Object.assign(new Error(recusa), { status: 400 });
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
  const saidaSaneada = path.join(os.tmpdir(), `${criativoId}-saneada.bmp`);
  const tempos = {};
  const medir = async (etapa, fn) => {
    const inicio = Date.now();
    try {
      return await fn();
    } finally {
      tempos[etapa] = Date.now() - inicio;
    }
  };

  // `-threads 1` antes do -i (decodificador) e depois (codificador): sem ele
  // o FFmpeg abre uma linha por núcleo do HOST (não da cota de 0,5 vCPU), cada
  // uma com o seu quadro na memória — PNG 16 bits de 32 MP: 1,8 GB → 0,7 GB,
  // medido 12/10/2026. A 0,5 vCPU não perde velocidade.
  // O teto de pixels vale também aqui, não só no ffprobe (revisão do AUD-017):
  // o ffprobe mede o primeiro stream de vídeo no começo do arquivo, e sem
  // `-map` o FFmpeg escolhia o de MAIOR resolução — um MKV com v:0 de 320x240
  // e v:1 de 16000x16000, ou com quadros que crescem no meio, passava no teto
  // e decodificava 256 MP (1,6 GB). `-max_pixels` recusa o quadro acima do
  // teto; `-map 0:v:0` processa o stream que foi medido.
  const decodificador = ['-threads', '1', '-max_pixels', String(MAX_PIXELS_DECODIFICADOR)];
  const comMemoria = (timeout) => ({ memoria: TETO_MEMORIA_FFMPEG, timeout });

  try {
    await medir('fila_ms', esperarVez);
    try {
      // Imagem decodificada UMA vez (revisão 2 do AUD-017). Com
      // `-loop 1` na foto do cliente, o FFmpeg relia e decodificava o arquivo
      // a cada quadro: um PNG com o cabeçalho certo e o corpo cortado (download
      // interrompido) passa no ffprobe e no teto de pixels, e o parser
      // acumulava o arquivo a cada volta — 1 GB em segundos, 2 GB até o kill;
      // corrompido, girava até o timeout segurando a vaga da fila. Agora um
      // quadro só, já enquadrado em 1080x1920, vai pra um BMP nosso: o que não
      // decodifica falha aqui em décimos de segundo e vira 400. O `-loop 1`
      // abaixo relê esse BMP de 2 MP sem descomprimir nada, não a foto de até
      // 32 MP (vídeo de 10 s de uma foto: 10,5 → 8,2 s de CPU contra um PNG).
      if (ehImagem) {
        let falha = null;
        await medir('saneamento_ms', () =>
          rodar(
            'ffmpeg',
            [
              '-y',
              ...decodificador,
              '-i',
              caminhoEntrada,
              '-map',
              '0:v:0',
              '-frames:v',
              '1',
              '-vf',
              filtro,
              '-pix_fmt',
              'bgr24',
              '-threads',
              '1',
              '-update',
              '1',
              saidaSaneada,
            ],
            comMemoria(TEMPO_MAXIMO_SANEAMENTO_MS),
          ).catch((err) => {
            falha = err;
          }),
        );
        // Teto de memória não é imagem ilegível: segue com a frase dele.
        if (falha?.origem === 'memoria') throw falha;
        // Sem quadro nenhum, há versão do FFmpeg que sai com 0 sem gravar o
        // arquivo ("Output file is empty"): é a mesma imagem ilegível.
        if (falha || !(fs.statSync(saidaSaneada, { throwIfNoEntry: false })?.size > 0)) {
          throw Object.assign(new Error(ERRO_IMAGEM_ILEGIVEL), { status: 400, origem: 'imagem', cause: falha });
        }
      }
      // Vídeo: o arquivo do cliente pelo filtro de enquadramento, cortado na
      // duração lida (+1 s: o arredondamento nunca corta vídeo de verdade) —
      // um MKV com a duração do contêiner forjada em 10 s e 600 s de áudio
      // saía com 600 s (revisão 3). Imagem: o BMP saneado (já 1080x1920)
      // repetido por `duracao_segundos`, convertido de RGB em BT.709 e marcado
      // assim (revisão 3): sem dizer a matriz, o swscale converte em BT.601 e
      // a saída nascia sem marca — o player que trata HD sem marca como
      // BT.709 mostrava as cores deslocadas (vermelho 224,16,32 → 239,37,28).
      const entrada = ehImagem
        ? [
            '-loop',
            '1',
            '-t',
            String(duracao_segundos),
            ...decodificador,
            '-i',
            saidaSaneada,
            '-vf',
            'scale=out_color_matrix=bt709:out_range=tv',
            '-colorspace',
            'bt709',
            '-color_range',
            'tv',
          ]
        : [...decodificador, '-i', caminhoEntrada, '-vf', filtro, '-t', String(duracao_segundos + 1)];
      await medir('ffmpeg_ms', () =>
        rodar(
          'ffmpeg',
          ['-y', ...entrada, '-map', '0:v:0', '-map', '0:a:0?', ...PERFIL_SAIDA, '-threads', '1', saidaVideo],
          comMemoria(ehImagem ? TEMPO_MAXIMO_IMAGEM_MS : TEMPO_MAXIMO_FFMPEG_MS),
        ),
      );
      await medir('thumb_ms', () =>
        rodar(
          'ffmpeg',
          ['-y', '-ss', '00:00:01', '-threads', '1', '-i', saidaVideo, '-frames:v', '1', '-threads', '1', saidaThumb],
          comMemoria(TEMPO_MAXIMO_MINIATURA_MS),
        ),
      );
    } finally {
      liberarVez();
    }

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
    fs.rmSync(saidaSaneada, { force: true });
  }
}

module.exports = { normalizar, probeMidia, subirParaStorage, recusaPorCusto };
