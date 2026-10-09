const express = require('express');
const router = express.Router();
const repo = require('./repository');
const anunciantesRepo = require('../anunciantes/repository');
const checkout = require('../financeiro/san-checkout');
const pool = require('../db/pool');
const outbox = require('../email/outbox');
const obrigacaoDoCiclo = require('../bancohoras/obrigacao-do-ciclo');
const estornos = require('../financeiro/estornos');
const { exigirAnuncianteLogado } = require('../anunciantes/routes');

// Prazo de arrependimento: 7 dias corridos da contratação (CDC art. 49). Conta
// da PRIMEIRA cobrança confirmada, que é quando a contratação se completou —
// contar do cadastro encurtaria o prazo de quem demorou pra pagar. É a
// confirmação no PSP (`pago_em`, migration 120), como dizem os Termos.
const DIAS_ARREPENDIMENTO = 7;

// A última desistência atendida, quando o contrato atual é o dela (nenhuma
// compra paga depois do pedido): o direito já foi exercido.
async function atendidaSemContratoNovo(anuncianteId, primeira) {
  const atendido = await repo.arrependimentoAtendido(anuncianteId);
  if (!atendido) return null;
  return !primeira || new Date(primeira.confirmado_em) <= new Date(atendido.pedido_em) ? atendido : null;
}

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
  // Desistência já atendida vale para o contrato dela; só uma compra nova,
  // paga depois do pedido, abre outro prazo.
  const primeira = await repo.primeiraCobranca(req.session.anuncianteId);
  const atendido = await atendidaSemContratoNovo(req.session.anuncianteId, primeira);
  if (atendido) return res.json({ disponivel: false, pedido: atendido });
  if (!primeira) return res.json({ disponivel: false, motivo: 'nenhuma cobrança confirmada ainda' });
  const { dentro, limite } = dentroDoPrazo(primeira.confirmado_em);
  res.json({
    disponivel: dentro,
    motivo: dentro ? null : 'o prazo de 7 dias já passou',
    prazo_ate: limite,
    // O que ainda pode voltar DESTE contrato — o que o PSP já devolveu não
    // conta de novo, e o contrato antigo (cancelado antes) não entra.
    valor_a_estornar: await estornos.restanteDesde(req.session.anuncianteId, primeira.confirmado_em),
  });
});

// POST executa: cancela no Checkout, tira o anúncio do ar na hora e registra a
// devolução. É a ÚNICA regra documentada em que cancelar e devolver andam
// juntos (Termos §4, art. 49) — e mesmo aqui o cliente só PEDE: cada
// cobrança vira um pedido de estorno (migration 120), que o Admin executa na
// Asaas (o `/estornar` do San Checkout não alcança cobrança de assinatura) e
// que só conta quando o PSP confirma. A desistência fecha sozinha quando a
// última devolução é confirmada — nunca por clique.
router.post('/titular/arrependimento', exigirAnuncianteLogado, async (req, res) => {
  const id = req.session.anuncianteId;
  const jaAberto = await repo.arrependimentoAberto(id);
  if (jaAberto) return res.status(409).json({ erro: 'já existe um pedido em andamento', pedido: jaAberto });
  const anunciante = await anunciantesRepo.buscarPorId(id);
  if (!anunciante) return res.status(401).json({ erro: 'não autenticado' });

  // Já atendida e sem compra nova depois dela: o direito sobre aquele
  // contrato foi exercido (devolveria de novo o que já voltou).
  const primeira = await repo.primeiraCobranca(id);
  const atendido = await atendidaSemContratoNovo(id, primeira);
  if (atendido) return res.status(409).json({ erro: 'a desistência desta conta já foi atendida', pedido: atendido });
  if (!primeira) return res.status(400).json({ erro: 'não há cobrança confirmada pra estornar' });

  const { dentro, limite } = dentroDoPrazo(primeira.confirmado_em);
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

  // O pedido e as devoluções dele (uma por cobrança) nascem juntos: ou a
  // desistência fica registrada com o que tem de voltar, ou nada.
  let pedido;
  let avisos = [];
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    pedido = await repo.registrarArrependimento(
      {
        anuncianteId: id,
        assinaturaId: assinatura ? assinatura.id : null,
        planoId: anunciante.plano_id || primeira.plano_id,
        valor: await estornos.restanteDesde(id, primeira.confirmado_em, cliente),
        contratadoEm: primeira.confirmado_em,
      },
      cliente,
    );
    if (!pedido) {
      await cliente.query('ROLLBACK');
      return res.status(409).json({ erro: 'já existe um pedido em andamento' });
    }
    avisos = await estornos.solicitarDevolucoesDaDesistencia(cliente, {
      anuncianteId: id,
      desde: primeira.confirmado_em,
      arrependimentoId: pedido.id,
      motivo: `desistência em 7 dias (CDC art. 49), pedido ${pedido.id}`,
    });
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
  for (const aviso of avisos) {
    await checkout
      .registrarPendencia({ evento: 'desistencia', arrependimentoId: pedido.id }, aviso)
      .catch((err) => console.error('pendência da desistência não registrada:', err.message));
  }

  // Fora do ar na hora: o direito é desfazer a contratação, não continuar
  // exibindo até o fim do ciclo pago.
  await anunciantesRepo.atualizar(id, {
    suspenso: true,
    plano_id: null,
    data_expiracao: null,
  });
  // Reembolso integral: a obrigação de veiculação dos ciclos pagos some; o que
  // já tinha sido entregue vira saldo técnico negativo (interno — a próxima
  // contratação desconta), nunca dívida mostrada ao cliente (migration 111).
  // O pedido já vale: se o lançamento falhar aqui, a conciliação diária lança
  // (`conferirReembolsos`) — o erro não desfaz o direito exercido.
  await obrigacaoDoCiclo
    .registrarReembolsoDaConta(pool, {
      anuncianteId: id,
      motivo: `arrependimento (reembolso integral, pedido ${pedido.id})`,
      ate: pedido.pedido_em,
    })
    .catch((err) => console.error(`reembolso do pedido ${pedido.id} não lançado agora: ${err.message}`));

  // E-mail que falha não pode desfazer um direito já exercido — o registro
  // no banco é o que vale. Pela fila: antes o erro era engolido em silêncio
  // (`.catch(() => {})`), e a caixa da Mostraí (em cópia) nunca sabia que
  // havia uma devolução a fazer. Agora falha vira nova tentativa e, no fim,
  // "abandonado" visível no admin.
  await outbox.enfileirarSemFalhar({
    tipo: 'desistencia_registrada',
    chave: `desistencia_registrada:${pedido.id}`,
    para: anunciante.contato_email,
    anuncianteId: anunciante.id,
    dados: {
      conta: { nome_empresa: anunciante.nome_empresa },
      pedido: { id: pedido.id, valor_a_estornar: pedido.valor_a_estornar },
    },
  });

  res.status(201).json({ ok: true, pedido });
});

// ---------------------------------------------------------------------------
// Fila do admin
// ---------------------------------------------------------------------------
router.get('/admin/arrependimentos', async (_req, res) => {
  res.json(await repo.listarArrependimentos());
});

// "Registrar" à mão saiu (migration 120): marcava a devolução como feita sem
// o PSP dizer nada. Agora a desistência fecha quando a Asaas confirma cada
// devolução (webhook `cobranca_estornada`, src/financeiro/estornos.js).
router.post('/admin/arrependimentos/:id/estornado', (_req, res) =>
  res.status(410).json({
    erro: 'a devolução se confirma sozinha pelo aviso da Asaas — execute o estorno na Asaas e acompanhe em Financeiro → Devoluções',
  }),
);

module.exports = router;
