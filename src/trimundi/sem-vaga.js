const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');

// Fila de exceções "pago sem vaga" (P5, decisão do dono de 16/11/2026): o
// pagamento chegou depois de a reserva vencer e já não havia vaga — no lote,
// na capacidade da edição ou na promoção de preço (encerrada ou sem
// quantidade). Nada é emitido nem consumido; o Admin identifica e trata:
// devolve o valor (fluxo de reembolso de sempre) e anota o que fez.
//
// Situação da conciliação, derivada do que existe (nada é marcado à mão):
//   a_devolver           — nenhum reembolso pedido
//   devolucao_solicitada — reembolso pedido, esperando o Checkout
//   devolucao_reenviar   — o pedido de reembolso não chegou ao Checkout
//   devolucao_falhou     — o Checkout recusou (falhou ou negou)
//   devolvido            — o Checkout confirmou a devolução do valor inteiro

const MOTIVO = {
  lote: 'O lote da reserva fechou ou ficou sem vaga.',
  capacidade: 'A capacidade da edição foi atingida.',
  promocao_encerrada: 'A promoção de preço já estava encerrada, pausada ou fora do prazo.',
  promocao_sem_quantidade: 'A quantidade promocional tinha acabado.',
};
const SITUACAO = {
  a_devolver: 'A devolver',
  devolucao_solicitada: 'Devolução pedida ao Checkout',
  devolucao_reenviar: 'Devolução não chegou ao Checkout — reenviar',
  devolucao_falhou: 'Devolução recusada pelo Checkout',
  devolvido: 'Devolvido',
};

function situacao(p, reembolsos) {
  const confirmado = reembolsos.filter((r) => r.status === 'confirmado').reduce((s, r) => s + Number(r.valor), 0);
  if (p.status === 'estornado' || confirmado >= Number(p.total_centavos)) return 'devolvido';
  if (reembolsos.some((r) => r.status === 'solicitado' && r.ultimo_erro)) return 'devolucao_reenviar';
  if (reembolsos.some((r) => r.status === 'solicitado')) return 'devolucao_solicitada';
  if (reembolsos.some((r) => ['falhou', 'negado'].includes(r.status))) return 'devolucao_falhou';
  return 'a_devolver';
}

// A fila da edição: os pagos sem vaga (de agora e de antes da migration 019) e
// os que já saíram dela por devolução — com o histórico, para consulta.
async function fila(edicaoId) {
  const { rows } = await consultar(
    `SELECT p.id, upper(left(p.id::text, 8)) AS codigo, p.status, p.total_centavos, p.valor_cobrado_centavos,
            p.pago_em, p.metodo_pagamento, co.nome AS comprador, cl.nome AS conta,
            s.motivo, s.detalhe, s.registrado_em, c.id AS campanha_id, c.nome AS campanha
       FROM pedidos p JOIN compradores co ON co.id = p.comprador_id
       LEFT JOIN clientes cl ON cl.id = p.cliente_id
       LEFT JOIN pedidos_sem_vaga s ON s.pedido_id = p.id
       LEFT JOIN campanhas c ON c.id = s.campanha_id
      WHERE p.edicao_id = $1 AND (p.status = 'pago_sem_vaga' OR s.pedido_id IS NOT NULL)
      ORDER BY p.pago_em DESC NULLS LAST
      LIMIT 500`,
    [edicaoId],
  );
  if (!rows.length) return { itens: [], abertos: 0 };
  const ids = rows.map((r) => r.id);
  const { rows: reemb } = await consultar(
    `SELECT id, pedido_id, status, valor_centavos AS valor, motivo, solicitado_por, ultimo_erro, criado_em, confirmado_em
       FROM reembolsos WHERE pedido_id = ANY($1::uuid[]) ORDER BY id`,
    [ids],
  );
  const { rows: aud } = await consultar(
    `SELECT entidade_id AS pedido_id, acao, autor, detalhe, ocorrido_em FROM auditoria
      WHERE entidade = 'pedido' AND entidade_id = ANY($1::text[]) ORDER BY id`,
    [ids],
  );
  const itens = rows.map((p) => {
    const rs = reemb.filter((r) => r.pedido_id === p.id);
    const sit = situacao(p, rs);
    const historico = [
      p.registrado_em || p.pago_em
        ? {
            em: p.registrado_em || p.pago_em,
            acao: 'Pagamento recebido sem vaga',
            autor: 'sistema',
            nota: p.detalhe || null,
          }
        : null,
      ...aud
        .filter((a) => a.pedido_id === p.id)
        .map((a) => ({
          em: a.ocorrido_em,
          acao:
            {
              sem_vaga_anotado: 'Anotação',
              reembolso_solicitado: 'Devolução pedida',
              reembolso_reenviado: 'Devolução reenviada',
            }[a.acao] || a.acao,
          autor: a.autor,
          nota: a.detalhe?.nota || rs.find((r) => Number(r.id) === Number(a.detalhe?.reembolso_id))?.motivo || null,
        })),
      ...rs
        .filter((r) => r.confirmado_em)
        .map((r) => ({
          em: r.confirmado_em,
          acao: 'Devolução confirmada pelo Checkout',
          autor: 'Checkout',
          nota: null,
        })),
      ...rs
        .filter((r) => ['falhou', 'negado'].includes(r.status))
        .map((r) => ({ em: r.criado_em, acao: 'Devolução recusada', autor: 'Checkout', nota: r.ultimo_erro || null })),
    ]
      .filter(Boolean)
      .sort((a, b) => new Date(a.em) - new Date(b.em));
    return {
      pedido_id: p.id,
      codigo: p.codigo,
      comprador: p.comprador,
      conta: p.conta,
      valor_recebido_centavos: Number(p.valor_cobrado_centavos ?? p.total_centavos),
      total_centavos: Number(p.total_centavos),
      metodo: p.metodo_pagamento,
      recebido_em: p.pago_em,
      campanha: p.campanha_id ? { id: p.campanha_id, nome: p.campanha } : null,
      motivo: p.motivo,
      motivo_texto: p.motivo ? MOTIVO[p.motivo] : 'Motivo não registrado (pagamento anterior à fila).',
      detalhe: p.detalhe,
      situacao: sit,
      situacao_texto: SITUACAO[sit],
      historico,
    };
  });
  return { itens, abertos: itens.filter((i) => i.situacao !== 'devolvido').length };
}

// Anotação do Admin no caso (contato com o comprador, combinado, etc.). Fica
// na auditoria do pedido — só acréscimo.
async function anotar(pedidoId, dados, autor) {
  const id = v.uuid(pedidoId);
  if (!id) throw erro(404, 'pedido não encontrado');
  const nota = v.texto(dados?.nota, { campo: 'a anotação', obrigatorio: true, min: 3, max: 300 });
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `SELECT p.id FROM pedidos p LEFT JOIN pedidos_sem_vaga s ON s.pedido_id = p.id
        WHERE p.id = $1 AND (p.status = 'pago_sem_vaga' OR s.pedido_id IS NOT NULL) FOR UPDATE OF p`,
      [id],
    );
    if (!rows[0]) throw erro(404, 'Este pedido não está na fila de pagos sem vaga.');
    await auditar(cliente, autor, 'sem_vaga_anotado', 'pedido', id, { nota });
    return { ok: true };
  });
}

module.exports = { fila, anotar, MOTIVO, SITUACAO };
