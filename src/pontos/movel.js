const pool = require('../db/pool');
const alocacao = require('./alocacao');
const { resumo: resumoDoHorario } = require('../lib/horario-semanal');

// PONTO MÓVEL (02/10/2026, pedido do dono; migrations 112, 113 e 114). Um
// ATIVO ITINERANTE da própria Mostraí: 1 ponto móvel = 1 tela. Nasce só pelo
// Admin (nunca de candidatura), nunca tem dono e nunca vira fixo (tipo
// imutável, gatilho na 113). NÃO TEM BASE (migration 114): é equipamento, e
// só tem local, contexto comercial, horário e lugar no inventário enquanto
// está ALOCADO — numa HOSPEDAGEM (um comércio recebe por um período,
// src/pontos/hospedagem.js) ou num EVENTO. Sem alocação, "Sem alocação":
// `localAtual` null, fora do inventário, a tela (se ligada) só toca o
// institucional. `anunciante_id` fica NULL (CHECK no banco), e por isso nada
// do que nasce do dono (crédito mensal, Plano Básico, cupom, "Meus pontos"
// como dono) chega em ninguém.
//
// Regras que moram SÓ aqui (o navegador nunca decide):
//   · LOCAL ATUAL: a hospedagem ativa, ou o evento em andamento; sem nenhum
//     dos dois, nenhum (os dois nunca coexistem: agenda única,
//     src/pontos/agenda.js);
//   · PRÓXIMO EVENTO: o programado de início mais próximo que ainda não
//     terminou. Cancelado nunca é próximo nem local atual — e fica no
//     histórico;
//   · alocação (hospedagem ou evento) tem período com data E hora e o seu
//     horário de funcionamento (src/pontos/alocacao.js) — é ele que vai para
//     a TV;
//   · só o Admin mexe (todas as rotas estão em /admin — src/server.js).
//
// O público estimado é ESTIMATIVA do evento: aparece como "~600 pessoas"
// e nunca entra em Proof-of-Play, impressão ou alcance.

const LIMITES = { nome: 120, organizacao: 120, local: 160, observacao: 500, publicoMaximo: 1_000_000 };
const agenda = require('./agenda');

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

// "Mostraí Móvel #01": o número é do móvel (migration 112), nunca reaproveitado.
const nomeDoMovel = (numero) => `Mostraí Móvel #${String(numero).padStart(2, '0')}`;

async function proximoNumeroMovel(db) {
  const { rows } = await db.query(`SELECT nextval('pontos_movel_numero_seq')::int AS numero`);
  return rows[0].numero;
}

// ---------------------------------------------------------------------------
// Leitura: local atual e próximo evento de cada móvel
// ---------------------------------------------------------------------------
// Uma consulta para N pontos (lista do anunciante, grade do admin). Ponto
// fixo não entra no mapa. É leitura PÚBLICA (card do anunciante): da
// hospedagem saem só o nome e o endereço do local — nunca a conta, o
// período, o percentual, o saldo ou o histórico. Hospedagem futura não
// aparece. Sem alocação: `localAtual` null.
async function situacaoDosMoveis(pontoIds, db = pool) {
  const ids = [...new Set(pontoIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const { rows } = await db.query(
    `SELECT p.id,
            atual.id AS atual_id, atual.nome AS atual_nome, atual.local AS atual_local,
            atual.inicio AS atual_inicio, atual.fim AS atual_fim,
            hosp.id AS hosp_id, hosp.local AS hosp_local, hosp.endereco AS hosp_endereco,
            prox.id AS prox_id, prox.nome AS prox_nome, prox.local AS prox_local,
            prox.inicio AS prox_inicio, prox.fim AS prox_fim, prox.publico_estimado AS prox_publico
       FROM pontos p
       LEFT JOIN pontos_moveis_eventos atual ON atual.ponto_id = p.id AND atual.estado = 'em_andamento'
       LEFT JOIN pontos_moveis_hospedagens hosp ON hosp.ponto_id = p.id AND hosp.estado = 'ativa'
       LEFT JOIN LATERAL (
         SELECT e.id, e.nome, e.local, e.inicio, e.fim, e.publico_estimado
           FROM pontos_moveis_eventos e
          WHERE e.ponto_id = p.id AND e.estado = 'programado' AND e.fim > now()
          ORDER BY e.inicio, e.id
          LIMIT 1
       ) prox ON true
      WHERE p.id = ANY($1::int[]) AND p.tipo = 'movel'`,
    [ids],
  );
  return new Map(rows.map((r) => [r.id, montarSituacao(r)]));
}

function montarSituacao(r) {
  return {
    localAtual: r.hosp_id
      ? { origem: 'hospedagem', nome: r.hosp_local, endereco: r.hosp_endereco }
      : r.atual_id
        ? {
            origem: 'evento',
            nome: r.atual_local,
            endereco: r.atual_local,
            evento: {
              id: Number(r.atual_id),
              nome: r.atual_nome,
              inicio: r.atual_inicio,
              fim: r.atual_fim,
              dataInicio: alocacao.dataEmMatao(r.atual_inicio),
              dataFim: alocacao.datasDoPeriodo(r.atual_inicio, r.atual_fim).dataFim,
            },
          }
        : null,
    proximoEvento: r.prox_id
      ? {
          id: Number(r.prox_id),
          nome: r.prox_nome,
          local: r.prox_local,
          inicio: r.prox_inicio,
          fim: r.prox_fim,
          dataInicio: alocacao.dataEmMatao(r.prox_inicio),
          dataFim: alocacao.datasDoPeriodo(r.prox_inicio, r.prox_fim).dataFim,
          publicoEstimado: r.prox_publico,
        }
      : null,
  };
}

// AGORA e PRÓXIMO de cada móvel, para o Admin: o compromisso em curso
// (hospedagem ativa — com a conta — ou evento em andamento) e o próximo da
// agenda (hospedagem programada ou evento programado), com início e fim.
const AGORA_SQL = `(SELECT json_build_object('tipo', x.tipo, 'id', x.id, 'nome', x.nome, 'conta', x.conta,
                                            'inicio', x.inicio, 'fim', x.fim)
     FROM (SELECT 'hospedagem' AS tipo, h.id, h.local AS nome, ca.nome_empresa AS conta, h.inicio, h.fim
             FROM pontos_moveis_hospedagens h JOIN anunciantes ca ON ca.id = h.conta_id
            WHERE h.ponto_id = p.id AND h.estado = 'ativa'
           UNION ALL
           SELECT 'evento', e.id, e.nome, NULL, e.inicio, e.fim
             FROM pontos_moveis_eventos e
            WHERE e.ponto_id = p.id AND e.estado = 'em_andamento'
           LIMIT 1) x)`;
const PROXIMO_SQL = `(SELECT json_build_object('tipo', x.tipo, 'id', x.id, 'nome', x.nome, 'conta', x.conta,
                                              'inicio', x.inicio, 'fim', x.fim)
     FROM (SELECT 'hospedagem' AS tipo, h.id, h.local AS nome, ca.nome_empresa AS conta, h.inicio, h.fim
             FROM pontos_moveis_hospedagens h JOIN anunciantes ca ON ca.id = h.conta_id
            WHERE h.ponto_id = p.id AND h.estado = 'programada' AND h.fim > now()
           UNION ALL
           SELECT 'evento', e.id, e.nome, NULL, e.inicio, e.fim
             FROM pontos_moveis_eventos e
            WHERE e.ponto_id = p.id AND e.estado = 'programado' AND e.fim > now()
           ORDER BY 5, 2 LIMIT 1) x)`;

// Admin → Rede → Pontos móveis: cada equipamento com a foto, a tela, o que
// está fazendo AGORA (sem alocação, hospedado, em evento) e o PRÓXIMO
// compromisso.
async function listarMoveis() {
  const { rows } = await pool.query(
    `SELECT p.id, p.nome, p.status, p.movel_numero, p.foto_instalacao_url,
            (SELECT row_to_json(t) FROM (
               SELECT d.id, d.apelido, d.status, d.ultima_vez_online, (d.chave_hash IS NOT NULL) AS chave_hash,
                      d.player_estado, d.ultimo_erro_codigo, d.ultimo_erro
                 FROM dispositivos d WHERE d.ponto_id = p.id AND d.status <> 'inativo' ORDER BY d.id LIMIT 1) t) AS tela,
            ${require('../lib/contexto-do-ponto').horarioEmVigorSql('p')} AS horario_em_vigor,
            ${AGORA_SQL} AS agora, ${PROXIMO_SQL} AS proximo
       FROM pontos p
      WHERE p.tipo = 'movel' AND p.status <> 'arquivado'
      ORDER BY p.movel_numero, p.id`,
  );
  return rows.map((r) => ({
    id: r.id,
    nome: r.nome,
    numero: r.movel_numero,
    status: r.status,
    foto: r.foto_instalacao_url,
    // Admin: cadastro, conectividade e operação separados (§8). Sem
    // alocação a tela pode estar ligada — conectividade não é inventário.
    tela: r.tela && {
      id: r.tela.id,
      nome: r.tela.apelido,
      status: r.tela.status,
      ...require('../lib/status-tela').estadosDaTela(r.tela, r.horario_em_vigor),
    },
    alocado: Boolean(r.agora),
    agora: r.agora,
    proximo: r.proximo,
  }));
}

// Ficha do Admin, por seções: Equipamento (número, nome, foto, nota),
// Tela, Situação atual (agora/próximo), Agenda (os compromissos que ainda
// vão acontecer, hospedagens e eventos juntos, por início), Hospedagens e
// Eventos (com histórico) e o histórico de bases do modelo antigo (só
// leitura — anterior à migration 114).
async function fichaDoMovel(pontoId) {
  const {
    rows: [p],
  } = await pool.query(
    `SELECT p.id, p.tipo, p.nome, p.foto_instalacao_url, p.movel_numero, p.observacoes, p.status,
            (SELECT json_build_object('id', d.id, 'nome', d.apelido, 'status', d.status)
               FROM dispositivos d WHERE d.ponto_id = p.id AND d.status <> 'inativo' ORDER BY d.id LIMIT 1) AS tela,
            ${AGORA_SQL} AS agora, ${PROXIMO_SQL} AS proximo
       FROM pontos p
      WHERE p.id = $1`,
    [pontoId],
  );
  if (!p) return null;
  if (p.tipo !== 'movel') return { tipo: p.tipo };
  const [situacoes, { rows: eventos }, { rows: bases }, hospedagens] = await Promise.all([
    situacaoDosMoveis([p.id]),
    pool.query(
      `SELECT e.id, e.nome, e.organizacao, e.local, e.inicio, e.fim, e.horario_operacao, e.publico_estimado,
              e.observacao, e.estado, e.iniciado_em, e.encerrado_em, e.cancelado_em, e.criado_em, e.criado_por_admin,
              e.categoria_id, cat.nome AS categoria_nome, e.encerramento,
              (e.fim <= now()) AS terminou,
              (SELECT COUNT(*)::int FROM execucoes_confirmadas x
                WHERE x.evento_id = e.id AND x.status = 'contabilizado') AS exibicoes_confirmadas
         FROM pontos_moveis_eventos e LEFT JOIN categorias cat ON cat.id = e.categoria_id
        WHERE e.ponto_id = $1
        ORDER BY CASE e.estado WHEN 'em_andamento' THEN 0 WHEN 'programado' THEN 1 ELSE 2 END,
                 CASE WHEN e.estado = 'programado' THEN e.inicio END,
                 e.inicio DESC, e.id DESC`,
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
  const listaDeEventos = eventos.map((e) => ({
    id: Number(e.id),
    nome: e.nome,
    organizacao: e.organizacao,
    local: e.local,
    inicio: e.inicio,
    fim: e.fim,
    inicioLocal: alocacao.parede(e.inicio),
    fimLocal: alocacao.parede(e.fim),
    horarioOperacao: e.horario_operacao,
    horario: e.horario_operacao ? resumoDoHorario(e.horario_operacao) : null,
    ...alocacao.datasDoPeriodo(e.inicio, e.fim),
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
  }));
  // A agenda: o que ainda vai acontecer (ou está acontecendo), por início.
  const agendaDoMovel = [
    ...hospedagens
      .filter((h) => h.estado === 'programada' || h.estado === 'ativa')
      .map((h) => ({
        tipo: 'hospedagem',
        id: h.id,
        nome: h.local,
        conta: h.conta?.nome,
        inicio: h.inicio,
        fim: h.fim,
        estado: h.estado,
      })),
    ...listaDeEventos
      .filter((e) => e.estado === 'programado' || e.estado === 'em_andamento')
      .map((e) => ({
        tipo: 'evento',
        id: e.id,
        nome: e.nome,
        conta: null,
        inicio: e.inicio,
        fim: e.fim,
        estado: e.estado,
      })),
  ].sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  return {
    tipo: 'movel',
    numero: p.movel_numero,
    nome: p.nome,
    status: p.status,
    foto: p.foto_instalacao_url,
    notaInterna: p.observacoes,
    tela: p.tela,
    alocado: Boolean(p.agora),
    agora: p.agora,
    proximo: p.proximo,
    localAtual: situacao.localAtual,
    proximoEvento: situacao.proximoEvento,
    agenda: agendaDoMovel,
    hospedagens,
    eventos: listaDeEventos,
    // Histórico do modelo antigo (anterior à 114): só leitura.
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

// Trava a linha do ponto: toda escrita de alocação de um mesmo ponto passa
// uma de cada vez (iniciar dois compromissos, agendar dois no mesmo
// período — nada disso cruza).
async function travarPonto(cliente, pontoId) {
  const { rows } = await cliente.query('SELECT * FROM pontos WHERE id = $1 FOR UPDATE', [pontoId]);
  if (!rows[0]) throw erro(404, 'ponto não encontrado');
  if (rows[0].status === 'arquivado') throw erro(409, 'ponto arquivado não muda');
  return rows[0];
}

async function travarMovel(cliente, pontoId) {
  const ponto = await travarPonto(cliente, pontoId);
  if (ponto.tipo !== 'movel') throw erro(409, 'esse ponto é fixo — hospedagem e eventos são só do ponto móvel');
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

// Cadastro leve (pedido do dono): nome, organização, local, período com data
// e hora (`inicio`/`fim`, no relógio de Matão) e o HORÁRIO DE FUNCIONAMENTO
// do evento (obrigatório — nunca 24 h automático; '24h' é escolha
// explícita). Público e observação, opcionais. `categoria_id`: o CONTEXTO DE
// CONCORRÊNCIA do evento — o ramo que a trava de concorrente protege enquanto
// ele está em andamento. Vazio = sem restrição.
function validarEvento(corpo, { agora = new Date() } = {}) {
  const nome = texto(corpo?.nome, 'nome', 'Nome do evento', LIMITES.nome);
  const organizacao = texto(corpo?.organizacao, 'organizacao', 'Organização', LIMITES.organizacao);
  const local = texto(corpo?.local, 'local', 'Local', LIMITES.local);
  const periodo = alocacao.lerPeriodo(corpo, { agora });
  const horario = alocacao.lerHorario(corpo?.horario_operacao);
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
  return { nome, organizacao, local, ...periodo, horario, publicoEstimado, observacao, categoriaId };
}

async function criarEvento(pontoId, corpo, admin) {
  const ev = validarEvento(corpo);
  return emTransacao(async (c) => {
    await travarMovel(c, pontoId);
    if (ev.categoriaId) {
      const { rows } = await c.query('SELECT 1 FROM categorias WHERE id = $1', [ev.categoriaId]);
      if (!rows[0]) throw erro(400, 'Contexto de concorrência: ramo não encontrado', 'categoria_id');
    }
    await agenda.exigirLivre(c, pontoId, ev.inicio, ev.fim);
    const { rows } = await c.query(
      `INSERT INTO pontos_moveis_eventos
         (ponto_id, nome, organizacao, local, data_inicio, data_fim, publico_estimado, observacao, criado_por_admin,
          categoria_id, inicio, fim, horario_operacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        ev.inicio,
        ev.fim,
        JSON.stringify(ev.horario),
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
        `SELECT *, (fim <= now()) AS terminou FROM pontos_moveis_eventos
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
// começar antes do início (montagem); não depois que acabou. Nunca começa
// sozinho.
async function iniciarEvento(pontoId, eventoId) {
  return emTransacao(async (c) => {
    await travarMovel(c, pontoId);
    const ev = await eventoDoPonto(c, pontoId, eventoId);
    if (ev.estado !== 'programado') throw erro(409, JA_ESTA[ev.estado]);
    if (ev.terminou) throw erro(409, 'Esse evento já terminou pelo horário — cancele ou cadastre de novo');
    await agenda.exigirLivre(c, pontoId, ev.inicio, ev.fim, {
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

// Entrar numa alocação ou sair dela muda o horário que vai para a TV
// (src/lib/contexto-do-ponto.js): a versão da config sobe como numa troca de
// horário (migration 093) e a TV busca a config nova no próximo heartbeat.
async function avisarTelas(c, pontoId) {
  await c.query(
    `UPDATE dispositivos SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now()
      WHERE ponto_id = $1`,
    [pontoId],
  );
}

// "Encerrar evento": o móvel fica sem alocação (até a próxima).
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
      throw erro(409, 'O ponto já está nesse evento — use Encerrar');
    }
    if (ev.estado !== 'programado') throw erro(409, JA_ESTA[ev.estado]);
    await c.query(
      `UPDATE pontos_moveis_eventos SET estado = 'cancelado', cancelado_em = now(), encerramento = 'manual'
        WHERE id = $1`,
      [ev.id],
    );
  });
}

// ---------------------------------------------------------------------------
// Criação (só Admin)
// ---------------------------------------------------------------------------
// O móvel nasce AQUI e só aqui — nunca de candidatura (que sempre gera fixo).
// Só o EQUIPAMENTO: nome (opcional: "Mostraí Móvel #NN") e nota interna; a
// foto vem depois, pela rota de foto. Nada de local, endereço, ramo ou
// horário — isso é da alocação (migration 114). O tipo é automático e nunca
// há dona. A Tela 1 nasce junto (1 móvel = 1 tela). Nasce SEM ALOCAÇÃO.
async function criarPontoMovel(corpo, admin) {
  const nomeInformado = texto(corpo?.nome, 'nome', 'Nome do equipamento', LIMITES.nome, { obrigatorio: false });
  const nota = texto(corpo?.observacoes, 'observacoes', 'Nota interna', LIMITES.observacao, { obrigatorio: false });
  const pontosRepo = require('./repository');
  const ponto = await emTransacao(async (c) => {
    const numero = await proximoNumeroMovel(c);
    return pontosRepo.criar(
      {
        nome: nomeInformado || nomeDoMovel(numero),
        segmento: 'outro',
        responsavel_nome: 'Mostraí',
        responsavel_contato: '',
        observacoes: nota,
        status: 'a_instalar',
        tipo: 'movel',
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

// Quem precisa ver a mudança sem F5: o anfitrião de uma hospedagem
// programada ou ativa, e quem escolheu o ponto.
async function contasInteressadas(pontoId, extras = []) {
  const { rows } = await pool.query(
    `SELECT anunciante_id AS id FROM anunciantes_pontos WHERE ponto_id = $1
     UNION SELECT conta_id FROM pontos_moveis_hospedagens WHERE ponto_id = $1 AND estado IN ('programada', 'ativa')`,
    [pontoId],
  );
  return [...new Set([...rows.map((r) => r.id), ...extras].filter(Boolean).map(Number))];
}

module.exports = {
  LIMITES,
  nomeDoMovel,
  proximoNumeroMovel,
  situacaoDosMoveis,
  listarMoveis,
  fichaDoMovel,
  validarEvento,
  criarEvento,
  iniciarEvento,
  encerrarEvento,
  cancelarEvento,
  criarPontoMovel,
  contasInteressadas,
  // Para src/pontos/hospedagem.js — a mesma trava e as mesmas validações.
  emTransacao,
  travarMovel,
  texto,
  avisarTelas,
};
