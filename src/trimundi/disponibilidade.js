const { erro } = require('./lib/erros');

// Estoque da Trimundi (RN-T07, RN-T10 a RN-T12; docs/trimundi/modelo-de-dados.md,
// "Disponibilidade"). Quem decide se há vaga é sempre o servidor, e toda
// escrita de estoque (pedido, confirmação, cortesia) acontece segurando a
// trava da linha da edição — por isso as leituras daqui, feitas DENTRO dessa
// transação, enxergam o estoque sem corrida.

// Vendidos de cada lote = vagas de pedido pago com ingresso não cancelado +
// vagas de pedido aguardando pagamento com a reserva ainda viva.
const SQL_LOTES = `
  SELECT l.id, l.categoria_id, l.ordem, l.preco_centavos, l.quantidade, l.inicio_vendas, l.fim_vendas,
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
//   esgotado / encerrado — fechado (não reabre); a sobra dele rola para o próximo
//   a_venda — o vigente; aguardando_anterior — vem depois do vigente
//   agendado — o primeiro não fechado ainda não começou (nada à venda agora)
function estadoDaCategoria(lotes, agora = new Date()) {
  let sobra = 0;
  let achouVigente = false;
  const saida = [];
  for (const l of lotes) {
    const efetiva = l.quantidade + sobra;
    const vendidos = l.pagos + l.reservados;
    const disponivel = Math.max(0, efetiva - vendidos);
    const porData = l.fim_vendas && new Date(l.fim_vendas) <= agora;
    const fechado = Boolean(l.encerrado_em) || Boolean(porData);
    let situacao;
    if (fechado) {
      situacao = l.motivo_encerramento === 'esgotado' ? 'esgotado' : 'encerrado';
      // Sem piso em zero: um pagamento tardio aceito neste lote fechado
      // (pagamentos.js#aindaCabe) tira a vaga do lote seguinte.
      sobra = efetiva - vendidos;
    } else if (achouVigente) {
      situacao = 'aguardando_anterior';
      sobra = 0;
    } else if (l.inicio_vendas && new Date(l.inicio_vendas) > agora) {
      situacao = 'agendado';
      achouVigente = true;
      sobra = 0;
    } else if (disponivel === 0) {
      // Esgotou sem a marca (ex.: quantidade reduzida): conta como esgotado e
      // o próximo assume; o alocador grava a marca.
      situacao = 'esgotado';
      sobra = 0;
    } else {
      situacao = 'a_venda';
      achouVigente = true;
      sobra = 0;
    }
    saida.push({ ...l, efetiva, vendidos, disponivel, situacao, fechado });
  }
  // Vaga que volta (reserva vencida) depois do ÚLTIMO lote não tem lote
  // seguinte para onde rolar: volta para o próprio último lote, se ele fechou
  // por esgotar (nunca se foi encerrado à mão ou pela data) e nada mais está
  // à venda — senão a vaga sumiria do estoque para sempre.
  const ultimo = saida[saida.length - 1];
  const ultimoPorData = ultimo?.fim_vendas && new Date(ultimo.fim_vendas) <= agora;
  if (!achouVigente && sobra > 0 && ultimo?.motivo_encerramento === 'esgotado' && !ultimoPorData) {
    ultimo.situacao = 'a_venda';
    ultimo.fechado = false;
    ultimo.reaberto = true;
    ultimo.disponivel = sobra;
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
    // Lotes esgotados sem a marca: o alocador grava "esgotado" neles.
    semMarca: saida.filter((l) => l.situacao === 'esgotado' && !l.encerrado_em).map((l) => l.id),
  };
}

// Distribui vagas pelos lotes de cada tipo, na ordem da cadeia, com o estado
// em memória: duas chamadas no mesmo pedido enxergam o que a primeira tirou.
function criarAlocador(lotesPorCategoria, agora = new Date()) {
  const estados = new Map();
  const consumo = new Map();
  for (const [categoriaId, lotes] of lotesPorCategoria) estados.set(categoriaId, estadoDaCategoria(lotes, agora));
  const esgotados = new Set();
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
      for (const id of e.semMarca) esgotados.add(id);
      const partes = [];
      let falta = quantidade;
      for (const l of e.cadeia) {
        if (!falta) break;
        const livre = Math.max(0, l.disponivel - (consumo.get(l.id) || 0));
        if (!livre) {
          esgotados.add(l.id);
          continue;
        }
        const n = Math.min(livre, falta);
        consumo.set(l.id, (consumo.get(l.id) || 0) + n);
        partes.push({ lote: l, quantidade: n });
        falta -= n;
        if (n === livre) esgotados.add(l.id);
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
    esgotados: () => [...esgotados],
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
  criarAlocador,
  ocupacaoDaEdicao,
  combosVendidos,
  compradosPorCpf,
  situacaoDoCombo,
};
