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
async function resolver(dispositivoId, horaAtual, baseProposta, calcularExtras) {
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

    // `criadaAgora`: esta é a PRIMEIRA geração da hora — quem drena o banco
    // de horas (src/playlist/gerador.js) só o faz nessa passada; as outras
    // gerações da mesma hora reprocessam a mesma base e não drenam de novo.
    let criadaAgora = false;
    if (!rows[0]) {
      const criada = await client.query(
        `INSERT INTO playlist_hora_congelada (dispositivo_id, janela_hora, base, extras)
         VALUES ($1, $2, $3::jsonb, '[]'::jsonb)
         RETURNING base, extras`,
        [dispositivoId, horaAtual, JSON.stringify(baseProposta)],
      );
      rows = criada.rows;
      criadaAgora = true;
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
    return { ...rows[0], criadaAgora };
  } catch (erro) {
    await client.query('ROLLBACK');
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = { resolver };
