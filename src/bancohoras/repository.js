const pool = require('../db/pool');
const { DURACAO_PADRAO } = require('../lib/pacing');

// Banco de horas (G.3 de docs/PENDENCIAS.md) — unidade de CONTA é EXIBIÇÃO
// (vezes), não segundos (ver migration 058): duração de criativo não tem
// histórico, só o valor atual, e a apuração não pode estimar sobre
// estimativa. Segundos aparecem só na TELA (painel do anunciante) — pedido
// do dono, exibições viram tempo pra ficar legível — usando a mesma duração
// atual, com o mesmo aviso: é ilustrativo, não é o que a apuração usa.

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

async function registrarDeficit({ anuncianteId, mesReferencia, exibicoesPedidas, exibicoesEntregues }) {
  const banco = exibicoesPedidas - exibicoesEntregues;
  if (banco <= 0) return null;
  const { rows } = await pool.query(
    `INSERT INTO banco_horas (anunciante_id, mes_referencia, exibicoes_pedidas, exibicoes_entregues, exibicoes_banco)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (anunciante_id, mes_referencia) DO NOTHING
     RETURNING *`,
    [anuncianteId, mesReferencia, exibicoesPedidas, exibicoesEntregues, banco],
  );
  return rows[0] || null;
}

async function saldoAtivoDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(exibicoes_banco - exibicoes_drenadas), 0)::int AS saldo
     FROM banco_horas WHERE anunciante_id = $1 AND status = 'ativo'`,
    [anuncianteId],
  );
  return rows[0].saldo;
}

// Saldo DISPONÍVEL de todos os anunciantes numa consulta só — é isso que o
// gerador de playlist precisa a cada hora, pra não fazer uma consulta por
// anunciante elegível. Disponível = saldo menos o que já está programado e
// ainda não foi liquidado (`vezes_banco` de linhas com `banco_liquidado_em`
// NULL, migration 090): sem isso, cada tela programaria a mesma dívida de
// novo até a liquidação passar.
//
// `idadeMeses` é de propósito a idade da linha MAIS ANTIGA ainda ativa —
// pedido do dono, 18/09/2026: "quanto mais tempo no banco tiver, mais
// prioridade tem" (src/playlist/gerador.js#multiplicadorPorIdade).
async function saldosAtivos() {
  const { rows } = await pool.query(
    `WITH saldo AS (
       SELECT anunciante_id,
              SUM(exibicoes_banco - exibicoes_drenadas)::int AS saldo,
              (EXTRACT(YEAR FROM age(date_trunc('month', now()), MIN(mes_referencia))) * 12
               + EXTRACT(MONTH FROM age(date_trunc('month', now()), MIN(mes_referencia))))::int AS idade_meses
         FROM banco_horas WHERE status = 'ativo'
        GROUP BY anunciante_id
     ), reservado AS (
       SELECT anunciante_id, SUM(vezes_banco)::int AS vezes
         FROM exibicoes_contador
        WHERE vezes_banco > 0 AND banco_liquidado_em IS NULL
        GROUP BY anunciante_id
     )
     SELECT s.anunciante_id, s.saldo - COALESCE(r.vezes, 0) AS disponivel, s.idade_meses
       FROM saldo s LEFT JOIN reservado r USING (anunciante_id)
      WHERE s.saldo - COALESCE(r.vezes, 0) > 0`,
  );
  const mapa = {};
  for (const r of rows) mapa[r.anunciante_id] = { saldo: r.disponivel, idadeMeses: r.idade_meses };
  return mapa;
}

// Drena até `quantidade` do saldo do anunciante, FIFO (linha mais antiga
// primeiro — quem espera mais tempo drena primeiro). Devolve quanto foi
// realmente drenado, que pode ser menos que `quantidade` se o saldo não
// alcançar. Sempre um número >= 0, nunca deixa `exibicoes_drenadas` passar
// de `exibicoes_banco` (a soma decrescente já garante isso por linha).
// `db`: client de uma transação já aberta (a liquidação abate o saldo e marca
// a hora como liquidada juntas); sem ele, abre a própria.
async function drenar(anuncianteId, quantidade, db = null) {
  if (quantidade <= 0) return 0;
  if (db) return drenarNa(db, anuncianteId, quantidade);
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const drenado = await drenarNa(cliente, anuncianteId, quantidade);
    await cliente.query('COMMIT');
    return drenado;
  } catch (err) {
    await cliente.query('ROLLBACK');
    throw err;
  } finally {
    cliente.release();
  }
}

async function drenarNa(cliente, anuncianteId, quantidade) {
  const { rows: linhas } = await cliente.query(
    `SELECT id, exibicoes_banco, exibicoes_drenadas FROM banco_horas
       WHERE anunciante_id = $1 AND status = 'ativo'
       ORDER BY mes_referencia ASC FOR UPDATE`,
    [anuncianteId],
  );
  let restante = quantidade;
  let drenadoTotal = 0;
  for (const linha of linhas) {
    if (restante <= 0) break;
    const disponivel = linha.exibicoes_banco - linha.exibicoes_drenadas;
    const drenarAqui = Math.min(disponivel, restante);
    if (drenarAqui <= 0) continue;
    const novoDrenado = linha.exibicoes_drenadas + drenarAqui;
    await cliente.query(
      `UPDATE banco_horas SET exibicoes_drenadas = $2, status = CASE WHEN $2 >= exibicoes_banco THEN 'drenado' ELSE status END
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

async function listarAtivasDoAnunciante(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT mes_referencia, exibicoes_banco, exibicoes_drenadas
     FROM banco_horas WHERE anunciante_id = $1 AND status = 'ativo'
     ORDER BY mes_referencia ASC`,
    [anuncianteId],
  );
  return rows;
}

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
  registrarDeficit,
  saldoAtivoDoAnunciante,
  saldosAtivos,
  drenar,
  listarAguardandoCredito,
  resolverCredito,
  listarAtivasDoAnunciante,
  listarTodos,
};
