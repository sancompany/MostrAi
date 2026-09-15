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
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Seu pagamento do plano ${plano.nome} (${CICLO_TEXTO[plano.compromisso_meses] || `${plano.compromisso_meses} meses`}) foi confirmado — ` +
      `valor cobrado: R$ ${Number(valorCobrado).toFixed(2)}.\n\n` +
      `AGORA FALTA UMA COISA: subir o seu anúncio.\n` +
      `Abra o painel e envie um vídeo ou imagem de 15 a 30 segundos, em pé (9:16). ` +
      `A gente ajusta o formato pra caber na tela. Depois da aprovação ele entra no ar.\n\n` +
      `${process.env.SITE_URL}/anunciante/painel.html\n\n` +
      `Não tem a arte pronta? Responda este e-mail ou chame no WhatsApp — a peça simples está incluída no seu plano.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Cartão recusado ou cobrança vencida (API.md do Checkout, 7.3 e o checklist
// de integração — item explícito: "ao receber cobranca_falhou, mandar o link
// de renovação"). Sem isso a cobertura simplesmente vence na próxima data de
// expiração e o anunciante nunca soube que devia trocar o cartão.
async function enviarCobrancaFalhou(anunciante, linkRenovar) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Não conseguimos cobrar sua renovação — Mostraí',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `A cobrança deste ciclo não passou — cartão vencido, sem limite ou recusado pelo banco.\n` +
      `Seu anúncio continua no ar até a cobertura atual acabar, mas a renovação automática não vai se repetir sozinha.\n\n` +
      `Pra resolver, atualize o cartão aqui:\n${linkRenovar}\n\n` +
      `A assinatura antiga só é cancelada quando a nova for confirmada — você não fica sem cobertura na troca.\n\n` +
      `Qualquer dúvida, responda este e-mail ou chame no WhatsApp.\n\n` +
      `Equipe Mostraí.`,
  });
}

// A conta nasce "pendente de aprovação" e o dono libera no admin — e ate agora
// isso nao avisava ninguem. A pessoa se cadastrava, via "aguardando aprovacao"
// e ia embora; quando era liberada, nada acontecia. O momento em que ela PODE
// comprar era justamente o unico que ninguem contava pra ela.
async function enviarContaAprovada(anunciante) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Sua conta foi aprovada — Mostraí',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Sua conta na Mostraí foi aprovada. Já dá pra escolher um plano e colocar seu anúncio na rotina da cidade.\n\n` +
      `${process.env.SITE_URL}/planos.html\n\n` +
      `Depois de contratar, é só subir um vídeo ou imagem de 15 a 30 segundos, em pé (9:16) — a gente ajusta o formato.\n\n` +
      `Equipe Mostraí.`,
  });
}

async function enviarLinkRedefinicaoSenha(email, nome, link) {
  await transportador().sendMail({
    from: remetente(),
    to: email,
    subject: 'Redefinir sua senha — Mostraí',
    text:
      `Olá, ${nome}!\n\n` +
      `Recebemos um pedido pra redefinir a senha da sua conta na Mostraí. ` +
      `Abra o link abaixo pra criar uma senha nova — ele vale por 1 hora:\n\n${link}\n\n` +
      `Se não foi você que pediu, é só ignorar este e-mail: sua senha continua a mesma.\n\nEquipe Mostraí.`,
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
async function enviarCriativoReprovado(anunciante, criativo) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Seu anúncio precisa de um ajuste — Mostraí',
    text: [
      `Olá, ${anunciante.nome_empresa}!`,
      '',
      'A peça que você enviou não passou na conferência e não entrou no ar.',
      criativo?.motivo_reprovacao ? `Motivo: ${criativo.motivo_reprovacao}` : '',
      '',
      'Dá pra resolver rápido: no seu painel, exclua a peça reprovada (ela libera',
      'a vaga do seu plano) e suba a versão corrigida. A gente confere de novo.',
      `${process.env.SITE_URL}/anunciante/painel.html`,
      '',
      'Se quiser ajuda pra ajustar, é só responder este e-mail.',
      'Mostraí',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function enviarCriativoNoAr(anunciante, criativo) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Seu anúncio está no ar — Mostraí',
    text: [
      `Olá, ${anunciante.nome_empresa}!`,
      '',
      'Seu vídeo foi aprovado e já entrou na playlist das telas da rede.',
      criativo?.duracao_segundos ? `Duração do vídeo: ${criativo.duracao_segundos} segundos.` : '',
      '',
      'Você acompanha quantas vezes ele apareceu, e em quais pontos, na aba',
      `Anúncios do seu painel: ${process.env.SITE_URL}/anunciante/painel.html`,
      '',
      'Qualquer dúvida, é só responder este e-mail.',
      'Mostraí',
    ]
      .filter(Boolean)
      .join('\n'),
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
    text:
      `${texto}\n\nVocê recebe este aviso porque aceitou receber novidades da Mostraí. ` +
      `Pra parar, abra seu perfil no painel e desmarque "receber novidades".`,
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
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Registramos sua desistência da contratação dentro do prazo de 7 dias. ` +
      `A cobrança recorrente foi cancelada e seu anúncio saiu do ar.\n\n` +
      `Valor a devolver: ${valor}. A devolução é feita pelo mesmo meio do pagamento ` +
      `e pode levar alguns dias úteis pra aparecer no seu extrato.\n\n` +
      `Protocolo: ${pedido.id}.\n\nEquipe Mostraí.`,
  });
}

// Candidatura nova (ponto ou vendedor) — vai pro DONO, não pro candidato.
// As páginas prometem contato em 2 dias úteis e nada avisava ninguém: a
// candidatura ficava esperando alguém abrir o admin e reparar na fila.
async function enviarCandidaturaNova(candidatura) {
  const tipo = candidatura.tipo === 'ponto' ? 'ponto (quer uma tela no comércio)' : 'vendedor parceiro';
  await transportador().sendMail({
    from: remetente(),
    to: process.env.MOSTRAI_EMAIL_CONTATO || remetente(),
    subject: `Candidatura nova de ${tipo} — Mostraí`,
    text: [
      `Tipo: ${tipo}`,
      `Nome: ${candidatura.nome}`,
      candidatura.nome_comercio ? `Comércio: ${candidatura.nome_comercio}` : '',
      `WhatsApp: ${candidatura.contato_telefone}`,
      candidatura.contato_email ? `E-mail: ${candidatura.contato_email}` : '',
      candidatura.endereco ? `Endereço: ${candidatura.endereco}` : '',
      candidatura.observacao ? `Observação: ${candidatura.observacao}` : '',
      '',
      'A página prometeu retorno em até 2 dias úteis.',
      `Fila: ${process.env.SITE_URL}/admin/#candidaturas`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

module.exports = {
  enviarCobrancaFalhou,
  enviarCandidaturaNova,
  enviarCriativoNoAr,
  enviarCriativoReprovado,
  enviarConfirmacaoPagamento,
  enviarLinkRedefinicaoSenha,
  enviarContaAprovada,
  enviarMensagemContato,
  enviarNovidade,
  enviarArrependimentoRecebido,
};
