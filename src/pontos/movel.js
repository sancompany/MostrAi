const pool = require('../db/pool');
const { FUSO } = require('../lib/fuso-comercial');
const { PARTES, linhaEndereco, problemaNoEndereco } = require('../lib/endereco');
const { gravarEnderecoNaTransacao } = require('./endereco');

// PONTO MÓVEL (02/10/2026, pedido do dono; migrations 112 e 113). Um ATIVO
// FÍSICO da própria Mostraí: 1 ponto móvel = 1 tela. Nasce só pelo Admin
// (nunca de candidatura), nunca tem dono e nunca vira fixo (tipo imutável,
// gatilho na 113). Fica numa BASE (um lugar; a conta dela, quando há, é
// custodiante — nunca dona), pode ser HOSPEDADO por um comércio por alguns
// dias (src/pontos/hospedagem.js) ou ir a um EVENTO, e volta. `anunciante_id`
// fica NULL (CHECK no banco), e por isso nada do que nasce do dono (crédito
// mensal, Plano Básico, cupom, "Meus pontos" como dono) chega em ninguém.
//
// Regras que moram SÓ aqui (o navegador nunca decide):
//   · LOCAL ATUAL: o anfitrião da hospedagem ativa, ou o local do evento em
//     andamento; sem nenhum dos dois, a base (os dois nunca coexistem: agenda
//     única, src/pontos/agenda.js);
//   · PRÓXIMO EVENTO: o programado de data de início mais próxima que ainda
//     não terminou (data de fim >= hoje em Matão). Cancelado nunca é
//     próximo nem local atual — e fica no histórico;
//   · evento é AUTORIZAÇÃO para operar fora do horário da base — não é
//     capacidade, obrigação nem benefício;
//   · só o Admin mexe (todas as rotas estão em /admin — src/server.js).
//
// O público estimado é ESTIMATIVA do evento: aparece como "~600 pessoas"
// e nunca entra em Proof-of-Play, impressão ou alcance.

const LIMITES = { nome: 120, organizacao: 120, local: 160, observacao: 500, publicoMaximo: 1_000_000 };
const agenda = require('./agenda');
const SQL_HOJE = `(now() AT TIME ZONE '${FUSO}')::date`;

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

// "Mostraí Móvel #01": o número é do móvel (migration 112), nunca reaproveitado.
const nomeDoMovel = (numero) => `Mostraí Móvel #${String(numero).padStart(2, '0')}`;

// Dia de hoje em Matão ('AAAA-MM-DD') — o mesmo dia que o SQL_HOJE usa.
const diaEmMatao = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const hojeEmMatao = (agora = new Date()) => diaEmMatao.format(agora);

async function proximoNumeroMovel(db) {
  const { rows } = await db.query(`SELECT nextval('pontos_movel_numero_seq')::int AS numero`);
  return rows[0].numero;
}

// ---------------------------------------------------------------------------
// Leitura: base, local atual e próximo evento de cada móvel
// ---------------------------------------------------------------------------
// Uma consulta para N pontos (lista do anunciante, grade do admin, "Meus
// pontos" da base). Ponto fixo não entra no mapa. É leitura PÚBLICA (card
// do anunciante): da hospedagem sai só o nome do local — nunca a conta, o
// percentual, o saldo ou o histórico. Hospedagem futura não aparece.
async function situacaoDosMoveis(pontoIds, db = pool) {
  const ids = [...new Set(pontoIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.base_nome, p.base_desde,
            atual.id AS atual_id, atual.nome AS atual_nome, atual.local AS atual_local,
            atual.data_inicio AS atual_inicio, atual.data_fim AS atual_fim,
            hosp.id AS hosp_id, hosp.local AS hosp_local, hosp.data_inicio AS hosp_inicio, hosp.data_fim AS hosp_fim,
            prox.id AS prox_id, prox.nome AS prox_nome, prox.local AS prox_local,
            prox.data_inicio AS prox_inicio, prox.data_fim AS prox_fim, prox.publico_estimado AS prox_publico
       FROM pontos p
       LEFT JOIN pontos_moveis_eventos atual ON atual.ponto_id = p.id AND atual.estado = 'em_andamento'
       LEFT JOIN pontos_moveis_hospedagens hosp ON hosp.ponto_id = p.id AND hosp.estado = 'ativa'
       LEFT JOIN LATERAL (
         SELECT e.id, e.nome, e.local, e.data_inicio, e.data_fim, e.publico_estimado
           FROM pontos_moveis_eventos e
          WHERE e.ponto_id = p.id AND e.estado = 'programado' AND e.data_fim >= ${SQL_HOJE}
          ORDER BY e.data_inicio, e.id
          LIMIT 1
       ) prox ON true
      WHERE p.id = ANY($1::int[]) AND p.tipo = 'movel'`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, montarSituacao(r)]));
}

function montarSituacao(r) {
  return {
    base: { nome: r.base_nome, desde: r.base_desde },
    localAtual: r.hosp_id
      ? {
          origem: 'hospedagem',
          nome: r.hosp_local,
          hospedagem: { dataInicio: r.hosp_inicio, dataFim: r.hosp_fim },
        }
      : r.atual_id
        ? {
            origem: 'evento',
            nome: r.atual_local,
            evento: { id: Number(r.atual_id), nome: r.atual_nome, dataInicio: r.atual_inicio, dataFim: r.atual_fim },
          }
        : { origem: 'base', nome: r.base_nome },
    proximoEvento: r.prox_id
      ? {
          id: Number(r.prox_id),
          nome: r.prox_nome,
          local: r.prox_local,
          dataInicio: r.prox_inicio,
          dataFim: r.prox_fim,
          publicoEstimado: r.prox_publico,
        }
      : null,
  };
}

// Admin → Rede → Pontos móveis: cada equipamento com a foto, a tela, a base,
// onde está agora, a hospedagem atual (com a conta), o próximo compromisso
// da agenda (hospedagem ou evento) e o próximo evento.
async function listarMoveis() {
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.status, p.movel_numero, p.foto_instalacao_url, p.base_nome, p.base_conta_id,
            a.nome_empresa AS base_conta_nome,
            (SELECT json_build_object('id', d.id, 'nome', d.apelido, 'status', d.status,
                                      'ultimaVezOnline', d.ultima_vez_online)
               FROM dispositivos d WHERE d.ponto_id = p.id AND d.status <> 'inativo' ORDER BY d.id LIMIT 1) AS tela,
            (SELECT json_build_object('id', h.id, 'local', h.local, 'conta', ca.nome_empresa,
                                      'dataInicio', h.data_inicio, 'dataFim', h.data_fim)
               FROM pontos_moveis_hospedagens h JOIN anunciantes ca ON ca.id = h.conta_id
              WHERE h.ponto_id = p.id AND h.estado = 'ativa') AS hospedagem_atual,
            (SELECT json_build_object('tipo', x.tipo, 'nome', x.nome, 'dataInicio', x.data_inicio, 'dataFim', x.data_fim)
               FROM (SELECT 'hospedagem' AS tipo, h.local AS nome, h.data_inicio, h.data_fim
                       FROM pontos_moveis_hospedagens h
                      WHERE h.ponto_id = p.id AND h.estado = 'programada' AND h.data_fim >= ${SQL_HOJE}
                     UNION ALL
                     SELECT 'evento', e.nome, e.data_inicio, e.data_fim
                       FROM pontos_moveis_eventos e
                      WHERE e.ponto_id = p.id AND e.estado = 'programado' AND e.data_fim >= ${SQL_HOJE}
                      ORDER BY 3 LIMIT 1) x) AS proximo_compromisso
       FROM pontos p LEFT JOIN anunciantes a ON a.id = p.base_conta_id
      WHERE p.tipo = 'movel' AND p.status <> 'arquivado'
      ORDER BY p.movel_numero, p.id`,
  );
  const situacoes = await situacaoDosMoveis(rows.map((r) => r.id));
  return rows.map((r) => {
    const s = situacoes.get(r.id);
    return {
      id: r.id,
      nome: r.nome,
      numero: r.movel_numero,
      status: r.status,
      foto: r.foto_instalacao_url,
      tela: r.tela,
      base: { nome: r.base_nome, conta: r.base_conta_id ? { id: r.base_conta_id, nome: r.base_conta_nome } : null },
      localAtual: s?.localAtual || null,
      hospedagemAtual: r.hospedagem_atual,
      proximoCompromisso: r.proximo_compromisso,
      proximoEvento: s?.proximoEvento || null,
    };
  });
}

// Ficha do Admin: a situação + a conta da base, a tela, a foto, as
// hospedagens (agenda e histórico, com tempo e benefício), todos os eventos
// (com as exibições confirmadas durante cada um — auditoria) e as bases
// anteriores.
async function fichaDoMovel(pontoId) {
  const {
    rows: [p],
  } = await pool.query(
    `SELECT p.id, p.tipo, p.base_conta_id, a.nome_empresa AS base_conta_nome, p.foto_instalacao_url, p.movel_numero,
            p.observacoes,
            (SELECT json_build_object('id', d.id, 'nome', d.apelido, 'status', d.status)
               FROM dispositivos d WHERE d.ponto_id = p.id AND d.status <> 'inativo' ORDER BY d.id LIMIT 1) AS tela
       FROM pontos p LEFT JOIN anunciantes a ON a.id = p.base_conta_id
      WHERE p.id = $1`,
    [pontoId],
  );
  if (!p) return null;
  if (p.tipo !== 'movel') return { tipo: p.tipo };
  const [situacoes, { rows: eventos }, { rows: bases }, hospedagens] = await Promise.all([
    situacaoDosMoveis([p.id]),
    pool.query(
      `SELECT e.id, e.nome, e.organizacao, e.local, e.data_inicio, e.data_fim, e.publico_estimado, e.observacao,
              e.estado, e.iniciado_em, e.encerrado_em, e.cancelado_em, e.criado_em, e.criado_por_admin,
              e.categoria_id, cat.nome AS categoria_nome, e.encerramento,
              (e.data_fim < ${SQL_HOJE}) AS terminou,
              (SELECT COUNT(*)::int FROM execucoes_confirmadas x
                WHERE x.evento_id = e.id AND x.status = 'contabilizado') AS exibicoes_confirmadas
         FROM pontos_moveis_eventos e LEFT JOIN categorias cat ON cat.id = e.categoria_id
        WHERE e.ponto_id = $1
        ORDER BY CASE e.estado WHEN 'em_andamento' THEN 0 WHEN 'programado' THEN 1 ELSE 2 END,
                 CASE WHEN e.estado = 'programado' THEN e.data_inicio END,
                 e.data_inicio DESC, e.id DESC`,
      [p.id],
    ),
    pool.query(
      `SELECT b.conta_id, a.nome_empresa AS conta_nome, b.nome, b.endereco, b.desde, b.ate, b.alterado_por_admin
         FROM pontos_moveis_bases b LEFT JOIN anunciantes a ON a.id = b.conta_id
        WHERE b.ponto_id = $1
        ORDER BY b.ate DESC, b.id DESC`,
      [p.id],
    ),
    require('./hospedagem').hospedagensDoPonto(p.id),
  ]);
  const situacao = situacoes.get(p.id);
  return {
    tipo: 'movel',
    numero: p.movel_numero,
    foto: p.foto_instalacao_url,
    notaInterna: p.observacoes,
    tela: p.tela,
    base: { ...situacao.base, conta: p.base_conta_id ? { id: p.base_conta_id, nome: p.base_conta_nome } : null },
    localAtual: situacao.localAtual,
    proximoEvento: situacao.proximoEvento,
    hospedagens,
    eventos: eventos.map((e) => ({
      id: Number(e.id),
      nome: e.nome,
      organizacao: e.organizacao,
      local: e.local,
      dataInicio: e.data_inicio,
      dataFim: e.data_fim,
      publicoEstimado: e.publico_estimado,
      observacao: e.observacao,
      categoria: e.categoria_id ? { id: e.categoria_id, nome: e.categoria_nome } : null,
      encerramento: e.encerramento,
      estado: e.estado,
      iniciadoEm: e.iniciado_em,
      encerradoEm: e.encerrado_em,
      canceladoEm: e.cancelado_em,
      criadoEm: e.criado_em,
      criadoPor: e.criado_por_admin,
      terminou: e.terminou,
      exibicoesConfirmadas: e.exibicoes_confirmadas,
    })),
    basesAnteriores: bases.map((b) => ({
      conta: { id: b.conta_id, nome: b.conta_nome },
      nome: b.nome,
      endereco: b.endereco,
      desde: b.desde,
      ate: b.ate,
      alteradoPor: b.alterado_por_admin,
    })),
  };
}

// ---------------------------------------------------------------------------
// Escrita (só Admin)
// ---------------------------------------------------------------------------
async function emTransacao(fn) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const r = await fn(cliente);
    await cliente.query('COMMIT');
    return r;
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// Trava a linha do ponto: toda escrita de base e de evento de um mesmo ponto
// passa uma de cada vez (iniciar dois eventos, trocar a base no meio, virar
// fixo com evento aberto — nada disso cruza).
async function travarPonto(cliente, pontoId) {
  const { rows } = await cliente.query('SELECT * FROM pontos WHERE id = $1 FOR UPDATE', [pontoId]);
  if (!rows[0]) throw erro(404, 'ponto não encontrado');
  if (rows[0].status === 'arquivado') throw erro(409, 'ponto arquivado não muda');
  return rows[0];
}

async function travarMovel(cliente, pontoId) {
  const ponto = await travarPonto(cliente, pontoId);
  if (ponto.tipo !== 'movel') throw erro(409, 'esse ponto é fixo — base e eventos são só do ponto móvel');
  return ponto;
}

function texto(valor, campo, rotulo, maximo, { obrigatorio = true } = {}) {
  const t = typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
  if (!t) {
    if (obrigatorio) throw erro(400, `${rotulo}: preencha`, campo);
    return null;
  }
  if (t.length > maximo) throw erro(400, `${rotulo}: no máximo ${maximo} caracteres`, campo);
  return t;
}

function dia(valor, campo, rotulo) {
  const v = typeof valor === 'string' ? valor.trim() : '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) {
    throw erro(400, `${rotulo}: data inválida`, campo);
  }
  return v;
}

// Cadastro leve (pedido do dono): nome, organização, local e datas; o fim
// pode ficar vazio (evento de um dia só). Público e observação, opcionais.
// `categoria_id` (migration 113): o CONTEXTO DE CONCORRÊNCIA do evento — o
// ramo que a trava de concorrente protege enquanto ele está em andamento.
// Vazio = sem restrição; nunca herda o ramo da base.
function validarEvento(corpo, hoje = hojeEmMatao()) {
  const nome = texto(corpo?.nome, 'nome', 'Nome do evento', LIMITES.nome);
  const organizacao = texto(corpo?.organizacao, 'organizacao', 'Organização', LIMITES.organizacao);
  const local = texto(corpo?.local, 'local', 'Local', LIMITES.local);
  const dataInicio = dia(corpo?.data_inicio, 'data_inicio', 'Início');
  const dataFim = corpo?.data_fim ? dia(corpo.data_fim, 'data_fim', 'Fim') : dataInicio;
  if (dataFim < dataInicio) throw erro(400, 'O fim vem antes do início', 'data_fim');
  if (dataFim < hoje) throw erro(400, 'Esse evento já terminou — cadastre só o que ainda vai acontecer', 'data_fim');
  let publicoEstimado = null;
  const publico = corpo?.publico_estimado;
  if (publico !== undefined && publico !== null && String(publico).trim() !== '') {
    const n = Number(String(publico).trim());
    if (!Number.isInteger(n) || n < 1 || n > LIMITES.publicoMaximo) {
      throw erro(400, 'Público estimado: um número inteiro de pessoas (ou deixe em branco)', 'publico_estimado');
    }
    publicoEstimado = n;
  }
  const observacao = texto(corpo?.observacao, 'observacao', 'Observação', LIMITES.observacao, { obrigatorio: false });
  let categoriaId = null;
  const cat = corpo?.categoria_id;
  if (cat !== undefined && cat !== null && String(cat).trim() !== '') {
    categoriaId = Number(String(cat).trim());
    if (!Number.isInteger(categoriaId) || categoriaId <= 0) {
      throw erro(400, 'Contexto de concorrência: escolha um ramo da lista (ou nenhum)', 'categoria_id');
    }
  }
  return { nome, organizacao, local, dataInicio, dataFim, publicoEstimado, observacao, categoriaId };
}

async function criarEvento(pontoId, corpo, admin) {
  const ev = validarEvento(corpo);
  return emTransacao(async (c) => {
    await travarMovel(c, pontoId);
    if (ev.categoriaId) {
      const { rows } = await c.query('SELECT 1 FROM categorias WHERE id = $1', [ev.categoriaId]);
      if (!rows[0]) throw erro(400, 'Contexto de concorrência: ramo não encontrado', 'categoria_id');
    }
    await agenda.exigirLivre(c, pontoId, ev.dataInicio, ev.dataFim);
    const { rows } = await c.query(
      `INSERT INTO pontos_moveis_eventos
         (ponto_id, nome, organizacao, local, data_inicio, data_fim, publico_estimado, observacao, criado_por_admin,
          categoria_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        pontoId,
        ev.nome,
        ev.organizacao,
        ev.local,
        ev.dataInicio,
        ev.dataFim,
        ev.publicoEstimado,
        ev.observacao,
        admin || null,
        ev.categoriaId,
      ],
    );
    return Number(rows[0].id);
  }).catch((err) => {
    throw agenda.traduzirErroDoBanco(err);
  });
}

async function eventoDoPonto(c, pontoId, eventoId) {
  const id = /^\d{1,15}$/.test(String(eventoId)) ? String(eventoId) : null;
  const { rows } = id
    ? await c.query(
        `SELECT *, (data_fim < ${SQL_HOJE}) AS terminou FROM pontos_moveis_eventos
          WHERE id = $1 AND ponto_id = $2 FOR UPDATE`,
        [id, pontoId],
      )
    : { rows: [] };
  if (!rows[0]) throw erro(404, 'evento não encontrado');
  return rows[0];
}

const JA_ESTA = {
  em_andamento: 'Esse evento já está em andamento',
  encerrado: 'Esse evento já foi encerrado',
  cancelado: 'Esse evento foi cancelado',
};

// "O ponto chegou ao evento": o local atual passa a ser o do evento. Pode
// começar antes da data (montagem na véspera); não depois que acabou.
async function iniciarEvento(pontoId, eventoId) {
  return emTransacao(async (c) => {
    await travarMovel(c, pontoId);
    const ev = await eventoDoPonto(c, pontoId, eventoId);
    if (ev.estado !== 'programado') throw erro(409, JA_ESTA[ev.estado]);
    if (ev.terminou) throw erro(409, 'Esse evento já terminou pela data — cancele ou cadastre de novo');
    await agenda.exigirLivre(c, pontoId, ev.data_inicio, ev.data_fim, {
      ignorar: { tipo: 'evento', id: ev.id },
      emCurso: true,
    });
    await c.query(`UPDATE pontos_moveis_eventos SET estado = 'em_andamento', iniciado_em = now() WHERE id = $1`, [
      ev.id,
    ]);
    await avisarTelas(c, pontoId);
  }).catch((err) => {
    throw agenda.traduzirErroDoBanco(err);
  });
}

// Fora da base (evento ou hospedagem), o horário da base não vale — a tela
// exibe enquanto estiver ligada (src/lib/contexto-do-ponto.js): entrar e
// sair muda a config das telas, então a versão sobe como numa troca de
// horário (migration 093) e a TV busca a config nova no próximo heartbeat.
async function avisarTelas(c, pontoId) {
  await c.query(
    `UPDATE dispositivos SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now()
      WHERE ponto_id = $1`,
    [pontoId],
  );
}

// "Encerrar evento / voltar para a base": o local atual volta a ser a base.
async function encerrarEvento(pontoId, eventoId) {
  return emTransacao(async (c) => {
    await travarMovel(c, pontoId);
    const ev = await eventoDoPonto(c, pontoId, eventoId);
    if (ev.estado === 'programado') throw erro(409, 'Esse evento ainda não começou — para desistir dele, cancele');
    if (ev.estado !== 'em_andamento') throw erro(409, JA_ESTA[ev.estado]);
    await c.query(
      `UPDATE pontos_moveis_eventos SET estado = 'encerrado', encerrado_em = now(), encerramento = 'manual'
        WHERE id = $1`,
      [ev.id],
    );
    await avisarTelas(c, pontoId);
  });
}

// Cancelado não vira local atual nem próximo evento, e continua auditável.
async function cancelarEvento(pontoId, eventoId) {
  return emTransacao(async (c) => {
    await travarMovel(c, pontoId);
    const ev = await eventoDoPonto(c, pontoId, eventoId);
    if (ev.estado === 'em_andamento') {
      throw erro(409, 'O ponto já está nesse evento — use Encerrar (ele volta para a base)');
    }
    if (ev.estado !== 'programado') throw erro(409, JA_ESTA[ev.estado]);
    await c.query(
      `UPDATE pontos_moveis_eventos SET estado = 'cancelado', cancelado_em = now(), encerramento = 'manual'
        WHERE id = $1`,
      [ev.id],
    );
  });
}

// Fecha o período da base atual no histórico (troca de base).
async function fecharPeriodoDaBase(c, ponto, admin) {
  await c.query(
    `INSERT INTO pontos_moveis_bases (ponto_id, conta_id, nome, endereco, desde, ate, alterado_por_admin)
     VALUES ($1, $2, $3, $4, $5, GREATEST(now(), $5), $6)`,
    [
      ponto.id,
      ponto.base_conta_id,
      ponto.base_nome,
      linhaEndereco(ponto, { comCidade: true }) || null,
      ponto.base_desde,
      admin || null,
    ],
  );
}

// A conta da base é OPCIONAL (migration 113): a base pode ser um depósito da
// Mostraí. Sem conta, nenhuma.
function contaDaBase(corpo) {
  const bruto = corpo?.base_conta_id;
  if (bruto === undefined || bruto === null || String(bruto).trim() === '') return null;
  const id = Number(bruto);
  if (!Number.isInteger(id) || id <= 0) throw erro(400, 'Conta da base inválida', 'base_conta_id');
  return id;
}

async function buscarContaDaBase(c, contaId) {
  if (!contaId) return null;
  const {
    rows: [conta],
  } = await c.query(
    `SELECT a.id, a.excluido_em, a.categoria_id, a.categoria_livre, cat.nome AS categoria_nome
       FROM anunciantes a LEFT JOIN categorias cat ON cat.id = a.categoria_id
      WHERE a.id = $1`,
    [contaId],
  );
  if (!conta || conta.excluido_em) throw erro(400, 'Conta da base não encontrada', 'base_conta_id');
  return conta;
}

// Definir/alterar a base: o nome do lugar, o endereço (que é o endereço do
// próprio ponto — a troca entra no histórico de endereço, pontos/endereco.js)
// e, se houver, a conta custodiante. Conta ou nome diferentes = base nova: o
// período anterior vai para o histórico e o ramo do ponto passa a ser o da
// conta nova (é ele que a trava de ramo da playlist protege na base). Mesma
// conta e mesmo nome = só correção do endereço da base.
// A base nunca vira dona: `anunciante_id` continua NULL.
async function alterarBase(pontoId, corpo, admin) {
  const contaId = contaDaBase(corpo);
  const nome = texto(corpo?.base_nome, 'base_nome', 'Nome da base', LIMITES.nome);
  const problema = problemaNoEndereco(corpo);
  if (problema) throw erro(400, problema.erro, problema.campo);
  const partes = Object.fromEntries(PARTES.filter((p) => corpo?.[p] !== undefined).map((p) => [p, corpo[p]]));

  return emTransacao(async (c) => {
    const ponto = await travarMovel(c, pontoId);
    const conta = await buscarContaDaBase(c, contaId);
    const contaAnterior = ponto.base_conta_id ? Number(ponto.base_conta_id) : null;

    const baseNova = contaAnterior !== contaId || ponto.base_nome !== nome;
    // Base nova sem endereço deixaria o ponto "morando" no endereço da base
    // antiga.
    if (baseNova && !Object.keys(partes).length) throw erro(400, 'Endereço da base: preencha', 'cep');
    let atual = ponto;
    if (baseNova) {
      await fecharPeriodoDaBase(c, ponto, admin);
      const contaMudou = contaAnterior !== contaId;
      const { rows } = await c.query(
        `UPDATE pontos
            SET base_conta_id = $2, base_nome = $3, base_desde = now(),
                categoria_id = CASE WHEN $4 THEN $5::int ELSE categoria_id END,
                categoria_livre = CASE WHEN $4 THEN $6::text ELSE categoria_livre END,
                segmento = CASE WHEN $4 THEN COALESCE($7::text, $6::text, segmento) ELSE segmento END
          WHERE id = $1 RETURNING *`,
        [
          ponto.id,
          contaId,
          nome,
          contaMudou,
          conta?.categoria_id ?? null,
          conta?.categoria_livre ?? null,
          conta?.categoria_nome ?? null,
        ],
      );
      atual = rows[0];
    }
    const endereco = Object.keys(partes).length
      ? await gravarEnderecoNaTransacao(c, atual, partes, { origem: 'admin', admin })
      : { mudou: false };
    return { baseNova, enderecoMudou: endereco.mudou, contaBase: contaId, contaBaseAnterior: ponto.base_conta_id };
  });
}

// ---------------------------------------------------------------------------
// Criação (só Admin)
// ---------------------------------------------------------------------------
// O móvel nasce AQUI e só aqui — nunca de candidatura (que sempre gera fixo).
// Nome (opcional: "Mostraí Móvel #NN"), a base (nome do lugar + endereço;
// conta custodiante opcional), horário da base (opcional: sem horário, a
// tela exibe enquanto estiver ligada), nota interna. O tipo é automático e
// nunca há dona. A Tela 1 nasce junto (1 móvel = 1 tela); a foto do
// equipamento vem depois, pela rota de foto.
async function criarPontoMovel(corpo, admin) {
  const contaId = contaDaBase(corpo);
  const baseNome = texto(corpo?.base_nome, 'base_nome', 'Nome da base', LIMITES.nome);
  const nomeInformado = texto(corpo?.nome, 'nome', 'Nome do equipamento', LIMITES.nome, { obrigatorio: false });
  const nota = texto(corpo?.observacoes, 'observacoes', 'Nota interna', LIMITES.observacao, { obrigatorio: false });
  const problema = problemaNoEndereco(corpo || {});
  if (problema) throw erro(400, problema.erro, problema.campo);
  const { parteQueFalta, colunasDoEndereco } = require('../lib/endereco');
  const falta = parteQueFalta(colunasDoEndereco(corpo || {}));
  if (falta) throw erro(400, `Endereço da base: preencha o campo ${falta}`, falta);
  const pontosRepo = require('./repository');
  const ponto = await emTransacao(async (c) => {
    const conta = await buscarContaDaBase(c, contaId);
    const numero = await proximoNumeroMovel(c);
    return pontosRepo.criar(
      {
        ...Object.fromEntries(PARTES.map((p) => [p, corpo[p]])),
        nome: nomeInformado || nomeDoMovel(numero),
        segmento: conta?.categoria_nome || conta?.categoria_livre || 'outro',
        categoria_id: conta?.categoria_id || null,
        categoria_livre: conta?.categoria_id ? null : conta?.categoria_livre || null,
        responsavel_nome: 'Mostraí',
        responsavel_contato: '',
        horario_semanal: corpo?.horario_semanal || null,
        observacoes: nota,
        status: 'a_instalar',
        tipo: 'movel',
        base_conta_id: contaId,
        base_nome: baseNome,
        movel_numero: numero,
      },
      c,
    );
  });
  // Fora da transação do ponto (o repositório da tela abre a sua). Se falhar,
  // o móvel fica "aguardando tela" e o Admin cria a tela pela ficha.
  let tela = null;
  try {
    tela = await require('../dispositivos/repository').criar(ponto.id);
  } catch (err) {
    console.error(`ponto móvel ${ponto.id} criado sem tela (crie pela ficha)`, err.message);
  }
  require('../lib/eventos').registrar('ponto:movel_criado', { ponto_id: ponto.id, admin: admin || null });
  return { id: ponto.id, nome: ponto.nome, telaId: tela?.id ?? null };
}

// Quem precisa ver a mudança sem F5: a conta da base, o anfitrião de uma
// hospedagem programada ou ativa, e quem escolheu o ponto.
async function contasInteressadas(pontoId, extras = []) {
  const { rows } = await pool.query(
    `SELECT anunciante_id AS id FROM anunciantes_pontos WHERE ponto_id = $1
     UNION SELECT base_conta_id FROM pontos WHERE id = $1 AND base_conta_id IS NOT NULL
     UNION SELECT conta_id FROM pontos_moveis_hospedagens WHERE ponto_id = $1 AND estado IN ('programada', 'ativa')`,
    [pontoId],
  );
  return [...new Set([...rows.map((r) => r.id), ...extras].filter(Boolean).map(Number))];
}

module.exports = {
  LIMITES,
  nomeDoMovel,
  hojeEmMatao,
  proximoNumeroMovel,
  situacaoDosMoveis,
  listarMoveis,
  fichaDoMovel,
  validarEvento,
  criarEvento,
  iniciarEvento,
  encerrarEvento,
  cancelarEvento,
  alterarBase,
  criarPontoMovel,
  contasInteressadas,
  // Para src/pontos/hospedagem.js — a mesma trava e as mesmas validações.
  emTransacao,
  travarMovel,
  texto,
  dia,
  avisarTelas,
};
