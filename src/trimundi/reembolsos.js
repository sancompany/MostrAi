const crypto = require('node:crypto');
const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar, historicoDoIngresso } = require('./lib/registro');
const checkout = require('./checkout/cliente');
const pagamentos = require('./pagamentos');

// Reembolso pedido pelo Admin (API.md §5.4): pedido inteiro ou um ingresso.
// O pedido ao Checkout leva NOSSA chave de idempotência, única por reembolso
// (repetir com a mesma chave nunca devolve duas vezes). O ingresso fica
// bloqueado até o aviso do Checkout: só o `estornado`/`estornado_parcialmente`
// cancela (pagamentos.js); `estorno_negado` devolve o ingresso a válido.

async function solicitar(pedidoId, dados, autor) {
  const id = v.uuid(pedidoId);
  if (!id) throw erro(404, 'pedido não encontrado');
  const motivo = v.texto(dados?.motivo, {
    campo: 'o motivo',
    obrigatorio: true,
    max: 300,
    mensagem: 'Informe o motivo do reembolso.',
  });
  const ingressoId = dados?.ingresso_id ? v.id(dados.ingresso_id, 'ingresso') : null;

  const pedido = await emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM pedidos WHERE id = $1 FOR UPDATE', [id]);
    const p = rows[0];
    if (!p) throw erro(404, 'pedido não encontrado');
    if (!['pago', 'pago_sem_vaga'].includes(p.status)) throw erro(409, 'Só pedido pago pode ser reembolsado.');
    const { rows: soma } = await cliente.query(
      "SELECT COALESCE(sum(valor_centavos), 0)::bigint AS s FROM reembolsos WHERE pedido_id = $1 AND status IN ('solicitado', 'confirmado')",
      [id],
    );
    const restante = Number(p.total_centavos) - Number(soma[0].s);
    let valor;
    let alvo = null;
    if (ingressoId) {
      if (p.status === 'pago_sem_vaga') throw erro(409, 'Pedido pago sem vaga se devolve inteiro.');
      const { rows: ing } = await cliente.query('SELECT * FROM ingressos WHERE id = $1 AND pedido_id = $2 FOR UPDATE', [
        ingressoId,
        id,
      ]);
      alvo = ing[0];
      if (!alvo) throw erro(404, 'ingresso não encontrado neste pedido');
      if (alvo.status === 'cancelado') throw erro(409, 'Esse ingresso já está cancelado.');
      const { rows: pend } = await cliente.query(
        "SELECT 1 FROM reembolsos WHERE ingresso_id = $1 AND status = 'solicitado'",
        [ingressoId],
      );
      if (pend.length) throw erro(409, 'Já há um reembolso pedido para esse ingresso.');
      valor = Number(alvo.valor_centavos);
    } else {
      valor = restante;
    }
    if (valor <= 0 || valor > restante) throw erro(409, 'Não há valor a reembolsar neste pedido.');
    const chave = `tm-${crypto.randomUUID()}`;
    const { rows: novo } = await cliente.query(
      `INSERT INTO reembolsos (pedido_id, ingresso_id, valor_centavos, chave_idempotencia, motivo, solicitado_por, solicitado_por_access)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [id, ingressoId, valor, chave, motivo, autor?.autor || 'admin', autor?.autorAccess || null],
    );
    const { rows: bloqueados } = await cliente.query(
      `UPDATE ingressos SET status = 'bloqueado', motivo_status = 'reembolso solicitado', atualizado_em = now()
        WHERE pedido_id = $1 AND status = 'valido' AND ($2::bigint IS NULL OR id = $2) RETURNING id`,
      [id, ingressoId],
    );
    for (const b of bloqueados) {
      await historicoDoIngresso(cliente, b.id, 'reembolso_solicitado', { motivo, autor: autor?.autor });
    }
    await auditar(cliente, autor, 'reembolso_solicitado', 'pedido', id, {
      reembolso_id: novo[0].id,
      valor_centavos: valor,
      parcial: Boolean(ingressoId),
    });
    return { ...p, reembolsoId: novo[0].id, chave, valor, parcial: valor < Number(p.total_centavos) };
  });

  return enviarAoCheckout(pedido.reembolsoId);
}

// Manda (ou reenvia, com a MESMA chave) o pedido de estorno ao Checkout.
async function enviarAoCheckout(reembolsoId) {
  const { rows } = await consultar(
    'SELECT r.*, p.charge_id, p.total_centavos FROM reembolsos r JOIN pedidos p ON p.id = r.pedido_id WHERE r.id = $1',
    [reembolsoId],
  );
  const r = rows[0];
  if (!r) throw erro(404, 'reembolso não encontrado');
  if (r.status !== 'solicitado') throw erro(409, 'Esse reembolso não está aguardando envio.');
  const parcial = Number(r.valor_centavos) < Number(r.total_centavos);
  let resposta;
  try {
    resposta = await checkout.estornar({
      pedidoId: r.pedido_id,
      // Total sem `valor` (estorna tudo); parcial com o valor e a chave.
      ...(parcial ? { valor: Number(r.valor_centavos) / 100 } : {}),
      chaveIdempotencia: r.chave_idempotencia,
    });
  } catch (err) {
    if (err.naoConfigurado) {
      await falhar(r, 'San Checkout não configurado para a Trimundi');
      throw erro(503, 'O pagamento da TICK não está configurado neste ambiente.');
    }
    // Rede: fica 'solicitado' para reenviar com a mesma chave.
    await consultar('UPDATE reembolsos SET ultimo_erro = $2, atualizado_em = now() WHERE id = $1', [
      r.id,
      String(err.message).slice(0, 500),
    ]);
    return { reembolso_id: r.id, status: 'solicitado', reenviar: true };
  }
  if (resposta.ok) {
    await consultar('UPDATE reembolsos SET ultimo_erro = NULL, atualizado_em = now() WHERE id = $1', [r.id]);
    await registrarResposta(r, resposta.corpo);
    const { rows: depois } = await consultar('SELECT status FROM reembolsos WHERE id = $1', [r.id]);
    return { reembolso_id: r.id, status: depois[0].status };
  }
  const codigo = String(resposta.corpo?.codigo || '');
  const mensagem = String(resposta.corpo?.erro || codigo || `HTTP ${resposta.status}`);
  if (
    resposta.status >= 500 ||
    resposta.status === 429 ||
    (resposta.status === 409 && !RECUSA_DEFINITIVA.has(codigo))
  ) {
    // 5xx, 429 e 409 de estorno em andamento/reconciliação: tentar de novo
    // com a MESMA chave (API.md §5.4) — o Checkout nunca devolve duas vezes.
    await consultar('UPDATE reembolsos SET ultimo_erro = $2, atualizado_em = now() WHERE id = $1', [
      r.id,
      mensagem.slice(0, 500),
    ]);
    return { reembolso_id: r.id, status: 'solicitado', reenviar: true };
  }
  await falhar(r, mensagem);
  throw erro(502, `O Checkout recusou o reembolso: ${mensagem.slice(0, 200)}`);
}

// 409 que repetir não resolve (API.md §5.4): precisa de gente.
const RECUSA_DEFINITIVA = new Set([
  'chave_idempotencia_reutilizada',
  'estorno_impossivel',
  'mais_de_uma_cobranca_paga',
  'estorno_de_parcelamento',
]);

// O 200 do /estornar já diz o resultado (`status`, `valorEstornado`): entra
// pela mesma fila dos avisos, com id próprio. O webhook do mesmo estorno vem
// depois e não muda nada (a aplicação é idempotente). Boleto responde
// `estorno_solicitado` — fica aguardando o aviso.
async function registrarResposta(r, corpo) {
  if (!corpo?.status || typeof corpo.status !== 'string') return;
  const valor = corpo.valorEstornado ?? '';
  await pagamentos.registrarEvento({
    eventoId: `estorno:${r.chave_idempotencia}:${corpo.status}:${valor}`.slice(0, 160),
    provedor: 'san_checkout',
    payload: {
      pedidoId: r.pedido_id,
      chargeId: corpo.chargeId || r.charge_id || null,
      status: corpo.status,
      valorEstornado: corpo.valorEstornado ?? null,
      estornoParcial: Boolean(corpo.estornoParcial),
      origem: 'resposta_do_estorno',
    },
  });
  await pagamentos.processarFila();
}

async function falhar(r, motivo) {
  await emTransacao(async (cliente) => {
    await cliente.query(
      "UPDATE reembolsos SET status = 'falhou', ultimo_erro = $2, atualizado_em = now() WHERE id = $1",
      [r.id, motivo.slice(0, 500)],
    );
    const { rows } = await cliente.query(
      `UPDATE ingressos SET status = 'valido', motivo_status = NULL, atualizado_em = now()
        WHERE pedido_id = $1 AND status = 'bloqueado' AND motivo_status = 'reembolso solicitado'
          AND ($2::bigint IS NULL OR id = $2) RETURNING id`,
      [r.pedido_id, r.ingresso_id],
    );
    for (const i of rows)
      await historicoDoIngresso(cliente, i.id, 'desbloqueado', { motivo: 'reembolso não enviado', autor: 'sistema' });
  });
}

module.exports = { solicitar, enviarAoCheckout };
