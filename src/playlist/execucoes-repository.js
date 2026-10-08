const pool = require('../db/pool');
const sse = require('../lib/sse');
const { confirmarExecucao } = require('./gerador');

// Deduplicação do proof-of-play em lote (contrato novo, migration 065). Ver
// `docs/PENDENCIAS.md` seção H pro porquê deste ledger existir separado de
// `exibicoes_contador` (que é agregado por hora, não por execução).
//
// Reserva o `execucaoId` e credita NA MESMA TRANSAÇÃO — reservar primeiro e
// creditar depois deixaria uma janela onde um crash no meio grava "já visto"
// sem ter creditado nada, e a retentativa (que é o próprio motivo do
// `execucaoId` existir) nunca mais credita essa exibição de verdade.
// `ON CONFLICT DO NOTHING` na reserva é a trava: duas chamadas com o mesmo
// `execucaoId` (retentativa do aparelho depois de resposta perdida) só a
// primeira reserva — a segunda vê a linha já lá e devolve `duplicado` sem
// tocar em `exibicoes_contador` de novo.
//
// Sempre devolve `{execucaoId, status}` com um dos 6 status do contrato
// (docs/player-mvp-contract.md §8) — quem chama (src/player/routes.js) já
// validou a forma do evento. Um `execucaoId` repetido, venha da mesma TV ou
// de outra, é `duplicado`: nada conta duas vezes.
// `horario`: o horário em vigor na tela agora (o do ponto, ou o do compromisso
// da tela móvel) — o POP de um minuto fechado não credita (gerador.js
// #confirmarExecucao). Vale só para hora congelada sem horário gravado
// (anterior à migration 119); com ele, decide o gravado. `undefined` = sem
// horário conhecido: credita como sempre.
async function confirmarComDedup(dispositivoId, evento, agora, { horario } = {}) {
  const { execucaoId, itemProgramacaoId, janelaId } = evento;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const reserva = await client.query(
      `INSERT INTO execucoes_confirmadas (execucao_id, dispositivo_id, status)
       VALUES ($1, $2, 'pendente') ON CONFLICT (execucao_id) DO NOTHING
       RETURNING execucao_id`,
      [execucaoId, dispositivoId],
    );
    if (!reserva.rows[0]) {
      await client.query('COMMIT');
      return { execucaoId, status: 'duplicado' };
    }

    const entradas = [];
    const extra = { criativoId: evento.criativoId, iniciadoEm: evento.iniciadoEm, entradas, horario };
    const status = await confirmarExecucao(dispositivoId, itemProgramacaoId, janelaId, agora, client, extra);
    // Rede móvel (migrations 112 e 115): a exibição contabilizada guarda em
    // qual evento aconteceu — o evento DESTA TELA em andamento no instante
    // dela (pelos horários em que o Admin marcou início e fim). Só contexto
    // de auditoria: sem evento (ponto fixo, tela fora de evento) fica NULL,
    // e a regra de contabilização não muda.
    await client.query(
      `UPDATE execucoes_confirmadas
          SET status = $2,
              evento_id = CASE WHEN $2 = 'contabilizado' AND $3::timestamptz IS NOT NULL THEN (
                SELECT ev.id FROM pontos_moveis_eventos ev
                  JOIN pontos_moveis_evento_telas et ON et.evento_id = ev.id
                 WHERE et.dispositivo_id = execucoes_confirmadas.dispositivo_id
                   AND ev.iniciado_em <= $3::timestamptz
                   AND (ev.encerrado_em IS NULL OR ev.encerrado_em > $3::timestamptz)
                 ORDER BY ev.iniciado_em DESC LIMIT 1) END
        WHERE execucao_id = $1`,
      [execucaoId, status, extra.instante ?? null],
    );
    await client.query('COMMIT');
    // Peça que acabou de entrar no ar (primeiro comprovante do contexto):
    // o painel do cliente e o admin trocam "Aguardando" por "No ar" sem
    // recarregar. Depois do COMMIT — antes, quem relesse ainda veria o
    // estado velho. Só na transição: um aviso por peça, não por exibição.
    for (const e of entradas) {
      sse.emitirParaConta(e.anuncianteId, 'creative.updated', { id: e.criativoId, noAr: true });
      sse.emitirParaAdmin('creative.updated', { id: e.criativoId, noAr: true });
    }
    return { execucaoId, status };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = { confirmarComDedup };
