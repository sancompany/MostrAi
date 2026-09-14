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

// Disparado quando o admin aprova o criativo. Era o buraco mais sentido do
// fluxo: a pessoa pagava, subia o vídeo e ficava sem saber quando entrou no
// ar — a plataforma decidia sozinha e não contava. Todo self-service de mídia
// avisa nessa hora; é a confirmação de que o dinheiro virou entrega.
async function enviarCriativoNoAr(anunciante, criativo) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Seu anúncio está no ar — Mostraí',
    text: [
      `Olá, ${anunciante.nome_empresa}!`,
      '',
      'Seu vídeo foi aprovado e já entrou na playlist das telas da rede.',
      criativo && criativo.duracao_segundos ? `Duração do vídeo: ${criativo.duracao_segundos} segundos.` : '',
      '',
      'Você acompanha quantas vezes ele apareceu, e em quais pontos, na aba',
      `Anúncios do seu painel: ${process.env.SITE_URL}/anunciante/painel.html`,
      '',
      'Qualquer dúvida, é só responder este e-mail.',
      'Mostraí',
    ].filter(Boolean).join('\n'),
  });
}

// Mensagem que NÃO é operacional — novidade, oferta, convite a um recurso
// novo. Diferente das de cima, esta depende de consentimento, e consentimento
// se revoga a qualquer tempo (LGPD art. 8 §5): quem revogou não recebe, e a
// checagem mora aqui e não em quem chama, senão o primeiro esquecimento vira
// o primeiro e-mail indevido. Hoje nada usa esta função — ela existe pra que
// a primeira divulgação nasça tendo de passar por ela.
async function enviarNovidade(anunciante, { assunto, texto }) {
  if (anunciante.comunicacoes_revogado_em) return { enviado: false, motivo: 'consentimento revogado' };
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: assunto,
    text: `${texto}\n\nVocê recebe este aviso porque aceitou receber novidades da Mostraí. `
      + `Pra parar, abra seu perfil no painel e desmarque "receber novidades".`,
  });
  return { enviado: true };
}

// Confirmação de que o pedido de arrependimento entrou (CDC art. 49). Sai pro
// titular e pra caixa da Mostraí: o estorno é executado por uma pessoa no
// painel do Checkout, e sem aviso ninguém fica sabendo que há um a pagar.
async function enviarArrependimentoRecebido(anunciante, pedido) {
  const valor = `R$ ${Number(pedido.valor_a_estornar).toFixed(2)}`;
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    cc: process.env.MOSTRAI_EMAIL_CONTATO || remetente(),
    subject: 'Desistência registrada — Mostraí',
    text: `Olá, ${anunciante.nome_empresa}!\n\n`
      + `Registramos sua desistência da contratação dentro do prazo de 7 dias. `
      + `A cobrança recorrente foi cancelada e seu anúncio saiu do ar.\n\n`
      + `Valor a devolver: ${valor}. A devolução é feita pelo mesmo meio do pagamento `
      + `e pode levar alguns dias úteis pra aparecer no seu extrato.\n\n`
      + `Protocolo: ${pedido.id}.\n\nEquipe Mostraí.`,
  });
}

module.exports = {
  enviarCriativoNoAr, enviarConfirmacaoPagamento, enviarLinkRedefinicaoSenha,
  enviarMensagemContato, enviarNovidade, enviarArrependimentoRecebido };
