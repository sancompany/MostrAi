const pool = require('../db/pool');
const { DURACAO_PADRAO } = require('../lib/pacing');

// Saldo de Veiculação (nome interno: banco de horas, G.3 de
// docs/PENDENCIAS.md). Desde 27/09/2026 (migration 100) a unidade de CONTA é
// o SEGUNDO: o que se vende é tempo de tela, e cada hora do contador guarda a
// duração que usou — trocar a peça não reescreve dívida fechada. As colunas
// `exibicoes_*` continuam gravadas como equivalentes (na duração da peça do
// dia da apuração), só pra leitura antiga; nenhuma conta sai delas.
//
// "Exibições equivalentes" do que ainda falta é derivado na leitura:
// segundos pendentes ÷ duração da peça que roda HOJE (`duracaoMediaDoAnunciante`)
// — é quantas vezes a peça atual precisa tocar pra devolver o tempo.

// Duração da peça QUE RODA HOJE, mesma regra de `duracaoMedia`
// (src/playlist/gerador.js): média dos criativos aprovados, `DURACAO_PADRAO`
// (20s) se a conta não tiver nenhum aprovado ainda.
async function duracaoMediaDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT ROUND(AVG(duracao_segundos))::int AS media
     FROM criativos WHERE anunciante_id = $1 AND status = 'aprovado' AND arquivo_normalizado_url IS NOT NULL`,
    [anuncianteId],
  );
  return rows[0]?.media || DURACAO_PADRAO;
}

// Saldo pendente (segundos) de uma conta: soma das linhas 'ativo'.
async function saldoAtivoDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(segundos_banco - segundos_drenados), 0)::bigint AS saldo
     FROM banco_horas WHERE anunciante_id = $1 AND status = 'ativo'`,
    [anuncianteId],
  );
  return Number(rows[0].saldo);
}

// Saldo DISPONÍVEL (segundos) de todos os anunciantes numa consulta só — é
// isso que o gerador de playlist precisa a cada hora. Disponível = saldo
// menos o que já está programado e ainda não foi liquidado (`vezes_banco` de
// linhas com `banco_liquidado_em` NULL, na duração daquela hora): sem isso,
// cada tela programaria a mesma dívida de novo até a liquidação passar.
//
// `idadeMeses` é de propósito a idade da linha MAIS ANTIGA ainda ativa —
// pedido do dono, 18/09/2026: "quanto mais tempo no banco tiver, mais
// prioridade tem" (src/playlist/gerador.js#multiplicadorPorIdade).
async function saldosAtivos() {
  const { rows } = await pool.query(
    `WITH saldo AS (
       SELECT anunciante_id,
              SUM(segundos_banco - segundos_drenados)::bigint AS segundos,
              (EXTRACT(YEAR FROM age(date_trunc('month', now()), MIN(mes_referencia))) * 12
               + EXTRACT(MONTH FROM age(date_trunc('month', now()), MIN(mes_referencia))))::int AS idade_meses
         FROM banco_horas WHERE status = 'ativo'
        GROUP BY anunciante_id
     ), reservado AS (
       SELECT anunciante_id, SUM(vezes_banco * COALESCE(duracao_segundos, $1))::bigint AS segundos
         FROM exibicoes_contador
        WHERE vezes_banco > 0 AND banco_liquidado_em IS NULL
        GROUP BY anunciante_id
     )
     SELECT s.anunciante_id, s.segundos - COALESCE(r.segundos, 0) AS disponivel, s.idade_meses
       FROM saldo s LEFT JOIN reservado r USING (anunciante_id)
      WHERE s.segundos - COALESCE(r.segundos, 0) > 0`,
    [DURACAO_PADRAO],
  );
  const mapa = {};
  for (const r of rows) mapa[r.anunciante_id] = { segundos: Number(r.disponivel), idadeMeses: r.idade_meses };
  return mapa;
}

// Abate até `segundos` do saldo do anunciante, FIFO (linha mais antiga
// primeiro — quem espera mais tempo drena primeiro). Devolve quanto foi
// realmente abatido, que pode ser menos se o saldo não alcançar. Nunca deixa
// `segundos_drenados` passar de `segundos_banco` (CHECK da migration 100).
// `db`: client de uma transação já aberta (a liquidação abate o saldo e marca
// a hora como liquidada juntas); sem ele, abre a própria.
async function drenar(anuncianteId, segundos, db = null) {
  if (segundos <= 0) return 0;
  if (db) return drenarNa(db, anuncianteId, segundos);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const drenado = await drenarNa(cliente, anuncianteId, segundos);
    await cliente.query('COMMIT');
    return drenado;
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}

async function drenarNa(cliente, anuncianteId, segundos) {
  const { rows: linhas } = await cliente.query(
    `SELECT id, segundos_banco, segundos_drenados FROM banco_horas
       WHERE anunciante_id = $1 AND status = 'ativo'
       ORDER BY mes_referencia ASC FOR UPDATE`,
    [anuncianteId],
  );
  let restante = segundos;
  let drenadoTotal = 0;
  for (const linha of linhas) {
    if (restante <= 0) break;
    const disponivel = Number(linha.segundos_banco) - Number(linha.segundos_drenados);
    const drenarAqui = Math.min(disponivel, restante);
    if (drenarAqui <= 0) continue;
    const novoDrenado = Number(linha.segundos_drenados) + drenarAqui;
    // O equivalente em exibições acompanha na mesma proporção (leitura antiga).
    await cliente.query(
      `UPDATE banco_horas
          SET segundos_drenados = $2::bigint,
              exibicoes_drenadas = LEAST(exibicoes_banco,
                                         FLOOR(exibicoes_banco * $2::bigint::numeric / NULLIF(segundos_banco, 0))::int),
              status = CASE WHEN $2::bigint >= segundos_banco THEN 'drenado' ELSE status END
        WHERE id = $1`,
      [linha.id, novoDrenado],
    );
    restante -= drenarAqui;
    drenadoTotal += drenarAqui;
  }
  return drenadoTotal;
}

// Fila 'aguardando_credito' — HISTÓRICO. Era alimentada pela válvula de 3
// meses, que saiu em 25/09/2026 (decisão do dono: banco de horas é
// obrigação de veiculação, sem expiração e nunca crédito em dinheiro).
// Nenhum código põe linha nova aqui; a leitura e o "resolver" continuam só
// pra alguma linha antiga que exista (em produção: nenhuma).
async function listarAguardandoCredito() {
  const { rows } = await pool.query(
    `SELECT b.*, a.nome_empresa, a.contato_email
     FROM banco_horas b JOIN anunciantes a ON a.id = b.anunciante_id
     WHERE b.status = 'aguardando_credito' AND b.resolvido_em IS NULL
     ORDER BY b.mes_referencia ASC`,
  );
  return rows;
}

// O admin decidiu o que fazer (crédito manual, desconto na próxima
// fatura, ou não fazer nada) — tira a linha da fila. Nunca dispara
// dinheiro por conta própria: essa parte é sempre ação humana, fora
// desta função.
async function resolverCredito(id) {
  const { rows } = await pool.query(
    `UPDATE banco_horas SET resolvido_em = now() WHERE id = $1 AND status = 'aguardando_credito' RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

// Meses da conta com saldo ainda pendente — em segundos, com o contratado e
// o entregue confirmado do mês (o painel mostra de onde o saldo veio).
async function listarAtivasDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT mes_referencia, segundos_obrigacao, segundos_entregues, segundos_banco, segundos_drenados
     FROM banco_horas WHERE anunciante_id = $1 AND status = 'ativo'
     ORDER BY mes_referencia ASC`,
    [anuncianteId],
  );
  return rows.map((r) => ({
    mes_referencia: r.mes_referencia,
    segundos_obrigacao: r.segundos_obrigacao == null ? null : Number(r.segundos_obrigacao),
    segundos_entregues: r.segundos_entregues == null ? null : Number(r.segundos_entregues),
    segundos_banco: Number(r.segundos_banco),
    segundos_drenados: Number(r.segundos_drenados),
  }));
}

// Admin: toda competência apurada, inclusive as que fecharam sem saldo
// (status 'drenado' com segundos_banco 0) — é a trilha de auditoria de que o
// mês foi apurado e do que se devia.
async function listarTodos() {
  const { rows } = await pool.query(
    `SELECT b.*, a.nome_empresa
     FROM banco_horas b JOIN anunciantes a ON a.id = b.anunciante_id
     ORDER BY b.mes_referencia DESC, a.nome_empresa`,
  );
  return rows;
}

module.exports = {
  duracaoMediaDoAnunciante,
  saldoAtivoDoAnunciante,
  saldosAtivos,
  drenar,
  listarAguardandoCredito,
  resolverCredito,
  listarAtivasDoAnunciante,
  listarTodos,
};
