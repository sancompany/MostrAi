const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
const repo = require('./repository');
const notificacoesRepo = require('./notificacoes');
const { custoDoBeneficio, opcoesDisponiveis, NOME_TIER } = require('./regras');
const { nomeDoCiclo, comNomeDeCiclo } = require('../lib/ciclos');
const planoAdministrativo = require('../financeiro/plano-administrativo');
const anunciantesRepo = require('../anunciantes/repository');
const indicacoesRepo = require('../indicacoes/repository');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const sse = require('../lib/sse');

// Um benefício dura 30 dias por mês comprado, contados do dia em que COMEÇA.
const DIAS_POR_MES = 30;

const dataBR = (iso) =>
  iso ? `${String(iso).slice(8, 10)}/${String(iso).slice(5, 7)}/${String(iso).slice(0, 4)}` : '';

// Por que a conta não pode resgatar agora — a MESMA função responde o GET
// (a tela explica antes de o cliente tentar) e o POST (o servidor recusa).
// Benefício aberto bloqueia: resgatar por cima fechava o anterior e jogava
// fora os dias que faltavam (ou, se agendado, os créditos já debitados dele).
async function bloqueioDoResgate(conta, historico) {
  if (conta.suspenso) return 'Sua conta está suspensa — fale com a gente antes de resgatar.';
  const ativo = historico.find((h) => h.status === 'ativo');
  if (ativo)
    return `Você já tem um benefício em vigor até ${dataBR(ativo.valido_ate)}. Resgate outro quando ele terminar.`;
  if (historico.some((h) => h.status === 'agendado')) {
    return 'Você já tem um benefício programado. Resgate outro depois que ele começar e terminar.';
  }
  return null;
}

// Benefício de nível MENOR que o plano pago em dia não se resgata (regra 31
// do pedido, ADR-016): o plano pago já dá mais, e o benefício nunca
// entraria. Devolve a frase de recusa, ou null.
async function bloqueioPorNivel(conta, tier) {
  if (!pagandoEmDia(conta)) return null;
  const {
    rows: [pago],
  } = await pool.query('SELECT tier, nome FROM planos WHERE id = $1', [conta.plano_id]);
  if (!pago || planoAdministrativo.nivelDoTier(tier) >= planoAdministrativo.nivelDoTier(pago.tier)) return null;
  return `Seu plano ${pago.nome} já oferece mais recursos que o benefício ${NOME_TIER[tier] || tier}.`;
}

const pagandoEmDia = (conta) =>
  !!(
    conta.plano_id &&
    !conta.plano_cortesia &&
    conta.data_expiracao &&
    vigencia.coberturaVigente(conta.data_expiracao)
  );

const beneficioPublico = (h) =>
  h && {
    tier: h.tier,
    nomeTier: NOME_TIER[h.tier] || h.tier,
    // Benefício é um CICLO (ADR-018): "Prime · Semestral".
    ciclo: nomeDoCiclo(h.compromisso_meses),
    nome: `${NOME_TIER[h.tier] || h.tier} · ${nomeDoCiclo(h.compromisso_meses)}`,
    planoNome: h.plano_nome,
    validoAte: h.valido_ate,
    comecaEm: h.status === 'agendado' ? vigencia.inicioDepoisDoPago(h.plano_anterior_valido_ate) : null,
  };

// ---------- autoatendimento (conta logada) ----------

// GET /anunciantes/me/creditos — tudo que o módulo "Créditos e benefícios"
// do painel mostra, numa chamada: saldo, as 12 opções tier×período, o
// benefício em vigor/programado, o que a conta tem agora (pro preview), se
// pode resgatar, o link de indicação e a atividade dele, e o histórico.
router.get('/anunciantes/me/creditos', exigirAnuncianteLogado, async (req, res) => {
  const contaId = req.session.anuncianteId;
  const conta = await anunciantesRepo.buscarPorId(contaId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  const [saldoAtual, movimentacoes, historico, planoAtual] = await Promise.all([
    repo.saldo(contaId),
    repo.movimentacoes(contaId, 20),
    planoAdministrativo.historicoDaConta(contaId),
    conta.plano_id ? pool.query('SELECT nome, compromisso_meses FROM planos WHERE id = $1', [conta.plano_id]) : null,
  ]);
  const bloqueio = await bloqueioDoResgate(conta, historico);
  // Opções de nível menor que o plano pago aparecem, mas indisponíveis — com
  // o motivo (mesma régua do POST, bloqueioPorNivel).
  const bloqueiosPorTier = Object.fromEntries(
    await Promise.all(Object.keys(NOME_TIER).map(async (t) => [t, await bloqueioPorNivel(conta, t)])),
  );
  let indicacao = null;
  if (!conta.conta_propria) {
    const cupom = await indicacoesRepo.garantirCupom(contaId, conta.nome_empresa);
    indicacao = { codigo: cupom.codigo, ...(await indicacoesRepo.resumoIndicacoes(cupom.codigo)) };
  }
  res.json({
    saldo: saldoAtual,
    opcoes: opcoesDisponiveis(saldoAtual).map((o) =>
      bloqueiosPorTier[o.tier] ? { ...o, disponivel: false, bloqueio: bloqueiosPorTier[o.tier] } : o,
    ),
    movimentacoes: movimentacoes.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      quantidade: m.quantidade,
      origem_nome: m.origem_nome,
      ponto_nome: m.ponto_nome,
      competencia: m.competencia,
      // Resgate antigo gravado como "Prime · 6 meses" aparece como
      // "Prime · Semestral" — o registro no ledger não muda.
      observacao: m.tipo === 'resgate_beneficio' ? comNomeDeCiclo(m.observacao) : m.observacao,
      criado_em: m.criado_em,
    })),
    beneficioAtivo: beneficioPublico(historico.find((h) => h.status === 'ativo')),
    beneficioAgendado: beneficioPublico(historico.find((h) => h.status === 'agendado')),
    situacaoAtual: {
      // Plano · Ciclo ("Pro · Trimestral"), ADR-018.
      planoNome: planoAtual?.rows[0]
        ? `${planoAtual.rows[0].nome} · ${nomeDoCiclo(planoAtual.rows[0].compromisso_meses)}`
        : null,
      cortesia: !!conta.plano_cortesia,
      validoAte: conta.data_expiracao,
      pagandoEmDia: pagandoEmDia(conta),
    },
    diasPorMes: DIAS_POR_MES,
    resgate: { permitido: !bloqueio, motivo: bloqueio },
    indicacao,
  });
});

// POST /anunciantes/me/creditos/resgatar {tier, meses} — a conta troca
// créditos por um benefício temporário. O preview ("agora → ativado →
// depois") é montado no front com o GET acima, que lê as mesmas regras.
router.post('/anunciantes/me/creditos/resgatar', exigirAnuncianteLogado, async (req, res) => {
  const contaId = req.session.anuncianteId;
  const tier = req.body.tier;
  const meses = Number(req.body.meses);
  const custo = custoDoBeneficio(tier, meses);
  if (!custo) return res.status(400).json({ erro: 'escolha um plano e um período válidos' });

  // O mesmo plano-alvo de sempre (essencial→destaque→maximo = Essencial/Pro/
  // Prime), no ciclo escolhido — nunca um plano fundador.
  const { rows: planoRows } = await pool.query(
    'SELECT * FROM planos WHERE tier = $1 AND compromisso_meses = $2 AND ativo AND NOT fundador ORDER BY id LIMIT 1',
    [tier, meses],
  );
  const plano = planoRows[0];
  if (!plano) return res.status(500).json({ erro: 'esse plano não está disponível agora — fale com a gente' });

  const cliente = await pool.connect();
  let resultado;
  try {
    await cliente.query('BEGIN');
    // Trava a conta: dois resgates simultâneos conferiam o saldo antes da
    // transação e os dois passavam — o ledger podia ficar negativo. Tudo que
    // decide o resgate é relido DEPOIS da trava.
    const { rows: travada } = await cliente.query('SELECT * FROM anunciantes WHERE id = $1 FOR UPDATE', [contaId]);
    const conta = travada[0];
    if (!conta) throw Object.assign(new Error('conta não encontrada'), { status: 404 });
    const bloqueio =
      (await bloqueioDoResgate(conta, await planoAdministrativo.historicoDaConta(contaId))) ||
      (await bloqueioPorNivel(conta, tier));
    if (bloqueio) throw Object.assign(new Error(bloqueio), { status: 409 });
    const saldoAtual = await repo.saldo(contaId, cliente);
    if (saldoAtual < custo) {
      throw Object.assign(new Error(`Saldo insuficiente — faltam ${custo - saldoAtual} créditos.`), { status: 409 });
    }
    const debito = await repo.debitarResgate(
      contaId,
      custo,
      `Resgate: ${NOME_TIER[tier]} · ${nomeDoCiclo(meses)}`,
      cliente,
    );
    resultado = await planoAdministrativo.resgatarOuConcederBeneficio(
      {
        conta,
        plano,
        diasDeBeneficio: meses * DIAS_POR_MES,
        observacao: 'resgate de créditos',
        origem: 'indicacao',
        ledgerId: debito.id,
      },
      cliente,
    );
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  } finally {
    cliente.release();
  }

  const { conta: atualizada, historico, status } = resultado;
  await notificacoesRepo.registrar(contaId, {
    tipo: status === 'ativo' ? 'beneficio_iniciado' : 'beneficio_programado',
    titulo:
      status === 'ativo'
        ? `${NOME_TIER[tier]} · ${nomeDoCiclo(meses)} ativado por créditos`
        : `${NOME_TIER[tier]} · ${nomeDoCiclo(meses)} programado por créditos`,
    descricao:
      status === 'ativo'
        ? `Válido até ${dataBR(historico.valido_ate)}.`
        : `Começa em ${dataBR(vigencia.inicioDepoisDoPago(historico.plano_anterior_valido_ate))}, quando seu plano pago atual terminar, e vale até ${dataBR(historico.valido_ate)}.`,
  });
  sse.emitirParaConta(contaId, 'credits.updated', {});
  // O plano em vigor pode ter mudado: o card Plano e o de custo por
  // exibição prevista se refazem sem F5 (em outras abas também).
  sse.emitirParaConta(contaId, 'plan.updated', {});
  res.json({
    conta: atualizada,
    status,
    validoAte: historico.valido_ate,
    comecaEm: vigencia.inicioDepoisDoPago(historico.plano_anterior_valido_ate),
  });
});

router.get('/anunciantes/me/notificacoes', exigirAnuncianteLogado, async (req, res) => {
  const [lista, naoLidas] = await Promise.all([
    notificacoesRepo.listar(req.session.anuncianteId, { limite: Number(req.query.limite) || 30 }),
    notificacoesRepo.contarNaoLidas(req.session.anuncianteId),
  ]);
  res.json({ notificacoes: lista, naoLidas });
});

router.post('/anunciantes/me/notificacoes/:id/lida', exigirAnuncianteLogado, async (req, res) => {
  const linha = await notificacoesRepo.marcarLida(req.session.anuncianteId, Number(req.params.id));
  if (!linha) return res.status(404).json({ erro: 'notificação não encontrada' });
  res.json(linha);
});

router.post('/anunciantes/me/notificacoes/marcar-todas-lidas', exigirAnuncianteLogado, async (req, res) => {
  await notificacoesRepo.marcarTodasLidas(req.session.anuncianteId);
  res.json({ ok: true });
});

// ---------- admin ----------

// POST /admin/anunciantes/:id/creditos/conceder — substitui "Liberar plano"
// na Central de Contas (pedido do dono): a forma normal de dar cortesia
// comercial passa a ser crédito, não plano direto — o mesmo resgate acima
// decide em que vira. `liberar-plano` e `plano-administrativo` continuam
// existindo (não apagados), como mecanismo técnico de correção emergencial,
// não como fluxo comercial normal.
//
// Revisão da ficha de Conta (23/09/2026): motivo passou a ser OBRIGATÓRIO no
// servidor (antes só o modal exigia — um POST direto gravava concessão sem
// motivo nenhum no ledger) e ganhou a nota interna opcional (migration 081).
// Conta suspensa ou excluída não recebe concessão: a suspensão congela
// qualquer mudança comercial, e a ficha já escondia o botão nesse estado.
router.post('/admin/anunciantes/:id/creditos/conceder', async (req, res) => {
  const { quantidade } = req.body;
  const motivo = String(req.body.motivo || '')
    .trim()
    .slice(0, 200);
  const notaInterna =
    String(req.body.nota_interna || '')
      .trim()
      .slice(0, 500) || null;
  if (!motivo) return res.status(400).json({ erro: 'descreva o motivo da concessão' });
  const conta = await anunciantesRepo.buscarPorId(req.params.id);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  if (conta.conta_propria) return res.status(400).json({ erro: 'a conta interna do Mostraí não recebe crédito' });
  if (conta.excluido_em) return res.status(409).json({ erro: 'conta excluída — restaure antes de conceder créditos' });
  if (conta.suspenso) return res.status(409).json({ erro: 'conta suspensa — reative antes de conceder créditos' });
  try {
    const linha = await repo.concederAdmin(conta.id, quantidade, {
      motivo,
      notaInterna,
      adminUsuario: req.session.adminUsuario,
    });
    await notificacoesRepo.registrar(conta.id, {
      tipo: 'creditos_recebidos',
      titulo: `Você recebeu ${linha.quantidade} ${linha.quantidade === 1 ? 'crédito' : 'créditos'}`,
      descricao: motivo,
    });
    sse.emitirParaConta(conta.id, 'credits.updated', {});
    res.status(201).json(linha);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ erro: err.message });
    throw err;
  }
});

router.get('/admin/anunciantes/:id/creditos', async (req, res) => {
  const [saldoAtual, movimentacoes, historico] = await Promise.all([
    repo.saldo(req.params.id),
    repo.movimentacoes(req.params.id, 100),
    planoAdministrativo.historicoDaConta(req.params.id),
  ]);
  res.json({ saldo: saldoAtual, movimentacoes, historicoBeneficios: historico });
});

module.exports = router;
