const pool = require('../db/pool');
const { FUSO } = require('../lib/fuso-comercial');
const { PARTES, linhaEndereco, problemaNoEndereco } = require('../lib/endereco');
const { gravarEnderecoNaTransacao } = require('./endereco');

// PONTO MÓVEL (02/10/2026, pedido do dono; migration 112). Um ativo da
// própria Mostraí: tem uma BASE (o comércio onde fica quando não está em
// evento) e pode sair para eventos e voltar. A conta da base é custodiante,
// nunca dona — `anunciante_id` fica NULL (CHECK no banco), e por isso nada
// do que nasce do dono (crédito mensal, Plano Básico, cupom, "Meus pontos"
// como dono) chega nela, sem regra nova nenhuma.
//
// Regras que moram SÓ aqui (o navegador nunca decide):
//   · LOCAL ATUAL: o local do evento em andamento; sem evento, a base;
//   · PRÓXIMO EVENTO: o programado de data de início mais próxima que ainda
//     não terminou (data de fim >= hoje em Matão). Cancelado nunca é
//     próximo nem local atual — e fica no histórico;
//   · um evento em andamento por ponto (índice único na 112);
//   · só o Admin mexe (todas as rotas estão em /admin — src/server.js).
//
// O público estimado é ESTIMATIVA do evento: aparece como "~600 pessoas"
// e nunca entra em Proof-of-Play, impressão ou alcance.

const LIMITES = { nome: 120, organizacao: 120, local: 160, observacao: 500, publicoMaximo: 1_000_000 };
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
// pontos" da base). Ponto fixo não entra no mapa.
async function situacaoDosMoveis(pontoIds, db = pool) {
  const ids = [...new Set(pontoIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id, p.base_nome, p.base_desde,
            atual.id AS atual_id, atual.nome AS atual_nome, atual.local AS atual_local,
            atual.data_inicio AS atual_inicio, atual.data_fim AS atual_fim,
            prox.id AS prox_id, prox.nome AS prox_nome, prox.local AS prox_local,
            prox.data_inicio AS prox_inicio, prox.data_fim AS prox_fim, prox.publico_estimado AS prox_publico
       FROM pontos p
       LEFT JOIN pontos_moveis_eventos atual ON atual.ponto_id = p.id AND atual.estado = 'em_andamento'
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
    localAtual: r.atual_id
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

// Ficha do Admin: a situação + a conta da base, todos os eventos (com as
// exibições confirmadas durante cada um — auditoria) e as bases anteriores.
async function fichaDoMovel(pontoId) {
  const {
    rows: [p],
  } = await pool.query(
    `SELECT p.id, p.tipo, p.base_conta_id, a.nome_empresa AS base_conta_nome
       FROM pontos p LEFT JOIN anunciantes a ON a.id = p.base_conta_id
      WHERE p.id = $1`,
    [pontoId],
  );
  if (!p) return null;
  if (p.tipo !== 'movel') return { tipo: p.tipo };
  const [situacoes, { rows: eventos }, { rows: bases }] = await Promise.all([
    situacaoDosMoveis([p.id]),
    pool.query(
      `SELECT e.id, e.nome, e.organizacao, e.local, e.data_inicio, e.data_fim, e.publico_estimado, e.observacao,
              e.estado, e.iniciado_em, e.encerrado_em, e.cancelado_em, e.criado_em, e.criado_por_admin,
              (e.data_fim < ${SQL_HOJE}) AS terminou,
              (SELECT COUNT(*)::int FROM execucoes_confirmadas x
                WHERE x.evento_id = e.id AND x.status = 'contabilizado') AS exibicoes_confirmadas
         FROM pontos_moveis_eventos e
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
  ]);
  const situacao = situacoes.get(p.id);
  return {
    tipo: 'movel',
    base: { ...situacao.base, conta: { id: p.base_conta_id, nome: p.base_conta_nome } },
    localAtual: situacao.localAtual,
    proximoEvento: situacao.proximoEvento,
    eventos: eventos.map((e) => ({
      id: Number(e.id),
      nome: e.nome,
      organizacao: e.organizacao,
      local: e.local,
      dataInicio: e.data_inicio,
      dataFim: e.data_fim,
      publicoEstimado: e.publico_estimado,
      observacao: e.observacao,
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
  return { nome, organizacao, local, dataInicio, dataFim, publicoEstimado, observacao };
}

async function criarEvento(pontoId, corpo, admin) {
  const ev = validarEvento(corpo);
  return emTransacao(async (c) => {
    await travarMovel(c, pontoId);
    const { rows } = await c.query(
      `INSERT INTO pontos_moveis_eventos
         (ponto_id, nome, organizacao, local, data_inicio, data_fim, publico_estimado, observacao, criado_por_admin)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      ],
    );
    return Number(rows[0].id);
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
    const { rows: outro } = await c.query(
      `SELECT nome FROM pontos_moveis_eventos WHERE ponto_id = $1 AND estado = 'em_andamento'`,
      [pontoId],
    );
    if (outro[0]) throw erro(409, `O ponto já está no evento “${outro[0].nome}” — encerre esse antes`);
    await c.query(`UPDATE pontos_moveis_eventos SET estado = 'em_andamento', iniciado_em = now() WHERE id = $1`, [
      ev.id,
    ]);
    await avisarTelas(c, pontoId);
  });
}

// Em evento, o horário da base não vale (a tela exibe enquanto estiver
// ligada — src/dispositivos/repository.js SELECT_TELA): entrar e sair do
// evento muda a config das telas, então a versão sobe como numa troca de
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
    await c.query(`UPDATE pontos_moveis_eventos SET estado = 'encerrado', encerrado_em = now() WHERE id = $1`, [ev.id]);
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
    await c.query(`UPDATE pontos_moveis_eventos SET estado = 'cancelado', cancelado_em = now() WHERE id = $1`, [ev.id]);
  });
}

// Fecha o período da base atual no histórico (troca de base, ou o móvel
// voltando a ser fixo).
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

// Definir/alterar a base: a conta custodiante, o nome do lugar e o endereço
// (que é o endereço do próprio ponto — a troca entra no histórico de
// endereço, pontos/endereco.js). Conta ou nome diferentes = base nova: o
// período anterior vai para o histórico e o ramo do ponto passa a ser o da
// conta nova (é ele que a trava de ramo da playlist protege). Mesma conta e
// mesmo nome = só correção do endereço da base.
// A base nunca vira dona: `anunciante_id` continua NULL.
async function alterarBase(pontoId, corpo, admin) {
  const contaId = Number(corpo?.base_conta_id);
  if (!Number.isInteger(contaId) || contaId <= 0) throw erro(400, 'Escolha a conta da base', 'base_conta_id');
  const nome = texto(corpo?.base_nome, 'base_nome', 'Nome da base', LIMITES.nome);
  const problema = problemaNoEndereco(corpo);
  if (problema) throw erro(400, problema.erro, problema.campo);
  const partes = Object.fromEntries(PARTES.filter((p) => corpo?.[p] !== undefined).map((p) => [p, corpo[p]]));

  return emTransacao(async (c) => {
    const ponto = await travarMovel(c, pontoId);
    const {
      rows: [conta],
    } = await c.query(
      `SELECT a.id, a.excluido_em, a.categoria_id, a.categoria_livre, cat.nome AS categoria_nome
         FROM anunciantes a LEFT JOIN categorias cat ON cat.id = a.categoria_id
        WHERE a.id = $1`,
      [contaId],
    );
    if (!conta || conta.excluido_em) throw erro(400, 'Conta da base não encontrada', 'base_conta_id');

    const baseNova = Number(ponto.base_conta_id) !== contaId || ponto.base_nome !== nome;
    // Base nova sem endereço deixaria o ponto "morando" no endereço da base
    // antiga.
    if (baseNova && !Object.keys(partes).length) throw erro(400, 'Endereço da base: preencha', 'cep');
    let atual = ponto;
    if (baseNova) {
      await fecharPeriodoDaBase(c, ponto, admin);
      const contaMudou = Number(ponto.base_conta_id) !== contaId;
      const { rows } = await c.query(
        `UPDATE pontos
            SET base_conta_id = $2, base_nome = $3, base_desde = now(),
                categoria_id = CASE WHEN $4 THEN $5::int ELSE categoria_id END,
                categoria_livre = CASE WHEN $4 THEN $6::text ELSE categoria_livre END,
                segmento = CASE WHEN $4 THEN COALESCE($7::text, $6::text, segmento) ELSE segmento END
          WHERE id = $1 RETURNING *`,
        [ponto.id, contaId, nome, contaMudou, conta.categoria_id, conta.categoria_livre, conta.categoria_nome],
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
// Fixo ⇄ móvel depois da aprovação ("quando fizer sentido")
// ---------------------------------------------------------------------------
// Fixo → móvel: a conta dona vira a BASE (custodiante) e o ponto passa a ser
// da Mostraí. É a regra de "dono mudou" que o sistema já tem: o Plano Básico
// deste ponto termina (basico.js, motivo `dono_mudou`) e o crédito mensal
// para de contar daqui pra frente; o que ela já ganhou fica com ela.
async function tornarMovel(pontoId) {
  return emTransacao(async (c) => {
    const ponto = await travarPonto(c, pontoId);
    if (ponto.tipo === 'movel') throw erro(409, 'Esse ponto já é móvel');
    if (!ponto.anunciante_id) {
      throw erro(
        409,
        'Ponto sem conta vinculada não vira móvel: a conta que cede o lugar vira a base, e este não tem nenhuma',
      );
    }
    const numero = ponto.movel_numero || (await proximoNumeroMovel(c));
    await c.query(
      `UPDATE pontos
          SET tipo = 'movel', movel_numero = $2, nome = $3,
              base_conta_id = anunciante_id, base_nome = nome, base_desde = now(), anunciante_id = NULL
        WHERE id = $1`,
      [ponto.id, numero, nomeDoMovel(numero)],
    );
    await require('./basico').sincronizar({ apenasPontos: [ponto.id], db: c });
    return { exDono: ponto.anunciante_id };
  });
}

// Móvel → fixo: decisão explícita do Admin de deixar o ponto de vez na base
// atual — a conta da base passa a ser a DONA, com o que todo dono de ponto
// fixo tem pelas regras de sempre (crédito mensal, Plano Básico). Só sem
// evento aberto: ponto fixo não tem evento.
async function tornarFixo(pontoId, admin) {
  return emTransacao(async (c) => {
    const ponto = await travarMovel(c, pontoId);
    const { rows: abertos } = await c.query(
      `SELECT 1 FROM pontos_moveis_eventos WHERE ponto_id = $1 AND estado IN ('programado', 'em_andamento') LIMIT 1`,
      [ponto.id],
    );
    if (abertos.length) {
      throw erro(409, 'Encerre o evento em andamento e cancele os programados antes — ponto fixo não tem evento');
    }
    await fecharPeriodoDaBase(c, ponto, admin);
    await c.query(
      `UPDATE pontos
          SET tipo = 'fixo', anunciante_id = base_conta_id, nome = base_nome,
              base_conta_id = NULL, base_nome = NULL, base_desde = NULL
        WHERE id = $1`,
      [ponto.id],
    );
    await require('./basico').sincronizar({ apenasPontos: [ponto.id], db: c });
    return { novoDono: ponto.base_conta_id };
  });
}

// Quem precisa ver a mudança sem F5: a conta da base e quem escolheu o ponto.
async function contasInteressadas(pontoId, extras = []) {
  const { rows } = await pool.query(
    `SELECT anunciante_id AS id FROM anunciantes_pontos WHERE ponto_id = $1
     UNION SELECT base_conta_id FROM pontos WHERE id = $1 AND base_conta_id IS NOT NULL`,
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
  fichaDoMovel,
  validarEvento,
  criarEvento,
  iniciarEvento,
  encerrarEvento,
  cancelarEvento,
  alterarBase,
  tornarMovel,
  tornarFixo,
  contasInteressadas,
};
