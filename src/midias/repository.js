const pool = require('../db/pool');
const { SEGUNDOS_DA_HORA, quebraCapacidade } = require('../lib/capacidade');
const { instanteComercial } = require('../lib/fuso-comercial');

// Mídia Mostraí (reorganização de Conteúdo, 22/09/2026, pedido do dono):
// cada peça institucional é uma linha aqui, 1-pra-1 com um `criativo`
// (arquivo/preview/status de aprovação continuam morando lá — ver Parte 27
// do pedido: substituir arquivo edita o MESMO criativo, nunca cria outro).

// "Agendada" e "Encerrada por período" são derivadas na leitura — não
// existe estado próprio pra isso no banco (Parte 14: "não criar máquina de
// estados excessivamente complexa"). `situacao` guarda só o controle manual
// (ativa/pausada/encerrada); esta função decide o rótulo final combinando
// os dois.
// 'excluida' (migration 107, 29/09/2026): exclusão lógica — vence qualquer
// outro estado; nunca toca, e as exibições confirmadas ficam como comprovante.
function situacaoDerivada(m, agora = new Date()) {
  if (m.situacao === 'excluida') return 'excluida';
  if (m.situacao === 'encerrada') return 'encerrada';
  if (m.situacao === 'pausada') return 'pausada';
  if (m.periodo_inicio && new Date(m.periodo_inicio) > agora) return 'agendada';
  if (m.periodo_fim && new Date(m.periodo_fim) < agora) return 'encerrada';
  return 'ativa';
}

const CAMPOS_MIDIA = `
  mp.id, mp.criativo_id, mp.nome_interno, mp.frequencia_hora, mp.cobertura_tipo,
  mp.periodo_inicio, mp.periodo_fim, mp.situacao, mp.created_at,
  c.arquivo_original_url, c.arquivo_normalizado_url, c.thumbnail_url, c.status AS aprovacao_status,
  c.motivo_reprovacao, c.duracao_segundos, c.anunciante_id
`;

function montarLinha(row) {
  return { ...row, situacaoDerivada: situacaoDerivada(row) };
}

// Excluída não aparece em lista de trabalho nenhuma; a linha fica só pelo
// comprovante (buscarPorId ainda a encontra, pras guardas das rotas).
async function listar() {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_MIDIA},
       (SELECT COUNT(*)::int FROM midias_proprias_pontos mpp WHERE mpp.midia_id = mp.id) AS qtd_pontos
     FROM midias_proprias mp
     JOIN criativos c ON c.id = mp.criativo_id
     WHERE mp.situacao <> 'excluida'
     ORDER BY mp.created_at DESC`,
  );
  return rows.map(montarLinha);
}

async function buscarPorId(id) {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS_MIDIA} FROM midias_proprias mp JOIN criativos c ON c.id = mp.criativo_id WHERE mp.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const { rows: pontos } = await pool.query(`SELECT ponto_id FROM midias_proprias_pontos WHERE midia_id = $1`, [id]);
  return { ...montarLinha(rows[0]), pontosIds: pontos.map((p) => p.ponto_id) };
}

async function definirCobertura(midiaId, coberturaTipo, pontosIds, db = pool) {
  await db.query('DELETE FROM midias_proprias_pontos WHERE midia_id = $1', [midiaId]);
  if (coberturaTipo === 'pontos' && pontosIds?.length) {
    const valores = pontosIds.map((_, i) => `($1, $${i + 2})`).join(',');
    await db.query(`INSERT INTO midias_proprias_pontos (midia_id, ponto_id) VALUES ${valores}`, [
      midiaId,
      ...pontosIds,
    ]);
  }
}

async function criar({ criativoId, nomeInterno, frequenciaHora, coberturaTipo, pontosIds, periodoInicio, periodoFim }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO midias_proprias
         (criativo_id, nome_interno, frequencia_hora, cobertura_tipo, periodo_inicio, periodo_fim)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [
        criativoId,
        nomeInterno,
        frequenciaHora,
        coberturaTipo,
        // Período digitado no admin é horário de Matão (D3, 24/09/2026 —
        // src/lib/fuso-comercial.js), convertido aqui, não no navegador.
        instanteComercial(periodoInicio, { campo: 'início do período' }) ?? null,
        instanteComercial(periodoFim, { campo: 'fim do período', fim: true }) ?? null,
      ],
    );
    const midiaId = rows[0].id;
    await definirCobertura(midiaId, coberturaTipo, pontosIds, client);
    await client.query('COMMIT');
    return buscarPorId(midiaId);
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

const CAMPOS_ATUALIZAVEIS = ['nome_interno', 'frequencia_hora', 'periodo_inicio', 'periodo_fim'];

async function atualizar(id, entrada) {
  const dados = { ...entrada };
  if ('periodo_inicio' in dados) {
    dados.periodo_inicio = instanteComercial(dados.periodo_inicio, { campo: 'início do período' });
  }
  if ('periodo_fim' in dados) {
    dados.periodo_fim = instanteComercial(dados.periodo_fim, { campo: 'fim do período', fim: true });
  }
  const campos = Object.keys(dados).filter((c) => CAMPOS_ATUALIZAVEIS.includes(c));
  if (campos.length) {
    const sets = campos.map((c, i) => `${c} = $${i + 2}`).join(', ');
    const valores = campos.map((c) => dados[c] ?? null);
    await pool.query(`UPDATE midias_proprias SET ${sets} WHERE id = $1`, [id, ...valores]);
  }
  if (dados.coberturaTipo) {
    await pool.query('UPDATE midias_proprias SET cobertura_tipo = $2 WHERE id = $1', [id, dados.coberturaTipo]);
    await definirCobertura(id, dados.coberturaTipo, dados.pontosIds);
  }
  return buscarPorId(id);
}

// Mídia excluída não muda mais de estado — a guarda mora no UPDATE, não só
// nas rotas. Devolve false quando nada mudou (inexistente ou excluída).
async function definirSituacao(id, situacao, db = pool) {
  const { rows } = await db.query(
    `UPDATE midias_proprias SET situacao = $2 WHERE id = $1 AND situacao <> 'excluida' RETURNING id`,
    [id, situacao],
  );
  return rows.length > 0;
}

// Exclusão lógica (migration 107). Só de mídia fora do ar — pausada ou
// encerrada, pela situação DERIVADA (período vencido conta como encerrada):
// ativa e agendada passam antes por Pausar ou Retirar do ar. Num commit só, a
// mídia vira 'excluida' e o arquivo ainda em análise sai da fila como
// reprovado — senão ficaria na Aprovação, com Aprovar, apontando pra uma
// mídia que não existe mais. Mesmo desenho do PR #91 (pausado).
const PODE_EXCLUIR = ['pausada', 'encerrada'];
const MOTIVO_EXCLUSAO = 'Mídia excluída pelo operador — o arquivo saiu da fila junto com ela.';

// `{ ok: true, midia, criativoReprovado }` ou `{ ok: false, status, erro }`.
async function excluir(id) {
  const midia = await buscarPorId(id);
  if (!midia || midia.situacao === 'excluida') return { ok: false, status: 404, erro: 'mídia não encontrada' };
  if (!PODE_EXCLUIR.includes(midia.situacaoDerivada)) {
    return { ok: false, status: 409, erro: 'pause ou retire a mídia do ar antes de excluir' };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // A situação é conferida de novo no UPDATE: entre a leitura e aqui, outra
    // aba pode ter retomado a mídia.
    const { rowCount } = await client.query(
      `UPDATE midias_proprias SET situacao = 'excluida'
        WHERE id = $1
          AND (situacao IN ('pausada', 'encerrada')
               OR (situacao = 'ativa' AND periodo_fim < now()
                   AND (periodo_inicio IS NULL OR periodo_inicio <= now())))`,
      [id],
    );
    if (!rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, status: 409, erro: 'pause ou retire a mídia do ar antes de excluir' };
    }
    const reprovado = await client.query(
      `UPDATE criativos SET status = 'reprovado', motivo_reprovacao = $2 WHERE id = $1 AND status = 'pendente'`,
      [midia.criativo_id, MOTIVO_EXCLUSAO],
    );
    await client.query('COMMIT');
    return { ok: true, midia, criativoReprovado: reprovado.rowCount > 0 };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

// Grava no criativo só se a mídia própria dona dele não estiver excluída,
// com a linha da mídia travada (FOR UPDATE). `excluir` trava a mesma linha no
// UPDATE, então as duas se esperam: sem isso, uma troca de arquivo que
// começou antes da exclusão terminava depois e devolvia o arquivo à fila
// como 'pendente', com Aprovar/Reprovar respondendo 409 (revisão Codex do
// #104). Criativo que não é de mídia própria grava normalmente. Devolve o que
// `gravar(client)` devolveu, ou null quando a mídia está excluída.
async function gravarSeMidiaNaoExcluida(criativoId, gravar) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT situacao FROM midias_proprias WHERE criativo_id = $1 FOR UPDATE', [
      criativoId,
    ]);
    if (rows[0]?.situacao === 'excluida') {
      await client.query('ROLLBACK');
      return null;
    }
    const resultado = await gravar(client);
    await client.query('COMMIT');
    return resultado;
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

// Situação da mídia própria dona deste criativo (1-pra-1), ou null quando o
// criativo não é de mídia própria.
async function situacaoPorCriativo(criativoId) {
  const { rows } = await pool.query('SELECT situacao FROM midias_proprias WHERE criativo_id = $1', [criativoId]);
  return rows[0]?.situacao ?? null;
}

// ---------- Ocupação (Parte 10/11/16) ----------
//
// Reaproveita a MESMA régua de `src/pontos/repository.js#ocupacaoPorAnunciante`
// (segundos_por_hora vendido, sobre 3600 por hora) — não inventa uma segunda
// fórmula. A parte institucional soma por cima com a mesma unidade
// (frequência × duração = segundos/hora), nunca mexe no bloqueio comercial
// de 80% (`avaliarBloqueios`), que continua intocado — Parte 10: "não altere
// essa política".
// `pontosIds`: null = todos os pontos do escopo (pra tabela de capacidade
// da rede, Parte 16); array = só esses (pra preview de cobertura
// específica, Parte 11). `excluirMidiaId`: ao editar uma mídia existente,
// não conta a contribuição dela mesma como "já ocupado" — senão editar sem
// mudar nada mostraria a mídia disputando espaço com ela própria.
// `status`: só 'em_operacao' por padrão (Mídia Mostraí e o preview de
// publicação); `null` = todos os pontos, pra tabela de ocupação da Visão
// geral, que também lista ponto aguardando instalação com anunciante já
// escolhido (rodada de integridade, 23/09/2026 — mesma régua nas duas telas).
async function ocupacaoPorPonto(pontosIds, excluirMidiaId, status = ['em_operacao']) {
  // `$1::int[] IS NULL OR ...` em vez de montar o filtro condicionalmente
  // na string: sem isso, quando `pontosIds` é null o placeholder $1 some do
  // texto da query mas continua sendo passado como parâmetro, e o Postgres
  // recusa com "could not determine data type of parameter $1" (não tem
  // onde inferir o tipo de um parâmetro que não aparece na query).
  const params = [pontosIds || null, excluirMidiaId || 0, status];
  const { rows } = await pool.query(
    `WITH comercial AS (
       -- FILTER (WHERE p.status = 'em_operacao'): o anunciante pode escolher
       -- um ponto ainda 'a_instalar' pra reservar a vaga (RN-49) — a linha em
       -- anunciantes_pontos existe antes de qualquer tela física existir. Sem
       -- este filtro, esse ponto contava segundos_por_hora do plano do
       -- anunciante como ocupação comercial REAL, mesmo sem nenhuma tela pra
       -- exibir nada (achado na revisão da Visão geral, 23/09/2026). O filtro
       -- fica dentro do SUM (não no WHERE de fora) pra o ponto continuar
       -- aparecendo na lista com 0% comercial — é alocação planejada, não
       -- ocupação operacional — em vez de sumir da tabela.
       SELECT p.id AS ponto_id,
              COALESCE(SUM(pl.segundos_por_hora) FILTER (WHERE p.status = 'em_operacao'), 0)::int AS segundos_comercial
         FROM pontos p
         LEFT JOIN anunciantes_pontos ap ON ap.ponto_id = p.id
         LEFT JOIN anunciantes a ON a.id = ap.anunciante_id AND NOT a.suspenso AND a.excluido_em IS NULL
         LEFT JOIN planos pl ON pl.id = a.plano_id
        WHERE p.status <> 'arquivado' AND ($3::text[] IS NULL OR p.status = ANY($3::text[])) AND ($1::int[] IS NULL OR p.id = ANY($1::int[]))
        GROUP BY p.id
     ),
     institucional_rede AS (
       SELECT COALESCE(SUM(mp.frequencia_hora * COALESCE(c.duracao_segundos, 0)), 0)::int AS segundos
         FROM midias_proprias mp
         JOIN criativos c ON c.id = mp.criativo_id
        WHERE mp.cobertura_tipo = 'rede' AND mp.situacao = 'ativa' AND mp.id != $2
          AND (mp.periodo_inicio IS NULL OR mp.periodo_inicio <= now())
          AND (mp.periodo_fim IS NULL OR mp.periodo_fim >= now())
     ),
     institucional_pontos AS (
       SELECT mpp.ponto_id, SUM(mp.frequencia_hora * COALESCE(c.duracao_segundos, 0))::int AS segundos
         FROM midias_proprias mp
         JOIN criativos c ON c.id = mp.criativo_id
         JOIN midias_proprias_pontos mpp ON mpp.midia_id = mp.id
        WHERE mp.cobertura_tipo = 'pontos' AND mp.situacao = 'ativa' AND mp.id != $2
          AND (mp.periodo_inicio IS NULL OR mp.periodo_inicio <= now())
          AND (mp.periodo_fim IS NULL OR mp.periodo_fim >= now())
        GROUP BY mpp.ponto_id
     )
     SELECT p.id AS ponto_id, p.nome AS ponto_nome, p.cidade, p.status,
            COALESCE(cm.segundos_comercial, 0) AS segundos_comercial,
            COALESCE(ir.segundos, 0) + COALESCE(ip.segundos, 0) AS segundos_institucional,
            (SELECT COUNT(*)::int FROM midias_proprias_pontos mpp2
               JOIN midias_proprias mp2 ON mp2.id = mpp2.midia_id
              WHERE mpp2.ponto_id = p.id AND mp2.situacao = 'ativa')
            + (SELECT COUNT(*)::int FROM midias_proprias mp3
                WHERE mp3.cobertura_tipo = 'rede' AND mp3.situacao = 'ativa') AS qtd_midias_proprias
       FROM pontos p
       LEFT JOIN comercial cm ON cm.ponto_id = p.id
       CROSS JOIN institucional_rede ir
       LEFT JOIN institucional_pontos ip ON ip.ponto_id = p.id
      WHERE p.status <> 'arquivado' AND ($3::text[] IS NULL OR p.status = ANY($3::text[])) AND ($1::int[] IS NULL OR p.id = ANY($1::int[]))
      ORDER BY p.nome`,
    params,
  );
  return rows.map((r) => {
    const segundosComercial = Number(r.segundos_comercial);
    const segundosMostrai = Number(r.segundos_institucional);
    const q = quebraCapacidade(segundosComercial, segundosMostrai);
    return {
      pontoId: r.ponto_id,
      pontoNome: r.ponto_nome,
      cidade: r.cidade,
      status: r.status,
      segundosComercial,
      segundosMostrai,
      ...q,
      // Nomes antigos mantidos pra quem ainda lê (mesmos valores de antes).
      // `livrePct` NÃO é mais mostrado em tela nenhuma: somava a reserva
      // Mostraí com o comercial ainda não vendido num saldo só.
      institucionalPct: q.mostraiPct,
      atualPct: q.totalPct,
      livrePct: Math.max(0, Math.round((100 - q.totalPct) * 10) / 10),
      qtdMidiasProprias: r.qtd_midias_proprias,
    };
  });
}

// Preview de "atual" x "depois desta mídia" (Parte 11/12) — mesma leitura
// acima, só soma a contribuição da configuração sendo editada/criada em
// cima do que já existe. `pontosAlvo`: null (cobertura 'rede') calcula em
// TODOS os pontos em operação; array (cobertura 'pontos') calcula só neles.
// A trava continua sendo o TOTAL passar de 100% (`comporta`); passar da
// reserva de 20% só é sinalizado (`acimaDaReserva`), não bloqueado — é
// ocupar capacidade comercial ainda não vendida, não estourar a hora.
async function previewOcupacao({ pontosAlvo, frequenciaHora, duracaoSegundos, excluirMidiaId }) {
  const linhas = await ocupacaoPorPonto(pontosAlvo, excluirMidiaId);
  const contribuicao = Number(frequenciaHora) * Number(duracaoSegundos || 0);
  return linhas.map((l) => {
    const depois = quebraCapacidade(l.segundosComercial, l.segundosMostrai + contribuicao);
    return {
      ...l,
      depoisPct: depois.totalPct,
      mostraiDepoisPct: depois.mostraiPct,
      acimaDaReserva: depois.mostraiAcimaDaReservaPct > 0,
      comporta: !depois.excede,
    };
  });
}

// Quem entra na playlist desta tela agora (src/playlist/gerador.js chama).
// Cada mídia própria vira um item independente — frequência e cobertura já
// são dela, não da conta (Parte 5/7): não precisa de RN-49 nem de banco de
// horas, que existem pra dividir/compensar cobertura entre pontos, e aqui
// cada mídia já diz exatamente quantas vezes por hora, em quais pontos.
async function elegiveisNoPonto(pontoId) {
  const { rows } = await pool.query(
    `SELECT mp.id, mp.frequencia_hora, c.id AS criativo_id, c.arquivo_normalizado_url AS url, c.duracao_segundos,
            c.conteudo_sha256
       FROM midias_proprias mp
       JOIN criativos c ON c.id = mp.criativo_id
      WHERE mp.situacao = 'ativa'
        AND c.status = 'aprovado' AND c.arquivo_normalizado_url IS NOT NULL
        AND (mp.periodo_inicio IS NULL OR mp.periodo_inicio <= now())
        AND (mp.periodo_fim IS NULL OR mp.periodo_fim >= now())
        AND (
          mp.cobertura_tipo = 'rede'
          OR EXISTS (SELECT 1 FROM midias_proprias_pontos mpp WHERE mpp.midia_id = mp.id AND mpp.ponto_id = $1)
        )`,
    [pontoId],
  );
  return rows;
}

// Detalhe por ponto (Parte 17): quais mídias próprias consomem capacidade
// ali, e quanto cada uma — métrica real (frequência × duração), nunca um
// "score" inventado.
async function midiasNoPonto(pontoId) {
  const { rows } = await pool.query(
    `SELECT mp.id, mp.nome_interno, mp.frequencia_hora, c.duracao_segundos
       FROM midias_proprias mp
       JOIN criativos c ON c.id = mp.criativo_id
      WHERE mp.situacao = 'ativa'
        AND (mp.periodo_inicio IS NULL OR mp.periodo_inicio <= now())
        AND (mp.periodo_fim IS NULL OR mp.periodo_fim >= now())
        AND (
          mp.cobertura_tipo = 'rede'
          OR EXISTS (SELECT 1 FROM midias_proprias_pontos mpp WHERE mpp.midia_id = mp.id AND mpp.ponto_id = $1)
        )
      ORDER BY mp.nome_interno`,
    [pontoId],
  );
  return rows.map((r) => ({
    id: r.id,
    nomeInterno: r.nome_interno,
    pct: Math.round(((Number(r.frequencia_hora) * Number(r.duracao_segundos || 0)) / SEGUNDOS_DA_HORA) * 1000) / 10,
  }));
}

module.exports = {
  listar,
  buscarPorId,
  criar,
  atualizar,
  definirSituacao,
  excluir,
  gravarSeMidiaNaoExcluida,
  situacaoPorCriativo,
  ocupacaoPorPonto,
  previewOcupacao,
  elegiveisNoPonto,
  midiasNoPonto,
  situacaoDerivada,
};
