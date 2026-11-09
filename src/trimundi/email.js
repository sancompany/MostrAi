const fs = require('node:fs/promises');
const config = require('./config');
const { consultar } = require('./db/conexao');

// Fila de e-mail da Trimundi, desacoplada do provedor (o SMTP da Mostraí, ou
// um próprio via TRIMUNDI_SMTP_*). Sem provedor, a mensagem fica
// 'aguardando_provedor': guardada, nunca dada como enviada.
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

// Versão HTML do e-mail (o texto continua indo junto): a logo e o nome da
// Trimundi no corpo, o resto é o mesmo texto, com os endereços clicáveis. O
// remetente é o da Mostraí (decisão do dono, 09/11/2026); o corpo é só
// Trimundi. A logo vem do próprio site (URL absoluta).
const esc = (t) =>
  String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function html(texto) {
  const logo = `${config.urlDoSite()}/ticket/img/trimundi-logo-256.png`;
  const corpo = String(texto)
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p style="margin:0 0 16px">${esc(p)
          .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#2a313c">$1</a>')
          .replace(/\n/g, '<br>')}</p>`,
    )
    .join('');
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#0d0f13">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:14px;padding:28px">
<tr><td align="center" style="padding-bottom:20px"><img src="${esc(logo)}" width="96" height="96" alt="Trimundi" style="display:block;border:0;background:#0a0b0e;border-radius:50%">
<div style="margin-top:10px;font-weight:700;letter-spacing:4px;font-size:13px">TRIMUNDI</div></td></tr>
<tr><td style="font-size:15px;line-height:1.5">${corpo}</td></tr>
</table></td></tr></table></body></html>`;
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
          `${JSON.stringify({ para: m.para, assunto: m.assunto, texto: m.texto, html: html(m.texto), tipo: m.tipo })}\n`,
        );
      } else {
        await obterTransporte(c).sendMail({
          from: c.remetente,
          to: m.para,
          subject: m.assunto,
          text: m.texto,
          html: html(m.texto),
        });
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

module.exports = { enfileirar, processar, html };
