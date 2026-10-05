// AGENDA ÚNICA DO PONTO MÓVEL (migrations 113 e 114). Um móvel está num
// lugar só: hospedagem e evento ocupam a MESMA agenda — hospedagem ×
// hospedagem, hospedagem × evento e evento × evento nunca se sobrepõem.
// Ocupam: hospedagem programada/ativa e evento programado/em andamento. O
// período é [inicio, fim), com data E hora (migration 114): uma alocação que
// termina às 18:00 e outra que começa às 18:00 no mesmo dia não colidem.
//
// A regra mora no banco (gatilho `movel_agenda_verificar`, que trava a linha
// do ponto — duas requisições ao mesmo tempo não passam juntas). Esta é a
// MESMA pergunta feita antes, dentro da transação que já travou o ponto, só
// para responder com o motivo ("já está hospedado na Tabacaria X de 03/10
// 08:00 a 05/10 18:00") em vez do erro genérico do gatilho.

const { FUSO } = require('../lib/fuso-comercial');

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

// `ignorar`: { tipo: 'hospedagem' | 'evento', id } — a própria linha, numa
// prorrogação. `emCurso`: a linha vai ficar em andamento (iniciar) — aí
// também conflita com qualquer outro compromisso em andamento, mesmo fora
// do período (o evento que começou antes da hora).
async function conflito(c, pontoId, inicio, fim, { ignorar = null, emCurso = false } = {}) {
  const { rows } = await c.query(
    `SELECT 'hospedagem' AS tipo, h.id, h.local AS nome, h.inicio, h.fim, h.estado
       FROM pontos_moveis_hospedagens h
      WHERE h.ponto_id = $1 AND h.estado IN ('programada', 'ativa')
        AND NOT ($4 = 'hospedagem' AND h.id = $5)
        AND (tstzrange(h.inicio, h.fim, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
             OR ($6 AND h.estado = 'ativa'))
     UNION ALL
     SELECT 'evento', e.id, e.nome, e.inicio, e.fim, e.estado
       FROM pontos_moveis_eventos e
      WHERE e.ponto_id = $1 AND e.estado IN ('programado', 'em_andamento')
        AND NOT ($4 = 'evento' AND e.id = $5)
        AND (tstzrange(e.inicio, e.fim, '[)') && tstzrange($2::timestamptz, $3::timestamptz, '[)')
             OR ($6 AND e.estado = 'em_andamento'))
      ORDER BY inicio
      LIMIT 1`,
    [pontoId, new Date(inicio), new Date(fim), ignorar?.tipo || '', ignorar?.id || 0, emCurso],
  );
  return rows[0] || null;
}

function descrever(c) {
  const oQue = c.tipo === 'hospedagem' ? `hospedado em “${c.nome}”` : `no evento “${c.nome}”`;
  const quando = c.estado === 'ativa' || c.estado === 'em_andamento' ? 'agora' : 'nesse período';
  return `O ponto móvel já está ${oQue} ${quando} (${brInstante(c.inicio)} a ${brInstante(c.fim)})`;
}

// A pergunta central: o móvel está livre? Lança 409 com o motivo.
async function exigirLivre(c, pontoId, inicio, fim, opcoes) {
  const ocupado = await conflito(c, pontoId, inicio, fim, opcoes);
  if (ocupado) throw erro(409, descrever(ocupado), 'inicio');
}

// O gatilho do banco é a última linha de defesa (corrida que escapou da
// pergunta acima): vira o mesmo 409, sem 500.
function traduzirErroDoBanco(err) {
  if (err?.code === '23P01') return erro(409, 'A agenda do ponto móvel já está ocupada nesse período');
  return err;
}

module.exports = { conflito, exigirLivre, traduzirErroDoBanco, brInstante };
