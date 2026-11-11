const { consultar, emTransacao } = require('./db/conexao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');
const { INGRESSO_DE_PE, linkDoCliente, linksDoOperador } = require('./indicacao');
const { mascararCpf } = require('./participantes');

// Desempenho das indicações (pedido do dono, 10/11/2026): quem trouxe cada
// pessoa, medido só por conversões confirmadas. Nada aqui grava conversão
// nem concede benefício — é leitura do que já está nos pedidos:
//   · conversão confirmada = pedido de venda PAGO, com indicador, e com ao
//     menos um ingresso de pé (INGRESSO_DE_PE); pendente, expirado,
//     cancelado, reembolsado ou contestado não conta;
//   · pessoa indicada = uma conta compradora (não importa quantos ingressos
//     comprou); ingressos vendidos por indicação = os ingressos de pé desses
//     pedidos. Quatro ingressos de uma pessoa = 1 pessoa, 4 ingressos.

const CONVERSOES = `
  SELECT p.id AS pedido_id, p.edicao_id, p.indicador_id, p.cliente_id, p.pago_em,
         (SELECT count(*)::int FROM ingressos i WHERE i.pedido_id = p.id AND ${INGRESSO_DE_PE}) AS ingressos
    FROM pedidos p
   WHERE p.origem = 'venda' AND p.status = 'pago' AND p.indicador_id IS NOT NULL`;

const TIPO = "CASE WHEN ind.operador_id IS NOT NULL THEN 'operador' ELSE 'comprador' END";
const NOME = "COALESCE(cl.nome, o.nome, '(conta apagada)')";

const situacaoDaConta = (c) =>
  c.anonimizado_em ? 'apagada' : c.email_confirmado_em ? 'ativa' : 'aguardando confirmação do e-mail';

// ------------------------------------------------------------------ ranking
// Por edição: comprador e operador, só conversões confirmadas.
async function ranking(edicaoId) {
  const { rows } = await consultar(
    `WITH conv AS (${CONVERSOES} AND p.edicao_id = $1)
     SELECT ind.id AS indicador_id, ${NOME} AS nome, ${TIPO} AS categoria,
            count(DISTINCT conv.cliente_id)::int AS pessoas, count(*)::int AS compras, sum(conv.ingressos)::int AS ingressos
       FROM conv JOIN indicadores ind ON ind.id = conv.indicador_id
       LEFT JOIN clientes cl ON cl.id = ind.cliente_id LEFT JOIN operadores o ON o.id = ind.operador_id
      WHERE conv.ingressos > 0
      GROUP BY ind.id, cl.nome, o.nome
      ORDER BY pessoas DESC, ingressos DESC, nome, ind.id`,
    [edicaoId],
  );
  return rows.map((r, n) => ({ posicao: n + 1, ...r }));
}

// CSV para premiações: nome, categoria e números. Sem CPF, e-mail, código
// nem id. Célula que começa com = + - @ ganha um apóstrofo (planilha não
// executa fórmula vinda do nome de alguém).
function celula(valor) {
  let t = String(valor ?? '');
  if (/^[=+\-@\t\r]/.test(t)) t = `'${t}`;
  return /[";\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

async function rankingCsv(edicaoId) {
  const linhas = await ranking(edicaoId);
  const cabecalho = [
    'posicao',
    'nome',
    'categoria',
    'pessoas_indicadas_com_compra',
    'compras_confirmadas',
    'ingressos_vendidos',
  ];
  const corpo = linhas.map((r) =>
    [r.posicao, r.nome, r.categoria, r.pessoas, r.compras, r.ingressos].map(celula).join(';'),
  );
  // BOM: o Excel em português abre com acento certo; `;` é o separador dele.
  return `﻿${[cabecalho.join(';'), ...corpo].join('\r\n')}\r\n`;
}

// ------------------------------------------------- pessoas indicadas
// Quem chegou pelo link de um indicador nesta edição (ou em todas, para o
// operador): com a compra e a situação dela. Inclui quem só registrou a
// origem e ainda não comprou — aparece como "sem compra", fora dos totais.
async function indicadosPor(indicadorId, edicaoId = null) {
  const { rows } = await consultar(
    `WITH alvo AS (
        SELECT cliente_id, edicao_id FROM indicacao_origens WHERE indicador_id = $1 AND ($2::bigint IS NULL OR edicao_id = $2)
        UNION
        SELECT cliente_id, edicao_id FROM pedidos
         WHERE indicador_id = $1 AND origem = 'venda' AND cliente_id IS NOT NULL AND ($2::bigint IS NULL OR edicao_id = $2)
      ), conv AS (${CONVERSOES} AND p.indicador_id = $1)
     SELECT a.cliente_id, a.edicao_id, cl.nome, cl.cpf, ev.nome || ' — ' || ed.nome AS edicao,
            (SELECT min(c.pago_em) FROM conv c WHERE c.cliente_id = a.cliente_id AND c.edicao_id = a.edicao_id AND c.ingressos > 0) AS convertido_em,
            (SELECT count(*)::int FROM conv c WHERE c.cliente_id = a.cliente_id AND c.edicao_id = a.edicao_id AND c.ingressos > 0) AS compras,
            COALESCE((SELECT sum(c.ingressos)::int FROM conv c WHERE c.cliente_id = a.cliente_id AND c.edicao_id = a.edicao_id), 0) AS ingressos,
            (SELECT p.status FROM pedidos p WHERE p.cliente_id = a.cliente_id AND p.edicao_id = a.edicao_id AND p.indicador_id = $1
               AND p.origem = 'venda' ORDER BY p.criado_em DESC LIMIT 1) AS ultimo_status,
            COALESCE((SELECT json_agg(DISTINCT cat.nome) FROM conv c JOIN ingressos i ON i.pedido_id = c.pedido_id AND ${INGRESSO_DE_PE}
                        JOIN categorias cat ON cat.id = i.categoria_id
                       WHERE c.cliente_id = a.cliente_id AND c.edicao_id = a.edicao_id), '[]') AS tipos
       FROM alvo a JOIN clientes cl ON cl.id = a.cliente_id
       JOIN edicoes ed ON ed.id = a.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      ORDER BY convertido_em DESC NULLS LAST, cl.nome`,
    [indicadorId, edicaoId],
  );
  const SITUACAO = {
    aguardando_pagamento: 'aguardando pagamento',
    pago: 'pago, sem ingresso válido',
    expirado: 'expirado',
    cancelado: 'cancelado',
    estornado: 'reembolsado',
    pago_sem_vaga: 'pago sem vaga (em devolução)',
  };
  const lista = rows.map((r) => ({
    cliente_id: r.cliente_id,
    edicao_id: r.edicao_id,
    edicao: r.edicao,
    nome: r.nome || '(conta apagada)',
    cpf: mascararCpf(r.cpf),
    tipos: r.tipos,
    situacao: r.compras > 0 ? 'compra confirmada' : r.ultimo_status ? SITUACAO[r.ultimo_status] : 'sem compra',
    confirmada: r.compras > 0,
    convertido_em: r.convertido_em,
    compras: r.compras,
    ingressos: r.compras > 0 ? r.ingressos : 0,
  }));
  const confirmados = lista.filter((x) => x.confirmada);
  return {
    totais: {
      // Uma pessoa por edição: quem comprou em dois eventos pelo mesmo link
      // conta nos dois (mesma regra da lista de operadores).
      pessoas: new Set(confirmados.map((x) => `${x.cliente_id}:${x.edicao_id}`)).size,
      compras: confirmados.reduce((t, x) => t + x.compras, 0),
      ingressos: confirmados.reduce((t, x) => t + x.ingressos, 0),
    },
    indicados: lista,
  };
}

// "Indique e acompanhe" (Minha conta): o funil do link de um indicador, em
// todas as edições. Três números que não se confundem:
//   · acessos únicos — navegadores diferentes que chegaram pelo link;
//   · contas criadas — desses navegadores, os que criaram conta DEPOIS da
//     primeira visita (a visita ganha a conta quando o navegador entra);
//   · compras confirmadas — pessoas (contas) com compra confirmada pela
//     indicação, as compras e os ingressos (a regra de sempre, acima).
// Só números: nada de quem visitou.
async function numerosDoIndicador(indicadorId) {
  const { rows } = await consultar(
    `SELECT count(*)::int AS acessos,
            count(DISTINCT v.cliente_id) FILTER (WHERE c.criado_em >= v.primeira_em - interval '1 minute')::int AS contas
       FROM indicacao_visitas v LEFT JOIN clientes c ON c.id = v.cliente_id
      WHERE v.indicador_id = $1`,
    [indicadorId],
  );
  const { totais } = await indicadosPor(indicadorId);
  return { acessos: rows[0].acessos, contas_criadas: rows[0].contas, ...totais };
}

// Área do operador na portaria (pedido do dono, 11/11/2026): o mesmo
// "Indique e acompanhe" da conta do cliente — os quatro números, o link
// permanente e os links por edição autorizada — e, só para o operador, a
// lista de quem ele indicou: nome, evento, situação e ingressos. Sem CPF,
// e-mail nem nada de quem só visitou o link.
async function indicacaoDoOperador(operadorId) {
  const andamento = await require('./indicacao').andamentoDoOperador(operadorId);
  if (!andamento) return null;
  const { rows } = await consultar('SELECT id FROM indicadores WHERE operador_id = $1', [operadorId]);
  const indicadorId = rows[0].id;
  const numeros = await numerosDoIndicador(indicadorId);
  const { indicados } = await indicadosPor(indicadorId);
  return {
    ...andamento,
    numeros,
    indicados: indicados.map((i) => ({
      nome: i.nome,
      edicao: i.edicao,
      situacao: i.situacao,
      confirmada: i.confirmada,
      ingressos: i.ingressos,
      tipos: i.tipos,
      convertido_em: i.convertido_em,
    })),
  };
}

// ---------------------------------------------- ficha do comprador
// Admin → Participantes → ficha: a conta, o que comprou nesta edição, quem
// indicou esta pessoa e quem ela indicou. CPF mascarado; o inteiro só pelo
// botão próprio, que fica na auditoria (cpfCompleto).
async function fichaDoComprador(edicaoId, clienteId) {
  const { rows: c } = await consultar(
    'SELECT id, nome, cpf, email, email_confirmado_em, anonimizado_em, criado_em FROM clientes WHERE id = $1',
    [clienteId],
  );
  const conta = c[0];
  if (!conta) throw erro(404, 'comprador não encontrado');
  const { rows: pedidos } = await consultar(
    `SELECT p.id, p.status, p.total_centavos, p.criado_em, p.pago_em, p.indicador_id,
            COALESCE((SELECT json_agg(json_build_object('id', i.id, 'codigo_curto', i.codigo_curto, 'categoria', cat.nome,
                        'status', i.status, 'participante', pa.nome, 'de_pe', ${INGRESSO_DE_PE},
                        'checkin_em', (SELECT ck.registrado_em FROM checkins ck WHERE ck.ingresso_id = i.id
                                         AND ck.escopo = 'entrada' AND ck.resultado = 'aceito'))
                        ORDER BY i.id)
                        FROM ingressos i JOIN categorias cat ON cat.id = i.categoria_id JOIN participantes pa ON pa.id = i.participante_id
                       WHERE i.pedido_id = p.id), '[]') AS ingressos
       FROM pedidos p WHERE p.cliente_id = $1 AND p.edicao_id = $2 AND p.origem = 'venda'
      ORDER BY p.criado_em DESC`,
    [clienteId, edicaoId],
  );
  if (!pedidos.length) throw erro(404, 'esta conta não tem pedido nesta edição');
  // Quem indicou: a origem registrada; sem ela, o indicador do pedido mais novo.
  const { rows: origem } = await consultar(
    'SELECT indicador_id FROM indicacao_origens WHERE cliente_id = $1 AND edicao_id = $2',
    [clienteId, edicaoId],
  );
  const indicadorDela = origem[0]?.indicador_id || pedidos.find((p) => p.indicador_id)?.indicador_id || null;
  let indicadoPor = null;
  if (indicadorDela) {
    const { rows } = await consultar(
      `SELECT ${NOME} AS nome, ${TIPO} AS tipo FROM indicadores ind
         LEFT JOIN clientes cl ON cl.id = ind.cliente_id LEFT JOIN operadores o ON o.id = ind.operador_id
        WHERE ind.id = $1`,
      [indicadorDela],
    );
    indicadoPor = rows[0] || null;
  }
  const link = conta.anonimizado_em ? null : await linkDoCliente(clienteId, edicaoId);
  const dela = link
    ? await indicadosPor(link.indicador_id, edicaoId)
    : { totais: { pessoas: 0, compras: 0, ingressos: 0 }, indicados: [] };
  const deP = pedidos.flatMap((p) => (p.status === 'pago' ? p.ingressos.filter((i) => i.de_pe) : []));
  const tipos = {};
  for (const i of deP) tipos[i.categoria] = (tipos[i.categoria] || 0) + 1;
  const pago = pedidos.some((p) => p.status === 'pago' && p.ingressos.some((i) => i.de_pe));
  return {
    comprador: {
      id: conta.id,
      nome: conta.nome || '(conta apagada)',
      cpf: mascararCpf(conta.cpf),
      email: conta.email,
      situacao_conta: situacaoDaConta(conta),
      cliente_desde: conta.criado_em,
    },
    compra: {
      ingressos: deP.length,
      tipos: Object.entries(tipos).map(([nome, quantidade]) => ({ nome, quantidade })),
      pagamento: pago ? 'confirmado' : pedidos[0].status,
      entradas: deP.filter((i) => i.checkin_em).length,
    },
    pedidos: pedidos.map((p) => ({
      id: p.id,
      codigo: p.id.slice(0, 8).toUpperCase(),
      status: p.status,
      total_centavos: p.total_centavos,
      criado_em: p.criado_em,
      pago_em: p.pago_em,
      ingressos: p.ingressos.map(({ de_pe, ...i }) => i),
    })),
    indicado_por: indicadoPor,
    link: link?.link || null,
    indicacoes: dela,
  };
}

// CPF inteiro só para o Admin, um de cada vez, e fica registrado quem viu.
async function cpfCompleto(clienteId, autor) {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT cpf FROM clientes WHERE id = $1 AND anonimizado_em IS NULL', [
      clienteId,
    ]);
    if (!rows[0]) throw erro(404, 'comprador não encontrado');
    await auditar(cliente, autor, 'cpf_consultado', 'cliente', clienteId, {});
    const c = rows[0].cpf;
    return { cpf: `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}` };
  });
}

// ------------------------------------------------------- operadores
// Números de cada operador (todas as edições) para a lista do Admin.
async function numerosDosOperadores() {
  const { rows } = await consultar(
    `WITH conv AS (${CONVERSOES})
     SELECT ind.operador_id, count(DISTINCT (conv.cliente_id, conv.edicao_id))::int AS pessoas,
            count(*)::int AS compras, sum(conv.ingressos)::int AS ingressos
       FROM conv JOIN indicadores ind ON ind.id = conv.indicador_id
      WHERE ind.operador_id IS NOT NULL AND conv.ingressos > 0
      GROUP BY ind.operador_id`,
  );
  return new Map(
    rows.map((r) => [Number(r.operador_id), { pessoas: r.pessoas, compras: r.compras, ingressos: r.ingressos }]),
  );
}

// Ficha do operador: links, totais, desempenho por edição e quem ele trouxe.
async function fichaDoOperador(operadorId) {
  const operadores = require('./operadores');
  const op = await operadores.obter(operadorId);
  const links = await linksDoOperador(operadorId);
  const { totais, indicados } = await indicadosPor(links.indicador_id);
  const { rows: porEdicao } = await consultar(
    `WITH conv AS (${CONVERSOES} AND p.indicador_id = $1)
     SELECT ev.nome || ' — ' || ed.nome AS edicao, conv.edicao_id,
            count(DISTINCT conv.cliente_id)::int AS pessoas, count(*)::int AS compras, sum(conv.ingressos)::int AS ingressos,
            min(conv.pago_em) AS primeira, max(conv.pago_em) AS ultima
       FROM conv JOIN edicoes ed ON ed.id = conv.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      WHERE conv.ingressos > 0
      GROUP BY conv.edicao_id, ev.nome, ed.nome, ed.inicio_em
      ORDER BY ed.inicio_em DESC NULLS LAST, conv.edicao_id DESC`,
    [links.indicador_id],
  );
  return {
    operador: op,
    codigo: links.codigo,
    links: links.links,
    totais,
    por_edicao: porEdicao,
    indicados,
  };
}

module.exports = {
  numerosDoIndicador,
  indicacaoDoOperador,
  ranking,
  rankingCsv,
  indicadosPor,
  fichaDoComprador,
  cpfCompleto,
  numerosDosOperadores,
  fichaDoOperador,
  celula,
};
