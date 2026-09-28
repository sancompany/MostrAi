const pool = require('../db/pool');
const vigencia = require('../lib/vigencia');
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
//
// O FIM é o instante em que deixou de ser ponto da conta quando o banco
// sabe (`pontos.arquivado_em`, `anunciantes.excluido_em`), não o da
// sincronização que viu: a rede de segurança do Saldo cobra hora a hora pelo
// início/fim da linha, e um fim atrasado cobraria horas que já não eram dela
// (revisão independente, 28/09/2026).
//
// limite: troca de dono não tem data — nenhuma rota muda `pontos.anunciante_id`
// (só operação manual no banco) — e o fim fica o da sincronização que viu. A
// leitura já corta na hora (`SQL_ATIVOS`), mas a rede de segurança pode cobrar
// do dono antigo as horas sem sinal entre a troca e a sincronização. Quem
// trocar o dono à mão sincroniza logo depois (RUNBOOK). Quando a troca virar
// rota, ela chama `sincronizar({ apenasPontos })` na mesma transação.
async function sincronizar({ apenasPontos = null, db = pool } = {}) {
  const filtro = apenasPontos ? 'AND b.ponto_id = ANY($1::int[])' : '';
  const params = apenasPontos ? [apenasPontos] : [];
  const { rows: encerrados } = await db.query(
    `WITH alvo AS (
       SELECT b.id, b.inicio,
              CASE WHEN p.status = 'arquivado' THEN 'ponto_arquivado'
                   WHEN p.anunciante_id IS DISTINCT FROM b.conta_id THEN 'dono_mudou'
                   WHEN a.conta_propria THEN 'conta_interna'
                   ELSE 'conta_excluida' END AS motivo,
              CASE WHEN p.status = 'arquivado' THEN p.arquivado_em
                   WHEN p.anunciante_id IS DISTINCT FROM b.conta_id OR a.conta_propria THEN NULL
                   ELSE a.excluido_em END AS quando
         FROM beneficios_basico_ponto b
         JOIN pontos p ON p.id = b.ponto_id
         JOIN anunciantes a ON a.id = b.conta_id
        WHERE b.fim IS NULL ${filtro}
          AND (p.status = 'arquivado' OR p.anunciante_id IS DISTINCT FROM b.conta_id
               OR a.excluido_em IS NOT NULL OR a.conta_propria)
     )
     UPDATE beneficios_basico_ponto t
        SET fim = GREATEST(alvo.inicio, LEAST(now(), COALESCE(alvo.quando, now()))), motivo_fim = alvo.motivo
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

// Os pontos EM OPERAÇÃO do Básico ativo de cada conta (Map conta → [ponto]).
// O gerador divide o Saldo de Veiculação da conta pelos pontos que puxam o
// saldo na mesma hora — a fatia comercial e os do Básico. Ponto do Básico
// com a tela em reparo, revogada ou inativa continua com o benefício, mas não
// gera playlist nem puxa saldo: fica fora, como fica fora da fatia comercial
// (`pontosEmOperacao`) — senão os outros pontos repunham menos à toa
// (revisão Codex do #93).
async function pontosPorConta(db = pool) {
  const { rows } = await db.query(
    `SELECT x.conta_id, array_agg(x.ponto_id) AS pontos FROM (${SQL_ATIVOS}) x
      WHERE x.ponto_status = 'em_operacao' GROUP BY x.conta_id`,
  );
  return new Map(rows.map((r) => [r.conta_id, r.pontos]));
}

// A peça cabe no teto (`null` = sem teto). Mesma régua de duração do gerador
// (`duracaoValida`: peça sem duração conta como a padrão).
const cabeNoTeto = (duracaoSegundos, teto) => teto == null || duracaoValida(duracaoSegundos) <= teto;

// O teto de peça da conta HOJE — a mesma conta do upload (`direitosCombinados`):
// o maior entre o Básico e o plano comercial dentro da validade; plano sem
// teto próprio, sem teto.
async function tetoDePeca(beneficio, db = pool) {
  const { rows } = await db.query(
    `SELECT p.duracao_maxima_segundos FROM anunciantes a
       JOIN planos p ON p.id = a.plano_id AND ${vigencia.vigenteSql('a.data_expiracao')}
      WHERE a.id = $1`,
    [beneficio.conta_id],
  );
  return direitosCombinados(rows[0] || null, [beneficio]).duracaoMaxima;
}

// As peças da vaga do Básico: as aprovadas mais novas que cabem no teto de
// peça da conta hoje, até o limite de criativos do Básico. Peça mais longa
// (sobra de um plano vencido, ou subida pelo operador) não toca pelo Básico
// nem toma a vez de uma que cabe (revisão Codex do #93). Uma regra só pro
// gerador e pra rede de segurança; o painel usa o mesmo `cabeNoTeto`.
async function pecasDoBasico(beneficio, db = pool) {
  const [teto, { rows }] = await Promise.all([
    tetoDePeca(beneficio, db),
    db.query(
      `SELECT id AS "criativoId", arquivo_normalizado_url AS url, duracao_segundos AS "duracaoSegundos",
              conteudo_sha256 AS "contentHash"
         FROM criativos WHERE anunciante_id = $1 AND status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL
        ORDER BY created_at DESC`,
      [beneficio.conta_id],
    ),
  ]);
  return rows.filter((c) => cabeNoTeto(c.duracaoSegundos, teto)).slice(0, beneficio.limite_criativos);
}

// O que o gerador precisa: o Básico ativo do ponto, só se a conta pode
// veicular agora (conta suspensa não toca nada — nem o comercial, nem o
// Básico), com as peças da vaga do Básico (`pecasDoBasico`).
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
  const criativos = await pecasDoBasico(b, db);
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
// floor((k+1)·s/d) − floor(k·s/d) —, cuja média é exatamente s/d.
// Determinística: a mesma hora dá sempre o mesmo número (a hora congela, e a
// rede de segurança recalcula igual).
//
// k anda uma casa por hora e UMA A MAIS por dia. Só com a hora, 24 ≡ 0 (mod 3)
// prendia cada hora do relógio na mesma fatia todo dia (9, 9 ou 10), e a
// média só fechava em horário de funcionamento múltiplo de 3 h: ponto aberto
// 10 h/dia ficava sempre em 2.790 ou 2.820 exibições de 15 s no mês, nunca
// 2.800 (revisão independente, 28/09/2026). Com a casa a mais, a fatia de cada
// hora gira dia a dia e a média fecha em qualquer horário (30 dias com peça de
// 15 s: exato; pior caso simulado, 0,06%).
function insercoesDoBasicoNaHora(segundosPorHora, duracaoSegundos, hora) {
  const s = Math.max(0, Number(segundosPorHora) || 0);
  const d = duracaoValida(duracaoSegundos);
  const t = new Date(hora).getTime();
  const k = Math.floor(t / 3_600_000) + Math.floor(t / 86_400_000);
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
    // Plano sem teto de peça (NULL — migration 045: vale só o limite global)
    // continua sem teto com o Básico junto; o maior dos dois não pode virar
    // os 15 s do Básico.
    duracaoMaxima:
      plano && plano.duracao_maxima_segundos == null
        ? null
        : Math.max(
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
  pontosPorConta,
  cabeNoTeto,
  pecasDoBasico,
  paraVeicularNoPonto,
  segundosDoBasicoNaHora,
  historicoDaConta,
  doPontoDesde,
  valiaNaHora,
  insercoesDoBasicoNaHora,
  direitosCombinados,
  resumo,
};
