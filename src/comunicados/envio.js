const pool = require('../db/pool');
const email = require('../financeiro/email');
const publicos = require('./publicos');
const conteudo = require('./conteudo');

// O modelo 'comunicado' da fila de e-mails (src/email/outbox.js, MODELOS):
// cada linha da fila é UM destinatário de um comunicado. Não requer a
// outbox (ela é que requer este arquivo) — sem ciclo.

// Monta e manda. Antes, confere se a conta AINDA recebe: entre o clique do
// admin e a vez desta linha (o ritmo espalha o envio; uma nova tentativa
// pode vir horas depois) a conta pode ter sido excluída ou suspensa, ter
// desmarcado "receber novidades" ou trocado o e-mail de login. Aí a linha é
// descartada — nunca enviada, e não conta como falha.
async function enviar(l) {
  if (!(await publicos.contaAindaRecebe(l.anunciante_id, l.destinatario))) {
    return {
      descartar:
        'a conta deixou de receber comunicados antes da vez dela (excluída, suspensa, pediu pra não receber ou trocou de e-mail)',
    };
  }
  const { rows } = await pool.query(
    'SELECT assunto, titulo, mensagem, botao_texto, botao_url FROM comunicados WHERE id = $1',
    [l.dados.comunicadoId],
  );
  if (!rows[0]) return { descartar: 'o comunicado não existe mais' };
  await email.enviarComunicado(l.destinatario, conteudo.montar(conteudo.deLinha(rows[0])));
}

// Resultado por destinatário (a fila expurga as linhas dela; este registro
// fica). A condição em `email_outbox_id` faz a linha de uma rodada antiga
// nunca sobrescrever a rodada atual de um reenvio.
function marcarEnviado(l) {
  return pool.query(
    `UPDATE comunicados_destinatarios
        SET situacao = 'enviado', enviado_em = now(), ultimo_erro = NULL, atualizado_em = now()
      WHERE comunicado_id = $1 AND anunciante_id = $2 AND email_outbox_id = $3`,
    [l.dados.comunicadoId, l.anunciante_id, l.id],
  );
}

// A fila desistiu desta linha: 'abandonado' (o provedor recusou todas as
// tentativas) vira falha — é o que "Reenviar falhas" pega; 'descartado'
// (a conta saiu do público) não é falha e não volta.
function marcarDesistencia(l, status, motivo) {
  return pool.query(
    `UPDATE comunicados_destinatarios
        SET situacao = $4, ultimo_erro = $5, atualizado_em = now()
      WHERE comunicado_id = $1 AND anunciante_id = $2 AND email_outbox_id = $3 AND situacao = 'na_fila'`,
    [l.dados.comunicadoId, l.anunciante_id, l.id, status === 'descartado' ? 'descartado' : 'falhou', motivo],
  );
}

// Antes de a fila expurgar as linhas dela (30 dias depois de enviada, 90 de
// abandonada/descartada — src/email/outbox.js#expurgar), o resultado final
// de cada uma vai pro registro do destinatário que ainda diz "na_fila" —
// é o caso em que o gancho da fila falhou (queda do banco no meio, processo
// morto entre marcar a fila e o registro). Sem isso, a linha expurgada
// deixaria o registro sem resultado e o histórico ficaria errado.
async function consolidar(db = pool) {
  const { rowCount } = await db.query(
    `UPDATE comunicados_destinatarios d
        SET situacao = CASE o.status WHEN 'enviado' THEN 'enviado' WHEN 'descartado' THEN 'descartado' ELSE 'falhou' END,
            enviado_em = CASE WHEN o.status = 'enviado' THEN o.enviado_em ELSE d.enviado_em END,
            ultimo_erro = CASE WHEN o.status = 'enviado' THEN NULL ELSE o.ultimo_erro END,
            atualizado_em = now()
       FROM email_outbox o
      WHERE o.id = d.email_outbox_id
        AND d.situacao = 'na_fila'
        AND o.tipo = 'comunicado'
        AND o.status IN ('enviado', 'abandonado', 'descartado')`,
  );
  return rowCount;
}

module.exports = { enviar, marcarEnviado, marcarDesistencia, consolidar };
