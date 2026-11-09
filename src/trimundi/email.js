const fs = require('node:fs/promises');
const config = require('./config');
const { consultar } = require('./db/conexao');

// Fila de e-mail da Trimundi, desacoplada do provedor. Sem provedor
// configurado (alias próprio da Trimundi ainda não existe — pendencias.md),
// a mensagem fica 'aguardando_provedor': guardada, nunca dada como enviada.
// Em desenvolvimento, TRIMUNDI_EMAIL_CAPTURA grava cada envio como linha
// JSON num arquivo, no lugar do SMTP.

async function enfileirar(cliente, { chave, tipo, para, assunto, texto }) {
  const status = config.email().configurado ? 'na_fila' : 'aguardando_provedor';
  await cliente.query(
    `INSERT INTO emails (chave, tipo, para, assunto, texto, status) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chave) DO NOTHING`,
    [chave, tipo, para, assunto, texto, status],
  );
}

let transporte = null;
function obterTransporte(c) {
  if (!transporte) {
    const nodemailer = require('nodemailer');
    transporte = nodemailer.createTransport({
      host: c.smtp.host,
      port: c.smtp.port,
      secure: c.smtp.port === 465,
      auth: { user: c.smtp.user, pass: c.smtp.pass },
    });
  }
  return transporte;
}

const ESPERA = [60, 300, 1800, 7200];

async function processar(limite = 10) {
  const c = config.email();
  if (!c.configurado) return 0;
  // Quem esperava provedor entra na fila quando ele passa a existir.
  await consultar("UPDATE emails SET status = 'na_fila' WHERE status = 'aguardando_provedor'");
  const { rows } = await consultar(
    `UPDATE emails SET tentativas = tentativas + 1, proxima_tentativa_em = now() + interval '5 minutes'
      WHERE id IN (SELECT id FROM emails WHERE status = 'na_fila' AND proxima_tentativa_em <= now()
                    ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
    [limite],
  );
  for (const m of rows) {
    try {
      if (c.captura) {
        await fs.appendFile(
          c.captura,
          `${JSON.stringify({ para: m.para, assunto: m.assunto, texto: m.texto, tipo: m.tipo })}\n`,
        );
      } else {
        await obterTransporte(c).sendMail({ from: c.remetente, to: m.para, subject: m.assunto, text: m.texto });
      }
      await consultar("UPDATE emails SET status = 'enviado', enviado_em = now(), ultimo_erro = NULL WHERE id = $1", [
        m.id,
      ]);
    } catch (err) {
      const espera = ESPERA[Math.min(m.tentativas - 1, ESPERA.length - 1)];
      const falhou = m.tentativas >= 6;
      await consultar(
        `UPDATE emails SET status = $2, ultimo_erro = $3, proxima_tentativa_em = now() + make_interval(secs => $4) WHERE id = $1`,
        [m.id, falhou ? 'falhou' : 'na_fila', String(err.message).slice(0, 500), espera],
      );
      // Sem o endereço no log (LGPD): só o id da mensagem.
      console.error(`trimundi: e-mail #${m.id} falhou (tentativa ${m.tentativas}):`, err.message);
    }
  }
  return rows.length;
}

module.exports = { enfileirar, processar };
