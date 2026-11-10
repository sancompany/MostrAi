const { erro } = require('./erros');
const { limpar, validarCpf } = require('../../br/documento');

// Validação de toda entrada da Trimundi, com teto de tamanho no próprio
// validador (lição nº 24: formato não valida tamanho). Cada função devolve o
// valor normalizado ou lança 400 com a mensagem que a tela mostra.

function texto(valor, { campo, min = 0, max, obrigatorio = false, mensagem } = {}) {
  if (valor === undefined || valor === null) valor = '';
  if (typeof valor !== 'string' && typeof valor !== 'number') throw erro(400, mensagem || `${campo} inválido`);
  const v = String(valor).trim();
  if (!v && obrigatorio) throw erro(400, mensagem || `preencha ${campo}`);
  if (v && v.length < min) throw erro(400, mensagem || `${campo} curto demais`);
  if (max && v.length > max) throw erro(400, `${campo} passa de ${max} caracteres`);
  return v;
}

function opcional(valor, opcoes) {
  const v = texto(valor, opcoes);
  return v || null;
}

function inteiro(valor, { campo, min, max, obrigatorio = true, mensagem } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw erro(400, mensagem || `preencha ${campo}`);
    return null;
  }
  const n = typeof valor === 'number' ? valor : Number(String(valor).trim());
  if (!Number.isInteger(n)) throw erro(400, mensagem || `${campo} precisa ser um número inteiro`);
  if (min !== undefined && n < min) throw erro(400, mensagem || `${campo} mínimo: ${min}`);
  if (max !== undefined && n > max) throw erro(400, mensagem || `${campo} máximo: ${max}`);
  return n;
}

function booleano(valor, padrao = false) {
  if (valor === undefined || valor === null) return padrao;
  return valor === true || valor === 'true' || valor === 1 || valor === '1';
}

function escolha(valor, opcoes, { campo, mensagem } = {}) {
  if (!opcoes.includes(valor)) throw erro(400, mensagem || `${campo} inválido`);
  return valor;
}

// Data e hora em ISO 8601. Vazio = nulo ("A definir").
function dataHora(valor, { campo, obrigatorio = false } = {}) {
  if (valor === undefined || valor === null || valor === '') {
    if (obrigatorio) throw erro(400, `preencha ${campo}`);
    return null;
  }
  const d = new Date(valor);
  if (typeof valor !== 'string' || Number.isNaN(d.getTime())) throw erro(400, `${campo} inválida`);
  return d;
}

const SLUG_EVENTO = /^[A-Za-z0-9][A-Za-z0-9-]{2,59}$/;
const SLUG_EDICAO = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
// Primeiros segmentos que já são rotas da Trimundi em /ticket/* (RN-T01).
const RESERVADOS = new Set([
  'ativar',
  'checkin',
  'api',
  'admin',
  'operador',
  'pedido',
  'webhook',
  'entrar',
  'sair',
  'recuperar',
  'dev',
  'arquivos',
  'conta',
  'img',
  'i',
  'termos',
  'privacidade',
]);

function slugEvento(valor) {
  const v = texto(valor, { campo: 'o endereço do evento', obrigatorio: true, max: 60 });
  if (!SLUG_EVENTO.test(v)) throw erro(400, 'Use de 3 a 60 letras, números ou hífen, começando por letra ou número.');
  if (RESERVADOS.has(v.toLowerCase())) throw erro(400, 'Esse endereço é reservado — escolha outro.');
  return v;
}

function slugEdicao(valor) {
  const v = texto(valor, { campo: 'o endereço da edição', obrigatorio: true, max: 40 });
  if (!SLUG_EDICAO.test(v)) throw erro(400, 'Use até 40 letras, números ou hífen, começando por letra ou número.');
  return v;
}

function cpf(valor, { mensagem = 'CPF inválido — confira os números.' } = {}) {
  const v = limpar(String(valor ?? ''));
  if (!validarCpf(v)) throw erro(400, mensagem);
  return v;
}

// Sem vírgula, ponto e vírgula nem espaço: um endereço só (o cadastro da
// Mostraí já aceitou "a@x.com,b@y.com" como dois destinatários — achado da
// auditoria V1).
const EMAIL = /^[^\s@,;<>()[\]"]+@[^\s@,;<>()[\]"]+\.[^\s@,;<>()[\]".]{2,}$/;
function email(valor) {
  const v = texto(valor, { campo: 'o e-mail', obrigatorio: true, max: 200 }).toLowerCase();
  if (!EMAIL.test(v)) throw erro(400, 'Informe um e-mail válido.');
  return v;
}

function telefone(valor, { obrigatorio = false } = {}) {
  const v = String(valor ?? '').replace(/\D/g, '');
  if (!v && !obrigatorio) return null;
  if (!/^[0-9]{10,11}$/.test(v)) throw erro(400, 'Informe o telefone com DDD (10 ou 11 dígitos).');
  return v;
}

// Chave de idempotência gerada no navegador (duplo clique não emite duas).
function chave(valor) {
  const v = String(valor ?? '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(v)) throw erro(400, 'chave de envio inválida — recarregue a página');
  return v;
}

function id(valor, campo = 'id') {
  return inteiro(valor, { campo, min: 1, max: Number.MAX_SAFE_INTEGER });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(valor) {
  const v = String(valor ?? '').toLowerCase();
  return UUID.test(v) ? v : null;
}

module.exports = {
  texto,
  opcional,
  inteiro,
  booleano,
  escolha,
  dataHora,
  slugEvento,
  slugEdicao,
  cpf,
  email,
  telefone,
  chave,
  id,
  uuid,
  RESERVADOS,
};
