const { erro } = require('./lib/erros');
const { medir } = require('./lib/registro');

// Estoque da Trimundi (RN-T07, RN-T10 a RN-T12; docs/trimundi/modelo-de-dados.md,
// "Disponibilidade"). Quem decide se há vaga é sempre o servidor, e toda
// escrita de estoque (pedido, confirmação, cortesia) acontece segurando a
// trava da linha da edição — por isso as leituras daqui, feitas DENTRO dessa
// transação, enxergam o estoque sem corrida.

// Vendidos de cada lote = vagas de pedido pago com ingresso não cancelado +
// vagas de pedido aguardando pagamento com a reserva ainda viva.
const SQL_LOTES = `
  SELECT l.id, l.categoria_id, l.ordem, l.preco_centavos, l.quantidade, l.inicio_vendas, l.fim_vendas, l.beneficio_id,
         l.encerrado_em, l.motivo_encerramento,
         COALESCE(SUM(CASE WHEN p.status = 'pago' AND i.id IS NOT NULL AND i.status <> 'cancelado' THEN 1 ELSE 0 END), 0)::int AS pagos,
         COALESCE(SUM(CASE WHEN p.status = 'aguardando_pagamento' AND p.reserva_expira_em > now() THEN 1 ELSE 0 END), 0)::int AS reservados
    FROM lotes l
    LEFT JOIN reservas r ON r.lote_id = l.id
    LEFT JOIN pedidos p ON p.id = r.pedido_id
    LEFT JOIN ingressos i ON i.reserva_id = r.id
   WHERE l.categoria_id = ANY($1::bigint[])
   GROUP BY l.id
   ORDER BY l.categoria_id, l.ordem`;

async function carregarLotes(cliente, categoriaIds) {
  if (!categoriaIds.length) return new Map();
  const { rows } = await cliente.query(SQL_LOTES, [categoriaIds]);
  const porCategoria = new Map(categoriaIds.map((id) => [Number(id), []]));
  for (const r of rows) porCategoria.get(Number(r.categoria_id))?.push(r);
  return porCategoria;
}

// Situação de cada lote de UM tipo de ingresso, em ordem. Função pura.
// Regra do dono (09/11/2026): cada lote vende só a quantidade dele — o que
// não vendeu num lote encerrado NÃO passa para o próximo.
//   encerrado / esgotado — fechado à mão, pela data, ou esgotado por PAGOS
//     (marca gravada na confirmação do pagamento); não reabre
//   esgotado (sem marca) — tudo reservado por pedidos ainda não pagos: o
//     próximo lote vende enquanto isso; reserva que vence devolve a vaga
//     para ESTE lote (ele nunca fechou)
//   a_venda — o vigente; aguardando_anterior — vem depois do vigente
//   agendado — o primeiro aberto ainda não começou (nada à venda agora)
function estadoDaCategoria(lotes, agora = new Date()) {
  let achouVigente = false;
  const saida = [];
  for (const l of lotes) {
    const efetiva = l.quantidade;
    const vendidos = l.pagos + l.reservados;
    const disponivel = Math.max(0, efetiva - vendidos);
    const porData = l.fim_vendas && new Date(l.fim_vendas) <= agora;
    const fechado = Boolean(l.encerrado_em) || Boolean(porData);
    let situacao;
    if (fechado) situacao = l.motivo_encerramento === 'esgotado' ? 'esgotado' : 'encerrado';
    else if (achouVigente) situacao = 'aguardando_anterior';
    else if (l.inicio_vendas && new Date(l.inicio_vendas) > agora) {
      situacao = 'agendado';
      achouVigente = true;
    } else if (disponivel === 0) situacao = 'esgotado';
    else {
      situacao = 'a_venda';
      achouVigente = true;
    }
    saida.push({ ...l, efetiva, vendidos, disponivel, situacao, fechado });
  }
  // Cadeia vendável agora: o vigente e os seguintes que abrem sozinhos quando
  // ele esgotar (sem início no futuro e sem fim já passado).
  const cadeia = [];
  const iVigente = saida.findIndex((l) => l.situacao === 'a_venda');
  if (iVigente >= 0) {
    for (let i = iVigente; i < saida.length; i++) {
      const l = saida[i];
      if (i > iVigente && l.inicio_vendas && new Date(l.inicio_vendas) > agora) break;
      if (l.fechado) continue;
      cadeia.push(l);
    }
  }
  const agendado = saida.find((l) => l.situacao === 'agendado');
  return {
    lotes: saida,
    vigente: iVigente >= 0 ? saida[iVigente] : null,
    cadeia,
    disponivelAgora: cadeia.reduce((s, l) => s + l.disponivel, 0),
    proximoInicio: iVigente < 0 ? (agendado?.inicio_vendas ?? null) : null,
    // Lotes completos por PAGOS ainda sem a marca: recebem "esgotado".
    semMarca: saida.filter((l) => !l.fechado && l.pagos >= l.quantidade).map((l) => l.id),
  };
}

// Grava a marca "esgotado" nos lotes completos por pagos (depois de uma
// confirmação de pagamento) e mede.
async function marcarEsgotados(cliente, loteIds, edicaoId) {
  if (!loteIds.length) return [];
  const { rows } = await cliente.query(
    `UPDATE lotes l SET encerrado_em = now(), motivo_encerramento = 'esgotado'
      WHERE l.id = ANY($1::bigint[]) AND l.encerrado_em IS NULL
        AND l.quantidade <= (SELECT count(*) FROM ingressos i JOIN pedidos p ON p.id = i.pedido_id
                              WHERE i.lote_id = l.id AND p.status = 'pago' AND i.status <> 'cancelado')
      RETURNING l.id`,
    [loteIds],
  );
  for (const l of rows) await medir(cliente, 'catalogo:lote_esgota', edicaoId, { lote_id: l.id });
  return rows.map((r) => r.id);
}

// Distribui vagas pelos lotes de cada tipo, na ordem da cadeia, com o estado
// em memória: duas chamadas no mesmo pedido enxergam o que a primeira tirou.
function criarAlocador(lotesPorCategoria, agora = new Date()) {
  const estados = new Map();
  const consumo = new Map();
  for (const [categoriaId, lotes] of lotesPorCategoria) estados.set(categoriaId, estadoDaCategoria(lotes, agora));
  return {
    estado: (categoriaId) => estados.get(Number(categoriaId)),
    disponivel(categoriaId) {
      const e = estados.get(Number(categoriaId));
      if (!e) return 0;
      return e.cadeia.reduce((s, l) => s + Math.max(0, l.disponivel - (consumo.get(l.id) || 0)), 0);
    },
    // Devolve [{ lote, quantidade }]; lança 409 se não couber.
    tirar(categoriaId, quantidade, rotulo) {
      const e = estados.get(Number(categoriaId));
      if (!e) throw erro(409, `${rotulo} não está à venda.`);
      const partes = [];
      let falta = quantidade;
      for (const l of e.cadeia) {
        if (!falta) break;
        const livre = Math.max(0, l.disponivel - (consumo.get(l.id) || 0));
        if (!livre) continue;
        const n = Math.min(livre, falta);
        consumo.set(l.id, (consumo.get(l.id) || 0) + n);
        partes.push({ lote: l, quantidade: n });
        falta -= n;
      }
      if (falta > 0) {
        const total = quantidade - falta + this.disponivel(categoriaId);
        throw erro(409, total ? `Restam só ${total} de ${rotulo} agora.` : `${rotulo} está esgotado.`, {
          codigo: 'esgotado',
          disponivel: total,
        });
      }
      return partes;
    },
  };
}

// Ocupação da edição (RN-T07): ingressos não cancelados (pagos e cortesias)
// + vagas reservadas vivas.
async function ocupacaoDaEdicao(cliente, edicaoId) {
  const { rows } = await cliente.query(
    `SELECT (SELECT count(*) FROM ingressos WHERE edicao_id = $1 AND status <> 'cancelado')
          + (SELECT count(*) FROM reservas r JOIN pedidos p ON p.id = r.pedido_id
              WHERE p.edicao_id = $1 AND p.status = 'aguardando_pagamento' AND p.reserva_expira_em > now()) AS n`,
    [edicaoId],
  );
  return Number(rows[0].n);
}

// Combos consumidos: pagos e reservados vivos (pedido devolvido não conta).
async function combosVendidos(cliente, promocaoIds) {
  if (!promocaoIds.length) return new Map();
  const { rows } = await cliente.query(
    `SELECT pi.promocao_id,
            COALESCE(SUM(CASE WHEN p.status = 'pago' THEN pi.quantidade ELSE 0 END), 0)::int AS pagos,
            COALESCE(SUM(CASE WHEN p.status = 'aguardando_pagamento' AND p.reserva_expira_em > now()
                         THEN pi.quantidade ELSE 0 END), 0)::int AS reservados
       FROM pedido_itens pi JOIN pedidos p ON p.id = pi.pedido_id
      WHERE pi.promocao_id = ANY($1::bigint[])
      GROUP BY pi.promocao_id`,
    [promocaoIds],
  );
  return new Map(rows.map((r) => [Number(r.promocao_id), { pagos: r.pagos, reservados: r.reservados }]));
}

// Ingressos (fora de combo) do mesmo CPF de comprador na edição, por tipo
// (RN-T14): pagos não cancelados + reservados vivos.
async function compradosPorCpf(cliente, edicaoId, cpf, categoriaIds) {
  if (!categoriaIds.length) return new Map();
  const { rows } = await cliente.query(
    `SELECT r.categoria_id, count(*)::int AS n
       FROM reservas r
       JOIN pedidos p ON p.id = r.pedido_id
       JOIN compradores c ON c.id = p.comprador_id
       LEFT JOIN ingressos i ON i.reserva_id = r.id
      WHERE p.edicao_id = $1 AND c.cpf = $2 AND r.promocao_item_id IS NULL AND r.categoria_id = ANY($3::bigint[])
        AND ((p.status = 'pago' AND i.id IS NOT NULL AND i.status <> 'cancelado')
          OR (p.status = 'aguardando_pagamento' AND p.reserva_expira_em > now()))
      GROUP BY r.categoria_id`,
    [edicaoId, cpf, categoriaIds],
  );
  return new Map(rows.map((r) => [Number(r.categoria_id), r.n]));
}

// Situação de um combo para a vitrine e para o Admin.
function situacaoDoCombo(promo, itens, vendidos, alocador, agora = new Date()) {
  if (!promo.ativo) return 'inativa';
  if (promo.inicio && new Date(promo.inicio) > agora) return 'em_breve';
  if (promo.fim && new Date(promo.fim) <= agora) return 'fora_da_validade';
  const usados = (vendidos?.pagos || 0) + (vendidos?.reservados || 0);
  if (usados >= promo.quantidade) return 'esgotada';
  const precisa = new Map();
  for (const it of itens)
    precisa.set(Number(it.categoria_id), (precisa.get(Number(it.categoria_id)) || 0) + it.quantidade);
  for (const [cat, n] of precisa) if (alocador.disponivel(cat) < n) return 'esgotada';
  return 'a_venda';
}

module.exports = {
  carregarLotes,
  estadoDaCategoria,
  marcarEsgotados,
  criarAlocador,
  ocupacaoDaEdicao,
  combosVendidos,
  compradosPorCpf,
  situacaoDoCombo,
};
