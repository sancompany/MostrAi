const pool = require('../db/pool');

// Ver migration 064 pro porquê: a hora, uma vez montada, fica congelada —
// quem chega depois entra em `extras`, sempre no fim, sem mexer em quem já
// tinha vaga.

async function buscar(dispositivoId, horaAtual) {
  const { rows } = await pool.query(
    `SELECT base, extras FROM playlist_hora_congelada WHERE dispositivo_id = $1 AND janela_hora = $2`,
    [dispositivoId, horaAtual],
  );
  return rows[0] || null;
}

// ON CONFLICT DO NOTHING: duas requisições concorrentes na primeira hora da
// tela (dois polls quase simultâneos, sem linha ainda) podem chegar aqui
// juntas — a primeira que gravar vence, e é a leitura seguinte que passa a
// enxergar a congelada, não uma condição de corrida no INSERT.
async function criar(dispositivoId, horaAtual, base) {
  await pool.query(
    `INSERT INTO playlist_hora_congelada (dispositivo_id, janela_hora, base, extras)
     VALUES ($1, $2, $3::jsonb, '[]'::jsonb)
     ON CONFLICT (dispositivo_id, janela_hora) DO NOTHING`,
    [dispositivoId, horaAtual, JSON.stringify(base)],
  );
}

async function acrescentarExtras(dispositivoId, horaAtual, novosIds) {
  await pool.query(
    `UPDATE playlist_hora_congelada SET extras = extras || $3::jsonb
     WHERE dispositivo_id = $1 AND janela_hora = $2`,
    [dispositivoId, horaAtual, JSON.stringify(novosIds)],
  );
}

module.exports = { buscar, criar, acrescentarExtras };
