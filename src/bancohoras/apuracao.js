const pool = require('../db/pool');
const bancoHorasRepo = require('./repository');

// Quantos meses um saldo pode ficar sem drenar antes de virar fila do
// admin (G.3: "se não drenar em N meses, o saldo vira crédito em
// dinheiro" — decisão de QUANDO ainda não veio do dono; 3 é o valor
// escolhido aqui, documentado como tal em docs/PENDENCIAS.md, e só muda
// código, não schema, se ele decidir outro número).
const MESES_PARA_FILA_DE_CREDITO = 3;

function primeiroDiaDoMes(data) {
  return new Date(data.getFullYear(), data.getMonth(), 1);
}

// Fecha o déficit do MÊS ANTERIOR ao de hoje — nunca o mês corrente, que
// ainda está em andamento e teria déficit falso (faltam horas por rodar
// ainda). Roda uma vez por mês (scripts/apurar-banco-horas.js, cron do
// Northflank, dia 1 de cada mês) — apurar de novo o mesmo mês não duplica
// (registrarDeficit tem UNIQUE anunciante_id+mes_referencia).
async function apurarMesAnterior() {
  const hoje = new Date();
  const inicioMesAtual = primeiroDiaDoMes(hoje);
  const inicioMesAnterior = new Date(inicioMesAtual);
  inicioMesAnterior.setMonth(inicioMesAnterior.getMonth() - 1);

  // `vezes_pedidas` (migration 057) é o que faltava pra separar "não
  // coube por causa da hora vendida" de "tela caiu e não confirmou" — ver
  // o comentário da migration. O déficit do banco de horas é só o
  // PRIMEIRO: `vezes_pedidas - vezes_programadas` (RN-30, o corte
  // proporcional decide na hora, antes de qualquer player confirmar
  // nada). `vezes_confirmadas` é outro problema, já rastreado à parte —
  // usá-la aqui creditaria banco pra quem teve tela offline mas nunca foi
  // cortado pela RN-30, e é exatamente essa mistura que a migration 057
  // existe pra evitar. Conta própria não entra: ela não é cliente
  // pagante, não tem promessa de entrega a cumprir.
  const { rows } = await pool.query(
    `SELECT e.anunciante_id, SUM(e.vezes_pedidas)::int AS pedidas, SUM(e.vezes_programadas)::int AS entregues
     FROM exibicoes_contador e
     JOIN anunciantes a ON a.id = e.anunciante_id
     WHERE e.janela_hora >= $1 AND e.janela_hora < $2
       AND NOT a.conta_propria
       AND a.excluido_em IS NULL
     GROUP BY e.anunciante_id
     HAVING SUM(e.vezes_pedidas) > SUM(e.vezes_programadas)`,
    [inicioMesAnterior, inicioMesAtual],
  );

  const registrados = [];
  for (const r of rows) {
    const linha = await bancoHorasRepo.registrarDeficit({
      anuncianteId: r.anunciante_id,
      mesReferencia: inicioMesAnterior,
      exibicoesPedidas: r.pedidas,
      exibicoesEntregues: r.entregues,
    });
    if (linha) registrados.push(linha);
  }
  return { mesApurado: inicioMesAnterior, anunciantesComDeficit: rows.length, novasLinhas: registrados.length };
}

async function aplicarValvula() {
  const linhas = await bancoHorasRepo.marcarAguardandoCredito(MESES_PARA_FILA_DE_CREDITO);
  return { meses: MESES_PARA_FILA_DE_CREDITO, linhasMovidas: linhas.length };
}

module.exports = { apurarMesAnterior, aplicarValvula, MESES_PARA_FILA_DE_CREDITO };
