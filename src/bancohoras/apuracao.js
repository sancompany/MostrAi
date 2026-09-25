const pool = require('../db/pool');
const bancoHorasRepo = require('./repository');
const { FOLGA_VIRADA_MIN } = require('../playlist/gerador');

// Banco de horas como OBRIGAÇÃO DE VEICULAÇÃO (decisão do dono, 25/09/2026 —
// MANTER): capacidade contratada que não coube vira saldo; o saldo volta em
// capacidade ociosa de horas futuras; só a exibição confirmada abate o saldo.
// Sem expiração automática, sem zerar na virada do mês, nunca crédito em
// dinheiro — por isso a válvula de 3 meses (fila "aguardando crédito") saiu.

// Mês comercial no relógio de Matão (mesma régua de src/lib/vigencia.js): o
// servidor roda em UTC, e `new Date(ano, mês, 1)` punha as 21h–24h do último
// dia do mês no mês seguinte.
const FUSO = 'America/Sao_Paulo';

// A prova de uma exibição só é aceita até 60 min + a folga da virada depois
// do início da hora dela (src/playlist/gerador.js#confirmarExecucao). Depois
// disso a linha da hora não muda mais, e a parte do banco pode ser abatida.
const MINUTOS_ATE_A_HORA_FECHAR = 60 + FOLGA_VIRADA_MIN;

// `mes`: 'YYYY-MM' (validado por quem chama) ou null = o mês anterior ao
// corrente em Matão. Só mês FECHADO: o corrente ainda tem horas por rodar e
// daria déficit falso.
async function janelaDoMes(mes) {
  const {
    rows: [j],
  } = await pool.query(
    `SELECT (m.inicio AT TIME ZONE '${FUSO}') AS inicio,
            ((m.inicio + interval '1 month') AT TIME ZONE '${FUSO}') AS fim,
            to_char(m.inicio, 'YYYY-MM-DD') AS mes_referencia,
            m.inicio < date_trunc('month', now() AT TIME ZONE '${FUSO}') AS fechado
       FROM (SELECT COALESCE(to_date($1, 'YYYY-MM')::timestamp,
                             date_trunc('month', now() AT TIME ZONE '${FUSO}') - interval '1 month') AS inicio) m`,
    [mes],
  );
  return j;
}

// Fecha o déficit de um mês. Apurar de novo o mesmo mês não duplica
// (UNIQUE anunciante_id+mes_referencia em banco_horas).
//
// `vezes_pedidas` (migration 057) separa "não coube porque a hora estava
// vendida" de "tela caiu e não confirmou": o déficit é só o primeiro —
// pedidas menos a entrega NORMAL da hora (`vezes_programadas - vezes_banco`,
// migration 090: exibição que devolve dívida antiga não é entrega do mês).
// `vezes_confirmadas` não entra: tela offline já volta como déficit da hora
// seguinte, e somar aqui creditaria banco duas vezes pela mesma falha. Conta
// própria não entra: não é cliente pagante, não tem promessa a cumprir.
//
// `simular`: calcula e devolve, sem gravar nada. `apenasContas`: mesmo escopo
// de teste dos outros jobs — produção não passa.
async function apurarMes({ mes = null, simular = false, apenasContas = null } = {}) {
  const janela = await janelaDoMes(mes);
  if (!janela.fechado) {
    const erro = new Error(
      `o mês ${janela.mes_referencia.slice(0, 7)} ainda não fechou em Matão — só se apura mês fechado`,
    );
    erro.argumentoInvalido = true;
    throw erro;
  }
  const { rows } = await pool.query(
    `SELECT e.anunciante_id, SUM(e.vezes_pedidas)::int AS pedidas,
            SUM(e.vezes_programadas - e.vezes_banco)::int AS entregues
       FROM exibicoes_contador e
       JOIN anunciantes a ON a.id = e.anunciante_id
      WHERE e.janela_hora >= $1 AND e.janela_hora < $2
        AND NOT a.conta_propria
        AND a.excluido_em IS NULL
        AND ($3::int[] IS NULL OR e.anunciante_id = ANY($3))
      GROUP BY e.anunciante_id
     HAVING SUM(e.vezes_pedidas) > SUM(e.vezes_programadas - e.vezes_banco)`,
    [janela.inicio, janela.fim, apenasContas],
  );

  const resultado = {
    mesApurado: janela.mes_referencia,
    anunciantesComDeficit: rows.length,
    exibicoesDevidas: rows.reduce((soma, r) => soma + (r.pedidas - r.entregues), 0),
    novasLinhas: 0,
  };
  if (simular) return resultado;
  for (const r of rows) {
    const linha = await bancoHorasRepo.registrarDeficit({
      anuncianteId: r.anunciante_id,
      mesReferencia: janela.mes_referencia,
      exibicoesPedidas: r.pedidas,
      exibicoesEntregues: r.entregues,
    });
    if (linha) resultado.novasLinhas += 1;
  }
  return resultado;
}

// Abate do saldo as exibições do banco que a TV CONFIRMOU, hora a hora, uma
// vez por hora já fechada. A confirmada conta primeiro pra entrega normal da
// hora e só o que passar dela é do banco — na dúvida sobre qual exibição
// falhou, a dívida fica (o erro vai a favor do anunciante). Banco programado
// e não confirmado não abate nada: volta a ficar disponível pra próxima hora
// com espaço.
//
// Uma transação por conta: marca as horas como liquidadas e abate o saldo
// juntas — duas execuções ao mesmo tempo nunca abatem a mesma hora (o UPDATE
// com `banco_liquidado_em IS NULL` trava e reavalia a linha).
async function liquidarBancoConfirmado({ apenasContas = null, simular = false } = {}) {
  const { rows: contas } = await pool.query(
    `SELECT anunciante_id, COUNT(*)::int AS linhas,
            SUM(LEAST(GREATEST(vezes_confirmadas - (vezes_programadas - vezes_banco), 0), vezes_banco))::int AS entregues
       FROM exibicoes_contador
      WHERE vezes_banco > 0 AND banco_liquidado_em IS NULL
        AND janela_hora < now() - ($1::int * interval '1 minute')
        AND ($2::int[] IS NULL OR anunciante_id = ANY($2))
      GROUP BY anunciante_id`,
    [MINUTOS_ATE_A_HORA_FECHAR, apenasContas],
  );
  const relato = { contas: contas.length, linhas: 0, exibicoesAbatidas: 0 };
  if (simular) {
    for (const c of contas) {
      relato.linhas += c.linhas;
      relato.exibicoesAbatidas += c.entregues;
    }
    return relato;
  }
  for (const { anunciante_id: anuncianteId } of contas) {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows } = await cliente.query(
        `UPDATE exibicoes_contador SET banco_liquidado_em = now()
          WHERE anunciante_id = $1 AND vezes_banco > 0 AND banco_liquidado_em IS NULL
            AND janela_hora < now() - ($2::int * interval '1 minute')
          RETURNING LEAST(GREATEST(vezes_confirmadas - (vezes_programadas - vezes_banco), 0), vezes_banco) AS entregues`,
        [anuncianteId, MINUTOS_ATE_A_HORA_FECHAR],
      );
      const entregues = rows.reduce((soma, r) => soma + r.entregues, 0);
      const abatidas = await bancoHorasRepo.drenar(anuncianteId, entregues, cliente);
      await cliente.query('COMMIT');
      relato.linhas += rows.length;
      relato.exibicoesAbatidas += abatidas;
    } catch (err) {
      await cliente.query('ROLLBACK');
      throw err;
    } finally {
      cliente.release();
    }
  }
  return relato;
}

async function registrarExecucao(comecouEm, { apuracao = {}, liquidacao = {}, abortou = null } = {}) {
  try {
    await pool.query(
      `INSERT INTO banco_horas_execucoes
         (comecou_em, mes_apurado, anunciantes_com_deficit, linhas_novas, linhas_liquidadas, exibicoes_abatidas, abortou)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        comecouEm,
        apuracao.mesApurado || null,
        apuracao.anunciantesComDeficit || 0,
        apuracao.novasLinhas || 0,
        liquidacao.linhas || 0,
        liquidacao.exibicoesAbatidas || 0,
        abortou,
      ],
    );
  } catch (err) {
    // O registro é evidência, não a operação: falhar aqui não desfaz o que
    // já foi apurado, e o log do job continua dizendo o que aconteceu.
    console.error('registro da execução do banco de horas falhou:', err.message);
  }
}

module.exports = {
  apurarMes,
  liquidarBancoConfirmado,
  registrarExecucao,
  MINUTOS_ATE_A_HORA_FECHAR,
};
