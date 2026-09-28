const pool = require('../db/pool');
const { SQL_PONTOS_ELEGIVEIS } = require('../creditos/ponto');
const { horasDeTelaPorMes, segundosDeObrigacao, duracaoValida } = require('../lib/pacing');

// PLANO BÁSICO DO PONTO (migration 103, ADR-025, 28/09/2026). Benefício de
// quem hospeda um ponto Mostraí — não é plano comercial, não se compra, não
// consome crédito. Soma-se ao plano comercial da conta, com a origem
// preservada (uma linha por ponto em `beneficios_basico_ponto`).
//
// TEMPO É A FONTE DE VERDADE: 14 h/mês. Na régua da vitrine (12 h abertas
// por dia × 30 dias — src/lib/pacing.js#horasDeTelaPorMes) isso é 140 s por
// hora aberta, no próprio ponto. Com peça de 15 s: 50.400 s ÷ 15 = 3.360
// exibições equivalentes por mês. Como 140 não divide por 15, a hora não
// arredonda pra baixo (seriam 9 × 15 = 135 s, 13,5 h/mês): as inserções se
// distribuem hora a hora (`insercoesDoBasicoNaHora`, 9, 9, 10, …), e a média
// fica exatamente nos 140 s.
const BASICO = Object.freeze({
  nome: 'Básico',
  horasPorMes: 14,
  segundosPorHora: 140,
  pontos: 1,
  duracaoMaximaSegundos: 15,
  limiteCriativos: 1,
});

// ATIVAÇÃO: a mesma régua do +1 crédito/mês (`SQL_PONTOS_ELEGIVEIS` — ponto
// não arquivado, conta dona válida e não interna, pelo menos uma tela
// provisionada e ativa). Não há um segundo conceito de "ponto ativo": formulário,
// candidatura aprovada ou ponto cadastrado sem tela instalada não dão Básico.
//
// ENCERRAMENTO: só quando o estabelecimento deixa DEFINITIVAMENTE de ser
// ponto daquela conta — ponto arquivado, dono trocado, conta excluída (ou
// virou a conta interna). Tela em reparo ou sem sinal NÃO encerra: o
// benefício continua ativo e simplesmente não gera obrigação enquanto não
// houver tela ativa pra tocar (a obrigação nasce por tela, por hora).
//
// Idempotente: o índice único parcial (um ativo por ponto) garante no banco
// que rodar de novo, em duas instâncias ou em paralelo nunca duplica.
// `apenasPontos`: escopo (a sincronização por ponto depois de mexer numa
// tela, e os testes rodando em paralelo no mesmo banco).
async function sincronizar({ apenasPontos = null, db = pool } = {}) {
  const filtro = apenasPontos ? 'AND b.ponto_id = ANY($1::int[])' : '';
  const params = apenasPontos ? [apenasPontos] : [];
  const { rows: encerrados } = await db.query(
    `WITH alvo AS (
       SELECT b.id,
              CASE WHEN p.status = 'arquivado' THEN 'ponto_arquivado'
                   WHEN p.anunciante_id IS DISTINCT FROM b.conta_id THEN 'dono_mudou'
                   WHEN a.conta_propria THEN 'conta_interna'
                   ELSE 'conta_excluida' END AS motivo
         FROM beneficios_basico_ponto b
         JOIN pontos p ON p.id = b.ponto_id
         JOIN anunciantes a ON a.id = b.conta_id
        WHERE b.fim IS NULL ${filtro}
          AND (p.status = 'arquivado' OR p.anunciante_id IS DISTINCT FROM b.conta_id
               OR a.excluido_em IS NOT NULL OR a.conta_propria)
     )
     UPDATE beneficios_basico_ponto t SET fim = now(), motivo_fim = alvo.motivo
       FROM alvo WHERE t.id = alvo.id
     RETURNING t.id, t.ponto_id, t.conta_id, t.motivo_fim`,
    params,
  );
  const escopo = apenasPontos ? 'WHERE e.id = ANY($1::int[])' : '';
  const { rows: ativados } = await db.query(
    `INSERT INTO beneficios_basico_ponto (ponto_id, conta_id, segundos_por_hora, horas_por_mes,
                                          duracao_maxima_segundos, limite_criativos)
     SELECT e.id, e.anunciante_id, ${BASICO.segundosPorHora}, ${BASICO.horasPorMes},
            ${BASICO.duracaoMaximaSegundos}, ${BASICO.limiteCriativos}
       FROM (${SQL_PONTOS_ELEGIVEIS}) e ${escopo}
     ON CONFLICT (ponto_id) WHERE fim IS NULL DO NOTHING
     RETURNING id, ponto_id, conta_id`,
    params,
  );
  return { ativados, encerrados };
}

// O Básico que vale AGORA — confere de novo, na leitura, o que o encerramento
// confere: entre uma sincronização e outra (ponto arquivado, dono trocado),
// ele não pode continuar veiculando nem aparecendo como ativo.
const SQL_ATIVOS = `
  SELECT b.id, b.ponto_id, b.conta_id, b.segundos_por_hora, b.horas_por_mes,
         b.duracao_maxima_segundos, b.limite_criativos, b.inicio,
         p.nome AS ponto_nome, p.status AS ponto_status
    FROM beneficios_basico_ponto b
    JOIN pontos p ON p.id = b.ponto_id AND p.status <> 'arquivado' AND p.anunciante_id = b.conta_id
    JOIN anunciantes a ON a.id = b.conta_id AND a.excluido_em IS NULL AND NOT a.conta_propria
   WHERE b.fim IS NULL`;

async function ativosDaConta(contaId, db = pool) {
  const { rows } = await db.query(`${SQL_ATIVOS} AND b.conta_id = $1 ORDER BY b.inicio, b.id`, [contaId]);
  return rows;
}

async function ativoNoPonto(pontoId, db = pool) {
  const { rows } = await db.query(`${SQL_ATIVOS} AND b.ponto_id = $1`, [pontoId]);
  return rows[0] || null;
}

// O que o gerador precisa: o Básico ativo do ponto, só se a conta pode
// veicular agora (conta suspensa não toca nada — nem o comercial, nem o
// Básico), com as peças aprovadas dela no limite do Básico.
// `hora`: a hora sendo gerada — o Básico só entra se já tinha começado
// antes do fim dela (backfill e testes geram horas passadas).
async function paraVeicularNoPonto(pontoId, hora = new Date(), db = pool) {
  const fimDaHora = new Date(Math.floor(new Date(hora).getTime() / 3_600_000) * 3_600_000 + 3_600_000);
  const { rows } = await db.query(`${SQL_ATIVOS} AND b.ponto_id = $1 AND NOT a.suspenso AND b.inicio < $2`, [
    pontoId,
    fimDaHora,
  ]);
  const b = rows[0];
  if (!b) return null;
  const { rows: criativos } = await db.query(
    `SELECT id AS "criativoId", arquivo_normalizado_url AS url, duracao_segundos AS "duracaoSegundos",
            conteudo_sha256 AS "contentHash"
       FROM criativos WHERE anunciante_id = $1 AND status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL
      ORDER BY created_at DESC LIMIT $2`,
    [b.conta_id, b.limite_criativos],
  );
  return criativos.length ? { ...b, criativos } : null;
}

// Obrigação da parcela Básico numa tela numa hora, em segundos: as inserções
// da hora (`insercoesDoBasicoNaHora`) × a peça, × minutos abertos ÷ 60, ÷
// telas ativas do ponto — a mesma forma da obrigação comercial
// (pacing.segundosDeObrigacao), pelo caminho "frequência × duração".
function segundosDoBasicoNaHora(beneficio, duracaoSegundos, hora, minutosAbertos = 60, telasDoPonto = 1) {
  return segundosDeObrigacao({
    segundosPorHora: 0,
    frequenciaHora: insercoesDoBasicoNaHora(beneficio.segundos_por_hora, duracaoSegundos, hora),
    duracaoSegundos,
    telasDoPonto,
    minutosAbertos,
  });
}

// Todos os benefícios da conta (ativos e encerrados), pra ficha do admin.
async function historicoDaConta(contaId, db = pool) {
  const { rows } = await db.query(
    `SELECT b.*, p.nome AS ponto_nome FROM beneficios_basico_ponto b
       LEFT JOIN pontos p ON p.id = b.ponto_id
      WHERE b.conta_id = $1 ORDER BY b.fim IS NOT NULL, b.inicio DESC`,
    [contaId],
  );
  return rows;
}

// O Básico que valia NUMA HORA passada (rede de segurança do Saldo,
// src/bancohoras/obrigacao.js): a linha guarda início e fim, então a hora
// sem sinal é conferida contra o estado daquela hora, não o de hoje. Hora
// inteira só depois do início (a hora em que ele nasceu é da geração ao vivo,
// que já cobra só o resto da hora de quem chega no meio).
function valiaNaHora(beneficio, hora) {
  const t = new Date(hora).getTime();
  if (new Date(beneficio.inicio).getTime() > t) return false;
  return !beneficio.fim || new Date(beneficio.fim).getTime() > t;
}

// Os benefícios (ativos ou encerrados depois de `desde`) de um ponto — pra
// rede de segurança olhar horas passadas.
async function doPontoDesde(pontoId, desde, db = pool) {
  const { rows } = await db.query(
    `SELECT b.* FROM beneficios_basico_ponto b
       JOIN pontos p ON p.id = b.ponto_id
       JOIN anunciantes a ON a.id = b.conta_id AND NOT a.conta_propria
      WHERE b.ponto_id = $1 AND (b.fim IS NULL OR b.fim > $2)
        -- Ativo sem o job ter encerrado ainda: só vale se continua coerente.
        AND (b.fim IS NOT NULL
             OR (p.anunciante_id = b.conta_id AND p.status <> 'arquivado' AND a.excluido_em IS NULL))`,
    [pontoId, desde],
  );
  return rows;
}

// Inserções da parcela Básico numa hora: 140 s por hora aberta NÃO divide
// pela peça (15 s → 9,33). Em vez de arredondar sempre pra baixo (e entregar
// 13,5 h de 14), cada hora recebe a sua fatia de uma sequência estável —
// floor((k+1)·s/d) − floor(k·s/d), com k = índice absoluto da hora —, cuja
// média é exatamente s/d. Determinística: a mesma hora dá sempre o mesmo
// número (a hora congela, e a rede de segurança recalcula igual).
function insercoesDoBasicoNaHora(segundosPorHora, duracaoSegundos, hora) {
  const s = Math.max(0, Number(segundosPorHora) || 0);
  const d = duracaoValida(duracaoSegundos);
  const k = Math.floor(new Date(hora).getTime() / 3_600_000);
  return Math.floor(((k + 1) * s) / d) - Math.floor((k * s) / d);
}

// Direitos somados, com a origem de cada parte (req. 4/5 da estação): pontos
// e horas somam; peça e quantidade de criativos no ar valem o MAIOR dos dois
// (é o mesmo conjunto de peças da conta que roda nas duas origens — somar
// criativos daria peças que nenhuma das duas origens vende sozinha).
function direitosCombinados(plano, basicos = []) {
  const horasPlano = plano ? horasDeTelaPorMes(plano.segundos_por_hora, plano.pontos_incluidos) : 0;
  const horasBasico = basicos.reduce((t, b) => t + Number(b.horas_por_mes || 0), 0);
  const pontosPlano = plano ? Number(plano.pontos_incluidos) || 0 : 0;
  return {
    pontos: pontosPlano + basicos.length,
    pontosPlano,
    pontosBasico: basicos.length,
    horasPorMes: horasPlano + horasBasico,
    horasPlano,
    horasBasico,
    duracaoMaxima:
      Math.max(
        plano ? Number(plano.duracao_maxima_segundos) || 0 : 0,
        ...basicos.map((b) => Number(b.duracao_maxima_segundos) || 0),
      ) || null,
    limiteCriativos: Math.max(
      plano ? Number(plano.limite_criativos) || 0 : 0,
      ...basicos.map((b) => Number(b.limite_criativos) || 0),
    ),
  };
}

// Forma única do Básico pra painel e admin.
function resumo(b) {
  return {
    id: b.id,
    pontoId: b.ponto_id,
    pontoNome: b.ponto_nome,
    horasPorMes: b.horas_por_mes,
    segundosPorHora: b.segundos_por_hora,
    duracaoMaximaSegundos: b.duracao_maxima_segundos,
    limiteCriativos: b.limite_criativos,
    pontos: BASICO.pontos,
    inicio: b.inicio,
    fim: b.fim || null,
    motivoFim: b.motivo_fim || null,
    ativo: !b.fim,
  };
}

module.exports = {
  BASICO,
  sincronizar,
  ativosDaConta,
  ativoNoPonto,
  paraVeicularNoPonto,
  segundosDoBasicoNaHora,
  historicoDaConta,
  doPontoDesde,
  valiaNaHora,
  insercoesDoBasicoNaHora,
  direitosCombinados,
  resumo,
};
