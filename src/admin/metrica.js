const pool = require('../db/pool');

// As três consultas salvas da métrica (docs/funcional.md §9).
//
// São três porque respondem as três perguntas que o estado atual do banco não
// responde: o resultado do mês (a métrica principal), onde as pessoas param no
// caminho até pagar, e quanto tempo o dono demora pra destravar cada fila.
//
// Toda consulta ignora `interno` — o dono testando não é métrica.
const MESES = 6;

// 1. A MÉTRICA PRINCIPAL, mês a mês. Receita confirmada menos ajuda de custo
// aos pontos, menos amortização das telas, menos custos fixos. Os três custos
// são do estado ATUAL da rede, não históricos: o sistema não guarda quanto
// custava a rede em março, e fingir que guarda seria pior que dizer isso.
const SQL_MARGEM = `
  WITH meses AS (
    SELECT date_trunc('month', now()) - (n || ' months')::interval AS mes
      FROM generate_series(0, $1::int - 1) n
  ),
  receita AS (
    SELECT date_trunc('month', criado_em) AS mes, COALESCE(SUM(valor), 0) AS total
      FROM cobrancas_confirmadas GROUP BY 1
  ),
  custo_atual AS (
    SELECT
      (SELECT COALESCE(SUM(valor_pago_mensal), 0) FROM pontos WHERE status = 'em_operacao') AS pontos,
      (SELECT COALESCE(SUM(d.custo_equipamento / GREATEST(d.meses_amortizacao, 1)), 0)
         FROM dispositivos d JOIN pontos p ON p.id = d.ponto_id
        WHERE d.status = 'ativo' AND p.status = 'ativo') AS amortizacao,
      (SELECT COALESCE(SUM(valor_mensal), 0) FROM custos_fixos) AS fixos
  )
  SELECT to_char(m.mes, 'YYYY-MM') AS mes,
         COALESCE(r.total, 0) AS receita,
         c.pontos AS custo_pontos, c.amortizacao, c.fixos AS custos_fixos,
         COALESCE(r.total, 0) - c.pontos - c.amortizacao - c.fixos AS margem
    FROM meses m CROSS JOIN custo_atual c LEFT JOIN receita r ON r.mes = m.mes
   ORDER BY m.mes`;

// 2. O FUNIL, mês a mês. Cadastrou → foi aprovado → chegou ao checkout →
// pagou. A distância entre os dois últimos é quem desiste na hora de pagar,
// que é a única perda que o banco sozinho não mostra: assinatura abandonada
// não vira linha em lugar nenhum.
const SQL_FUNIL = `
  SELECT to_char(date_trunc('month', criado_em), 'YYYY-MM') AS mes,
         COUNT(*) FILTER (WHERE nome = 'conta:cadastro_conclui')::int AS cadastros,
         COUNT(*) FILTER (WHERE nome = 'conta:aprovacao_recebe')::int AS aprovacoes,
         COUNT(*) FILTER (WHERE nome = 'plano:assinatura_inicia')::int AS checkouts_abertos,
         COUNT(*) FILTER (WHERE nome = 'pagamento:cobranca_confirma')::int AS pagamentos
    FROM eventos
   WHERE NOT interno AND criado_em >= date_trunc('month', now()) - ($1::int - 1 || ' months')::interval
   GROUP BY 1 ORDER BY 1`;

// 3. O TEMPO DAS FILAS, por semana. Mediana e pior caso de quanto o dono
// demora pra aprovar uma conta e um criativo. Mediana, não média: uma conta
// esquecida por duas semanas puxaria a média e esconderia que o resto sai no
// mesmo dia.
const SQL_FILAS = `
  SELECT to_char(date_trunc('week', criado_em), 'YYYY-MM-DD') AS semana,
         nome,
         COUNT(*)::int AS quantidade,
         ROUND(percentile_cont(0.5) WITHIN GROUP (
           ORDER BY (propriedades->>'horas_ate_aprovar')::numeric)::numeric, 1) AS mediana_horas,
         ROUND(MAX((propriedades->>'horas_ate_aprovar')::numeric), 1) AS pior_caso_horas
    FROM eventos
   WHERE NOT interno
     AND nome IN ('conta:aprovacao_recebe', 'criativo:video_aprova')
     AND propriedades ? 'horas_ate_aprovar'
     AND criado_em >= now() - interval '90 days'
   GROUP BY 1, 2 ORDER BY 1 DESC, 2`;

async function consultar() {
  const [margem, funil, filas, brutos] = await Promise.all([
    pool.query(SQL_MARGEM, [MESES]),
    pool.query(SQL_FUNIL, [MESES]),
    pool.query(SQL_FILAS),
    // Contagem por nome, pra saber de relance se a instrumentação está viva.
    // Um evento que nunca aparece aqui é um evento que ninguém emite.
    pool.query(`SELECT nome, COUNT(*)::int AS total,
                       COUNT(*) FILTER (WHERE interno)::int AS internos,
                       MAX(criado_em) AS ultimo
                  FROM eventos GROUP BY nome ORDER BY nome`),
  ]);
  return {
    meses: MESES,
    margem: margem.rows,
    funil: funil.rows,
    filas: filas.rows,
    eventos: brutos.rows,
  };
}

module.exports = { consultar };
