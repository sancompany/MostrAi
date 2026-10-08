const pool = require('../db/pool');

// Ver migration 064 pro porquê: a hora, uma vez montada, fica congelada —
// quem chega depois entra em `extras`, sempre no fim, sem mexer em quem já
// tinha vaga.

// Resolve criação e extras na mesma seção crítica. O advisory lock é por
// (tela, hora): não bloqueia outras telas nem outras horas e funciona entre
// processos/instâncias porque vive no Postgres. Assim, a primeira base que
// entrar é a única base da hora; uma requisição concorrente relê essa base e
// transforma apenas os seus participantes ainda desconhecidos em extras.
//
// `calcularExtras` é síncrona e não toca o banco. Ela fica aqui dentro da
// transação para decidir a nova leva usando exatamente o estado protegido
// pelo lock. Repetições dentro da leva são intencionais (frequência); o que
// não pode acontecer é duas requisições anexarem a mesma leva.
//
// `horario`: o horário em vigor na tela quando a hora nasce (migration 119)
// — gravado só pela primeira geração, como a base; é por ele que o POP
// daquela hora é julgado (gerador.js#confirmarExecucao). `undefined` = não
// informado (linha sem registro).
async function resolver(dispositivoId, horaAtual, baseProposta, calcularExtras, horario) {
  const client = await pool.connect();
  const horaEpoch = Math.floor(new Date(horaAtual).getTime() / 3_600_000);

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [dispositivoId, horaEpoch]);

    let { rows } = await client.query(
      `SELECT base, extras FROM playlist_hora_congelada
       WHERE dispositivo_id = $1 AND janela_hora = $2
       FOR UPDATE`,
      [dispositivoId, horaAtual],
    );

    if (!rows[0]) {
      const criada = await client.query(
        `INSERT INTO playlist_hora_congelada (dispositivo_id, janela_hora, base, extras, horario_semanal, horario_registrado)
         VALUES ($1, $2, $3::jsonb, '[]'::jsonb, $4::jsonb, $5)
         RETURNING base, extras`,
        [
          dispositivoId,
          horaAtual,
          JSON.stringify(baseProposta),
          horario == null ? null : JSON.stringify(horario),
          horario !== undefined,
        ],
      );
      rows = criada.rows;
    }

    const congelada = rows[0];
    const novaLeva = calcularExtras(congelada.base, congelada.extras);
    if (novaLeva.length) {
      const atualizada = await client.query(
        `UPDATE playlist_hora_congelada SET extras = extras || $3::jsonb
         WHERE dispositivo_id = $1 AND janela_hora = $2
         RETURNING base, extras`,
        [dispositivoId, horaAtual, JSON.stringify(novaLeva)],
      );
      rows = atualizada.rows;
    }

    await client.query('COMMIT');
    return rows[0];
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = { resolver };
