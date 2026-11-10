const express = require('express');
const multer = require('multer');
const { tratarErros, erro } = require('../lib/erros');
const v = require('../lib/validacao');
const { autorDaRequisicao } = require('../lib/registro');
const config = require('../config');
const eventos = require('../eventos');
const catalogo = require('../catalogo');
const promocoes = require('../promocoes');
const emissao = require('../emissao');
const participantes = require('../participantes');
const operadores = require('../operadores');
const reembolsos = require('../reembolsos');
const indicacao = require('../indicacao');
const desempenho = require('../desempenho');

// Admin da Trimundi — `/admin/trimundi/*` (api.md). O server.js já exige a
// sessão do Admin em todo /admin, e o Cloudflare Access fica na frente; a
// conferência daqui é a segunda trava, caso o router seja montado em outro
// lugar. Toda escrita grava o histórico (RN-T29) na própria transação.

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

router.use('/admin/trimundi', (req, res, next) => {
  if (!req.session?.isAdmin) return res.status(401).json({ erro: 'não autorizado' });
  if (!config.configurada()) return res.status(503).json({ erro: 'a Trimundi não está configurada neste ambiente' });
  next();
});

const id = (req, nome = 'id') => v.id(req.params[nome]);
const autor = (req) => autorDaRequisicao(req);

router.get('/admin/trimundi/estado', (_req, res) => {
  res.json({
    configurada: true,
    checkout: config.checkout().configurado ? 'configurado' : config.pagamentoSimulado() ? 'simulado' : 'ausente',
    imagens: require('../armazenamento').adaptador()?.tipo || null,
    email: config.email().configurado,
    // Pedido de teste só fora de produção (RN-T19).
    pedido_teste: !config.producao(),
  });
});

// Evento e edição (T1, T1a)
router.get('/admin/trimundi/edicoes', async (_req, res) => res.json(await eventos.listarEdicoes()));
router.get('/admin/trimundi/eventos', async (_req, res) => res.json(await eventos.listarEventos()));
router.post('/admin/trimundi/edicoes', async (req, res) =>
  res.status(201).json(await eventos.criarEdicao(req.body, autor(req))),
);
router.get('/admin/trimundi/edicoes/:id', async (req, res) => res.json(await eventos.obterEdicao(id(req))));
router.patch('/admin/trimundi/edicoes/:id', async (req, res) =>
  res.json(await eventos.atualizarEdicao(id(req), req.body, autor(req))),
);
router.post('/admin/trimundi/edicoes/:id/status', async (req, res) =>
  res.json(await eventos.mudarStatus(id(req), String(req.body?.status || ''), autor(req))),
);
router.post('/admin/trimundi/edicoes/:id/imagens', upload.single('arquivo'), async (req, res) => {
  res.status(201).json(await eventos.adicionarImagem(id(req), String(req.body?.tipo || ''), req.file, autor(req)));
});
router.delete('/admin/trimundi/imagens/:id', async (req, res) =>
  res.json(await eventos.removerImagem(id(req), autor(req))),
);

// Benefícios, tipos de ingresso e lotes (T2)
router.get('/admin/trimundi/edicoes/:id/beneficios', async (req, res) =>
  res.json(await catalogo.listarBeneficios(id(req))),
);
router.post('/admin/trimundi/edicoes/:id/beneficios', async (req, res) =>
  res.status(201).json(await catalogo.criarBeneficio(id(req), req.body, autor(req))),
);
router.patch('/admin/trimundi/beneficios/:id', async (req, res) =>
  res.json(await catalogo.atualizarBeneficio(id(req), req.body, autor(req))),
);
router.get('/admin/trimundi/edicoes/:id/tipos', async (req, res) => res.json(await catalogo.listarTipos(id(req))));
router.post('/admin/trimundi/edicoes/:id/tipos', async (req, res) =>
  res.status(201).json(await catalogo.criarTipo(id(req), req.body, autor(req))),
);
router.patch('/admin/trimundi/tipos/:id', async (req, res) =>
  res.json(await catalogo.atualizarTipo(id(req), req.body, autor(req))),
);
router.post('/admin/trimundi/lotes/:id/encerrar', async (req, res) =>
  res.json(await catalogo.encerrarLote(id(req), autor(req))),
);

// Promoções (T3)
router.get('/admin/trimundi/edicoes/:id/promocoes', async (req, res) =>
  res.json(await promocoes.listarPromocoes(id(req))),
);
router.post('/admin/trimundi/edicoes/:id/promocoes', async (req, res) =>
  res.status(201).json(await promocoes.criarPromocao(id(req), req.body, autor(req))),
);
router.patch('/admin/trimundi/promocoes/:id', async (req, res) =>
  res.json(await promocoes.atualizarPromocao(id(req), req.body, autor(req))),
);

// Participantes, cortesias, pedidos e reembolsos (T4)
router.get('/admin/trimundi/edicoes/:id/participantes', async (req, res) => {
  res.json(
    await participantes.listar(id(req), {
      filtro: String(req.query.filtro || 'todos'),
      busca: String(req.query.busca || ''),
      categoria: req.query.categoria || null,
      pagina: req.query.pagina,
    }),
  );
});
router.get('/admin/trimundi/edicoes/:id/resumo', async (req, res) => res.json(await participantes.resumo(id(req))));
router.get('/admin/trimundi/edicoes/:id/avisos', async (req, res) => res.json(await participantes.avisos(id(req))));
router.post('/admin/trimundi/edicoes/:id/cortesias', async (req, res) =>
  res.status(201).json(await emissao.emitirCortesia(id(req), req.body, autor(req))),
);
router.post('/admin/trimundi/ingressos/:id/cancelar', async (req, res) =>
  res.json(await emissao.cancelarCortesia(id(req), req.body?.motivo, autor(req))),
);
router.get('/admin/trimundi/ingressos/:id/qr', async (req, res) => {
  const qr = await participantes.qrDoIngresso(id(req), req.query.formato === 'svg' ? 'svg' : 'png');
  res.set('Cache-Control', 'no-store');
  res.type(qr.tipo).send(qr.corpo);
});
router.get('/admin/trimundi/pedidos/:pedido', async (req, res) =>
  res.json(await participantes.pedidoNoAdmin(req.params.pedido)),
);
router.post('/admin/trimundi/pedidos/:pedido/link', async (req, res) =>
  res.json(await participantes.linkDoPedido(req.params.pedido, autor(req))),
);
router.post('/admin/trimundi/pedidos/:pedido/reembolsos', async (req, res) =>
  res.status(201).json(await reembolsos.solicitar(req.params.pedido, req.body, autor(req))),
);
router.post('/admin/trimundi/reembolsos/:id/reenviar', async (req, res) =>
  res.json(await reembolsos.enviarAoCheckout(id(req))),
);
// Pedido de teste: o fluxo real (reserva, Checkout, emissão), fora das métricas.
router.post('/admin/trimundi/edicoes/:id/pedido-teste', async (req, res) =>
  res.status(201).json(await require('../pedidos').criarTeste(id(req), req.body, autor(req))),
);

// Check-in offline: leituras que o servidor não aceitou na sincronização.
router.get('/admin/trimundi/edicoes/:id/checkin/conflitos', async (req, res) =>
  res.json(await require('../checkin-offline').conflitos(id(req))),
);

router.post('/admin/trimundi/edicoes/:id/avisos/resolver', async (req, res) =>
  res.json(await participantes.resolverAviso(id(req), req.body, autor(req))),
);

// Pedido do titular (LGPD): CPF só no corpo (nunca na URL, que vai para log).
router.post('/admin/trimundi/titular/consultar', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await require('../titular').exportar(req.body?.cpf));
});
router.post('/admin/trimundi/titular/anonimizar', async (req, res) =>
  res.json(await require('../titular').anonimizar(req.body?.cpf, req.body?.motivo, autor(req))),
);

// Operadores (T5)
// Indicação: campanhas por edição, quem indicou e a entrega da recompensa.
router.get('/admin/trimundi/edicoes/:id/campanhas', async (req, res) =>
  res.json(await indicacao.listarCampanhas(id(req))),
);
router.post('/admin/trimundi/edicoes/:id/campanhas', async (req, res) =>
  res.status(201).json(await indicacao.criarCampanha(id(req), req.body, autorDaRequisicao(req))),
);
router.patch('/admin/trimundi/campanhas/:id', async (req, res) =>
  res.json(await indicacao.atualizarCampanha(id(req), req.body, autorDaRequisicao(req))),
);
// Desempenho das indicações: ranking da edição (e CSV para premiações) e a
// ficha do comprador. CPF inteiro só pelo POST próprio, auditado.
router.get('/admin/trimundi/edicoes/:id/ranking', async (req, res) => res.json(await desempenho.ranking(id(req))));
router.get('/admin/trimundi/edicoes/:id/ranking.csv', async (req, res) => {
  const csv = await desempenho.rankingCsv(id(req));
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', `attachment; filename="ranking-indicacoes-edicao-${id(req)}.csv"`);
  res.type('text/csv; charset=utf-8').send(csv);
});
router.get('/admin/trimundi/edicoes/:id/compradores/:cliente', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await desempenho.fichaDoComprador(id(req), id(req, 'cliente')));
});
router.post('/admin/trimundi/clientes/:id/cpf', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await desempenho.cpfCompleto(id(req), autor(req)));
});
router.get('/admin/trimundi/campanhas/:id/indicadores', async (req, res) =>
  res.json(await indicacao.indicadoresDaCampanha(id(req))),
);
router.post('/admin/trimundi/recompensas/:id/entregar', async (req, res) =>
  res.json(await indicacao.entregarRecompensa(id(req), autorDaRequisicao(req))),
);

// Lista com o link e os números de cada operador (só conversões confirmadas).
router.get('/admin/trimundi/operadores', async (_req, res) => {
  const [lista, numeros] = await Promise.all([operadores.listar(), desempenho.numerosDosOperadores()]);
  const zero = { pessoas: 0, compras: 0, ingressos: 0 };
  const saida = [];
  for (const o of lista) {
    const { codigo, links } = await indicacao.linksDoOperador(o.id);
    saida.push({ ...o, indicacao: { codigo, links, ...(numeros.get(Number(o.id)) || zero) } });
  }
  res.json(saida);
});
router.get('/admin/trimundi/operadores/:id/desempenho', async (req, res) =>
  res.json(await desempenho.fichaDoOperador(id(req))),
);
router.post('/admin/trimundi/operadores', async (req, res) =>
  res.status(201).json(await operadores.criar(req.body, autor(req))),
);
router.patch('/admin/trimundi/operadores/:id', async (req, res) =>
  res.json(await operadores.atualizar(id(req), req.body, autor(req))),
);
router.post('/admin/trimundi/operadores/:id/codigo', async (req, res) =>
  res.json(await operadores.novoCodigo(id(req), autor(req))),
);
router.post('/admin/trimundi/operadores/:id/desativar', async (req, res) =>
  res.json(await operadores.desativar(id(req), autor(req))),
);
router.post('/admin/trimundi/operadores/:id/reativar', async (req, res) =>
  res.json(await operadores.reativar(id(req), autor(req))),
);

router.use('/admin/trimundi', (err, req, res, next) => {
  if (err?.code === 'LIMIT_FILE_SIZE')
    return res.status(400).json({ erro: 'Envie uma imagem JPEG, PNG ou WebP de até 8 MB.' });
  return tratarErros(err, req, res, next);
});

module.exports = { router, erro };
