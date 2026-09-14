const express = require('express');
const multer = require('multer');
const os = require('os');
const fs = require('fs');
const router = express.Router();
const planosRepo = require('./planos-repository');
const beneficiosRepo = require('./beneficios-repository');
const cobrancasRepo = require('./cobrancas-repository');
const assinaturasRepo = require('./assinaturas-repository');
const sanCheckout = require('./san-checkout');
const drive = require('./drive');
const pool = require('../db/pool');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const anunciantesRepo = require('../anunciantes/repository');

const uploadNota = multer({ dest: os.tmpdir() });

// Planos — pública (módulo 7) + admin
// Plano fundador só aparece pro público enquanto o programa está aberto
// (PROGRAMA_FUNDADOR_ATIVO=true) e ainda tem vaga — fora disso some da
// vitrine sem o admin precisar desativar o plano.
router.get('/planos', async (req, res) => {
  const programaAberto = process.env.PROGRAMA_FUNDADOR_ATIVO === 'true';
  const planos = await planosRepo.listarAtivos({ incluirFundador: programaAberto });
  res.json(planos.filter((p) => !p.fundador || p.vagas_restantes == null || p.vagas_restantes > 0));
});

router.get('/admin/planos', async (req, res) => {
  res.json(await planosRepo.listarTodos());
});

// Fora de 1..3 os dois leitores do limite discordam: o upload
// (src/anunciantes/routes.js) libera 0 ou 4 ao pé da letra, enquanto a
// playlist trava em 1..3. Barra na entrada, que é onde os dois se resolvem.
function limiteCriativosInvalido(valor) {
  if (valor === undefined) return false;
  const n = Number(valor);
  return !Number.isInteger(n) || n < 1 || n > 3;
}

// Cria um plano novo — usado pra lançar preço/promoção sem mexer no que
// quem já assinou um plano existente está pagando (ver migration 014).
router.post('/admin/planos', async (req, res) => {
  const { id, tier, nome, valor_mensal, compromisso_meses, frequencia_dia, cobertura } = req.body;
  if (!id || !tier || !nome || !valor_mensal || !compromisso_meses || !frequencia_dia || !cobertura) {
    return res.status(400).json({ erro: 'campos obrigatórios faltando' });
  }
  if (limiteCriativosInvalido(req.body.limite_criativos)) {
    return res.status(400).json({ erro: 'limite de criativos precisa ser 1, 2 ou 3' });
  }
  const ativo = req.body.ativo === undefined ? true : req.body.ativo;
  if (ativo && await planosRepo.vagaOcupada(Number(compromisso_meses), null, !!req.body.fundador)) {
    return res.status(409).json({
      erro: `já tem ${planosRepo.MAX_ATIVOS_POR_CICLO} planos ativos nessa modalidade — desative um antes (quem já assina continua pagando igual)`,
    });
  }
  try {
    const plano = await planosRepo.criar({ ...req.body, ativo });
    if (Array.isArray(req.body.beneficio_ids)) {
      await planosRepo.definirBeneficios(plano.id, req.body.beneficio_ids.map(Number));
    }
    res.status(201).json(await planosRepo.buscarPorId(plano.id));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'já existe um plano com esse id' });
    throw err;
  }
});

router.patch('/admin/planos/:id', async (req, res) => {
  const atual = await planosRepo.buscarPorId(req.params.id);
  if (!atual) return res.status(404).json({ erro: 'plano não encontrado' });

  if (limiteCriativosInvalido(req.body.limite_criativos)) {
    return res.status(400).json({ erro: 'limite de criativos precisa ser 1, 2 ou 3' });
  }

  // Campo NOT NULL apagado na tela chegaria como null e viraria 500 no
  // constraint do banco — devolve o motivo em vez do erro genérico.
  const vazio = ['nome', 'valor_mensal', 'frequencia_dia', 'compromisso_meses', 'limite_criativos']
    .find((c) => c in req.body && (req.body[c] === null || req.body[c] === ''));
  if (vazio) return res.status(400).json({ erro: `${vazio} não pode ficar em branco` });

  // Reativar/mover de ciclo só passa se ainda houver vaga na vitrine daquela
  // modalidade. Desativar nunca é barrado.
  if (req.body.ativo === true || (atual.ativo && req.body.compromisso_meses)) {
    const ciclo = Number(req.body.compromisso_meses || atual.compromisso_meses);
    const ehFundador = 'fundador' in req.body ? !!req.body.fundador : !!atual.fundador;
    if (await planosRepo.vagaOcupada(ciclo, req.params.id, ehFundador)) {
      return res.status(409).json({
        erro: `já tem ${planosRepo.MAX_ATIVOS_POR_CICLO} planos ativos nessa modalidade — desative um antes`,
      });
    }
  }

  if (Array.isArray(req.body.beneficio_ids)) {
    await planosRepo.definirBeneficios(req.params.id, req.body.beneficio_ids.map(Number));
  }
  res.json(await planosRepo.atualizar(req.params.id, req.body));
});

// Catálogo de benefícios — criado/editado uma vez, marcado por plano.
router.get('/admin/beneficios', async (req, res) => {
  res.json(await beneficiosRepo.listar());
});

router.post('/admin/beneficios', async (req, res) => {
  if (!req.body.texto) return res.status(400).json({ erro: 'texto obrigatório' });
  try {
    res.status(201).json(await beneficiosRepo.criar(req.body));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ erro: 'esse benefício já existe' });
    throw err;
  }
});

router.patch('/admin/beneficios/:id', async (req, res) => {
  const beneficio = await beneficiosRepo.atualizar(req.params.id, req.body);
  if (!beneficio) return res.status(404).json({ erro: 'benefício não encontrado' });
  res.json(beneficio);
});

router.delete('/admin/beneficios/:id', async (req, res) => {
  const ok = await beneficiosRepo.excluir(req.params.id);
  if (!ok) return res.status(404).json({ erro: 'benefício não encontrado' });
  res.json({ ok: true });
});

// Assinatura de plano — cria uma linha em `assinaturas` (o id dela é o que
// vai no link, ver src/financeiro/assinaturas-repository.js e
// san-checkout.js sobre por que não é mais um id de catálogo genérico) e
// devolve o link de checkout. Se já existir uma assinatura ativa, reusa —
// não deixa acumular assinatura duplicada por clique duplo.
router.post('/anunciantes/:id/assinar', exigirAnuncianteLogado, async (req, res) => {
  if (Number(req.params.id) !== req.session.anuncianteId) {
    return res.status(403).json({ erro: 'só pode assinar plano na própria conta' });
  }
  const plano = await planosRepo.buscarPorId(req.body.planoId);
  if (!plano || !plano.ativo) return res.status(400).json({ erro: 'plano inválido' });
  if (plano.fundador && process.env.PROGRAMA_FUNDADOR_ATIVO !== 'true') {
    return res.status(400).json({ erro: 'o programa de fundador não está aberto' });
  }
  // Vagas do plano (fundador) — mesma conta que a vitrine usa (planos-repository).
  if (plano.vagas != null) {
    const ocupadas = await planosRepo.contarVagasOcupadas(plano.id, req.session.anuncianteId);
    if (ocupadas >= plano.vagas) return res.status(400).json({ erro: 'as vagas desse plano acabaram' });
  }

  // Dono de ponto ou vendedor que resolve anunciar: a conta é a mesma, mas o
  // checkout e a nota fiscal precisam do endereço comercial — que o convite
  // não pediu. Sem ele, manda completar o perfil antes.
  const conta = await anunciantesRepo.buscarPorId(req.session.anuncianteId);
  if (!conta || conta.excluido_em) return res.status(403).json({ erro: 'conta indisponível' });
  if (conta.status === 'suspenso') return res.status(403).json({ erro: 'conta suspensa — fale com o suporte antes de assinar' });
  if (!conta.endereco || !conta.cidade || !conta.uf || !conta.cep) {
    return res.status(400).json({ erro: 'complete o endereço da empresa no seu perfil antes de assinar' });
  }
  if (!(conta.papeis || []).includes('anunciante')) {
    await pool.query(`UPDATE anunciantes SET papeis = array_append(papeis, 'anunciante') WHERE id = $1`, [conta.id]);
  }

  let assinatura = await assinaturasRepo.buscarAtivaDoAnunciante(req.session.anuncianteId);
  if (assinatura && assinatura.plano_id !== plano.id) {
    // Assinatura de outro plano: se já foi paga, a Asaas está cobrando ela —
    // criar outra viraria cobrança dupla. Troca de plano pago é pelo admin
    // (cancela no Checkout e assina de novo). Se nunca foi paga, é só um
    // clique antigo: cancela localmente e segue.
    const pagou = conta.status === 'ativo' && conta.plano_id === assinatura.plano_id;
    if (pagou) return res.status(409).json({ erro: 'você já tem um plano ativo — pra trocar, fale com a gente pelo WhatsApp' });
    await assinaturasRepo.marcarCancelada(assinatura.id);
    assinatura = null;
  }
  if (!assinatura) {
    assinatura = await assinaturasRepo.criar({ anuncianteId: req.session.anuncianteId, planoId: plano.id });
  }

  res.json({ checkoutUrl: sanCheckout.linkCheckoutAssinatura(assinatura.id) });
});

// Exposto pro San Checkout consultar a assinatura (INTEGRACAO.md 6.1 chama
// isso de "plano", mas o :id aqui identifica uma assinatura específica —
// ver comentário em san-checkout.js#montarRespostaPlano)
router.get('/plano/:assinaturaId', sanCheckout.exigirChaveCheckout, async (req, res) => {
  const resposta = await sanCheckout.montarRespostaPlano(req.params.assinaturaId);
  if (!resposta) return res.status(404).json({ erro: 'assinatura não encontrada' });
  res.json(resposta);
});

// Confirmação/eventos de assinatura (API.md do Checkout, 4.3) — responde 200
// rápido, processa depois, exatamente como o contrato permite. A autorização
// é a assinatura HMAC dos headers, conferida em `webhookAutorizado`.
router.post('/webhook/san-checkout', (req, res) => {
  if (!sanCheckout.webhookAutorizado(req)) {
    return res.status(401).json({ erro: 'não autorizado' });
  }
  res.json({ ok: true });
  sanCheckout.processarWebhookAssinatura(req.body).catch((err) => {
    console.error('erro processando webhook san-checkout', err);
  });
});

// Admin aciona cancelamento (Vitrina → San Checkout, nunca o pagador direto)
// Liberar plano de graça. Uma ação só, em vez de o dono editar `plano_id` e
// `data_expiracao` à mão em dois campos e esquecer de anotar que era cortesia.
//
// Não cria assinatura nem cobrança: o San Checkout não fica sabendo, e por isso
// nada é cobrado nem agora nem na renovação. A cobertura simplesmente vence na
// data, e o dono decide se estende.
router.post('/admin/anunciantes/:id/liberar-plano', async (req, res) => {
  const { plano_id, meses, motivo } = req.body;
  if (!plano_id) return res.status(400).json({ erro: 'escolha o plano' });

  const plano = await planosRepo.buscarPorId(plano_id);
  if (!plano) return res.status(404).json({ erro: 'plano não encontrado' });

  const anunciante = await anunciantesRepo.buscarPorId(req.params.id);
  if (!anunciante) return res.status(404).json({ erro: 'conta não encontrada' });

  // Liberar de graça por cima de quem PAGA apagaria a cobertura comprada e
  // pareceria um upgrade. Quem já paga, cancela primeiro.
  if (anunciante.plano_id && !anunciante.plano_cortesia
      && anunciante.data_expiracao && new Date(anunciante.data_expiracao) > new Date()) {
    return res.status(409).json({ erro: 'essa conta tem plano pago ativo — cancele a assinatura antes de liberar cortesia' });
  }

  const duracao = Number(meses) > 0 ? Number(meses) : plano.compromisso_meses;
  const atualizado = await anunciantesRepo.atualizar(anunciante.id, {
    plano_id,
    status: 'ativo',
    data_inicio_cobertura: anunciante.data_inicio_cobertura || new Date(),
    data_expiracao: new Date(Date.now() + duracao * 30 * 24 * 60 * 60 * 1000),
    plano_cortesia: true,
    cortesia_motivo: motivo || null,
    // Cortesia não trava preço: quando ela acabar e a pessoa assinar, ela
    // assina pelo valor da vitrine, não por um valor "herdado" de um plano
    // que nunca foi pago.
    valor_mensal_travado: null,
  });
  res.json(atualizado);
});

router.post('/admin/anunciantes/:id/cancelar-assinatura', async (req, res) => {
  const anunciante = await anunciantesRepo.buscarPorId(req.params.id);
  if (!anunciante) return res.status(404).json({ erro: 'anunciante não encontrado' });

  const assinatura = await assinaturasRepo.buscarAtivaDoAnunciante(req.params.id);
  if (!assinatura) return res.status(400).json({ erro: 'anunciante sem assinatura ativa' });

  try {
    await sanCheckout.cancelarAssinatura(assinatura.id, anunciante.cpf_cnpj);
    await assinaturasRepo.marcarCancelada(assinatura.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ erro: 'falha ao cancelar no San Checkout' });
  }
});

// Fila de reconciliação manual (webhooks que não deram pra correlacionar
// automaticamente ou eventos sem ação automática — ver san-checkout.js)
router.get('/admin/eventos-pendentes', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM eventos_assinatura_pendentes WHERE resolvido = false ORDER BY criado_em DESC`
  );
  res.json(rows);
});

router.patch('/admin/eventos-pendentes/:id', async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE eventos_assinatura_pendentes SET resolvido = true WHERE id = $1 RETURNING *`,
    [req.params.id]
  );
  res.json(rows[0] || null);
});

router.get('/admin/cobrancas', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, a.nome_empresa FROM cobrancas_confirmadas c
     JOIN anunciantes a ON a.id = c.anunciante_id ORDER BY c.criado_em DESC`
  );
  res.json(rows);
});

// Admin sobe o PDF de nota fiscal (emissão em si é manual — ver SPEC.md
// módulo 6) — o upload pro Drive é automático a partir daqui.
router.patch('/admin/cobrancas/:id/nota-fiscal', uploadNota.single('arquivo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: 'arquivo obrigatório' });
  try {
    const cobranca = await cobrancasRepo.buscarPorId(req.params.id);
    if (!cobranca) return res.status(404).json({ erro: 'cobrança não encontrada' });

    const { driveFileId, url } = await drive.subirNotaFiscal(req.file.path, `nota-fiscal-${req.params.id}.pdf`);
    const atualizada = await cobrancasRepo.marcarNotaFiscal(req.params.id, { nota_fiscal_url: url, drive_file_id: driveFileId });
    res.json(atualizada);
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// ---------------------------------------------------------------------------
// Vendedor — desde a v2 é um PAPEL da conta única (migration 019), não um
// login à parte. Entra só por convite (src/convites). As rotas antigas de
// /afiliados/* ficam respondendo 410 por um tempo pra quem tiver link salvo.
// ---------------------------------------------------------------------------
const vendedoresRepo = require('./vendedores-repository');

function exigirVendedorLogado(req, res, next) {
  if (!req.session.anuncianteId) return res.status(401).json({ erro: 'não autenticado' });
  vendedoresRepo.buscarPorConta(req.session.anuncianteId).then((v) => {
    if (!v) return res.status(403).json({ erro: 'esta conta não é de vendedor' });
    req.vendedor = v;
    next();
  }).catch(next);
}

['/afiliados/cadastro', '/afiliados/login', '/afiliados/logout'].forEach((rota) => {
  router.post(rota, (req, res) => res.status(410).json({ erro: 'vendedor agora usa a conta única — entre em /anunciante/login.html' }));
});

router.get('/vendedor/painel', exigirVendedorLogado, async (req, res) => {
  const { rows: comissoes } = await pool.query(
    `SELECT c.*, a.nome_empresa FROM comissoes c
     JOIN anunciantes a ON a.id = c.anunciante_id
     WHERE c.vendedor_conta_id = $1 ORDER BY c.criado_em DESC`,
    [req.vendedor.conta_id]
  );
  const totalComissionado = comissoes.reduce((soma, c) => soma + Number(c.comissao_valor), 0);
  const totalPago = comissoes.filter((c) => c.pago_em).reduce((soma, c) => soma + Number(c.comissao_valor), 0);
  res.json({ vendedor: req.vendedor, comissoes, totalComissionado, totalPago, totalAReceber: totalComissionado - totalPago });
});

// Admin — quanto se deve a cada vendedor, e marcar como pago.
router.get('/admin/comissoes', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.*, va.nome_empresa AS vendedor_nome, v.chave_pix, an.nome_empresa
     FROM comissoes c
     LEFT JOIN vendedores v ON v.conta_id = c.vendedor_conta_id
     LEFT JOIN anunciantes va ON va.id = c.vendedor_conta_id
     JOIN anunciantes an ON an.id = c.anunciante_id
     ORDER BY c.pago_em NULLS FIRST, c.criado_em DESC`
  );
  res.json(rows);
});

router.patch('/admin/comissoes/:id', async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE comissoes SET pago_em = $2 WHERE id = $1 RETURNING *',
    [req.params.id, req.body.pago ? new Date() : null]
  );
  if (!rows[0]) return res.status(404).json({ erro: 'comissão não encontrada' });
  res.json(rows[0]);
});

router.get('/admin/vendedores', async (req, res) => res.json(await vendedoresRepo.listar()));

router.patch('/admin/vendedores/:contaId', async (req, res) => {
  try {
    const v = await vendedoresRepo.atualizar(req.params.contaId, req.body);
    if (!v) return res.status(404).json({ erro: 'vendedor não encontrado' });
    res.json(v);
  } catch (err) {
    if (err.code === '23514') return res.status(400).json({ erro: 'status inválido' });
    throw err;
  }
});

module.exports = { router, exigirVendedorLogado };