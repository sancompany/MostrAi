const crypto = require('node:crypto');
const email = require('../financeiro/email');

// O texto de um comunicado: o que o admin escreve vira TEXTO, nunca HTML.
// Não existe editor de HTML — o backend monta o e-mail com o template
// institucional de todo e-mail da Mostraí (`mensagem` em
// src/financeiro/email.js: cabeçalho, título, parágrafos, botão, rodapé e a
// versão em texto puro), e todo campo passa pelo `esc` de lá. A prévia, o
// teste e o envio de verdade chamam `montar` daqui — a prévia é o e-mail.

const LIMITES = { assunto: 150, titulo: 150, mensagem: 5000, botaoTexto: 40, botaoUrl: 500 };

// Controle invisível que não tem o que fazer num e-mail: C0/C1, DEL e os
// marcadores de direção de texto (U+202A–E, U+2066–9 — o truque de inverter
// a leitura de um trecho) e o BOM. Quebra de linha e tab só no corpo.
// biome-ignore lint/suspicious/noControlCharactersInRegex: caractere de controle é justamente o que se remove
const CONTROLE_LINHA = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: caractere de controle é justamente o que se remove
const CONTROLE_TEXTO = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/g;

// Campo de uma linha (assunto, título, texto do botão): quebra de linha vira
// espaço — no assunto, CR/LF seria injeção de cabeçalho no e-mail.
function linha(valor) {
  return String(valor ?? '')
    .normalize('NFC')
    .replace(CONTROLE_LINHA, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Corpo: mantém parágrafos (linha em branco) e quebras simples; no máximo
// uma linha em branco seguida; sem espaço sobrando no fim das linhas.
function texto(valor) {
  return String(valor ?? '')
    .normalize('NFC')
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(CONTROLE_TEXTO, '')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Link do botão. Mesma régua do destino do QR institucional
// (src/midias/qr-institucional.js#validarDestino): https — http só onde o
// próprio site roda em http (ambiente local) —, sem usuário/senha embutidos
// (https://mostrai.com.br@golpe.com), com domínio. Isso também barra
// javascript:, data:, file: e afins.
function validarLink(bruto) {
  const valor = String(bruto ?? '').trim();
  if (!valor) return { erro: 'informe o link do botão' };
  if (valor.length > LIMITES.botaoUrl) return { erro: `link longo demais — o máximo é ${LIMITES.botaoUrl} caracteres` };
  // biome-ignore lint/suspicious/noControlCharactersInRegex: caractere de controle é justamente o que se recusa
  if (/[\s\u0000-\u001f\u007f]/.test(valor)) return { erro: 'o link não pode ter espaços nem quebras de linha' };
  let url;
  try {
    url = new URL(valor);
  } catch {
    return { erro: 'link inválido — cole o endereço completo, começando com https://' };
  }
  let local = false;
  try {
    local = new URL(process.env.SITE_URL).protocol === 'http:';
  } catch {}
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    return { erro: 'use um link seguro, começando com https://' };
  }
  if (url.username || url.password) return { erro: 'o link não pode ter usuário ou senha' };
  if (!url.hostname.includes('.') && !(local && url.hostname === 'localhost')) {
    return { erro: 'link inválido — falta o domínio (ex.: .com.br)' };
  }
  return { url: url.href };
}

// Devolve `{ conteudo }` normalizado ou `{ erro, campo }` (o primeiro
// problema, com o campo pra tela marcar).
function validar(corpo = {}) {
  const assunto = linha(corpo.assunto);
  const titulo = linha(corpo.titulo);
  const mensagem = texto(corpo.mensagem);
  const botaoTexto = linha(corpo.botaoTexto);
  const botaoUrl = String(corpo.botaoUrl ?? '').trim();

  if (assunto.length < 3) return { erro: 'escreva o assunto (pelo menos 3 caracteres)', campo: 'assunto' };
  if (assunto.length > LIMITES.assunto) {
    return { erro: `assunto longo demais — o máximo é ${LIMITES.assunto} caracteres`, campo: 'assunto' };
  }
  if (titulo.length < 3) return { erro: 'escreva o título (pelo menos 3 caracteres)', campo: 'titulo' };
  if (titulo.length > LIMITES.titulo) {
    return { erro: `título longo demais — o máximo é ${LIMITES.titulo} caracteres`, campo: 'titulo' };
  }
  if (!mensagem) return { erro: 'escreva a mensagem', campo: 'mensagem' };
  if (mensagem.length > LIMITES.mensagem) {
    return { erro: `mensagem longa demais — o máximo é ${LIMITES.mensagem} caracteres`, campo: 'mensagem' };
  }

  let botao = null;
  if (botaoTexto || botaoUrl) {
    if (!botaoTexto) return { erro: 'escreva o texto do botão (ou apague o link)', campo: 'botaoTexto' };
    if (botaoTexto.length > LIMITES.botaoTexto) {
      return { erro: `texto do botão longo demais — o máximo é ${LIMITES.botaoTexto} caracteres`, campo: 'botaoTexto' };
    }
    const link = validarLink(botaoUrl);
    if (link.erro) return { erro: link.erro, campo: 'botaoUrl' };
    botao = { texto: botaoTexto, url: link.url };
  }
  return { conteudo: { assunto, titulo, mensagem, botao } };
}

// Linha gravada (comunicados) → conteúdo.
function deLinha(c) {
  return {
    assunto: c.assunto,
    titulo: c.titulo,
    mensagem: c.mensagem,
    botao: c.botao_texto ? { texto: c.botao_texto, url: c.botao_url } : null,
  };
}

// Por que a pessoa recebe, e como parar — a saída que o perfil já oferece
// (a mesma caixa que o envio respeita: src/comunicados/publicos.js).
const NOTA_RODAPE =
  'Você recebe este comunicado porque tem uma conta na Mostraí. Se não quiser mais receber comunicados como este, abra seu perfil no painel e desmarque "Quero receber novidades e ofertas da Mostraí por e-mail".';

const AVISO_TESTE =
  'ENVIO DE TESTE — só você recebeu esta mensagem. Ela não foi para as contas e não entra no histórico.';

// Texto da prévia da caixa de entrada (o trecho cinza depois do assunto).
const previaDe = (mensagem) => {
  const corrido = mensagem.replace(/\s+/g, ' ').trim();
  return corrido.length > 110 ? `${corrido.slice(0, 107)}...` : corrido;
};

// O e-mail pronto: { assunto, text, html }. `teste` marca assunto e corpo.
function montar(conteudo, { teste = false } = {}) {
  const paragrafos = conteudo.mensagem
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const { text, html } = email.mensagem({
    previa: teste ? AVISO_TESTE : previaDe(conteudo.mensagem),
    titulo: conteudo.titulo,
    paragrafos: teste ? [AVISO_TESTE, ...paragrafos] : paragrafos,
    botao: conteudo.botao || undefined,
    nota: NOTA_RODAPE,
    quebrasDeLinha: true,
  });
  return { assunto: teste ? `[TESTE] ${conteudo.assunto}` : conteudo.assunto, text, html };
}

// Impressão digital de público + conteúdo: o mesmo comunicado mandado de
// novo pro mesmo público (página recarregada no meio do envio, outra aba)
// é reconhecido mesmo sem a chave do navegador.
function impressaoDe(publico, conteudo) {
  const partes = [
    publico,
    conteudo.assunto,
    conteudo.titulo,
    conteudo.mensagem,
    conteudo.botao?.texto || '',
    conteudo.botao?.url || '',
  ];
  return crypto.createHash('sha256').update(JSON.stringify(partes)).digest('hex');
}

module.exports = {
  LIMITES,
  NOTA_RODAPE,
  AVISO_TESTE,
  linha,
  texto,
  validarLink,
  validar,
  deLinha,
  montar,
  impressaoDe,
};
