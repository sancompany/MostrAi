const nodemailer = require('nodemailer');
const { linhaEndereco } = require('../lib/endereco');

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
      `Abra o painel e envie um vídeo ou imagem em pé (9:16), na duração que o seu plano permite. ` +
      `A gente ajusta o formato pra caber na tela. Depois da aprovação ele entra no ar.\n\n` +
      `${process.env.SITE_URL}/anunciante/painel.html\n\n` +
      `Não tem a arte pronta? A gente faz pra você — é um serviço à parte do plano, com preço combinado na hora. Responda este e-mail ou chame no WhatsApp que a gente te passa um orçamento.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Cartão recusado ou cobrança vencida (API.md do Checkout, 7.3 e o checklist
// de integração — item explícito: "ao receber cobranca_falhou, mandar o link
// de renovação"). Sem isso a cobertura simplesmente vence na próxima data de
// expiração e o anunciante nunca soube que devia trocar o cartão.
async function enviarCobrancaFalhou(anunciante, linkRenovar) {
  const comoResolver = linkRenovar
    ? `Pra resolver, atualize o cartão aqui:\n${linkRenovar}\n\n` +
      `A assinatura antiga só é cancelada quando a nova for confirmada — você não fica sem cobertura na troca.\n\n`
    : `Pra resolver, responda este e-mail ou chame no WhatsApp que a gente atualiza o pagamento com você.\n\n`;
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Não conseguimos cobrar sua renovação — Mostraí',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `A cobrança deste ciclo não passou — cartão vencido, sem limite ou recusado pelo banco.\n` +
      `Seu anúncio continua no ar até a cobertura atual acabar, mas a renovação automática não vai se repetir sozinha.\n\n` +
      comoResolver +
      `Qualquer dúvida, responda este e-mail ou chame no WhatsApp.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Cobertura acabando sem recorrência pra renovar (seção F, item 16). Quem
// trocou de plano pagou um pedido avulso: vale pelo período contratado e
// acaba ali, sem próxima cobrança. Sem este aviso o anúncio sai do ar num
// dia qualquer e o cliente só descobre pelo silêncio — o mesmo buraco que
// `enviarCobrancaFalhou` tapa do lado da assinatura.
async function enviarCoberturaAcabando(anunciante, plano, diasRestantes) {
  const quando = diasRestantes <= 0 ? 'hoje' : diasRestantes === 1 ? 'amanhã' : `em ${diasRestantes} dias`;
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: `Sua cobertura na Mostraí acaba ${quando}`,
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `O período do seu plano ${plano.nome} (${CICLO_TEXTO[plano.compromisso_meses] || `${plano.compromisso_meses} meses`}) acaba ${quando}. ` +
      `Ele foi contratado como pagamento único, então não existe renovação automática: ` +
      `quando o prazo terminar, seu anúncio sai das telas.\n\n` +
      `Pra continuar no ar, escolha o plano e contrate de novo aqui:\n` +
      `${process.env.SITE_URL}/planos.html\n\n` +
      `Sua peça e seu histórico continuam na sua conta, então não precisa subir nada de novo.\n\n` +
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
      `Depois de contratar, é só subir um vídeo ou imagem em pé (9:16), na duração do seu plano — a gente ajusta o formato.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Boas-vindas no cadastro (pedido do dono, 18/09/2026) — o primeiro contato
// por e-mail depois de criar a conta, antes até de escolher plano (conta
// nova nunca nasce com plano — RN-34/RN-35, sem aprovação nem plano prévio).
async function enviarContaCriada(anunciante) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Sua conta na Mostraí foi criada',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Sua conta na Mostraí foi criada com sucesso. O próximo passo é escolher um plano ` +
      `e colocar seu anúncio na rotina da cidade.\n\n` +
      `${process.env.SITE_URL}/planos.html\n\n` +
      `Qualquer dúvida, responda este e-mail ou chame no WhatsApp.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Confirma a exclusão pedida pelo próprio anunciante (RN-24/26, direitos do
// titular). A cobrança recorrente já foi cancelada antes deste e-mail sair
// (é a mesma rota que faz as duas coisas) — dizer isso evita a pergunta
// "vou continuar sendo cobrado?" chegando pelo WhatsApp.
async function enviarContaExcluida(anunciante) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Sua conta na Mostraí foi excluída',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Sua conta na Mostraí foi excluída, a seu pedido. Se havia assinatura ativa, ` +
      `a cobrança recorrente já foi cancelada — não vem mais cobrança nenhuma.\n\n` +
      `Se foi engano, responda este e-mail ou chame no WhatsApp o quanto antes.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Confirma a troca (RN-52, POST /trocar-plano do Checkout) — de qual plano
// pra qual, e se cobrou acerto ou não. Os números vão abertos porque é a
// Mostraí que tem de explicar a cobrança ao assinante (mesma régua do
// próprio Checkout, que devolve os números pra isso).
async function enviarTrocaDePlano(anunciante, planoAntigo, planoNovo, acerto) {
  const linhaAcerto = acerto?.cobrado
    ? `Foi cobrado um acerto proporcional de R$ ${Number(acerto.valor).toFixed(2)} no cartão salvo, pelos dias que faltavam no ciclo atual.`
    : `Não houve cobrança agora — o valor novo passa a valer a partir da sua próxima renovação.`;
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Troca de plano confirmada — Mostraí',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Sua troca de plano foi confirmada: de ${planoAntigo.nome} para ${planoNovo.nome}.\n\n` +
      `${linhaAcerto}\n\n` +
      `${process.env.SITE_URL}/anunciante/painel.html\n\n` +
      `Qualquer dúvida, responda este e-mail ou chame no WhatsApp.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Confirma o cancelamento (self-service ou pelo admin em nome do cliente —
// mesma cobertura das duas rotas). Cobertura já paga continua até vencer;
// é o mesmo aviso que `enviarCoberturaAcabando` dá pra quem NÃO cancelou,
// só que aqui o motivo do fim é a decisão do próprio assinante.
async function enviarCancelamento(anunciante, plano) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Assinatura cancelada — Mostraí',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Sua assinatura do plano ${plano?.nome || ''} foi cancelada. A renovação automática não vai mais acontecer.\n\n` +
      `Sua cobertura já paga continua no ar até o fim do período atual — nenhum anúncio sai do ar agora.\n\n` +
      `Se quiser assinar de novo depois, sua conta e seu histórico continuam aqui.\n\n` +
      `Qualquer dúvida, responda este e-mail ou chame no WhatsApp.\n\n` +
      `Equipe Mostraí.`,
  });
}

// Código de 6 dígitos pra confirmar que o e-mail digitado no cadastro é de
// verdade — ele é o login e o único canal de recuperação de senha, então um
// e-mail errado tranca a pessoa fora da própria conta sem volta.
async function enviarCodigoConfirmacaoEmail(anunciante, codigo) {
  await transportador().sendMail({
    from: remetente(),
    to: anunciante.contato_email,
    subject: 'Confirme seu e-mail — Mostraí',
    text:
      `Olá, ${anunciante.nome_empresa}!\n\n` +
      `Seu código de confirmação é: ${codigo}\n\n` +
      `Digite esse código na sua conta pra confirmar o e-mail. Ele vale por 2 minutos.\n\n` +
      `Se não foi você que criou essa conta, pode ignorar este e-mail.\n\nEquipe Mostraí.`,
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
    subject: `Mostraí — Contato pelo site — ${nome}`,
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
    subject: 'Mostraí — Desistência registrada',
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
    subject: `Mostraí — Candidatura nova de ${tipo}`,
    text: [
      `Tipo: ${tipo}`,
      `Nome: ${candidatura.nome}`,
      candidatura.nome_comercio ? `Comércio: ${candidatura.nome_comercio}` : '',
      `WhatsApp: ${candidatura.contato_telefone}`,
      candidatura.contato_email ? `E-mail: ${candidatura.contato_email}` : '',
      candidatura.endereco ? `Endereço: ${linhaEndereco(candidatura, { comCidade: true })}` : '',
      candidatura.cep ? `CEP: ${candidatura.cep}` : '',
      candidatura.observacao ? `Observação: ${candidatura.observacao}` : '',
      '',
      'A página prometeu retorno em até 2 dias úteis.',
      `Fila: ${process.env.SITE_URL}/admin/#candidaturas`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

// DIAGNOSTICO DE SMTP, pro dono conferir sem depender de esperar um pagamento
// real acontecer. `verify()` do nodemailer abre a conexao e faz o LOGIN de
// verdade no servidor, mas NAO manda mensagem nenhuma — e exatamente o que
// falha quando a senha de app do Gmail e recusada (`535-5.7.8 Username and
// Password not accepted`).
//
// NUNCA devolve o valor de SMTP_PASS, nem parte dele: so diz se a variavel
// existe e quantos caracteres tem. O tamanho e util porque senha de app do
// Gmail tem 16 caracteres — se vier 19, sobraram os espacos que o Google
// mostra na tela (eles sao so separacao visual e nao fazem parte da senha).
// O 535 do Gmail nao diz qual das cinco causas e a sua. Esta funcao aponta a
// mais provavel a partir do que da pra ver — e a primeira delas custou um dia:
// o SMTP do Gmail autentica com o endereco da CONTA, nunca com um alias de
// envio. Se `SMTP_USER` e um alias (mostrai@) de uma conta real (admin@), o
// login falha com "Username and Password not accepted" mesmo com a senha de
// app perfeita, porque a senha pertence a conta, nao ao alias.
function dicaDoErro(err, base) {
  const texto = `${err.message || ''} ${err.response || ''}`;
  if (!/535|BadCredentials|not accepted|Invalid login/i.test(texto)) return null;

  if (base.senha_tem_espaco) {
    return 'A senha tem espaço. A senha de app do Gmail são 16 caracteres; os espaços que o Google mostra na tela são só separação visual e não fazem parte dela.';
  }
  if (base.senha_caracteres !== 16) {
    return `A senha tem ${base.senha_caracteres} caracteres. Senha de app do Gmail tem 16 — confira se veio inteira.`;
  }
  return (
    'A senha parece bem formada (16 caracteres, sem espaço), então o suspeito é o USUÁRIO. ' +
    'O SMTP do Gmail autentica com o endereço da CONTA, nunca com um alias de envio: se ' +
    `"${base.usuario}" for alias de outra conta, use o endereço real em SMTP_USER e deixe o alias só em ` +
    'MOSTRAI_EMAIL_FROM (o remetente). Se não for alias, gere uma senha de app nova em ' +
    'myaccount.google.com → Segurança → Senhas de app.'
  );
}

async function diagnosticarSmtp() {
  const faltando = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'].filter((v) => !process.env[v]);
  const senha = process.env.SMTP_PASS || '';
  const base = {
    host: process.env.SMTP_HOST || null,
    porta: Number(process.env.SMTP_PORT) || null,
    usuario: process.env.SMTP_USER || null,
    remetente: remetente() || null,
    destino_contato: process.env.MOSTRAI_EMAIL_CONTATO || remetente() || null,
    senha_definida: Boolean(senha),
    senha_caracteres: senha.length,
    senha_tem_espaco: /\s/.test(senha),
  };
  if (faltando.length) return { ok: false, erro: `variáveis não definidas: ${faltando.join(', ')}`, ...base };

  // Limites de tempo proprios: sem eles, host errado ou porta bloqueada
  // deixam a tela do admin girando pra sempre em vez de dizer o que houve.
  const teste = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    auth: { user: process.env.SMTP_USER, pass: senha },
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 8000,
  });
  try {
    await teste.verify();
    return { ok: true, ...base };
  } catch (err) {
    return {
      ok: false,
      erro: err.message,
      codigo: err.code || null,
      resposta: err.response || null,
      dica: dicaDoErro(err, base),
      ...base,
    };
  } finally {
    teste.close();
  }
}

module.exports = {
  enviarCobrancaFalhou,
  enviarCoberturaAcabando,
  enviarCandidaturaNova,
  enviarCriativoNoAr,
  enviarCriativoReprovado,
  enviarConfirmacaoPagamento,
  enviarLinkRedefinicaoSenha,
  enviarCodigoConfirmacaoEmail,
  enviarContaAprovada,
  enviarContaCriada,
  enviarContaExcluida,
  enviarTrocaDePlano,
  enviarCancelamento,
  enviarMensagemContato,
  enviarNovidade,
  enviarArrependimentoRecebido,
  diagnosticarSmtp,
};
