const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const repo = require('./repository');
const notificacoesRepo = require('./notificacoes');
const { custoDoBeneficio, opcoesDisponiveis, NOME_TIER } = require('./regras');
const planoAdministrativo = require('../financeiro/plano-administrativo');
const anunciantesRepo = require('../anunciantes/repository');
const comodato = require('../pontos/comodato');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');
const sse = require('../lib/sse');

// ---------- autoatendimento (conta logada) ----------

// GET /anunciantes/me/creditos — saldo, movimentações recentes, as opções
// de resgate (as que já dá pra pagar e as que faltam) e o benefício
// ativo/agendado agora, se houver. É o dado que alimenta o card "Créditos e
// benefícios" do dashboard inteiro, numa chamada só.
router.get('/anunciantes/me/creditos', exigirAnuncianteLogado, async (req, res) => {
  const contaId = req.session.anuncianteId;
  const [saldoAtual, movimentacoes, historico] = await Promise.all([
    repo.saldo(contaId),
    repo.movimentacoes(contaId, 20),
    planoAdministrativo.historicoDaConta(contaId),
  ]);
  const ativo = historico.find((h) => h.status === 'ativo') || null;
  const agendado = historico.find((h) => h.status === 'agendado') || null;
  res.json({
    saldo: saldoAtual,
    opcoes: opcoesDisponiveis(saldoAtual),
    movimentacoes: movimentacoes.map((m) => ({
      id: m.id,
      tipo: m.tipo,
      quantidade: m.quantidade,
      origem_nome: m.origem_nome,
      observacao: m.observacao,
      criado_em: m.criado_em,
    })),
    beneficioAtivo: ativo && {
      tier: NOME_TIER[ativo.tier] || ativo.tier,
      validoAte: ativo.valido_ate,
      planoNome: ativo.plano_nome,
    },
    beneficioAgendado: agendado && {
      tier: NOME_TIER[agendado.tier] || agendado.tier,
      validoAte: agendado.valido_ate,
      planoNome: agendado.plano_nome,
      planoAnteriorValidoAte: agendado.plano_anterior_valido_ate,
    },
  });
});

// POST /anunciantes/me/creditos/resgatar {tier, meses} — a conta troca
// créditos por um benefício. O preview ("agora/depois/ao terminar") é
// montado no FRONTEND com os mesmos dados deste GET acima + o plano atual
// da conta (GET /anunciantes/me) — nenhum estado novo pra isso, e o preview
// nunca fica desatualizado em relação ao que o resgate de fato faz, porque
// os dois leem a mesma fonte.
router.post('/anunciantes/me/creditos/resgatar', exigirAnuncianteLogado, async (req, res) => {
  const contaId = req.session.anuncianteId;
  const { tier, meses } = req.body;
  const custo = custoDoBeneficio(tier, meses);
  if (!custo) return res.status(400).json({ erro: 'escolha um plano e um período válidos' });

  const conta = await anunciantesRepo.buscarPorId(contaId);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  if (conta.suspenso) return res.status(409).json({ erro: 'conta suspensa — fale com a gente antes de resgatar' });
  if (await comodato.bloqueiaPlanoComercial(contaId)) {
    return res.status(409).json({
      erro:
        'essa conta está na modalidade "Recebe os R$ 50" do comodato, que não acumula com plano comercial — ' +
        'troque a modalidade pra "Troca os R$ 50 por tela" antes de resgatar',
    });
  }
  const saldoAtual = await repo.saldo(contaId);
  if (saldoAtual < custo)
    return res.status(409).json({ erro: `saldo insuficiente — faltam ${custo - saldoAtual} créditos` });

  // O mesmo plano-alvo de sempre (essencial→destaque→maximo = Essencial/Pro/
  // Prime), no ciclo escolhido pelo cliente — nunca um plano fundador (regra
  // já usada em plano-administrativo.js).
  const { rows: planoRows } = await pool.query(
    'SELECT * FROM planos WHERE tier = $1 AND compromisso_meses = $2 AND ativo AND NOT fundador ORDER BY id LIMIT 1',
    [tier, meses],
  );
  const plano = planoRows[0];
  if (!plano) return res.status(500).json({ erro: 'esse plano não está disponível agora — fale com a gente' });

  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await repo.debitarResgate(
      contaId,
      custo,
      `Resgate: ${NOME_TIER[tier]} · ${meses} ${meses === 1 ? 'mês' : 'meses'}`,
      cliente,
    );
    const { conta: atualizada, status } = await planoAdministrativo.resgatarOuConcederBeneficio(
      {
        conta,
        plano,
        validoAte: new Date(Date.now() + meses * 30 * 24 * 3600 * 1000).toISOString().slice(0, 10),
        observacao: 'resgate de créditos',
        origem: 'indicacao',
      },
      cliente,
    );
    await cliente.query('COMMIT');
    await notificacoesRepo.registrar(contaId, {
      tipo: status === 'ativo' ? 'beneficio_iniciado' : 'beneficio_programado',
      titulo:
        status === 'ativo' ? `${NOME_TIER[tier]} ativado por créditos` : `${NOME_TIER[tier]} programado por créditos`,
      descricao:
        status === 'ativo'
          ? `Válido até ${new Date(plano ? atualizada.data_expiracao : null).toLocaleDateString('pt-BR')}.`
          : 'Começa quando seu plano pago em dia terminar — sem cobrar de novo até lá.',
    });
    sse.emitirParaConta(contaId, 'credits.updated', {});
    res.json({ conta: atualizada, status });
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
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
router.post('/admin/anunciantes/:id/creditos/conceder', async (req, res) => {
  const { quantidade, motivo } = req.body;
  const conta = await anunciantesRepo.buscarPorId(req.params.id);
  if (!conta) return res.status(404).json({ erro: 'conta não encontrada' });
  if (conta.conta_propria) return res.status(400).json({ erro: 'a conta interna do Mostraí não recebe crédito' });
  try {
    const linha = await repo.concederAdmin(conta.id, quantidade, { motivo, adminUsuario: req.session.adminUsuario });
    await notificacoesRepo.registrar(conta.id, {
      tipo: 'creditos_recebidos',
      titulo: `Você recebeu ${linha.quantidade} créditos`,
      descricao: motivo || undefined,
    });
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
