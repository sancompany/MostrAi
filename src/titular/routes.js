const express = require('express');
const router = express.Router();
const repo = require('./repository');
const anunciantesRepo = require('../anunciantes/repository');
const checkout = require('../financeiro/san-checkout');
const pool = require('../db/pool');
const email = require('../financeiro/email');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Prazo de arrependimento: 7 dias corridos da contratação (CDC art. 49). Conta
// da PRIMEIRA cobrança confirmada, que é quando a contratação se completou —
// contar do cadastro encurtaria o prazo de quem demorou pra pagar.
const DIAS_ARREPENDIMENTO = 7;

function dentroDoPrazo(contratadoEm) {
  const limite = new Date(contratadoEm).getTime() + DIAS_ARREPENDIMENTO * 24 * 3600 * 1000;
  return { dentro: Date.now() <= limite, limite: new Date(limite) };
}

// ---------------------------------------------------------------------------
// Acesso e portabilidade (LGPD art. 18, II e V)
// ---------------------------------------------------------------------------
// Baixa tudo o que a conta tem, em JSON. A Política de Privacidade promete
// isso "por e-mail" — o que só funciona enquanto o dono tiver tempo de montar
// à mão. Aqui o titular pega sozinho, na hora, sem pedir licença a ninguém.
router.get('/titular/meus-dados', exigirAnuncianteLogado, async (req, res) => {
  const dados = await repo.exportarConta(req.session.anuncianteId);
  if (!dados) return res.status(401).json({ erro: 'não autenticado' });
  const nome = String(dados.conta.nome_empresa || 'conta')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40);
  const dia = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mostrai-${nome}-${dia}.json"`);
  res.send(JSON.stringify(dados, null, 2));
});

// ---------------------------------------------------------------------------
// Revogação de consentimento (LGPD art. 8 §5 e art. 18, IX)
// ---------------------------------------------------------------------------
// Só o que É consentimento se revoga aqui. O que sustenta o serviço — nome,
// documento, endereço, histórico de cobrança — tem outra base legal (execução
// de contrato e obrigação fiscal) e não se revoga isoladamente: some junto
// com a conta. Prometer o contrário na tela seria mentir com botão.
router.post('/titular/consentimento', exigirAnuncianteLogado, async (req, res) => {
  const { escopo, aceita } = req.body || {};
  if (escopo === 'comunicacoes') {
    const r = await repo.definirComunicacoes(req.session.anuncianteId, aceita === true);
    return res.json({ ok: true, comunicacoes_revogado_em: r.comunicacoes_revogado_em });
  }
  if (escopo === 'opcionais') {
    const r = await repo.apagarDadosOpcionais(req.session.anuncianteId);
    return res.json({ ok: true, dados_opcionais_apagados_em: r.dados_opcionais_apagados_em });
  }
  return res.status(400).json({ erro: 'escopo inválido' });
});

// ---------------------------------------------------------------------------
// Arrependimento em 7 dias, com estorno (CDC art. 49)
// ---------------------------------------------------------------------------
// GET diz se o botão deve aparecer e até quando. Sem isso o front teria de
// refazer a conta de prazo — e duas contas de prazo divergem.
router.get('/titular/arrependimento', exigirAnuncianteLogado, async (req, res) => {
  const aberto = await repo.arrependimentoAberto(req.session.anuncianteId);
  if (aberto) return res.json({ disponivel: false, pedido: aberto });

  const primeira = await repo.primeiraCobranca(req.session.anuncianteId);
  if (!primeira) {
    return res.json({ disponivel: false, motivo: 'nenhuma cobrança confirmada ainda' });
  }
  const { dentro, limite } = dentroDoPrazo(primeira.criado_em);
  res.json({
    disponivel: dentro,
    motivo: dentro ? null : 'o prazo de 7 dias já passou',
    prazo_ate: limite,
    valor_a_estornar: await repo.totalPago(req.session.anuncianteId),
  });
});

// POST executa: cancela no Checkout, tira o anúncio do ar na hora e registra o
// estorno a pagar. O estorno em si acontece no painel do Checkout/Asaas — a
// API dele não expõe estorno —, então o que fica aqui é a obrigação com nome,
// valor e data, numa fila que o admin vê. Sem esse registro o pedido viraria
// um e-mail, e e-mail não cobra ninguém.
router.post('/titular/arrependimento', exigirAnuncianteLogado, async (req, res) => {
  const id = req.session.anuncianteId;
  const jaAberto = await repo.arrependimentoAberto(id);
  if (jaAberto) return res.status(409).json({ erro: 'já existe um pedido em andamento', pedido: jaAberto });

  const anunciante = await anunciantesRepo.buscarPorId(id);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });

  const primeira = await repo.primeiraCobranca(id);
  if (!primeira) return res.status(400).json({ erro: 'não há cobrança confirmada pra estornar' });

  const { dentro, limite } = dentroDoPrazo(primeira.criado_em);
  if (!dentro) {
    return res.status(400).json({
      erro: 'o prazo de 7 dias do arrependimento já passou',
      prazo_ate: limite,
    });
  }

  const { rows: assinaturas } = await pool.query(
    "SELECT id FROM assinaturas WHERE anunciante_id = $1 AND status = 'ativa' ORDER BY created_at DESC LIMIT 1",
    [id],
  );
  const assinatura = assinaturas[0] || null;

  // Cancela primeiro no Checkout: se falhar, nada aqui muda e a pessoa tenta
  // de novo. O contrário — marcar aqui e falhar lá — deixaria a cobrança
  // recorrente viva com a conta já desligada.
  if (assinatura) {
    try {
      await checkout.cancelarAssinatura(assinatura.id, anunciante.cpf_cnpj);
      await pool.query("UPDATE assinaturas SET status = 'cancelada' WHERE id = $1", [assinatura.id]);
    } catch {
      return res.status(502).json({
        erro: 'não conseguimos cancelar a cobrança agora — tente de novo em alguns minutos',
      });
    }
  }

  const pedido = await repo.registrarArrependimento({
    anuncianteId: id,
    assinaturaId: assinatura ? assinatura.id : null,
    planoId: anunciante.plano_id || primeira.plano_id,
    valor: await repo.totalPago(id),
    contratadoEm: primeira.criado_em,
  });

  // Fora do ar na hora: o direito é desfazer a contratação, não continuar
  // exibindo até o fim do ciclo pago.
  await anunciantesRepo.atualizar(id, {
    status: 'suspenso',
    plano_id: null,
    data_expiracao: null,
    valor_mensal_travado: null,
  });

  // Fire-and-forget: e-mail que falha não pode desfazer um direito já
  // exercido — o registro no banco é o que vale.
  email.enviarArrependimentoRecebido(anunciante, pedido).catch(() => {});

  res.status(201).json({ ok: true, pedido });
});

// ---------------------------------------------------------------------------
// Fila do admin
// ---------------------------------------------------------------------------
router.get('/admin/arrependimentos', async (_req, res) => {
  res.json(await repo.listarArrependimentos());
});

router.post('/admin/arrependimentos/:id/estornado', async (req, res) => {
  const pedido = await repo.marcarEstornado(req.params.id, req.body?.comprovante);
  if (!pedido) return res.status(404).json({ erro: 'pedido não encontrado ou já estornado' });
  res.json(pedido);
});

module.exports = router;
