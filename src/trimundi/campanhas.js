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
    `SELECT i.id, i.categoria_id, i.lote_id, i.promocao_id, ${colunasDeNumero('i')}
       FROM ingressos i WHERE i.pedido_id = $1 AND i.origem = 'pago' AND i.status = 'valido'
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
    escolherVencedoras(posicoes.filter((x) => !x.resultado));
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
function escolherVencedoras(candidatas) {
  const naoAcumulaveis = candidatas.filter((x) => !x.campanha.acumula).sort(melhorPrimeiro);
  const vencedora = naoAcumulaveis[0] || null;
  for (const perdeu of naoAcumulaveis.slice(1)) Object.assign(perdeu, { resultado: 'nao_acumulavel', vencedora });
  const levadas = vencedora ? [vencedora] : [];
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
// As telas novas vêm no PR 2; aqui ficam as regras (criar, ativar, pausar,
// retomar, encerrar, duplicar) que elas vão usar — e que os testes cobrem.

function lerCampanha(d = {}, parcial = false) {
  const tem = (k) => !parcial || Object.hasOwn(d, k);
  const out = {};
  if (!parcial) out.modalidade = v.escolha(d.modalidade, ['ordem_compra', 'indicacao'], { campo: 'a modalidade' });
  if (tem('nome')) out.nome = v.texto(d.nome, { campo: 'o nome da campanha', obrigatorio: true, max: 80 });
  if (tem('descricao')) out.descricao = v.texto(d.descricao, { campo: 'a descrição', max: 1000 });
  if (tem('regras')) out.regras = v.texto(d.regras, { campo: 'as regras', max: 5000 });
  if (tem('inicio')) out.inicio = v.dataHora(d.inicio, { campo: 'o início' });
  if (tem('fim')) out.fim = v.dataHora(d.fim, { campo: 'o fim' });
  if (out.inicio && out.fim && out.fim <= out.inicio) throw erro(400, 'O fim precisa ser depois do início.');
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
  return out;
}

function lerFaixas(lista, modalidade) {
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
    const categoria = a.categoria_id ? v.id(a.categoria_id, 'tipo') : null;
    const lote = a.lote_id ? v.id(a.lote_id, 'lote') : null;
    if (!categoria && !lote) throw erro(400, 'Alvo sem tipo nem lote.');
    const { rows } = await cliente.query(
      `SELECT 1 FROM categorias c LEFT JOIN lotes l ON l.id = $3
        WHERE c.edicao_id = $1 AND ($2::bigint IS NULL OR c.id = $2)
          AND ($3::bigint IS NULL OR l.categoria_id = c.id) LIMIT 1`,
      [edicaoId, categoria, lote],
    );
    if (!rows.length) throw erro(400, 'Tipo ou lote que não é desta edição.');
    await cliente.query('INSERT INTO campanha_alvos (campanha_id, categoria_id, lote_id) VALUES ($1, $2, $3)', [
      campanhaId,
      categoria,
      lote,
    ]);
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

async function criar(edicaoId, dados, autor) {
  const c = lerCampanha(dados);
  const faixas = lerFaixas(dados.faixas, c.modalidade);
  return emTransacao(async (cliente) => {
    const { rows: ed } = await cliente.query('SELECT id FROM edicoes WHERE id = $1 FOR UPDATE', [edicaoId]);
    if (!ed[0]) throw erro(404, 'edição não encontrada');
    const { rows } = await cliente.query(
      `INSERT INTO campanhas (edicao_id, modalidade, nome, descricao, regras, inicio, fim, relampago, acumula,
                              prioridade, escada, limite_por_pessoa, prazo_retirada, inclui_combos)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
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
      ],
    );
    const id = rows[0].id;
    await gravarFaixas(cliente, id, edicaoId, faixas);
    if (c.modalidade === 'ordem_compra') await gravarAlvos(cliente, id, edicaoId, dados.alvos);
    await auditar(cliente, autor, 'campanha_criada', 'campanha', id, { edicao_id: edicaoId, modalidade: c.modalidade });
    return obter(id, cliente);
  });
}

const TRANSICOES = {
  ativar: { de: ['rascunho', 'pausada'], para: 'ativa' },
  pausar: { de: ['ativa'], para: 'pausada' },
  retomar: { de: ['pausada'], para: 'ativa' },
  encerrar: { de: ['rascunho', 'ativa', 'pausada'], para: 'encerrada' },
};

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
    if (t.para === 'ativa') {
      const { rows: f } = await cliente.query('SELECT count(*)::int AS n FROM campanha_faixas WHERE campanha_id = $1', [
        id,
      ]);
      if (!f[0].n) throw erro(409, 'A campanha precisa de ao menos uma faixa ou nível.');
    }
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

// Duplicar: a configuração vira um rascunho novo, sem posições nem prêmios.
async function duplicar(id, autor) {
  return emTransacao(async (cliente) => {
    const { rows } = await cliente.query('SELECT * FROM campanhas WHERE id = $1', [id]);
    const c = rows[0];
    if (!c) throw erro(404, 'campanha não encontrada');
    const { rows: novo } = await cliente.query(
      `INSERT INTO campanhas (edicao_id, modalidade, nome, descricao, regras, inicio, fim, relampago, acumula,
                              prioridade, escada, limite_por_pessoa, prazo_retirada, inclui_combos)
       SELECT edicao_id, modalidade, left('Cópia de ' || nome, 80), descricao, regras, inicio, fim, relampago, acumula,
              prioridade, escada, limite_por_pessoa, prazo_retirada, inclui_combos
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

module.exports = {
  aoConfirmar,
  revisarPedido,
  reconciliarIndicador,
  entregarPremio,
  expirarVencidos,
  criar,
  mudarStatus,
  duplicar,
  obter,
  brindeDe,
  DE_PE,
};
