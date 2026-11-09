const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');
const { conteudoDoQr, qrPng, qrSvg } = require('./lib/qr');
const { novoAcesso } = require('./pedidos');
const config = require('./config');

// Participantes (T4; RN-T22), resumo da edição (D1) e avisos que pedem ação
// do Admin. Teste nunca entra em venda nem receita; cortesia nunca é receita.

const POR_PAGINA = 50;
const FILTROS = {
  todos: "i.status <> 'cancelado'",
  pagos: "i.origem = 'pago' AND p.origem = 'venda' AND i.status <> 'cancelado'",
  cortesias: "i.origem = 'cortesia' AND i.status <> 'cancelado'",
  testes: "p.origem = 'teste'",
  cancelados: "i.status = 'cancelado'",
  utilizados: 'ck.id IS NOT NULL',
};

const escaparLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

// CPF na lista do Admin só com os 6 do meio (padrão de mascaramento usual):
// a busca por CPF continua pelo número inteiro, no servidor.
const mascararCpf = (c) => (c && c.length === 11 ? `***.${c.slice(3, 6)}.${c.slice(6, 9)}-**` : null);

async function listar(edicaoId, { filtro = 'todos', busca = '', categoria = null, pagina = 1 } = {}) {
  if (!FILTROS[filtro]) throw erro(400, 'filtro inválido');
  const params = [edicaoId];
  const where = ['i.edicao_id = $1', FILTROS[filtro]];
  const termo = String(busca || '')
    .trim()
    .slice(0, 120);
  if (termo) {
    const digitos = termo.replace(/\D/g, '');
    params.push(`%${escaparLike(termo)}%`);
    const t = `$${params.length}`;
    const ou = [`pa.nome ILIKE ${t}`, `pa.email ILIKE ${t}`, `i.codigo_curto ILIKE ${t}`, `p.id::text ILIKE ${t}`];
    if (digitos.length >= 3) {
      params.push(`%${digitos}%`);
      ou.push(`pa.cpf LIKE $${params.length}`);
    }
    where.push(`(${ou.join(' OR ')})`);
  }
  if (categoria) {
    params.push(v.id(categoria, 'ingresso'));
    where.push(`i.categoria_id = $${params.length}`);
  }
  const pag = Math.max(1, Math.min(10000, Number(pagina) || 1));
  const base = `FROM ingressos i
      JOIN participantes pa ON pa.id = i.participante_id
      JOIN categorias c ON c.id = i.categoria_id
      LEFT JOIN pedidos p ON p.id = i.pedido_id
      LEFT JOIN promocoes pr ON pr.id = i.promocao_id
      LEFT JOIN cortesias co ON co.id = i.cortesia_id
      LEFT JOIN checkins ck ON ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito'
      LEFT JOIN operadores op ON op.id = ck.operador_id
     WHERE ${where.join(' AND ')}`;
  const [{ rows: itens }, { rows: total }] = await Promise.all([
    consultar(
      `SELECT i.id, i.codigo_curto, i.origem, i.status, i.motivo_status, i.valor_centavos, i.emitido_em,
              pa.nome, pa.cpf, pa.email, c.nome AS categoria, pr.nome AS promocao,
              p.id AS pedido_id, p.status AS pedido_status, p.origem AS pedido_origem, co.classificacao,
              ck.registrado_em AS checkin_em, op.nome AS checkin_operador,
              COALESCE((SELECT json_agg(ib.nome ORDER BY ib.nome) FROM ingresso_beneficios ib WHERE ib.ingresso_id = i.id), '[]') AS beneficios
         ${base}
        ORDER BY i.emitido_em DESC, i.id DESC
        LIMIT ${POR_PAGINA} OFFSET ${(pag - 1) * POR_PAGINA}`,
      params,
    ),
    consultar(`SELECT count(*)::int AS n ${base}`, params),
  ]);
  return {
    itens: itens.map((r) => ({
      id: r.id,
      codigo_curto: r.codigo_curto,
      nome: r.nome,
      cpf: mascararCpf(r.cpf),
      email: r.email,
      categoria: r.categoria,
      promocao: r.promocao,
      pedido: r.pedido_id
        ? { id: r.pedido_id, codigo: r.pedido_id.slice(0, 8).toUpperCase(), status: r.pedido_status }
        : null,
      origem: r.origem,
      teste: r.pedido_origem === 'teste',
      classificacao: r.classificacao,
      pagamento:
        r.origem === 'cortesia'
          ? 'cortesia'
          : r.pedido_origem === 'teste'
            ? 'teste'
            : r.pedido_status === 'estornado'
              ? 'reembolsado'
              : 'confirmado',
      valor_centavos: r.valor_centavos,
      beneficios: r.beneficios,
      status: r.status,
      motivo_status: r.motivo_status,
      checkin: r.checkin_em ? { em: r.checkin_em, operador: r.checkin_operador } : null,
      emitido_em: r.emitido_em,
    })),
    total: total[0].n,
    pagina: pag,
    por_pagina: POR_PAGINA,
  };
}

// D1: pagos, cortesias, participantes, receita confirmada, cancelamentos,
// reembolsos e chargebacks — pedido de teste fora de tudo.
async function resumo(edicaoId) {
  const [{ rows: ing }, { rows: rec }, { rows: cb }] = await Promise.all([
    consultar(
      `SELECT count(*) FILTER (WHERE i.origem = 'pago' AND i.status <> 'cancelado')::int AS pagos,
              count(*) FILTER (WHERE i.origem = 'cortesia' AND i.status <> 'cancelado')::int AS cortesias,
              count(*) FILTER (WHERE i.status <> 'cancelado')::int AS participantes,
              count(*) FILTER (WHERE i.status = 'cancelado')::int AS cancelados,
              count(*) FILTER (WHERE i.status = 'bloqueado')::int AS bloqueados,
              count(ck.id)::int AS entradas
         FROM ingressos i LEFT JOIN pedidos p ON p.id = i.pedido_id
         LEFT JOIN checkins ck ON ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito'
        WHERE i.edicao_id = $1 AND (p.id IS NULL OR p.origem = 'venda')`,
      [edicaoId],
    ),
    consultar(
      `SELECT COALESCE(sum(p.total_centavos) FILTER (WHERE p.status IN ('pago', 'estornado', 'pago_sem_vaga')), 0)::bigint AS bruta,
              COALESCE((SELECT sum(r.valor_centavos) FROM reembolsos r JOIN pedidos p2 ON p2.id = r.pedido_id
                         WHERE p2.edicao_id = $1 AND p2.origem = 'venda' AND r.status = 'confirmado'), 0)::bigint AS reembolsado,
              (SELECT count(*) FROM reembolsos r JOIN pedidos p2 ON p2.id = r.pedido_id
                WHERE p2.edicao_id = $1 AND p2.origem = 'venda' AND r.status = 'confirmado')::int AS reembolsos,
              count(*) FILTER (WHERE p.status = 'pago')::int AS pedidos_pagos
         FROM pedidos p WHERE p.edicao_id = $1 AND p.origem = 'venda'`,
      [edicaoId],
    ),
    consultar(
      `SELECT count(DISTINCT i.pedido_id)::int AS n FROM ingresso_historico h
         JOIN ingressos i ON i.id = h.ingresso_id JOIN pedidos p ON p.id = i.pedido_id
        WHERE h.tipo = 'chargeback' AND i.edicao_id = $1 AND p.origem = 'venda'`,
      [edicaoId],
    ),
  ]);
  const bruta = Number(rec[0].bruta);
  const reembolsado = Number(rec[0].reembolsado);
  return {
    ingressos_pagos: ing[0].pagos,
    cortesias: ing[0].cortesias,
    participantes: ing[0].participantes,
    entradas: ing[0].entradas,
    cancelados: ing[0].cancelados,
    bloqueados: ing[0].bloqueados,
    pedidos_pagos: rec[0].pedidos_pagos,
    receita_confirmada_centavos: bruta,
    reembolsado_centavos: reembolsado,
    receita_liquida_centavos: bruta - reembolsado,
    reembolsos: rec[0].reembolsos,
    chargebacks: cb[0].n,
  };
}

const TEXTO_AVISO = {
  sem_vaga: 'Pagamento chegou depois da reserva e não havia mais vaga — devolva o pedido.',
  valor_divergente: 'Pagamento com valor diferente do pedido — confira no Checkout.',
  pagamento_duplicado: 'Pedido pago duas vezes — devolva uma das cobranças.',
  parcial_sem_pedido: 'Devolução parcial feita fora do Admin — confira o pedido.',
  morto: 'Aviso de pagamento que não deu para aplicar — confira no Checkout.',
  reembolso_falhou: 'Reembolso que o Checkout recusou.',
  reembolso_reenviar: 'Reembolso que não chegou ao Checkout — reenvie.',
  chargeback: 'Contestação no banco (chargeback): ingressos bloqueados.',
};

async function avisos(edicaoId) {
  const [{ rows: ev }, { rows: sv }, { rows: re }, { rows: cb }] = await Promise.all([
    consultar(
      `SELECT DISTINCT ON (pe.pedido_id, COALESCE(pe.resultado, pe.processamento)) pe.pedido_id,
              CASE WHEN pe.processamento = 'morto' THEN 'morto' ELSE pe.resultado END AS tipo, pe.recebido_em
         FROM pagamento_eventos pe JOIN pedidos p ON p.id = pe.pedido_id
        WHERE p.edicao_id = $1 AND (pe.processamento = 'morto' OR pe.resultado IN ('valor_divergente', 'pagamento_duplicado', 'parcial_sem_pedido'))`,
      [edicaoId],
    ),
    consultar(
      "SELECT id AS pedido_id, pago_em AS recebido_em FROM pedidos WHERE edicao_id = $1 AND status = 'pago_sem_vaga'",
      [edicaoId],
    ),
    consultar(
      `SELECT r.id, r.pedido_id, r.status, r.ultimo_erro, r.atualizado_em AS recebido_em FROM reembolsos r JOIN pedidos p ON p.id = r.pedido_id
        WHERE p.edicao_id = $1 AND (r.status = 'falhou' OR (r.status = 'solicitado' AND r.ultimo_erro IS NOT NULL))`,
      [edicaoId],
    ),
    consultar(
      `SELECT DISTINCT i.pedido_id, max(h.ocorrido_em) AS recebido_em FROM ingresso_historico h JOIN ingressos i ON i.id = h.ingresso_id
        WHERE h.tipo = 'chargeback' AND i.edicao_id = $1 AND i.status = 'bloqueado' GROUP BY i.pedido_id`,
      [edicaoId],
    ),
  ]);
  const lista = [
    ...ev.map((x) => ({ tipo: x.tipo, pedido_id: x.pedido_id, desde: x.recebido_em })),
    ...sv.map((x) => ({ tipo: 'sem_vaga', pedido_id: x.pedido_id, desde: x.recebido_em })),
    ...re.map((x) => ({
      tipo: x.status === 'falhou' ? 'reembolso_falhou' : 'reembolso_reenviar',
      pedido_id: x.pedido_id,
      reembolso_id: x.id,
      desde: x.recebido_em,
    })),
    ...cb.map((x) => ({ tipo: 'chargeback', pedido_id: x.pedido_id, desde: x.recebido_em })),
  ];
  return lista.map((a) => ({
    ...a,
    pedido_codigo: a.pedido_id?.slice(0, 8).toUpperCase(),
    texto: TEXTO_AVISO[a.tipo],
  }));
}

// QR de um ingresso para o Admin (Ver QR / Baixar QR). Cancelado não tem QR.
async function qrDoIngresso(ingressoId, formato = 'png') {
  const { rows } = await consultar(
    'SELECT i.codigo, i.status, ed.codigo_publico FROM ingressos i JOIN edicoes ed ON ed.id = i.edicao_id WHERE i.id = $1',
    [ingressoId],
  );
  const i = rows[0];
  if (!i) throw erro(404, 'ingresso não encontrado');
  if (i.status === 'cancelado') throw erro(409, 'Ingresso cancelado não tem QR válido.');
  const conteudo = conteudoDoQr(i.codigo_publico, i.codigo);
  return formato === 'svg'
    ? { tipo: 'image/svg+xml', corpo: await qrSvg(conteudo) }
    : { tipo: 'image/png', corpo: await qrPng(conteudo) };
}

// Link novo da página do pedido, para o suporte entregar ao comprador
// quando o e-mail não chegou (o token antigo continua valendo).
async function linkDoPedido(pedidoId, autor) {
  const id = v.uuid(pedidoId);
  if (!id) throw erro(404, 'pedido não encontrado');
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT id FROM pedidos WHERE id = $1', [id]);
    if (!rows[0]) throw erro(404, 'pedido não encontrado');
    const tk = await novoAcesso(cliente, id, 'suporte');
    await auditar(cliente, autor, 'link_do_pedido', 'pedido', id, {});
    return { url: `${config.urlDoSite()}/ticket/pedido/${id}?t=${tk}` };
  });
}

// Pedido no Admin: itens, ingressos e reembolsos (para decidir devolução).
async function pedidoNoAdmin(pedidoId) {
  const id = v.uuid(pedidoId);
  if (!id) throw erro(404, 'pedido não encontrado');
  const { rows } = await consultar(
    `SELECT p.id, p.status, p.origem, p.total_centavos, p.criado_em, p.pago_em, p.metodo_pagamento, c.nome AS comprador, c.email
       FROM pedidos p JOIN compradores c ON c.id = p.comprador_id WHERE p.id = $1`,
    [id],
  );
  if (!rows[0]) throw erro(404, 'pedido não encontrado');
  const [{ rows: itens }, { rows: ingressos }, { rows: reembolsos }] = await Promise.all([
    consultar('SELECT descricao, quantidade, total_centavos FROM pedido_itens WHERE pedido_id = $1 ORDER BY ordem', [
      id,
    ]),
    consultar(
      `SELECT i.id, i.codigo_curto, i.status, i.valor_centavos, pa.nome, c.nome AS categoria
         FROM ingressos i JOIN participantes pa ON pa.id = i.participante_id JOIN categorias c ON c.id = i.categoria_id
        WHERE i.pedido_id = $1 ORDER BY i.id`,
      [id],
    ),
    consultar(
      'SELECT id, ingresso_id, valor_centavos, status, motivo, ultimo_erro, criado_em FROM reembolsos WHERE pedido_id = $1 ORDER BY id',
      [id],
    ),
  ]);
  return { ...rows[0], codigo: id.slice(0, 8).toUpperCase(), itens, ingressos, reembolsos };
}

module.exports = { listar, resumo, avisos, qrDoIngresso, linkDoPedido, pedidoNoAdmin, FILTROS };
