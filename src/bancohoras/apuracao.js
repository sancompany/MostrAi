const pool = require('../db/pool');
const bancoHorasRepo = require('./repository');
const { registrarHorasSemPedido } = require('./obrigacao');
const { PRAZO_PROOF_OF_PLAY_MIN } = require('../playlist/gerador');
const { DURACAO_PADRAO } = require('../lib/pacing');

// SALDO DE VEICULAÇÃO (nome interno: banco de horas). Obrigação de
// veiculação (decisão do dono, 25/09/2026 — MANTER): o que a conta tinha
// direito e a TV não confirmou vira saldo; o saldo volta em capacidade
// ociosa de horas futuras; só a exibição confirmada abate o saldo. Sem
// expiração automática, sem zerar na virada do mês, nunca crédito em
// dinheiro.
//
// Desde 27/09/2026 (docs/specs/2026-09-27-saldo-de-veiculacao.md) a conta é
// em TEMPO e por comprovante:
//
//   saldo do mês = Σ obrigação − Σ entrega normal CONFIRMADA   (segundos)
//
// - obrigação: `exibicoes_contador.segundos_obrigacao` — hora fechada não tem
//   linha (ponto fechado ≠ falha de entrega); hora aberta sem sinal ganha a
//   linha pela apuração (obrigacao.js);
// - entrega: `LEAST(confirmadas, programadas − banco) × duração da hora` —
//   pedida, programada, servida ou `playing` não entrega nada; a parte
//   confirmada que devolve dívida antiga (banco) não é entrega do mês;
// - redistribuição já aconteceu antes: a compensação da RN-49 e a reposição
//   da hora anterior entram na hora (camada T2 de montarHoraDeTv) e, se
//   tocaram, já estão na entrega. Só o que não coube e não tocou sobra.
//
// Até 27/09/2026 a apuração contava "o que não coube" (pedidas − programadas)
// e confiava no déficit hora a hora pro que foi programado e não tocou —
// que se perdia na virada de hora fechada, de mês e com a TV sem sinal.

// Mês comercial no relógio de Matão (mesma régua de src/lib/vigencia.js).
const FUSO = 'America/Sao_Paulo';

// A prova de uma exibição é aceita até 7 dias + 60 min depois do início da
// hora dela (proof-of-play offline, src/playlist/gerador.js#confirmarExecucao).
// Só depois disso a linha da hora não muda mais: a liquidação espera esse
// prazo por hora, e a apuração de um mês só fica DEFINITIVA quando a última
// hora dele passa do prazo — antes disso ela se recompõe a cada execução.
const MINUTOS_ATE_A_HORA_FECHAR = PRAZO_PROOF_OF_PLAY_MIN;

const HORA = 3_600_000;

// `mes`: 'YYYY-MM' (validado por quem chama) ou null = o mês anterior ao de
// `agora` em Matão. `fechado`: o mês acabou. `finalEm`: a partir de quando
// nenhum comprovante do mês ainda pode chegar.
async function janelaDoMes(mes, agora) {
  const {
    rows: [j],
  } = await pool.query(
    `SELECT (m.inicio AT TIME ZONE '${FUSO}') AS inicio,
            ((m.inicio + interval '1 month') AT TIME ZONE '${FUSO}') AS fim,
            to_char(m.inicio, 'YYYY-MM-DD') AS mes_referencia
       FROM (SELECT COALESCE(to_date($1, 'YYYY-MM')::timestamp,
                             date_trunc('month', $2::timestamptz AT TIME ZONE '${FUSO}') - interval '1 month') AS inicio) m`,
    [mes, agora],
  );
  const fim = new Date(j.fim);
  // Última hora do mês começa 1 h antes do fim; o prazo conta do início dela.
  const finalEm = new Date(fim.getTime() - HORA + MINUTOS_ATE_A_HORA_FECHAR * 60_000);
  return {
    inicio: new Date(j.inicio),
    fim,
    mesReferencia: j.mes_referencia,
    fechado: fim.getTime() <= new Date(agora).getTime(),
    finalEm,
    definitivo: finalEm.getTime() <= new Date(agora).getTime(),
  };
}

// Fecha o saldo de uma competência.
//
// IDEMPOTENTE: uma linha por (conta, mês) — UNIQUE da 058. Rodar de novo
// RECOMPÕE a mesma linha com os mesmos dados (mesmo resultado), nunca soma.
// Enquanto a última apuração da linha aconteceu antes de `finalEm`, ela ainda
// pode mudar (comprovante offline chegando); depois de uma apuração em
// `finalEm` ou além, a linha congela e nenhuma execução mexe mais nela. O
// saldo nunca fica abaixo do que já voltou em exibição (`segundos_drenados`).
//
// Toda conta com obrigação no mês ganha linha — inclusive a que entregou
// tudo (saldo 0, status 'drenado'): é a trilha de auditoria de que o mês foi
// apurado e do que se devia. Conta própria e conta excluída não entram.
//
// `simular`: calcula e devolve, sem gravar nada (nem as horas sem sinal).
// `apenasContas`: mesmo escopo de teste dos outros jobs. `agora`: relógio
// injetável (testes); produção não passa.
async function apurarMes({ mes = null, simular = false, apenasContas = null, agora = new Date() } = {}) {
  const janela = await janelaDoMes(mes, agora);
  const mesTexto = janela.mesReferencia.slice(0, 7);
  if (!janela.fechado) {
    const erro = new Error(`o mês ${mesTexto} ainda não fechou em Matão — só se apura mês fechado`);
    erro.argumentoInvalido = true;
    throw erro;
  }
  const semSinal = simular
    ? { horas: 0 }
    : await registrarHorasSemPedido({
        de: janela.inicio,
        ate: new Date(Math.min(janela.fim.getTime(), new Date(agora).getTime())),
        apenasContas,
      });

  // Duração de reserva só pra linha gravada antes da migration 100 (sem a
  // duração da hora): a média das peças aprovadas da conta, ou o padrão.
  const { rows } = await pool.query(
    `SELECT e.anunciante_id,
            SUM(COALESCE(e.segundos_obrigacao,
                         e.vezes_pedidas * COALESCE(e.duracao_segundos, d.media, $4)))::bigint AS obrigacao,
            SUM(LEAST(e.vezes_confirmadas, e.vezes_programadas - e.vezes_banco)
                * COALESCE(e.duracao_segundos, d.media, $4))::bigint AS entregue,
            COALESCE(MAX(d.media), $4)::int AS duracao_atual
       FROM exibicoes_contador e
       JOIN anunciantes a ON a.id = e.anunciante_id
       LEFT JOIN LATERAL (
         SELECT ROUND(AVG(c.duracao_segundos))::int AS media FROM criativos c
          WHERE c.anunciante_id = e.anunciante_id AND c.status = 'aprovado'
       ) d ON true
      WHERE e.janela_hora >= $1 AND e.janela_hora < $2
        AND NOT a.conta_propria
        AND a.excluido_em IS NULL
        AND ($3::int[] IS NULL OR e.anunciante_id = ANY($3))
      GROUP BY e.anunciante_id
     HAVING SUM(COALESCE(e.segundos_obrigacao, e.vezes_pedidas)) > 0`,
    [janela.inicio, janela.fim, apenasContas, DURACAO_PADRAO],
  );

  const contas = rows.map((r) => {
    const obrigacao = Number(r.obrigacao);
    const entregue = Number(r.entregue);
    return {
      anuncianteId: r.anunciante_id,
      obrigacao,
      entregue,
      saldo: Math.max(0, obrigacao - entregue),
      duracao: r.duracao_atual,
    };
  });
  const resultado = {
    mesApurado: janela.mesReferencia,
    definitivo: janela.definitivo,
    anunciantesComDeficit: contas.filter((c) => c.saldo > 0).length,
    segundosDevidos: contas.reduce((soma, c) => soma + c.saldo, 0),
    horasSemPedido: semSinal.horas,
    novasLinhas: 0,
    linhasRecompostas: 0,
  };
  if (simular) return resultado;

  for (const c of contas) {
    const { rows: gravada } = await pool.query(
      `INSERT INTO banco_horas
         (anunciante_id, mes_referencia, exibicoes_pedidas, exibicoes_entregues, exibicoes_banco,
          segundos_obrigacao, segundos_entregues, segundos_banco, status, apurado_em)
       VALUES ($1, $2, CEIL($3::numeric / $6)::int, FLOOR($4::numeric / $6)::int, CEIL($5::numeric / $6)::int,
               $3, $4, $5, CASE WHEN $5 > 0 THEN 'ativo' ELSE 'drenado' END, $7)
       ON CONFLICT (anunciante_id, mes_referencia) DO UPDATE
          SET segundos_obrigacao = EXCLUDED.segundos_obrigacao,
              segundos_entregues = EXCLUDED.segundos_entregues,
              segundos_banco = GREATEST(banco_horas.segundos_drenados, EXCLUDED.segundos_banco),
              exibicoes_pedidas = EXCLUDED.exibicoes_pedidas,
              exibicoes_entregues = EXCLUDED.exibicoes_entregues,
              exibicoes_banco = GREATEST(banco_horas.exibicoes_drenadas, EXCLUDED.exibicoes_banco),
              status = CASE WHEN GREATEST(banco_horas.segundos_drenados, EXCLUDED.segundos_banco)
                                 > banco_horas.segundos_drenados
                            THEN 'ativo' ELSE 'drenado' END,
              apurado_em = EXCLUDED.apurado_em
        WHERE banco_horas.status <> 'aguardando_credito'
          AND (banco_horas.apurado_em IS NULL OR banco_horas.apurado_em < $8)
       RETURNING (xmax = 0) AS nova`,
      [c.anuncianteId, janela.mesReferencia, c.obrigacao, c.entregue, c.saldo, c.duracao, agora, janela.finalEm],
    );
    if (gravada[0]?.nova) resultado.novasLinhas += 1;
    else if (gravada[0]) resultado.linhasRecompostas += 1;
  }
  return resultado;
}

// Recompõe o mês anterior enquanto ainda chegam comprovantes dele — chamada
// todo dia pelo job Conciliacao (scripts/conciliar.js), a MESMA apuração do
// job ApuracaoBancoHoras (idempotente). Fora da janela (mês já definitivo e
// apurado depois disso), não faz nada.
async function recomporMesAnteriorEmPrazo({ agora = new Date(), apenasContas = null } = {}) {
  const janela = await janelaDoMes(null, agora);
  const aberto = new Date(agora).getTime() < janela.finalEm.getTime() + 2 * 24 * HORA;
  if (!aberto) return null;
  return apurarMes({ agora, apenasContas });
}

// Abate do saldo o tempo do banco que a TV CONFIRMOU, hora a hora, uma vez
// por hora já fechada (passado o prazo do comprovante). A confirmada conta
// primeiro pra entrega normal da hora e só o que passar dela é do banco — na
// dúvida sobre qual exibição falhou, a dívida fica (o erro vai a favor do
// anunciante). Banco programado e não confirmado não abate nada: volta a
// ficar disponível pra próxima hora com espaço. Em SEGUNDOS: cada exibição
// vale a duração da hora em que tocou.
//
// Uma transação por conta: marca as horas como liquidadas e abate o saldo
// juntas — duas execuções ao mesmo tempo nunca abatem a mesma hora (o UPDATE
// com `banco_liquidado_em IS NULL` trava e reavalia a linha).
const ENTREGUE_DO_BANCO = `LEAST(GREATEST(vezes_confirmadas - (vezes_programadas - vezes_banco), 0), vezes_banco)`;

async function liquidarBancoConfirmado({ apenasContas = null, simular = false, agora = new Date() } = {}) {
  const corte = new Date(new Date(agora).getTime() - MINUTOS_ATE_A_HORA_FECHAR * 60_000);
  const { rows: contas } = await pool.query(
    `SELECT anunciante_id, COUNT(*)::int AS linhas,
            SUM(${ENTREGUE_DO_BANCO})::int AS exibicoes,
            SUM(${ENTREGUE_DO_BANCO} * COALESCE(duracao_segundos, $3))::bigint AS segundos
       FROM exibicoes_contador
      WHERE vezes_banco > 0 AND banco_liquidado_em IS NULL
        AND janela_hora < $1
        AND ($2::int[] IS NULL OR anunciante_id = ANY($2))
      GROUP BY anunciante_id`,
    [corte, apenasContas, DURACAO_PADRAO],
  );
  const relato = { contas: contas.length, linhas: 0, exibicoesAbatidas: 0, segundosAbatidos: 0 };
  if (simular) {
    for (const c of contas) {
      relato.linhas += c.linhas;
      relato.exibicoesAbatidas += c.exibicoes;
      relato.segundosAbatidos += Number(c.segundos);
    }
    return relato;
  }
  for (const { anunciante_id: anuncianteId } of contas) {
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      const { rows } = await cliente.query(
        `UPDATE exibicoes_contador SET banco_liquidado_em = $3
          WHERE anunciante_id = $1 AND vezes_banco > 0 AND banco_liquidado_em IS NULL
            AND janela_hora < $2
          RETURNING ${ENTREGUE_DO_BANCO} AS exibicoes,
                    ${ENTREGUE_DO_BANCO} * COALESCE(duracao_segundos, $4) AS segundos`,
        [anuncianteId, corte, agora, DURACAO_PADRAO],
      );
      const segundos = rows.reduce((soma, r) => soma + Number(r.segundos), 0);
      const abatidos = await bancoHorasRepo.drenar(anuncianteId, segundos, cliente);
      await cliente.query('COMMIT');
      relato.linhas += rows.length;
      relato.exibicoesAbatidas += rows.reduce((soma, r) => soma + Number(r.exibicoes), 0);
      relato.segundosAbatidos += abatidos;
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
         (comecou_em, mes_apurado, anunciantes_com_deficit, linhas_novas, linhas_liquidadas, exibicoes_abatidas,
          segundos_devidos, segundos_abatidos, horas_sem_pedido, linhas_recompostas, abortou)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        comecouEm,
        apuracao.mesApurado || null,
        apuracao.anunciantesComDeficit || 0,
        apuracao.novasLinhas || 0,
        liquidacao.linhas || 0,
        liquidacao.exibicoesAbatidas || 0,
        apuracao.segundosDevidos || 0,
        liquidacao.segundosAbatidos || 0,
        apuracao.horasSemPedido || 0,
        apuracao.linhasRecompostas || 0,
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
  recomporMesAnteriorEmPrazo,
  liquidarBancoConfirmado,
  registrarExecucao,
  janelaDoMes,
  MINUTOS_ATE_A_HORA_FECHAR,
};
