const { consultar } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { carregarLotes, estadoDaCategoria } = require('./disponibilidade');
const { listarPromocoes } = require('./promocoes');
const campanhas = require('./campanhas');
const { INGRESSO_DE_PE } = require('./indicacao');

// Relatórios administrativos (§8 do prompt master; auditoria em
// docs/trimundi/auditoria-relatorios.md). Tudo sai do banco a cada leitura —
// nenhum número estimado, nenhum total guardado. Definições únicas:
//   · VENDIDO  = ingresso pago de pedido de VENDA pago, não cancelado (teste
//     e cortesia ficam de fora; reembolso tira da conta);
//   · RECEITA  = soma de ingressos.valor_centavos (o valor efetivamente pago,
//     com desconto ou rateio de combo, sem taxa);
//   · DISPONÍVEL = estoque real (disponibilidade.carregarLotes).
// Sem CPF nem e-mail em nenhum relatório. Os CSVs neutralizam fórmula.

const VENDIDO = "(i.origem = 'pago' AND p.origem = 'venda' AND p.status = 'pago' AND i.status <> 'cancelado')";
const LIMITE = 5000;
// Teto só da TELA (JSON): o CSV sai sem teto (`gerar(..., { semLimite: true })`),
// senão a exportação de auditoria perderia linhas.
const limiteSql = (f) => (f.limite ? ` LIMIT ${Number(f.limite) + 1}` : '');
const cortar = (rows, f) => (f.limite ? rows.slice(0, f.limite) : rows);
const foiCortado = (rows, f) => Boolean(f.limite && rows.length > f.limite);
// Os mesmos rótulos da tela de Ingressos (o CSV sai legível, sem código interno).
const SITUACAO_LOTE = {
  agendado: 'Agendado',
  a_venda: 'À venda',
  aguardando_anterior: 'Aguardando o lote anterior',
  esgotado: 'Esgotado',
  encerrado: 'Encerrado',
};

// Filtros comuns, todos opcionais e validados (nada da query vai cru ao SQL).
function lerFiltros(q = {}) {
  const f = {};
  if (q.tipo) f.tipo = v.id(q.tipo, 'tipo');
  if (q.lote) f.lote = v.id(q.lote, 'lote');
  if (q.operador) f.operador = v.id(q.operador, 'operador');
  if (q.de) f.de = v.dataHora(q.de, { campo: 'o início do período' });
  if (q.ate) f.ate = v.dataHora(q.ate, { campo: 'o fim do período' });
  if (f.de && f.ate && f.ate < f.de) throw erro(400, 'O fim do período vem depois do início.');
  if (q.situacao) f.situacao = String(q.situacao);
  if (q.resultado) f.resultado = v.escolha(q.resultado, ['aceito', 'recusado'], { campo: 'o resultado' });
  return f;
}

// Monta "AND ..." com os parâmetros na ordem (começando depois dos fixos).
function condicoes(f, mapa, params) {
  const partes = [];
  for (const [chave, coluna] of Object.entries(mapa)) {
    if (f[chave] === undefined || f[chave] === null) continue;
    params.push(f[chave]);
    const n = `$${params.length}`;
    if (chave === 'de') partes.push(`${coluna} >= ${n}`);
    else if (chave === 'ate') partes.push(`${coluna} <= ${n}`);
    else partes.push(`${coluna} = ${n}`);
  }
  return partes.length ? ` AND ${partes.join(' AND ')}` : '';
}

const col = (id, rotulo, tipo = 'texto') => ({ id, rotulo, tipo });

// ------------------------------------------------------- 2. vendas por lote
async function vendasPorLote(edicaoId, f) {
  const params = [edicaoId];
  const extraVenda = condicoes({ de: f.de, ate: f.ate }, { de: 'p.pago_em', ate: 'p.pago_em' }, params);
  const extraLote = condicoes({ tipo: f.tipo, lote: f.lote }, { tipo: 'c.id', lote: 'l.id' }, params);
  const { rows } = await consultar(
    `SELECT l.id AS lote_id, c.id AS tipo_id, c.nome AS tipo, l.ordem, l.preco_centavos, l.quantidade,
            count(i.id) FILTER (WHERE ${VENDIDO}${extraVenda})::int AS vendidos,
            COALESCE(sum(i.valor_centavos) FILTER (WHERE ${VENDIDO}${extraVenda}), 0)::bigint AS receita_centavos
       FROM lotes l JOIN categorias c ON c.id = l.categoria_id
       LEFT JOIN ingressos i ON i.lote_id = l.id
       LEFT JOIN pedidos p ON p.id = i.pedido_id
      WHERE c.edicao_id = $1${extraLote}
      GROUP BY l.id, c.id
      ORDER BY c.ordem, c.id, l.ordem`,
    params,
  );
  const estoque = await carregarLotes({ query: (s, p) => consultar(s, p) }, [
    ...new Set(rows.map((r) => Number(r.tipo_id))),
  ]);
  const linhas = rows.map((r) => {
    const e = estadoDaCategoria(estoque.get(Number(r.tipo_id)) || []).lotes.find(
      (x) => Number(x.id) === Number(r.lote_id),
    );
    return {
      tipo: r.tipo,
      lote: `${r.ordem}º lote`,
      preco_centavos: Number(r.preco_centavos),
      quantidade: r.quantidade,
      vendidos: r.vendidos,
      receita_centavos: Number(r.receita_centavos),
      disponiveis: e && !e.fechado ? e.disponivel : 0,
      situacao: SITUACAO_LOTE[e?.situacao] || e?.situacao || '—',
    };
  });
  return {
    colunas: [
      col('tipo', 'Tipo'),
      col('lote', 'Lote'),
      col('preco_centavos', 'Preço', 'moeda'),
      col('quantidade', 'Quantidade', 'numero'),
      col('vendidos', 'Vendidos', 'numero'),
      col('receita_centavos', 'Receita', 'moeda'),
      col('disponiveis', 'Disponíveis', 'numero'),
      col('situacao', 'Situação'),
    ],
    linhas,
    totais: somar(linhas, ['quantidade', 'vendidos', 'receita_centavos', 'disponiveis']),
  };
}

// ------------------------------------------------------- 3. vendas por tipo
async function vendasPorTipo(edicaoId, f) {
  const porLote = await vendasPorLote(edicaoId, { ...f, lote: undefined });
  const mapa = new Map();
  for (const l of porLote.linhas) {
    const t = mapa.get(l.tipo) || {
      tipo: l.tipo,
      lotes: 0,
      quantidade: 0,
      vendidos: 0,
      receita_centavos: 0,
      disponiveis: 0,
    };
    t.lotes += 1;
    t.quantidade += l.quantidade;
    t.vendidos += l.vendidos;
    t.receita_centavos += l.receita_centavos;
    t.disponiveis += l.disponiveis;
    mapa.set(l.tipo, t);
  }
  const linhas = [...mapa.values()];
  return {
    colunas: [
      col('tipo', 'Tipo'),
      col('lotes', 'Lotes', 'numero'),
      col('quantidade', 'Quantidade', 'numero'),
      col('vendidos', 'Vendidos', 'numero'),
      col('receita_centavos', 'Receita', 'moeda'),
      col('disponiveis', 'Disponíveis', 'numero'),
    ],
    linhas,
    totais: somar(linhas, ['lotes', 'quantidade', 'vendidos', 'receita_centavos', 'disponiveis']),
  };
}

// ----------------------------------------------------- 11. disponíveis
async function disponiveis(edicaoId, f) {
  const r = await vendasPorLote(edicaoId, { tipo: f.tipo, lote: f.lote });
  const linhas = r.linhas.map(({ tipo, lote, quantidade, vendidos, disponiveis: d, situacao }) => ({
    tipo,
    lote,
    quantidade,
    vendidos,
    disponiveis: d,
    situacao,
  }));
  return {
    colunas: [
      col('tipo', 'Tipo'),
      col('lote', 'Lote'),
      col('quantidade', 'Quantidade', 'numero'),
      col('vendidos', 'Vendidos', 'numero'),
      col('disponiveis', 'Disponíveis agora', 'numero'),
      col('situacao', 'Situação'),
    ],
    linhas,
    totais: somar(linhas, ['quantidade', 'vendidos', 'disponiveis']),
  };
}

// ----------------------------------------------------- 12. combos vendidos
async function combos(edicaoId, f) {
  const lista = await listarPromocoes(edicaoId);
  const params = [edicaoId];
  const extra = condicoes({ de: f.de, ate: f.ate }, { de: 'p.pago_em', ate: 'p.pago_em' }, params);
  const { rows: receita } = await consultar(
    `SELECT i.promocao_id, count(*)::int AS ingressos, COALESCE(sum(i.valor_centavos), 0)::bigint AS receita
       FROM ingressos i JOIN pedidos p ON p.id = i.pedido_id
      WHERE i.edicao_id = $1 AND i.promocao_id IS NOT NULL AND ${VENDIDO}${extra}
      GROUP BY i.promocao_id`,
    params,
  );
  const porCombo = new Map(receita.map((r) => [Number(r.promocao_id), r]));
  const linhas = lista.map((c) => ({
    combo: c.nome,
    preco_centavos: Number(c.preco_total_centavos),
    quantidade: c.quantidade,
    vendidos: c.vendidos,
    ingressos: porCombo.get(Number(c.id))?.ingressos || 0,
    receita_centavos: Number(porCombo.get(Number(c.id))?.receita || 0),
    disponiveis: c.disponiveis,
  }));
  return {
    colunas: [
      col('combo', 'Combo'),
      col('preco_centavos', 'Preço', 'moeda'),
      col('quantidade', 'Quantidade', 'numero'),
      col('vendidos', 'Combos vendidos', 'numero'),
      col('ingressos', 'Ingressos de pé', 'numero'),
      col('receita_centavos', 'Receita', 'moeda'),
      col('disponiveis', 'Disponíveis', 'numero'),
    ],
    linhas,
    totais: somar(linhas, ['quantidade', 'vendidos', 'ingressos', 'receita_centavos', 'disponiveis']),
  };
}

// ------------------------------------------ 6. campanhas com maior conversão
async function campanhasConversao(edicaoId) {
  const lista = await campanhas.listar(edicaoId);
  const ids = lista.map((c) => Number(c.id));
  const { rows: desc } = ids.length
    ? await consultar(
        `SELECT r.campanha_id, count(*)::int AS unidades,
                COALESCE(sum(pi.preco_original_centavos - i.valor_centavos), 0)::bigint AS desconto,
                COALESCE(sum(i.valor_centavos), 0)::bigint AS receita
           FROM reservas r JOIN ingressos i ON i.reserva_id = r.id JOIN pedidos p ON p.id = i.pedido_id
           JOIN pedido_itens pi ON pi.id = r.pedido_item_id
          WHERE r.campanha_id = ANY($1::bigint[]) AND ${VENDIDO}
          GROUP BY r.campanha_id`,
        [ids],
      )
    : { rows: [] };
  const porDesc = new Map(desc.map((d) => [Number(d.campanha_id), d]));
  const MODALIDADE = { ordem_compra: 'Primeiros N', indicacao: 'Indicação', desconto: 'Promoção de preço' };
  const linhas = lista.map((c) => {
    const d = porDesc.get(Number(c.id));
    const resultado =
      c.modalidade === 'desconto'
        ? d?.unidades || 0
        : c.modalidade === 'indicacao'
          ? c.conversoes
          : c.a_retirar + c.entregues;
    return {
      campanha: c.nome,
      modalidade: MODALIDADE[c.modalidade] || c.modalidade,
      status: c.status,
      resultado,
      medida:
        c.modalidade === 'desconto'
          ? 'ingressos vendidos com desconto'
          : c.modalidade === 'indicacao'
            ? 'indicações convertidas'
            : 'brindes concedidos',
      posicoes: c.posicoes,
      premios_entregues: c.entregues,
      premios_a_retirar: c.a_retirar,
      desconto_centavos: Number(d?.desconto || 0),
      receita_centavos: Number(d?.receita || 0),
    };
  });
  linhas.sort((a, b) => b.resultado - a.resultado || a.campanha.localeCompare(b.campanha));
  return {
    colunas: [
      col('campanha', 'Campanha'),
      col('modalidade', 'Modalidade'),
      col('status', 'Situação'),
      col('resultado', 'Conversões', 'numero'),
      col('medida', 'O que conta'),
      col('posicoes', 'Posições', 'numero'),
      col('premios_entregues', 'Prêmios entregues', 'numero'),
      col('premios_a_retirar', 'Prêmios a retirar', 'numero'),
      col('desconto_centavos', 'Desconto concedido', 'moeda'),
      col('receita_centavos', 'Receita com desconto', 'moeda'),
    ],
    linhas,
    totais: somar(linhas, ['premios_entregues', 'premios_a_retirar', 'desconto_centavos', 'receita_centavos']),
  };
}

// --------------------------------------------- 7, 8, 9. recompensas
// situacao: todas (7 — concedidas) · entregues (8) · pendentes (9).
const SITUACOES = ['todas', 'entregues', 'pendentes'];
async function recompensas(edicaoId, f) {
  const situacao = f.situacao || 'todas';
  if (!SITUACOES.includes(situacao)) throw erro(400, 'situação inválida');
  const params = [edicaoId];
  const extra = condicoes({ de: f.de, ate: f.ate }, { de: 'x.concedido_em', ate: 'x.concedido_em' }, params);
  const filtroSit =
    situacao === 'entregues'
      ? " AND x.situacao = 'entregue'"
      : situacao === 'pendentes'
        ? " AND x.situacao = 'a retirar'"
        : '';
  const { rows } = await consultar(
    `WITH x AS (
       SELECT CASE ca.modalidade WHEN 'indicacao' THEN 'Indicação' ELSE 'Primeiros N' END AS origem,
              pr.premio, ca.nome AS campanha,
              COALESCE(pa.nome, cl.nome, o.nome, '—') AS de_quem, ing.codigo_curto,
              CASE pr.status WHEN 'concedido' THEN 'a retirar' ELSE pr.status END AS situacao,
              pr.concedido_em, pr.entregue_em,
              CASE WHEN pr.entregue_por LIKE 'operador:%' THEN (SELECT nome FROM operadores WHERE 'operador:' || operadores.id = pr.entregue_por)
                   WHEN pr.entregue_por IS NULL THEN NULL ELSE 'Admin' END AS entregue_por
         FROM campanha_premios pr JOIN campanhas ca ON ca.id = pr.campanha_id
         LEFT JOIN ingressos ing ON ing.id = pr.ingresso_id LEFT JOIN participantes pa ON pa.id = ing.participante_id
         LEFT JOIN indicadores ind ON ind.id = pr.indicador_id
         LEFT JOIN clientes cl ON cl.id = ind.cliente_id LEFT JOIN operadores o ON o.id = ind.operador_id
        WHERE ca.edicao_id = $1
       UNION ALL
       SELECT 'Benefício do ingresso', ib.nome, NULL, pa.nome, i.codigo_curto,
              CASE WHEN ib.resgatado_em IS NOT NULL THEN 'entregue' ELSE 'a retirar' END,
              i.emitido_em, ib.resgatado_em,
              (SELECT o.nome FROM checkins ck JOIN operadores o ON o.id = ck.operador_id
                WHERE ck.ingresso_id = i.id AND ck.escopo = 'beneficio' AND ck.beneficio_id = ib.beneficio_id
                  AND ck.resultado = 'aceito' ORDER BY ck.id LIMIT 1)
         FROM ingresso_beneficios ib JOIN ingressos i ON i.id = ib.ingresso_id
         JOIN participantes pa ON pa.id = i.participante_id LEFT JOIN pedidos p ON p.id = i.pedido_id
        WHERE i.edicao_id = $1 AND i.status <> 'cancelado' AND (p.id IS NULL OR p.origem = 'venda')
     )
     SELECT * FROM x WHERE true${extra}${filtroSit}
     ORDER BY (x.situacao = 'a retirar') DESC, x.concedido_em DESC NULLS LAST${limiteSql(f)}`,
    params,
  );
  const linhas = cortar(rows, f).map((r) => ({ ...r, campanha: r.campanha || '—' }));
  const contar = (s) => linhas.filter((l) => l.situacao === s).length;
  return {
    colunas: [
      col('origem', 'Origem'),
      col('premio', 'Recompensa'),
      col('campanha', 'Campanha'),
      col('de_quem', 'De quem'),
      col('codigo_curto', 'Ingresso'),
      col('situacao', 'Situação'),
      col('concedido_em', 'Concedida em', 'data'),
      col('entregue_em', 'Entregue em', 'data'),
      col('entregue_por', 'Entregue por'),
    ],
    linhas,
    totais: { total: linhas.length, a_retirar: contar('a retirar'), entregues: contar('entregue') },
    cortado: foiCortado(rows, f),
  };
}

// --------------------------------- 10, 13, 14. portaria (entradas e leituras)
const SQL_CHECKINS = `
  SELECT ck.registrado_em AS em, i.codigo_curto, c.nome AS tipo, pa.nome AS titular, o.nome AS operador,
         ck.escopo, ck.resultado, ck.motivo, ck.aparelho, ck.lido_no_aparelho_em
    FROM checkins ck JOIN ingressos i ON i.id = ck.ingresso_id
    JOIN categorias c ON c.id = i.categoria_id JOIN participantes pa ON pa.id = i.participante_id
    JOIN operadores o ON o.id = ck.operador_id
   WHERE ck.edicao_id = $1`;
const MOTIVO = {
  ja_utilizado: 'já utilizado',
  cancelado: 'cancelado',
  bloqueado: 'bloqueado',
  outra_edicao: 'de outra edição',
  invalido: 'inválido',
};

// 13. Histórico de validações: toda leitura registrada (aceita ou recusada).
async function validacoes(edicaoId, f) {
  const params = [edicaoId];
  const extra = condicoes(
    { operador: f.operador, tipo: f.tipo, resultado: f.resultado, de: f.de, ate: f.ate },
    {
      operador: 'ck.operador_id',
      tipo: 'i.categoria_id',
      resultado: 'ck.resultado',
      de: 'ck.registrado_em',
      ate: 'ck.registrado_em',
    },
    params,
  );
  const { rows } = await consultar(
    `${SQL_CHECKINS}${extra} ORDER BY ck.registrado_em DESC, ck.id DESC${limiteSql(f)}`,
    params,
  );
  const linhas = cortar(rows, f).map((r) => ({
    ...r,
    escopo: r.escopo === 'beneficio' ? 'benefício' : 'entrada',
    motivo: r.motivo ? MOTIVO[r.motivo] || r.motivo : '',
    modo: r.lido_no_aparelho_em ? 'sem conexão (sincronizado)' : 'com conexão',
  }));
  return {
    colunas: [
      col('em', 'Quando', 'data'),
      col('codigo_curto', 'Ingresso'),
      col('tipo', 'Tipo'),
      col('titular', 'Titular'),
      col('operador', 'Operador'),
      col('escopo', 'O quê'),
      col('resultado', 'Resultado'),
      col('motivo', 'Motivo'),
      col('modo', 'Modo'),
      col('aparelho', 'Aparelho'),
    ],
    linhas,
    totais: {
      total: linhas.length,
      aceitas: linhas.filter((l) => l.resultado === 'aceito').length,
      recusadas: linhas.filter((l) => l.resultado === 'recusado').length,
    },
    cortado: foiCortado(rows, f),
  };
}

// 10. Ingressos utilizados: a entrada aceita de cada ingresso (uma só, pelo banco).
async function utilizados(edicaoId, f) {
  const r = await validacoes(edicaoId, { ...f, resultado: 'aceito' });
  const linhas = r.linhas.filter((l) => l.escopo === 'entrada').map(({ escopo, resultado, motivo, ...resto }) => resto);
  return {
    colunas: r.colunas.filter((c) => !['escopo', 'resultado', 'motivo'].includes(c.id)),
    linhas,
    totais: { total: linhas.length },
    cortado: r.cortado,
  };
}

// 14. Tentativas duplicadas: leituras recusadas por "já utilizado", com a
// primeira entrada (quem validou e quando) ao lado.
async function duplicadas(edicaoId, f) {
  const params = [edicaoId];
  const extra = condicoes(
    { operador: f.operador, tipo: f.tipo, de: f.de, ate: f.ate },
    { operador: 'ck.operador_id', tipo: 'i.categoria_id', de: 'ck.registrado_em', ate: 'ck.registrado_em' },
    params,
  );
  const { rows } = await consultar(
    `SELECT ck.registrado_em AS em, i.codigo_curto, c.nome AS tipo, pa.nome AS titular, o.nome AS operador,
            ck.aparelho, pe.registrado_em AS primeira_entrada_em, po.nome AS primeira_entrada_por
       FROM checkins ck JOIN ingressos i ON i.id = ck.ingresso_id
       JOIN categorias c ON c.id = i.categoria_id JOIN participantes pa ON pa.id = i.participante_id
       JOIN operadores o ON o.id = ck.operador_id
       LEFT JOIN checkins pe ON pe.ingresso_id = ck.ingresso_id AND pe.escopo = 'entrada' AND pe.resultado = 'aceito'
       LEFT JOIN operadores po ON po.id = pe.operador_id
      WHERE ck.edicao_id = $1 AND ck.resultado = 'recusado' AND ck.motivo = 'ja_utilizado'${extra}
      ORDER BY ck.registrado_em DESC, ck.id DESC${limiteSql(f)}`,
    params,
  );
  const linhas = cortar(rows, f);
  return {
    colunas: [
      col('em', 'Tentativa em', 'data'),
      col('codigo_curto', 'Ingresso'),
      col('tipo', 'Tipo'),
      col('titular', 'Titular'),
      col('operador', 'Operador da tentativa'),
      col('aparelho', 'Aparelho'),
      col('primeira_entrada_em', '1ª entrada em', 'data'),
      col('primeira_entrada_por', '1ª entrada por'),
    ],
    linhas,
    totais: { total: linhas.length, ingressos: new Set(linhas.map((l) => l.codigo_curto)).size },
    cortado: foiCortado(rows, f),
  };
}

// ----------------------------------------------- 5. clientes indicados
async function indicados(edicaoId, f) {
  const params = [edicaoId];
  const extra = condicoes({ de: f.de, ate: f.ate }, { de: 'p.pago_em', ate: 'p.pago_em' }, params);
  const { rows } = await consultar(
    `SELECT COALESCE(icl.nome, o.nome, '(conta apagada)') AS indicador,
            CASE WHEN ind.operador_id IS NOT NULL THEN 'operador' ELSE 'comprador' END AS categoria,
            COALESCE(cl.nome, '(conta apagada)') AS indicado,
            count(DISTINCT p.id)::int AS compras,
            count(i.id) FILTER (WHERE ${INGRESSO_DE_PE})::int AS ingressos,
            min(p.pago_em) AS primeira_compra_em
       FROM pedidos p JOIN indicadores ind ON ind.id = p.indicador_id
       LEFT JOIN clientes icl ON icl.id = ind.cliente_id LEFT JOIN operadores o ON o.id = ind.operador_id
       LEFT JOIN clientes cl ON cl.id = p.cliente_id
       LEFT JOIN ingressos i ON i.pedido_id = p.id
      WHERE p.edicao_id = $1 AND p.origem = 'venda' AND p.status = 'pago'${extra}
      GROUP BY ind.id, icl.nome, o.nome, p.cliente_id, cl.nome
     HAVING count(i.id) FILTER (WHERE ${INGRESSO_DE_PE}) > 0
      ORDER BY indicador, primeira_compra_em`,
    params,
  );
  return {
    colunas: [
      col('indicador', 'Quem indicou'),
      col('categoria', 'Categoria'),
      col('indicado', 'Indicado'),
      col('compras', 'Compras confirmadas', 'numero'),
      col('ingressos', 'Ingressos', 'numero'),
      col('primeira_compra_em', '1ª compra em', 'data'),
    ],
    linhas: rows,
    totais: somar(rows, ['compras', 'ingressos']),
  };
}

// ------------------------------------------- 1 e 15. promoters (RN-T49)
// Mesmas definições do livro de comissões (promoters.js): venda de pé =
// venda sem estorno; situação derivada na leitura (provisória abaixo de 10
// de pé na edição, retida com ingresso bloqueado, paga, estornada).
const SQL_PROMOTER_DE_PE = `
  (SELECT count(*)::int FROM promoter_comissoes x
    WHERE x.promoter_id = c.promoter_id AND x.edicao_id = c.edicao_id AND x.tipo = 'venda'
      AND NOT EXISTS (SELECT 1 FROM promoter_comissoes e2 WHERE e2.origem_id = x.id))`;

const ROTULO_SITUACAO_VENDA = {
  provisoria: 'provisória',
  confirmada: 'confirmada',
  retida: 'retida (ingresso bloqueado)',
  paga: 'paga',
  estornada: 'estornada',
  estornada_apos_pagamento: 'estornada após o pagamento',
};

async function comissoesDaEdicao(edicaoId, f) {
  const params = [edicaoId];
  const extra = condicoes({ de: f.de, ate: f.ate }, { de: 'c.registrado_em', ate: 'c.registrado_em' }, params);
  const { rows } = await consultar(
    `SELECT c.id, c.promoter_id, cl.nome AS promoter, upper(left(c.pedido_id::text, 8)) AS pedido, i.codigo_curto,
            cat.nome AS tipo, l.ordem AS lote, c.venda_numero, c.valor_bruto_pedido_centavos, c.taxas_centavos,
            c.base_centavos, c.percentual, c.comissao_centavos, c.registrado_em, i.status AS ingresso_status,
            e.id AS estorno_id, pi.pagamento_id, ${SQL_PROMOTER_DE_PE} AS de_pe
       FROM promoter_comissoes c
       JOIN promoters pr ON pr.id = c.promoter_id JOIN clientes cl ON cl.id = pr.cliente_id
       JOIN ingressos i ON i.id = c.ingresso_id JOIN categorias cat ON cat.id = i.categoria_id
       LEFT JOIN lotes l ON l.id = i.lote_id
       LEFT JOIN promoter_comissoes e ON e.origem_id = c.id
       LEFT JOIN promoter_pagamento_itens pi ON pi.comissao_id = c.id
      WHERE c.edicao_id = $1 AND c.tipo = 'venda'${extra}
      ORDER BY cl.nome, c.promoter_id, c.venda_numero, c.id${limiteSql(f)}`,
    params,
  );
  const { situacaoDaVenda } = require('./promoters');
  return { rows, situacao: (r) => situacaoDaVenda(r, r.de_pe) };
}

// 15. Comissões de promoters: o livro, venda a venda.
async function comissoes(edicaoId, f) {
  const { rows, situacao } = await comissoesDaEdicao(edicaoId, f);
  const linhas = cortar(rows, f).map((r) => ({
    promoter: r.promoter,
    pedido: r.pedido,
    codigo_curto: r.codigo_curto,
    tipo: r.tipo,
    lote: r.lote ? `${r.lote}º lote` : '—',
    venda_numero: r.venda_numero,
    valor_bruto_pedido_centavos: r.valor_bruto_pedido_centavos,
    // Taxa que o Checkout não informou fica "—" (regra 4), nunca zero inventado.
    taxas: r.taxas_centavos === null ? '—' : (Number(r.taxas_centavos) / 100).toFixed(2).replace('.', ','),
    base_centavos: r.base_centavos,
    percentual: `${Number(r.percentual)}%`,
    comissao_centavos: r.comissao_centavos,
    situacao: ROTULO_SITUACAO_VENDA[situacao(r)],
    registrado_em: r.registrado_em,
    _situacao: situacao(r),
  }));
  const soma = (s) =>
    linhas.filter((l) => s.includes(l._situacao)).reduce((t, l) => t + Number(l.comissao_centavos), 0);
  return {
    colunas: [
      col('promoter', 'Promoter'),
      col('pedido', 'Pedido'),
      col('codigo_curto', 'Ingresso'),
      col('tipo', 'Tipo'),
      col('lote', 'Lote'),
      col('venda_numero', 'Venda nº', 'numero'),
      col('valor_bruto_pedido_centavos', 'Valor bruto do pedido', 'moeda'),
      col('taxas', 'Taxas'),
      col('base_centavos', 'Base da comissão', 'moeda'),
      col('percentual', 'Percentual'),
      col('comissao_centavos', 'Comissão', 'moeda'),
      col('situacao', 'Situação'),
      col('registrado_em', 'Registrada em', 'data'),
    ],
    linhas: linhas.map(({ _situacao, ...l }) => l),
    totais: {
      vendas: linhas.length,
      provisoria_centavos: soma(['provisoria']),
      confirmada_centavos: soma(['confirmada']),
      paga_centavos: soma(['paga']),
      estornada_centavos: soma(['estornada', 'estornada_apos_pagamento']),
    },
    cortado: foiCortado(rows, f),
  };
}

// 1. Vendas por promoter: um por linha, com a faixa e as comissões.
async function vendasPorPromoter(edicaoId, f) {
  const { rows, situacao } = await comissoesDaEdicao(edicaoId, { ...f, limite: null });
  const { percentualDaVenda, META } = require('./promoters');
  const por = new Map();
  for (const r of rows) {
    const k = String(r.promoter_id);
    if (!por.has(k))
      por.set(k, {
        promoter: r.promoter,
        vendas: 0,
        receita_centavos: 0,
        provisoria_centavos: 0,
        confirmada_centavos: 0,
        paga_centavos: 0,
        estornada_centavos: 0,
        de_pe: r.de_pe,
      });
    const x = por.get(k);
    const s = situacao(r);
    if (!s.startsWith('estornada')) {
      x.vendas += 1;
      x.receita_centavos += Number(r.base_centavos);
    }
    const campo = s.startsWith('estornada') ? 'estornada_centavos' : s === 'retida' ? null : `${s}_centavos`;
    if (campo) x[campo] += Number(r.comissao_centavos);
  }
  const linhas = [...por.values()]
    .map(({ de_pe, ...x }) => ({
      ...x,
      situacao: de_pe >= META ? 'oficial' : 'provisório',
      percentual_atual: de_pe >= 1 ? `${percentualDaVenda(de_pe)}%` : '—',
    }))
    .sort((a, b) => b.vendas - a.vendas || a.promoter.localeCompare(b.promoter));
  return {
    colunas: [
      col('promoter', 'Promoter'),
      col('situacao', 'Na edição'),
      col('vendas', 'Vendas de pé', 'numero'),
      col('receita_centavos', 'Receita (base)', 'moeda'),
      col('percentual_atual', 'Percentual atual'),
      col('provisoria_centavos', 'Comissão provisória', 'moeda'),
      col('confirmada_centavos', 'Comissão confirmada', 'moeda'),
      col('paga_centavos', 'Comissão paga', 'moeda'),
      col('estornada_centavos', 'Comissão estornada', 'moeda'),
    ],
    linhas,
    totais: somar(linhas, [
      'vendas',
      'receita_centavos',
      'provisoria_centavos',
      'confirmada_centavos',
      'paga_centavos',
    ]),
  };
}

function somar(linhas, campos) {
  const t = {};
  for (const c of campos) t[c] = linhas.reduce((s, l) => s + Number(l[c] || 0), 0);
  return t;
}

// Catálogo: o número do §8, o nome e a função. 4 (ranking de indicação) já
// existe em Indicações; 1 e 15 dependem do módulo de Promoters.
const RELATORIOS = {
  'vendas-promoter': { n: 1, nome: 'Vendas por promoter', fn: vendasPorPromoter, filtros: ['periodo'] },
  'vendas-lote': { n: 2, nome: 'Vendas por lote', fn: vendasPorLote, filtros: ['tipo', 'lote', 'periodo'] },
  'vendas-tipo': { n: 3, nome: 'Vendas por tipo de ingresso', fn: vendasPorTipo, filtros: ['tipo', 'periodo'] },
  indicados: { n: 5, nome: 'Clientes indicados', fn: indicados, filtros: ['periodo'] },
  campanhas: { n: 6, nome: 'Campanhas com maior conversão', fn: campanhasConversao, filtros: [] },
  'recompensas-concedidas': {
    n: 7,
    nome: 'Recompensas concedidas',
    fn: (e, f) => recompensas(e, { ...f, situacao: 'todas' }),
    filtros: ['periodo'],
  },
  'recompensas-entregues': {
    n: 8,
    nome: 'Recompensas entregues',
    fn: (e, f) => recompensas(e, { ...f, situacao: 'entregues' }),
    filtros: ['periodo'],
  },
  'recompensas-pendentes': {
    n: 9,
    nome: 'Recompensas pendentes',
    fn: (e, f) => recompensas(e, { ...f, situacao: 'pendentes' }),
    filtros: ['periodo'],
  },
  utilizados: { n: 10, nome: 'Ingressos utilizados', fn: utilizados, filtros: ['tipo', 'operador', 'periodo'] },
  disponiveis: { n: 11, nome: 'Ingressos disponíveis', fn: disponiveis, filtros: ['tipo', 'lote'] },
  combos: { n: 12, nome: 'Combos vendidos', fn: combos, filtros: ['periodo'] },
  validacoes: {
    n: 13,
    nome: 'Histórico de validações',
    fn: validacoes,
    filtros: ['tipo', 'operador', 'resultado', 'periodo'],
  },
  duplicadas: { n: 14, nome: 'Tentativas duplicadas', fn: duplicadas, filtros: ['tipo', 'operador', 'periodo'] },
  'comissoes-promoter': { n: 15, nome: 'Comissões de promoters', fn: comissoes, filtros: ['periodo'] },
};

async function gerar(edicaoId, nome, query, { semLimite = false, limite = LIMITE } = {}) {
  const r = Object.hasOwn(RELATORIOS, nome) ? RELATORIOS[nome] : null;
  if (!r) throw erro(404, 'relatório não encontrado');
  const { rows } = await consultar('SELECT id FROM edicoes WHERE id = $1', [edicaoId]);
  if (!rows[0]) throw erro(404, 'edição não encontrada');
  const filtros = { ...lerFiltros(query), limite: semLimite ? null : limite };
  const dados = await r.fn(Number(edicaoId), filtros);
  return { relatorio: nome, numero: r.n, titulo: r.nome, filtros_aceitos: r.filtros, ...dados };
}

function celula(valor) {
  let t = valor instanceof Date ? valor.toISOString() : String(valor ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

// CSV: ; como separador, BOM, valores em reais com vírgula, datas ISO.
function paraCsv(dados) {
  const fmt = (c, v) => (c.tipo === 'moeda' ? (Number(v || 0) / 100).toFixed(2).replace('.', ',') : v);
  const linhas = [dados.colunas.map((c) => celula(c.rotulo)).join(';')];
  for (const l of dados.linhas) linhas.push(dados.colunas.map((c) => celula(fmt(c, l[c.id]))).join(';'));
  return `﻿${linhas.join('\r\n')}\r\n`;
}

function catalogo() {
  return Object.entries(RELATORIOS)
    .map(([id, r]) => ({ id, numero: r.n, nome: r.nome, filtros: r.filtros }))
    .sort((a, b) => a.numero - b.numero);
}

module.exports = { gerar, paraCsv, catalogo, RELATORIOS };
