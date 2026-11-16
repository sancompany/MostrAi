const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar, medir } = require('./lib/registro');
const { colunasDeNumero } = require('./lib/numeracao');

// Campanhas (§3). Desenho aprovado: docs/trimundi/specs/2026-11-15-campanhas-desenho.md
// (v2) e decisões C1–C7 e R1–R3 de 16/11/2026.
//
// O que garante o quê:
//   · ORDEM REAL: toda confirmação de pagamento roda sob a trava da linha da
//     edição (pagamentos.aplicar). As posições são dadas DENTRO dessa
//     transação, então a ordem de commit é a ordem das posições. O instante
//     oficial (R2) é pedidos.pago_em, gravado com clock_timestamp() depois da
//     trava — o mesmo instante decide a janela (C4) e fica na posição.
//   · IDEMPOTÊNCIA: posição única por (campanha, ingresso), prêmio com chave
//     única, livro de indicações único por (campanha, pedido); as funções de
//     reconciliação calculam o estado desejado e gravam só a diferença.
//   · HISTÓRICO: toda mudança de prêmio grava campanha_premio_eventos (só
//     acréscimo) na mesma transação.
// Ordem das travas, sempre: edição → pedido → campanhas (por id).

const DE_PE = ['concedido', 'entregue'];
const brindeDe = (f) =>
  f.beneficio_id ? `b:${f.beneficio_id}` : `n:${String(f.premio).trim().toLowerCase().slice(0, 86)}`;
const valorDe = (f) => Number(f.custo_unitario_centavos) * Number(f.quantidade);

// Melhor primeiro: maior valor, depois maior prioridade, depois a mais antiga.
const melhorPrimeiro = (a, b) =>
  b.valor - a.valor || b.campanha.prioridade - a.campanha.prioridade || Number(a.campanha.id) - Number(b.campanha.id);

async function evento(cliente, premioId, acao, autor, motivo = null) {
  await cliente.query('INSERT INTO campanha_premio_eventos (premio_id, acao, autor, motivo) VALUES ($1, $2, $3, $4)', [
    premioId,
    acao,
    String(autor || 'sistema').slice(0, 200),
    motivo ? String(motivo).slice(0, 200) : null,
  ]);
}

async function mudarPremio(cliente, premio, para, { autor, motivo = null }) {
  const sets = {
    revogado: "status = 'revogado', revogado_em = clock_timestamp()",
    expirado: "status = 'expirado', expirado_em = clock_timestamp()",
    concedido: "status = 'concedido', revogado_em = NULL",
  };
  // Restaurado volta sem motivo (o motivo da volta fica no evento).
  const { rowCount } = await cliente.query(
    `UPDATE campanha_premios SET ${sets[para]}, motivo = $2::text, atualizado_em = clock_timestamp()
      WHERE id = $1 AND status = $3`,
    [premio.id, para === 'concedido' ? null : motivo, premio.status],
  );
  if (!rowCount) return false;
  await evento(cliente, premio.id, para === 'concedido' ? 'restaurado' : para, autor, motivo);
  return true;
}

// ------------------------------------------------------------ leitura base
async function campanhasDaConfirmacao(cliente, edicaoId, instante) {
  // C4/R2: janela pelo instante oficial; C6: pausada não entra. Travadas em
  // ordem de id (ordem de travas fixa, sem deadlock).
  const { rows } = await cliente.query(
    `SELECT * FROM campanhas WHERE edicao_id = $1 AND status = 'ativa'
        AND (inicio IS NULL OR inicio <= $2) AND (fim IS NULL OR fim > $2)
      ORDER BY id FOR UPDATE`,
    [edicaoId, instante],
  );
  return rows;
}

async function faixasDe(cliente, campanhaIds) {
  if (!campanhaIds.length) return new Map();
  const { rows } = await cliente.query(
    'SELECT * FROM campanha_faixas WHERE campanha_id = ANY($1::bigint[]) ORDER BY campanha_id, ordem',
    [campanhaIds],
  );
  const m = new Map(campanhaIds.map((id) => [Number(id), []]));
  for (const f of rows) m.get(Number(f.campanha_id)).push(f);
  return m;
}

async function alvosDe(cliente, campanhaIds) {
  if (!campanhaIds.length) return new Map();
  const { rows } = await cliente.query('SELECT * FROM campanha_alvos WHERE campanha_id = ANY($1::bigint[])', [
    campanhaIds,
  ]);
  const m = new Map(campanhaIds.map((id) => [Number(id), []]));
  for (const a of rows) m.get(Number(a.campanha_id)).push(a);
  return m;
}

function qualifica(campanha, alvos, ing) {
  if (!campanha.inclui_combos && ing.promocao_id) return false;
  if (!alvos.length) return true;
  return alvos.some(
    (a) =>
      (!a.categoria_id || Number(a.categoria_id) === Number(ing.categoria_id)) &&
      (!a.lote_id || Number(a.lote_id) === Number(ing.lote_id)),
  );
}

// ------------------------------------------------- confirmação de pagamento
// Chamada por pagamentos.confirmar logo depois da emissão, na mesma
// transação e sob a trava da edição. `checkoutEm`: hora do aviso do Checkout
// (R2: só auditoria).
async function aoConfirmar(cliente, pedido, { checkoutEm = null } = {}) {
  if (pedido.origem !== 'venda') return;
  const { rows: ped } = await cliente.query('SELECT pago_em, cliente_id, indicador_id FROM pedidos WHERE id = $1', [
    pedido.id,
  ]);
  const p = ped[0];
  if (!p?.pago_em) return;
  const instante = p.pago_em;
  const campanhas = await campanhasDaConfirmacao(cliente, pedido.edicao_id, instante);
  if (!campanhas.length) return;
  const checkout = checkoutEm && !Number.isNaN(new Date(checkoutEm).getTime()) ? new Date(checkoutEm) : null;
  const ordem = campanhas.filter((c) => c.modalidade === 'ordem_compra');
  if (ordem.length) await posicionarPedido(cliente, pedido, p, ordem, { instante, checkout });
  const indicacao = campanhas.filter((c) => c.modalidade === 'indicacao');
  if (indicacao.length && p.indicador_id && p.cliente_id) {
    await registrarIndicacao(cliente, pedido, p, indicacao, instante);
  }
}

async function posicionarPedido(cliente, pedido, p, campanhas, { instante, checkout }) {
  const ids = campanhas.map((c) => Number(c.id));
  const faixas = await faixasDe(cliente, ids);
  const alvos = await alvosDe(cliente, ids);
  // Cada ingresso pago é uma posição (decisão I), na ordem da numeração.
  const { rows: ingressos } = await cliente.query(
    `SELECT i.id, i.categoria_id, i.lote_id, i.promocao_id, ${colunasDeNumero('i')},
            d.id AS desconto_id, d.acumula AS desconto_acumula
       FROM ingressos i JOIN reservas r ON r.id = i.reserva_id
       LEFT JOIN campanhas d ON d.id = r.campanha_id
      WHERE i.pedido_id = $1 AND i.origem = 'pago' AND i.status = 'valido'
      ORDER BY numero, i.id`,
    [pedido.id],
  );
  const contador = new Map(campanhas.map((c) => [Number(c.id), c.proxima_posicao]));
  for (const ing of ingressos) {
    // Idempotência: ingresso que já tem posição em alguma destas campanhas já
    // foi processado (tudo do ingresso nasce na mesma transação).
    const { rows: ja } = await cliente.query(
      'SELECT 1 FROM campanha_posicoes WHERE ingresso_id = $1 AND campanha_id = ANY($2::bigint[]) LIMIT 1',
      [ing.id, ids],
    );
    if (ja.length) continue;
    const posicoes = [];
    for (const c of campanhas) {
      if (!qualifica(c, alvos.get(Number(c.id)), ing)) continue;
      const posicao = contador.get(Number(c.id));
      contador.set(Number(c.id), posicao + 1);
      const faixa = faixas.get(Number(c.id)).find((f) => f.de <= posicao && posicao <= f.ate) || null;
      const pos = { campanha: c, posicao, faixa, resultado: null, vencedora: null };
      if (!faixa) pos.resultado = 'sem_faixa';
      else if (!(await temEstoqueOrdem(cliente, faixa))) pos.resultado = 'sem_estoque';
      else if (!(await cabeNoLimite(cliente, c, p.cliente_id))) pos.resultado = 'limite_por_pessoa';
      else Object.assign(pos, { valor: valorDe(faixa), brinde: brindeDe(faixa) });
      posicoes.push(pos);
    }
    if (!posicoes.length) continue;
    // P2: ingresso comprado com desconto NÃO acumulável — o desconto é a
    // campanha vencedora dele; brinde não acumulável não vem junto (a posição
    // continua ocupada — C1). Desconto acumulável não interfere.
    const desconto = ing.desconto_id && !ing.desconto_acumula ? { campanha: { id: ing.desconto_id } } : null;
    escolherVencedoras(
      posicoes.filter((x) => !x.resultado),
      desconto,
    );
    for (const pos of posicoes) {
      const { rows: pr } = await cliente.query(
        `INSERT INTO campanha_posicoes (campanha_id, posicao, ingresso_id, pedido_id, comprador_cliente_id, faixa_id,
                                        resultado, vencedora_id, confirmado_em, confirmado_no_checkout_em)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          pos.campanha.id,
          pos.posicao,
          ing.id,
          pedido.id,
          p.cliente_id,
          pos.faixa?.id || null,
          pos.resultado,
          pos.vencedora?.campanha.id || null,
          instante,
          checkout,
        ],
      );
      if (pos.resultado !== 'premiado') continue;
      const f = pos.faixa;
      const { rows: novo } = await cliente.query(
        `INSERT INTO campanha_premios (campanha_id, faixa_id, ingresso_id, posicao_id, comprador_cliente_id, premio,
                                       beneficio_id, brinde, quantidade, valor_centavos, exclusivo, chave)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (chave) DO NOTHING RETURNING id`,
        [
          pos.campanha.id,
          f.id,
          ing.id,
          pr[0].id,
          p.cliente_id,
          f.premio,
          f.beneficio_id,
          pos.brinde,
          f.quantidade,
          pos.valor,
          !pos.campanha.acumula,
          `pos:${pos.campanha.id}:${ing.id}`,
        ],
      );
      if (novo[0]) {
        await evento(cliente, novo[0].id, 'concedido', 'pagamento', `posição ${pos.posicao}`);
        await medir(cliente, 'campanha:premio_concedido', pedido.edicao_id, { campanha_id: pos.campanha.id });
      }
    }
  }
  for (const c of campanhas) {
    const prox = contador.get(Number(c.id));
    if (prox !== c.proxima_posicao) {
      await cliente.query('UPDATE campanhas SET proxima_posicao = $2 WHERE id = $1', [c.id, prox]);
      c.proxima_posicao = prox;
    }
  }
}

// C1 + J: das não acumuláveis, uma vencedora (valor, prioridade, antiguidade);
// as acumuláveis somam-se, sem repetir o mesmo brinde no ingresso.
function escolherVencedoras(candidatas, jaVenceu = null) {
  const naoAcumulaveis = candidatas.filter((x) => !x.campanha.acumula).sort(melhorPrimeiro);
  const vencedora = jaVenceu || naoAcumulaveis[0] || null;
  for (const perdeu of naoAcumulaveis.filter((x) => x !== vencedora)) {
    Object.assign(perdeu, { resultado: 'nao_acumulavel', vencedora });
  }
  const levadas = vencedora && !jaVenceu ? [vencedora] : [];
  for (const x of candidatas.filter((y) => y.campanha.acumula).sort(melhorPrimeiro)) {
    const mesmoBrinde = levadas.find((l) => l.brinde === x.brinde);
    if (mesmoBrinde) Object.assign(x, { resultado: 'nao_acumulavel', vencedora: mesmoBrinde });
    else levadas.push(x);
  }
  for (const l of levadas) l.resultado = 'premiado';
}

// Ordem de compra: o estoque conta TODO prêmio já concedido na faixa,
// inclusive revogado — a posição é fixa e o prêmio não passa adiante.
async function temEstoqueOrdem(cliente, faixa) {
  if (!faixa.estoque) return true;
  const { rows } = await cliente.query('SELECT count(*)::int AS n FROM campanha_premios WHERE faixa_id = $1', [
    faixa.id,
  ]);
  return rows[0].n < faixa.estoque;
}

// C3/R3: limite por CONTA COMPRADORA, contando só prêmios de pé.
async function cabeNoLimite(cliente, campanha, compradorId) {
  if (!campanha.limite_por_pessoa || !compradorId) return true;
  const { rows } = await cliente.query(
    `SELECT count(*)::int AS n FROM campanha_premios
      WHERE campanha_id = $1 AND comprador_cliente_id = $2 AND status = ANY($3::text[])`,
    [campanha.id, compradorId, DE_PE],
  );
  return rows[0].n < campanha.limite_por_pessoa;
}

// ------------------------------------------------------------- indicação
// O pedido pago de quem chegou por um link conta em cada campanha de
// indicação ativa cuja janela contém o instante oficial (C4/R2). A mesma
// pessoa conta uma vez por campanha.
async function registrarIndicacao(cliente, pedido, p, campanhas, instante) {
  for (const c of campanhas) {
    const { rows: ja } = await cliente.query(
      'SELECT 1 FROM campanha_indicacoes WHERE campanha_id = $1 AND cliente_id = $2 AND valida',
      [c.id, p.cliente_id],
    );
    if (ja.length) continue;
    const { rows } = await cliente.query(
      `INSERT INTO campanha_indicacoes (campanha_id, indicador_id, pedido_id, cliente_id, confirmado_em)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING id`,
      [c.id, p.indicador_id, pedido.id, p.cliente_id, instante],
    );
    if (!rows[0]) continue;
    await medir(cliente, 'indicacao:conversao', pedido.edicao_id, { campanha_id: c.id });
    await reconciliarIndicador(cliente, c.id, p.indicador_id, { autor: 'pagamento' });
  }
}

// A conversão segue o estado do pedido (pago com ingresso de pé conta;
// reembolso, contestação ou baixa desfeita tiram). Chamada em todo aviso.
async function revisarIndicacoesDoPedido(cliente, pedidoId, deDePe) {
  const { rows: p } = await cliente.query('SELECT status, origem FROM pedidos WHERE id = $1', [pedidoId]);
  const { rows } = await cliente.query('SELECT * FROM campanha_indicacoes WHERE pedido_id = $1 ORDER BY campanha_id', [
    pedidoId,
  ]);
  const vale = p[0]?.status === 'pago' && p[0]?.origem === 'venda' && deDePe;
  for (const x of rows) {
    if (x.valida !== vale) {
      let pode = true;
      if (vale) {
        const { rows: ja } = await cliente.query(
          'SELECT 1 FROM campanha_indicacoes WHERE campanha_id = $1 AND cliente_id = $2 AND valida AND id <> $3',
          [x.campanha_id, x.cliente_id, x.id],
        );
        pode = !ja.length;
      }
      if (pode) {
        await cliente.query('UPDATE campanha_indicacoes SET valida = $2, atualizado_em = now() WHERE id = $1', [
          x.id,
          vale,
        ]);
      }
    }
    await reconciliarIndicador(cliente, x.campanha_id, x.indicador_id, { autor: 'pagamento' });
  }
}

// Estado desejado dos prêmios de um indicador numa campanha (seção 3.2 do
// desenho), aplicado como diferença. Campanha travada.
//   · cada nível tem a SUA linha (C2) — chave niv:<c>:<ind>:<nível>[:<rep>];
//   · maior_nivel: o maior nível atingido (com estoque) fica de pé; os de
//     baixo ainda não entregues são revogados ("substituído"); os de baixo
//     ENTREGUES ficam e o de cima também vem (C2);
//   · cumulativa: um por nível atingido;
//   · nível que se repete: floor(n / de) prêmios (o formato de antes);
//   · nível não mais atingido: o não entregue é revogado; o entregue fica;
//   · revogado volta (mesma linha, evento 'restaurado') quando volta a valer;
//   · grava novo/restaurado só com a campanha ativa, dentro do prazo, do
//     estoque e do limite por pessoa (R3: só prêmios de pé contam).
async function reconciliarIndicador(cliente, campanhaId, indicadorId, { autor = 'sistema' } = {}) {
  const { rows: cr } = await cliente.query('SELECT * FROM campanhas WHERE id = $1 FOR UPDATE', [campanhaId]);
  const c = cr[0];
  if (c?.modalidade !== 'indicacao') return;
  const { rows: niveis } = await cliente.query('SELECT * FROM campanha_faixas WHERE campanha_id = $1 ORDER BY ordem', [
    campanhaId,
  ]);
  if (!niveis.length) return;
  const { rows: cnt } = await cliente.query(
    'SELECT count(*)::int AS n FROM campanha_indicacoes WHERE campanha_id = $1 AND indicador_id = $2 AND valida',
    [campanhaId, indicadorId],
  );
  const n = cnt[0].n;
  const { rows: ind } = await cliente.query('SELECT operador_id FROM indicadores WHERE id = $1', [indicadorId]);
  const soAdmin = Boolean(ind[0]?.operador_id);
  const premios = async () =>
    (
      await cliente.query(
        'SELECT * FROM campanha_premios WHERE campanha_id = $1 AND indicador_id = $2 ORDER BY faixa_id, repeticao NULLS FIRST, id FOR UPDATE',
        [campanhaId, indicadorId],
      )
    ).rows;
  const podeConceder =
    c.status === 'ativa' &&
    (!c.prazo_retirada || new Date(c.prazo_retirada) > new Date()) &&
    (!c.fim || new Date(c.fim) > new Date());
  const dePeNaFaixa = async (faixaId) =>
    (
      await cliente.query(
        'SELECT count(*)::int AS n FROM campanha_premios WHERE faixa_id = $1 AND status = ANY($2::text[])',
        [faixaId, DE_PE],
      )
    ).rows[0].n;
  const dePeMeus = async () =>
    (
      await cliente.query(
        'SELECT count(*)::int AS n FROM campanha_premios WHERE campanha_id = $1 AND indicador_id = $2 AND status = ANY($3::text[])',
        [campanhaId, indicadorId, DE_PE],
      )
    ).rows[0].n;
  const cabe = async (faixa) =>
    (!faixa.estoque || (await dePeNaFaixa(faixa.id)) < faixa.estoque) &&
    (!c.limite_por_pessoa || (await dePeMeus()) < c.limite_por_pessoa);
  const conceder = async (faixa, repeticao, existente) => {
    if (existente?.status === 'revogado') {
      await mudarPremio(cliente, existente, 'concedido', { autor, motivo: `nível de ${faixa.de} indicações de novo` });
      return;
    }
    if (existente) return; // expirado ou de pé: nada a fazer
    const chave = `niv:${campanhaId}:${indicadorId}:${faixa.id}${repeticao ? `:${repeticao}` : ''}`;
    const { rows } = await cliente.query(
      `INSERT INTO campanha_premios (campanha_id, faixa_id, indicador_id, repeticao, premio, beneficio_id, brinde,
                                     quantidade, valor_centavos, exclusivo, so_admin, chave)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (chave) DO NOTHING RETURNING id`,
      [
        campanhaId,
        faixa.id,
        indicadorId,
        repeticao,
        faixa.premio,
        faixa.beneficio_id,
        brindeDe(faixa),
        faixa.quantidade,
        valorDe(faixa),
        !c.acumula,
        soAdmin,
        chave,
      ],
    );
    if (rows[0]) {
      await evento(cliente, rows[0].id, 'concedido', autor, `${n} indicações`);
      await medir(cliente, 'indicacao:recompensa_concedida', c.edicao_id, { campanha_id: campanhaId });
    }
  };

  // Nível que se repete (único na campanha): por contagem, como antes.
  if (niveis[0].repete) {
    const faixa = niveis[0];
    let desejados = Math.floor(n / faixa.de);
    if (c.limite_por_pessoa) desejados = Math.min(desejados, c.limite_por_pessoa);
    let lista = await premios();
    const dePe = lista.filter((x) => DE_PE.includes(x.status));
    // Sobra: revoga os não entregues, do maior número para o menor.
    let sobra = dePe.length - desejados;
    for (const x of [...dePe].filter((y) => y.status === 'concedido').sort((a, b) => b.repeticao - a.repeticao)) {
      if (sobra <= 0) break;
      await mudarPremio(cliente, x, 'revogado', { autor, motivo: 'indicação reembolsada' });
      sobra -= 1;
    }
    if (!podeConceder) return;
    lista = await premios();
    let falta = desejados - lista.filter((x) => DE_PE.includes(x.status)).length;
    // Falta: primeiro restaura revogados (menor número), depois cria novos.
    for (const x of lista.filter((y) => y.status === 'revogado').sort((a, b) => a.repeticao - b.repeticao)) {
      if (falta <= 0 || !(await cabe(faixa))) break;
      await conceder(faixa, x.repeticao, x);
      falta -= 1;
    }
    let proxima = lista.reduce((m, x) => Math.max(m, x.repeticao || 0), 0) + 1;
    while (falta > 0 && (await cabe(faixa))) {
      await conceder(faixa, proxima, null);
      proxima += 1;
      falta -= 1;
    }
    return;
  }

  // Níveis (C2).
  const atingidos = niveis.filter((f) => f.de <= n);
  const porNivel = async () => new Map((await premios()).map((x) => [Number(x.faixa_id), x]));
  let meus = await porNivel();
  const entregue = (f) => meus.get(Number(f.id))?.status === 'entregue';
  const dePe = (f) => DE_PE.includes(meus.get(Number(f.id))?.status);
  let desejados;
  if (c.escada === 'cumulativa') {
    desejados = new Set(atingidos.map((f) => Number(f.id)));
  } else {
    // O maior nível atingido que ele já tem de pé ou que ainda tem estoque.
    let topo = null;
    for (const f of [...atingidos].reverse()) {
      if (dePe(f) || !f.estoque || (await dePeNaFaixa(f.id)) < f.estoque) {
        topo = f;
        break;
      }
    }
    desejados = new Set(topo ? [Number(topo.id)] : []);
    for (const f of atingidos) if (entregue(f)) desejados.add(Number(f.id));
  }
  const topoDe = atingidos.length ? atingidos[atingidos.length - 1].de : null;
  // Primeiro revoga (libera estoque), depois concede.
  for (const f of niveis) {
    const x = meus.get(Number(f.id));
    if (x?.status === 'concedido' && !desejados.has(Number(f.id))) {
      const motivo = f.de <= n ? `substituído pelo nível de ${topoDe} indicações` : 'indicação reembolsada';
      await mudarPremio(cliente, x, 'revogado', { autor, motivo });
    }
  }
  if (!podeConceder) return;
  meus = await porNivel();
  for (const f of niveis) {
    if (!desejados.has(Number(f.id)) || dePe(f)) continue;
    if (!(await cabe(f))) continue;
    await conceder(f, null, meus.get(Number(f.id)) || null);
  }
}

// --------------------------------------------- reembolso e estado do ingresso
// Prêmios de ordem de compra do pedido seguem o ingresso: cancelado →
// revogado (o não entregue) ou alerta (o já entregue). A posição nunca muda.
async function revisarIngressosDoPedido(cliente, pedidoId) {
  const { rows } = await cliente.query(
    `SELECT pr.*, i.status AS ingresso_status FROM campanha_premios pr JOIN ingressos i ON i.id = pr.ingresso_id
      WHERE i.pedido_id = $1 AND i.status = 'cancelado' AND pr.status IN ('concedido', 'entregue')
      ORDER BY pr.id FOR UPDATE OF pr`,
    [pedidoId],
  );
  for (const pr of rows) {
    if (pr.status === 'concedido') {
      await mudarPremio(cliente, pr, 'revogado', { autor: 'pagamento', motivo: 'ingresso reembolsado' });
    } else {
      const { rows: ja } = await cliente.query(
        "SELECT 1 FROM campanha_premio_eventos WHERE premio_id = $1 AND acao = 'alerta' AND motivo = 'ingresso reembolsado após a entrega'",
        [pr.id],
      );
      if (!ja.length) await evento(cliente, pr.id, 'alerta', 'pagamento', 'ingresso reembolsado após a entrega');
    }
  }
}

// Em todo aviso de pagamento (pagamentos.aplicar), depois do pedido aplicado.
async function revisarPedido(cliente, pedidoId, { ingressoDePe }) {
  await revisarIngressosDoPedido(cliente, pedidoId);
  await revisarIndicacoesDoPedido(cliente, pedidoId, ingressoDePe);
}

// ------------------------------------------------------------- entrega
// Entrega única: prêmio travado e UPDATE condicionado; o segundo pedido vê
// "já entregue". Prazo de retirada vencido → expirado (e recusa).
async function entregarPremio(cliente, premioId, { autor, via }) {
  const { rows } = await cliente.query(
    `SELECT pr.*, c.prazo_retirada, c.edicao_id, i.status AS ingresso_status
       FROM campanha_premios pr JOIN campanhas c ON c.id = pr.campanha_id
       LEFT JOIN ingressos i ON i.id = pr.ingresso_id
      WHERE pr.id = $1 FOR UPDATE OF pr`,
    [premioId],
  );
  const pr = rows[0];
  if (!pr || pr.status === 'revogado') throw erro(404, 'recompensa não encontrada');
  if (pr.status === 'entregue') {
    return { resultado: 'ja_entregue', entregue_em: pr.entregue_em, entregue_por: pr.entregue_por, premio: pr };
  }
  if (pr.status === 'expirado') throw erro(409, 'O prazo de retirada desta recompensa acabou.');
  if (pr.prazo_retirada && new Date(pr.prazo_retirada) <= new Date()) {
    await mudarPremio(cliente, pr, 'expirado', { autor: 'sistema', motivo: 'prazo de retirada vencido' });
    throw erro(409, 'O prazo de retirada desta recompensa acabou.');
  }
  if (pr.ingresso_id && pr.ingresso_status !== 'valido') {
    throw erro(409, 'Ingresso cancelado ou bloqueado: a recompensa não pode ser entregue.');
  }
  const { rows: ok } = await cliente.query(
    `UPDATE campanha_premios SET status = 'entregue', entregue_em = clock_timestamp(), entregue_por = $2,
            atualizado_em = clock_timestamp()
      WHERE id = $1 AND status = 'concedido' RETURNING entregue_em`,
    [pr.id, String(autor).slice(0, 200)],
  );
  await evento(cliente, pr.id, 'entregue', autor, via);
  await auditar(cliente, { autor }, 'recompensa_entregue', 'campanha_premio', pr.id, {
    via,
    campanha_id: pr.campanha_id,
  });
  await medir(cliente, 'campanha:premio_entregue', pr.edicao_id, { via });
  return { resultado: 'entregue', entregue_em: ok[0].entregue_em, premio: pr };
}

// Varredura: prêmio concedido com prazo de retirada vencido → expirado.
async function expirarVencidos() {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query(
      `SELECT pr.* FROM campanha_premios pr JOIN campanhas c ON c.id = pr.campanha_id
        WHERE pr.status = 'concedido' AND c.prazo_retirada IS NOT NULL AND c.prazo_retirada <= now()
        ORDER BY pr.id LIMIT 500 FOR UPDATE OF pr SKIP LOCKED`,
    );
    for (const pr of rows) {
      await mudarPremio(cliente, pr, 'expirado', { autor: 'sistema', motivo: 'prazo de retirada vencido' });
    }
    return rows.length;
  });
}

// --------------------------------------------------------- Admin (serviço)
// Admin → Campanhas (PR 2). Três modalidades na mesma tabela:
//   · ordem_compra — brinde para as posições de compra (faixas);
//   · indicacao    — brinde por níveis de indicação;
//   · desconto     — promoção de preço em ingresso individual (pedido do dono,
//     16/11/2026): percentual, valor fixo ou preço promocional, com quantidade
//     promocional. Combos seguem em Admin → Combos (são outra coisa).
// "Relâmpago" é uma marca de destaque (com fim obrigatório) em ordem de
// compra e desconto. Toda escrita grava auditoria.

const MODALIDADES = ['ordem_compra', 'indicacao', 'desconto'];
// O mesmo piso de preço do lote (lotes.preco_centavos >= 500): desconto nunca
// leva o ingresso abaixo de R$ 5,00. Ingresso grátis é cortesia, não desconto.
const PRECO_MINIMO = 500;
// Preço final de UM ingresso na campanha de desconto (calculado sempre no
// servidor). Percentual: arredonda ao centavo (meio para cima — P4).
function precoComDesconto(c, precoLote) {
  const p = Number(precoLote);
  if (c.desconto_tipo === 'percentual') return Math.round((p * (100 - Number(c.desconto_valor))) / 100);
  if (c.desconto_tipo === 'valor') return p - Number(c.desconto_valor);
  return Number(c.desconto_valor);
}

// ------------------------------------------- desconto no pedido (PR 4, 018)
// Unidade promocional USADA (P1): vaga com a campanha cujo ingresso foi
// emitido — mesmo que depois reembolsado ou cancelado, a unidade não volta —
// mais vaga de pedido aguardando pagamento com a reserva viva. Reserva
// vencida sem pagamento não conta (nunca foi vendida).
const SQL_USOS = `
  SELECT r.campanha_id, count(*)::int AS n
    FROM reservas r JOIN pedidos p ON p.id = r.pedido_id
    LEFT JOIN ingressos i ON i.reserva_id = r.id
   WHERE r.campanha_id = ANY($1::bigint[])
     AND (i.id IS NOT NULL OR (p.status = 'aguardando_pagamento' AND p.reserva_expira_em > now()))
   GROUP BY r.campanha_id`;
// Limite por pessoa do desconto: pela CONTA COMPRADORA (C3), contando só o
// que está de pé (R3, por analogia — P7): ingresso válido ou reserva viva.
const SQL_USOS_DA_CONTA = `
  SELECT r.campanha_id, count(*)::int AS n
    FROM reservas r JOIN pedidos p ON p.id = r.pedido_id
    LEFT JOIN ingressos i ON i.reserva_id = r.id
   WHERE r.campanha_id = ANY($1::bigint[]) AND p.cliente_id = $2
     AND ((i.id IS NOT NULL AND i.status <> 'cancelado')
       OR (p.status = 'aguardando_pagamento' AND p.reserva_expira_em > now()))
   GROUP BY r.campanha_id`;

async function usosDe(cliente, ids, clienteId = null) {
  if (!ids.length) return new Map();
  const { rows } = await cliente.query(clienteId ? SQL_USOS_DA_CONTA : SQL_USOS, clienteId ? [ids, clienteId] : [ids]);
  return new Map(rows.map((r) => [Number(r.campanha_id), r.n]));
}

async function usosDoDesconto(cliente, campanhaId) {
  return (await usosDe(cliente, [Number(campanhaId)])).get(Number(campanhaId)) || 0;
}

// Promoções de preço valendo AGORA na edição (ativas, dentro da janela), com
// alvos, quanto resta da quantidade promocional e quanto resta para a conta.
async function descontosVigentes(cliente, edicaoId, { clienteId = null } = {}) {
  const { rows } = await cliente.query(
    `SELECT * FROM campanhas WHERE edicao_id = $1 AND modalidade = 'desconto' AND status = 'ativa'
        AND (inicio IS NULL OR inicio <= now()) AND (fim IS NULL OR fim > now())
      ORDER BY id`,
    [edicaoId],
  );
  if (!rows.length) return [];
  const ids = rows.map((c) => Number(c.id));
  const alvos = await alvosDe(cliente, ids);
  const usos = await usosDe(cliente, ids);
  const daConta = clienteId ? await usosDe(cliente, ids, clienteId) : new Map();
  return rows.map((c) => {
    const id = Number(c.id);
    const restam = Math.max(0, c.quantidade_promocional - (usos.get(id) || 0));
    const daPessoa = c.limite_por_pessoa ? Math.max(0, c.limite_por_pessoa - (daConta.get(id) || 0)) : Infinity;
    return { ...c, alvos: alvos.get(id), restam, cabe: Math.min(restam, clienteId ? daPessoa : restam) };
  });
}

// Preço do lote para a vitrine e para o pedido: a melhor promoção que alcança
// este lote (P2 — dois descontos nunca se somam: vale o menor preço; empate,
// prioridade, depois a mais antiga). Promoção que deixaria o preço igual ou
// acima do lote, ou abaixo do piso, não vale (o lote pode ter mudado de preço
// depois da ativação).
function descontosDoLote(vigentes, catId, lote) {
  return vigentes
    .filter((c) => qualifica({ inclui_combos: false }, c.alvos, { categoria_id: catId, lote_id: lote.id }))
    .map((c) => ({ campanha: c, preco: precoComDesconto(c, lote.preco_centavos) }))
    .filter((x) => x.preco < Number(lote.preco_centavos) && x.preco >= PRECO_MINIMO)
    .sort(
      (a, b) =>
        a.preco - b.preco ||
        b.campanha.prioridade - a.campanha.prioridade ||
        Number(a.campanha.id) - Number(b.campanha.id),
    );
}

// Divide `quantidade` ingressos de UM lote em partes com e sem desconto. Gasta
// o `cabe` das campanhas (o chamador segura a trava da edição na criação).
function repartirComDesconto(vigentes, catId, lote, quantidade) {
  const partes = [];
  let resta = quantidade;
  for (const { campanha, preco } of descontosDoLote(vigentes, catId, lote)) {
    if (!resta) break;
    const n = Math.min(resta, campanha.cabe);
    if (n <= 0) continue;
    campanha.cabe -= n;
    campanha.restam -= n;
    resta -= n;
    partes.push({ quantidade: n, preco, campanha });
  }
  if (resta) partes.push({ quantidade: resta, preco: Number(lote.preco_centavos), campanha: null });
  return partes;
}

// Pagamento depois de a reserva vencer (P5): a vaga com desconto só vale se a
// promoção ainda estiver aberta (ativa, na janela) e com quantidade
// promocional para ela — a mesma regra do lote. Senão, "pago sem vaga".
// Roda sob a trava da edição (pagamentos.aplicar), como a criação do pedido.
async function descontoAindaCabe(cliente, pedidoId) {
  const { rows } = await cliente.query(
    `SELECT r.campanha_id, count(*)::int AS n FROM reservas r
      WHERE r.pedido_id = $1 AND r.campanha_id IS NOT NULL GROUP BY r.campanha_id`,
    [pedidoId],
  );
  if (!rows.length) return true;
  const ids = rows.map((r) => Number(r.campanha_id));
  const { rows: cs } = await cliente.query(
    `SELECT id, quantidade_promocional FROM campanhas WHERE id = ANY($1::bigint[]) AND status = 'ativa'
        AND (inicio IS NULL OR inicio <= now()) AND (fim IS NULL OR fim > now())`,
    [ids],
  );
  if (cs.length !== ids.length) return false;
  const usos = await usosDe(cliente, ids);
  return rows.every((r) => {
    const c = cs.find((x) => Number(x.id) === Number(r.campanha_id));
    return (usos.get(Number(r.campanha_id)) || 0) + r.n <= c.quantidade_promocional;
  });
}

function lerCampanha(d = {}, parcial = false) {
  const tem = (k) => !parcial || Object.hasOwn(d, k);
  const out = {};
  if (!parcial) out.modalidade = v.escolha(d.modalidade, MODALIDADES, { campo: 'a modalidade' });
  if (tem('nome')) out.nome = v.texto(d.nome, { campo: 'o nome da campanha', obrigatorio: true, max: 80 });
  if (tem('descricao')) out.descricao = v.texto(d.descricao, { campo: 'a descrição', max: 1000 });
  if (tem('regras')) out.regras = v.texto(d.regras, { campo: 'as regras', max: 5000 });
  if (tem('inicio')) out.inicio = v.dataHora(d.inicio, { campo: 'o início' });
  if (tem('fim')) out.fim = v.dataHora(d.fim, { campo: 'o fim' });
  if (tem('prazo_retirada')) out.prazo_retirada = v.dataHora(d.prazo_retirada, { campo: 'o prazo de retirada' });
  for (const k of ['relampago', 'acumula', 'inclui_combos']) if (Object.hasOwn(d, k)) out[k] = v.booleano(d[k]);
  if (Object.hasOwn(d, 'prioridade'))
    out.prioridade = v.inteiro(d.prioridade, { campo: 'a prioridade', min: -1000, max: 1000 });
  if (Object.hasOwn(d, 'escada'))
    out.escada = v.escolha(d.escada, ['maior_nivel', 'cumulativa'], { campo: 'a escada' });
  if (tem('limite_por_pessoa')) {
    out.limite_por_pessoa = v.inteiro(d.limite_por_pessoa, {
      campo: 'o limite por pessoa',
      min: 1,
      max: 1000,
      obrigatorio: false,
    });
  }
  if (Object.hasOwn(d, 'desconto_tipo')) {
    out.desconto_tipo = d.desconto_tipo
      ? v.escolha(d.desconto_tipo, ['percentual', 'valor', 'preco'], { campo: 'o tipo de desconto' })
      : null;
  }
  if (Object.hasOwn(d, 'desconto_valor')) {
    out.desconto_valor = v.inteiro(d.desconto_valor, {
      campo: 'o valor do desconto',
      min: 1,
      max: 5000000,
      obrigatorio: false,
    });
  }
  if (Object.hasOwn(d, 'quantidade_promocional')) {
    out.quantidade_promocional = v.inteiro(d.quantidade_promocional, {
      campo: 'a quantidade promocional',
      min: 1,
      max: 100000,
      obrigatorio: false,
    });
  }
  return out;
}

function lerFaixas(lista, modalidade) {
  if (modalidade === 'desconto') {
    if (Array.isArray(lista) && lista.length) throw erro(400, 'Promoção de preço não tem faixas nem níveis.');
    return [];
  }
  if (!Array.isArray(lista) || lista.length < 1 || lista.length > 20) {
    throw erro(400, 'A campanha precisa de 1 a 20 faixas ou níveis.');
  }
  return lista.map((f, i) => ({
    ordem: i + 1,
    de: v.inteiro(f.de, { campo: modalidade === 'indicacao' ? 'o nível' : 'a posição inicial', min: 1, max: 1000000 }),
    ate: modalidade === 'ordem_compra' ? v.inteiro(f.ate, { campo: 'a posição final', min: 1, max: 1000000 }) : null,
    repete: modalidade === 'indicacao' ? v.booleano(f.repete, false) : false,
    premio: v.texto(f.premio, { campo: 'o prêmio', obrigatorio: true, max: 80 }),
    beneficio_id: f.beneficio_id ? v.id(f.beneficio_id, 'benefício') : null,
    quantidade: v.inteiro(f.quantidade ?? 1, { campo: 'a quantidade', min: 1, max: 100 }),
    estoque: v.inteiro(f.estoque, { campo: 'o estoque', min: 1, max: 1000000, obrigatorio: false }),
    custo_unitario_centavos: v.inteiro(f.custo_unitario_centavos ?? 0, {
      campo: 'o custo unitário',
      min: 0,
      max: 100000000,
    }),
  }));
}

// Configurações contraditórias são recusadas antes de gravar (o banco ainda
// confere sobreposição de faixas e níveis crescentes).
function conferirCoerencia(c, faixas, alvos) {
  if (c.inicio && c.fim && new Date(c.fim) <= new Date(c.inicio))
    throw erro(400, 'O fim precisa ser depois do início.');
  if (c.relampago && !c.fim) throw erro(400, 'Campanha relâmpago precisa de data e hora de encerramento.');
  if (c.relampago && c.modalidade === 'indicacao')
    throw erro(400, 'Relâmpago vale para promoção de preço e ordem de compra.');
  if (c.prazo_retirada) {
    if (c.modalidade === 'desconto') throw erro(400, 'Promoção de preço não tem prazo de retirada.');
    if (c.fim && new Date(c.prazo_retirada) < new Date(c.fim)) {
      throw erro(400, 'O prazo de retirada não pode acabar antes do fim da campanha.');
    }
    if (c.inicio && new Date(c.prazo_retirada) <= new Date(c.inicio)) {
      throw erro(400, 'O prazo de retirada precisa ser depois do início.');
    }
  }
  if (c.modalidade === 'desconto') {
    if (!c.desconto_tipo || !c.desconto_valor || !c.quantidade_promocional) {
      throw erro(400, 'Informe o tipo e o valor do desconto e a quantidade promocional.');
    }
    if (c.desconto_tipo === 'percentual' && (c.desconto_valor < 1 || c.desconto_valor > 90)) {
      throw erro(400, 'O desconto percentual vai de 1% a 90%.');
    }
    if (!alvos.length) throw erro(400, 'Escolha o tipo de ingresso (e, se quiser, o lote) da promoção.');
  } else {
    if (c.desconto_tipo || c.desconto_valor || c.quantidade_promocional) {
      throw erro(400, 'Desconto só existe na promoção de preço.');
    }
  }
  if (c.modalidade === 'indicacao' && alvos.length) throw erro(400, 'Campanha de indicação não tem tipos ou lotes.');
  for (const f of faixas) {
    if (c.modalidade === 'ordem_compra') {
      if (f.ate < f.de) throw erro(400, 'Em cada faixa, a posição final vem depois da inicial.');
      if (f.estoque && f.estoque > f.ate - f.de + 1) {
        throw erro(400, `O estoque da faixa ${f.de}–${f.ate} não pode passar do número de posições dela.`);
      }
    }
  }
  if (c.modalidade === 'ordem_compra') {
    const ord = [...faixas].sort((a, b) => a.de - b.de);
    for (let i = 1; i < ord.length; i++) {
      if (ord[i].de <= ord[i - 1].ate) throw erro(400, 'As faixas não podem se sobrepor.');
    }
  }
  if (c.modalidade === 'indicacao') {
    if (faixas.some((f) => f.repete) && faixas.length > 1) {
      throw erro(400, 'O nível que se repete ("a cada N") é o único da campanha.');
    }
    for (let i = 1; i < faixas.length; i++) {
      if (faixas[i].de <= faixas[i - 1].de) throw erro(400, 'Os níveis de indicação precisam crescer.');
    }
  }
}

function lerAlvos(lista = []) {
  if (!Array.isArray(lista)) throw erro(400, 'alvos inválidos');
  return lista.map((a) => {
    const categoria = a?.categoria_id ? v.id(a.categoria_id, 'tipo') : null;
    const lote = a?.lote_id ? v.id(a.lote_id, 'lote') : null;
    if (!categoria && !lote) throw erro(400, 'Alvo sem tipo nem lote.');
    return { categoria_id: categoria, lote_id: lote };
  });
}

async function gravarFaixas(cliente, campanhaId, edicaoId, faixas) {
  for (const f of faixas) {
    if (f.beneficio_id) {
      const { rows } = await cliente.query('SELECT 1 FROM beneficios WHERE id = $1 AND edicao_id = $2', [
        f.beneficio_id,
        edicaoId,
      ]);
      if (!rows.length) throw erro(400, 'O brinde precisa ser um benefício desta edição.');
    }
    await cliente.query(
      `INSERT INTO campanha_faixas (campanha_id, ordem, de, ate, repete, premio, beneficio_id, quantidade, estoque,
                                    custo_unitario_centavos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        campanhaId,
        f.ordem,
        f.de,
        f.ate,
        f.repete,
        f.premio,
        f.beneficio_id,
        f.quantidade,
        f.estoque,
        f.custo_unitario_centavos,
      ],
    );
  }
}

async function gravarAlvos(cliente, campanhaId, edicaoId, alvos = []) {
  for (const a of alvos) {
    const { rows } = await cliente.query(
      `SELECT 1 FROM categorias c LEFT JOIN lotes l ON l.id = $3
        WHERE c.edicao_id = $1 AND ($2::bigint IS NULL OR c.id = $2)
          AND ($3::bigint IS NULL OR l.categoria_id = c.id) LIMIT 1`,
      [edicaoId, a.categoria_id, a.lote_id],
    );
    if (!rows.length) throw erro(400, 'Tipo ou lote que não é desta edição.');
    await cliente.query('INSERT INTO campanha_alvos (campanha_id, categoria_id, lote_id) VALUES ($1, $2, $3)', [
      campanhaId,
      a.categoria_id,
      a.lote_id,
    ]);
  }
}

// Lotes que a promoção de preço alcança, com o estoque de agora.
async function lotesDoDesconto(cliente, campanhaId) {
  const { rows } = await cliente.query(
    `SELECT DISTINCT l.id, l.categoria_id, l.ordem, l.preco_centavos, l.quantidade, l.encerrado_em, c.nome AS tipo
       FROM campanha_alvos a
       JOIN lotes l ON (a.lote_id IS NOT NULL AND l.id = a.lote_id) OR (a.lote_id IS NULL AND l.categoria_id = a.categoria_id)
       JOIN categorias c ON c.id = l.categoria_id
      WHERE a.campanha_id = $1
      ORDER BY l.categoria_id, l.ordem`,
    [campanhaId],
  );
  return rows;
}

// Preço final válido em todos os lotes alcançados: abaixo do preço do lote e
// nunca abaixo do piso.
async function conferirPrecos(cliente, c) {
  for (const l of await lotesDoDesconto(cliente, c.id)) {
    const final = precoComDesconto(c, l.preco_centavos);
    if (final >= Number(l.preco_centavos)) {
      throw erro(400, `O preço promocional precisa ser menor que o do ${l.ordem}º lote de ${l.tipo}.`);
    }
    if (final < PRECO_MINIMO) {
      throw erro(400, `Com esse desconto, o ${l.ordem}º lote de ${l.tipo} ficaria abaixo de R$ 5,00.`);
    }
  }
}

// R1: mensagem clara quando o índice único barra a segunda campanha de
// indicação não acumulável ativa (inclusive em duas ativações simultâneas).
function ativaR1(err) {
  if (err.code === '23505' && /ux_campanha_indicacao_exclusiva/.test(err.constraint || err.message)) {
    throw erro(
      409,
      'Já existe outra campanha de indicação não acumulável ativa nesta edição. Pause ou encerre a outra, ou marque esta como acumulável.',
      { codigo: 'indicacao_exclusiva' },
    );
  }
  throw err;
}

async function edicaoParaCampanha(cliente, edicaoId) {
  const { rows } = await cliente.query('SELECT id, status FROM edicoes WHERE id = $1 FOR UPDATE', [edicaoId]);
  if (!rows[0]) throw erro(404, 'edição não encontrada');
  if (rows[0].status === 'encerrado') throw erro(409, 'Edição encerrada fica só para consulta.');
  return rows[0];
}

async function criar(edicaoId, dados, autor) {
  const c = lerCampanha(dados);
  const faixas = lerFaixas(dados.faixas, c.modalidade);
  const alvos = c.modalidade === 'indicacao' ? lerAlvos(dados.alvos || []) : lerAlvos(dados.alvos);
  conferirCoerencia(c, faixas, alvos);
  return emTransacao(async (cliente) => {
    await edicaoParaCampanha(cliente, edicaoId);
    const { rows } = await cliente.query(
      `INSERT INTO campanhas (edicao_id, modalidade, nome, descricao, regras, inicio, fim, relampago, acumula,
                              prioridade, escada, limite_por_pessoa, prazo_retirada, inclui_combos,
                              desconto_tipo, desconto_valor, quantidade_promocional)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [
        edicaoId,
        c.modalidade,
        c.nome,
        c.descricao || '',
        c.regras || '',
        c.inicio,
        c.fim,
        c.relampago ?? false,
        c.acumula ?? false,
        c.prioridade ?? 0,
        c.escada ?? 'maior_nivel',
        c.limite_por_pessoa ?? null,
        c.prazo_retirada,
        c.inclui_combos ?? true,
        c.desconto_tipo ?? null,
        c.desconto_valor ?? null,
        c.quantidade_promocional ?? null,
      ],
    );
    const id = rows[0].id;
    await gravarFaixas(cliente, id, edicaoId, faixas);
    if (c.modalidade !== 'indicacao') await gravarAlvos(cliente, id, edicaoId, alvos);
    if (c.modalidade === 'desconto') await conferirPrecos(cliente, { ...c, id });
    await auditar(cliente, autor, 'campanha_criada', 'campanha', id, { edicao_id: edicaoId, modalidade: c.modalidade });
    return obter(id, cliente);
  });
}

// Campanha "em uso": já deu posição, prêmio, conversão ou desconto. A partir
// daí, a configuração que decide quem ganha o quê não muda (justiça).
async function emUso(cliente, id) {
  const { rows } = await cliente.query(
    `SELECT EXISTS (SELECT 1 FROM campanha_posicoes WHERE campanha_id = $1)
         OR EXISTS (SELECT 1 FROM campanha_premios WHERE campanha_id = $1)
         OR EXISTS (SELECT 1 FROM campanha_indicacoes WHERE campanha_id = $1)
         OR EXISTS (SELECT 1 FROM reservas WHERE campanha_id = $1) AS uso`,
    [id],
  );
  return rows[0].uso;
}

const EDITAVEIS_EM_USO = new Set([
  'nome',
  'descricao',
  'regras',
  'fim',
  'prazo_retirada',
  'relampago',
  'quantidade_promocional',
]);

async function atualizar(id, dados, autor) {
  const novo = lerCampanha(dados, true);
  delete novo.modalidade;
  const mudaFaixas = Object.hasOwn(dados, 'faixas');
  const mudaAlvos = Object.hasOwn(dados, 'alvos');
  const estoques = Object.hasOwn(dados, 'estoques') ? dados.estoques : null; // { faixa_id: estoque } — só para mais
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM campanhas WHERE id = $1', [id]);
    const atual = rows[0];
    if (!atual) throw erro(404, 'campanha não encontrada');
    await cliente.query('SELECT 1 FROM edicoes WHERE id = $1 FOR UPDATE', [atual.edicao_id]);
    await cliente.query('SELECT 1 FROM campanhas WHERE id = $1 FOR UPDATE', [id]);
    if (atual.status === 'encerrada') throw erro(409, 'Campanha encerrada fica só para consulta.');
    const usada = await emUso(cliente, id);
    const campos = Object.keys(novo);
    if (usada) {
      const travados = campos.filter((k) => !EDITAVEIS_EM_USO.has(k));
      if (travados.length || mudaFaixas || mudaAlvos) {
        throw erro(
          409,
          'Esta campanha já está em uso: faixas, níveis, alvos, desconto e regras de acumulação não mudam mais. Dá para mudar nome, descrição, regulamento, aumentar estoques e prorrogar o fim.',
          { codigo: 'campanha_em_uso' },
        );
      }
      for (const k of ['fim', 'prazo_retirada']) {
        if (k in novo && atual[k] && (!novo[k] || novo[k] < new Date(atual[k]))) {
          throw erro(409, 'Com a campanha em uso, o fim e o prazo de retirada só podem ser prorrogados.');
        }
      }
      if ('quantidade_promocional' in novo && novo.quantidade_promocional < atual.quantidade_promocional) {
        throw erro(409, 'Com a campanha em uso, a quantidade promocional só pode aumentar.');
      }
    }
    if ('regras' in novo && novo.regras !== atual.regras && atual.status === 'ativa') {
      throw erro(409, 'Pause a campanha antes de mudar o regulamento — o texto novo precisa de nova revisão jurídica.');
    }
    const faixasAtuais = (
      await cliente.query('SELECT * FROM campanha_faixas WHERE campanha_id = $1 ORDER BY ordem', [id])
    ).rows;
    const faixas = mudaFaixas ? lerFaixas(dados.faixas, atual.modalidade) : faixasAtuais;
    const alvos = mudaAlvos
      ? lerAlvos(dados.alvos)
      : (await cliente.query('SELECT categoria_id, lote_id FROM campanha_alvos WHERE campanha_id = $1', [id])).rows;
    const final = { ...atual, ...novo };
    conferirCoerencia(final, faixas, alvos);
    if (campos.length) {
      const sets = campos.map((k, i) => `${k} = $${i + 2}`);
      // Regulamento mudou: a revisão jurídica anterior não vale mais (C7).
      if ('regras' in novo && novo.regras !== atual.regras) {
        sets.push('regras_revisadas_em = NULL', 'regras_revisadas_por = NULL');
      }
      await cliente.query(`UPDATE campanhas SET ${sets.join(', ')}, atualizado_em = now() WHERE id = $1`, [
        id,
        ...campos.map((k) => novo[k]),
      ]);
    }
    if (mudaFaixas) {
      await cliente.query('DELETE FROM campanha_faixas WHERE campanha_id = $1', [id]);
      await gravarFaixas(cliente, id, atual.edicao_id, faixas);
    }
    if (mudaAlvos) {
      await cliente.query('DELETE FROM campanha_alvos WHERE campanha_id = $1', [id]);
      await gravarAlvos(cliente, id, atual.edicao_id, alvos);
    }
    if (estoques) {
      for (const [faixaId, valor] of Object.entries(estoques)) {
        const f = faixasAtuais.find((x) => Number(x.id) === Number(faixaId));
        if (!f) throw erro(400, 'faixa que não é desta campanha');
        const e = v.inteiro(valor, { campo: 'o estoque', min: 1, max: 1000000 });
        if (f.estoque && e < f.estoque) throw erro(409, 'O estoque de uma faixa só pode aumentar.');
        if (f.ate && e > f.ate - f.de + 1) throw erro(400, 'O estoque não pode passar do número de posições da faixa.');
        await cliente.query('UPDATE campanha_faixas SET estoque = $2 WHERE id = $1', [f.id, e]);
      }
    }
    if (atual.modalidade === 'desconto') await conferirPrecos(cliente, final);
    await auditar(cliente, autor, 'campanha_alterada', 'campanha', id, {
      campos: [
        ...campos,
        ...(mudaFaixas ? ['faixas'] : []),
        ...(mudaAlvos ? ['alvos'] : []),
        ...(estoques ? ['estoques'] : []),
      ],
    });
    return obter(id, cliente);
  });
}

// C7: o Admin registra que o regulamento passou pela revisão jurídica (quem
// revisou). Sem isso a campanha não ativa. Mudar o texto apaga a marca.
async function marcarRegrasRevisadas(id, dados, autor) {
  const revisor = v.texto(dados?.revisor, { campo: 'quem revisou', obrigatorio: true, min: 3, max: 200 });
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM campanhas WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw erro(404, 'campanha não encontrada');
    if (!rows[0].regras.trim()) throw erro(409, 'Escreva o regulamento antes de marcar a revisão.');
    await cliente.query(
      'UPDATE campanhas SET regras_revisadas_em = now(), regras_revisadas_por = $2, atualizado_em = now() WHERE id = $1',
      [id, revisor],
    );
    await auditar(cliente, autor, 'campanha_regras_revisadas', 'campanha', id, { revisor });
    return obter(id, cliente);
  });
}

const TRANSICOES = {
  ativar: { de: ['rascunho', 'pausada'], para: 'ativa' },
  pausar: { de: ['ativa'], para: 'pausada' },
  retomar: { de: ['pausada'], para: 'ativa' },
  encerrar: { de: ['rascunho', 'ativa', 'pausada'], para: 'encerrada' },
};

// Antes de ativar (ou retomar): configuração completa e coerente, regulamento
// revisado (C7), preços e quantidade promocional que cabem no estoque real.
async function conferirAtivacao(cliente, c) {
  const { rows: f } = await cliente.query('SELECT * FROM campanha_faixas WHERE campanha_id = $1', [c.id]);
  if (c.modalidade !== 'desconto' && !f.length) throw erro(409, 'A campanha precisa de ao menos uma faixa ou nível.');
  if (!String(c.regras || '').trim() || !c.regras_revisadas_em) {
    throw erro(409, 'O regulamento precisa estar escrito e marcado como revisado pelo jurídico antes de ativar (C7).', {
      codigo: 'regulamento_sem_revisao',
    });
  }
  if (c.fim && new Date(c.fim) <= new Date()) throw erro(409, 'O fim desta campanha já passou.');
  if (c.modalidade === 'desconto') {
    await conferirPrecos(cliente, c);
    const lotes = await lotesDoDesconto(cliente, c.id);
    const { carregarLotes, estadoDaCategoria } = require('./disponibilidade');
    const porCat = await carregarLotes(cliente, [...new Set(lotes.map((l) => Number(l.categoria_id)))]);
    let livres = 0;
    for (const l of lotes) {
      const e = estadoDaCategoria(porCat.get(Number(l.categoria_id)) || []).lotes.find(
        (x) => Number(x.id) === Number(l.id),
      );
      if (e && !e.fechado) livres += e.disponivel;
    }
    const usados = await usosDoDesconto(cliente, c.id);
    if (c.quantidade_promocional - usados > livres) {
      throw erro(
        409,
        `A quantidade promocional (${c.quantidade_promocional - usados} restantes) passa do estoque real dos lotes (${livres}). Diminua a quantidade ou aumente os lotes.`,
        { codigo: 'promocao_acima_do_estoque' },
      );
    }
  }
}

async function mudarStatus(id, acao, autor) {
  const t = TRANSICOES[acao];
  if (!t) throw erro(400, 'ação inválida');
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM campanhas WHERE id = $1', [id]);
    const c = rows[0];
    if (!c) throw erro(404, 'campanha não encontrada');
    // Mesma ordem de travas da confirmação de pagamento: edição, depois a
    // campanha. Pausar/encerrar no meio de uma confirmação espera ela acabar.
    await cliente.query('SELECT 1 FROM edicoes WHERE id = $1 FOR UPDATE', [c.edicao_id]);
    const { rows: atual } = await cliente.query('SELECT * FROM campanhas WHERE id = $1 FOR UPDATE', [id]);
    if (!t.de.includes(atual[0].status)) {
      throw erro(409, `Não dá para ${acao} uma campanha ${atual[0].status}.`);
    }
    if (t.para === 'ativa') await conferirAtivacao(cliente, atual[0]);
    await cliente
      .query(
        `UPDATE campanhas SET status = $2, atualizado_em = now(),
                encerrada_em = CASE WHEN $2 = 'encerrada' THEN now() ELSE NULL END WHERE id = $1`,
        [id, t.para],
      )
      .catch(ativaR1);
    await auditar(cliente, autor, `campanha_${acao}`, 'campanha', id, { de: atual[0].status, para: t.para });
    return obter(id, cliente);
  });
}

// Duplicar: a configuração vira um rascunho novo, sem posições, prêmios nem
// a marca de revisão jurídica (o texto copiado precisa ser revisto).
async function duplicar(id, autor) {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM campanhas WHERE id = $1', [id]);
    const c = rows[0];
    if (!c) throw erro(404, 'campanha não encontrada');
    await edicaoParaCampanha(cliente, c.edicao_id);
    const { rows: novo } = await cliente.query(
      `INSERT INTO campanhas (edicao_id, modalidade, nome, descricao, regras, inicio, fim, relampago, acumula,
                              prioridade, escada, limite_por_pessoa, prazo_retirada, inclui_combos,
                              desconto_tipo, desconto_valor, quantidade_promocional)
       SELECT edicao_id, modalidade, left('Cópia de ' || nome, 80), descricao, regras, inicio, fim, relampago, acumula,
              prioridade, escada, limite_por_pessoa, prazo_retirada, inclui_combos,
              desconto_tipo, desconto_valor, quantidade_promocional
         FROM campanhas WHERE id = $1 RETURNING id`,
      [id],
    );
    const nid = novo[0].id;
    await cliente.query(
      `INSERT INTO campanha_faixas (campanha_id, ordem, de, ate, repete, premio, beneficio_id, quantidade, estoque,
                                    custo_unitario_centavos)
       SELECT $2, ordem, de, ate, repete, premio, beneficio_id, quantidade, estoque, custo_unitario_centavos
         FROM campanha_faixas WHERE campanha_id = $1 ORDER BY ordem`,
      [id, nid],
    );
    await cliente.query(
      'INSERT INTO campanha_alvos (campanha_id, categoria_id, lote_id) SELECT $2, categoria_id, lote_id FROM campanha_alvos WHERE campanha_id = $1',
      [id, nid],
    );
    await auditar(cliente, autor, 'campanha_duplicada', 'campanha', nid, { origem: id });
    return obter(nid, cliente);
  });
}

async function obter(id, cliente = null) {
  const q = cliente ? (s, p) => cliente.query(s, p) : consultar;
  const { rows } = await q('SELECT * FROM campanhas WHERE id = $1', [id]);
  if (!rows[0]) throw erro(404, 'campanha não encontrada');
  const { rows: faixas } = await q('SELECT * FROM campanha_faixas WHERE campanha_id = $1 ORDER BY ordem', [id]);
  const { rows: alvos } = await q('SELECT categoria_id, lote_id FROM campanha_alvos WHERE campanha_id = $1', [id]);
  return { ...rows[0], faixas, alvos };
}

// Lista do Admin: todas as campanhas da edição, com os números de cada uma.
async function listar(edicaoId) {
  const { rows } = await consultar(
    `SELECT c.*,
            (SELECT count(*)::int FROM campanha_posicoes WHERE campanha_id = c.id) AS posicoes,
            (SELECT count(*)::int FROM campanha_indicacoes WHERE campanha_id = c.id AND valida) AS conversoes,
            (SELECT count(*)::int FROM campanha_premios WHERE campanha_id = c.id AND status = 'concedido') AS a_retirar,
            (SELECT count(*)::int FROM campanha_premios WHERE campanha_id = c.id AND status = 'entregue') AS entregues,
            (SELECT count(*)::int FROM campanha_premios WHERE campanha_id = c.id AND status = 'revogado') AS revogados,
            (SELECT count(*)::int FROM campanha_premios WHERE campanha_id = c.id AND status = 'expirado') AS expirados,
            (SELECT COALESCE(sum(valor_centavos), 0)::bigint FROM campanha_premios WHERE campanha_id = c.id AND status IN ('concedido', 'entregue')) AS custo_centavos
       FROM campanhas c WHERE c.edicao_id = $1
      ORDER BY CASE c.status WHEN 'ativa' THEN 0 WHEN 'pausada' THEN 1 WHEN 'rascunho' THEN 2 ELSE 3 END, c.id DESC`,
    [edicaoId],
  );
  const ids = rows.map((r) => Number(r.id));
  const faixas = await faixasDe({ query: (s, p) => consultar(s, p) }, ids);
  const { rows: porFaixa } = ids.length
    ? await consultar(
        `SELECT faixa_id, count(*)::int AS concedidas FROM campanha_premios
          WHERE campanha_id = ANY($1::bigint[]) GROUP BY faixa_id`,
        [ids],
      )
    : { rows: [] };
  const conc = new Map(porFaixa.map((x) => [Number(x.faixa_id), x.concedidas]));
  const alvos = await alvosDe({ query: (s, p) => consultar(s, p) }, ids);
  const lista = [];
  for (const c of rows) {
    const extra =
      c.modalidade === 'desconto' ? { usados: await usosDoDesconto({ query: (s, p) => consultar(s, p) }, c.id) } : {};
    lista.push({
      ...c,
      ...extra,
      faixas: faixas.get(Number(c.id)).map((f) => ({ ...f, concedidas: conc.get(Number(f.id)) || 0 })),
      alvos: alvos.get(Number(c.id)).map((a) => ({ categoria_id: a.categoria_id, lote_id: a.lote_id })),
    });
  }
  return lista;
}

// Detalhe: posições, prêmios e o histórico de cada prêmio (sem CPF nem e-mail).
async function detalhe(id) {
  const c = await obter(id);
  const { rows: posicoes } = await consultar(
    `SELECT po.posicao, po.resultado, po.confirmado_em, po.confirmado_no_checkout_em, po.ingresso_id,
            i.codigo_curto, i.status AS ingresso_status, cat.nome AS tipo, pa.nome AS titular,
            v.nome AS vencedora, f.premio AS faixa_premio
       FROM campanha_posicoes po JOIN ingressos i ON i.id = po.ingresso_id
       JOIN categorias cat ON cat.id = i.categoria_id JOIN participantes pa ON pa.id = i.participante_id
       LEFT JOIN campanhas v ON v.id = po.vencedora_id LEFT JOIN campanha_faixas f ON f.id = po.faixa_id
      WHERE po.campanha_id = $1 ORDER BY po.posicao LIMIT 2000`,
    [id],
  );
  const { rows: premios } = await consultar(
    `SELECT pr.id, pr.premio, pr.status, pr.motivo, pr.concedido_em, pr.entregue_em, pr.so_admin, pr.repeticao,
            CASE WHEN pr.entregue_por LIKE 'operador:%' THEN (SELECT nome FROM operadores WHERE 'operador:' || operadores.id = pr.entregue_por)
                 WHEN pr.entregue_por IS NULL THEN NULL ELSE 'Admin' END AS entregue_por,
            f.de AS nivel, po.posicao, i.codigo_curto,
            COALESCE(pa.nome, cl.nome, o.nome) AS de_quem,
            COALESCE((SELECT json_agg(json_build_object('acao', e.acao, 'motivo', e.motivo, 'em', e.em,
                        'autor', CASE WHEN e.autor LIKE 'operador:%' THEN 'portaria' WHEN e.autor IN ('pagamento', 'sistema', 'migracao') THEN e.autor ELSE 'Admin' END)
                        ORDER BY e.id) FROM campanha_premio_eventos e WHERE e.premio_id = pr.id), '[]') AS historico
       FROM campanha_premios pr JOIN campanha_faixas f ON f.id = pr.faixa_id
       LEFT JOIN campanha_posicoes po ON po.id = pr.posicao_id
       LEFT JOIN ingressos i ON i.id = pr.ingresso_id LEFT JOIN participantes pa ON pa.id = i.participante_id
       LEFT JOIN indicadores ind ON ind.id = pr.indicador_id
       LEFT JOIN clientes cl ON cl.id = ind.cliente_id LEFT JOIN operadores o ON o.id = ind.operador_id
      WHERE pr.campanha_id = $1 ORDER BY (pr.status = 'concedido') DESC, pr.id DESC LIMIT 2000`,
    [id],
  );
  const extra =
    c.modalidade === 'desconto' ? { usados: await usosDoDesconto({ query: (s, p) => consultar(s, p) }, id) } : {};
  return { ...c, ...extra, em_uso: await emUso({ query: (s, p) => consultar(s, p) }, id), posicoes, premios };
}

// ------------------------------------------------ portaria e Minha Conta (PR 3)
const quemNomeSql = (coluna) => `CASE WHEN ${coluna} IS NULL THEN NULL
  WHEN ${coluna} LIKE 'operador:%' THEN (SELECT nome FROM operadores WHERE 'operador:' || operadores.id = ${coluna})
  ELSE 'Admin' END`;

// Prêmios de campanha por ordem de compra de UM ingresso (os que importam na
// portaria: de pé ou expirado — revogado não aparece).
async function premiosDoIngresso(cliente, ingressoId, { travar = false } = {}) {
  const { rows } = await cliente.query(
    `SELECT pr.id, pr.premio AS nome, pr.status, pr.entregue_em, ${quemNomeSql('pr.entregue_por')} AS entregue_por,
            pr.quantidade, c.nome AS campanha, c.prazo_retirada, po.posicao
       FROM campanha_premios pr JOIN campanhas c ON c.id = pr.campanha_id
       LEFT JOIN campanha_posicoes po ON po.id = pr.posicao_id
      WHERE pr.ingresso_id = $1 AND pr.status IN ('concedido', 'entregue', 'expirado')
      ORDER BY pr.id${travar ? ' FOR UPDATE OF pr' : ''}`,
    [ingressoId],
  );
  return rows;
}

const ACAO_TEXTO = {
  concedido: 'liberado',
  entregue: 'retirado',
  revogado: 'revogado',
  expirado: 'expirado',
  restaurado: 'liberado de novo',
  alerta: 'observação',
};
const quemFez = (autor) =>
  autor?.startsWith('operador:')
    ? 'portaria'
    : ['pagamento', 'sistema', 'migracao'].includes(autor)
      ? 'sistema'
      : 'organização';

// "MINHAS PROMOÇÕES E RECOMPENSAS" (§4): só o que é da conta — posições dos
// ingressos que ela comprou, o andamento das campanhas de indicação do link
// dela e o histórico dos prêmios. Nada de outras pessoas.
// ------------------------------------------------- vitrine (página de venda)
// O que a página pública mostra das campanhas (PR 4). Só campanha com o
// regulamento revisado pelo jurídico (C7) aparece — rascunho, pausada e sem
// revisão nunca. Indicação fica na Minha Conta. Nada é prometido além do que
// existe: esgotada aparece como esgotada, e o preço com desconto é o mesmo
// cálculo do pedido (precoComDesconto). Encerrada aparece por 24 h, como aviso.
const VITRINE_ENCERRADA_MS = 24 * 3600 * 1000;

function situacaoNaVitrine(c, agora) {
  const fim = c.encerrada_em || c.fim;
  if (c.status === 'encerrada' || (fim && new Date(fim) <= agora)) return 'encerrada';
  if (c.inicio && new Date(c.inicio) > agora) return 'em_breve';
  return 'ativa';
}

async function paraVitrine(edicaoId, tipos) {
  const agora = new Date();
  const { rows } = await consultar(
    `SELECT * FROM campanhas
      WHERE edicao_id = $1 AND modalidade IN ('desconto', 'ordem_compra') AND regras_revisadas_em IS NOT NULL
        AND (status = 'ativa' OR (status = 'encerrada' AND encerrada_em > now() - interval '24 hours'))
      ORDER BY relampago DESC, id`,
    [edicaoId],
  );
  const visiveis = rows.filter((c) => {
    const fim = c.encerrada_em || c.fim;
    return !fim || new Date(fim) > agora - VITRINE_ENCERRADA_MS;
  });
  const ids = visiveis.map((c) => Number(c.id));
  const db = { query: (s, p) => consultar(s, p) };
  const alvos = await alvosDe(db, ids);
  const usos = await usosDe(db, ids);
  const faixas = await faixasDe(db, ids);
  const { rows: porFaixa } = ids.length
    ? await consultar(
        'SELECT faixa_id, count(*)::int AS n FROM campanha_premios WHERE campanha_id = ANY($1::bigint[]) GROUP BY faixa_id',
        [ids],
      )
    : { rows: [] };
  const concedidas = new Map(porFaixa.map((x) => [Number(x.faixa_id), x.n]));
  const nomeDoTipo = new Map(tipos.map((t) => [Number(t.id), t.nome]));
  const nomesDosAlvos = (lista) =>
    [...new Set(lista.map((a) => nomeDoTipo.get(Number(a.categoria_id))).filter(Boolean))].join(', ') || null;
  const base = (c) => ({
    id: c.id,
    nome: c.nome,
    descricao: c.descricao || null,
    regras: c.regras,
    relampago: c.relampago,
    acumula: c.acumula,
    inicio: c.inicio,
    fim: c.encerrada_em || c.fim,
    limite_por_pessoa: c.limite_por_pessoa,
    situacao: situacaoNaVitrine(c, agora),
  });

  // Promoção de preço por tipo: a melhor que alcança o lote à venda agora.
  const descontos = visiveis.filter((c) => c.modalidade === 'desconto');
  const porTipo = new Map();
  for (const t of tipos) {
    const lote = t.vigente;
    if (!lote) continue;
    const doLote = descontos
      .filter((c) =>
        qualifica({ inclui_combos: false }, alvos.get(Number(c.id)), { categoria_id: t.id, lote_id: lote.id }),
      )
      .map((c) => {
        const preco = precoComDesconto(c, lote.preco_centavos);
        const restam = Math.max(0, c.quantidade_promocional - (usos.get(Number(c.id)) || 0));
        const v = base(c);
        if (v.situacao === 'ativa' && !restam) v.situacao = 'esgotada';
        return { ...v, preco, restam };
      })
      .filter((x) => x.preco < Number(lote.preco_centavos) && x.preco >= PRECO_MINIMO);
    // Valendo agora primeiro (menor preço, P2); depois em breve; depois o
    // aviso de esgotada/encerrada.
    const peso = { ativa: 0, em_breve: 1, esgotada: 2, encerrada: 3 };
    doLote.sort((a, b) => peso[a.situacao] - peso[b.situacao] || a.preco - b.preco || Number(a.id) - Number(b.id));
    const m = doLote[0];
    if (!m) continue;
    const original = Number(lote.preco_centavos);
    porTipo.set(Number(t.id), {
      ...m,
      preco_original_centavos: original,
      preco_centavos: m.situacao === 'ativa' || m.situacao === 'em_breve' ? m.preco : null,
      percentual:
        m.situacao === 'ativa' || m.situacao === 'em_breve'
          ? Math.round(((original - m.preco) / original) * 100)
          : null,
      restam: m.situacao === 'ativa' ? m.restam : 0,
      preco: undefined,
    });
  }

  // Ordem de compra: brinde para as posições, com quanto ainda resta.
  const brindes = visiveis
    .filter((c) => c.modalidade === 'ordem_compra')
    .map((c) => {
      const prox = Number(c.proxima_posicao);
      let restam = 0;
      const premios = faixas.get(Number(c.id)).map((f) => {
        const posicoes = Math.max(0, f.ate - Math.max(f.de, prox) + 1);
        const r = f.estoque
          ? Math.min(posicoes, Math.max(0, f.estoque - (concedidas.get(Number(f.id)) || 0)))
          : posicoes;
        restam += r;
        return { de: f.de, ate: f.ate, premio: f.premio, quantidade: f.quantidade };
      });
      const v = base(c);
      if (v.situacao === 'ativa' && !restam) v.situacao = 'esgotada';
      return {
        ...v,
        premios,
        restam: v.situacao === 'ativa' ? restam : 0,
        tipos: nomesDosAlvos(alvos.get(Number(c.id))),
        inclui_combos: c.inclui_combos,
      };
    });
  return { porTipo, brindes };
}

async function daConta(clienteId) {
  const { rows: posicoes } = await consultar(
    `SELECT po.posicao, po.resultado, c.id AS campanha_id, c.nome AS campanha, c.prazo_retirada, c.edicao_id,
            ev.nome || ' — ' || ed.nome AS evento, i.codigo_curto, i.status AS ingresso_status, cat.nome AS tipo,
            pr.id AS premio_id, pr.premio, pr.status AS premio_status, pr.entregue_em, pr.motivo, v.nome AS vencedora
       FROM campanha_posicoes po JOIN campanhas c ON c.id = po.campanha_id
       JOIN ingressos i ON i.id = po.ingresso_id JOIN pedidos p ON p.id = i.pedido_id
       JOIN categorias cat ON cat.id = i.categoria_id
       JOIN edicoes ed ON ed.id = c.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
       LEFT JOIN campanha_premios pr ON pr.posicao_id = po.id
       LEFT JOIN campanhas v ON v.id = po.vencedora_id
      WHERE p.cliente_id = $1
      ORDER BY ed.inicio_em NULLS LAST, c.id, po.posicao`,
    [clienteId],
  );
  const { rows: ind } = await consultar('SELECT id FROM indicadores WHERE cliente_id = $1', [clienteId]);
  let indicacao = [];
  if (ind[0]) {
    const { rows } = await consultar(
      `SELECT c.id, c.nome, c.escada, c.status, c.prazo_retirada, c.edicao_id, c.limite_por_pessoa,
              ev.nome || ' — ' || ed.nome AS evento,
              (SELECT count(*)::int FROM campanha_indicacoes x WHERE x.campanha_id = c.id AND x.indicador_id = $1 AND x.valida) AS n
         FROM campanhas c JOIN edicoes ed ON ed.id = c.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
        WHERE c.modalidade = 'indicacao'
          AND (EXISTS (SELECT 1 FROM campanha_indicacoes x WHERE x.campanha_id = c.id AND x.indicador_id = $1)
               OR (c.status = 'ativa' AND ed.status = 'publicado'
                   AND (c.inicio IS NULL OR c.inicio <= now()) AND (c.fim IS NULL OR c.fim > now())))
        ORDER BY ed.inicio_em NULLS LAST, c.id`,
      [ind[0].id],
    );
    const ids = rows.map((r) => Number(r.id));
    const faixas = await faixasDe({ query: (sq, pq) => consultar(sq, pq) }, ids);
    const { rows: meus } = ids.length
      ? await consultar(
          `SELECT id, campanha_id, faixa_id, repeticao, status, entregue_em, motivo, premio
             FROM campanha_premios WHERE indicador_id = $1 AND campanha_id = ANY($2::bigint[])
            ORDER BY faixa_id, repeticao NULLS FIRST, id`,
          [ind[0].id, ids],
        )
      : { rows: [] };
    indicacao = rows.map((c) => {
      const niveis = faixas.get(Number(c.id));
      const repete = niveis.length === 1 && niveis[0].repete ? niveis[0] : null;
      const proximo = repete
        ? { de: (Math.floor(c.n / repete.de) + 1) * repete.de, premio: repete.premio }
        : niveis.find((f) => f.de > c.n) || null;
      return {
        campanha: c.nome,
        evento: c.evento,
        status: c.status,
        indicacoes: c.n,
        escada: c.escada,
        repete: Boolean(repete),
        prazo_retirada: c.prazo_retirada,
        proximo: proximo ? { de: proximo.de, premio: proximo.premio, faltam: proximo.de - c.n } : null,
        niveis: niveis.map((f) => ({
          de: f.de,
          premio: f.premio,
          atingido: repete ? c.n >= f.de : c.n >= f.de,
          premios: meus
            .filter((m) => Number(m.faixa_id) === Number(f.id))
            .map((m) => ({ status: m.status, entregue_em: m.entregue_em, motivo: m.motivo, repeticao: m.repeticao })),
        })),
      };
    });
  }
  const { rows: historico } = await consultar(
    `SELECT e.acao, e.autor, e.motivo, e.em, pr.premio, c.nome AS campanha
       FROM campanha_premio_eventos e JOIN campanha_premios pr ON pr.id = e.premio_id
       JOIN campanhas c ON c.id = pr.campanha_id
       LEFT JOIN ingressos i ON i.id = pr.ingresso_id LEFT JOIN pedidos p ON p.id = i.pedido_id
       LEFT JOIN indicadores ind ON ind.id = pr.indicador_id
      WHERE p.cliente_id = $1 OR ind.cliente_id = $1
      ORDER BY e.em DESC, e.id DESC LIMIT 60`,
    [clienteId],
  );
  return {
    posicoes: posicoes.map((x) => ({
      campanha: x.campanha,
      evento: x.evento,
      posicao: x.posicao,
      resultado: x.resultado,
      vencedora: x.vencedora,
      ingresso: x.codigo_curto,
      tipo: x.tipo,
      ingresso_status: x.ingresso_status,
      premio: x.premio_id
        ? {
            nome: x.premio,
            status: x.premio_status,
            entregue_em: x.entregue_em,
            motivo: x.motivo,
            prazo_retirada: x.prazo_retirada,
          }
        : null,
    })),
    indicacao,
    historico: historico.map((h) => ({
      acao: ACAO_TEXTO[h.acao] || h.acao,
      quem: quemFez(h.autor),
      // Na entrega o motivo é só o canal (portaria/admin), que já sai em `quem`.
      motivo: ['alerta', 'entregue'].includes(h.acao) ? null : h.motivo,
      em: h.em,
      premio: h.premio,
      campanha: h.campanha,
    })),
  };
}

function celula(valor) {
  const t = String(valor ?? '');
  const seguro = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return `"${seguro.replace(/"/g, '""')}"`;
}

async function posicoesCsv(id) {
  const d = await detalhe(id);
  const linhas = [
    ['posicao', 'resultado', 'vencedora', 'codigo', 'tipo', 'titular', 'ingresso', 'confirmado_em', 'checkout_em'],
  ];
  for (const p of d.posicoes) {
    linhas.push([
      p.posicao,
      p.resultado,
      p.vencedora || '',
      p.codigo_curto,
      p.tipo,
      p.titular || '',
      p.ingresso_status,
      new Date(p.confirmado_em).toISOString(),
      p.confirmado_no_checkout_em ? new Date(p.confirmado_no_checkout_em).toISOString() : '',
    ]);
  }
  return `﻿${linhas.map((l) => l.map(celula).join(';')).join('\r\n')}\r\n`;
}

module.exports = {
  aoConfirmar,
  revisarPedido,
  reconciliarIndicador,
  entregarPremio,
  expirarVencidos,
  criar,
  atualizar,
  marcarRegrasRevisadas,
  mudarStatus,
  duplicar,
  obter,
  listar,
  detalhe,
  posicoesCsv,
  precoComDesconto,
  descontosVigentes,
  paraVitrine,
  descontosDoLote,
  repartirComDesconto,
  descontoAindaCabe,
  usosDoDesconto,
  premiosDoIngresso,
  daConta,
  brindeDe,
  DE_PE,
  PRECO_MINIMO,
};
