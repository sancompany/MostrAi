const crypto = require('node:crypto');
const { consultar, emTransacao } = require('./db/conexao');
const v = require('./lib/validacao');
const { erro } = require('./lib/erros');
const { auditar } = require('./lib/registro');
const { ALFABETO } = require('./lib/codigos');
const config = require('./config');

// Indicação (pedido do dono, 09/11/2026): cada cliente — e o operador que o
// Admin habilitar — tem um link próprio; o pedido PAGO de quem chegou por ele
// é uma conversão; a cada N conversões o indicador ganha a recompensa da
// campanha, enquanto houver. Sem níveis, pontos nem gamificação.
//
// A conversão é recalculada a partir do estado do pedido (revisarPedido),
// chamada em todo aviso de pagamento: pago com ingresso de pé conta;
// reembolsado, contestado ou desfeito deixa de contar. Recompensa já
// concedida e ainda não entregue volta se a conversão sair.

const CODIGO = /^[A-Z2-9]{8}$/;

// Ingresso "de pé": válido, ou bloqueado só porque o reembolso foi pedido e
// ainda não saiu. Conversão confirmada = pedido de venda PAGO com ao menos um
// ingresso de pé; os ingressos vendidos por indicação são os de pé. A mesma
// regra vale para a campanha (revisarPedido) e para os relatórios
// (desempenho.js): reembolso, contestação ou cancelamento tiram da conta.
const INGRESSO_DE_PE = "(i.status = 'valido' OR (i.status = 'bloqueado' AND i.motivo_status = 'reembolso solicitado'))";

function novoCodigo() {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ALFABETO[b % 32];
  return s;
}

// Um código por pessoa, criado no primeiro uso. ON CONFLICT DO NOTHING (sem
// alvo) cobre os dois índices únicos sem abortar a transação: a pessoa que já
// tem código (outra aba ao mesmo tempo) é relida; o código sorteado repetido
// tenta outro.
async function criarIndicador(cliente, coluna, id) {
  const achar = async () =>
    (await cliente.query(`SELECT id, codigo FROM indicadores WHERE ${coluna} = $1`, [id])).rows[0];
  for (let i = 0; i < 5; i++) {
    const existente = await achar();
    if (existente) return existente;
    const { rows } = await cliente.query(
      `INSERT INTO indicadores (${coluna}, codigo) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id, codigo`,
      [id, novoCodigo()],
    );
    if (rows[0]) return rows[0];
  }
  throw new Error('não foi possível sortear um código de indicação livre');
}

const indicadorDoCliente = (cliente, clienteId) => criarIndicador(cliente, 'cliente_id', clienteId);
const indicadorDoOperador = (cliente, operadorId) => criarIndicador(cliente, 'operador_id', operadorId);

// Indicador que vale para esta compra (ou para mostrar na página): existe; o
// de comprador não é a própria conta (nem o mesmo CPF) e não foi apagado; o
// de operador não é a conta de cliente com o e-mail dele e está ativo e
// autorizado nesta edição (10/11/2026: todo
// operador tem link — a antiga marca "indicação habilitada" não decide mais).
// Devolve { id, nome, tipo } ou null. Código ruim é ignorado em silêncio —
// nunca impede a compra.
async function indicadorValido(cliente, onde, { compradorClienteId = null, edicaoId }) {
  const { rows } = await cliente.query(
    `SELECT i.id, i.cliente_id, i.operador_id, o.status AS operador_status, o.email_normalizado AS operador_email, o.cliente_id AS operador_cliente_id,
            cl.cpf AS indicador_cpf,
            cl.anonimizado_em AS cliente_anonimizado, COALESCE(cl.nome, o.nome) AS nome,
            EXISTS (SELECT 1 FROM operador_permissoes op WHERE op.operador_id = i.operador_id
                     AND op.permissao = 'checkin' AND (op.edicao_id IS NULL OR op.edicao_id = $2)) AS operador_autorizado
       FROM indicadores i LEFT JOIN operadores o ON o.id = i.operador_id LEFT JOIN clientes cl ON cl.id = i.cliente_id
      WHERE ${onde.coluna} = $1`,
    [onde.valor, edicaoId],
  );
  const ind = rows[0];
  if (!ind) return null;
  // Sem edição (link geral, /tic/eventos?ind=): basta o operador estar ativo;
  // a autorização dele na edição é conferida na compra.
  if (ind.operador_id && !(ind.operador_status === 'ativo' && (edicaoId == null || ind.operador_autorizado))) {
    return null;
  }
  // Operador comprando com a própria conta de cliente (mesmo e-mail, 11/11/2026):
  // é autoindicação — o operador não tem CPF, então o e-mail é o que liga as
  // duas contas da mesma pessoa. Não conta a compra nem a visita.
  if (ind.operador_id && compradorClienteId && Number(ind.operador_cliente_id) === Number(compradorClienteId)) {
    return null; // operador ligado a esta mesma conta TICK
  }
  if (ind.operador_id && compradorClienteId && ind.operador_email) {
    const { rows: comp } = await cliente.query('SELECT lower(trim(email)) AS email FROM clientes WHERE id = $1', [
      compradorClienteId,
    ]);
    if (comp[0]?.email && comp[0].email === String(ind.operador_email).trim().toLowerCase()) return null;
  }
  if (ind.cliente_id) {
    if (ind.cliente_anonimizado) return null;
    if (compradorClienteId && Number(ind.cliente_id) === Number(compradorClienteId)) return null;
    if (compradorClienteId) {
      const { rows: comp } = await cliente.query('SELECT cpf FROM clientes WHERE id = $1', [compradorClienteId]);
      if (comp[0]?.cpf === ind.indicador_cpf) return null;
    }
  }
  return { id: ind.id, nome: ind.nome, tipo: ind.operador_id ? 'operador' : 'comprador', operador_id: ind.operador_id };
}

const normalizarCodigo = (codigo) => {
  const c = String(codigo ?? '')
    .trim()
    .toUpperCase();
  return CODIGO.test(c) ? c : null;
};

async function indicadorDoCodigo(cliente, codigo, compradorClienteId, edicaoId) {
  const c = normalizarCodigo(codigo);
  if (!c) return null;
  return indicadorValido(cliente, { coluna: 'i.codigo', valor: c }, { compradorClienteId, edicaoId });
}

// A origem desta conta nesta edição (registro da indicação). O primeiro link
// que valeu fica: outro link depois — na mesma página, em outra aba, num
// pedido novo — não troca quem indicou. Sem origem ainda, o código que veio
// (se valer) vira a origem. ON CONFLICT DO NOTHING + releitura: duas abas ao
// mesmo tempo ficam com a mesma origem.
async function origemDaConta(cliente, { clienteId, edicaoId, codigo }) {
  const registrada = async () =>
    (
      await cliente.query('SELECT indicador_id FROM indicacao_origens WHERE cliente_id = $1 AND edicao_id = $2', [
        clienteId,
        edicaoId,
      ])
    ).rows[0];
  let reg = await registrada();
  if (!reg) {
    const novo = await indicadorDoCodigo(cliente, codigo, clienteId, edicaoId);
    if (!novo) return null;
    await cliente.query(
      `INSERT INTO indicacao_origens (cliente_id, edicao_id, indicador_id) VALUES ($1, $2, $3)
       ON CONFLICT (cliente_id, edicao_id) DO NOTHING`,
      [clienteId, edicaoId, novo.id],
    );
    reg = await registrada();
  }
  // A origem registrada só vale enquanto o indicador puder indicar (operador
  // desativado ou tirado da edição, conta apagada): senão, a compra fica sem.
  return indicadorValido(
    cliente,
    { coluna: 'i.id', valor: reg.indicador_id },
    { compradorClienteId: clienteId, edicaoId },
  );
}

// Visita pelo link ("Indique e acompanhe"): um visitante é um navegador — um
// id aleatório dele, guardado só como hash. A mesma pessoa voltando pelo
// mesmo link no mesmo navegador não conta de novo. Quando esse navegador
// entra numa conta, a visita ganha o cliente_id (assim se conta quem criou
// conta pela indicação). Quem visita o próprio link não conta.
const VISITANTE = /^[A-Za-z0-9_-]{16,64}$/;
async function registrarVisita(cliente, { indicadorId, visitante, edicaoId = null, clienteId = null }) {
  if (!indicadorId || !VISITANTE.test(String(visitante ?? ''))) return false;
  const h = crypto.createHash('sha256').update(String(visitante)).digest('hex');
  const { rowCount } = await cliente.query(
    `INSERT INTO indicacao_visitas (indicador_id, visitante, edicao_id, cliente_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (indicador_id, visitante) DO UPDATE SET cliente_id = EXCLUDED.cliente_id
       WHERE indicacao_visitas.cliente_id IS NULL AND EXCLUDED.cliente_id IS NOT NULL`,
    [indicadorId, h, edicaoId, clienteId],
  );
  return rowCount > 0;
}

// Página de venda: quem indicou, para o aviso "Você chegou por indicação de…".
// Logado, registra a origem (a mesma regra do pedido); sem login, só mostra
// de quem é o código. Nome e tipo — nada mais do indicador. Com `visitante`,
// conta a visita pelo link do código que veio (não o da origem).
async function quemIndicou({
  clienteId = null,
  operadorId = null,
  edicaoId = null,
  codigo,
  visitante = null,
  contarVisita = true,
}) {
  return emTransacao(async (cliente) => {
    let doCodigo = await indicadorDoCodigo(cliente, codigo, clienteId, edicaoId);
    // O próprio operador, logado na portaria, pelo próprio link: não é visita.
    if (doCodigo && operadorId && Number(doCodigo.operador_id) === Number(operadorId)) doCodigo = null;
    if (doCodigo && visitante && contarVisita) {
      await registrarVisita(cliente, { indicadorId: doCodigo.id, visitante, edicaoId, clienteId });
    }
    const ind = clienteId && edicaoId ? await origemDaConta(cliente, { clienteId, edicaoId, codigo }) : doCodigo;
    return ind ? { nome: ind.nome, tipo: ind.tipo } : null;
  });
}

// A conversão e os prêmios de indicação moram no modelo de Campanhas desde
// 16/11/2026 (campanhas.js, migrations 015/016). O livro de conversões nasce
// na confirmação do pagamento (campanhas.aoConfirmar, com a janela pelo
// instante oficial — C4/R2 — e sem pausada — C6); daqui em diante, todo aviso
// revisa: pago com ingresso de pé conta; reembolso, contestação ou baixa
// desfeita tiram. As tabelas antigas (campanhas_indicacao, indicacoes,
// recompensas_indicacao) ficam intactas, sem uso.
async function revisarPedido(cliente, pedidoId) {
  const { rows } = await cliente.query(
    `SELECT EXISTS (SELECT 1 FROM ingressos i WHERE i.pedido_id = $1 AND ${INGRESSO_DE_PE}) AS de_pe`,
    [pedidoId],
  );
  await require('./campanhas').revisarPedido(cliente, pedidoId, { ingressoDePe: rows[0].de_pe });
}

// ------------------------------------------------------------------ Admin
function lerCampanha(d = {}, parcial = false) {
  const tem = (k) => !parcial || Object.hasOwn(d, k);
  const out = {};
  if (tem('nome')) out.nome = v.texto(d.nome, { campo: 'o nome da campanha', obrigatorio: true, max: 80 });
  if (tem('recompensa')) out.recompensa = v.texto(d.recompensa, { campo: 'a recompensa', obrigatorio: true, max: 80 });
  if (tem('quantidade'))
    out.quantidade = v.inteiro(d.quantidade, { campo: 'a quantidade de recompensas', min: 1, max: 100000 });
  if (tem('indicacoes_por_recompensa')) {
    out.indicacoes_por_recompensa = v.inteiro(d.indicacoes_por_recompensa ?? 1, {
      campo: 'as indicações por recompensa',
      min: 1,
      max: 100,
    });
  }
  if (tem('limite_por_indicador')) {
    out.limite_por_indicador = v.inteiro(d.limite_por_indicador, {
      campo: 'o limite por pessoa',
      min: 1,
      max: 1000,
      obrigatorio: false,
    });
  }
  if (tem('inicio')) out.inicio = v.dataHora(d.inicio, { campo: 'o início' });
  if (tem('fim')) out.fim = v.dataHora(d.fim, { campo: 'o fim' });
  if (out.inicio && out.fim && out.fim <= out.inicio) throw erro(400, 'O fim precisa ser depois do início.');
  if (Object.hasOwn(d, 'ativo')) out.ativo = v.booleano(d.ativo, true);
  return out;
}

// Campanha de indicação no formato de antes ("a cada N indicações pagas, 1
// recompensa, até X por pessoa, Q no total"): no modelo novo é uma campanha
// de indicação com UM nível que se repete (de = N, estoque = Q, limite = X).
// As telas atuais (Admin → Campanhas e a conta) seguem com o mesmo formato.
const SQL_CAMPANHA = `
  SELECT c.id, c.edicao_id, c.nome, f.premio AS recompensa, f.estoque AS quantidade, f.de AS indicacoes_por_recompensa,
         c.limite_por_pessoa AS limite_por_indicador, c.inicio, c.fim, (c.status = 'ativa') AS ativo, c.status,
         c.criado_em, c.atualizado_em,
         (SELECT count(*)::int FROM campanha_indicacoes WHERE campanha_id = c.id AND valida) AS conversoes,
         (SELECT count(*)::int FROM campanha_premios WHERE campanha_id = c.id AND status IN ('concedido', 'entregue')) AS concedidas,
         (SELECT count(*)::int FROM campanha_premios WHERE campanha_id = c.id AND status = 'entregue') AS entregues
    FROM campanhas c JOIN campanha_faixas f ON f.campanha_id = c.id AND f.ordem = 1`;

async function listarCampanhas(edicaoId) {
  const { rows } = await consultar(
    `${SQL_CAMPANHA} WHERE c.edicao_id = $1 AND c.modalidade = 'indicacao' ORDER BY (c.status = 'ativa') DESC, c.id DESC`,
    [edicaoId],
  );
  return rows;
}

// R1 (16/11/2026): uma campanha de indicação não acumulável ativa por edição
// (índice único no banco — vale também para duas ativações ao mesmo tempo).
function ativaDuplicada(err) {
  if (err.code === '23505' && /ux_campanha_indicacao_exclusiva/.test(err.constraint || err.message)) {
    throw erro(
      409,
      'Já existe outra campanha de indicação não acumulável ativa nesta edição — pause ou encerre a outra antes.',
      { codigo: 'indicacao_exclusiva' },
    );
  }
  throw err;
}

async function criarCampanha(edicaoId, dados, autor) {
  const c = lerCampanha(dados);
  return emTransacao(async (cliente) => {
    const { rows: ed } = await cliente.query('SELECT id FROM edicoes WHERE id = $1', [edicaoId]);
    if (!ed[0]) throw erro(404, 'edição não encontrada');
    const { rows } = await cliente
      .query(
        `INSERT INTO campanhas (edicao_id, modalidade, nome, status, inicio, fim, acumula, escada, limite_por_pessoa)
         VALUES ($1, 'indicacao', $2, $3, $4, $5, false, 'cumulativa', $6) RETURNING id`,
        [edicaoId, c.nome, (c.ativo ?? true) ? 'ativa' : 'pausada', c.inicio, c.fim, c.limite_por_indicador],
      )
      .catch(ativaDuplicada);
    await cliente.query(
      `INSERT INTO campanha_faixas (campanha_id, ordem, de, repete, premio, quantidade, estoque)
       VALUES ($1, 1, $2, true, $3, 1, $4)`,
      [rows[0].id, c.indicacoes_por_recompensa, c.recompensa, c.quantidade],
    );
    await auditar(cliente, autor, 'campanha_criada', 'campanha', rows[0].id, {
      edicao_id: edicaoId,
      modalidade: 'indicacao',
    });
    return (await cliente.query(`${SQL_CAMPANHA} WHERE c.id = $1`, [rows[0].id])).rows[0];
  });
}

async function atualizarCampanha(id, dados, autor) {
  const c = lerCampanha(dados, true);
  const campos = Object.keys(c);
  if (!campos.length) throw erro(400, 'nada para alterar');
  return emTransacao(async (cliente) => {
    const { rows: atual } = await cliente.query(
      `${SQL_CAMPANHA} WHERE c.id = $1 AND c.modalidade = 'indicacao' FOR UPDATE OF c`,
      [id],
    );
    if (!atual[0]) throw erro(404, 'campanha não encontrada');
    if (atual[0].status === 'encerrada') throw erro(409, 'Campanha encerrada fica só para consulta.');
    if (c.quantidade && c.quantidade < atual[0].concedidas) {
      throw erro(409, `A quantidade não pode ficar abaixo do que já foi concedido (${atual[0].concedidas}).`);
    }
    const daCampanha = { nome: 'nome', inicio: 'inicio', fim: 'fim', limite_por_indicador: 'limite_por_pessoa' };
    const daFaixa = { recompensa: 'premio', quantidade: 'estoque', indicacoes_por_recompensa: 'de' };
    const sets = campos.filter((k) => daCampanha[k]);
    const valores = sets.map((k) => c[k]);
    if (c.ativo !== undefined) {
      sets.push('status');
      valores.push(c.ativo ? 'ativa' : 'pausada');
    }
    if (sets.length) {
      await cliente
        .query(
          `UPDATE campanhas SET ${sets.map((k, i) => `${daCampanha[k] || k} = $${i + 2}`).join(', ')}, atualizado_em = now()
            WHERE id = $1`,
          [id, ...valores],
        )
        .catch(ativaDuplicada);
    }
    const daF = campos.filter((k) => daFaixa[k]);
    if (daF.length) {
      await cliente.query(
        `UPDATE campanha_faixas SET ${daF.map((k, i) => `${daFaixa[k]} = $${i + 2}`).join(', ')}
          WHERE campanha_id = $1 AND ordem = 1`,
        [id, ...daF.map((k) => c[k])],
      );
    }
    await auditar(cliente, autor, 'campanha_alterada', 'campanha', id, { campos });
    return (await cliente.query(`${SQL_CAMPANHA} WHERE c.id = $1`, [id])).rows[0];
  });
}

// Quem indicou, quanto converteu e o que ganhou — sem CPF nem e-mail.
async function indicadoresDaCampanha(campanhaId) {
  const { rows } = await consultar(
    `SELECT i.id, i.codigo, COALESCE(cl.nome, o.nome, '(anonimizado)') AS nome,
            CASE WHEN i.operador_id IS NOT NULL THEN 'operador' ELSE 'cliente' END AS tipo,
            (SELECT count(*)::int FROM campanha_indicacoes x WHERE x.campanha_id = $1 AND x.indicador_id = i.id AND x.valida) AS conversoes,
            COALESCE((SELECT json_agg(json_build_object('id', r.id,
                                                        'status', CASE r.status WHEN 'concedido' THEN 'concedida' ELSE r.status END,
                                                        'concedida_em', r.concedido_em, 'entregue_em', r.entregue_em)
                                      ORDER BY r.id)
                        FROM campanha_premios r WHERE r.campanha_id = $1 AND r.indicador_id = i.id
                         AND r.status IN ('concedido', 'entregue')), '[]') AS recompensas
       FROM indicadores i LEFT JOIN clientes cl ON cl.id = i.cliente_id LEFT JOIN operadores o ON o.id = i.operador_id
      WHERE EXISTS (SELECT 1 FROM campanha_indicacoes x WHERE x.campanha_id = $1 AND x.indicador_id = i.id)
      ORDER BY conversoes DESC, i.id`,
    [campanhaId],
  );
  return rows;
}

// Entrega pelo Admin (registrada uma vez só, com histórico e auditoria).
async function entregarRecompensa(id, autor) {
  return emTransacao(async (cliente) => {
    const r = await require('./campanhas').entregarPremio(cliente, id, {
      autor: String(autor?.autor || 'admin').slice(0, 200),
      via: 'admin',
    });
    if (r.resultado === 'ja_entregue') {
      throw erro(409, 'Esta recompensa já foi entregue.', { entregue_em: r.entregue_em });
    }
    return { ok: true };
  });
}

// ------------------------------------------------- "minha indicação"
// Link permanente: o código é da conta (não muda), e o endereço é a página de
// venda de cada edição em que ele vale hoje — publicada ou com venda
// pausada, que ainda não terminou (a mesma regra da vitrine). Para operador,
// só as edições autorizadas. Sai com ou sem campanha: a campanha é só a
// promoção que, se existir, dá recompensa.
const linkDaEdicao = (codigo, e) => `${config.urlDoSite()}/ticket/${e.evento_slug}/${e.edicao_slug}?ind=${codigo}`;

async function edicoesDoLink(cliente, operadorId = null) {
  const { rows } = await cliente.query(
    `SELECT ed.id, ev.nome AS evento, ed.nome AS edicao, ev.slug AS evento_slug, ed.slug AS edicao_slug
       FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id
      WHERE ed.status IN ('publicado', 'pausado')
        AND (COALESCE(ed.fim_em, ed.inicio_em + interval '12 hours') IS NULL
             OR COALESCE(ed.fim_em, ed.inicio_em + interval '12 hours') > now())
        AND ($1::bigint IS NULL OR EXISTS (
              SELECT 1 FROM operador_permissoes op WHERE op.operador_id = $1 AND op.permissao = 'checkin'
                 AND (op.edicao_id IS NULL OR op.edicao_id = ed.id)))
      ORDER BY ed.inicio_em NULLS LAST, ed.id`,
    [operadorId],
  );
  return rows;
}

async function andamento(cliente, indicador, operadorId = null) {
  const edicoes = await edicoesDoLink(cliente, operadorId);
  const ids = edicoes.map((e) => e.id);
  const { rows } = await cliente.query(
    `SELECT c.*, ev.nome AS evento, ed.nome AS edicao, ev.slug AS evento_slug, ed.slug AS edicao_slug,
            (SELECT count(*)::int FROM campanha_indicacoes x WHERE x.campanha_id = c.id AND x.indicador_id = $1 AND x.valida) AS minhas_conversoes,
            (SELECT count(*)::int FROM campanha_premios r WHERE r.campanha_id = c.id AND r.indicador_id = $1 AND r.status = 'concedido') AS a_retirar,
            (SELECT count(*)::int FROM campanha_premios r WHERE r.campanha_id = c.id AND r.indicador_id = $1 AND r.status = 'entregue') AS entregues,
            COALESCE((SELECT json_agg(json_build_object('id', f.id, 'de', f.de, 'repete', f.repete, 'premio', f.premio,
                        'estoque', f.estoque,
                        'concedidas', (SELECT count(*)::int FROM campanha_premios r WHERE r.faixa_id = f.id AND r.status IN ('concedido', 'entregue')))
                        ORDER BY f.ordem) FROM campanha_faixas f WHERE f.campanha_id = c.id), '[]') AS niveis
       FROM campanhas c JOIN edicoes ed ON ed.id = c.edicao_id JOIN eventos ev ON ev.id = ed.evento_id
      WHERE c.modalidade = 'indicacao' AND c.status = 'ativa' AND ed.status = 'publicado'
        AND (c.inicio IS NULL OR c.inicio <= now()) AND (c.fim IS NULL OR c.fim > now())
        AND c.edicao_id = ANY($2::bigint[])
      ORDER BY ed.inicio_em NULLS LAST, c.id`,
    [indicador.id, ids],
  );
  return {
    codigo: indicador.codigo,
    // Link permanente geral: a vitrine da TICK, que leva o código para
    // qualquer evento que a pessoa abrir (edicao.page.js usa o geral quando
    // não há um do próprio evento).
    link_geral: `${config.urlDoSite()}/tic/eventos?ind=${indicador.codigo}`,
    links: edicoes.map((e) => ({
      edicao_id: e.id,
      evento: `${e.evento} — ${e.edicao}`,
      link: linkDaEdicao(indicador.codigo, e),
    })),
    campanhas: rows.map((c) => {
      const ganhas = c.a_retirar + c.entregues;
      const noLimite = c.limite_por_pessoa && ganhas >= c.limite_por_pessoa;
      const n = c.minhas_conversoes;
      // Nível que se repete (formato de antes) ou o próximo nível da escada.
      const repete = c.niveis.length === 1 && c.niveis[0].repete ? c.niveis[0] : null;
      const proximo = repete || c.niveis.find((f) => f.de > n) || null;
      const restam = (f) => (f?.estoque ? Math.max(0, f.estoque - f.concedidas) : null);
      return {
        campanha: c.nome,
        evento: `${c.evento} — ${c.edicao}`,
        recompensa: (proximo || c.niveis[c.niveis.length - 1])?.premio,
        link: linkDaEdicao(indicador.codigo, c),
        indicacoes_por_recompensa: proximo?.de ?? null,
        limite_por_indicador: c.limite_por_pessoa,
        conversoes: n,
        recompensas_a_retirar: c.a_retirar,
        recompensas_entregues: c.entregues,
        faltam_para_proxima: noLimite || !proximo ? null : repete ? repete.de - (n % repete.de) : proximo.de - n,
        restam_na_campanha: repete ? restam(repete) : restam(proximo),
      };
    }),
  };
}

async function andamentoDoCliente(clienteId) {
  return emTransacao(async (cliente) => andamento(cliente, await indicadorDoCliente(cliente, clienteId)));
}

// Todo operador tem link (10/11/2026), nas edições em que está autorizado.
async function andamentoDoOperador(operadorId) {
  return emTransacao(async (cliente) => andamento(cliente, await indicadorDoOperador(cliente, operadorId), operadorId));
}

// Código e links do operador para a ficha do Admin (cria o código se faltar).
async function linksDoOperador(operadorId) {
  return emTransacao(async (cliente) => {
    const ind = await indicadorDoOperador(cliente, operadorId);
    const edicoes = await edicoesDoLink(cliente, operadorId);
    return {
      indicador_id: ind.id,
      codigo: ind.codigo,
      links: edicoes.map((e) => ({
        edicao_id: e.id,
        evento: `${e.evento} — ${e.edicao}`,
        link: linkDaEdicao(ind.codigo, e),
      })),
    };
  });
}

// Link do comprador numa edição (ficha do Admin).
async function linkDoCliente(clienteId, edicaoId) {
  return emTransacao(async (cliente) => {
    const ind = await indicadorDoCliente(cliente, clienteId);
    const { rows } = await cliente.query(
      `SELECT ev.slug AS evento_slug, ed.slug AS edicao_slug FROM edicoes ed JOIN eventos ev ON ev.id = ed.evento_id
        WHERE ed.id = $1`,
      [edicaoId],
    );
    return { indicador_id: ind.id, codigo: ind.codigo, link: rows[0] ? linkDaEdicao(ind.codigo, rows[0]) : null };
  });
}

module.exports = {
  INGRESSO_DE_PE,
  registrarVisita,
  indicadorDoCodigo,
  origemDaConta,
  quemIndicou,
  linksDoOperador,
  linkDoCliente,
  indicadorDoCliente,
  indicadorDoOperador,
  revisarPedido,
  listarCampanhas,
  criarCampanha,
  atualizarCampanha,
  indicadoresDaCampanha,
  entregarRecompensa,
  andamentoDoCliente,
  andamentoDoOperador,
};
