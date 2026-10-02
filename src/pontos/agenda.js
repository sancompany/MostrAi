// AGENDA ÚNICA DO PONTO MÓVEL (migration 113). Um móvel está num lugar só:
// hospedagem e evento ocupam a MESMA agenda (datas inclusivas). Ocupam:
// hospedagem programada/ativa e evento programado/em andamento.
//
// A regra mora no banco (gatilho `movel_agenda_verificar`, que trava a linha
// do ponto — duas requisições ao mesmo tempo não passam juntas). Esta é a
// MESMA pergunta feita antes, dentro da transação que já travou o ponto, só
// para responder com o motivo ("já está hospedado na Tabacaria X de 03/10 a
// 05/10") em vez do erro genérico do gatilho.

const erro = (status, mensagem, campo) => Object.assign(new Error(mensagem), { status, ...(campo ? { campo } : {}) });

const brData = (d) => {
  const s = typeof d === 'string' ? d : new Date(d).toISOString().slice(0, 10);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}`;
};

// `ignorar`: { tipo: 'hospedagem' | 'evento', id } — a própria linha, numa
// prorrogação. `emCurso`: a linha vai ficar em andamento (iniciar) — aí
// também conflita com qualquer outro compromisso em andamento, mesmo fora
// das datas (o evento que começou na véspera).
async function conflito(c, pontoId, inicio, fim, { ignorar = null, emCurso = false } = {}) {
  const { rows } = await c.query(
    `SELECT 'hospedagem' AS tipo, h.id, h.local AS nome, h.data_inicio, h.data_fim, h.estado
       FROM pontos_moveis_hospedagens h
      WHERE h.ponto_id = $1 AND h.estado IN ('programada', 'ativa')
        AND NOT ($4 = 'hospedagem' AND h.id = $5)
        AND (daterange(h.data_inicio, h.data_fim, '[]') && daterange($2::date, $3::date, '[]')
             OR ($6 AND h.estado = 'ativa'))
     UNION ALL
     SELECT 'evento', e.id, e.nome, e.data_inicio, e.data_fim, e.estado
       FROM pontos_moveis_eventos e
      WHERE e.ponto_id = $1 AND e.estado IN ('programado', 'em_andamento')
        AND NOT ($4 = 'evento' AND e.id = $5)
        AND (daterange(e.data_inicio, e.data_fim, '[]') && daterange($2::date, $3::date, '[]')
             OR ($6 AND e.estado = 'em_andamento'))
      ORDER BY data_inicio
      LIMIT 1`,
    [pontoId, inicio, fim, ignorar?.tipo || '', ignorar?.id || 0, emCurso],
  );
  return rows[0] || null;
}

function descrever(c) {
  const oQue = c.tipo === 'hospedagem' ? `hospedado em “${c.nome}”` : `no evento “${c.nome}”`;
  const quando = c.estado === 'ativa' || c.estado === 'em_andamento' ? 'agora' : 'nesse período';
  return `O ponto móvel já está ${oQue} ${quando} (${brData(c.data_inicio)} a ${brData(c.data_fim)})`;
}

// A pergunta central: o móvel está livre? Lança 409 com o motivo.
async function exigirLivre(c, pontoId, inicio, fim, opcoes) {
  const ocupado = await conflito(c, pontoId, inicio, fim, opcoes);
  if (ocupado) throw erro(409, descrever(ocupado), 'data_inicio');
}

// O gatilho do banco é a última linha de defesa (corrida que escapou da
// pergunta acima): vira o mesmo 409, sem 500.
function traduzirErroDoBanco(err) {
  if (err?.code === '23P01') return erro(409, 'A agenda do ponto móvel já está ocupada nesse período');
  return err;
}

module.exports = { conflito, exigirLivre, traduzirErroDoBanco, brData };
