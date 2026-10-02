const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const multer = require('multer');
const movel = require('./movel');
const hospedagem = require('./hospedagem');
const interesses = require('./hospedagem-interesse');
const sse = require('../lib/sse');
const { limiteTentativas } = require('../lib/limite-tentativas');

// Ponto móvel e hospedagem temporária (migrations 112 e 113).
//
// Admin — tudo em /admin, então a guarda de sessão do admin (src/server.js)
// vale para todas: a conta da base, o anfitrião, o anunciante e o
// organizador do evento não mexem em nada daqui.
//   GET  /admin/pontos-moveis                                lista (Rede → Pontos móveis)
//   POST /admin/pontos-moveis                                criar móvel (+ Tela 1)
//   POST /admin/pontos/:id/foto-movel                        foto do equipamento
//   GET  /admin/pontos/:id/movel                             ficha (base, local atual, agenda, histórico)
//   PUT  /admin/pontos/:id/base                              definir/alterar a base
//   POST /admin/pontos/:id/eventos                           cadastrar evento
//   POST /admin/pontos/:id/eventos/:eventoId/:acao           iniciar | encerrar | cancelar
//   POST /admin/pontos/:id/hospedagens                       confirmar hospedagem (percentual congelado)
//   POST /admin/pontos/:id/hospedagens/:hid/:acao            iniciar | encerrar | cancelar
//   PUT  /admin/pontos/:id/hospedagens/:hid/periodo          alterar período / prorrogar
//   GET  /admin/hospedagem/percentual                        percentual + histórico
//   PUT  /admin/hospedagem/percentual                        alterar (auditado)
//   GET  /admin/hospedagem/interesses                        interesses recebidos
//   PATCH /admin/hospedagem/interesses/:id                   andamento e nota interna
//   GET  /admin/anunciantes/:id/saldo-hospedagem             saldo, extrato e hospedagens da conta
//   POST /admin/anunciantes/:id/saldo-hospedagem/ajustes     ajuste +/− com motivo
//
// Público e painel:
//   GET  /hospedagem/condicao                                o percentual em vigor (o site lê daqui)
//   POST /hospedagem/interesse                               interesse (visitante ou logado)
//   GET  /anunciantes/me/hospedagem                          as hospedagens e o saldo da conta logada
//   POST /anunciantes/me/hospedagem/interesse                interesse pelo painel (dados da conta)
const router = express.Router();

const idDaRota = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);
const adminDe = (req) => req.session?.adminUsuario || 'admin';
// Só imagem: o bucket é público (um .html "foto" seria servido como página).
// Arquivo de outro tipo é ignorado e a rota responde "envie uma imagem".
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype || '')),
});
// O temporário do multer some quando a resposta sai — inclusive quando a
// rota recusa antes de olhar o arquivo (id inválido).
const apagarTemporario = (req, res, next) => {
  res.on('close', () => req.file && fs.unlink(req.file.path, () => {}));
  next();
};

// Cada escrita avisa sem F5: o Admin (Rede), a conta da base e o anfitrião
// ("Meus pontos", painel) e quem escolheu o ponto (lista de pontos).
async function avisar(pontoId, extras = []) {
  sse.emitirParaAdmin('point.updated', { id: pontoId });
  for (const conta of await movel.contasInteressadas(pontoId, extras)) {
    sse.emitirParaConta(conta, 'point.updated', { id: pontoId });
    sse.emitirParaConta(conta, 'hosting.updated', {});
  }
}

const responderErro = (res, err) => {
  if (err.status) return res.status(err.status).json({ erro: err.message, ...(err.campo ? { campo: err.campo } : {}) });
  throw err;
};

function rota(fn) {
  return async (req, res) => {
    const id = idDaRota(req.params.id);
    if (!id) return res.status(404).json({ erro: 'ponto não encontrado' });
    try {
      await fn(req, res, id);
    } catch (err) {
      responderErro(res, err);
    }
  };
}

function simples(fn) {
  return async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      responderErro(res, err);
    }
  };
}

// ---------------------------------------------------------------------------
// Ponto móvel
// ---------------------------------------------------------------------------
router.get(
  '/admin/pontos-moveis',
  simples(async (_req, res) => {
    const [moveis, percentual] = await Promise.all([movel.listarMoveis(), hospedagem.percentualAtual()]);
    res.json({ moveis, percentual });
  }),
);

router.post(
  '/admin/pontos-moveis',
  simples(async (req, res) => {
    const r = await movel.criarPontoMovel(req.body, adminDe(req));
    sse.emitirParaAdmin('point.updated', { id: r.id });
    res.status(201).json(r);
  }),
);

// A foto do EQUIPAMENTO (não de um comércio): aparece no card do anunciante,
// no Admin e no site. Mesmo bucket e padrão de upsert + `?v=` das outras
// fotos; o nome do objeto vem do id numérico, nunca do texto da rota.
router.post(
  '/admin/pontos/:id/foto-movel',
  apagarTemporario,
  upload.single('arquivo'),
  rota(async (req, res, id) => {
    if (!req.file) return res.status(400).json({ erro: 'envie uma imagem (JPG, PNG ou WebP)' });
    const { rows } = await require('../db/pool').query('SELECT tipo FROM pontos WHERE id = $1', [id]);
    if (!rows[0]) return res.status(404).json({ erro: 'ponto não encontrado' });
    if (rows[0].tipo !== 'movel') return res.status(409).json({ erro: 'foto de equipamento é só do ponto móvel' });
    const supabase = require('../lib/supabase');
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    const nomeArquivo = `pontos/movel-${id}.jpg`;
    const { error } = await supabase.storage
      .from(bucket)
      .upload(nomeArquivo, fs.readFileSync(req.file.path), { contentType: req.file.mimetype, upsert: true });
    if (error) return res.status(502).json({ erro: 'falha ao salvar a foto' });
    const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
    const url = `${data.publicUrl}?v=${Date.now()}`;
    await require('../db/pool').query('UPDATE pontos SET foto_instalacao_url = $2 WHERE id = $1', [id, url]);
    await avisar(id);
    res.json({ url });
  }),
);

router.get(
  '/admin/pontos/:id/movel',
  rota(async (_req, res, id) => {
    const ficha = await movel.fichaDoMovel(id);
    if (!ficha) return res.status(404).json({ erro: 'ponto não encontrado' });
    res.json(ficha);
  }),
);

// A conversão fixo ⇄ móvel saiu (V2, 02/10/2026): o tipo é do nascimento
// (gatilho na migration 113). Resposta explícita para cliente antigo.
for (const caminho of ['/admin/pontos/:id/tornar-movel', '/admin/pontos/:id/tornar-fixo']) {
  router.post(caminho, (_req, res) =>
    res.status(410).json({ erro: 'o tipo do ponto não muda depois de criado — o móvel nasce em Rede → Pontos móveis' }),
  );
}

router.put(
  '/admin/pontos/:id/base',
  rota(async (req, res, id) => {
    const r = await movel.alterarBase(id, req.body, adminDe(req));
    await avisar(id, [r.contaBaseAnterior]);
    res.json({ ok: true, baseNova: r.baseNova, enderecoMudou: r.enderecoMudou });
  }),
);

router.post(
  '/admin/pontos/:id/eventos',
  rota(async (req, res, id) => {
    const eventoId = await movel.criarEvento(id, req.body, adminDe(req));
    await avisar(id);
    res.status(201).json({ id: eventoId });
  }),
);

const ACOES_DO_EVENTO = {
  iniciar: movel.iniciarEvento,
  encerrar: movel.encerrarEvento,
  cancelar: movel.cancelarEvento,
};
router.post(
  '/admin/pontos/:id/eventos/:eventoId/:acao',
  rota(async (req, res, id) => {
    if (!Object.hasOwn(ACOES_DO_EVENTO, req.params.acao)) return res.status(404).json({ erro: 'ação desconhecida' });
    await ACOES_DO_EVENTO[req.params.acao](id, req.params.eventoId);
    await avisar(id);
    res.json({ ok: true });
  }),
);

// ---------------------------------------------------------------------------
// Hospedagem
// ---------------------------------------------------------------------------
router.post(
  '/admin/pontos/:id/hospedagens',
  rota(async (req, res, id) => {
    const r = await hospedagem.criar(id, req.body, adminDe(req));
    if (req.body?.interesse_id) {
      await require('../pendencias/repository')
        .resolver(`HOSPEDAGEM_INTERESSE:${Number(req.body.interesse_id)}`, { resolucao: 'agendada', por: adminDe(req) })
        .catch(() => {});
    }
    await avisar(id, [r.contaId]);
    res.status(201).json(r);
  }),
);

const ACOES_DA_HOSPEDAGEM = {
  iniciar: (id, hid) => hospedagem.iniciar(id, hid),
  encerrar: (id, hid, admin) => hospedagem.encerrar(id, hid, admin),
  cancelar: (id, hid) => hospedagem.cancelar(id, hid),
};
router.post(
  '/admin/pontos/:id/hospedagens/:hid/:acao',
  rota(async (req, res, id) => {
    if (!Object.hasOwn(ACOES_DA_HOSPEDAGEM, req.params.acao)) {
      return res.status(404).json({ erro: 'ação desconhecida' });
    }
    const r = await ACOES_DA_HOSPEDAGEM[req.params.acao](id, req.params.hid, adminDe(req));
    await avisar(id, [r?.contaId]);
    res.json({ ok: true, ...(r?.tempoSegundos !== undefined ? r : {}) });
  }),
);

router.put(
  '/admin/pontos/:id/hospedagens/:hid/periodo',
  rota(async (req, res, id) => {
    const r = await hospedagem.alterarPeriodo(id, req.params.hid, req.body);
    await avisar(id, [r.contaId]);
    res.json({ ok: true, dataInicio: r.dataInicio, dataFim: r.dataFim });
  }),
);

router.get(
  '/admin/hospedagem/percentual',
  simples(async (_req, res) => {
    const [percentual, historico] = await Promise.all([
      hospedagem.percentualAtual(),
      hospedagem.historicoDoPercentual(),
    ]);
    res.json({ percentual, historico });
  }),
);

router.put(
  '/admin/hospedagem/percentual',
  simples(async (req, res) => {
    const r = await hospedagem.alterarPercentual(req.body?.percentual, adminDe(req));
    sse.emitirParaAdmin('hosting.percent', { percentual: r.novo });
    res.json({ percentual: r.novo, anterior: r.anterior, mudou: r.mudou });
  }),
);

router.get(
  '/admin/hospedagem/interesses',
  simples(async (_req, res) => res.json(await interesses.listar())),
);

router.patch(
  '/admin/hospedagem/interesses/:id',
  simples(async (req, res) => {
    const r = await interesses.atualizar(req.params.id, req.body, adminDe(req));
    sse.emitirParaAdmin('hosting.interest', { id: r.id });
    res.json(r);
  }),
);

router.get(
  '/admin/anunciantes/:id/saldo-hospedagem',
  rota(async (_req, res, id) => {
    const [saldo, extrato, hospedagens] = await Promise.all([
      hospedagem.saldoDaConta(id),
      hospedagem.extratoDaConta(id),
      hospedagem.hospedagensDaConta(id),
    ]);
    res.json({ saldo, extrato, hospedagens });
  }),
);

router.post(
  '/admin/anunciantes/:id/saldo-hospedagem/ajustes',
  rota(async (req, res, id) => {
    const r = await hospedagem.ajustar(id, req.body, adminDe(req));
    sse.emitirParaConta(id, 'hosting.updated', {});
    res.status(201).json({ ok: true, segundos: r.segundos, saldo: await hospedagem.saldoDaConta(id) });
  }),
);

// ---------------------------------------------------------------------------
// Público e painel
// ---------------------------------------------------------------------------
// O site nunca escreve o percentual no HTML: lê daqui. O exemplo é o mesmo
// do Admin ("Com 20%: 30 h de operação geram 6 h de mídia").
router.get(
  '/hospedagem/condicao',
  simples(async (_req, res) => {
    const percentual = await hospedagem.percentualAtual();
    res.set('Cache-Control', 'no-store');
    res.json({
      percentual,
      exemplo: { horasDeOperacao: 30, segundosDeMidia: hospedagem.beneficioDe(30 * 3600, percentual) },
    });
  }),
);

// Visitante ou logado (a conta vem da SESSÃO, nunca do corpo). Campo
// escondido `site` preenchido = robô: responde igual e não grava.
router.post(
  '/hospedagem/interesse',
  limiteTentativas,
  simples(async (req, res) => {
    if (typeof req.body?.site === 'string' && req.body.site.trim()) return res.status(201).json({ ok: true });
    await interesses.registrar(req.body, { contaId: req.session?.anuncianteId || null, origem: 'publico' });
    res.status(201).json({ ok: true });
  }),
);

function exigirConta(req, res, next) {
  if (!req.session?.anuncianteId) return res.status(401).json({ erro: 'não autenticado' });
  next();
}

router.get(
  '/anunciantes/me/hospedagem',
  exigirConta,
  simples(async (req, res) => {
    const contaId = req.session.anuncianteId;
    // Sem extrato: o painel não o mostra, e a nota do ajuste é do Admin.
    const [saldo, hospedagens, interesseAberto, percentual] = await Promise.all([
      hospedagem.saldoDaConta(contaId),
      hospedagem.hospedagensDaConta(contaId),
      interesses.abertoDaConta(contaId),
      hospedagem.percentualAtual(),
    ]);
    res.json({
      saldo: { disponivelSegundos: saldo.disponivelSegundos, recebidoSegundos: saldo.recebidoSegundos },
      hospedagens,
      interesseAberto,
      percentual,
    });
  }),
);

router.post(
  '/anunciantes/me/hospedagem/interesse',
  exigirConta,
  limiteTentativas,
  simples(async (req, res) => {
    // O painel não pede de novo o que a conta já tem: empresa, responsável,
    // contato, endereço e ramo vêm do cadastro; do corpo, só disponibilidade
    // e observação. Quem escolhe equipamento, período e percentual é o Admin.
    const { rows } = await require('../db/pool').query('SELECT * FROM anunciantes WHERE id = $1', [
      req.session.anuncianteId,
    ]);
    const conta = rows[0];
    if (!conta || conta.excluido_em) return res.status(404).json({ erro: 'conta não encontrada' });
    // Parte vazia no cadastro vai como ausente (não null): o endereço no
    // formato antigo (só a linha) continua reconhecido.
    const ou = (v) => v ?? undefined;
    const corpo = {
      empresa: conta.nome_empresa,
      responsavel: conta.responsavel_nome || conta.nome_empresa,
      contato_email: ou(conta.contato_email),
      contato_telefone: conta.contato_telefone || conta.responsavel_telefone || '',
      cep: ou(conta.cep),
      logradouro: ou(conta.logradouro),
      numero: ou(conta.numero),
      complemento: ou(conta.complemento),
      bairro: ou(conta.bairro),
      cidade: ou(conta.cidade),
      uf: ou(conta.uf),
      endereco: conta.logradouro ? undefined : ou(conta.endereco),
      categoria_id: conta.categoria_id,
      segmento: ou(conta.categoria_livre),
      disponibilidade: req.body?.disponibilidade,
      observacao: req.body?.observacao,
    };
    const r = await interesses.registrar(corpo, { contaId: conta.id, origem: 'painel' });
    res.status(201).json({ ok: true, jaRecebido: !r.novo });
  }),
);

module.exports = router;
