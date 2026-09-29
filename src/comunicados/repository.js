const pool = require('../db/pool');
const outbox = require('../email/outbox');
const publicos = require('./publicos');
const conteudo = require('./conteudo');

// Comunicados por e-mail (migration 108). O envio é a fila de sempre
// (email_outbox): criar um comunicado grava o texto UMA vez, uma linha de
// destinatário por conta e uma mensagem na fila por destinatário — tudo na
// mesma transação. Ou entra inteiro, ou não entra nada.
//
// Envio duplicado é barrado em três camadas:
//   1. a chave do navegador (Idempotency-Key, única no banco): duplo clique,
//      tempo esgotado e nova tentativa da mesma confirmação devolvem o
//      comunicado que já existe;
//   2. a impressão digital (público + conteúdo) nas últimas 24 h: página
//      recarregada no meio do envio, outra aba, outro admin — o mesmo
//      comunicado pro mesmo público não sai de novo;
//   3. a chave de cada mensagem na fila (`comunicado:<id>:<conta>`, única):
//      o mesmo destinatário nunca entra duas vezes no mesmo comunicado.
// As criações passam uma de cada vez (trava transacional no Postgres —
// vale entre instâncias, não só dentro do processo), então 1 e 2 não têm
// corrida: a segunda requisição só olha o banco depois que a primeira
// terminou.

// Número fixo e estável da trava (o do runner de migração é outro).
const TRAVA_CRIACAO = 2909108;
const JANELA_REPETICAO_H = 24;

// Ritmo de saída: o provedor (SMTP da conta Google) limita volume por
// minuto e por dia. Cada destinatário ganha a vez `intervaloS` depois do
// anterior — 30 por minuto por padrão, ajustável por COMUNICADOS_POR_MINUTO.
// A fila continua mandando código e link de senha na hora: comunicado é
// "em massa" e vai pro fim dela (src/email/outbox.js).
const config = { intervaloS: 60 / (Number(process.env.COMUNICADOS_POR_MINUTO) || 30) };

const erro = (status, mensagem, detalhes = {}) => Object.assign(new Error(mensagem), { status, detalhes });

const chaveDaFila = (comunicadoId, anuncianteId, rodada) =>
  rodada > 1 ? `comunicado:${comunicadoId}:${anuncianteId}:${rodada}` : `comunicado:${comunicadoId}:${anuncianteId}`;

// O estado REAL de cada destinatário, lendo as duas pontas: o registro do
// comunicado e a linha da fila da rodada atual. Se um gancho da fila falhou
// (o e-mail saiu mas o registro não foi atualizado), vale o que a fila diz;
// linha que sumiu da fila sem terminar conta como falha (pode reenviar).
const SITUACAO_SQL = `CASE
    WHEN d.situacao = 'enviado' OR o.status = 'enviado' THEN 'enviado'
    WHEN d.situacao = 'descartado' OR o.status = 'descartado' THEN 'descartado'
    WHEN d.situacao = 'falhou' OR o.status = 'abandonado' OR o.id IS NULL THEN 'falhou'
    WHEN o.status = 'tentando_de_novo' THEN 'tentando'
    ELSE 'na_fila'
  END`;

// Resumo de um comunicado pra tela. Nunca devolve endereço.
function situacaoGeral(c) {
  if (c.na_fila + c.tentando > 0) return 'em_andamento';
  if (c.falharam === 0) return 'concluido';
  if (c.enviados > 0) return 'concluido_com_falhas';
  return 'falhou';
}

function resumo(c) {
  const r = {
    id: Number(c.id),
    publico: c.publico,
    publicoRotulo: publicos.PUBLICOS[c.publico]?.rotulo || c.publico,
    assunto: c.assunto,
    previstos: c.previstos,
    enviados: c.enviados,
    falharam: c.falharam,
    descartados: c.descartados,
    naFila: c.na_fila,
    tentandoDeNovo: c.tentando,
    criadoPor: c.criado_por,
    criadoEm: c.criado_em,
    reenvios: c.reenvios || 0,
    ultimoReenvioEm: c.ultimo_reenvio_em || null,
  };
  r.situacao = situacaoGeral(c);
  return r;
}

const COLUNAS_RESUMO = `c.id, c.publico, c.assunto, c.previstos, c.criado_por, c.criado_em,
       COALESCE(e.enviados, 0) AS enviados, COALESCE(e.falharam, 0) AS falharam,
       COALESCE(e.descartados, 0) AS descartados, COALESCE(e.na_fila, 0) AS na_fila,
       COALESCE(e.tentando, 0) AS tentando, r.reenvios, r.ultimo_reenvio_em`;
const JUNCOES_RESUMO = `
  LEFT JOIN LATERAL (
    SELECT COUNT(*) FILTER (WHERE s = 'enviado')::int AS enviados,
           COUNT(*) FILTER (WHERE s = 'falhou')::int AS falharam,
           COUNT(*) FILTER (WHERE s = 'descartado')::int AS descartados,
           COUNT(*) FILTER (WHERE s = 'na_fila')::int AS na_fila,
           COUNT(*) FILTER (WHERE s = 'tentando')::int AS tentando
      FROM (SELECT ${SITUACAO_SQL} AS s
              FROM comunicados_destinatarios d
              LEFT JOIN email_outbox o ON o.id = d.email_outbox_id
             WHERE d.comunicado_id = c.id) x
  ) e ON true
  LEFT JOIN LATERAL (
    SELECT COUNT(*)::int AS reenvios, MAX(criado_em) AS ultimo_reenvio_em
      FROM comunicados_reenvios WHERE comunicado_id = c.id
  ) r ON true`;

async function buscarResumo(id, db = pool) {
  const { rows } = await db.query(`SELECT ${COLUNAS_RESUMO} FROM comunicados c ${JUNCOES_RESUMO} WHERE c.id = $1`, [
    id,
  ]);
  return rows[0] ? resumo(rows[0]) : null;
}

// Grava na fila, em ordem, cada destinatário com a vez dele (ritmo), e o
// registro do destinatário apontando pra linha da fila.
async function enfileirarDestinatarios(db, comunicadoId, destinatarios, rodada = 1) {
  let i = 0;
  for (const d of destinatarios) {
    const fila = await outbox.enfileirar(
      {
        tipo: 'comunicado',
        chave: chaveDaFila(comunicadoId, d.anuncianteId, rodada),
        para: d.email,
        anuncianteId: d.anuncianteId,
        dados: { comunicadoId: Number(comunicadoId) },
        atrasoS: i * config.intervaloS,
      },
      db,
    );
    // Chave já na fila = este destinatário já entrou nesta rodada: não
    // mexe em nada (nunca acontece com a trava; é a terceira camada).
    if (!fila.novo) continue;
    await db.query(
      `INSERT INTO comunicados_destinatarios (comunicado_id, anunciante_id, email_outbox_id, rodada)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (comunicado_id, anunciante_id) DO UPDATE
         SET email_outbox_id = EXCLUDED.email_outbox_id, rodada = EXCLUDED.rodada,
             situacao = 'na_fila', ultimo_erro = NULL, atualizado_em = now()`,
      [comunicadoId, d.anuncianteId, fila.id, rodada],
    );
    i++;
  }
  return i;
}

// Cria e dispara. `confirmados` é o número que o admin viu na confirmação:
// se o público mudou entre a tela e o clique, nada sai e a tela mostra o
// número novo pra confirmar de novo.
async function criar({ chave, publico, conteudo: c, confirmados, adminUsuario }) {
  const impressao = conteudo.impressaoDe(publico, c);
  const cliente = await pool.connect();
  let criado;
  try {
    await cliente.query('BEGIN');
    await cliente.query('SELECT pg_advisory_xact_lock($1)', [TRAVA_CRIACAO]);

    const { rows: mesmaChave } = await cliente.query(
      'SELECT id, impressao FROM comunicados WHERE chave_idempotencia = $1',
      [chave],
    );
    if (mesmaChave[0]) {
      if (mesmaChave[0].impressao !== impressao) {
        throw erro(409, 'essa confirmação já foi usada para outro comunicado — revise e confirme de novo');
      }
      await cliente.query('ROLLBACK');
      return { comunicado: await buscarResumo(mesmaChave[0].id), repetido: true };
    }

    const { rows: igual } = await cliente.query(
      `SELECT id, criado_em FROM comunicados
        WHERE impressao = $1 AND criado_em > now() - make_interval(hours => $2)
        ORDER BY criado_em DESC LIMIT 1`,
      [impressao, JANELA_REPETICAO_H],
    );
    if (igual[0]) {
      throw erro(
        409,
        'este mesmo comunicado já foi enviado para este público nas últimas 24 horas — confira o histórico. Para quem falhou, use "Reenviar falhas" lá.',
        { motivo: 'repetido', comunicadoId: Number(igual[0].id) },
      );
    }

    // A MESMA consulta da contagem que o admin viu (src/comunicados/publicos.js).
    const destinatarios = await publicos.listarDestinatarios(publico, cliente);
    if (!destinatarios.length) {
      throw erro(400, 'nenhuma conta deste público recebe comunicados agora — nada foi enviado', {
        motivo: 'sem_destinatarios',
        destinatarios: 0,
      });
    }
    if (destinatarios.length !== confirmados) {
      throw erro(
        409,
        `o público mudou desde a confirmação: agora são ${destinatarios.length} ${destinatarios.length === 1 ? 'conta' : 'contas'} — confira e confirme de novo`,
        { motivo: 'publico_mudou', destinatarios: destinatarios.length },
      );
    }

    const { rows } = await cliente.query(
      `INSERT INTO comunicados (chave_idempotencia, impressao, publico, assunto, titulo, mensagem,
                                botao_texto, botao_url, previstos, criado_por)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        chave,
        impressao,
        publico,
        c.assunto,
        c.titulo,
        c.mensagem,
        c.botao?.texto || null,
        c.botao?.url || null,
        destinatarios.length,
        adminUsuario,
      ],
    );
    criado = rows[0].id;
    await enfileirarDestinatarios(cliente, criado, destinatarios);
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
  // Depois do COMMIT: a fila só enxerga as linhas agora.
  outbox.despachar();
  return { comunicado: await buscarResumo(criado), repetido: false };
}

// Histórico (mais recente primeiro): contagens por situação, nunca endereço.
async function historico({ limite = 30 } = {}) {
  const { rows } = await pool.query(
    `SELECT ${COLUNAS_RESUMO} FROM comunicados c ${JUNCOES_RESUMO}
      ORDER BY c.criado_em DESC, c.id DESC LIMIT $1`,
    [limite],
  );
  return rows.map(resumo);
}

// Detalhe: o texto enviado e quem não recebeu (nome da empresa + endereço
// MASCARADO + motivo sem endereço), pra diagnóstico. Quem recebeu não é
// listado — só contado.
async function detalhe(id) {
  const base = await buscarResumo(id);
  if (!base) return null;
  const { rows: texto } = await pool.query(
    'SELECT titulo, mensagem, botao_texto, botao_url FROM comunicados WHERE id = $1',
    [id],
  );
  const { rows: problemas } = await pool.query(
    `SELECT a.nome_empresa, COALESCE(o.destinatario, a.contato_email) AS endereco, s.situacao,
            COALESCE(o.ultimo_erro, d.ultimo_erro) AS erro, d.rodada, d.atualizado_em
       FROM comunicados_destinatarios d
       JOIN anunciantes a ON a.id = d.anunciante_id
       LEFT JOIN email_outbox o ON o.id = d.email_outbox_id
       CROSS JOIN LATERAL (SELECT ${SITUACAO_SQL} AS situacao) s
      WHERE d.comunicado_id = $1 AND s.situacao IN ('falhou', 'descartado', 'tentando')
      ORDER BY s.situacao, a.nome_empresa`,
    [id],
  );
  return {
    ...base,
    titulo: texto[0].titulo,
    mensagem: texto[0].mensagem,
    botao: texto[0].botao_texto ? { texto: texto[0].botao_texto, url: texto[0].botao_url } : null,
    paraReenviar: (await falhasReenviaveis(id)).length,
    problemas: problemas.map((p) => ({
      nomeEmpresa: p.nome_empresa,
      email: outbox.mascararEmail(p.endereco),
      situacao: p.situacao,
      erro: p.erro ? outbox.sanitizar(p.erro) : null,
      rodada: p.rodada,
      atualizadoEm: p.atualizado_em,
    })),
  };
}

// Quem "Reenviar falhas" pega agora: falhou (pela situação real, fila +
// registro) E a conta ainda recebe comunicado pela régua de sempre — quem
// foi excluída, suspensa ou desmarcou "receber novidades" depois da falha
// fica de fora. Vai pro endereço de login ATUAL da conta.
async function falhasReenviaveis(id, db = pool) {
  const { rows } = await db.query(
    `SELECT d.anunciante_id, d.rodada, trim(a.contato_email) AS email
       FROM comunicados_destinatarios d
       JOIN anunciantes a ON a.id = d.anunciante_id
       LEFT JOIN email_outbox o ON o.id = d.email_outbox_id
      WHERE d.comunicado_id = $1 AND (${SITUACAO_SQL}) = 'falhou' AND ${publicos.CONTA_RECEBE_SQL}
      ORDER BY d.anunciante_id`,
    [id],
  );
  return publicos.semRepetidos(
    rows.map((r) => ({ anuncianteId: r.anunciante_id, email: r.email, rodada: r.rodada + 1 })),
  );
}

// "Reenviar falhas": volta pra fila SÓ quem falhou — nunca quem recebeu,
// nunca quem saiu do público. Cada um ganha uma rodada nova (chave nova na
// fila) e vai pro endereço de login ATUAL da conta, se ela ainda recebe.
// Linha travada (FOR UPDATE) no comunicado: dois cliques em "Reenviar"
// passam um de cada vez, e o segundo não acha mais falha nenhuma.
async function reenviarFalhas(id, { adminUsuario, confirmados }) {
  const cliente = await pool.connect();
  let quantidade = 0;
  try {
    await cliente.query('BEGIN');
    const { rows: existe } = await cliente.query('SELECT id FROM comunicados WHERE id = $1 FOR UPDATE', [id]);
    if (!existe[0]) throw erro(404, 'comunicado não encontrado');
    const destinatarios = await falhasReenviaveis(id, cliente);
    if (confirmados !== undefined && confirmados !== destinatarios.length) {
      throw erro(
        409,
        `as falhas mudaram desde a confirmação: agora são ${destinatarios.length} para reenviar — confira e confirme de novo`,
        { motivo: 'falhas_mudaram', paraReenviar: destinatarios.length },
      );
    }
    if (!destinatarios.length) {
      await cliente.query('COMMIT');
      return { reenfileirados: 0, comunicado: await buscarResumo(id) };
    }
    // Cada um na rodada dele (a chave da fila muda por rodada).
    let i = 0;
    for (const d of destinatarios) {
      const fila = await outbox.enfileirar(
        {
          tipo: 'comunicado',
          chave: chaveDaFila(id, d.anuncianteId, d.rodada),
          para: d.email,
          anuncianteId: d.anuncianteId,
          dados: { comunicadoId: Number(id) },
          atrasoS: i * config.intervaloS,
        },
        cliente,
      );
      if (!fila.novo) continue;
      await cliente.query(
        `UPDATE comunicados_destinatarios
            SET email_outbox_id = $3, rodada = $4, situacao = 'na_fila', ultimo_erro = NULL, atualizado_em = now()
          WHERE comunicado_id = $1 AND anunciante_id = $2`,
        [id, d.anuncianteId, fila.id, d.rodada],
      );
      quantidade++;
      i++;
    }
    if (quantidade) {
      await cliente.query(
        'INSERT INTO comunicados_reenvios (comunicado_id, quantidade, criado_por) VALUES ($1, $2, $3)',
        [id, quantidade, adminUsuario],
      );
    }
    await cliente.query('COMMIT');
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
  if (quantidade) outbox.despachar();
  return { reenfileirados: quantidade, comunicado: await buscarResumo(id) };
}

module.exports = {
  TRAVA_CRIACAO,
  JANELA_REPETICAO_H,
  config,
  chaveDaFila,
  criar,
  historico,
  detalhe,
  buscarResumo,
  falhasReenviaveis,
  reenviarFalhas,
};
