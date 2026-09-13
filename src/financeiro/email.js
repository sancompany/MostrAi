const nodemailer = require('nodemailer');

function transportador() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function remetente() {
  return process.env.MOSTRAI_EMAIL_FROM || process.env.VITRINA_EMAIL_FROM;
}

const CICLO_TEXTO = { 1: 'mensal', 3: 'trimestral', 6: 'semestral', 12: 'anual' };

// Disparado pelo webhook de pagamento confirmado (INTEGRACAO.md 4.2) —
// fire-and-forget: se falhar, não trava a ativação (quem chama já faz .catch).
async function enviarConfirmacaoPagamento(anunciante, plano, valorCobrado) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Pagamento confirmado — Mostraí',
    text: `Olá, ${anunciante.nome_empresa}!\n\n`
      + `Seu pagamento do plano ${plano.nome} (${CICLO_TEXTO[plano.compromisso_meses] || `${plano.compromisso_meses} meses`}) foi confirmado — `
      + `valor cobrado: R$ ${Number(valorCobrado).toFixed(2)}.\n\n`
      + `Assim que o primeiro ponto da rede estiver no ar, seu anúncio começa a rodar automaticamente. `
      + `Você pode acompanhar tudo no seu painel.\n\nEquipe Mostraí.`,
  });
}

async function enviarLinkRedefinicaoSenha(email, nome, link) {
  await transportador().sendMail({
    from: remetente(),
    to: email,
    subject: 'Redefinir sua senha — Mostraí',
    text: `Olá, ${nome}!\n\n`
      + `Recebemos um pedido pra redefinir a senha da sua conta na Mostraí. `
      + `Abra o link abaixo pra criar uma senha nova — ele vale por 1 hora:\n\n${link}\n\n`
      + `Se não foi você que pediu, é só ignorar este e-mail: sua senha continua a mesma.\n\nEquipe Mostraí.`,
  });
}

// Formulário de contato do site — cai na caixa da própria Mostraí, com o
// e-mail de quem escreveu no reply-to pra responder direto.
async function enviarMensagemContato({ nome, email, telefone, mensagem }) {
  await transportador().sendMail({
    from: remetente(),
    to: process.env.MOSTRAI_EMAIL_CONTATO || remetente(),
    replyTo: email,
    subject: `Contato pelo site — ${nome}`,
    text: `Nome: ${nome}\nE-mail: ${email}\nTelefone: ${telefone || '-'}\n\n${mensagem}`,
  });
}

module.exports = { enviarConfirmacaoPagamento, enviarLinkRedefinicaoSenha, enviarMensagemContato };
