// Configuração da Trimundi — tudo lido do ambiente na hora do uso (nada no
// require), para o servidor da Mostraí subir igual sem nenhuma variável da
// Trimundi. Sem banco próprio configurado, o módulo fica desligado: as rotas
// respondem 503 e o login da Mostraí não procura operador (RN-T31).

const producao = () => process.env.NODE_ENV === 'production';

// Estrutura da Mostraí (decisão do dono, 09/11/2026): as tabelas da Trimundi
// moram no MESMO banco da Mostraí, num esquema próprio (`trimundi`) — sem
// custo novo e sem tocar nas tabelas da Mostraí (esquema `public`). Liga com
// TRIMUNDI_ATIVA=1; TRIMUNDI_DATABASE_URL aponta outro banco, se um dia for
// preciso separar de novo.
const ESQUEMA = 'trimundi';

function urlDoBanco() {
  if (process.env.TRIMUNDI_DATABASE_URL) return process.env.TRIMUNDI_DATABASE_URL;
  return process.env.TRIMUNDI_ATIVA === '1' ? process.env.DATABASE_URL || '' : '';
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

// O isolamento é por esquema (`SET search_path` em cada conexão), e isso só
// se sustenta numa conexão de sessão. O pooler de TRANSAÇÃO do Supabase
// (porta 6543) troca de conexão a cada transação e perderia o esquema: com
// ele, a Trimundi não liga.
function poolerDeTransacao() {
  const id = identidadeDoBanco(urlDoBanco());
  return Boolean(id && /:6543\//.test(id));
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
  return Boolean(urlDoBanco()) && Boolean(segredoMestre()) && !poolerDeTransacao();
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

// Armazenamento das imagens da edição: o Storage da Mostraí (mesmo bucket,
// pasta `trimundi/`), ou um próprio se TRIMUNDI_SUPABASE_* existir; 'local'
// grava em disco e só vale fora de produção.
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
      prefixo: '',
    };
  }
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_STORAGE_BUCKET) {
    return {
      tipo: 'supabase',
      url: process.env.SUPABASE_URL,
      chave: process.env.SUPABASE_SERVICE_ROLE_KEY,
      bucket: process.env.SUPABASE_STORAGE_BUCKET,
      prefixo: 'trimundi/',
    };
  }
  return { tipo: null };
}

// E-mail: o da Mostraí (remetente MOSTRAI_EMAIL_FROM e o SMTP_* dela —
// decisão do dono, 09/11/2026); TRIMUNDI_* sobrepõe, se um dia existir. Sem
// provedor, a mensagem fica 'aguardando_provedor' — nunca finge que saiu.
function email() {
  const de = (nome) => process.env[`TRIMUNDI_${nome}`] || process.env[nome] || '';
  const remetente = process.env.TRIMUNDI_EMAIL_FROM || process.env.MOSTRAI_EMAIL_FROM || '';
  const smtp = {
    host: de('SMTP_HOST'),
    port: Number(de('SMTP_PORT') || 465),
    user: de('SMTP_USER'),
    pass: de('SMTP_PASS'),
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
  ESQUEMA,
  producao,
  urlDoBanco,
  identidadeDoBanco,
  poolerDeTransacao,
  segredoMestre,
  configurada,
  checkout,
  pagamentoSimulado,
  armazenamento,
  email,
  urlDoSite,
};
