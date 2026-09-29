const QRCode = require('qrcode');
const pontosRepo = require('../pontos/repository');

// QR Code institucional da Mostraí (Admin → Mídia Mostraí, 27/09/2026).
//
// O QR impresso (vídeo institucional, flyer, material de divulgação) codifica
// SEMPRE a rota permanente `/q/anuncie` do próprio site — nunca o destino.
// Para onde essa rota leva é configuração, na mesma `configuracoes_site` do
// vídeo institucional e da foto de exemplo (migration 055): trocar o destino
// não troca o QR, e o que já foi impresso continua funcionando.
//
// Imagem gerada aqui, pela biblioteca `qrcode` 1.5.4 (README da versão
// instalada, lido em 27/09/2026: margem padrão de 4 módulos, que é a zona de
// silêncio mínima da norma; correção de erro L/M/Q/H; `toBuffer` PNG via
// pngjs; `toString` SVG). Nenhum serviço externo recebe o link.

const CAMINHO_PERMANENTE = '/q/anuncie';
const CHAVE = 'qr_institucional';
const TAMANHO_MAXIMO_DESTINO = 2048;

const OPCOES_QR = {
  // Q: o símbolo ainda lê com ~25% da área danificada — o mesmo QR vai pra
  // flyer amassado e pra vídeo comprimido na TV. Com o link de produção dá a
  // versão 4 (33 módulos), módulo grande o bastante pra ler de longe.
  errorCorrectionLevel: 'Q',
  margin: 4,
  // Cor de texto da marca (--text do style.css) sobre branco: contraste de
  // ~18:1. O laranja fica na moldura do preview e nunca nos módulos: laranja
  // sobre branco não chega a 3:1, e é aí que o leitor do celular erra.
  color: { dark: '#14171f', light: '#ffffff' },
};

// 1024 px: Canva, WhatsApp, redes, vídeo. 2048 px: impressão (até ~17 cm a
// 300 dpi). Maior que isso é o SVG, que é vetor. O PNG é montado pixel a
// pixel no processo: 4096 px travava o servidor ~2 s por pedido.
const TAMANHOS_PNG = [1024, 2048];

// Só SITE_URL (revisão Codex do #86): sem o fallback pra CORS_ORIGIN que
// e-mails e convites usam — link de e-mail com host errado se reenvia, QR
// impresso com host errado não tem conserto trocando o destino.
function baseDoSite() {
  return String(process.env.SITE_URL || '')
    .trim()
    .replace(/\/+$/, '');
}

// `null` sem SITE_URL: um QR com endereço relativo não abre em celular nenhum.
function linkPermanente() {
  const base = baseDoSite();
  return base ? `${base}${CAMINHO_PERMANENTE}` : null;
}

function destinoPadrao() {
  return `${baseDoSite()}/planos.html`;
}

// O destino não pode ser o próprio link do QR: o celular ficaria preso num
// laço de redirecionamento. Compara o caminho já normalizado pela URL
// (`/q/x/../anuncie`), sem barra final, sem caixa e sem %-codificação.
function ehOProprioLink(url, site) {
  if (url.host !== site.host) return false;
  let caminho = url.pathname;
  try {
    caminho = decodeURIComponent(caminho);
  } catch {}
  return caminho.replace(/\/+$/, '').toLowerCase() === site.pathname.toLowerCase();
}

// Devolve `{ destino }` (normalizado) ou `{ erro }` com o motivo em português.
// Vale na gravação e de novo na leitura: valor gravado à mão no banco também
// não vira redirecionamento sem passar por aqui.
function validarDestino(bruto) {
  if (typeof bruto !== 'string' || !bruto.trim()) return { erro: 'informe o endereço de destino' };
  const valor = bruto.trim();
  if (valor.length > TAMANHO_MAXIMO_DESTINO) {
    return { erro: `endereço longo demais — o máximo é ${TAMANHO_MAXIMO_DESTINO} caracteres` };
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: caractere de controle é justamente o que se recusa
  if (/[\s\u0000-\u001f\u007f]/.test(valor)) return { erro: 'o endereço não pode ter espaços nem quebras de linha' };
  let url;
  try {
    url = new URL(valor);
  } catch {
    return { erro: 'endereço inválido — cole o endereço completo, começando com https://' };
  }
  const link = linkPermanente();
  const site = link ? new URL(link) : null;
  // http só onde o próprio site roda em http (ambiente local): em produção o
  // destino nunca é menos seguro que o link do QR. Isto também barra
  // javascript:, data:, file:, ftp: e afins.
  const local = site?.protocol === 'http:';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { erro: 'use um endereço seguro, começando com https://' };
  }
  // https://usuario@site-falso.com — truque clássico pra disfarçar o domínio.
  if (url.username || url.password) return { erro: 'o endereço não pode ter usuário ou senha' };
  if (!url.hostname.includes('.') && !(local && url.hostname === 'localhost')) {
    return { erro: 'endereço inválido — falta o domínio (ex.: .com.br)' };
  }
  if (site && ehOProprioLink(url, site)) {
    return { erro: 'o destino não pode ser o próprio link do QR — quem escanear ficaria preso num laço' };
  }
  return { destino: url.href };
}

// Estado que o admin vê e a rota pública usa. Sem valor gravado, ou com um
// valor gravado que não passa na validação, vale o destino padrão (a página
// de planos) — o QR impresso nunca leva a um endereço inseguro.
async function lerEstado() {
  const padrao = destinoPadrao();
  const semConfiguracao = {
    linkPermanente: linkPermanente(),
    destino: padrao,
    destinoPadrao: padrao,
    padrao: true,
    atualizadoEm: null,
    atualizadoPor: null,
  };
  const bruto = await pontosRepo.obterConfiguracao(CHAVE);
  if (bruto === null) return semConfiguracao;
  let salvo = null;
  try {
    salvo = JSON.parse(bruto);
  } catch {}
  const validado = validarDestino(salvo?.destino);
  if (!validado.destino) {
    console.error(
      `qr institucional: valor gravado em configuracoes_site é inválido (${validado.erro}); valendo o padrão`,
    );
    return semConfiguracao;
  }
  // Quem/quando só como texto e data de verdade: valor editado à mão no banco
  // não vira "Invalid Date" nem objeto na tela.
  const texto = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const quando = texto(salvo.atualizadoEm);
  return {
    ...semConfiguracao,
    destino: validado.destino,
    padrao: false,
    atualizadoEm: quando && !Number.isNaN(Date.parse(quando)) ? quando : null,
    atualizadoPor: texto(salvo.atualizadoPor),
  };
}

// `destino` já validado por `validarDestino`. Quem trocou e quando ficam
// junto do valor: é o único histórico, e o admin vê na própria tela.
async function definirDestino(destino, usuario) {
  const valor = { destino, atualizadoEm: new Date().toISOString(), atualizadoPor: usuario || null };
  await pontosRepo.definirConfiguracao(CHAVE, JSON.stringify(valor));
}

// A imagem só depende do link permanente, que não muda enquanto o processo
// vive: gera uma vez e guarda (o PNG de impressão custa ~0,3 s de CPU).
// Promessa que falha sai da memória, pra próxima tentativa gerar de novo.
const imagens = new Map();
function gerarUmaVez(chave, gerar) {
  if (!imagens.has(chave)) {
    imagens.set(
      chave,
      gerar().catch((err) => {
        imagens.delete(chave);
        throw err;
      }),
    );
  }
  return imagens.get(chave);
}

function gerarSvg(link) {
  return gerarUmaVez(`svg ${link}`, () => QRCode.toString(link, { ...OPCOES_QR, type: 'svg', width: 1024 }));
}

function gerarPng(link, lado) {
  return gerarUmaVez(`png ${lado} ${link}`, () => QRCode.toBuffer(link, { ...OPCOES_QR, type: 'png', width: lado }));
}

module.exports = {
  CAMINHO_PERMANENTE,
  TAMANHOS_PNG,
  // O QR do link de indicação (src/indicacoes/routes.js, 29/09/2026) usa a
  // mesma base e as mesmas opções — um QR só de regra no sistema.
  OPCOES_QR,
  baseDoSite,
  linkPermanente,
  destinoPadrao,
  validarDestino,
  lerEstado,
  definirDestino,
  gerarSvg,
  gerarPng,
};
