const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { historicoDoIngresso, medir } = require('./lib/registro');
const { emitirDoPedido } = require('./emissao');
const { carregarLotes, criarAlocador, ocupacaoDaEdicao } = require('./disponibilidade');
const config = require('./config');

// Avisos de pagamento (RN-T18; API.md §4.3). Todo fato chega por aqui —
// webhook assinado, conciliação ou o simulador de desenvolvimento — e só é
// aplicado uma vez: `pagamento_eventos.evento_id` é único (o eventoId do
// Checkout), e a emissão é idempotente por vaga. Ausência de aviso nunca
// significa "pago".

const reais = (x) => (x === null || x === undefined || x === '' ? null : Math.round(Number(x) * 100));
const MOTIVO_DESFEITO = 'pagamento desfeito no provedor';

async function registrarEvento({ eventoId, provedor, payload }) {
  const pedidoRef = typeof payload?.pedidoId === 'string' ? payload.pedidoId.slice(0, 128) : null;
  const pedidoUuid = v.uuid(pedidoRef);
  const { rows } = await consultar(
    `INSERT INTO pagamento_eventos (evento_id, provedor, pedido_ref, pedido_id, charge_id, status, payload, ocorrido_em)
     VALUES ($1, $2, $3, (SELECT id FROM pedidos WHERE id = $4::uuid), $5, $6, $7, $8)
     ON CONFLICT (evento_id) DO NOTHING RETURNING id`,
    [
      String(eventoId).slice(0, 160),
      provedor,
      pedidoRef,
      pedidoUuid,
      payload?.chargeId ? String(payload.chargeId).slice(0, 128) : null,
      String(payload?.status || 'desconhecido').slice(0, 60),
      payload,
      payload?.ocorridoEm && !Number.isNaN(new Date(payload.ocorridoEm).getTime())
        ? new Date(payload.ocorridoEm)
        : null,
    ],
  );
  return { novo: rows.length > 0 };
}

// O pedido ainda cabe no estoque? (pagamento que chegou com a reserva já
// vencida: confere por tipo de ingresso e na capacidade — nunca vende acima.)
async function aindaCabe(cliente, pedido) {
  const { rows: vagas } = await cliente.query(
    'SELECT categoria_id, count(*)::int AS n FROM reservas WHERE pedido_id = $1 GROUP BY categoria_id',
    [pedido.id],
  );
  const alocador = criarAlocador(
    await carregarLotes(
      cliente,
      vagas.map((x) => Number(x.categoria_id)),
    ),
  );
  for (const x of vagas) if (alocador.disponivel(x.categoria_id) < x.n) return false;
  const { rows: ed } = await cliente.query('SELECT capacidade FROM edicoes WHERE id = $1', [pedido.edicao_id]);
  if (ed[0].capacidade) {
    const total = vagas.reduce((s, x) => s + x.n, 0);
    if ((await ocupacaoDaEdicao(cliente, pedido.edicao_id)) + total > ed[0].capacidade) return false;
  }
  return true;
}

async function avisarComprador(cliente, pedido) {
  const { rows } = await cliente.query(
    `SELECT c.email, ev.nome AS evento, ed.nome AS edicao FROM pedidos p
       JOIN compradores c ON c.id = p.comprador_id JOIN edicoes ed ON ed.id = p.edicao_id
       JOIN eventos ev ON ev.id = ed.evento_id WHERE p.id = $1`,
    [pedido.id],
  );
  const d = rows[0];
  if (!d?.email) return;
  const tk = await require('./pedidos').novoAcesso(cliente, pedido.id, 'email');
  const link = `${config.urlDoSite()}/ticket/pedido/${pedido.id}?t=${tk}`;
  await require('./email').enfileirar(cliente, {
    chave: `pedido_confirmado:${pedido.id}`,
    tipo: 'pedido_confirmado',
    para: d.email,
    assunto: `Seus ingressos — ${d.evento} ${d.edicao}`,
    texto: `Pagamento confirmado.\n\nSeus ingressos de ${d.evento} — ${d.edicao} estão neste link:\n${link}\n\nCada ingresso tem o próprio QR Code. Guarde este link: ele dá acesso aos ingressos do pedido.`,
  });
}

async function confirmar(cliente, pedido, p) {
  if (pedido.status === 'pago') {
    if (p.chargeId && pedido.charge_id && p.chargeId !== pedido.charge_id) return 'pagamento_duplicado';
    // Baixa desfeita e refeita (`confirmado` → `pendente` → `confirmado`, API.md
    // §4.3.6): o ingresso bloqueado pelo `pendente` volta a valer. Bloqueio por
    // chargeback ou reembolso não sai por aqui — é decisão de gente.
    const voltaram = await mudarIngressos(cliente, pedido.id, {
      de: ['bloqueado'],
      para: 'valido',
      historico: 'desbloqueado',
      motivo: 'pagamento confirmado de novo pelo provedor',
      seMotivo: MOTIVO_DESFEITO,
    });
    return voltaram.length ? 'pagamento_refeito' : 'ja_aplicado';
  }
  if (!['aguardando_pagamento', 'expirado', 'cancelado'].includes(pedido.status)) return 'ignorado_status_final';
  if (reais(p.valorComDesconto) !== Number(pedido.total_centavos)) return 'valor_divergente';
  const reservaViva = pedido.status === 'aguardando_pagamento' && new Date(pedido.reserva_expira_em) > new Date();
  const dados = [pedido.id, p.chargeId || null, p.metodoPagamento || null, reais(p.valorCobrado)];
  if (!reservaViva && !(await aindaCabe(cliente, pedido))) {
    await cliente.query(
      `UPDATE pedidos SET status = 'pago_sem_vaga', pago_em = now(), charge_id = $2, metodo_pagamento = $3,
         valor_cobrado_centavos = $4 WHERE id = $1`,
      dados,
    );
    return 'sem_vaga';
  }
  await cliente.query(
    `UPDATE pedidos SET status = 'pago', pago_em = now(), encerrado_em = NULL, charge_id = $2, metodo_pagamento = $3,
       valor_cobrado_centavos = $4 WHERE id = $1`,
    dados,
  );
  pedido.status = 'pago';
  const emitidos = await emitirDoPedido(cliente, pedido, { autor: 'pagamento' });
  await medir(cliente, 'venda:pagamento_confirma', pedido.edicao_id, {
    pedido_id: pedido.id,
    total_centavos: Number(pedido.total_centavos),
    minutos_desde_criacao: Math.round((Date.now() - new Date(pedido.criado_em).getTime()) / 60000),
    metodo: p.metodoPagamento || null,
    teste: pedido.origem === 'teste',
  });
  await avisarComprador(cliente, pedido);
  return emitidos.length ? 'aplicado' : 'ja_aplicado';
}

// Muda o status dos ingressos do pedido e grava o histórico de cada um.
// `seMotivo`: só os que estão no status por ESTE motivo (ex.: não desbloquear
// um chargeback quando o que voltou foi a baixa desfeita).
async function mudarIngressos(cliente, pedidoId, { de, para, historico, motivo, ids = null, seMotivo = null }) {
  const { rows } = await cliente.query(
    `UPDATE ingressos SET status = $3, motivo_status = $4, atualizado_em = now()
      WHERE pedido_id = $1 AND status = ANY($2::text[]) AND ($5::bigint[] IS NULL OR id = ANY($5::bigint[]))
        AND ($6::text IS NULL OR motivo_status = $6)
      RETURNING id`,
    [pedidoId, de, para, para === 'valido' ? null : motivo, ids, seMotivo],
  );
  for (const r of rows) await historicoDoIngresso(cliente, r.id, historico, { motivo, autor: 'pagamento' });
  return rows.map((r) => r.id);
}

// Estorno total. O valor que conta para a receita é o do PEDIDO (o preço dos
// ingressos): `valorEstornado` do Checkout inclui as taxas que o comprador
// pagou por cima (API.md §4.3.3, `valorCobrado`), que não são receita daqui.
async function estornoTotal(cliente, pedido, ev) {
  if (!['pago', 'pago_sem_vaga'].includes(pedido.status)) return 'ignorado';
  await cliente.query("UPDATE pedidos SET status = 'estornado', encerrado_em = now() WHERE id = $1", [pedido.id]);
  await mudarIngressos(cliente, pedido.id, {
    de: ['valido', 'bloqueado'],
    para: 'cancelado',
    historico: 'reembolsado',
    motivo: 'pedido reembolsado',
  });
  await cliente.query(
    "UPDATE reembolsos SET status = 'confirmado', confirmado_em = now(), atualizado_em = now() WHERE pedido_id = $1 AND status = 'solicitado'",
    [pedido.id],
  );
  const { rows: soma } = await cliente.query(
    "SELECT COALESCE(sum(valor_centavos), 0)::bigint AS s FROM reembolsos WHERE pedido_id = $1 AND status = 'confirmado'",
    [pedido.id],
  );
  const falta = Number(pedido.total_centavos) - Number(soma[0].s);
  if (falta > 0) {
    // Devolução (ou parte dela) feita fora do Admin — painel do Checkout ou da
    // Asaas: fica registrada, com o que faltava do pedido.
    await cliente.query(
      `INSERT INTO reembolsos (pedido_id, valor_centavos, chave_idempotencia, motivo, status, solicitado_por, confirmado_em)
       VALUES ($1, $2, $3, 'devolução confirmada pelo provedor', 'confirmado', 'checkout', now())
       ON CONFLICT (chave_idempotencia) DO NOTHING`,
      [
        pedido.id,
        falta,
        `externo-${String(ev.evento_id)
          .replace(/[^A-Za-z0-9_-]/g, '')
          .slice(0, 100)}`,
      ],
    );
  }
  await medir(cliente, 'venda:reembolso_confirma', pedido.edicao_id, {
    pedido_id: pedido.id,
    valor_centavos: Number(pedido.total_centavos),
    parcial: false,
    teste: pedido.origem === 'teste',
  });
  return 'estornado';
}

async function estornoParcial(cliente, pedido, p) {
  if (pedido.status !== 'pago') return 'ignorado';
  const acumulado = reais(p.valorEstornado) || 0;
  const { rows: confirmados } = await cliente.query(
    "SELECT COALESCE(sum(valor_centavos), 0)::bigint AS s FROM reembolsos WHERE pedido_id = $1 AND status = 'confirmado'",
    [pedido.id],
  );
  let soma = Number(confirmados[0].s);
  // O mesmo estorno chega pela resposta do /estornar e depois pelo webhook:
  // o acumulado já está coberto pelo que foi confirmado → nada a fazer.
  if (acumulado <= soma) return 'ja_aplicado';
  const { rows: pendentes } = await cliente.query(
    "SELECT * FROM reembolsos WHERE pedido_id = $1 AND status = 'solicitado' ORDER BY criado_em, id",
    [pedido.id],
  );
  let aplicou = 0;
  for (const r of pendentes) {
    if (soma + Number(r.valor_centavos) > acumulado) break;
    soma += Number(r.valor_centavos);
    await cliente.query(
      "UPDATE reembolsos SET status = 'confirmado', confirmado_em = now(), atualizado_em = now() WHERE id = $1",
      [r.id],
    );
    if (r.ingresso_id) {
      await mudarIngressos(cliente, pedido.id, {
        de: ['valido', 'bloqueado'],
        para: 'cancelado',
        historico: 'reembolsado',
        motivo: 'ingresso reembolsado',
        ids: [r.ingresso_id],
      });
    }
    await medir(cliente, 'venda:reembolso_confirma', pedido.edicao_id, {
      pedido_id: pedido.id,
      valor_centavos: Number(r.valor_centavos),
      parcial: true,
      teste: pedido.origem === 'teste',
    });
    aplicou += 1;
  }
  // Sobrou valor devolvido sem reembolso pedido aqui: foi feito fora do Admin.
  if (soma < acumulado) return 'parcial_sem_pedido';
  return aplicou ? 'estornado_parcialmente' : 'ja_aplicado';
}

async function aplicar(cliente, ev) {
  const p = ev.payload || {};
  const pedidoId = v.uuid(p.pedidoId);
  if (!pedidoId) return 'pedido_desconhecido';
  const { rows: base } = await cliente.query('SELECT edicao_id FROM pedidos WHERE id = $1', [pedidoId]);
  if (!base[0]) return 'pedido_desconhecido';
  // Mesma ordem de trava do pedido novo e da cortesia: edição, depois pedido.
  await cliente.query('SELECT 1 FROM edicoes WHERE id = $1 FOR UPDATE', [base[0].edicao_id]);
  const { rows } = await cliente.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [pedidoId]);
  const pedido = rows[0];
  switch (p.status) {
    case 'confirmado':
      return confirmar(cliente, pedido, p);
    case 'em_analise':
      return 'aguardando_analise';
    case 'recusado':
    case 'vencido':
      // "Não será pago" vale para AQUELA cobrança (API.md §4.3.3). O pedido
      // segue aguardando até a reserva vencer: o comprador pode tentar outro
      // meio no mesmo link. Quem devolve a vaga é o vencimento da reserva.
      if (pedido.status !== 'aguardando_pagamento') return 'ignorado';
      await cliente.query('UPDATE pedidos SET pagamento_recusado_em = now() WHERE id = $1', [pedido.id]);
      return 'recusado_aguardando';
    case 'chargeback': {
      if (pedido.status !== 'pago') return 'ignorado';
      const ids = await mudarIngressos(cliente, pedido.id, {
        de: ['valido', 'bloqueado'],
        para: 'bloqueado',
        historico: 'chargeback',
        motivo: 'contestação no banco (chargeback)',
      });
      await medir(cliente, 'venda:chargeback', pedido.edicao_id, {
        pedido_id: pedido.id,
        ingressos: ids.length,
        teste: pedido.origem === 'teste',
      });
      return 'bloqueado_chargeback';
    }
    case 'estornado':
      return estornoTotal(cliente, pedido, ev);
    case 'estornado_parcialmente':
      return estornoParcial(cliente, pedido, p);
    case 'estorno_negado': {
      const { rows: negados } = await cliente.query(
        "UPDATE reembolsos SET status = 'negado', atualizado_em = now() WHERE pedido_id = $1 AND status = 'solicitado' RETURNING ingresso_id",
        [pedido.id],
      );
      if (!negados.length) return 'ignorado';
      const todos = negados.some((r) => !r.ingresso_id);
      await mudarIngressos(cliente, pedido.id, {
        de: ['bloqueado'],
        para: 'valido',
        historico: 'desbloqueado',
        motivo: 'reembolso negado pelo provedor',
        ids: todos ? null : negados.map((r) => r.ingresso_id),
        seMotivo: 'reembolso solicitado',
      });
      return 'estorno_negado';
    }
    case 'pendente':
      if (pedido.status !== 'pago') return 'ignorado';
      await mudarIngressos(cliente, pedido.id, {
        de: ['valido'],
        para: 'bloqueado',
        historico: 'bloqueado',
        motivo: MOTIVO_DESFEITO,
      });
      return 'bloqueado_pagamento_desfeito';
    default:
      return 'ignorado';
  }
}

const ESPERAS = [30, 120, 600, 1800, 7200];

// Processa a fila de avisos: um por vez, com SKIP LOCKED (várias instâncias
// não pegam o mesmo), novas tentativas com espera crescente e 'morto' depois
// de 6 falhas (aparece nos avisos do Admin).
async function processarFila(limite = 20) {
  let feitos = 0;
  for (; feitos < limite; feitos++) {
    const { rows } = await consultar(
      `UPDATE pagamento_eventos SET processamento = 'processando', tentativas = tentativas + 1,
              proxima_tentativa_em = now() + interval '5 minutes'
        WHERE id = (SELECT id FROM pagamento_eventos
                     WHERE processamento IN ('recebido', 'tentando_de_novo', 'processando') AND proxima_tentativa_em <= now()
                     ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING *`,
    );
    const ev = rows[0];
    if (!ev) break;
    try {
      const resultado = await emTransacao((cliente) => aplicar(cliente, ev));
      await consultar(
        `UPDATE pagamento_eventos SET processamento = 'processado', resultado = $2, processado_em = now(), ultimo_erro = NULL,
           pedido_id = COALESCE(pedido_id, (SELECT id FROM pedidos WHERE id = $3::uuid)) WHERE id = $1`,
        [ev.id, resultado, v.uuid(ev.pedido_ref)],
      );
    } catch (err) {
      const morto = ev.tentativas >= 6;
      await consultar(
        `UPDATE pagamento_eventos SET processamento = $2, ultimo_erro = $3,
           proxima_tentativa_em = now() + make_interval(secs => $4) WHERE id = $1`,
        [
          ev.id,
          morto ? 'morto' : 'tentando_de_novo',
          String(err.message).slice(0, 500),
          ESPERAS[Math.min(ev.tentativas - 1, ESPERAS.length - 1)],
        ],
      );
      console.error(`trimundi: aviso de pagamento #${ev.id} falhou (tentativa ${ev.tentativas}):`, err.message);
    }
  }
  return feitos;
}

module.exports = { registrarEvento, processarFila, aplicar, reais };
