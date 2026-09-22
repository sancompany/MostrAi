const pool = require('../db/pool');
const { reais, data } = require('../br/formato');

// Extrato do ponto — o que foi pago a quem cede a parede, mês a mês.
// Regra de negócio mora aqui, não em scripts/ (Lei 1).

const CAMPOS = `id, ponto_id, competencia, valor, pago_em, forma, observacao, criado_em`;

// O extrato que o DONO DO PONTO vê: só dos pontos dele, nunca de outro.
async function extratoDaConta(anuncianteId) {
  const { rows } = await pool.query(
    `SELECT pg.id, pg.ponto_id, pg.competencia, pg.valor, pg.pago_em,
            pg.forma, pg.observacao, pg.criado_em, p.nome AS ponto_nome
     FROM pagamentos_ponto pg
     JOIN pontos p ON p.id = pg.ponto_id
     WHERE p.anunciante_id = $1
     ORDER BY pg.competencia DESC, p.nome`,
    [anuncianteId],
  );
  return rows;
}

// Fila financeira (rodada Financeiro, 22/09/2026): quem devo pagar ESTE mês.
// Só pontos com dinheiro de verdade envolvido (`valor_pago_mensal > 0` — a
// modalidade "troca por tela" do comodato não gera repasse nenhum, isso já
// vem certo de `pontos.valor_pago_mensal`, sem recriar a regra de comodato
// aqui) e SEM lançamento pago pra este mês: nunca lançou (`pagamento_id`
// nulo, a ficha vira "Pagar" — lança já quitado) ou lançou e ainda não
// pagou (`pagamento_id` presente, vira "Marcar como pago").
async function listarPendentesDoMes() {
  const { rows } = await pool.query(
    `SELECT p.id AS ponto_id, p.nome AS ponto_nome, p.valor_pago_mensal,
            p.responsavel_nome, a.nome_empresa AS conta_nome,
            pg.id AS pagamento_id, pg.forma, pg.observacao
       FROM pontos p
       LEFT JOIN anunciantes a ON a.id = p.anunciante_id
       LEFT JOIN pagamentos_ponto pg
         ON pg.ponto_id = p.id AND pg.competencia = date_trunc('month', current_date)::date
      WHERE p.status = 'em_operacao' AND p.valor_pago_mensal > 0
        AND (pg.id IS NULL OR pg.pago_em IS NULL)
      ORDER BY p.nome`,
  );
  return rows;
}

async function listarPorPonto(pontoId) {
  const { rows } = await pool.query(
    `SELECT ${CAMPOS} FROM pagamentos_ponto WHERE ponto_id = $1 ORDER BY competencia DESC`,
    [pontoId],
  );
  return rows;
}

// Lançamento do admin. `competencia` chega como 'AAAA-MM' e vira o dia 1.
async function lancar({ ponto_id, competencia, valor, forma, observacao, pago_em }) {
  const mes = /^\d{4}-\d{2}$/.test(String(competencia)) ? `${competencia}-01` : competencia;
  const { rows } = await pool.query(
    `INSERT INTO pagamentos_ponto (ponto_id, competencia, valor, forma, observacao, pago_em)
     VALUES ($1, $2::date, $3, $4, $5, $6)
     ON CONFLICT (ponto_id, competencia) DO UPDATE
       SET valor = EXCLUDED.valor, forma = EXCLUDED.forma,
           observacao = EXCLUDED.observacao, pago_em = EXCLUDED.pago_em
     RETURNING ${CAMPOS}`,
    [ponto_id, mes, valor, forma || null, observacao || null, pago_em || null],
  );
  return rows[0];
}

async function marcarPago(id, pago) {
  const { rows } = await pool.query(`UPDATE pagamentos_ponto SET pago_em = $2 WHERE id = $1 RETURNING ${CAMPOS}`, [
    id,
    pago ? new Date() : null,
  ]);
  return rows[0];
}

// Totais que o ponto lê de cabeça: quanto já recebeu e quanto está em aberto.
function resumir(linhas) {
  const centavos = (v) => Math.round(Number(v || 0) * 100);
  const pago = linhas.filter((l) => l.pago_em).reduce((s, l) => s + centavos(l.valor), 0);
  const aberto = linhas.filter((l) => !l.pago_em).reduce((s, l) => s + centavos(l.valor), 0);
  return {
    totalPago: pago / 100,
    totalAberto: aberto / 100,
    totalPagoTexto: reais(pago / 100),
    totalAbertoTexto: reais(aberto / 100),
    ultimoPagamento: linhas.find((l) => l.pago_em) ? data(linhas.find((l) => l.pago_em).pago_em) : null,
  };
}

module.exports = { extratoDaConta, listarPorPonto, listarPendentesDoMes, lancar, marcarPago, resumir };
