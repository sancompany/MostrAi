const pool = require('../db/pool');
const notificacoesRepo = require('./notificacoes');
const sse = require('../lib/sse');

// CRÉDITO MENSAL DO PONTO (migration 082, reestruturação de 24/09/2026 —
// ADR-016). Ser ponto da Mostraí não é plano: é uma relação com a rede que
// gera CRÉDITOS, a mesma unidade do ledger de indicação e de concessão do
// admin, resgatável em benefício Essencial/Pro/Prime (creditos/regras.js).
//
// UM ponto elegível = +1 crédito por COMPETÊNCIA (mês). Três telas no mesmo
// ponto continuam sendo um ponto — o benefício recompensa hospedar um ponto
// da rede, não a quantidade de equipamento. Três pontos da mesma conta = três
// créditos no mês, cada um com o ponto de origem no ledger.
//
// ELEGÍVEL (regra única — a tela do painel, a ficha do admin e o job leem
// esta mesma SQL):
//   · o ponto existe (só nasce depois da candidatura aprovada) e não está
//     arquivado/mesclado;
//   · tem conta dona válida (não excluída, não a conta interna do Mostraí);
//   · tem pelo menos UMA tela provisionada (credencial de aparelho vinculada —
//     `chave_hash`, Player V2 ou chave V1, migration 083 — ou já conectou
//     alguma vez) e ADMINISTRATIVAMENTE ativa (`dispositivos.status =
//     'ativo'`).
// De propósito, NÃO olha heartbeat/uptime: uma queda de internet não tira o
// crédito do mês do dono. Saúde técnica (status-tela.js) e elegibilidade
// comercial são coisas separadas — tela em reparo ou desligada pelo admin é
// que tira o ponto do programa, não uma hora sem sinal.
//
// COMPETÊNCIA: o mês corrente no fuso de Matão (`America/Sao_Paulo`). O job
// diário concede o mês assim que o ponto está elegível nele (instalou dia 28
// → ganha o mês); o índice único (ponto_id, competencia) garante no banco
// que rodar de novo, rodar em duas instâncias ou trocar o dono no meio do mês
// nunca gera o mesmo mês duas vezes.
const SQL_PONTOS_ELEGIVEIS = `
  SELECT p.id, p.nome, p.anunciante_id
    FROM pontos p
    JOIN anunciantes a ON a.id = p.anunciante_id
   WHERE p.status <> 'arquivado'
     AND a.excluido_em IS NULL
     AND NOT a.conta_propria
     AND EXISTS (
       SELECT 1 FROM dispositivos d
        WHERE d.ponto_id = p.id
          AND d.status = 'ativo'
          AND (d.chave_hash IS NOT NULL OR d.ultima_vez_online IS NOT NULL)
     )`;

const MESES = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

// 'AAAA-MM-01' do mês corrente em Matão.
function competenciaDe(agora = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(agora);
  const ano = partes.find((p) => p.type === 'year').value;
  const mes = partes.find((p) => p.type === 'month').value;
  return `${ano}-${mes}-01`;
}

function proximaCompetencia(competencia) {
  const [a, m] = competencia.split('-').map(Number);
  return m === 12 ? `${a + 1}-01-01` : `${a}-${String(m + 1).padStart(2, '0')}-01`;
}

// "setembro/2026"
function nomeDaCompetencia(competencia) {
  const [a, m] = String(competencia).slice(0, 10).split('-').map(Number);
  return `${MESES[m - 1]}/${a}`;
}

// `apenasPontos` (opcional): restringe a estes ids — os testes usam pra não
// creditar pontos de outros testes rodando em paralelo no mesmo banco.
async function pontosElegiveis(apenasPontos = null, db = pool) {
  const { rows } = apenasPontos
    ? await db.query(`SELECT * FROM (${SQL_PONTOS_ELEGIVEIS}) e WHERE e.id = ANY($1::int[])`, [apenasPontos])
    : await db.query(SQL_PONTOS_ELEGIVEIS);
  return rows;
}

// Situação do benefício de cada ponto (pro painel e pra ficha do admin):
// elegível agora?, o crédito do mês já saiu?, quando foi o último.
async function situacaoDosPontos(pontoIds, agora = new Date(), db = pool) {
  if (!pontoIds.length) return new Map();
  const competencia = competenciaDe(agora);
  const [{ rows: elegiveis }, { rows: ultimos }] = await Promise.all([
    db.query(`SELECT id FROM (${SQL_PONTOS_ELEGIVEIS}) e WHERE e.id = ANY($1::int[])`, [pontoIds]),
    db.query(
      `SELECT DISTINCT ON (ponto_id) ponto_id, competencia, criado_em
         FROM creditos_ledger
        WHERE tipo = 'credito_mensal_ponto' AND ponto_id = ANY($1::int[])
        ORDER BY ponto_id, competencia DESC`,
      [pontoIds],
    ),
  ]);
  const elegivel = new Set(elegiveis.map((r) => r.id));
  const ultimo = new Map(ultimos.map((r) => [r.ponto_id, r]));
  return new Map(
    pontoIds.map((id) => {
      const u = ultimo.get(id);
      const competenciaUltima = u
        ? String(u.competencia instanceof Date ? u.competencia.toISOString() : u.competencia).slice(0, 10)
        : null;
      const doMesJaSaiu = competenciaUltima === competencia;
      return [
        id,
        {
          elegivel: elegivel.has(id),
          creditoDoMesConcedido: doMesJaSaiu,
          competenciaAtual: nomeDaCompetencia(competencia),
          proximaCompetencia: nomeDaCompetencia(doMesJaSaiu ? proximaCompetencia(competencia) : competencia),
          ultimoCreditoEm: u ? u.criado_em : null,
          ultimaCompetencia: competenciaUltima ? nomeDaCompetencia(competenciaUltima) : null,
        },
      ];
    }),
  );
}

// Concede o crédito do mês a todo ponto elegível que ainda não recebeu.
// Idempotente: ON CONFLICT no índice único (ponto, competência) — só avisa
// (notificação + SSE) quem de fato ganhou uma linha nova nesta execução.
async function concederCreditosMensais({ agora = new Date(), apenasPontos = null } = {}) {
  const competencia = competenciaDe(agora);
  const elegiveis = await pontosElegiveis(apenasPontos);
  let concedidos = 0;
  for (const ponto of elegiveis) {
    const { rows } = await pool.query(
      `INSERT INTO creditos_ledger (anunciante_id, tipo, quantidade, ponto_id, competencia, observacao)
       VALUES ($1, 'credito_mensal_ponto', 1, $2, $3, $4)
       ON CONFLICT (ponto_id, competencia) WHERE tipo = 'credito_mensal_ponto' DO NOTHING
       RETURNING id`,
      [ponto.anunciante_id, ponto.id, competencia, `Crédito mensal do ponto ${ponto.nome}`],
    );
    if (!rows.length) continue;
    concedidos += 1;
    try {
      const {
        rows: [{ saldo }],
      } = await pool.query(
        'SELECT COALESCE(SUM(quantidade), 0)::int AS saldo FROM creditos_ledger WHERE anunciante_id = $1',
        [ponto.anunciante_id],
      );
      // Uma notificação só por crédito, com o saldo junto — sem mandar
      // "ganhou" e "agora você tem" separados.
      await notificacoesRepo.registrar(ponto.anunciante_id, {
        tipo: 'credito_mensal_ponto',
        titulo: `Seu ponto ${ponto.nome} gerou 1 crédito`,
        descricao: `Crédito de ${nomeDaCompetencia(competencia)}. Você agora tem ${saldo} ${saldo === 1 ? 'crédito' : 'créditos'}.`,
        entidadeTipo: 'ponto',
        entidadeId: ponto.id,
      });
    } catch (err) {
      console.error('crédito do ponto: notificação falhou (o crédito foi gravado)', err.message);
    }
    sse.emitirParaConta(ponto.anunciante_id, 'credits.updated', {});
  }
  return { competencia, elegiveis: elegiveis.length, concedidos };
}

module.exports = {
  SQL_PONTOS_ELEGIVEIS,
  competenciaDe,
  nomeDaCompetencia,
  pontosElegiveis,
  situacaoDosPontos,
  concederCreditosMensais,
};
