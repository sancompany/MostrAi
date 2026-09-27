const nodemailer = require('nodemailer');
const { linhaEndereco } = require('../lib/endereco');
const { gerarComprovante } = require('./comprovante');

// Um transporte só, reaproveitado (27/09/2026). Antes cada e-mail abria a
// própria conexão SMTP — o cadastro abria duas ao mesmo tempo contra o mesmo
// login do Gmail, e sem prazo nenhum uma conexão pendurada segurava o envio
// pra sempre. Com `pool` as mensagens reusam a conexão, e os prazos fazem a
// falha virar erro (que a outbox tenta de novo) em vez de espera infinita.
// Conferido na doc do Nodemailer 6+/7 (SMTP transport: pool, maxConnections,
// connectionTimeout, greetingTimeout, socketTimeout), 27/09/2026.
let transporteCompartilhado = null;
function transportador() {
  if (transporteCompartilhado) return transporteCompartilhado;
  // Teste automatizado NUNCA fala com SMTP de verdade: sem um transporte
  // falso instalado (`usarTransporte`), o envio falha aqui.
  if (process.env.NODE_ENV === 'test') {
    throw new Error('SMTP real bloqueado em teste — instale um transporte falso');
  }
  // Ambiente local/e2e: `EMAIL_CAPTURA=<arquivo>` grava cada mensagem como
  // uma linha JSON em vez de mandar — é assim que os roteiros e2e leem o
  // código de verificação (que no banco só existe como hash). Nunca em
  // produção, nem por engano de variável.
  if (process.env.EMAIL_CAPTURA && process.env.NODE_ENV !== 'production') {
    const arquivo = process.env.EMAIL_CAPTURA;
    transporteCompartilhado = {
      sendMail: async (m) => {
        const linha = { em: new Date().toISOString(), to: m.to, cc: m.cc, subject: m.subject, text: m.text };
        await require('node:fs/promises').appendFile(arquivo, `${JSON.stringify(linha)}\n`);
        return { messageId: `captura-${Date.now()}` };
      },
    };
    return transporteCompartilhado;
  }
  if (!process.env.SMTP_HOST) throw new Error('SMTP não configurado (SMTP_HOST ausente)');
  transporteCompartilhado = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    pool: true,
    maxConnections: 2,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
  });
  return transporteCompartilhado;
}

// Troca o transporte (testes: SMTP falso que só guarda a mensagem).
function usarTransporte(t) {
  transporteCompartilhado = t;
}

function remetente() {
  return process.env.MOSTRAI_EMAIL_FROM || process.env.VITRINA_EMAIL_FROM;
}

const CICLO_TEXTO = { 1: 'mensal', 3: 'trimestral', 6: 'semestral', 12: 'anual' };
const painel = () => `${process.env.SITE_URL}/anunciante/painel.html`;
const reais = (v) => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;

// ---------------------------------------------------------------------------
// Layout (25/09/2026): todo e-mail ao cliente sai em HTML e em texto puro,
// com o MESMO conteúdo. HTML em tabela com estilo inline e 600 px de largura
// máxima — é o que Gmail, Outlook e o app do celular renderizam igual; nada
// de imagem (bloqueada por padrão em muito cliente) nem CSS externo. O botão
// usa o laranja escuro da marca (--brand-text, #c2570a): o laranja claro
// (#ff7a1a) com texto branco não chega ao contraste mínimo de leitura.
// Todo dado vindo de cadastro passa por `esc` — nome de empresa é texto
// digitado por quem se cadastrou.
// ---------------------------------------------------------------------------
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

// { previa, saudacao, titulo, paragrafos: [texto], destaque, botao: { texto, url }, depois: [texto], nota }
function mensagem({ previa = '', saudacao, titulo, paragrafos = [], destaque, botao, depois = [], nota }) {
  const texto = [
    saudacao,
    ...paragrafos,
    destaque,
    botao ? `${botao.texto}: ${botao.url}` : null,
    ...depois,
    'Equipe Mostraí.',
    nota,
  ]
    .filter(Boolean)
    .join('\n\n');

  const p = (t) => `<p style="margin:0 0 16px;font-size:16px;line-height:24px;color:#14171f">${esc(t)}</p>`;
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(titulo)}</title></head>
<body style="margin:0;padding:0;background:#f7f8fa">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(previa)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8fa"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border:1px solid #e1e5eb;border-radius:12px;font-family:Arial,Helvetica,sans-serif">
<tr><td style="height:6px;background:#ff7a1a;border-radius:12px 12px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 8px"><div style="font-size:22px;font-weight:bold;color:#14171f">Mostraí</div></td></tr>
<tr><td style="padding:8px 32px 8px">
<h1 style="margin:0 0 20px;font-size:22px;line-height:30px;color:#14171f">${esc(titulo)}</h1>
${saudacao ? p(saudacao) : ''}${paragrafos.map(p).join('')}${
  destaque
    ? `<div style="margin:0 0 20px;padding:16px;background:#eef1f5;border-radius:8px;text-align:center;font-size:28px;letter-spacing:6px;font-weight:bold;color:#14171f;font-family:Consolas,Menlo,monospace">${esc(destaque)}</div>`
    : ''
}${
  botao
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px"><tr><td style="border-radius:8px;background:#c2570a"><a href="${esc(botao.url)}" style="display:inline-block;padding:14px 24px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px">${esc(botao.texto)}</a></td></tr></table>
<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#5b6472">Se o botão não abrir, copie este endereço: <a href="${esc(botao.url)}" style="color:#1d4ed8;word-break:break-all">${esc(botao.url)}</a></p>`
    : ''
}${depois.map(p).join('')}
<p style="margin:0 0 8px;font-size:16px;line-height:24px;color:#14171f">Equipe Mostraí.</p>
</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #e1e5eb;font-size:13px;line-height:20px;color:#5b6472">${
    nota ? `${esc(nota)}<br><br>` : ''
  }Mostraí · anúncios nas telas do comércio local.<br>Dúvidas? É só responder este e-mail.</td></tr>
</table></td></tr></table></body></html>`;
  return { text: texto, html };
}

function enviar({ to, cc, replyTo, subject, conteudo, attachments }) {
  return transportador().sendMail({
    from: remetente(),
    to,
    cc,
    replyTo,
    subject,
    text: conteudo.text,
    html: conteudo.html,
    attachments,
  });
}

// Disparado pelo webhook de pagamento confirmado (INTEGRACAO.md 4.2) —
// fire-and-forget: se falhar, não trava a ativação (quem chama já faz .catch).
// `cobranca` ({ id, criado_em }) é a linha de `cobrancas_confirmadas` deste
// ciclo: dela nasce o comprovante de pagamento em PDF, anexado. Sem ela (ou se
// o PDF falhar) o e-mail sai igual, sem anexo — o aviso não depende do papel.
async function enviarConfirmacaoPagamento(anunciante, plano, valorCobrado, cobranca = null) {
  let anexo = null;
  if (cobranca?.id) {
    try {
      anexo = gerarComprovante({
        cobrancaId: cobranca.id,
        confirmadoEm: cobranca.criado_em,
        valor: valorCobrado,
        plano,
        anunciante,
      });
    } catch (err) {
      console.error('comprovante não gerado; e-mail segue sem anexo:', err.message);
    }
  }
  const ciclo = CICLO_TEXTO[plano.compromisso_meses] || `${plano.compromisso_meses} meses`;
  await enviar({
    to: anunciante.contato_email,
    subject: 'Pagamento confirmado — Mostraí',
    conteudo: mensagem({
      previa: `Plano ${plano.nome}: ${reais(valorCobrado)} confirmados.`,
      titulo: 'Pagamento confirmado',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        `Seu pagamento do plano ${plano.nome} (${ciclo}) foi confirmado — valor cobrado: ${reais(valorCobrado)}.`,
        ...(anexo ? ['O comprovante de pagamento está anexado a este e-mail, em PDF.'] : []),
        'AGORA FALTA UMA COISA: subir o seu anúncio.',
        'Abra o painel e envie um vídeo ou imagem em pé (9:16), na duração que o seu plano permite. A gente ajusta o formato pra caber na tela. Depois da aprovação ele entra no ar.',
      ],
      botao: { texto: 'Abrir o painel', url: painel() },
      depois: [
        'Não tem a arte pronta? A gente faz pra você — é um serviço à parte do plano, com preço combinado na hora. Responda este e-mail ou chame no WhatsApp que a gente te passa um orçamento.',
      ],
    }),
    attachments: anexo
      ? [{ filename: anexo.nomeArquivo, content: anexo.pdf, contentType: 'application/pdf' }]
      : undefined,
  });
  return { comComprovante: !!anexo };
}

// Cartão recusado ou cobrança vencida (API.md do Checkout, 7.3 e o checklist
// de integração — item explícito: "ao receber cobranca_falhou, mandar o link
// de renovação"). Sem isso a cobertura simplesmente vence na próxima data de
// expiração e o anunciante nunca soube que devia trocar o cartão.
async function enviarCobrancaFalhou(anunciante, linkRenovar) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Não conseguimos cobrar sua renovação — Mostraí',
    conteudo: mensagem({
      previa: 'A cobrança deste ciclo não passou.',
      titulo: 'Não conseguimos cobrar sua renovação',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'A cobrança deste ciclo não passou — cartão vencido, sem limite ou recusado pelo banco.',
        'Seu anúncio continua no ar até a cobertura atual acabar, mas a renovação automática não vai se repetir sozinha.',
        linkRenovar
          ? 'Pra resolver, atualize o cartão pelo botão abaixo.'
          : 'Pra resolver, responda este e-mail ou chame no WhatsApp que a gente atualiza o pagamento com você.',
      ],
      botao: linkRenovar ? { texto: 'Atualizar o cartão', url: linkRenovar } : null,
      depois: [
        ...(linkRenovar
          ? ['A assinatura antiga só é cancelada quando a nova for confirmada — você não fica sem cobertura na troca.']
          : []),
        'Qualquer dúvida, responda este e-mail ou chame no WhatsApp.',
      ],
    }),
  });
}

// Cobertura acabando sem recorrência pra renovar (seção F, item 16). Quem
// trocou de plano pagou um pedido avulso: vale pelo período contratado e
// acaba ali, sem próxima cobrança. Sem este aviso o anúncio sai do ar num
// dia qualquer e o cliente só descobre pelo silêncio — o mesmo buraco que
// `enviarCobrancaFalhou` tapa do lado da assinatura.
async function enviarCoberturaAcabando(anunciante, plano, diasRestantes) {
  const quando = diasRestantes <= 0 ? 'hoje' : diasRestantes === 1 ? 'amanhã' : `em ${diasRestantes} dias`;
  const ciclo = CICLO_TEXTO[plano.compromisso_meses] || `${plano.compromisso_meses} meses`;
  await enviar({
    to: anunciante.contato_email,
    subject: `Sua cobertura na Mostraí acaba ${quando}`,
    conteudo: mensagem({
      previa: `O período do seu plano ${plano.nome} acaba ${quando}.`,
      titulo: `Sua cobertura acaba ${quando}`,
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        `O período do seu plano ${plano.nome} (${ciclo}) acaba ${quando}. Ele foi contratado como pagamento único, então não existe renovação automática: quando o prazo terminar, seu anúncio sai das telas.`,
        'Pra continuar no ar, escolha o plano e contrate de novo.',
      ],
      botao: { texto: 'Ver os planos', url: `${process.env.SITE_URL}/planos.html` },
      depois: [
        'Sua peça e seu histórico continuam na sua conta, então não precisa subir nada de novo.',
        'Qualquer dúvida, responda este e-mail ou chame no WhatsApp.',
      ],
    }),
  });
}

// Conta suspensa que o admin reativou (consolidação final, 24/09/2026 —
// antes recebia "Sua conta foi aprovada", texto do fluxo de aprovação de
// conta que não existe desde 15/09/2026: toda conta nasce liberada).
async function enviarContaReativada(anunciante) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Sua conta foi reativada — Mostraí',
    conteudo: mensagem({
      previa: 'O acesso ao painel voltou ao normal.',
      titulo: 'Sua conta foi reativada',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'Sua conta na Mostraí foi reativada. O acesso ao painel voltou ao normal e, se você tem plano em vigor, seu anúncio volta pra rotação.',
      ],
      botao: { texto: 'Abrir o painel', url: painel() },
    }),
  });
}

// Boas-vindas (pedido do dono, 18/09/2026). Desde 27/09/2026 sai DEPOIS que
// o e-mail é confirmado, não no cadastro: no cadastro a prioridade é o
// código, e dar "bem-vindo" a um endereço que talvez esteja errado era
// competir com ele pelo mesmo SMTP.
async function enviarContaCriada(anunciante) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Sua conta na Mostraí foi criada',
    conteudo: mensagem({
      previa: 'O próximo passo é escolher um plano.',
      titulo: 'Sua conta foi criada',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'Sua conta na Mostraí foi criada com sucesso. O próximo passo é escolher um plano e colocar seu anúncio na rotina da cidade.',
      ],
      botao: { texto: 'Ver os planos', url: `${process.env.SITE_URL}/planos.html` },
      depois: ['Qualquer dúvida, responda este e-mail ou chame no WhatsApp.'],
    }),
  });
}

// Confirma a exclusão pedida pelo próprio anunciante (RN-24/26, direitos do
// titular). A cobrança recorrente já foi cancelada antes deste e-mail sair
// (é a mesma rota que faz as duas coisas) — dizer isso evita a pergunta
// "vou continuar sendo cobrado?" chegando pelo WhatsApp.
async function enviarContaExcluida(anunciante) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Sua conta na Mostraí foi excluída',
    conteudo: mensagem({
      previa: 'A exclusão que você pediu foi feita.',
      titulo: 'Sua conta foi excluída',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'Sua conta na Mostraí foi excluída, a seu pedido. Se havia assinatura ativa, a cobrança recorrente já foi cancelada — não vem mais cobrança nenhuma.',
        'Se foi engano, responda este e-mail ou chame no WhatsApp o quanto antes.',
      ],
    }),
  });
}

// Confirma a troca (RN-52, POST /trocar-plano do Checkout) — de qual plano
// pra qual, e se cobrou acerto ou não. Os números vão abertos porque é a
// Mostraí que tem de explicar a cobrança ao assinante (mesma régua do
// próprio Checkout, que devolve os números pra isso).
async function enviarTrocaDePlano(anunciante, planoAntigo, planoNovo, acerto) {
  const linhaAcerto = acerto?.cobrado
    ? `Foi cobrado um acerto proporcional de ${reais(acerto.valor)} no cartão salvo, pelos dias que faltavam no ciclo atual.`
    : 'Não houve cobrança agora — o valor novo passa a valer a partir da sua próxima renovação.';
  await enviar({
    to: anunciante.contato_email,
    subject: 'Troca de plano confirmada — Mostraí',
    conteudo: mensagem({
      previa: `De ${planoAntigo.nome} para ${planoNovo.nome}.`,
      titulo: 'Troca de plano confirmada',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [`Sua troca de plano foi confirmada: de ${planoAntigo.nome} para ${planoNovo.nome}.`, linhaAcerto],
      botao: { texto: 'Abrir o painel', url: painel() },
      depois: ['Qualquer dúvida, responda este e-mail ou chame no WhatsApp.'],
    }),
  });
}

// Confirma o cancelamento (self-service ou pelo admin em nome do cliente —
// mesma cobertura das duas rotas). Cobertura já paga continua até vencer;
// é o mesmo aviso que `enviarCoberturaAcabando` dá pra quem NÃO cancelou,
// só que aqui o motivo do fim é a decisão do próprio assinante.
async function enviarCancelamento(anunciante, plano) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Assinatura cancelada — Mostraí',
    conteudo: mensagem({
      previa: 'A renovação automática não vai mais acontecer.',
      titulo: 'Assinatura cancelada',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        `Sua assinatura do plano ${plano?.nome || ''} foi cancelada. A renovação automática não vai mais acontecer.`,
        'Sua cobertura já paga continua no ar até o fim do período atual — nenhum anúncio sai do ar agora.',
        'Se quiser assinar de novo depois, sua conta e seu histórico continuam aqui.',
        'Qualquer dúvida, responda este e-mail ou chame no WhatsApp.',
      ],
    }),
  });
}

// Código de 6 dígitos pra confirmar que o e-mail digitado no cadastro é de
// verdade — ele é o login e o único canal de recuperação de senha, então um
// e-mail errado tranca a pessoa fora da própria conta sem volta.
//
// `troca: true` é o código mandado pro endereço NOVO numa troca de e-mail de
// uma conta já confirmada — o texto diz que é troca, e quem não pediu sabe
// que pode ignorar sem que nada mude na conta.
async function enviarCodigoConfirmacaoEmail(anunciante, codigo, { validadeMinutos = 10, troca = false } = {}) {
  await enviar({
    to: anunciante.contato_email,
    subject: troca ? 'Confirme seu novo e-mail — Mostraí' : 'Confirme seu e-mail — Mostraí',
    conteudo: mensagem({
      previa: `Seu código de confirmação é ${codigo}.`,
      titulo: troca ? 'Confirme seu novo e-mail' : 'Confirme seu e-mail',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        troca
          ? 'Recebemos um pedido pra trocar o e-mail de acesso da sua conta na Mostraí para este endereço. Seu código é:'
          : 'Seu código de confirmação é:',
      ],
      destaque: codigo,
      depois: [
        troca
          ? `Digite esse código na sua conta pra concluir a troca. Ele vale por ${validadeMinutos} minutos. Até lá, o login continua pelo e-mail antigo.`
          : `Digite esse código na sua conta pra confirmar o e-mail. Ele vale por ${validadeMinutos} minutos.`,
      ],
      nota: troca
        ? 'Se não foi você que pediu, pode ignorar este e-mail: nada muda na conta.'
        : 'Se não foi você que criou essa conta, pode ignorar este e-mail.',
    }),
  });
}

// Aviso de segurança depois que a senha mudou (pela redefinição por link).
// Sai pro e-mail de login: se não foi a pessoa, é por aqui que ela descobre.
async function enviarSenhaAlterada(anunciante) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Sua senha foi alterada — Mostraí',
    conteudo: mensagem({
      previa: 'A senha da sua conta acabou de mudar.',
      titulo: 'Sua senha foi alterada',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: ['A senha da sua conta na Mostraí acabou de ser alterada.'],
      nota: 'Se não foi você, responda este e-mail ou chame no WhatsApp agora — e peça uma senha nova em "Esqueci minha senha".',
    }),
  });
}

// Aviso ao endereço ANTIGO depois que o e-mail de login mudou (troca pelo
// próprio usuário ou correção pelo admin). É o único jeito de o dono de
// verdade da conta perceber uma troca que não foi ele que fez. Mostra o
// endereço novo mascarado — o bastante pra reconhecer, não pra expor.
async function enviarEmailAlterado(anunciante, { emailNovoMascarado, peloSuporte = false }) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'O e-mail da sua conta foi alterado — Mostraí',
    conteudo: mensagem({
      previa: 'O login da sua conta passou a ser outro e-mail.',
      titulo: 'O e-mail da sua conta foi alterado',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        peloSuporte
          ? `A pedido seu, nosso suporte trocou o e-mail de acesso da sua conta na Mostraí para ${emailNovoMascarado}.`
          : `O e-mail de acesso da sua conta na Mostraí foi trocado para ${emailNovoMascarado}.`,
        'A partir de agora, o login e a recuperação de senha passam a usar o endereço novo. Este endereço não recebe mais os avisos da conta.',
      ],
      nota: 'Se não foi você, responda este e-mail ou chame no WhatsApp agora.',
    }),
  });
}

// Decisão sobre o pedido de ponto feito de dentro do painel. Antes só havia
// a notificação dentro da conta — quem não abria o painel não sabia.
async function enviarPontoAprovado(anunciante) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Seu pedido de ponto foi aprovado — Mostraí',
    conteudo: mensagem({
      previa: 'A gente chama no WhatsApp pra combinar a instalação.',
      titulo: 'Seu pedido de ponto foi aprovado',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'Seu pedido pra ter uma tela da Mostraí no seu comércio foi aprovado.',
        'A gente chama no WhatsApp pra combinar a visita e a instalação.',
      ],
      botao: { texto: 'Abrir o painel', url: painel() },
    }),
  });
}

async function enviarPontoRecusado(anunciante) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Sobre o seu pedido de ponto — Mostraí',
    conteudo: mensagem({
      previa: 'Seu pedido de ponto não foi aprovado desta vez.',
      titulo: 'Seu pedido de ponto não foi aprovado desta vez',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'Analisamos seu pedido pra ter uma tela da Mostraí no seu comércio e, desta vez, não conseguimos seguir com ele.',
        'Se quiser entender o motivo ou tentar de novo mais pra frente, é só responder este e-mail.',
      ],
    }),
  });
}

async function enviarLinkRedefinicaoSenha(email, nome, link) {
  await enviar({
    to: email,
    subject: 'Redefinir sua senha — Mostraí',
    conteudo: mensagem({
      previa: 'O link vale por 1 hora.',
      titulo: 'Redefinir sua senha',
      saudacao: `Olá, ${nome}!`,
      paragrafos: [
        'Recebemos um pedido pra redefinir a senha da sua conta na Mostraí. Use o botão abaixo pra criar uma senha nova — o link vale por 1 hora.',
      ],
      botao: { texto: 'Criar senha nova', url: link },
      nota: 'Se não foi você que pediu, é só ignorar este e-mail: sua senha continua a mesma.',
    }),
  });
}

// Formulário de contato do site — cai na caixa da própria Mostraí, com o
// e-mail de quem escreveu no reply-to pra responder direto. Interno: texto
// puro, é o dono que lê.
async function enviarMensagemContato({ nome, email, telefone, mensagem: texto }, para = null) {
  await transportador().sendMail({
    from: remetente(),
    to: para || process.env.MOSTRAI_EMAIL_CONTATO || remetente(),
    replyTo: email,
    subject: `Mostraí — Contato pelo site — ${nome}`,
    text: `Nome: ${nome}\nE-mail: ${email}\nTelefone: ${telefone || '-'}\n\n${texto}`,
  });
}

// Disparado quando o admin aprova o criativo. Era o buraco mais sentido do
// fluxo: a pessoa pagava, subia o vídeo e ficava sem saber quando entrou no
// ar — a plataforma decidia sozinha e não contava. Todo self-service de mídia
// avisa nessa hora; é a confirmação de que o dinheiro virou entrega.
async function enviarCriativoReprovado(anunciante, criativo) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Seu anúncio precisa de um ajuste — Mostraí',
    conteudo: mensagem({
      previa: 'A peça que você enviou não passou na conferência.',
      titulo: 'Seu anúncio precisa de um ajuste',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'A peça que você enviou não passou na conferência e não entrou no ar.',
        ...(criativo?.motivo_reprovacao ? [`Motivo: ${criativo.motivo_reprovacao}`] : []),
        'Dá pra resolver rápido: no seu painel, exclua a peça reprovada (ela libera a vaga do seu plano) e suba a versão corrigida. A gente confere de novo.',
      ],
      botao: { texto: 'Abrir o painel', url: painel() },
      depois: ['Se quiser ajuda pra ajustar, é só responder este e-mail.'],
    }),
  });
}

// Sai na aprovação, que NÃO é exibição: aprovado só libera a peça para a
// programação. "No ar" é estado que só o proof-of-play confirma (painel), por
// isso este e-mail não promete que a peça já está rodando nem dá horário.
async function enviarCriativoAprovado(anunciante, criativo) {
  await enviar({
    to: anunciante.contato_email,
    subject: 'Seu anúncio foi aprovado — Mostraí',
    conteudo: mensagem({
      previa: 'Seu anúncio foi aprovado e está liberado para a programação.',
      titulo: 'Seu anúncio foi aprovado',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'Seu anúncio foi aprovado e está liberado para entrar na programação da Mostraí.',
        ...(criativo?.duracao_segundos ? [`Duração do vídeo: ${criativo.duracao_segundos} segundos.`] : []),
        'Você pode acompanhar pelo painel quando a primeira exibição for confirmada.',
      ],
      botao: { texto: 'Abrir o painel', url: painel() },
      depois: ['Qualquer dúvida, é só responder este e-mail.'],
    }),
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
  await enviar({
    to: anunciante.contato_email,
    subject: assunto,
    conteudo: mensagem({
      titulo: assunto,
      paragrafos: [texto],
      nota: 'Você recebe este aviso porque aceitou receber novidades da Mostraí. Pra parar, abra seu perfil no painel e desmarque "receber novidades".',
    }),
  });
  return { enviado: true };
}

// Confirmação de que o pedido de arrependimento entrou (CDC art. 49). Sai pro
// titular e pra caixa da Mostraí: o estorno é executado por uma pessoa no
// painel do Checkout, e sem aviso ninguém fica sabendo que há um a pagar.
async function enviarArrependimentoRecebido(anunciante, pedido) {
  await enviar({
    to: anunciante.contato_email,
    cc: process.env.MOSTRAI_EMAIL_CONTATO || remetente(),
    subject: 'Mostraí — Desistência registrada',
    conteudo: mensagem({
      previa: `Protocolo ${pedido.id}.`,
      titulo: 'Desistência registrada',
      saudacao: `Olá, ${anunciante.nome_empresa}!`,
      paragrafos: [
        'Registramos sua desistência da contratação dentro do prazo de 7 dias. A cobrança recorrente foi cancelada e seu anúncio saiu do ar.',
        `Valor a devolver: ${reais(pedido.valor_a_estornar)}. A devolução é feita pelo mesmo meio do pagamento e pode levar alguns dias úteis pra aparecer no seu extrato.`,
        `Protocolo: ${pedido.id}.`,
      ],
    }),
  });
}

// Candidatura nova (ponto ou vendedor) — vai pro DONO, não pro candidato.
// As páginas prometem contato em 2 dias úteis e nada avisava ninguém: a
// candidatura ficava esperando alguém abrir o admin e reparar na fila.
// Interno: texto puro.
async function enviarCandidaturaNova(candidatura, para = null) {
  const tipo = candidatura.tipo === 'ponto' ? 'ponto (quer uma tela no comércio)' : 'vendedor parceiro';
  await transportador().sendMail({
    from: remetente(),
    to: para || process.env.MOSTRAI_EMAIL_CONTATO || remetente(),
    subject: `Mostraí — Candidatura nova de ${tipo}`,
    text: [
      `Tipo: ${tipo}`,
      `Nome: ${candidatura.nome}`,
      candidatura.nome_comercio ? `Comércio: ${candidatura.nome_comercio}` : '',
      `WhatsApp: ${candidatura.contato_telefone}`,
      candidatura.contato_email ? `E-mail: ${candidatura.contato_email}` : '',
      candidatura.endereco ? `Endereço: ${linhaEndereco(candidatura, { comCidade: true })}` : '',
      candidatura.cep ? `CEP: ${candidatura.cep}` : '',
      candidatura.mensagem ? `Observação: ${candidatura.mensagem}` : '',
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
  mensagem,
  usarTransporte,
  enviarSenhaAlterada,
  enviarEmailAlterado,
  enviarPontoAprovado,
  enviarPontoRecusado,
  enviarCobrancaFalhou,
  enviarCoberturaAcabando,
  enviarCandidaturaNova,
  enviarCriativoAprovado,
  enviarCriativoReprovado,
  enviarConfirmacaoPagamento,
  enviarLinkRedefinicaoSenha,
  enviarCodigoConfirmacaoEmail,
  enviarContaReativada,
  enviarContaCriada,
  enviarContaExcluida,
  enviarTrocaDePlano,
  enviarCancelamento,
  enviarMensagemContato,
  enviarNovidade,
  enviarArrependimentoRecebido,
  diagnosticarSmtp,
};
