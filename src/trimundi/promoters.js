const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');

// Promoters e comissões — PR 1: banco e motor (migration 021).
//
// Só o que já está aprovado (decisoes-comerciais-2026-11-14.md, regras 3 a
// 9 e decisão B). As perguntas abertas (P-1 a P-10 do desenho) NÃO viram
// regra aqui; onde o motor precisa de um comportamento, ele faz o mais
// conservador e o ponto fica marcado com "P-n" para a decisão do dono:
//   - P-1 (quando a comissão fica liberada para pagar): o registro de
//     pagamento fica DESLIGADO até a decisão (TRIMUNDI_PROMOTER_PAGAMENTOS);
//   - P-2 (reembolso depois de pago): o estorno entra no livro e aparece como
//     "estornada após o pagamento"; nada é descontado sozinho;
//   - P-4 (compra pelo próprio link): já não existe — a indicação da própria
//     conta (mesma conta ou mesmo CPF) nunca vai para o pedido
//     (indicacao.indicadorValido), então não gera comissão.
//
// Regras aplicadas:
//   - venda = cada ingresso pago (pedido de venda, não teste; cortesia nunca)
//     atribuído ao link do promoter, confirmado depois da aprovação dele
//     (sem retroativo — decisão B);
//   - base = valor efetivamente pago pelo ingresso (`ingressos.valor_centavos`,
//     com desconto e rateio de combo, sem taxa — regra 4);
//   - percentual da venda de número k na edição (k conta só as vendas de pé
//     na hora): 10% até a 19ª, 11% da 20ª à 29ª … 15% da 60ª em diante
//     (regras 5 e 7, tabela aprovada); gravado na confirmação e nunca
//     recalculado;
//   - reembolso: lançamento de estorno ligado à venda (regra 6); a venda
//     deixa de contar para as próximas;
//   - abaixo de 10 vendas de pé na edição, a comissão é provisória (regra 8);
//   - recrutador: 1 ingresso em crédito quando o recrutado chega a 10 vendas
//     de pé na mesma edição, uma vez por recrutado; volta a 'revogado' se cair
//     abaixo de 10 antes de o Admin emitir (mesmo critério da decisão A).
//
// Tudo roda dentro da transação do aviso de pagamento, com a edição travada
// (pagamentos.aplicar): a ordem real das confirmações decide o k.

const META = 10;
const SELOS = [10, 20, 40, 60];
const SITUACOES = ['candidato', 'ativo', 'recusado', 'suspenso', 'encerrado'];

// Percentual da venda de número k (regra 5 + tabela aprovada).
function percentualDaVenda(k) {
  if (!Number.isInteger(k) || k < 1) throw new Error('número de venda inválido');
  if (k < 20) return 10;
  return Math.min(15, 9 + Math.floor(k / 10));
}

// Comissão em centavos: ao centavo, meio centavo para cima (mesmo
// arredondamento aprovado em P4 para os registros financeiros).
function comissaoDe(baseCentavos, percentual) {
  const bp = Math.round(Number(percentual) * 100); // pontos-base
  return Math.floor((Number(baseCentavos) * bp + 5000) / 10000);
}

const pagamentosLigados = () => process.env.TRIMUNDI_PROMOTER_PAGAMENTOS === '1';

// Vendas de pé do promoter na edição: vendas do livro sem estorno.
async function vendasDePe(cliente, promoterId, edicaoId) {
  const { rows } = await cliente.query(
    `SELECT count(*)::int AS n FROM promoter_comissoes c
      WHERE c.promoter_id = $1 AND c.edicao_id = $2 AND c.tipo = 'venda'
        AND NOT EXISTS (SELECT 1 FROM promoter_comissoes e WHERE e.origem_id = c.id)`,
    [promoterId, edicaoId],
  );
  return rows[0].n;
}

// ------------------------------------------------------------------ motor
// Chamado pela fila de pagamento depois de todo aviso aplicado ao pedido
// (confirmação, reembolso, contestação, baixa desfeita). Idempotente:
// reaplicar o mesmo aviso não muda nada.
async function revisarPedido(cliente, pedidoId) {
  const { rows: ped } = await cliente.query(
    `SELECT p.id, p.edicao_id, p.origem, p.status, p.pago_em, p.indicador_id, p.total_centavos,
            pr.id AS promoter_id, pr.situacao, pr.aprovado_em,
            -- A situação do promoter NO INSTANTE da confirmação, pelo histórico:
            -- um aviso reprocessado depois de suspender e reativar não credita
            -- a venda paga durante a suspensão.
            (SELECT e.para FROM promoter_eventos e
              WHERE e.promoter_id = pr.id AND e.ocorrido_em <= p.pago_em
              ORDER BY e.ocorrido_em DESC, e.id DESC LIMIT 1) AS situacao_no_pagamento
       FROM pedidos p JOIN promoters pr ON pr.indicador_id = p.indicador_id
      WHERE p.id = $1`,
    [pedidoId],
  );
  const p = ped[0];
  if (!p) return { mudou: false };
  let mudou = false;

  // Estornos: ingresso cancelado com venda no livro e sem estorno ainda. Vale
  // mesmo que o promoter tenha sido suspenso depois (o livro segue o ingresso).
  const { rows: cancelar } = await cliente.query(
    `SELECT c.* FROM promoter_comissoes c JOIN ingressos i ON i.id = c.ingresso_id
      WHERE c.pedido_id = $1 AND c.tipo = 'venda' AND i.status = 'cancelado'
        AND NOT EXISTS (SELECT 1 FROM promoter_comissoes e WHERE e.origem_id = c.id)
      ORDER BY c.id`,
    [pedidoId],
  );
  for (const c of cancelar) {
    await cliente.query(
      `INSERT INTO promoter_comissoes (promoter_id, edicao_id, pedido_id, ingresso_id, tipo, origem_id,
              valor_bruto_pedido_centavos, taxas_centavos, base_centavos, percentual, comissao_centavos, motivo)
       VALUES ($1, $2, $3, $4, 'estorno', $5, $6, $7, $8, $9, $10, 'ingresso reembolsado ou cancelado')
       ON CONFLICT DO NOTHING`,
      [
        c.promoter_id,
        c.edicao_id,
        c.pedido_id,
        c.ingresso_id,
        c.id,
        c.valor_bruto_pedido_centavos,
        c.taxas_centavos,
        c.base_centavos,
        c.percentual,
        c.comissao_centavos,
      ],
    );
    mudou = true;
  }

  // Vendas novas: só pedido de venda pago, promoter ativo e aprovado antes da
  // confirmação do pagamento (sem retroativo).
  const elegivel =
    p.origem === 'venda' &&
    p.status === 'pago' &&
    p.situacao_no_pagamento === 'ativo' &&
    p.aprovado_em &&
    p.pago_em &&
    new Date(p.aprovado_em) <= new Date(p.pago_em);
  if (elegivel) {
    const { rows: novos } = await cliente.query(
      `SELECT i.id, i.valor_centavos FROM ingressos i
        WHERE i.pedido_id = $1 AND i.origem = 'pago' AND i.status <> 'cancelado'
          AND NOT EXISTS (SELECT 1 FROM promoter_comissoes c WHERE c.ingresso_id = i.id AND c.tipo = 'venda')
        ORDER BY i.id`,
      [pedidoId],
    );
    let k = novos.length ? await vendasDePe(cliente, p.promoter_id, p.edicao_id) : 0;
    for (const i of novos) {
      k += 1;
      const pct = percentualDaVenda(k);
      await cliente.query(
        `INSERT INTO promoter_comissoes (promoter_id, edicao_id, pedido_id, ingresso_id, tipo, venda_numero,
                valor_bruto_pedido_centavos, taxas_centavos, base_centavos, percentual, comissao_centavos)
         VALUES ($1, $2, $3, $4, 'venda', $5, $6, NULL, $7, $8, $9)`,
        [
          p.promoter_id,
          p.edicao_id,
          p.id,
          i.id,
          k,
          p.total_centavos,
          i.valor_centavos,
          pct,
          comissaoDe(i.valor_centavos, pct),
        ],
      );
      mudou = true;
    }
  }
  if (mudou) await revisarCredito(cliente, p.promoter_id, p.edicao_id);
  return { mudou };
}

// Crédito de recrutamento do recrutador deste promoter, nesta edição.
async function revisarCredito(cliente, promoterId, edicaoId) {
  const { rows } = await cliente.query(
    `SELECT pr.recrutador_id, r.situacao AS recrutador_situacao
       FROM promoters pr JOIN promoters r ON r.id = pr.recrutador_id
      WHERE pr.id = $1`,
    [promoterId],
  );
  if (!rows[0]) return;
  // O crédito com trava: a emissão pelo Admin (marcarCreditoEmitido) e um
  // reembolso ao mesmo tempo nunca revogam um crédito já emitido.
  const { rows: cr } = await cliente.query(
    'SELECT id, situacao, edicao_id FROM promoter_creditos WHERE recrutado_id = $1 FOR UPDATE',
    [promoterId],
  );
  const x = {
    ...rows[0],
    credito_id: cr[0]?.id ?? null,
    credito_situacao: cr[0]?.situacao ?? null,
    credito_edicao: cr[0]?.edicao_id ?? null,
  };
  const vendas = await vendasDePe(cliente, promoterId, edicaoId);
  if (vendas >= META) {
    if (!x.credito_id && x.recrutador_situacao === 'ativo') {
      await cliente.query(
        `INSERT INTO promoter_creditos (recrutador_id, recrutado_id, edicao_id) VALUES ($1, $2, $3)
         ON CONFLICT (recrutado_id) DO NOTHING`,
        [x.recrutador_id, promoterId, edicaoId],
      );
    } else if (x.credito_situacao === 'revogado') {
      await cliente.query(
        `UPDATE promoter_creditos SET situacao = 'pendente', edicao_id = $2, atualizado_em = now(),
                nota = 'meta atingida de novo'
          WHERE id = $1 AND situacao = 'revogado'`,
        [x.credito_id, edicaoId],
      );
    }
  } else if (x.credito_situacao === 'pendente' && Number(x.credito_edicao) === Number(edicaoId)) {
    await cliente.query(
      `UPDATE promoter_creditos SET situacao = 'revogado', atualizado_em = now(),
              nota = 'recrutado voltou abaixo de 10 vendas antes da emissão'
        WHERE id = $1 AND situacao = 'pendente'`,
      [x.credito_id],
    );
  }
}

// ---------------------------------------------------- situação de cada venda
// Derivada na leitura (o livro não muda): estornada · paga · retida (ingresso
// bloqueado) · provisória (edição abaixo de 10 vendas de pé) · confirmada.
const SQL_LIVRO = `
  SELECT c.id, c.promoter_id, c.edicao_id, c.pedido_id, upper(left(c.pedido_id::text, 8)) AS pedido_codigo,
         c.ingresso_id, i.codigo_curto, cat.nome AS tipo_ingresso, l.ordem AS lote,
         c.venda_numero, c.valor_bruto_pedido_centavos, c.taxas_centavos, c.base_centavos, c.percentual,
         c.comissao_centavos, c.registrado_em, i.status AS ingresso_status,
         e.id AS estorno_id, e.registrado_em AS estornado_em,
         pi.pagamento_id
    FROM promoter_comissoes c
    JOIN ingressos i ON i.id = c.ingresso_id
    JOIN categorias cat ON cat.id = i.categoria_id
    LEFT JOIN lotes l ON l.id = i.lote_id
    LEFT JOIN promoter_comissoes e ON e.origem_id = c.id
    LEFT JOIN promoter_pagamento_itens pi ON pi.comissao_id = c.id
   WHERE c.tipo = 'venda'`;

function situacaoDaVenda(l, vendasDePeNaEdicao) {
  if (l.estorno_id) return l.pagamento_id ? 'estornada_apos_pagamento' : 'estornada';
  if (l.pagamento_id) return 'paga';
  if (l.ingresso_status === 'bloqueado') return 'retida';
  return vendasDePeNaEdicao < META ? 'provisoria' : 'confirmada';
}

function resumir(linhas, vendas) {
  const soma = (s) => linhas.filter((l) => l.situacao === s).reduce((t, l) => t + Number(l.comissao_centavos), 0);
  const pct = vendas >= 1 ? percentualDaVenda(vendas) : null;
  const proximoSelo = SELOS.find((s) => s > vendas) ?? null;
  // Próxima mudança de percentual: a venda 20, 30 … 60.
  const proximaFaixa = vendas < 60 ? Math.max(20, (Math.floor(vendas / 10) + 1) * 10) : null;
  return {
    vendas,
    meta: META,
    oficial: vendas >= META,
    percentual_atual: pct,
    proxima_faixa: proximaFaixa ? { venda: proximaFaixa, percentual: percentualDaVenda(proximaFaixa) } : null,
    selos: SELOS.filter((s) => vendas >= s),
    proximo_selo: proximoSelo,
    comissao: {
      provisoria_centavos: soma('provisoria'),
      confirmada_centavos: soma('confirmada'),
      retida_centavos: soma('retida'),
      paga_centavos: soma('paga'),
      estornada_centavos: soma('estornada') + soma('estornada_apos_pagamento'),
      estornada_apos_pagamento_centavos: soma('estornada_apos_pagamento'),
    },
  };
}

async function livroDaEdicao(promoterId, edicaoId) {
  const [{ rows }, n] = await Promise.all([
    consultar(`${SQL_LIVRO} AND c.promoter_id = $1 AND c.edicao_id = $2 ORDER BY c.venda_numero, c.id`, [
      promoterId,
      edicaoId,
    ]),
    vendasDePe({ query: (...a) => consultar(...a) }, promoterId, edicaoId),
  ]);
  const linhas = rows.map((l) => ({ ...l, situacao: situacaoDaVenda(l, n) }));
  return { linhas, resumo: resumir(linhas, n) };
}

// ------------------------------------------------------- candidatura (conta)
// A conta (e-mail confirmado) pede para ser promoter; opcionalmente pelo
// link de recrutamento de alguém (código do link do recrutador). Um
// recrutador por pessoa, nunca a própria conta; sem cadeia (só o direto
// ganha o crédito).
async function candidatar(clienteId, { recrutador } = {}) {
  return emTransacao(async (c) => {
    const { rows: cl } = await c.query('SELECT id, email_confirmado_em, anonimizado_em FROM clientes WHERE id = $1', [
      clienteId,
    ]);
    if (!cl[0] || cl[0].anonimizado_em) throw erro(404, 'conta não encontrada');
    if (!cl[0].email_confirmado_em) throw erro(409, 'Confirme o seu e-mail antes de pedir para ser promoter.');
    const { rows: ja } = await c.query('SELECT id, situacao FROM promoters WHERE cliente_id = $1', [clienteId]);
    if (ja[0]) {
      if (ja[0].situacao === 'recusado') throw erro(409, 'O seu pedido anterior foi recusado. Fale com a organização.');
      return { id: ja[0].id, situacao: ja[0].situacao, novo: false };
    }
    let recrutadorId = null;
    const codigo = String(recrutador ?? '')
      .trim()
      .toUpperCase();
    if (codigo) {
      const { rows: r } = await c.query(
        `SELECT pr.id FROM promoters pr JOIN indicadores ind ON ind.id = pr.indicador_id
          WHERE ind.codigo = $1 AND pr.situacao = 'ativo' AND pr.cliente_id <> $2`,
        [codigo, clienteId],
      );
      // Link de recrutamento inválido não impede a candidatura: só não liga.
      recrutadorId = r[0]?.id ?? null;
    }
    const { rows } = await c.query(
      'INSERT INTO promoters (cliente_id, recrutador_id) VALUES ($1, $2) RETURNING id, situacao',
      [clienteId, recrutadorId],
    );
    await c.query(
      `INSERT INTO promoter_eventos (promoter_id, acao, para, autor) VALUES ($1, 'candidatura', 'candidato', 'conta')`,
      [rows[0].id],
    );
    return { id: rows[0].id, situacao: rows[0].situacao, novo: true, recrutado: Boolean(recrutadorId) };
  });
}

// ------------------------------------------------------------------ Admin
const TRANSICOES = {
  aprovar: { de: ['candidato'], para: 'ativo', acao: 'aprovado' },
  recusar: { de: ['candidato'], para: 'recusado', acao: 'recusado' },
  suspender: { de: ['ativo'], para: 'suspenso', acao: 'suspenso' },
  reativar: { de: ['suspenso'], para: 'ativo', acao: 'reativado' },
  encerrar: { de: ['ativo', 'suspenso'], para: 'encerrado', acao: 'encerrado' },
};

async function decidir(promoterId, operacao, dados, autor) {
  const t = TRANSICOES[operacao];
  if (!t || !Object.hasOwn(TRANSICOES, operacao)) throw erro(404, 'ação desconhecida');
  const motivo = v.texto(dados?.motivo, {
    campo: 'o motivo',
    max: 300,
    obrigatorio: operacao !== 'aprovar' && operacao !== 'reativar',
  });
  return emTransacao(async (c) => {
    const { rows } = await c.query('SELECT * FROM promoters WHERE id = $1 FOR UPDATE', [promoterId]);
    const pr = rows[0];
    if (!pr) throw erro(404, 'promoter não encontrado');
    if (!t.de.includes(pr.situacao)) throw erro(409, `Não dá para ${operacao} um promoter ${pr.situacao}.`);
    let indicadorId = pr.indicador_id;
    if (t.para === 'ativo' && !indicadorId) {
      const { rows: cl } = await c.query('SELECT anonimizado_em FROM clientes WHERE id = $1', [pr.cliente_id]);
      if (!cl[0] || cl[0].anonimizado_em) throw erro(409, 'A conta deste promoter foi apagada.');
      indicadorId = (await require('./indicacao').indicadorDoCliente(c, pr.cliente_id)).id;
    }
    await c.query(
      `UPDATE promoters SET situacao = $2, indicador_id = $3, atualizado_em = now(),
              aprovado_em = CASE WHEN $2 = 'ativo' THEN COALESCE(aprovado_em, clock_timestamp()) ELSE aprovado_em END
        WHERE id = $1`,
      [pr.id, t.para, indicadorId],
    );
    await c.query(
      `INSERT INTO promoter_eventos (promoter_id, acao, de, para, motivo, autor, autor_access)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [pr.id, t.acao, pr.situacao, t.para, motivo || null, autor?.autor || 'admin', autor?.autorAccess || null],
    );
    await auditar(c, autor, `promoter_${t.acao}`, 'promoter', pr.id, { de: pr.situacao, para: t.para });
    return { id: pr.id, situacao: t.para };
  });
}

// Lista do Admin: todos os promoters (filtro por situação), com os números
// da edição escolhida.
async function listar(edicaoId, { situacao } = {}) {
  if (situacao && !SITUACOES.includes(situacao)) throw erro(400, 'situação inválida');
  const { rows } = await consultar(
    `SELECT pr.id, pr.situacao, pr.candidatura_em, pr.aprovado_em, cl.nome, ind.codigo,
            rec.id AS recrutador_id, rcl.nome AS recrutador,
            (SELECT count(*)::int FROM promoters x WHERE x.recrutador_id = pr.id) AS recrutados
       FROM promoters pr JOIN clientes cl ON cl.id = pr.cliente_id
       LEFT JOIN indicadores ind ON ind.id = pr.indicador_id
       LEFT JOIN promoters rec ON rec.id = pr.recrutador_id LEFT JOIN clientes rcl ON rcl.id = rec.cliente_id
      WHERE ($1::text IS NULL OR pr.situacao = $1)
      ORDER BY (pr.situacao = 'candidato') DESC, pr.situacao, cl.nome, pr.id`,
    [situacao || null],
  );
  if (!edicaoId) return rows;
  const out = [];
  for (const r of rows) {
    const { resumo } = await livroDaEdicao(r.id, edicaoId);
    out.push({ ...r, edicao: resumo });
  }
  return out;
}

async function ficha(promoterId, edicaoId) {
  const { rows } = await consultar(
    `SELECT pr.*, cl.nome, ind.codigo, rcl.nome AS recrutador
       FROM promoters pr JOIN clientes cl ON cl.id = pr.cliente_id
       LEFT JOIN indicadores ind ON ind.id = pr.indicador_id
       LEFT JOIN promoters rec ON rec.id = pr.recrutador_id LEFT JOIN clientes rcl ON rcl.id = rec.cliente_id
      WHERE pr.id = $1`,
    [promoterId],
  );
  const pr = rows[0];
  if (!pr) throw erro(404, 'promoter não encontrado');
  const [eventos, recrutados, creditos, pagamentos] = await Promise.all([
    consultar(
      'SELECT acao, de, para, motivo, autor, ocorrido_em FROM promoter_eventos WHERE promoter_id = $1 ORDER BY id',
      [pr.id],
    ),
    consultar(
      `SELECT x.id, cl.nome, x.situacao FROM promoters x JOIN clientes cl ON cl.id = x.cliente_id
        WHERE x.recrutador_id = $1 ORDER BY x.id`,
      [pr.id],
    ),
    consultar(
      `SELECT cr.id, cr.situacao, cr.edicao_id, cr.criado_em, cr.atualizado_em, cr.nota, cl.nome AS recrutado
         FROM promoter_creditos cr JOIN promoters x ON x.id = cr.recrutado_id JOIN clientes cl ON cl.id = x.cliente_id
        WHERE cr.recrutador_id = $1 ORDER BY cr.id`,
      [pr.id],
    ),
    consultar(
      `SELECT id, edicao_id, valor_centavos, pago_em, meio, referencia, observacao, registrado_por, registrado_em
         FROM promoter_pagamentos WHERE promoter_id = $1 ORDER BY id`,
      [pr.id],
    ),
  ]);
  const edicao = edicaoId ? await livroDaEdicao(pr.id, edicaoId) : null;
  return {
    id: pr.id,
    nome: pr.nome,
    situacao: pr.situacao,
    codigo: pr.codigo,
    candidatura_em: pr.candidatura_em,
    aprovado_em: pr.aprovado_em,
    recrutador: pr.recrutador,
    termo: pr.termo_versao ? { versao: pr.termo_versao, aceito_em: pr.termo_aceito_em } : null,
    eventos: eventos.rows,
    recrutados: recrutados.rows,
    creditos: creditos.rows,
    pagamentos: pagamentos.rows,
    pagamentos_ligados: pagamentosLigados(),
    edicao,
  };
}

// Pagamento manual (decisão C). DESLIGADO até o dono decidir quando a
// comissão fica liberada (P-1) e os dados para pagar (P-9).
async function registrarPagamento(promoterId, dados, autor) {
  if (!pagamentosLigados())
    throw erro(
      409,
      'O registro de pagamento de comissão está desligado até a decisão do dono sobre a liberação (P-1) e os dados para pagar (P-9).',
    );
  const edicaoId = v.id(dados?.edicao_id, 'edição');
  const ids = Array.isArray(dados?.comissoes) ? dados.comissoes.map((x) => v.id(x, 'comissão')) : [];
  if (!ids.length) throw erro(400, 'Escolha as vendas pagas.');
  const pagoEm = v.texto(dados?.pago_em, { campo: 'a data do pagamento', obrigatorio: true, max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(pagoEm)) throw erro(400, 'Data do pagamento no formato AAAA-MM-DD.');
  const meio = v.texto(dados?.meio, { campo: 'o meio', obrigatorio: true, max: 40 });
  const referencia = v.texto(dados?.referencia, { campo: 'a referência', max: 120 });
  const observacao = v.texto(dados?.observacao, { campo: 'a observação', max: 300 });
  return emTransacao(async (c) => {
    await c.query('SELECT 1 FROM edicoes WHERE id = $1 FOR UPDATE', [edicaoId]);
    const n = await vendasDePe(c, promoterId, edicaoId);
    const { rows } = await c.query(`${SQL_LIVRO} AND c.promoter_id = $1 AND c.edicao_id = $2 AND c.id = ANY($3)`, [
      promoterId,
      edicaoId,
      ids,
    ]);
    if (rows.length !== new Set(ids).size) throw erro(400, 'Alguma venda escolhida não é deste promoter nesta edição.');
    const naoConfirmada = rows.find((l) => situacaoDaVenda(l, n) !== 'confirmada');
    if (naoConfirmada)
      throw erro(409, 'Só vendas confirmadas podem ser pagas (nem provisórias, nem retidas, nem estornadas).');
    const total = rows.reduce((t, l) => t + Number(l.comissao_centavos), 0);
    const { rows: pg } = await c.query(
      `INSERT INTO promoter_pagamentos (promoter_id, edicao_id, valor_centavos, pago_em, meio, referencia, observacao,
              registrado_por, registrado_por_access)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        promoterId,
        edicaoId,
        total,
        pagoEm,
        meio,
        referencia || null,
        observacao || null,
        autor?.autor || 'admin',
        autor?.autorAccess || null,
      ],
    );
    for (const l of rows)
      await c.query('INSERT INTO promoter_pagamento_itens (pagamento_id, comissao_id) VALUES ($1, $2)', [
        pg[0].id,
        l.id,
      ]);
    await auditar(c, autor, 'promoter_pagamento', 'promoter', promoterId, {
      vendas: rows.length,
      valor_centavos: total,
    });
    return { id: pg[0].id, valor_centavos: total, vendas: rows.length };
  });
}

// O Admin emitiu a cortesia nominal do crédito de recrutamento (regra 3).
async function marcarCreditoEmitido(creditoId, dados, autor) {
  const nota = v.texto(dados?.nota, {
    campo: 'a nota',
    max: 300,
    obrigatorio: true,
    mensagem: 'Diga qual cortesia foi emitida.',
  });
  return emTransacao(async (c) => {
    const { rows } = await c.query('SELECT * FROM promoter_creditos WHERE id = $1 FOR UPDATE', [creditoId]);
    if (!rows[0]) throw erro(404, 'crédito não encontrado');
    if (rows[0].situacao !== 'pendente') throw erro(409, `Este crédito está ${rows[0].situacao}.`);
    await c.query(
      `UPDATE promoter_creditos SET situacao = 'emitido', emitido_por = $2, nota = $3, atualizado_em = now() WHERE id = $1`,
      [creditoId, autor?.autor || 'admin', nota],
    );
    await auditar(c, autor, 'promoter_credito_emitido', 'promoter_credito', creditoId, {});
    return { id: Number(creditoId), situacao: 'emitido' };
  });
}

// ------------------------------------------------------------ painel (conta)
async function painelDaConta(clienteId) {
  const { rows } = await consultar(
    `SELECT pr.id, pr.situacao, pr.candidatura_em, pr.aprovado_em, ind.codigo
       FROM promoters pr LEFT JOIN indicadores ind ON ind.id = pr.indicador_id WHERE pr.cliente_id = $1`,
    [clienteId],
  );
  const pr = rows[0];
  if (!pr) return { promoter: null };
  const base = { id: pr.id, situacao: pr.situacao, candidatura_em: pr.candidatura_em, codigo: pr.codigo || null };
  if (!['ativo', 'suspenso', 'encerrado'].includes(pr.situacao)) return { promoter: base };
  const { rows: eds } = await consultar(
    `SELECT DISTINCT ed.id, ev.nome || ' — ' || ed.nome AS nome, ed.inicio_em
       FROM promoter_comissoes c JOIN edicoes ed ON ed.id = c.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      WHERE c.promoter_id = $1
      UNION
     SELECT ed.id, ev.nome || ' — ' || ed.nome, ed.inicio_em FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id
      WHERE ed.status = 'publicado'
      ORDER BY 3 DESC NULLS LAST`,
    [pr.id],
  );
  const edicoes = [];
  for (const e of eds) {
    const { linhas, resumo } = await livroDaEdicao(pr.id, e.id);
    edicoes.push({
      id: e.id,
      nome: e.nome,
      resumo,
      // Para o painel: sem nome nem dado de quem comprou.
      vendas: linhas.map((l) => ({
        venda_numero: l.venda_numero,
        tipo_ingresso: l.tipo_ingresso,
        lote: l.lote,
        base_centavos: Number(l.base_centavos),
        percentual: Number(l.percentual),
        comissao_centavos: Number(l.comissao_centavos),
        situacao: l.situacao,
        em: l.registrado_em,
      })),
    });
  }
  const [{ rows: pagamentos }, { rows: recrutados }, { rows: creditos }] = await Promise.all([
    consultar(
      'SELECT edicao_id, valor_centavos, pago_em, meio, referencia FROM promoter_pagamentos WHERE promoter_id = $1 ORDER BY id',
      [pr.id],
    ),
    consultar(
      `SELECT split_part(cl.nome, ' ', 1) AS nome, x.situacao FROM promoters x JOIN clientes cl ON cl.id = x.cliente_id
        WHERE x.recrutador_id = $1 ORDER BY x.id`,
      [pr.id],
    ),
    consultar('SELECT situacao, edicao_id, atualizado_em FROM promoter_creditos WHERE recrutador_id = $1 ORDER BY id', [
      pr.id,
    ]),
  ]);
  return { promoter: { ...base, edicoes, pagamentos, recrutados, creditos } };
}

module.exports = {
  META,
  SELOS,
  percentualDaVenda,
  comissaoDe,
  revisarPedido,
  revisarCredito,
  candidatar,
  decidir,
  listar,
  ficha,
  livroDaEdicao,
  registrarPagamento,
  marcarCreditoEmitido,
  painelDaConta,
  pagamentosLigados,
};
