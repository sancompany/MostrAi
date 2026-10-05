// AGENDA POR TELA DA REDE MÓVEL (migration 115). A rede móvel de uma cidade
// tem várias telas físicas; cada tela está num lugar só de cada vez. Duas
// telas da MESMA rede podem estar em compromissos simultâneos (uma num
// evento, outra hospedada num comércio); a MESMA tela nunca: hospedagem ×
// hospedagem, hospedagem × evento e evento × evento dela não se sobrepõem.
// Ocupam: hospedagem programada/ativa (uma tela) e evento programado/em
// andamento (cada tela participante). O período é [inicio, fim), com data E
// hora: uma alocação que termina às 18:00 e outra que começa às 18:00 não
// colidem.
//
// A regra mora no banco (gatilhos da 115, com trava por tela). Esta é a
// MESMA pergunta feita antes, dentro da transação, só para responder com o
// motivo ("A tela M-0010 já está hospedada na Tabacaria X de 03/10 08:00 a
// 05/10 18:00") em vez do erro genérico do gatilho.

const { FUSO } = require('../lib/fuso-comercial');
const { formatarCodigoTela } = require('../lib/codigo-tela');

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

const formatoBr = new Intl.DateTimeFormat('pt-BR', {
  timeZone: FUSO,
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
// "03/10 08:00" no relógio de Matão.
const brInstante = (d) => formatoBr.format(new Date(d)).replace(',', '');

// O primeiro compromisso de cada tela de `telas` que cruza [inicio, fim).
// `ignorar`: { tipo: 'hospedagem' | 'evento', id } — a própria linha, numa
// prorrogação. `emCurso`: a linha vai ficar em andamento (iniciar) — aí
// também conflita com qualquer outro compromisso em andamento da tela,
// mesmo fora do período.
async function conflitos(c, telas, inicio, fim, { ignorar = null, emCurso = false } = {}) {
  const ids = [...new Set((telas || []).map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return [];
  const { rows } = await c.query(
    `SELECT DISTINCT ON (x.dispositivo_id) x.*
       FROM (
         SELECT h.dispositivo_id, 'hospedagem' AS tipo, h.id, h.local AS nome, h.inicio, h.fim, h.estado
           FROM pontos_moveis_hospedagens h
          WHERE h.dispositivo_id = ANY($1::int[]) AND h.estado IN ('programada', 'ativa')
            AND NOT ($4 = 'hospedagem' AND h.id = $5)
            AND (tstzrange(h.inicio, h.fim, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
                 OR ($6 AND h.estado = 'ativa'))
         UNION ALL
         SELECT et.dispositivo_id, 'evento', e.id, e.nome, e.inicio, e.fim, e.estado
           FROM pontos_moveis_evento_telas et JOIN pontos_moveis_eventos e ON e.id = et.evento_id
          WHERE et.dispositivo_id = ANY($1::int[]) AND e.estado IN ('programado', 'em_andamento')
            AND NOT ($4 = 'evento' AND e.id = $5)
            AND (tstzrange(e.inicio, e.fim, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
                 OR ($6 AND e.estado = 'em_andamento'))
       ) x
      ORDER BY x.dispositivo_id, x.inicio`,
    [ids, new Date(inicio), new Date(fim), ignorar?.tipo || '', ignorar?.id || 0, emCurso],
  );
  return rows;
}

function descrever(c) {
  const tela = formatarCodigoTela(c.dispositivo_id);
  const oQue = c.tipo === 'hospedagem' ? `hospedada em “${c.nome}”` : `no evento “${c.nome}”`;
  const quando = c.estado === 'ativa' || c.estado === 'em_andamento' ? 'agora' : 'nesse período';
  return `A tela ${tela} já está ${oQue} ${quando} (${brInstante(c.inicio)} a ${brInstante(c.fim)})`;
}

// A pergunta central: as telas estão livres? Lança 409 com o motivo da
// primeira ocupada.
async function exigirLivres(c, telas, inicio, fim, opcoes) {
  const [ocupada] = await conflitos(c, telas, inicio, fim, opcoes);
  if (ocupada) throw erro(409, descrever(ocupada), 'telas');
}

// O gatilho do banco é a última linha de defesa (corrida que escapou da
// pergunta acima): vira o mesmo 409, sem 500. Tela de outra rede vira 400.
function traduzirErroDoBanco(err) {
  if (err?.code === '23P01') return erro(409, 'A agenda dessa tela já está ocupada nesse período', 'telas');
  if (err?.code === '23514' && /não é da rede móvel/.test(err.message || '')) {
    return erro(400, 'Essa tela não é desta rede móvel', 'telas');
  }
  return err;
}

module.exports = { conflitos, exigirLivres, traduzirErroDoBanco, brInstante, descrever };
