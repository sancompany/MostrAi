// Configuração da Trimundi — tudo lido do ambiente na hora do uso (nada no
// require), para o servidor da Mostraí subir igual sem nenhuma variável da
// Trimundi. Sem banco próprio configurado, o módulo fica desligado: as rotas
// respondem 503 e o login da Mostraí não procura operador (RN-T31).

const producao = () => process.env.NODE_ENV === 'production';

function urlDoBanco() {
  return process.env.TRIMUNDI_DATABASE_URL || '';
}

// host + porta + nome do banco, para comparar duas URLs sem olhar usuário/senha.
function identidadeDoBanco(url) {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase()}:${u.port || '5432'}/${decodeURIComponent(u.pathname.replace(/^\//, ''))}`;
  } catch {
    return null;
  }
}

// Trava de segurança: a Trimundi nunca roda (nem migra) no banco da Mostraí.
function mesmoBancoDaMostrai() {
  const trimundi = identidadeDoBanco(urlDoBanco());
  const mostrai = identidadeDoBanco(process.env.DATABASE_URL || '');
  return Boolean(trimundi && mostrai && trimundi === mostrai);
}

// Segredo-mestre: deriva as chaves do QR, dos códigos de ativação e dos
// tokens de acesso (src/trimundi/lib/chaves.js). Em produção é obrigatório e
// próprio; fora dela, sem ele, deriva do SESSION_SECRET com rótulo próprio —
// só para o ambiente local e os testes.
function segredoMestre() {
  const proprio = process.env.TRIMUNDI_SEGREDO || '';
  if (proprio.length >= 32) return proprio;
  if (producao()) return null;
  return `desenvolvimento:${process.env.SESSION_SECRET || 'trimundi-local'}`;
}

function configurada() {
  return Boolean(urlDoBanco()) && Boolean(segredoMestre()) && !mesmoBancoDaMostrai();
}

// San Checkout: a Trimundi é contratante próprio (chave, URL base e webhook
// só dela — docs/trimundi/api.md). Os dois endereços do Checkout não são
// intercambiáveis (API.md §2.1): BASE é a tela do comprador, API é a do servidor.
function checkout() {
  const baseUrl = (process.env.TRIMUNDI_CHECKOUT_BASE_URL || '').replace(/\/+$/, '');
  const apiUrl = (process.env.TRIMUNDI_CHECKOUT_API_URL || '').replace(/\/+$/, '');
  const contratanteId = process.env.TRIMUNDI_CHECKOUT_CONTRATANTE_ID || '';
  const chave = process.env.TRIMUNDI_CHECKOUT_KEY || '';
  return { configurado: Boolean(baseUrl && apiUrl && contratanteId && chave), baseUrl, apiUrl, contratanteId, chave };
}

// Pagamento simulado: só fora de produção e só com a variável ligada. Gera o
// mesmo aviso assinado que o Checkout mandaria e passa pelo mesmo caminho de
// conferência — nunca é tratado como pagamento real (o provedor fica 'simulado').
function pagamentoSimulado() {
  return !producao() && process.env.TRIMUNDI_PAGAMENTO_SIMULADO === '1';
}

// Armazenamento das imagens da edição. 'supabase' é o de produção (projeto
// próprio da Trimundi); 'local' grava em disco e só vale fora de produção.
function armazenamento() {
  const tipo = process.env.TRIMUNDI_ARMAZENAMENTO || '';
  if (tipo === 'local' && !producao()) {
    return { tipo: 'local', pasta: process.env.TRIMUNDI_ARMAZENAMENTO_PASTA || '.trimundi-arquivos' };
  }
  if (process.env.TRIMUNDI_SUPABASE_URL && process.env.TRIMUNDI_SUPABASE_SERVICE_ROLE_KEY) {
    return {
      tipo: 'supabase',
      url: process.env.TRIMUNDI_SUPABASE_URL,
      chave: process.env.TRIMUNDI_SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.TRIMUNDI_STORAGE_BUCKET || 'trimundi',
    };
  }
  return { tipo: null };
}

// E-mail próprio da Trimundi (um alias por projeto). Sem provedor, a mensagem
// fica guardada como 'aguardando_provedor' — nunca finge que foi enviada.
function email() {
  const remetente = process.env.TRIMUNDI_EMAIL_FROM || '';
  const smtp = {
    host: process.env.TRIMUNDI_SMTP_HOST || '',
    port: Number(process.env.TRIMUNDI_SMTP_PORT || 465),
    user: process.env.TRIMUNDI_SMTP_USER || '',
    pass: process.env.TRIMUNDI_SMTP_PASS || '',
  };
  const captura = !producao() ? process.env.TRIMUNDI_EMAIL_CAPTURA || '' : '';
  return {
    configurado: Boolean(remetente && (captura || (smtp.host && smtp.user && smtp.pass))),
    remetente,
    smtp,
    captura,
  };
}

function urlDoSite() {
  return (process.env.SITE_URL || '').replace(/\/+$/, '');
}

module.exports = {
  producao,
  urlDoBanco,
  identidadeDoBanco,
  mesmoBancoDaMostrai,
  segredoMestre,
  configurada,
  checkout,
  pagamentoSimulado,
  armazenamento,
  email,
  urlDoSite,
};
