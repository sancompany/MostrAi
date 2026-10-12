# Upload limitado por bytes, mas o FFmpeg custa por pixel

**Sintoma.** Auditoria v1 (AUD-017, 11/10/2026): um PNG de 771 KB em
16000x16000 (256 MP) passava por todas as checagens do upload de criativo e
levava o FFmpeg a 132-164 s e 4,8-6,5 GB de RAM — a instância de produção
tem 1 GB e 0,5 vCPU. Uma foto de celular em modo 108/200 MP faz o mesmo sem
malícia nenhuma.

**Causa raiz.** O único teto do upload era o do multer (95 MB). Imagem
comprimida é minúscula em bytes e enorme em pixels: o custo do ffprobe (que
decodifica 1 quadro de PNG) e do FFmpeg (que com `-loop 1` decodifica de novo
a cada quadro, com uma linha por núcleo do HOST, não da cota) cresce com
largura × altura. Nada conferia a resolução, os `execFile` não tinham
`timeout` e não havia limite de processos simultâneos.

**Correção.** `src/lib/ffmpeg.js`: teto de 32 MP conferido antes do FFmpeg
(o ffprobe roda com `-max_pixels`, então nem ele aloca a imagem gigante; a
recusa diz o tamanho), `-threads 1`, `timeout` + `SIGKILL` em cada processo,
e um FFmpeg/ffprobe por vez no contêiner (fila). As rotas de upload recusam
com 400 e a frase antes do FFmpeg; no upload do anunciante a linha
temporária já existe (nasce antes da fila) e a recusa a apaga.

**Revisão (12/10/2026): o teto estava no processo errado.** O `-max_pixels`
ficou só no ffprobe, que mede o primeiro stream de vídeo no começo do
arquivo; o FFmpeg do normalizar decodificava sem teto o stream que quisesse
(sem `-map`, o de maior resolução) e quadros que crescem no meio — um MKV de
3 MB com v:1 de 16000x16000 passava e chegava a 1,6 GB. Agora o FFmpeg
recebe `-max_pixels` (com 5% de folga: o decodificador confere a largura
alinhada a 64) e `-map 0:v:0`, e a recusa faz a mesma conta do alinhamento
(sem isso, imagem que o decodificador recusa girava no `-loop 1` até o
timeout).

**Revisão 2 (12/10/2026): o teto media o cabeçalho, e o arquivo era outro.**
Um PNG 1080x1920 cortado em 20 KB (download interrompido) passa no ffprobe e
no teto de pixels; com `-loop 1` o FFmpeg relia a foto a cada quadro e o
parser acumulava o arquivo a cada volta: 1 GB em segundos, 2 GB até o kill.
Corrompido no meio, girava até o timeout de 15 min segurando a única vaga da
fila. Desenho novo: (1) todo FFmpeg/ffprobe nasce por `prlimit` com teto de
memória virtual e de CPU do sistema — qualquer entrada patológica é contida
pelo kernel (sem `prlimit`, roda sem ele e avisa uma vez); o teto foi medido
no pior caso legítimo (vídeo e foto de 32 MP) e o malloc roda com uma arena
só (`MALLOC_ARENA_MAX=1`), senão o `--as` media reserva vazia; (2) a imagem
é decodificada UMA vez (`-frames:v 1`, já enquadrada, num BMP temporário) e
o vídeo sai desse BMP — o que não decodifica falha em décimos de segundo,
400 "não conseguimos ler esta imagem"; (3) imagem tem timeout próprio: 60 s
pra decodificar, 4 min pra codificar (vídeo segue com 15 min).

**Revisão 3 (13/10/2026): o teto media um quadro, e o custo é o vídeo
inteiro.** (1) Um MP4 de 5,6 MB com 3000 quadros estáticos de 7680x4096
(200 fps, 15 s) passava no teto de 32 MP e segurava a única vaga do FFmpeg
até o SIGKILL de 15 min — todo outro envio da instância voltava 503. O
ffprobe agora conta os quadros (`-count_packets`: lê, não decodifica) e a
recusa olha quadros × pixels (quadro menor que 1080x1920 conta como a tela,
que o filtro monta de qualquer jeito): acima de 20 G, 400 "vídeo pesado
demais". Medido (FFmpeg 6.1, um núcleo): 9,7 a 14,6 ns de CPU por
pixel-quadro conforme o codec (H.264 a AV1), 10 bits igual a 8; 20 G no pior
codec é ~5 min de CPU, ~10 min a 0,5 vCPU. Cabe 4K a 30 fps por 60 s e a 60
fps por 40 s. O vídeo também sai cortado na duração lida + 1 s (`-t` na
saída: um MKV com a duração do contêiner forjada em 10 s e 600 s de áudio
saía com 600 s, agora 11 s), e vídeo sem duração lida não se lê. (2) Vídeo de 10 bits (HDR de celular, drone em D-Log) guarda 2 bytes
por amostra: o 5.1K HEVC Main10 pedia 851 MB de `--as` e morria por falta de
memória depois de processar o arquivo, com a frase de arquivo inválido; o
teto tinha sido medido só em 8 bits. Agora o ffprobe lê o `pix_fmt` e 10
bits acima de 9 MP volta 400 antes do FFmpeg (4K de 10 bits: 575-739 MB
conforme o codec, cabe). E o FFmpeg que estoura o teto ("Cannot allocate
memory", "malloc of size … failed", SIGSEGV sob o `prlimit`) sai como
`origem: 'memoria'`, com frase própria e log `teto_memoria`. (3) A peça feita
de foto saía sem marca de cor (o BMP saneado é RGB e o swscale convertia em
BT.601): agora converte e marca em BT.709.

**Guarda.** `tests/upload-criativo.test.js` e `tests/midias.test.js`
(16000x16000 → 400 sem chamar `normalizar`), `tests/ffmpeg-normalizar.test.js`
(ffprobe real recusa PNG de 36 MP; a segunda normalização simultânea espera
a primeira; MKV com segundo stream ou quadro que cresce acima do teto não
chega à saída; foto de 31,99 MP fora do múltiplo de 64 normaliza; PNG cortado
e corrompido voltam 400 em segundos; os argumentos do processo começam com
`prlimit --as --cpu`, e sem ele o upload segue com um aviso só; revisão 3:
MP4 de 7680x4096 a 200 fps e HEVC Main10 5120x2700 recusados antes do
FFmpeg, 4K de 10 bits passa; ENOMEM/malloc/SIGSEGV viram `memoria`; a foto
sai marcada `bt709`/`tv` com a cor certa; `-t` na saída do vídeo). Rotas:
`tests/upload-criativo.test.js` (quadros demais e 10 bits → 400 sem linha;
`teto_memoria` no log) e `tests/video-institucional.test.js`.

**Como evitar na origem.** Todo processo externo que roda dentro da
requisição precisa de três tetos explícitos: tamanho de ENTRADA medido na
unidade que custa (pixels, quadros, páginas — não bytes), tempo
(`timeout` + `killSignal`) e concorrência. E o teto se mede na máquina de
produção, no pior formato (aqui, PNG de 16 bits), não no arquivo típico.
O teto vale no processo que ALOCA, não só no que mede: medir uma parte do
arquivo e processar outra é o mesmo que não medir. E checagem de entrada não
substitui teto do sistema: o arquivo que passa em todas as checagens e ainda
assim explode existe — o kernel (`prlimit`) é quem garante o limite. Medir em
TODAS as unidades que custam (pixels do quadro, número de quadros, bytes por
amostra), no pior formato de cada uma (aqui, 10 bits) — e o erro do teto do
sistema tem frase e log próprios, senão ele se disfarça de arquivo ruim.

**Ecossistema:** sim — qualquer projeto da San & Co. que processe imagem,
vídeo ou PDF do cliente no servidor.
