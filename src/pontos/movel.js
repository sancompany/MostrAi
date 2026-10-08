const pool = require('../db/pool');
const alocacao = require('./alocacao');
const agenda = require('./agenda');
const { resumo: resumoDoHorario } = require('../lib/horario-semanal');
const { formatarCodigoTela } = require('../lib/codigo-tela');

// MOSTRAÍ MÓVEL = REDE MÓVEL COMERCIAL DE UMA CIDADE (migration 115, pedido
// do dono em 05/10/2026). No banco é um `pontos` com `tipo = 'movel'` (o
// nome técnico continua "ponto móvel"); no produto é a REDE — nome escolhido
// pelo Admin ("Mostraí Móvel") + cidade/UF ("Matão/SP"), campos separados
// desde a estação Rede/Admin V2 (06/10/2026) —, selo ITINERANTE, com N TELAS
// físicas (`dispositivos` comuns: Player, credencial, heartbeat, POP e
// provisionamento por tela).
//
// Não confundir:
//   · REDE        — a cidade + UF; é o que o anunciante escolhe, e conta
//                   como UMA posição do plano, tenha 1 ou 10 telas;
//   · TELA        — o equipamento físico; tem a sua agenda, o seu contexto
//                   e a sua operação;
//   · ALOCAÇÃO    — onde a tela está num período: HOSPEDAGEM (uma tela num
//                   comércio, src/pontos/hospedagem.js) ou EVENTO (uma ou
//                   várias telas da rede num evento, aqui);
//   · a agenda é POR TELA (src/pontos/agenda.js): duas telas da mesma rede
//     podem estar em lugares diferentes ao mesmo tempo; a mesma tela nunca.
//
// A rede nasce só pelo Admin (nunca de candidatura), sem dona e sem tela —
// "+ Adicionar tela" na ficha. Uma rede por cidade + UF (índice único da
// 115). Tela sem alocação não é inventário: ligada, toca só o institucional
// (src/lib/contexto-do-ponto.js). A rede aparece SEMPRE para o anunciante;
// sem tela em operação ela só não veicula (src/lib/pacing.js#poolDaRede).
//
// O público estimado é ESTIMATIVA do evento: aparece como "~600 pessoas"
// e nunca entra em Proof-of-Play, impressão ou alcance.

const LIMITES = {
  nome: 120,
  organizacao: 120,
  local: 160,
  endereco: 300,
  observacao: 500,
  cidade: 80,
  publicoMaximo: 1_000_000,
};
const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

async function proximoNumeroMovel(db) {
  const { rows } = await db.query(`SELECT nextval('pontos_movel_numero_seq')::int AS numero`);
  return rows[0].numero;
}

// ---------------------------------------------------------------------------
// Leitura: telas e compromissos das redes
// ---------------------------------------------------------------------------
// As telas de N redes (inativa fora: não é mais da operação) e os
// compromissos de cada uma que ainda contam — em curso, ou programados que
// não terminaram. Evento com 3 telas vira 3 linhas (uma por tela).
async function telasECompromissos(redeIds, db = pool) {
  const ids = [...new Set(redeIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return { telas: [], compromissos: [] };
  const [{ rows: telas }, { rows: compromissos }] = await Promise.all([
    db.query(
      `SELECT d.id, d.ponto_id, d.status, d.ultima_vez_online, (d.chave_hash IS NOT NULL) AS chave_hash,
              d.player_estado, d.ultimo_erro_codigo, d.ultimo_erro, d.primeiro_sinal_em, d.instalado_em,
              d.created_at, d.provisionado_em, d.fila_pendentes, d.fila_mais_antigo_em,
              d.config_versao_desejada, d.config_versao_aplicada, d.config_alterada_em
         FROM dispositivos d
        WHERE d.ponto_id = ANY($1::int[]) AND d.status <> 'inativo'
        ORDER BY d.id`,
      [ids],
    ),
    db.query(
      `SELECT 'hospedagem' AS tipo, h.id, h.ponto_id, h.dispositivo_id, h.local AS nome, h.local, h.endereco,
              ca.nome_empresa AS conta, h.inicio, h.fim, h.estado, h.horario_operacao
         FROM pontos_moveis_hospedagens h JOIN anunciantes ca ON ca.id = h.conta_id
        WHERE h.ponto_id = ANY($1::int[])
          AND (h.estado = 'ativa' OR (h.estado = 'programada' AND h.fim > now()))
       UNION ALL
       SELECT 'evento', e.id, e.ponto_id, et.dispositivo_id, e.nome, e.local, e.endereco,
              NULL, e.inicio, e.fim, e.estado, e.horario_operacao
         FROM pontos_moveis_eventos e JOIN pontos_moveis_evento_telas et ON et.evento_id = e.id
        WHERE e.ponto_id = ANY($1::int[])
          AND (e.estado = 'em_andamento' OR (e.estado = 'programado' AND e.fim > now()))
        ORDER BY 9, 2`,
      [ids],
    ),
  ]);
  return { telas, compromissos };
}

const emCurso = (c) => c.estado === 'ativa' || c.estado === 'em_andamento';

const compromissoCurto = (c) =>
  c && {
    tipo: c.tipo,
    id: Number(c.id),
    nome: c.nome,
    local: c.local,
    endereco: c.endereco,
    conta: c.conta,
    inicio: c.inicio,
    fim: c.fim,
    estado: c.estado,
    tela: { id: c.dispositivo_id, codigo: formatarCodigoTela(c.dispositivo_id) },
  };

// Cada tela da rede com o que está fazendo AGORA e o PRÓXIMO compromisso.
// `operando`: ativa no cadastro E alocada — é a tela comercial ativa.
function telasDaRede(redeId, telas, compromissos) {
  const { estadoDaTela } = require('../lib/status-tela');
  return telas
    .filter((t) => t.ponto_id === redeId)
    .map((t) => {
      const dela = compromissos.filter((c) => c.dispositivo_id === t.id);
      const atual = dela.find(emCurso) || null;
      const proximo = dela.find((c) => !emCurso(c)) || null;
      return {
        id: t.id,
        codigo: formatarCodigoTela(t.id),
        status: t.status,
        instaladaEm: t.instalado_em,
        primeiroSinalEm: t.primeiro_sinal_em,
        // Tela da rede MÓVEL: sem compromisso em curso = sem alocação (não
        // opera, nunca "24 h"); com ele, o horário do compromisso.
        estado: estadoDaTela(
          { ...t, ponto_tipo: 'movel', movel_alocado: Boolean(atual) },
          atual ? atual.horario_operacao : null,
        ),
        alocacao: compromissoCurto(atual),
        proximo: compromissoCurto(proximo),
        operando: t.status === 'ativo' && Boolean(atual),
      };
    });
}

// "4 telas · 2 em operação agora · 1 com compromisso futuro · 1 disponível".
// Partição das telas da rede (inativa fora): em operação (alocada agora),
// agendada (sem alocação agora, com compromisso futuro), disponível (ativa,
// sem nada) e o resto (em reparo sem compromisso).
function resumoDasTelas(telas) {
  const emOperacao = telas.filter((t) => t.operando).length;
  const agendadas = telas.filter((t) => !t.alocacao && t.proximo).length;
  const disponiveis = telas.filter((t) => t.status === 'ativo' && !t.alocacao && !t.proximo).length;
  return { telas: telas.length, emOperacao, comCompromissoFuturo: agendadas, disponiveis };
}

// Um compromisso visto de fora (anunciante, site, card): o que é, o nome
// (o comércio da hospedagem ou o nome do evento), o local do evento e o
// período — nunca conta, contato, percentual, termo, tela ou observação.
const compromissoPublico = (c) =>
  c && {
    tipo: c.tipo,
    nome: c.nome,
    local: c.tipo === 'evento' ? c.local || null : null,
    inicio: c.inicio,
    fim: c.fim,
  };

// Os locais de AGORA da rede, um por compromisso (evento com 3 telas é UM
// local), e o PRÓXIMO compromisso que ainda vai começar. `evento`: o nome do
// evento em curso (null na hospedagem, onde o local já é o comércio).
function locaisEProximo(redeId, dela, compromissos) {
  const vistos = new Set();
  const locaisAgora = [];
  for (const t of dela.filter((x) => x.operando)) {
    const chave = `${t.alocacao.tipo}:${t.alocacao.id}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    locaisAgora.push({
      origem: t.alocacao.tipo,
      nome: t.alocacao.local,
      endereco: t.alocacao.endereco,
      evento: t.alocacao.tipo === 'evento' ? t.alocacao.nome : null,
    });
  }
  const agora = Date.now();
  const futuro = compromissos
    .filter((c) => c.ponto_id === redeId && !emCurso(c) && new Date(c.fim).getTime() > agora)
    .sort((a, b) => new Date(a.inicio) - new Date(b.inicio))[0];
  return { locaisAgora, proximo: compromissoPublico(futuro) || null };
}

// Para o anunciante, "Onde estamos" e a grade do Admin: a rede com cidade,
// UF, quantas telas e quantas operando agora, ONDE as telas em operação
// estão (só nome e endereço do local — nunca conta, período, percentual ou
// agenda) e o PRÓXIMO compromisso (público: nome, local do evento,
// período). Sem tela em operação: `locaisAgora` vazio.
async function situacaoDasRedes(redeIds, db = pool) {
  const ids = [...new Set(redeIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return new Map();
  const [{ rows: redes }, { telas, compromissos }] = await Promise.all([
    db.query(
      `SELECT id, nome, cidade, uf, status, foto_instalacao_url FROM pontos WHERE id = ANY($1::int[]) AND tipo = 'movel'`,
      [ids],
    ),
    telasECompromissos(ids, db),
  ]);
  const mapa = new Map();
  for (const r of redes) {
    const dela = telasDaRede(r.id, telas, compromissos);
    const resumo = resumoDasTelas(dela);
    mapa.set(r.id, {
      nome: r.nome,
      cidade: r.cidade,
      uf: r.uf,
      status: r.status,
      foto: r.foto_instalacao_url,
      telas: resumo.telas,
      emOperacao: resumo.emOperacao,
      ...locaisEProximo(r.id, dela, compromissos),
    });
  }
  return mapa;
}

// "Onde estamos" (site público, GET /pontos): a rede móvel é UM card por
// cidade, com ou sem localização — nunca um card por tela nem por alocação,
// nunca endereço-base. Só a foto da rede, os locais de AGORA (o endereço vira
// o "Ver no mapa"; sem local, sem mapa) e o PRÓXIMO compromisso. Nada
// técnico: telas, operação e status da rede ficam de fora.
function redePublica(m) {
  if (!m) return null;
  return {
    foto: m.foto || null,
    agora: (m.locaisAgora || []).map(({ nome, endereco, evento }) => ({ nome, endereco, evento })),
    proximo: m.proximo ? { nome: m.proximo.nome, local: m.proximo.local, inicio: m.proximo.inicio } : null,
  };
}

// AGENDA MÓVEL do Admin (Rede → Pontos, filtro Móveis → "Agenda móvel"):
// os compromissos de todas as redes, uma linha por compromisso (evento com
// várias telas é UMA linha com as telas juntas). Padrão: AGORA + FUTURO (em
// curso, ou programado que ainda não terminou), por início; `historico`:
// os encerrados e cancelados, do mais recente para trás.
async function agendaDasRedes({ historico = false } = {}) {
  const filtroH = historico
    ? `h.estado IN ('encerrada', 'cancelada')`
    : `(h.estado = 'ativa' OR (h.estado = 'programada' AND h.fim > now()))`;
  const filtroE = historico
    ? `e.estado IN ('encerrado', 'cancelado')`
    : `(e.estado = 'em_andamento' OR (e.estado = 'programado' AND e.fim > now()))`;
  const { rows } = await pool.query(
    `SELECT x.* FROM (
       SELECT 'hospedagem' AS tipo, h.id, h.ponto_id, p.nome AS rede, p.cidade, p.uf, h.local AS nome,
              NULL::text AS local, ca.nome_empresa AS conta, h.inicio, h.fim, h.estado, ARRAY[h.dispositivo_id] AS telas
         FROM pontos_moveis_hospedagens h JOIN pontos p ON p.id = h.ponto_id JOIN anunciantes ca ON ca.id = h.conta_id
        WHERE ${filtroH}
       UNION ALL
       SELECT 'evento', e.id, e.ponto_id, p.nome, p.cidade, p.uf, e.nome, e.local, NULL, e.inicio, e.fim, e.estado,
              (SELECT array_agg(et.dispositivo_id ORDER BY et.dispositivo_id) FROM pontos_moveis_evento_telas et
                WHERE et.evento_id = e.id)
         FROM pontos_moveis_eventos e JOIN pontos p ON p.id = e.ponto_id
        WHERE ${filtroE}
     ) x ORDER BY ${historico ? 'x.inicio DESC' : 'x.inicio'}, x.id LIMIT 200`,
  );
  return rows.map((r) => ({
    tipo: r.tipo,
    id: Number(r.id),
    redeId: r.ponto_id,
    rede: r.rede,
    cidade: r.cidade,
    uf: r.uf,
    nome: r.nome,
    local: r.local,
    conta: r.conta,
    inicio: r.inicio,
    fim: r.fim,
    estado: r.estado,
    emCurso: r.estado === 'ativa' || r.estado === 'em_andamento',
    telas: (r.telas || []).map((id) => ({ id, codigo: formatarCodigoTela(id) })),
  }));
}

// AGENDA PÚBLICA de uma rede (o "Ver agenda" do card do anunciante): só o
// PRESENTE e o FUTURO — o que está acontecendo agora e o que vai acontecer.
// Nunca o passado, nunca público estimado, conta, contato, percentual,
// termo, tela ou observação: só tipo, nome (o comércio da hospedagem ou o
// nome do evento), local do evento e período. `null` = não é rede ativa.
async function agendaPublicaDaRede(redeId) {
  const id = /^\d{1,9}$/.test(String(redeId)) ? Number(redeId) : null;
  if (!id) return null;
  const {
    rows: [rede],
  } = await pool.query(
    `SELECT id, nome, cidade, uf FROM pontos WHERE id = $1 AND tipo = 'movel' AND status <> 'arquivado'`,
    [id],
  );
  if (!rede) return null;
  const { rows } = await pool.query(
    `SELECT 'hospedagem' AS tipo, h.id, h.local AS nome, NULL::text AS local, h.inicio, h.fim,
            (h.estado = 'ativa') AS em_curso
       FROM pontos_moveis_hospedagens h
      WHERE h.ponto_id = $1 AND h.estado IN ('ativa', 'programada') AND h.fim > now()
     UNION ALL
     SELECT 'evento', e.id, e.nome, e.local, e.inicio, e.fim, (e.estado = 'em_andamento')
       FROM pontos_moveis_eventos e
      WHERE e.ponto_id = $1 AND e.estado IN ('em_andamento', 'programado') AND e.fim > now()
      ORDER BY 5, 2 LIMIT 100`,
    [id],
  );
  const linha = (r) => compromissoPublico(r);
  return {
    rede: { id: rede.id, nome: rede.nome, cidade: rede.cidade, uf: rede.uf },
    agora: rows.filter((r) => r.em_curso).map(linha),
    proximos: rows.filter((r) => !r.em_curso).map(linha),
  };
}

// Ficha da rede no Admin: cabeçalho (nome, cidade/UF, selo), o resumo das
// telas, cada tela com a operação de agora, a AGENDA consolidada (cada
// compromisso com a tela), hospedagens e eventos com histórico, e o
// histórico de bases do modelo antigo (só leitura — anterior à 114).
async function fichaDaRede(redeId) {
  const {
    rows: [p],
  } = await pool.query(
    `SELECT p.id, p.tipo, p.nome, p.cidade, p.uf, p.foto_instalacao_url, p.movel_numero, p.observacoes, p.status
       FROM pontos p WHERE p.id = $1`,
    [redeId],
  );
  if (!p) return null;
  if (p.tipo !== 'movel') return { tipo: p.tipo };
  const [{ telas, compromissos }, { rows: eventos }, { rows: telasDosEventos }, { rows: bases }, hospedagens] =
    await Promise.all([
      telasECompromissos([p.id]),
      pool.query(
        `SELECT e.id, e.nome, e.organizacao, e.local, e.endereco, e.inicio, e.fim, e.horario_operacao,
                e.publico_estimado, e.observacao, e.estado, e.iniciado_em, e.encerrado_em, e.cancelado_em, e.criado_em,
                e.criado_por_admin, e.categoria_id, cat.nome AS categoria_nome, e.encerramento,
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
        `SELECT et.evento_id, et.dispositivo_id FROM pontos_moveis_evento_telas et
           JOIN pontos_moveis_eventos e ON e.id = et.evento_id
          WHERE e.ponto_id = $1 ORDER BY et.dispositivo_id`,
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
  const telasDoEvento = (id) =>
    telasDosEventos
      .filter((t) => String(t.evento_id) === String(id))
      .map((t) => ({ id: t.dispositivo_id, codigo: formatarCodigoTela(t.dispositivo_id) }));
  const listaDeEventos = eventos.map((e) => ({
    id: Number(e.id),
    nome: e.nome,
    organizacao: e.organizacao,
    local: e.local,
    endereco: e.endereco,
    inicio: e.inicio,
    fim: e.fim,
    inicioLocal: alocacao.parede(e.inicio),
    fimLocal: alocacao.parede(e.fim),
    horarioOperacao: e.horario_operacao,
    // null = "operar durante todo o período".
    horario: e.horario_operacao ? resumoDoHorario(e.horario_operacao) : null,
    ...alocacao.datasDoPeriodo(e.inicio, e.fim),
    publicoEstimado: e.publico_estimado,
    observacao: e.observacao,
    categoria: e.categoria_id ? { id: e.categoria_id, nome: e.categoria_nome } : null,
    telas: telasDoEvento(e.id),
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
  const dela = telasDaRede(p.id, telas, compromissos);
  // A agenda consolidada: o que está acontecendo ou vai acontecer, por
  // início, cada compromisso com a(s) tela(s) dele.
  const agendaDaRede = [
    ...hospedagens
      .filter((h) => h.estado === 'programada' || h.estado === 'ativa')
      .map((h) => ({
        tipo: 'hospedagem',
        id: h.id,
        nome: h.local,
        local: h.local,
        conta: h.conta?.nome,
        inicio: h.inicio,
        fim: h.fim,
        estado: h.estado,
        telas: [h.tela],
      })),
    ...listaDeEventos
      .filter((e) => e.estado === 'programado' || e.estado === 'em_andamento')
      .map((e) => ({
        tipo: 'evento',
        id: e.id,
        nome: e.nome,
        local: e.local,
        conta: null,
        inicio: e.inicio,
        fim: e.fim,
        estado: e.estado,
        telas: e.telas,
      })),
  ].sort((a, b) => new Date(a.inicio) - new Date(b.inicio));
  const resumo = resumoDasTelas(dela);
  return {
    tipo: 'movel',
    id: p.id,
    nome: p.nome,
    cidade: p.cidade,
    uf: p.uf,
    status: p.status,
    foto: p.foto_instalacao_url,
    notaInterna: p.observacoes,
    // A rede é sempre escolhível pelo anunciante (sem tela em operação ela
    // só não veicula). Arquivada sai da rede.
    disponivelParaAnunciantes: p.status !== 'arquivado',
    resumo,
    telas: dela,
    agenda: agendaDaRede,
    // O formato ÚNICO do Admin (estação Rede Front V3): agora, próximos e
    // histórico, conta e local externo lado a lado (src/pontos/compromissos.js).
    compromissos: require('./compromissos').normalizar(hospedagens, listaDeEventos),
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

// Para os formulários de evento e hospedagem: cada tela da rede, livre ou
// não no período pedido (com o motivo). É só a resposta adiantada — o
// servidor confere de novo ao gravar, e o banco por último.
async function disponibilidadeDasTelas(redeId, consulta) {
  const periodo = alocacao.lerPeriodo(consulta, { exigirFuturo: false });
  const ignorar =
    consulta?.ignorar_tipo === 'evento' || consulta?.ignorar_tipo === 'hospedagem'
      ? { tipo: consulta.ignorar_tipo, id: Number(consulta.ignorar_id) || 0 }
      : null;
  const { rows: telas } = await pool.query(
    `SELECT id, status FROM dispositivos WHERE ponto_id = $1 AND status <> 'inativo' ORDER BY id`,
    [redeId],
  );
  const ocupadas = await agenda.conflitos(
    pool,
    telas.map((t) => t.id),
    periodo.inicio,
    periodo.fim,
    { ignorar },
  );
  return telas.map((t) => {
    const conflito = ocupadas.find((o) => o.dispositivo_id === t.id);
    return {
      id: t.id,
      codigo: formatarCodigoTela(t.id),
      status: t.status,
      livre: !conflito,
      motivo: conflito ? agenda.descrever(conflito) : null,
    };
  });
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

// Trava a linha da rede: toda escrita de alocação de uma mesma rede passa
// uma de cada vez. (A agenda de cada tela também trava no banco — 115.)
async function travarMovel(cliente, pontoId) {
  const { rows } = await cliente.query('SELECT * FROM pontos WHERE id = $1 FOR UPDATE', [pontoId]);
  if (!rows[0]) throw erro(404, 'rede não encontrada');
  if (rows[0].status === 'arquivado') throw erro(409, 'rede arquivada não muda');
  if (rows[0].tipo !== 'movel') throw erro(409, 'esse ponto é fixo — hospedagem e eventos são só da rede móvel');
  return rows[0];
}

// As telas pedidas, conferidas contra a rede: existem, são desta rede e não
// estão inativas. Devolve os ids, sem repetição, em ordem.
async function telasValidas(c, redeId, pedidas, { minimo = 1, maximo = Number.POSITIVE_INFINITY } = {}) {
  const ids = [...new Set((Array.isArray(pedidas) ? pedidas : [pedidas]).map(Number))].filter(
    (id) => Number.isInteger(id) && id > 0,
  );
  if (ids.length < minimo) {
    throw erro(400, minimo === 1 && maximo === 1 ? 'Escolha a tela' : 'Escolha pelo menos uma tela', 'telas');
  }
  if (ids.length > maximo) throw erro(400, 'Escolha uma tela só', 'telas');
  const { rows } = await c.query(
    `SELECT id FROM dispositivos WHERE id = ANY($1::int[]) AND ponto_id = $2 AND status <> 'inativo'`,
    [ids, redeId],
  );
  if (rows.length !== ids.length)
    throw erro(400, 'Uma das telas escolhidas não é desta rede (ou está inativa)', 'telas');
  return ids.sort((a, b) => a - b);
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

function lerUf(valor) {
  const uf = typeof valor === 'string' ? valor.trim().toUpperCase() : '';
  if (!UFS.has(uf)) throw erro(400, 'UF: escolha o estado', 'uf');
  return uf;
}

// Horário de uma alocação (evento ou hospedagem). Padrão: "Operar durante
// todo o período" — sem grade (NULL: a TV opera o período inteiro). Com
// `horario_operacao`, a grade semanal com feriados.
function lerHorarioDaAlocacao(corpo) {
  if (corpo?.operar_todo_periodo === true || corpo?.horario_operacao == null || corpo?.horario_operacao === '') {
    return null;
  }
  return alocacao.lerHorario(corpo.horario_operacao);
}

// Contexto de concorrência (categoria protegida): vazio = nenhuma restrição.
function lerCategoria(valor) {
  if (valor === undefined || valor === null || String(valor).trim() === '') return null;
  const id = Number(String(valor).trim());
  if (!Number.isInteger(id) || id <= 0) {
    throw erro(400, 'Categoria protegida: escolha uma categoria da lista (ou nenhuma restrição)', 'categoria_id');
  }
  return id;
}

async function exigirCategoria(c, categoriaId) {
  if (!categoriaId) return;
  const { rows } = await c.query('SELECT 1 FROM categorias WHERE id = $1', [categoriaId]);
  if (!rows[0]) throw erro(400, 'Categoria protegida: categoria não encontrada', 'categoria_id');
}

// Evento: nome, organização (opcional), local e endereço (a cidade é a da
// rede), público estimado e observação (opcionais), período com data e hora,
// horário (padrão: o período inteiro), a categoria protegida e as TELAS
// PARTICIPANTES (uma ou várias da rede).
function validarEvento(corpo, { agora = new Date() } = {}) {
  const nome = texto(corpo?.nome, 'nome', 'Nome do evento', LIMITES.nome);
  const organizacao = texto(corpo?.organizacao, 'organizacao', 'Organização', LIMITES.organizacao, {
    obrigatorio: false,
  });
  const local = texto(corpo?.local, 'local', 'Local', LIMITES.local);
  const endereco = texto(corpo?.endereco, 'endereco', 'Endereço', LIMITES.endereco);
  const periodo = alocacao.lerPeriodo(corpo, { agora });
  const horario = lerHorarioDaAlocacao(corpo);
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
  const categoriaId = lerCategoria(corpo?.categoria_id);
  return { nome, organizacao, local, endereco, ...periodo, horario, publicoEstimado, observacao, categoriaId };
}

async function criarEvento(redeId, corpo, admin) {
  const ev = validarEvento(corpo);
  return emTransacao(async (c) => {
    await travarMovel(c, redeId);
    await exigirCategoria(c, ev.categoriaId);
    const telas = await telasValidas(c, redeId, corpo?.telas);
    await agenda.exigirLivres(c, telas, ev.inicio, ev.fim);
    const { rows } = await c.query(
      `INSERT INTO pontos_moveis_eventos
         (ponto_id, nome, organizacao, local, endereco, data_inicio, data_fim, publico_estimado, observacao,
          criado_por_admin, categoria_id, inicio, fim, horario_operacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        redeId,
        ev.nome,
        ev.organizacao,
        ev.local,
        ev.endereco,
        ev.dataInicio,
        ev.dataFim,
        ev.publicoEstimado,
        ev.observacao,
        admin || null,
        ev.categoriaId,
        ev.inicio,
        ev.fim,
        ev.horario ? JSON.stringify(ev.horario) : null,
      ],
    );
    const id = rows[0].id;
    await c.query(`INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id) SELECT $1, unnest($2::int[])`, [
      id,
      telas,
    ]);
    return Number(id);
  }).catch((err) => {
    throw agenda.traduzirErroDoBanco(err);
  });
}

// Editar um evento PROGRAMADO (estação Rede Front V3 — o compromisso unificado
// edita os dois tipos): nome, organização, local, endereço, período, horário,
// telas, categoria e observação, com as mesmas regras do cadastro e a agenda
// conferida sem contar o próprio evento. Começou → 409 (só encerrar).
async function editarEvento(redeId, eventoId, corpo) {
  const ev = validarEvento(corpo);
  return emTransacao(async (c) => {
    await travarMovel(c, redeId);
    const atual = await eventoDaRede(c, redeId, eventoId);
    if (atual.estado !== 'programado') throw erro(409, JA_ESTA[atual.estado]);
    await exigirCategoria(c, ev.categoriaId);
    const telas = await telasValidas(c, redeId, corpo?.telas);
    await agenda.exigirLivres(c, telas, ev.inicio, ev.fim, { ignorar: { tipo: 'evento', id: atual.id } });
    // As telas saem antes de mudar o período: o gatilho da agenda do evento
    // confere as telas que ele já tem.
    await c.query('DELETE FROM pontos_moveis_evento_telas WHERE evento_id = $1', [atual.id]);
    await c.query(
      `UPDATE pontos_moveis_eventos
          SET nome = $2, organizacao = $3, local = $4, endereco = $5, data_inicio = $6, data_fim = $7,
              observacao = $8, categoria_id = $9, inicio = $10, fim = $11, horario_operacao = $12
        WHERE id = $1`,
      [
        atual.id,
        ev.nome,
        ev.organizacao,
        ev.local,
        ev.endereco,
        ev.dataInicio,
        ev.dataFim,
        ev.observacao,
        ev.categoriaId,
        ev.inicio,
        ev.fim,
        ev.horario ? JSON.stringify(ev.horario) : null,
      ],
    );
    await c.query(`INSERT INTO pontos_moveis_evento_telas (evento_id, dispositivo_id) SELECT $1, unnest($2::int[])`, [
      atual.id,
      telas,
    ]);
    return { id: Number(atual.id), inicio: ev.inicio, fim: ev.fim };
  }).catch((err) => {
    throw agenda.traduzirErroDoBanco(err);
  });
}

async function eventoDaRede(c, redeId, eventoId) {
  const id = /^\d{1,15}$/.test(String(eventoId)) ? String(eventoId) : null;
  const { rows } = id
    ? await c.query(
        `SELECT e.*, (e.fim <= now()) AS terminou,
                COALESCE((SELECT array_agg(et.dispositivo_id ORDER BY et.dispositivo_id)
                            FROM pontos_moveis_evento_telas et WHERE et.evento_id = e.id), ARRAY[]::int[]) AS telas
           FROM pontos_moveis_eventos e WHERE e.id = $1 AND e.ponto_id = $2 FOR UPDATE OF e`,
        [id, redeId],
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

// "As telas chegaram ao evento": cada tela participante passa a operar no
// contexto do evento. Pode começar antes do início (montagem); não depois
// que acabou. Nunca começa sozinho.
async function iniciarEvento(redeId, eventoId) {
  return emTransacao(async (c) => {
    await travarMovel(c, redeId);
    const ev = await eventoDaRede(c, redeId, eventoId);
    if (ev.estado !== 'programado') throw erro(409, JA_ESTA[ev.estado]);
    if (ev.terminou) throw erro(409, 'Esse evento já terminou pelo horário — cancele ou cadastre de novo');
    await agenda.exigirLivres(c, ev.telas, ev.inicio, ev.fim, {
      ignorar: { tipo: 'evento', id: ev.id },
      emCurso: true,
    });
    await c.query(`UPDATE pontos_moveis_eventos SET estado = 'em_andamento', iniciado_em = now() WHERE id = $1`, [
      ev.id,
    ]);
    await avisarTelas(c, ev.telas);
  }).catch((err) => {
    throw agenda.traduzirErroDoBanco(err);
  });
}

// Entrar numa alocação ou sair dela muda o horário que vai para a TV
// (src/lib/contexto-do-ponto.js): a versão da config DAS TELAS ENVOLVIDAS
// sobe como numa troca de horário (migration 093) e cada TV busca a config
// nova no próximo heartbeat. As outras telas da rede não mudam.
async function avisarTelas(c, telaIds) {
  const ids = [...new Set((telaIds || []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  await c.query(
    `UPDATE dispositivos SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now()
      WHERE id = ANY($1::int[])`,
    [ids],
  );
}

// "Encerrar evento": as telas dele ficam sem alocação (até a próxima).
async function encerrarEvento(redeId, eventoId) {
  return emTransacao(async (c) => {
    await travarMovel(c, redeId);
    const ev = await eventoDaRede(c, redeId, eventoId);
    if (ev.estado === 'programado') throw erro(409, 'Esse evento ainda não começou — para desistir dele, cancele');
    if (ev.estado !== 'em_andamento') throw erro(409, JA_ESTA[ev.estado]);
    await c.query(
      `UPDATE pontos_moveis_eventos SET estado = 'encerrado', encerrado_em = now(), encerramento = 'manual'
        WHERE id = $1`,
      [ev.id],
    );
    await avisarTelas(c, ev.telas);
  });
}

// Cancelado não vira alocação nem próximo compromisso, e continua auditável.
async function cancelarEvento(redeId, eventoId) {
  return emTransacao(async (c) => {
    await travarMovel(c, redeId);
    const ev = await eventoDaRede(c, redeId, eventoId);
    if (ev.estado === 'em_andamento') throw erro(409, 'O evento já está em andamento — use Encerrar');
    if (ev.estado !== 'programado') throw erro(409, JA_ESTA[ev.estado]);
    await c.query(
      `UPDATE pontos_moveis_eventos SET estado = 'cancelado', cancelado_em = now(), encerramento = 'manual'
        WHERE id = $1`,
      [ev.id],
    );
  });
}

// ---------------------------------------------------------------------------
// A rede (só Admin)
// ---------------------------------------------------------------------------
// A rede nasce AQUI e só aqui — nunca de candidatura. Nome, cidade e UF
// obrigatórios e SEPARADOS (estação Rede/Admin V2: o sistema não compõe
// "Nome — Cidade" sozinho; o card mostra "Mostraí Móvel" e "Matão/SP");
// nota interna opcional; a foto/capa vem depois, pela rota de foto. NENHUMA
// tela nasce junto: "+ Adicionar tela" na ficha. Uma rede por cidade + UF.
async function criarRedeMovel(corpo, admin) {
  const cidade = texto(corpo?.cidade, 'cidade', 'Cidade', LIMITES.cidade);
  const uf = lerUf(corpo?.uf);
  const nome = texto(corpo?.nome, 'nome', 'Nome da rede', LIMITES.nome);
  const nota = texto(corpo?.observacoes, 'observacoes', 'Nota interna', LIMITES.observacao, { obrigatorio: false });
  const pontosRepo = require('./repository');
  let rede;
  try {
    rede = await emTransacao(async (c) => {
      await existeRedeNaCidade(c, cidade, uf);
      const numero = await proximoNumeroMovel(c);
      return pontosRepo.criar(
        {
          nome,
          cidade,
          uf,
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
  } catch (err) {
    throw redeDuplicada(err, cidade, uf);
  }
  require('../lib/eventos').registrar('ponto:movel_criado', { ponto_id: rede.id, admin: admin || null });
  return { id: rede.id, nome: rede.nome, cidade, uf };
}

async function existeRedeNaCidade(c, cidade, uf, exceto = null) {
  const { rows } = await c.query(
    `SELECT 1 FROM pontos WHERE tipo = 'movel' AND status <> 'arquivado'
        AND lower(btrim(cidade)) = lower(btrim($1)) AND uf = $2 AND id IS DISTINCT FROM $3`,
    [cidade, uf, exceto],
  );
  if (rows[0]) throw erro(409, `Já existe uma rede móvel em ${cidade}/${uf}`, 'cidade');
}

// Corrida que escapou da pergunta acima: o índice único da 115 responde.
function redeDuplicada(err, cidade, uf) {
  if (err?.code === '23505' && /ux_pontos_rede_movel_cidade/.test(err.constraint || err.message || '')) {
    return erro(409, `Já existe uma rede móvel em ${cidade}/${uf}`, 'cidade');
  }
  return err;
}

// Editar a rede: nome, cidade, UF e nota interna. Mudar a cidade NÃO muda o
// nome (são campos independentes); nome vazio é recusado.
async function editarRede(redeId, corpo) {
  return emTransacao(async (c) => {
    const atual = await travarMovel(c, redeId);
    const cidade = corpo?.cidade !== undefined ? texto(corpo.cidade, 'cidade', 'Cidade', LIMITES.cidade) : atual.cidade;
    const uf = corpo?.uf !== undefined ? lerUf(corpo.uf) : atual.uf;
    const nome = corpo?.nome !== undefined ? texto(corpo.nome, 'nome', 'Nome da rede', LIMITES.nome) : atual.nome;
    const nota =
      corpo?.observacoes !== undefined
        ? texto(corpo.observacoes, 'observacoes', 'Nota interna', LIMITES.observacao, { obrigatorio: false })
        : atual.observacoes;
    await existeRedeNaCidade(c, cidade, uf, atual.id);
    await c
      .query('UPDATE pontos SET nome = $2, cidade = $3, uf = $4, observacoes = $5 WHERE id = $1', [
        atual.id,
        nome,
        cidade,
        uf,
        nota,
      ])
      .catch((err) => {
        throw redeDuplicada(err, cidade, uf);
      });
    return { id: atual.id, nome, cidade, uf };
  });
}

// Quem precisa ver a mudança sem F5: o anfitrião de uma hospedagem
// programada ou ativa, e quem escolheu a rede.
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
  situacaoDasRedes,
  redePublica,
  agendaDasRedes,
  agendaPublicaDaRede,
  fichaDaRede,
  disponibilidadeDasTelas,
  validarEvento,
  criarEvento,
  editarEvento,
  iniciarEvento,
  encerrarEvento,
  cancelarEvento,
  criarRedeMovel,
  editarRede,
  contasInteressadas,
  // Para src/pontos/hospedagem.js — a mesma trava e as mesmas validações.
  emTransacao,
  travarMovel,
  telasValidas,
  texto,
  lerHorarioDaAlocacao,
  lerCategoria,
  exigirCategoria,
  avisarTelas,
};
