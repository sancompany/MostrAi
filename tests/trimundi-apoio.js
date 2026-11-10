// Apoio dos testes da Trimundi. Mesmo desenho da produção: o banco de teste
// da Mostraí, com a Trimundi no esquema próprio `trimundi` (nunca no
// `public`). Ambiente fixo por arquivo, sem depender do .env local: cada
// arquivo de teste roda no próprio processo.
require('dotenv').config();
const crypto = require('node:crypto');

const AMBIENTE = {
  TRIMUNDI_ATIVA: '1',
  TRIMUNDI_DATABASE_URL: '',
  TRIMUNDI_SEGREDO: 'segredo-de-teste-da-trimundi-0123456789abcdef',
  TRIMUNDI_ARMAZENAMENTO: '',
  TRIMUNDI_SUPABASE_URL: '',
  TRIMUNDI_EMAIL_FROM: '',
  // Nunca um serviço real nos testes: sem e-mail nem Storage da Mostraí.
  MOSTRAI_EMAIL_FROM: '',
  SMTP_HOST: '',
  SUPABASE_STORAGE_BUCKET: '',
  TRIMUNDI_EMAIL_CAPTURA: '',
  TRIMUNDI_PAGAMENTO_SIMULADO: '',
  TRIMUNDI_CHECKOUT_BASE_URL: 'https://checkout.teste.invalid',
  TRIMUNDI_CHECKOUT_API_URL: 'https://api.teste.invalid',
  TRIMUNDI_CHECKOUT_CONTRATANTE_ID: 'trimundi-teste',
  TRIMUNDI_CHECKOUT_KEY: 'chave-de-teste-do-contratante-trimundi-0123456789',
  SITE_URL: 'https://site.teste.invalid',
};
for (const [k, val] of Object.entries(AMBIENTE)) process.env[k] = val;
process.env.ADMIN_USER ||= 'admin';
process.env.ADMIN_PASSWORD ||= 'Admin12@teste';
process.env.SESSION_SECRET ||= 'teste-trimundi';

let preparado = null;
function prepararBanco() {
  // Os arquivos rodam em paralelo; o migrador tem trava própria.
  if (!preparado) preparado = require('../src/trimundi/db/migrate').migrar({ silencioso: true });
  return preparado;
}

const app = () => require('../src/server');

async function iniciarApp() {
  await prepararBanco();
  const server = app().listen(0);
  await new Promise((r) => server.once('listening', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    fechar: () => {
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

async function encerrar() {
  await require('../src/trimundi/db/conexao').encerrar();
  await require('../src/db/pool').end();
}

// IP próprio por arquivo (o limitador da Mostraí conta por IP e o banco de
// teste é compartilhado entre arquivos que rodam ao mesmo tempo).
// Faixa só da Trimundi (100.64.0.0/10, CGNAT): a 198.18/15 é dos testes de
// limite da Mostraí, e um login certo daqui zeraria o balde deles.
const REDE = `100.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 250)}`;
let proximoIp = 1;
const novoIp = () => `${REDE}.${(proximoIp++ % 250) + 1}`;

function cookiesDe(r) {
  return (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
}

async function entrarAdmin(srv) {
  const r = await fetch(`${srv.base}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': novoIp() },
    body: JSON.stringify({ usuario: process.env.ADMIN_USER, senha: process.env.ADMIN_PASSWORD }),
  });
  if (!r.ok) throw new Error(`login do admin falhou: ${r.status}`);
  // Ler o corpo antes de usar o cookie: a resposta só termina depois de a
  // sessão estar gravada (express-session).
  await r.json();
  return cookiesDe(r);
}

// Operador ativo e já logado (cookie). O login do operador é por uma rota
// só (ver S6); este é o único lugar dos testes que sabe qual.
const SENHA_OPERADOR = 'Portaria12@teste';
async function operadorLogado(srv, edicoes = 'todas') {
  const operadores = require('../src/trimundi/operadores');
  const email = `operador.${sufixo()}@exemplo.com`;
  const { operador, codigo } = await operadores.criar({ nome: `Operador ${sufixo()}`, email, edicoes }, AUTOR);
  const ip = novoIp();
  const pedirJson = async (caminho, corpo) => {
    const r = await fetch(`${srv.base}${caminho}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(corpo),
    });
    const json = await r.json().catch(() => null);
    return { r, json };
  };
  const at = await pedirJson('/ticket/api/ativar', { email, codigo, senha: SENHA_OPERADOR });
  if (!at.r.ok) throw new Error(`ativação falhou: ${at.r.status}`);
  const login = await pedirJson(ROTA_LOGIN_OPERADOR, { email, senha: SENHA_OPERADOR });
  if (!login.r.ok) throw new Error(`login do operador falhou: ${login.r.status}`);
  return { ...operador, email, cookie: cookiesDe(login.r) };
}
const ROTA_LOGIN_OPERADOR = '/ticket/api/operador/entrar';

// Cliente HTTP mínimo: JSON, cookie e IP.
function cliente(srv, { cookie = '', ip = novoIp() } = {}) {
  const pedir = async (metodo, caminho, corpo, extra = {}) => {
    // Atalho dos testes de venda: pedido sem cookie entra antes na conta do
    // `comprador` do corpo (a compra exige conta logada).
    let cookieDaVez = cookie;
    if (!cookie && metodo === 'POST' && caminho === '/ticket/api/pedidos' && corpo?.comprador) {
      cookieDaVez = await entrarCliente(srv, corpo.comprador, ip);
    }
    const r = await fetch(`${srv.base}${caminho}`, {
      method: metodo,
      redirect: 'manual',
      headers: {
        ...(corpo !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(cookieDaVez ? { cookie: cookieDaVez } : {}),
        'x-forwarded-for': ip,
        ...extra,
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const texto = await r.text();
    let json = null;
    try {
      json = texto ? JSON.parse(texto) : null;
    } catch {
      json = null;
    }
    return { status: r.status, json, texto, headers: r.headers, cookies: cookiesDe(r) };
  };
  return {
    get: (c, extra) => pedir('GET', c, undefined, extra),
    post: (c, corpo = {}, extra) => pedir('POST', c, corpo, extra),
    patch: (c, corpo = {}, extra) => pedir('PATCH', c, corpo, extra),
    delete: (c, extra) => pedir('DELETE', c, undefined, extra),
    ip,
    cookie,
  };
}

const sufixo = () => crypto.randomBytes(4).toString('hex');
const chave = () => crypto.randomBytes(12).toString('base64url');

// CPF válido gerado (dígitos verificadores corretos), único o bastante.
function cpf() {
  const n = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (n.every((d) => d === n[0])) n[0] = (n[0] + 1) % 10;
  const dv = (base, peso) => {
    const s = base.reduce((acc, d, i) => acc + d * (peso - i), 0);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  n.push(dv(n, 10));
  n.push(dv(n, 11));
  return n.join('');
}

const pessoa = (rotulo = 'Pessoa') => ({
  nome: `${rotulo} ${sufixo()}`,
  cpf: cpf(),
  email: `${rotulo
    .toLowerCase()
    .normalize('NFD')
    .replace(/[^a-z0-9]/g, '')}.${sufixo()}@exemplo.com`,
});

const AUTOR = { autor: 'teste', autorAccess: null };

// Conta de cliente JÁ confirmada para a pessoa (a compra exige conta). O
// mesmo CPF devolve a mesma conta; a senha é sempre SENHA_CONTA.
const SENHA_CONTA = 'Conta12@teste';
let hashDaSenha = null;
async function contaDe(p) {
  const { consultar } = require('../src/trimundi/db/conexao');
  const cpfLimpo = String(p.cpf).replace(/\D/g, '');
  const achada = await consultar(
    'SELECT id, nome, cpf, email, termos_versao, termos_aceitos_em FROM clientes WHERE cpf = $1 AND anonimizado_em IS NULL',
    [cpfLimpo],
  );
  if (achada.rows[0]) return achada.rows[0];
  hashDaSenha ||= await require('../src/lib/senha').gerarHash(SENHA_CONTA);
  const { rows } = await consultar(
    `INSERT INTO clientes (nome, cpf, email, senha_hash, email_confirmado_em, termos_versao, termos_aceitos_em,
        maioridade_declarada_em)
     VALUES ($1, $2, $3, $4, now(), $5, now(), now()) RETURNING id, nome, cpf, email, termos_versao, termos_aceitos_em`,
    [p.nome, cpfLimpo, String(p.email).toLowerCase(), hashDaSenha, require('../src/trimundi/legal').VERSAO],
  );
  return rows[0];
}

// Cookie de sessão de cliente logado (pela rota de login de verdade).
async function entrarCliente(srv, p, ip = novoIp()) {
  const c = await contaDe(p);
  const r = await fetch(`${srv.base}/ticket/api/conta/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify({ email: c.email, senha: SENHA_CONTA }),
  });
  if (!r.ok) throw new Error(`login do cliente falhou: ${r.status}`);
  await r.json();
  return cookiesDe(r);
}

// Edição publicada com um tipo de ingresso (e lotes) — atalho pelos serviços.
async function edicaoPronta({
  lotes = [{ preco_centavos: 5000, quantidade: 10 }],
  capacidade = null,
  limite = null,
  publicar = true,
} = {}) {
  const eventos = require('../src/trimundi/eventos');
  const catalogo = require('../src/trimundi/catalogo');
  const s = sufixo();
  const ed = await eventos.criarEdicao(
    {
      evento: { nome: `Evento ${s}`, slug: `ev-${s}` },
      edicao: {
        nome: 'Edição 01',
        slug: 'ED01',
        descricao: 'Edição de teste',
        classificacao_etaria: '18',
        capacidade,
        textos: { regras_entrada: 'Documento com foto.', termos_compra: 'Termos de teste.' },
      },
    },
    AUTOR,
  );
  const tipo = await catalogo.criarTipo(ed.id, { nome: 'Pista', limite_por_comprador: limite, lotes }, AUTOR);
  if (publicar) await eventos.mudarStatus(ed.id, 'publicado', AUTOR);
  return { edicao: await eventos.obterEdicao(ed.id), tipo, slugEvento: `ev-${s}`, slugEdicao: 'ED01' };
}

// Pedido criado pelo mesmo caminho da página pública (cotação → criação).
async function novoPedido(pronta, itens, extra = {}) {
  const pedidos = require('../src/trimundi/pedidos');
  const cot = await pedidos.cotar({ evento: pronta.slugEvento, edicao: pronta.slugEdicao, itens });
  const corpo = {
    evento: pronta.slugEvento,
    edicao: pronta.slugEdicao,
    itens,
    comprador: extra.comprador || pessoa('Comprador'),
    participantes: extra.participantes || cot.vagas.map(() => pessoa('Participante')),
    aceite: { aceito: true, termos: cot.termos.map((t) => t.id), idade: true },
    chave: extra.chave || chave(),
    ...(extra.indicacao ? { indicacao: extra.indicacao } : {}),
  };
  const conta = await contaDe(corpo.comprador);
  const r = await pedidos.criar(corpo, { ip: '100.64.0.1', userAgent: 'teste', cliente: conta });
  return { ...r, corpo, cot };
}

const itensDe = (tipo, quantidade) => ({ tipos: [{ categoria_id: tipo.id, quantidade }] });

// Aviso v2 de pedido (API.md §4.3.3) com os valores do pedido.
async function aviso(pedidoId, status, extra = {}) {
  const { consultar } = require('../src/trimundi/db/conexao');
  const { rows } = await consultar('SELECT total_centavos, charge_id FROM pedidos WHERE id = $1', [pedidoId]);
  const total = rows[0] ? Number(rows[0].total_centavos) / 100 : 10;
  return {
    versao: 2,
    tipo: 'pedido',
    eventoId: crypto.randomUUID(),
    ocorridoEm: new Date().toISOString(),
    pedidoId,
    chargeId: rows[0]?.charge_id || `pay_${sufixo()}`,
    status,
    statusFinanceiro: status,
    valorCheio: total,
    desconto: 0,
    cupom: null,
    valorComDesconto: total,
    frete: 0,
    taxaDoProjeto: 0,
    taxaAsaas: 0.99,
    taxaPropria: 0.5,
    taxaIsenta: false,
    taxasTotais: 1.49,
    metodoPagamento: 'pix',
    valorCobrado: Math.round((total + 1.49) * 100) / 100,
    valorEstornado: null,
    estornoParcial: false,
    cotacaoId: null,
    pagamentoDuplicado: false,
    duplicadoCom: [],
    ...extra,
  };
}

// Grava o aviso como a fila grava e espera ele ser aplicado. Outro arquivo
// de teste pode estar processando a fila ao mesmo tempo (banco de teste
// compartilhado): processa e confere até sair de verdade.
async function aplicarAviso(payload) {
  const pagamentos = require('../src/trimundi/pagamentos');
  await pagamentos.registrarEvento({ eventoId: payload.eventoId, provedor: 'teste', payload });
  return aguardarEvento(payload.eventoId);
}

async function aguardarEvento(eventoId) {
  const pagamentos = require('../src/trimundi/pagamentos');
  const { consultar } = require('../src/trimundi/db/conexao');
  for (let i = 0; i < 200; i++) {
    await pagamentos.processarFila();
    const { rows } = await consultar('SELECT processamento, resultado FROM pagamento_eventos WHERE evento_id = $1', [
      eventoId,
    ]);
    if (rows[0]?.processamento === 'processado') return rows[0].resultado;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`evento ${eventoId} não foi processado`);
}

async function pagar(pedidoId, extra = {}) {
  return aplicarAviso(await aviso(pedidoId, 'confirmado', extra));
}

function assinarWebhook(
  payload,
  { chave: k = process.env.TRIMUNDI_CHECKOUT_KEY, ts = Math.floor(Date.now() / 1000) } = {},
) {
  const corpo = JSON.stringify(payload);
  const assinatura = `sha256=${crypto.createHmac('sha256', k).update(`${ts}.${corpo}`).digest('hex')}`;
  return {
    corpo,
    headers: {
      'content-type': 'application/json',
      'x-checkout-signature': assinatura,
      'x-checkout-timestamp': String(ts),
    },
  };
}

module.exports = {
  prepararBanco,
  iniciarApp,
  encerrar,
  entrarAdmin,
  cliente,
  novoIp,
  sufixo,
  chave,
  cpf,
  pessoa,
  AUTOR,
  SENHA_CONTA,
  SENHA_OPERADOR,
  operadorLogado,
  contaDe,
  entrarCliente,
  edicaoPronta,
  novoPedido,
  itensDe,
  aviso,
  aplicarAviso,
  aguardarEvento,
  pagar,
  assinarWebhook,
};
