const express = require('express');
const { limiteTentativas, limiteTentativasPorAlvo, descontarAcerto } = require('../../lib/limite-tentativas');
const { tratarErros, erro } = require('../lib/erros');
const v = require('../lib/validacao');
const config = require('../config');
const paginas = require('../paginas');
const pedidos = require('../pedidos');
const publico = require('../publico');
const armazenamento = require('../armazenamento');
const contrato = require('../checkout/contrato');
const webhook = require('../checkout/webhook');
const { consultar, emTransacao } = require('../db/conexao');
const { exigirCliente } = require('./conta');

// Rotas públicas da Trimundi — `/ticket/*` (api.md). Toda rota que faz
// trabalho com dado do comprador passa pelo limitador da Mostraí (IP e,
// quando há alvo, o e-mail): erro conta, acerto desconta.

const router = express.Router();

const ipDo = (req) => req.get('cf-connecting-ip') || req.ip;
const acertou = (req, res) => descontarAcerto(req, res).catch(() => {});

// Arquivos de imagem no armazenamento local (só desenvolvimento).
let estaticoLocal = null;
router.use('/ticket/arquivos', (req, res, next) => {
  const a = armazenamento.adaptador();
  if (a?.tipo !== 'local') return next();
  if (!estaticoLocal || estaticoLocal.raiz !== a.raiz) {
    estaticoLocal = {
      raiz: a.raiz,
      servir: express.static(a.raiz, { dotfiles: 'deny', index: false, maxAge: '1h', fallthrough: false }),
    };
  }
  return estaticoLocal.servir(req, res, next);
});

// --- Home pública da TICK (/tic/eventos) e a lista de eventos dela
router.get('/tic', (_req, res) => res.redirect(302, '/tic/eventos'));
router.get('/tic/eventos', (_req, res) => paginas.enviar(res, 'eventos', { url: `${config.urlDoSite()}/tic/eventos` }));
router.get('/ticket/api/vitrine', async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ eventos: await require('../vitrine').listarEventos({ busca: req.query.q }) });
});

// --- API da vitrine e do pedido
router.get('/ticket/api/edicoes/:evento/:edicao', async (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json(await publico.edicaoPublica(req.params.evento, req.params.edicao));
});

// Quem indicou (aviso "Você chegou por indicação de…" na página de venda).
// Com a conta logada, registra a origem desta conta nesta edição — o
// primeiro link que valeu fica, também para o pedido. Devolve só nome e tipo
// do indicador; código inválido, da própria conta ou de operador sem acesso
// à edição é `null`, sem erro.
// Visitas pelo link (só para os números de "Indique e acompanhe"): um
// navegador conta uma vez por link. Teto por IP para ninguém inflar o número
// com ids inventados — passado o teto, a página segue normal, só não conta.
const visitasPorIp = new Map();
function contaVisita(req) {
  const ip = ipDo(req);
  const agora = Date.now();
  const atual = visitasPorIp.get(ip);
  if (!atual || agora - atual.inicio > 3600000) visitasPorIp.set(ip, { inicio: agora, n: 1 });
  else if (++atual.n > 60) return false;
  if (visitasPorIp.size > 20000) visitasPorIp.clear();
  return true;
}

router.post('/ticket/api/edicoes/:evento/:edicao/indicacao', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cliente = await require('../clientes').daSessao(req);
  const ed = await pedidos.edicaoPorEndereco(
    { query: (s, p) => consultar(s, p) },
    req.params.evento,
    req.params.edicao,
  );
  if (!ed || ed.status === 'rascunho') throw erro(404, 'evento não encontrado');
  const indicacao = await require('../indicacao').quemIndicou({
    clienteId: cliente?.id || null,
    edicaoId: ed.id,
    codigo: req.body?.codigo,
    visitante: req.body?.visitante,
    contarVisita: Boolean(req.body?.visitante) && contaVisita(req),
  });
  res.json({ indicacao });
});

// Link geral (/tic/eventos?ind=): quem indicou e a visita, sem edição.
router.post('/ticket/api/indicacao/visita', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cliente = await require('../clientes').daSessao(req);
  const indicacao = await require('../indicacao').quemIndicou({
    clienteId: cliente?.id || null,
    codigo: req.body?.codigo,
    visitante: req.body?.visitante,
    contarVisita: Boolean(req.body?.visitante) && contaVisita(req),
  });
  res.json({ indicacao });
});

router.post('/ticket/api/cotacao', limiteTentativas, async (req, res) => {
  const cotacao = await pedidos.cotar(req.body);
  await acertou(req, res);
  res.json(cotacao);
});

router.post('/ticket/api/pedidos', limiteTentativas, exigirCliente, async (req, res) => {
  const r = await pedidos.criar(req.body, {
    ip: ipDo(req),
    userAgent: req.get('user-agent'),
    cliente: req.clienteTrimundi,
  });
  await acertou(req, res);
  res
    .status(r.repetido ? 200 : 201)
    .json({ ...r, url: `/ticket/pedido/${r.pedido_id}?t=${encodeURIComponent(r.token)}` });
});

router.get('/ticket/api/pedidos/:id', limiteTentativas, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const dados = await pedidos.paraComprador(req.params.id, String(req.get('x-pedido-token') || req.query.t || ''));
  await acertou(req, res);
  res.json(dados);
});

// Recuperar o link: resposta sempre igual (não revela se há pedido). O link
// vai para o e-mail do COMPRADOR; sem provedor de e-mail ativo, a mensagem
// fica guardada e a página diz isso.
const alvoDaRecuperacao = (req) =>
  String(req.body?.email ?? '')
    .trim()
    .toLowerCase();
router.post('/ticket/api/recuperar', limiteTentativasPorAlvo(alvoDaRecuperacao), async (req, res) => {
  const email = v.email(req.body?.email);
  const cpf = v.cpf(req.body?.cpf);
  const { rows } = await consultar(
    `SELECT p.id FROM pedidos p JOIN compradores c ON c.id = p.comprador_id
      WHERE c.email = $1 AND c.cpf = $2 AND p.status IN ('pago', 'estornado') AND p.criado_em > now() - interval '400 days'
      ORDER BY p.criado_em DESC LIMIT 10`,
    [email, cpf],
  );
  for (const p of rows) {
    await emTransacao(async (cliente) => {
      const tk = await pedidos.novoAcesso(cliente, p.id, 'email');
      await require('../email').enfileirar(cliente, {
        chave: `recuperar:${p.id}:${Date.now()}`,
        tipo: 'recuperar_link',
        para: email,
        assunto: 'Link dos seus ingressos',
        texto: `Você pediu de novo o link do seu pedido:\n${config.urlDoSite()}/ticket/pedido/${p.id}?t=${tk}\n\nSe não foi você, ignore esta mensagem.`,
      });
    });
  }
  const ativo = config.email().configurado;
  res.json({
    ok: true,
    mensagem: ativo
      ? 'Se houver pedido pago com esses dados, o link vai para o e-mail do comprador em alguns minutos.'
      : 'Se houver pedido pago com esses dados, o link fica pronto para envio — o envio de e-mails dos ingressos ainda não está ativo; fale com a organização do evento.',
  });
});

// --- Contrato com o San Checkout (API.md §4.1 e §4.3)
router.get('/ticket/api/checkout/pedido/:pedidoId', async (req, res) => {
  if (!contrato.chaveConfere(req.get('X-Checkout-Key'))) return res.status(401).json({ erro: 'não autorizado' });
  const r = await contrato.respostaDoPedido(req.params.pedidoId);
  if (!r) return res.status(404).json({ erro: 'pedido não encontrado' });
  res.set('Cache-Control', 'no-store');
  res.json(r);
});
router.post('/ticket/api/checkout/webhook', webhook.receber);

// --- Pagamento simulado (só desenvolvimento, TRIMUNDI_PAGAMENTO_SIMULADO=1)
router.get('/ticket/dev/pagamento/:id', (_req, res, next) => {
  if (!config.pagamentoSimulado()) return next();
  paginas.enviar(res, 'simulador', {}, { cache: 'no-store' });
});
router.post('/ticket/api/dev/pagamento/:id', limiteTentativas, async (req, res) => {
  if (!config.pagamentoSimulado()) throw erro(404, 'não encontrado');
  const id = await pedidos.acessoValido(req.params.id, String(req.body?.t || ''));
  if (!id) throw erro(404, 'pedido não encontrado');
  const acao = v.escolha(String(req.body?.acao || ''), ['aprovar', 'recusar'], { mensagem: 'ação inválida' });
  const r = await require('../checkout/simulador').simular(id, acao === 'aprovar' ? 'confirmado' : 'recusado');
  await acertou(req, res);
  res.json(r);
});

// --- Páginas
router.get('/ticket/pedido/:id', (_req, res) => paginas.enviar(res, 'pedido', {}, { cache: 'no-store' }));
router.get('/ticket/recuperar', (_req, res) => paginas.enviar(res, 'recuperar'));

router.get('/ticket/:evento/:edicao', async (req, res, next) => {
  if (v.RESERVADOS.has(String(req.params.evento).toLowerCase())) return next();
  const meta = await publico.metaDaEdicao(req.params.evento, req.params.edicao);
  if (!meta) return next();
  const site = config.urlDoSite();
  const imagem = meta.imagem
    ? meta.imagem.startsWith('http')
      ? meta.imagem
      : `${site}${meta.imagem}`
    : `${site}/ticket/img/trimundi-logo-256.png`;
  paginas.enviar(res, 'edicao', {
    titulo: meta.titulo,
    descricao: meta.descricao || `Ingressos para ${meta.titulo}.`,
    imagem,
    url: `${site}${req.path}`,
  });
});

router.use('/ticket', tratarErros);

module.exports = { router };
