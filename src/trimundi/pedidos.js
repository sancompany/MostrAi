const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { token, hashToken } = require('./lib/codigos');
const { medir } = require('./lib/registro');
const { conteudoDoQr, qrDataUrl } = require('./lib/qr');
const config = require('./config');
const { travarEdicao } = require('./eventos');
const {
  carregarLotes,
  criarAlocador,
  combosVendidos,
  compradosPorCpf,
  ocupacaoDaEdicao,
  situacaoDoCombo,
} = require('./disponibilidade');

// Pedido (RN-T12 a RN-T14, RN-T17): cotação sem trava (o que o comprador
// confere) e criação com a trava da edição (o que vale). O pedido reserva
// as vagas por 30 min — o mesmo prazo vai como `expiraEm` para o Checkout,
// que recusa cobrar depois dele (API.md §4.1.2): o estoque nunca passa da
// quantidade (decisão do dono, 09/11/2026).

const RESERVA_MINUTOS = 30;
const MAX_INGRESSOS = 20;
const MAX_COMBOS_POR_ITEM = 10;

async function edicaoPorEndereco(cliente, evento, edicao) {
  const { rows } = await cliente.query(
    `SELECT ed.*, ev.nome AS evento_nome, ev.slug AS evento_slug
       FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id
      WHERE lower(ev.slug) = lower($1) AND lower(ed.slug) = lower($2)`,
    [String(evento ?? ''), String(edicao ?? '')],
  );
  return rows[0] || null;
}

function lerItens(itens = {}) {
  const tipos = new Map();
  for (const t of Array.isArray(itens.tipos) ? itens.tipos : []) {
    const id = v.id(t?.categoria_id, 'ingresso');
    const q = v.inteiro(t?.quantidade, { campo: 'a quantidade', min: 0, max: MAX_INGRESSOS });
    if (q > 0) tipos.set(id, (tipos.get(id) || 0) + q);
  }
  const combos = new Map();
  for (const c of Array.isArray(itens.combos) ? itens.combos : []) {
    const id = v.id(c?.promocao_id, 'promoção');
    const q = v.inteiro(c?.quantidade, { campo: 'a quantidade', min: 0, max: MAX_COMBOS_POR_ITEM });
    if (q > 0) combos.set(id, (combos.get(id) || 0) + q);
  }
  if (!tipos.size && !combos.size) throw erro(400, 'Escolha pelo menos um ingresso.');
  return { tipos, combos };
}

// Monta o pedido em memória com o estoque de agora. `marcar` = criação: os
// lotes que esgotarem são devolvidos para gravar a marca.
async function montar(cliente, ed, pedido) {
  const { tipos, combos } = pedido;
  const { rows: categorias } = await cliente.query('SELECT * FROM categorias WHERE edicao_id = $1 ORDER BY ordem, id', [
    ed.id,
  ]);
  const catPorId = new Map(categorias.map((c) => [Number(c.id), c]));
  for (const id of tipos.keys()) {
    const c = catPorId.get(id);
    if (!c) throw erro(400, 'ingresso que não é desta edição');
    if (!c.ativo) throw erro(409, `${c.nome} não está à venda.`);
  }
  const { rows: promos } = combos.size
    ? await cliente.query('SELECT * FROM promocoes WHERE edicao_id = $1 AND id = ANY($2::bigint[]) ORDER BY id', [
        ed.id,
        [...combos.keys()],
      ])
    : { rows: [] };
  if (promos.length !== combos.size) throw erro(400, 'promoção que não é desta edição');
  const { rows: itensPromo } = promos.length
    ? await cliente.query(
        'SELECT * FROM promocao_itens WHERE promocao_id = ANY($1::bigint[]) ORDER BY promocao_id, ordem',
        [promos.map((p) => p.id)],
      )
    : { rows: [] };
  for (const it of itensPromo) {
    if (!catPorId.get(Number(it.categoria_id))?.ativo) {
      throw erro(409, 'Esta promoção não está disponível agora.');
    }
  }
  const categoriasUsadas = [...new Set([...tipos.keys(), ...itensPromo.map((i) => Number(i.categoria_id))])];
  const lotes = await carregarLotes(cliente, categoriasUsadas);
  const vendidos = await combosVendidos(
    cliente,
    promos.map((p) => p.id),
  );
  const agora = new Date();
  const alocador = criarAlocador(lotes, agora);
  const numeroDoLote = (catId, loteId) =>
    (alocador.estado(catId)?.lotes.findIndex((l) => Number(l.id) === Number(loteId)) ?? -1) + 1;

  const linhas = [];
  const vagas = [];
  const tiposOrdenados = [...tipos.entries()].sort(
    ([a], [b]) => catPorId.get(a).ordem - catPorId.get(b).ordem || a - b,
  );
  for (const [catId, q] of tiposOrdenados) {
    const cat = catPorId.get(catId);
    for (const parte of alocador.tirar(catId, q, cat.nome)) {
      const linha = {
        lote_id: parte.lote.id,
        promocao_id: null,
        descricao: `${cat.nome} — ${numeroDoLote(catId, parte.lote.id)}º lote`,
        quantidade: parte.quantidade,
        preco_unitario_centavos: parte.lote.preco_centavos,
        reservas: [],
      };
      for (let i = 0; i < parte.quantidade; i++) {
        linha.reservas.push({
          categoria_id: catId,
          lote_id: parte.lote.id,
          promocao_item_id: null,
          valor_centavos: parte.lote.preco_centavos,
        });
        vagas.push({ categoria_id: catId, categoria_nome: cat.nome, origem: 'tipo', combo_nome: null });
      }
      linhas.push(linha);
    }
  }
  for (const promo of promos) {
    const q = combos.get(Number(promo.id));
    const meus = itensPromo.filter((i) => Number(i.promocao_id) === Number(promo.id));
    const usados = vendidos.get(Number(promo.id)) || { pagos: 0, reservados: 0 };
    const situacao = situacaoDoCombo(promo, meus, usados, alocador, agora);
    if (situacao !== 'a_venda')
      throw erro(409, `A promoção ${promo.nome} não está disponível agora.`, { codigo: 'esgotado' });
    const livres = promo.quantidade - usados.pagos - usados.reservados;
    if (q > livres)
      throw erro(409, `Restam só ${livres} da promoção ${promo.nome}.`, { codigo: 'esgotado', disponivel: livres });
    const porCombo = meus.reduce((s, i) => s + i.quantidade, 0);
    const base = Math.floor(promo.preco_total_centavos / porCombo);
    const resto = promo.preco_total_centavos - base * porCombo;
    const linha = {
      lote_id: null,
      promocao_id: promo.id,
      descricao: `Promoção ${promo.nome}`,
      quantidade: q,
      preco_unitario_centavos: promo.preco_total_centavos,
      reservas: [],
    };
    for (let u = 0; u < q; u++) {
      let posicaoNoCombo = 0;
      for (const it of meus) {
        const cat = catPorId.get(Number(it.categoria_id));
        for (const parte of alocador.tirar(
          Number(it.categoria_id),
          it.quantidade,
          `${cat.nome} (promoção ${promo.nome})`,
        )) {
          for (let j = 0; j < parte.quantidade; j++) {
            posicaoNoCombo += 1;
            linha.reservas.push({
              categoria_id: Number(it.categoria_id),
              lote_id: parte.lote.id,
              promocao_item_id: it.id,
              valor_centavos: base + (posicaoNoCombo === 1 ? resto : 0),
            });
            vagas.push({
              categoria_id: Number(it.categoria_id),
              categoria_nome: cat.nome,
              origem: 'combo',
              combo_nome: promo.nome,
            });
          }
        }
      }
    }
    linhas.push(linha);
  }
  if (vagas.length > MAX_INGRESSOS) throw erro(400, `No máximo ${MAX_INGRESSOS} ingressos por pedido.`);
  const total = linhas.reduce((s, l) => s + l.quantidade * l.preco_unitario_centavos, 0);
  return { linhas, vagas, total, catPorId, tiposOrdenados };
}

async function termosVigentes(cliente, edicaoId) {
  const { rows } = await cliente.query(
    "SELECT id, tipo, versao, hash_sha256 FROM termos WHERE edicao_id = $1 AND vigente ORDER BY array_position(ARRAY['regras_entrada','condicoes_especiais','termos_compra'], tipo)",
    [edicaoId],
  );
  return rows;
}

// Venda só com a edição publicada. Pedido de TESTE (criado pelo Admin, fora
// das métricas) também vale em rascunho e pausada: dá para conferir o fluxo
// inteiro, com o Checkout de verdade, antes de abrir as vendas.
function conferirVenda(ed, origem = 'venda') {
  if (!ed) throw erro(404, 'evento não encontrado');
  if (origem === 'teste' && ['rascunho', 'publicado', 'pausado'].includes(ed.status)) return;
  if (ed.status !== 'publicado') {
    throw erro(
      409,
      ed.status === 'pausado' ? 'As vendas estão pausadas.' : 'As vendas desta edição não estão abertas.',
    );
  }
}

function linhasPublicas(linhas) {
  return linhas.map((l) => ({
    descricao: l.descricao,
    quantidade: l.quantidade,
    preco_unitario_centavos: l.preco_unitario_centavos,
    total_centavos: l.quantidade * l.preco_unitario_centavos,
  }));
}

// O que o comprador confere antes de aceitar os termos (sem reservar nada).
async function cotar(corpo) {
  const pedido = lerItens(corpo?.itens);
  const cliente = { query: (s, p) => consultar(s, p) };
  const ed = await edicaoPorEndereco(cliente, corpo?.evento, corpo?.edicao);
  conferirVenda(ed);
  const m = await montar(cliente, ed, pedido);
  return {
    itens: linhasPublicas(m.linhas),
    total_centavos: m.total,
    vagas: m.vagas.map((x, i) => ({ numero: i + 1, ...x })),
    termos: (await termosVigentes(cliente, ed.id)).map((t) => ({ id: t.id, tipo: t.tipo, versao: t.versao })),
  };
}

function lerPessoa(p, rotulo) {
  return {
    nome: v.texto(p?.nome, {
      campo: `o nome ${rotulo}`,
      obrigatorio: true,
      min: 2,
      max: 120,
      mensagem: `Informe o nome ${rotulo}.`,
    }),
    cpf: v.cpf(p?.cpf, { mensagem: `CPF ${rotulo} inválido — confira os números.` }),
    email: v.email(p?.email),
  };
}

function linkDePagamento(pedidoId, tk) {
  const ck = config.checkout();
  const voltar = `${config.urlDoSite()}/ticket/pedido/${pedidoId}?t=${encodeURIComponent(tk)}`;
  if (ck.configurado) {
    return {
      modo: 'checkout',
      url: `${ck.baseUrl}/index.html?c=${encodeURIComponent(ck.contratanteId)}&pedido=${pedidoId}&returnUrl=${encodeURIComponent(voltar)}`,
    };
  }
  if (config.pagamentoSimulado())
    return { modo: 'simulado', url: `/ticket/dev/pagamento/${pedidoId}?t=${encodeURIComponent(tk)}` };
  return { modo: null, url: null };
}

async function novoAcesso(cliente, pedidoId, origem) {
  const tk = token();
  await cliente.query('INSERT INTO pedido_acessos (pedido_id, token_hash, origem) VALUES ($1, $2, $3)', [
    pedidoId,
    hashToken(tk),
    origem,
  ]);
  return tk;
}

async function criar(corpo, contexto = {}) {
  const pedido = lerItens(corpo?.itens);
  const comprador = {
    ...lerPessoa(corpo?.comprador, 'do comprador'),
    telefone: v.telefone(corpo?.comprador?.telefone),
  };
  const participantes = Array.isArray(corpo?.participantes) ? corpo.participantes : [];
  const chave = v.chave(corpo?.chave);
  if (corpo?.aceite?.aceito !== true) throw erro(400, 'É preciso aceitar os termos para continuar.');
  const termosAceitos = new Set((Array.isArray(corpo?.aceite?.termos) ? corpo.aceite.termos : []).map(Number));
  const origem = contexto.origem === 'teste' ? 'teste' : 'venda';

  return emTransacao(async (cliente) => {
    const achada = await edicaoPorEndereco(cliente, corpo?.evento, corpo?.edicao);
    if (!achada) throw erro(404, 'evento não encontrado');
    const ed = await travarEdicao(cliente, achada.id);
    ed.evento_nome = achada.evento_nome;
    const { rows: existente } = await cliente.query('SELECT id FROM pedidos WHERE chave_idempotencia = $1', [chave]);
    if (existente[0]) {
      const tk = await novoAcesso(cliente, existente[0].id, 'compra');
      return { pedido_id: existente[0].id, token: tk, repetido: true, pagamento: linkDePagamento(existente[0].id, tk) };
    }
    conferirVenda(ed, origem);
    const m = await montar(cliente, ed, pedido);
    if (participantes.length !== m.vagas.length) {
      throw erro(400, 'Preencha os dados de cada participante.', { codigo: 'participantes' });
    }
    const pessoas = participantes.map((p, i) => lerPessoa(p, `do participante ${i + 1}`));

    const termos = await termosVigentes(cliente, ed.id);
    if (termos.length !== termosAceitos.size || termos.some((t) => !termosAceitos.has(Number(t.id)))) {
      throw erro(409, 'Os termos mudaram — confira de novo antes de continuar.', { codigo: 'termos' });
    }

    // Limite por comprador, contando o que este CPF já tem nesta edição.
    const comLimite = m.tiposOrdenados.filter(([id]) => m.catPorId.get(id).limite_por_comprador);
    if (comLimite.length) {
      const ja = await compradosPorCpf(
        cliente,
        ed.id,
        comprador.cpf,
        comLimite.map(([id]) => id),
      );
      for (const [id, q] of comLimite) {
        const cat = m.catPorId.get(id);
        if ((ja.get(id) || 0) + q > cat.limite_por_comprador) {
          throw erro(409, `O limite é de ${cat.limite_por_comprador} ${cat.nome} por comprador.`, { codigo: 'limite' });
        }
      }
    }
    if (ed.capacidade && (await ocupacaoDaEdicao(cliente, ed.id)) + m.vagas.length > ed.capacidade) {
      throw erro(409, 'Não há mais vaga nesta edição.', { codigo: 'esgotado' });
    }

    const { rows: comp } = await cliente.query(
      'INSERT INTO compradores (nome, cpf, email, telefone) VALUES ($1, $2, $3, $4) RETURNING id',
      [comprador.nome, comprador.cpf, comprador.email, comprador.telefone],
    );
    const { rows: ped } = await cliente.query(
      `INSERT INTO pedidos (edicao_id, comprador_id, origem, total_centavos, reserva_expira_em, chave_idempotencia)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5), $6) RETURNING id, reserva_expira_em`,
      [ed.id, comp[0].id, origem, m.total, RESERVA_MINUTOS, chave],
    );
    const pedidoId = ped[0].id;
    let vaga = 0;
    for (const [ordem, l] of m.linhas.entries()) {
      const { rows: pi } = await cliente.query(
        `INSERT INTO pedido_itens (pedido_id, lote_id, promocao_id, descricao, quantidade, preco_unitario_centavos, total_centavos, ordem)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          pedidoId,
          l.lote_id,
          l.promocao_id,
          l.descricao,
          l.quantidade,
          l.preco_unitario_centavos,
          l.quantidade * l.preco_unitario_centavos,
          ordem + 1,
        ],
      );
      for (const [posicao, r] of l.reservas.entries()) {
        const p = pessoas[vaga++];
        const { rows: part } = await cliente.query(
          'INSERT INTO participantes (edicao_id, nome, cpf, email) VALUES ($1, $2, $3, $4) RETURNING id',
          [ed.id, p.nome, p.cpf, p.email],
        );
        await cliente.query(
          `INSERT INTO reservas (pedido_id, pedido_item_id, posicao, categoria_id, lote_id, promocao_item_id, participante_id, valor_centavos)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            pedidoId,
            pi[0].id,
            posicao + 1,
            r.categoria_id,
            r.lote_id,
            r.promocao_item_id,
            part[0].id,
            r.valor_centavos,
          ],
        );
      }
    }
    for (const t of termos) {
      await cliente.query(
        'INSERT INTO aceites (pedido_id, termo_id, hash_sha256, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [
          pedidoId,
          t.id,
          t.hash_sha256,
          contexto.ip ? String(contexto.ip).slice(0, 64) : null,
          contexto.userAgent ? String(contexto.userAgent).slice(0, 300) : null,
        ],
      );
    }
    const tk = await novoAcesso(cliente, pedidoId, 'compra');
    await medir(cliente, 'venda:pedido_cria', ed.id, {
      ingressos_quantidade: m.vagas.length,
      total_centavos: m.total,
      origem,
    });
    return {
      pedido_id: pedidoId,
      token: tk,
      repetido: false,
      total_centavos: m.total,
      reserva_expira_em: ped[0].reserva_expira_em,
      pagamento: linkDePagamento(pedidoId, tk),
    };
  });
}

// Pedido de teste pelo Admin: mesmo caminho do comprador (estoque, reserva,
// Checkout, emissão), marcado `teste` — fica fora de venda, receita e
// métricas (D1). O aceite registrado é o dos termos vigentes, em nome de
// quem testa (o autor fica na auditoria).
async function criarTeste(edicaoId, corpo, autor) {
  // RN-T19: pedido de teste só fora de produção. Liberar em produção (para
  // homologar o Checkout de verdade) é decisão do dono — pendencias.md.
  if (config.producao()) throw erro(403, 'Pedido de teste só fora de produção.');
  const { rows } = await consultar(
    'SELECT ed.id, ed.slug, ev.slug AS evento_slug FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id WHERE ed.id = $1',
    [edicaoId],
  );
  if (!rows[0]) throw erro(404, 'edição não encontrada');
  const termos = await termosVigentes({ query: (s, p) => consultar(s, p) }, edicaoId);
  const r = await criar(
    {
      ...corpo,
      evento: rows[0].evento_slug,
      edicao: rows[0].slug,
      aceite: { aceito: true, termos: termos.map((t) => t.id) },
      chave: corpo?.chave || `teste-${token().slice(0, 24)}`,
    },
    { origem: 'teste', ip: null, userAgent: 'admin' },
  );
  await emTransacao((cliente) =>
    require('./lib/registro').auditar(cliente, autor, 'pedido_teste_criado', 'pedido', r.pedido_id, {
      edicao_id: Number(edicaoId),
    }),
  );
  return { ...r, url: `/ticket/pedido/${r.pedido_id}?t=${encodeURIComponent(r.token)}` };
}

async function acessoValido(pedidoId, tk) {
  const id = v.uuid(pedidoId);
  if (!id || typeof tk !== 'string' || tk.length < 20 || tk.length > 64) return null;
  const { rows } = await consultar(
    'SELECT 1 FROM pedido_acessos WHERE pedido_id = $1 AND token_hash = $2 AND revogado_em IS NULL',
    [id, hashToken(tk)],
  );
  return rows.length ? id : null;
}

// Pedido aguardando que passou do prazo vira expirado (as vagas já tinham
// voltado ao estoque quando a reserva venceu).
async function expirarVencidos(pedidoId = null) {
  const { rows } = await consultar(
    `UPDATE pedidos SET status = 'expirado', encerrado_em = now()
      WHERE status = 'aguardando_pagamento' AND reserva_expira_em <= now() AND ($1::uuid IS NULL OR id = $1)
      RETURNING id, edicao_id, total_centavos, origem`,
    [pedidoId],
  );
  for (const p of rows) {
    await consultar('INSERT INTO metricas (nome, edicao_id, propriedades) VALUES ($1, $2, $3)', [
      'venda:pedido_expira',
      p.edicao_id,
      { total_centavos: p.total_centavos, origem: p.origem },
    ]);
  }
  return rows.length;
}

const ROTULO_PEDIDO = {
  aguardando_pagamento: 'Aguardando pagamento',
  pago: 'Pago',
  cancelado: 'Cancelado',
  expirado: 'Expirado',
  estornado: 'Reembolsado',
  pago_sem_vaga: 'Pago — em devolução',
};

// O que a página do pedido mostra para quem tem o link (RN-T23).
async function paraComprador(pedidoId, tk) {
  const id = await acessoValido(pedidoId, tk);
  if (!id) throw erro(404, 'pedido não encontrado');
  await expirarVencidos(id);
  const { rows } = await consultar(
    `SELECT p.*, ed.nome AS edicao_nome, ed.slug AS edicao_slug, ed.inicio_em, ed.local_nome, ed.logradouro, ed.numero,
            ed.bairro, ed.cidade, ed.uf, ev.nome AS evento_nome, ev.slug AS evento_slug, ed.codigo_publico,
            (SELECT url FROM edicao_imagens WHERE edicao_id = ed.id AND tipo = 'banner') AS banner
       FROM pedidos p JOIN edicoes ed ON ed.id = p.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      WHERE p.id = $1`,
    [id],
  );
  const p = rows[0];
  const { rows: itens } = await consultar(
    'SELECT descricao, quantidade, preco_unitario_centavos, total_centavos FROM pedido_itens WHERE pedido_id = $1 ORDER BY ordem',
    [id],
  );
  let ingressos = [];
  if (['pago', 'estornado', 'pago_sem_vaga'].includes(p.status)) {
    const { rows: ing } = await consultar(
      `SELECT i.id, i.codigo, i.codigo_curto, i.status, c.nome AS categoria, pa.nome AS participante,
              pr.nome AS promocao,
              (SELECT registrado_em FROM checkins ck WHERE ck.ingresso_id = i.id AND ck.escopo = 'entrada' AND ck.resultado = 'aceito') AS utilizado_em,
              COALESCE((SELECT json_agg(ib.nome ORDER BY ib.nome) FROM ingresso_beneficios ib WHERE ib.ingresso_id = i.id), '[]') AS beneficios
         FROM ingressos i JOIN categorias c ON c.id = i.categoria_id
         JOIN participantes pa ON pa.id = i.participante_id
         LEFT JOIN promocoes pr ON pr.id = i.promocao_id
         LEFT JOIN reservas r ON r.id = i.reserva_id
         LEFT JOIN pedido_itens pi ON pi.id = r.pedido_item_id
        WHERE i.pedido_id = $1 ORDER BY pi.ordem, r.posicao`,
      [id],
    );
    ingressos = await Promise.all(
      ing.map(async (i) => ({
        codigo_curto: i.codigo_curto,
        categoria: i.categoria,
        promocao: i.promocao,
        participante: i.participante,
        status: i.status,
        utilizado_em: i.utilizado_em,
        beneficios: i.beneficios,
        qr: i.status === 'valido' ? await qrDataUrl(conteudoDoQr(p.codigo_publico, i.codigo)) : null,
      })),
    );
  }
  const aguardando = p.status === 'aguardando_pagamento';
  return {
    edicao: {
      evento: p.evento_nome,
      nome: p.edicao_nome,
      inicio_em: p.inicio_em,
      local: p.local_nome
        ? {
            nome: p.local_nome,
            endereco: [
              p.logradouro && `${p.logradouro}${p.numero ? `, ${p.numero}` : ''}`,
              p.bairro,
              p.cidade && `${p.cidade}${p.uf ? `/${p.uf}` : ''}`,
            ]
              .filter(Boolean)
              .join(' · '),
          }
        : null,
      banner: p.banner,
      endereco_publico: `/ticket/${p.evento_slug}/${p.edicao_slug}`,
    },
    pedido: {
      id: p.id,
      codigo: p.id.slice(0, 8).toUpperCase(),
      status: p.status,
      status_rotulo: ROTULO_PEDIDO[p.status],
      total_centavos: p.total_centavos,
      criado_em: p.criado_em,
      reserva_expira_em: p.reserva_expira_em,
      itens,
      teste: p.origem === 'teste',
      // A última tentativa foi recusada e a reserva ainda vale: a página
      // oferece tentar de novo (outro cartão, Pix).
      pagamento_recusado: aguardando && Boolean(p.pagamento_recusado_em),
    },
    pagamento: aguardando ? linkDePagamento(p.id, tk) : null,
    ingressos,
  };
}

module.exports = {
  RESERVA_MINUTOS,
  MAX_INGRESSOS,
  edicaoPorEndereco,
  cotar,
  criar,
  criarTeste,
  acessoValido,
  novoAcesso,
  expirarVencidos,
  paraComprador,
  linkDePagamento,
  termosVigentes,
};
