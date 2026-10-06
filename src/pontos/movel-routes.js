const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const multer = require('multer');
const movel = require('./movel');
const hospedagem = require('./hospedagem');
const interesses = require('./hospedagem-interesse');
const equipamento = require('./hospedagem-equipamento');
const sse = require('../lib/sse');
const { limiteTentativas } = require('../lib/limite-tentativas');

// Rede móvel (Mostraí Móvel de uma cidade), as telas dela e a hospedagem
// temporária de uma tela (migrations 112 a 115). `:id` nas rotas é a REDE
// (o `pontos` tipo 'movel'); as telas são escolhidas no corpo.
//
// Admin — tudo em /admin, então a guarda de sessão do admin (src/server.js)
// vale para todas: o anfitrião, o anunciante e o organizador do evento não
// mexem em nada daqui.
//   GET  /admin/pontos-moveis/agenda[?historico=1]           agenda de todas as redes (agora + futuro | histórico)
//   POST /admin/pontos-moveis                                criar rede (nome + cidade + UF; sem tela)
//   PATCH /admin/pontos/:id/movel                            editar a rede (nome, cidade, UF, nota)
//   (a foto/capa da rede é a foto do ponto: POST /admin/pontos/:id/foto, src/pontos/routes.js)
//   GET  /admin/pontos/:id/movel                             ficha (telas, operação agora, agenda, histórico)
//   GET  /admin/pontos/:id/telas-livres?inicio=&fim=         cada tela da rede, livre ou não no período
//   PUT  /admin/pontos/:id/base                              410 — a rede não tem base (114)
//   POST /admin/pontos/:id/eventos                           cadastrar evento (com as telas participantes)
//   POST /admin/pontos/:id/eventos/:eventoId/:acao           iniciar | encerrar | cancelar
//   POST /admin/pontos/:id/hospedagens                       confirmar hospedagem de UMA tela (percentual congelado)
//   POST /admin/pontos/:id/hospedagens/:hid/:acao            iniciar (exige termo físico + entrega) | encerrar
//                                                            (retirada opcional) | cancelar | retirada
//   PUT  /admin/pontos/:id/hospedagens/:hid/termo-fisico     termo físico Pendente/Assinado (data e observação)
//   POST /admin/pontos/:id/hospedagens/:hid/movimentacoes/:tipo/foto  foto da entrega/retirada
//   PUT  /admin/pontos/:id/hospedagens/:hid/periodo          alterar tela/período/horário/local (programada)
//                                                            ou prorrogar o fim (ativa)
//   GET  /admin/hospedagem/percentual                        percentual + histórico
//   PUT  /admin/hospedagem/percentual                        alterar (auditado)
//   GET  /admin/hospedagem/interesses                        interesses recebidos
//   PATCH /admin/hospedagem/interesses/:id                   andamento (em contato, aprovado, recusado) e nota
//   GET  /admin/anunciantes/:id/saldo-hospedagem             saldo, extrato e hospedagens da conta
//   POST /admin/anunciantes/:id/saldo-hospedagem/ajustes     ajuste +/− com motivo
//
// Público e painel:
//   GET  /hospedagem/condicao                                o percentual em vigor (o site lê daqui)
//   POST /hospedagem/interesse                               interesse (só conta com direito ativo)
//   GET  /anunciantes/me/hospedagem                          hospedagens, saldo, elegibilidade, dados da conta
//   POST /anunciantes/me/hospedagem/interesse                o mesmo interesse, pelo painel
//
// O termo eletrônico saiu (115): `/admin/hospedagem/termos` e
// `/anunciantes/me/hospedagens/:hid/termo|aceite` respondem 410.
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

// Cada escrita avisa sem F5: o Admin (Rede), o anfitrião (painel) e quem
// escolheu a rede (lista de pontos).
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
    if (!id) return res.status(404).json({ erro: 'rede não encontrada' });
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
// Rede móvel
// ---------------------------------------------------------------------------
// A AGENDA MÓVEL (Rede → Pontos, filtro Móveis → "Agenda móvel"): agora +
// futuro por padrão; `?historico=1` traz os encerrados e cancelados. As
// redes em si vêm de GET /admin/pontos (`movel`), no mesmo grid dos fixos.
router.get(
  '/admin/pontos-moveis/agenda',
  simples(async (req, res) => {
    res.json(await movel.agendaDasRedes({ historico: req.query.historico === '1' }));
  }),
);

router.post(
  '/admin/pontos-moveis',
  simples(async (req, res) => {
    const r = await movel.criarRedeMovel(req.body, adminDe(req));
    sse.emitirParaAdmin('point.updated', { id: r.id });
    res.status(201).json(r);
  }),
);

router.patch(
  '/admin/pontos/:id/movel',
  rota(async (req, res, id) => {
    const r = await movel.editarRede(id, req.body);
    await avisar(id);
    res.json(r);
  }),
);

router.get(
  '/admin/pontos/:id/telas-livres',
  rota(async (req, res, id) => {
    res.json({ telas: await movel.disponibilidadeDasTelas(id, req.query) });
  }),
);

// Foto da entrega ou da retirada (opcional, recomendada): mesmo bucket das
// fotos de ponto; só JPEG, PNG ou WebP (`upload`, acima).
router.post(
  '/admin/pontos/:id/hospedagens/:hid/movimentacoes/:tipo/foto',
  apagarTemporario,
  upload.single('arquivo'),
  rota(async (req, res, id) => {
    const tipo = req.params.tipo === 'entrega' || req.params.tipo === 'retirada' ? req.params.tipo : null;
    const hid = /^\d{1,15}$/.test(String(req.params.hid)) ? req.params.hid : null;
    if (!tipo || !hid) return res.status(404).json({ erro: 'registro não encontrado' });
    if (!req.file) return res.status(400).json({ erro: 'envie uma imagem (JPG, PNG ou WebP)' });
    // O registro existe antes de subir (sem órfão no bucket).
    if (!(await equipamento.movimentacaoDoPonto(id, hid, tipo))) {
      return res.status(404).json({ erro: `${tipo === 'entrega' ? 'Entrega' : 'Retirada'} ainda não registrada` });
    }
    const supabase = require('../lib/supabase');
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    // Nome aleatório por envio: o bucket é público (o endereço não se
    // adivinha pelo id) e uma foto nova nunca sobrescreve a anterior.
    const nomeArquivo = `pontos/movel-${id}-${tipo}-${require('node:crypto').randomUUID()}.jpg`;
    const { error } = await supabase.storage
      .from(bucket)
      .upload(nomeArquivo, fs.readFileSync(req.file.path), { contentType: req.file.mimetype, upsert: false });
    if (error) return res.status(502).json({ erro: 'falha ao salvar a foto' });
    const { data } = supabase.storage.from(bucket).getPublicUrl(nomeArquivo);
    const url = data.publicUrl;
    await equipamento.definirFotoDaMovimentacao(id, hid, tipo, url);
    await avisar(id);
    res.json({ url });
  }),
);

// O termo eletrônico (versões, publicação, aceite pelo painel) saiu na 115:
// o termo é FÍSICO, e o Admin só marca Pendente/Assinado na hospedagem.
const TERMO_ELETRONICO_SAIU = {
  erro: 'o termo de hospedagem é assinado em papel — o Admin marca "termo físico assinado" na hospedagem',
};
router.all('/admin/hospedagem/termos', (_req, res) => res.status(410).json(TERMO_ELETRONICO_SAIU));

router.get(
  '/admin/pontos/:id/movel',
  rota(async (_req, res, id) => {
    const ficha = await movel.fichaDaRede(id);
    if (!ficha) return res.status(404).json({ erro: 'rede não encontrada' });
    res.json(ficha);
  }),
);

// A conversão fixo ⇄ móvel saiu (V2, 02/10/2026): o tipo é do nascimento
// (gatilho na migration 113). Resposta explícita para cliente antigo.
for (const caminho of ['/admin/pontos/:id/tornar-movel', '/admin/pontos/:id/tornar-fixo']) {
  router.post(caminho, (_req, res) =>
    res
      .status(410)
      .json({ erro: 'o tipo do ponto não muda depois de criado — a rede móvel nasce em Rede › Pontos, filtro Móveis' }),
  );
}

// A rede móvel não tem base (migration 114): cada tela só tem local
// enquanto está alocada. Resposta explícita para cliente antigo.
router.put('/admin/pontos/:id/base', (_req, res) =>
  res
    .status(410)
    .json({ erro: 'a rede móvel não tem base — cada tela só tem local enquanto está alocada (hospedagem ou evento)' }),
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
  iniciar: (id, hid, admin, corpo) => hospedagem.iniciar(id, hid, corpo, admin),
  encerrar: (id, hid, admin, corpo) => hospedagem.encerrar(id, hid, admin, corpo),
  cancelar: (id, hid) => hospedagem.cancelar(id, hid),
  retirada: (id, hid, admin, corpo) => equipamento.registrarRetirada(id, hid, corpo, admin),
};
router.post(
  '/admin/pontos/:id/hospedagens/:hid/:acao',
  rota(async (req, res, id) => {
    if (!Object.hasOwn(ACOES_DA_HOSPEDAGEM, req.params.acao)) {
      return res.status(404).json({ erro: 'ação desconhecida' });
    }
    const r = await ACOES_DA_HOSPEDAGEM[req.params.acao](id, req.params.hid, adminDe(req), req.body || {});
    await avisar(id, [r?.contaId]);
    res.json({ ok: true, ...(r?.tempoSegundos !== undefined ? r : {}) });
  }),
);

router.put(
  '/admin/pontos/:id/hospedagens/:hid/termo-fisico',
  rota(async (req, res, id) => {
    const r = await equipamento.marcarTermoFisico(id, req.params.hid, req.body, adminDe(req));
    await avisar(id, [r.contaId]);
    res.json({ ok: true, termo: r.termo });
  }),
);

router.put(
  '/admin/pontos/:id/hospedagens/:hid/periodo',
  rota(async (req, res, id) => {
    const r = await hospedagem.alterarPeriodo(id, req.params.hid, req.body);
    await avisar(id, [r.contaId]);
    res.json({ ok: true, inicio: r.inicio, fim: r.fim });
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

function exigirConta(req, res, next) {
  if (!req.session?.anuncianteId) return res.status(401).json({ erro: 'Entre na sua conta para enviar o interesse' });
  next();
}

async function contaDaSessao(req) {
  const { rows } = await require('../db/pool').query('SELECT * FROM anunciantes WHERE id = $1', [
    req.session.anuncianteId,
  ]);
  return rows[0] && !rows[0].excluido_em ? rows[0] : null;
}

// Interesse (V1.1): só conta logada COM direito ativo de veiculação — a
// regra é do servidor (src/pontos/hospedagem-interesse.js). Empresa,
// responsável e contato vêm do cadastro; do corpo, só o local escolhido
// (conta | ponto | outro) e a observação. Campo escondido `site`
// preenchido = robô: responde igual e não grava.
async function enviarInteresse(req, res) {
  if (typeof req.body?.site === 'string' && req.body.site.trim()) return res.status(201).json({ ok: true });
  const conta = await contaDaSessao(req);
  if (!conta) return res.status(401).json({ erro: 'Entre na sua conta para enviar o interesse' });
  try {
    const r = await interesses.registrar(conta, req.body);
    res.status(r.novo ? 201 : 200).json({ ok: true, jaRecebido: !r.novo });
  } catch (err) {
    if (err.status === 403) return res.status(403).json({ erro: err.message, motivo: err.motivo });
    throw err;
  }
}

router.post('/hospedagem/interesse', exigirConta, limiteTentativas, simples(enviarInteresse));

router.get(
  '/anunciantes/me/hospedagem',
  exigirConta,
  simples(async (req, res) => {
    const conta = await contaDaSessao(req);
    if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
    const contaId = conta.id;
    const { possuiDireitoAtivoDeVeiculacao } = require('../anunciantes/acesso-painel');
    const { linhaEndereco } = require('../lib/endereco');
    // Sem extrato: o painel não o mostra, e a nota do ajuste é do Admin.
    const [saldo, hospedagens, interesseAberto, percentual, direito, pontos] = await Promise.all([
      hospedagem.saldoDaConta(contaId),
      hospedagem.hospedagensDaConta(contaId),
      interesses.abertoDaConta(contaId),
      hospedagem.percentualAtual(),
      possuiDireitoAtivoDeVeiculacao(conta),
      interesses.pontosDaConta(contaId),
    ]);
    res.json({
      saldo: { disponivelSegundos: saldo.disponivelSegundos, recebidoSegundos: saldo.recebidoSegundos },
      hospedagens,
      interesseAberto,
      percentual,
      // Pode mandar interesse? (a mesma régua do POST). Só o sim/não e a
      // origem — nada do plano em si.
      elegivel: { possui: direito.possui, origem: direito.origem ?? null, motivo: direito.motivo ?? null },
      // "DADOS DA CONTA" do formulário: o que vai junto, sem pedir de novo.
      conta: {
        empresa: conta.nome_empresa,
        responsavel: conta.responsavel_nome || conta.nome_empresa,
        email: conta.contato_email,
        telefone: conta.contato_telefone || conta.responsavel_telefone || null,
        endereco: linhaEndereco(conta, { comCidade: true }) || conta.endereco || null,
      },
      pontos: pontos.map((p) => ({
        id: p.id,
        nome: p.nome,
        endereco: linhaEndereco(p, { comCidade: true }) || p.endereco,
      })),
    });
  }),
);

// O aceite eletrônico pelo painel saiu (115) — o termo é assinado em papel.
router.get('/anunciantes/me/hospedagens/:hid/termo', (_req, res) => res.status(410).json(TERMO_ELETRONICO_SAIU));
router.post('/anunciantes/me/hospedagens/:hid/aceite', (_req, res) => res.status(410).json(TERMO_ELETRONICO_SAIU));

// O mesmo interesse pelo painel (rota de sempre do painel).
router.post('/anunciantes/me/hospedagem/interesse', exigirConta, limiteTentativas, simples(enviarInteresse));

module.exports = router;
