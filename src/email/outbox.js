const pool = require('../db/pool');
const cofre = require('../lib/cofre');
const email = require('../financeiro/email');
const comunicados = require('../comunicados/envio');

// Fila durável de e-mails (migration 097). Mesmo desenho da inbox do webhook
// (src/financeiro/webhook-inbox.js), do lado da SAÍDA:
//
//   regra de negócio: conclui → enfileirar() grava a linha → segue
//   processador: pega uma linha (FOR UPDATE SKIP LOCKED) → monta e manda
//   pelo SMTP → marca.
//
// Estados: na_fila → enviando → enviado
//                       ↘ tentando_de_novo (espera crescente) → … → abandonado
//          (código vencido antes de sair) → descartado
// "enviando" tem prazo (LEASE_MIN): a instância que pegou pode morrer no meio
// (deploy, OOM) — passado o prazo, outra retoma. O efeito é "pelo menos uma
// vez": na pior das hipóteses (SMTP aceitou e a instância morreu antes de
// marcar) o e-mail sai duas vezes. Nunca zero.
//
// E-MAIL NUNCA QUEBRA NEGÓCIO: quem chama depois de concluir a operação usa
// `enfileirarSemFalhar` — erro ao gravar vira log, nunca 500 de uma operação
// que já aconteceu (crédito concedido, pagamento aplicado, conta criada).

const MAX_TENTATIVAS = 6;
// Espera antes da tentativa 2, 3, 4, 5 e 6: 30 s, 2 min, 10 min, 30 min, 2 h.
// Um código de 10 minutos ainda tem 2 tentativas dentro da validade; o resto
// cobre SMTP fora por horas (senha de app expirada já aconteceu aqui).
const ESPERAS_S = [30, 120, 600, 1800, 7200];
const LEASE_MIN = 5;
const INTERVALO_MS = 30 * 1000;
// Retenção: mensagem com segredo (código, link de senha) some em 2 dias,
// seja qual for o estado; o resto, 30 dias depois de enviada e 90 depois de
// abandonada/descartada — tempo de alguém investigar "não recebi".
const RETENCAO = { comSegredoDias: 2, enviadoDias: 30, falhaDias: 90 };

// Liga o envio imediato depois de enfileirar (sem esperar a próxima volta de
// 30 s). Desligado em teste: lá quem roda o processador é o próprio teste.
const config = { despacharNaHora: process.env.NODE_ENV !== 'test' };

const remetenteInterno = () =>
  process.env.MOSTRAI_EMAIL_CONTATO || process.env.MOSTRAI_EMAIL_FROM || process.env.VITRINA_EMAIL_FROM || null;

// `fu***@gmail.com` — pra log e tela operacional. Nunca o endereço inteiro.
function mascararEmail(endereco) {
  const [nome, dominio] = String(endereco || '').split('@');
  if (!dominio) return '***';
  return `${nome.slice(0, 2)}***@${dominio}`;
}

// Classificação (A21 da estação de e-mail, 27/09/2026):
//   critico      — sem ele a pessoa perde acesso ou não percebe uma invasão
//   transacional — dinheiro e contrato (pagamento, assinatura, desistência)
//   operacional  — andamento do serviço (criativo, ponto, avisos internos)
//   opcional     — divulgação, depende de consentimento (nada usa hoje)
//
// `enviar(linha, segredo)` monta e manda; `conta` é { nome_empresa,
// contato_email } com o destinatário DA LINHA — o endereço gravado na hora
// do evento é o que recebe, mesmo que a conta troque de e-mail depois.
// Ganchos opcionais de um modelo: `depois(linha)` roda quando saiu;
// `aoDesistir(linha, status, motivo)` quando a fila desiste ('abandonado'
// ou 'descartado'); `enviar` que devolve `{ descartar: motivo }` conferiu na
// hora que a mensagem não deve mais sair. `emMassa`: o tipo vai pro fim da
// fila — um comunicado para centenas de contas nunca atrasa um código de
// verificação ou um link de senha que entrou depois dele.
const conta = (l) => ({ ...(l.dados.conta || {}), contato_email: l.destinatario });

const MODELOS = {
  codigo_confirmacao: {
    classe: 'critico',
    enviar: (l, s) =>
      email.enviarCodigoConfirmacaoEmail(conta(l), s.codigo, { validadeMinutos: l.dados.validadeMinutos }),
  },
  codigo_troca_email: {
    classe: 'critico',
    enviar: (l, s) =>
      email.enviarCodigoConfirmacaoEmail(conta(l), s.codigo, { validadeMinutos: l.dados.validadeMinutos, troca: true }),
  },
  redefinir_senha: {
    classe: 'critico',
    enviar: (l, s) => email.enviarLinkRedefinicaoSenha(l.destinatario, l.dados.conta?.nome_empresa, s.link),
  },
  senha_alterada: { classe: 'critico', enviar: (l) => email.enviarSenhaAlterada(conta(l)) },
  email_alterado: {
    classe: 'critico',
    enviar: (l) =>
      email.enviarEmailAlterado(conta(l), {
        emailNovoMascarado: l.dados.emailNovoMascarado,
        peloSuporte: !!l.dados.peloSuporte,
      }),
  },
  boas_vindas: { classe: 'operacional', enviar: (l) => email.enviarContaCriada(conta(l)) },
  conta_excluida: { classe: 'critico', enviar: (l) => email.enviarContaExcluida(conta(l)) },
  conta_reativada: { classe: 'operacional', enviar: (l) => email.enviarContaReativada(conta(l)) },

  // Pagamento: o comprovante em PDF nasce da cobrança confirmada, relida do
  // banco na hora de enviar — a fila guarda só os ids e o valor (o CPF/CNPJ
  // do pagador não fica copiado aqui).
  pagamento_confirmado: {
    classe: 'transacional',
    enviar: async (l) => {
      const { rows } = await pool.query(
        `SELECT cc.id, cc.criado_em, a.nome_empresa, a.cpf_cnpj, p.nome, p.compromisso_meses
           FROM cobrancas_confirmadas cc
           JOIN anunciantes a ON a.id = cc.anunciante_id
           JOIN planos p ON p.id = $2
          WHERE cc.id = $1`,
        [l.dados.cobrancaId, l.dados.planoId],
      );
      const r = rows[0];
      if (!r) throw new Error(`cobrança ${l.dados.cobrancaId} não encontrada pro e-mail de pagamento`);
      await email.enviarConfirmacaoPagamento(
        { nome_empresa: r.nome_empresa, cpf_cnpj: r.cpf_cnpj, contato_email: l.destinatario },
        { nome: r.nome, compromisso_meses: r.compromisso_meses },
        l.dados.valor,
        { id: r.id, criado_em: r.criado_em },
      );
    },
    // A evidência de que o e-mail do ciclo saiu (coluna já existente).
    depois: (l) =>
      pool.query('UPDATE cobrancas_confirmadas SET email_confirmacao_enviado_em = now() WHERE id = $1', [
        l.dados.cobrancaId,
      ]),
  },
  cobranca_falhou: {
    classe: 'transacional',
    enviar: (l, s) => email.enviarCobrancaFalhou(conta(l), s?.link || null),
  },
  cobertura_acabando: {
    classe: 'transacional',
    enviar: (l) => email.enviarCoberturaAcabando(conta(l), l.dados.plano, l.dados.dias),
  },
  troca_de_plano: {
    classe: 'transacional',
    enviar: (l) => email.enviarTrocaDePlano(conta(l), l.dados.planoAntigo, l.dados.planoNovo, l.dados.acerto),
  },
  assinatura_cancelada: {
    classe: 'transacional',
    enviar: (l) => email.enviarCancelamento(conta(l), l.dados.plano),
  },
  desistencia_registrada: {
    classe: 'transacional',
    enviar: (l) => email.enviarArrependimentoRecebido(conta(l), l.dados.pedido),
  },
  criativo_aprovado: {
    classe: 'operacional',
    enviar: (l) => email.enviarCriativoAprovado(conta(l), l.dados.criativo),
  },
  criativo_recusado: {
    classe: 'operacional',
    enviar: (l) => email.enviarCriativoReprovado(conta(l), l.dados.criativo),
  },
  criativo_correcao: {
    classe: 'operacional',
    enviar: (l) => email.enviarCriativoCorrecao(conta(l), l.dados.criativo),
  },
  ponto_aprovado: { classe: 'operacional', enviar: (l) => email.enviarPontoAprovado(conta(l)) },
  ponto_recusado: { classe: 'operacional', enviar: (l) => email.enviarPontoRecusado(conta(l)) },

  // Internos (caixa da Mostraí): texto puro, lidos pelo dono.
  contato_interno: {
    classe: 'operacional',
    enviar: (l) => email.enviarMensagemContato(l.dados.mensagem, l.destinatario),
    depois: (l) => pool.query('UPDATE mensagens_contato SET email_enviado = true WHERE id = $1', [l.dados.mensagemId]),
  },
  candidatura_interna: {
    classe: 'operacional',
    enviar: (l) => email.enviarCandidaturaNova(l.dados.candidatura, l.destinatario),
  },

  // Comunicado do admin (Visão geral, migration 108): uma linha por
  // destinatário; o texto mora em `comunicados` e é relido na hora de sair
  // (a fila guarda só o id). Aviso da plataforma, não divulgação — e ainda
  // assim respeita quem desmarcou "receber novidades" (src/comunicados/).
  comunicado: {
    classe: 'operacional',
    emMassa: true,
    enviar: (l) => comunicados.enviar(l),
    depois: (l) => comunicados.marcarEnviado(l),
    aoDesistir: (l, status, motivo) => comunicados.marcarDesistencia(l, status, motivo),
  },
};

const TIPOS_EM_MASSA = Object.keys(MODELOS).filter((t) => MODELOS[t].emMassa);

// Erro pra log/banco: primeira linha, curta, sem e-mail nem número longo
// (resposta de SMTP costuma citar o destinatário).
function sanitizar(err) {
  return String(err?.message || err || 'erro desconhecido')
    .split('\n')[0]
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '<email>')
    .replace(/\b\d{6,}\b/g, '<numero>')
    .slice(0, 300);
}

// Grava a mensagem. Devolve { id, novo }; `novo: false` = a mesma chave já
// estava na fila (o evento de negócio já gerou este e-mail — não duplica).
// Erro de banco SOBE: quem precisa de tudo-ou-nada passa a transação em `db`.
// `atrasoS`: só sai depois disso (o comunicado espalha as N mensagens no
// ritmo do provedor). Sem ele, sai já — como sempre foi.
async function enfileirar(
  { tipo, chave, para, anuncianteId = null, dados = {}, segredo = null, validoAte = null, atrasoS = 0 },
  db = pool,
) {
  const modelo = MODELOS[tipo];
  if (!modelo) throw new Error(`tipo de e-mail desconhecido: ${tipo}`);
  if (!chave) throw new Error('e-mail sem chave de evento');
  if (!para) throw new Error(`e-mail ${tipo} sem destinatário`);
  const { rows } = await db.query(
    `INSERT INTO email_outbox
       (chave, tipo, classe, destinatario, anunciante_id, dados, segredo, valido_ate, proxima_tentativa_em)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + make_interval(secs => $9))
     ON CONFLICT (chave) DO NOTHING RETURNING id`,
    [
      String(chave).slice(0, 300),
      tipo,
      modelo.classe,
      para,
      anuncianteId,
      dados,
      segredo ? cofre.fechar(JSON.stringify(segredo)) : null,
      validoAte,
      Math.max(0, Number(atrasoS) || 0),
    ],
  );
  if (rows[0] && db === pool) despachar();
  return { id: rows[0]?.id ?? null, novo: !!rows[0] };
}

// Mensagens desta conta que ainda não saíram e deixaram de fazer sentido
// (link de senha depois que a senha mudou; código ou link mandado pro e-mail
// que a conta deixou de usar): viram "descartado" e o segredo sai junto.
// A que já está "enviando" não dá pra segurar — o link/código dela já foi
// invalidado por quem chama. Revisão Codex do PR #80.
async function descartarPendentes(anuncianteId, tipos, motivo, db = pool) {
  const { rowCount } = await db.query(
    `UPDATE email_outbox
        SET status = 'descartado', segredo = NULL, ultimo_erro = $3, atualizado_em = now()
      WHERE anunciante_id = $1 AND tipo = ANY($2::text[]) AND status IN ('na_fila', 'tentando_de_novo')`,
    [anuncianteId, tipos, motivo],
  );
  return rowCount;
}

// Para quem chama DEPOIS da operação de negócio concluída: nunca lança.
async function enfileirarSemFalhar(msg) {
  try {
    return await enfileirar(msg);
  } catch (err) {
    console.error(`e-mail ${msg?.tipo} não entrou na fila (a operação segue valendo): ${sanitizar(err)}`);
    return null;
  }
}

// Reserva UMA linha elegível e marca "enviando" numa transação curta.
// `escopo` (prefixo do destinatário) existe pros testes: os arquivos rodam em
// paralelo contra o mesmo banco, e cada um só processa o que é seu. Em
// produção é sempre null (tudo).
// Ordem: primeiro o que não é em massa (código, link de senha, pagamento),
// depois a vez de cada um — FIFO dentro de cada grupo, como sempre foi.
async function pegarProxima(escopo = null) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const { rows } = await cliente.query(
      `SELECT id FROM email_outbox
        WHERE ((status IN ('na_fila', 'tentando_de_novo') AND proxima_tentativa_em <= now())
           OR (status = 'enviando' AND enviando_desde < now() - make_interval(mins => $1)))
          AND ($2::text IS NULL OR destinatario LIKE $2 || '%')
        ORDER BY (tipo = ANY($3::text[])), proxima_tentativa_em, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [LEASE_MIN, escopo, TIPOS_EM_MASSA],
    );
    if (!rows[0]) {
      await cliente.query('COMMIT');
      return null;
    }
    const { rows: pega } = await cliente.query(
      `UPDATE email_outbox
          SET status = 'enviando', enviando_desde = now(), tentativas = tentativas + 1, atualizado_em = now()
        WHERE id = $1
        RETURNING id, chave, tipo, destinatario, anunciante_id, dados, segredo, valido_ate, tentativas`,
      [rows[0].id],
    );
    await cliente.query('COMMIT');
    return pega[0];
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    cliente.release();
  }
}

// Fecha a linha num estado final. `tentativas` na condição: se o prazo
// venceu e outra instância retomou, o resultado desta (atrasada) não
// sobrescreve o dela. O segredo sai junto — terminou, não precisa mais.
// Devolve se fechou de fato: os ganchos (`depois`, `aoDesistir`) só rodam
// pra quem fechou — a instância atrasada não registra nada por cima da que
// retomou (quem retomou registra o resultado dela).
async function finalizar(l, status, erro = null) {
  const { rowCount } = await pool.query(
    `UPDATE email_outbox
        SET status = $3, enviando_desde = NULL, segredo = NULL, ultimo_erro = $4,
            enviado_em = CASE WHEN $3 = 'enviado' THEN now() ELSE enviado_em END, atualizado_em = now()
      WHERE id = $1 AND tentativas = $2`,
    [l.id, l.tentativas, status, erro],
  );
  return rowCount > 0;
}

const rotulo = (l) => `e-mail ${l.tipo} #${l.id} para ${mascararEmail(l.destinatario)}`;

// A fila desistiu da linha ('abandonado' ou 'descartado'): avisa o modelo,
// se ele quiser saber (o comunicado registra a falha por destinatário).
// Falha aqui não muda o estado da linha na fila.
async function desistir(l, status, motivo) {
  if (!(await finalizar(l, status, motivo))) return;
  const gancho = MODELOS[l.tipo]?.aoDesistir;
  if (!gancho) return;
  await Promise.resolve()
    .then(() => gancho(l, status, motivo))
    .catch((err) => console.error(`${rotulo(l)} ${status}; registro posterior falhou: ${sanitizar(err)}`));
}

async function enviarUma(escopo = null) {
  const l = await pegarProxima(escopo);
  if (!l) return false;

  if (l.valido_ate && new Date(l.valido_ate) <= new Date()) {
    await desistir(l, 'descartado', 'venceu antes de sair (código/link já não vale)');
    console.error(`${rotulo(l)} descartado: venceu antes de sair`);
    return true;
  }
  let segredo = null;
  if (l.segredo) {
    segredo = JSON.parse(cofre.abrir(l.segredo) || 'null');
    if (!segredo) {
      // Chave do cofre trocada (SESSION_SECRET novo): o código não abre mais.
      // Mandar sem ele seria um e-mail inútil; quem precisa pede outro.
      await desistir(l, 'descartado', 'segredo ilegível (chave do servidor trocada)');
      return true;
    }
  }

  let resultado;
  try {
    resultado = await MODELOS[l.tipo].enviar(l, segredo);
  } catch (err) {
    const erro = sanitizar(err);
    if (l.tentativas >= MAX_TENTATIVAS) {
      await desistir(l, 'abandonado', erro);
      console.error(`${rotulo(l)} ABANDONADO após ${l.tentativas} tentativas: ${erro}`);
    } else {
      const espera = ESPERAS_S[Math.min(l.tentativas, ESPERAS_S.length) - 1];
      await pool.query(
        `UPDATE email_outbox
            SET status = 'tentando_de_novo', enviando_desde = NULL, ultimo_erro = $3,
                proxima_tentativa_em = now() + make_interval(secs => $4), atualizado_em = now()
          WHERE id = $1 AND tentativas = $2`,
        [l.id, l.tentativas, erro, espera],
      );
      console.error(
        `${rotulo(l)} falhou (tentativa ${l.tentativas}/${MAX_TENTATIVAS}, de novo em ${espera}s): ${erro}`,
      );
    }
    return true;
  }

  // O modelo conferiu na hora que a mensagem não deve mais sair (ex.: a
  // conta deixou de receber comunicados): descartada, sem nova tentativa.
  if (resultado?.descartar) {
    const motivo = sanitizar(resultado.descartar);
    await desistir(l, 'descartado', motivo);
    console.log(`${rotulo(l)} descartado: ${motivo}`);
    return true;
  }

  const fechou = await finalizar(l, 'enviado');
  // Efeito colateral de registro (ex.: "e-mail do ciclo saiu"). Falha aqui
  // não desfaz o envio nem faz reenviar.
  if (fechou && MODELOS[l.tipo].depois) {
    await Promise.resolve()
      .then(() => MODELOS[l.tipo].depois(l))
      .catch((err) => console.error(`${rotulo(l)} enviado; registro posterior falhou: ${sanitizar(err)}`));
  }
  console.log(`${rotulo(l)} enviado (tentativa ${l.tentativas})`);
  return true;
}

// Esvazia o que estiver pronto, com até RODADAS_SIMULTANEAS rodadas por
// instância (o transporte tem 2 conexões). O SKIP LOCKED garante que duas
// rodadas — desta ou de outra instância — nunca pegam a mesma linha.
const RODADAS_SIMULTANEAS = 2;
const rodadas = new Set();
function processarPendentes({ limite = 50, escopo = null } = {}) {
  if (rodadas.size >= RODADAS_SIMULTANEAS) return Promise.resolve(0);
  const rodada = (async () => {
    let feitos = 0;
    while (feitos < limite && (await enviarUma(escopo))) feitos++;
    return feitos;
  })().finally(() => rodadas.delete(rodada));
  rodadas.add(rodada);
  return rodada;
}

async function aguardarRodadas() {
  while (rodadas.size) await Promise.allSettled([...rodadas]);
}

// Manda já o que acabou de entrar (o código do cadastro não espera 30 s).
function despachar() {
  if (!config.despacharNaHora) return;
  setImmediate(() => processarPendentes().catch((err) => console.error('outbox de e-mail:', sanitizar(err))));
}

async function expurgar() {
  // Antes de apagar, o resultado de cada mensagem de comunicado vai pro
  // registro dela (src/comunicados/envio.js#consolidar). Se isso falhar, o
  // expurgo não acontece nesta volta — apagar antes perderia o resultado.
  await comunicados.consolidar();
  const { rowCount } = await pool.query(
    `DELETE FROM email_outbox
      WHERE (tipo IN ('codigo_confirmacao', 'codigo_troca_email', 'redefinir_senha')
             AND criado_em < now() - make_interval(days => $1))
         OR (status = 'enviado' AND enviado_em < now() - make_interval(days => $2))
         OR (status IN ('abandonado', 'descartado') AND atualizado_em < now() - make_interval(days => $3))`,
    [RETENCAO.comSegredoDias, RETENCAO.enviadoDias, RETENCAO.falhaDias],
  );
  // Código de verificação vencido há mais de 1 dia: nada mais a conferir.
  await pool.query(`DELETE FROM codigos_email WHERE expira_em < now() - interval '1 day'`);
  return rowCount;
}

// Visão operacional (admin): contagem por estado e as últimas que falharam.
// Destinatário mascarado; `dados`/`segredo` nunca saem daqui. As falhas de
// tipo em massa (comunicado) ficam de fora da lista: têm o histórico delas,
// e 50 falhas de um comunicado esconderiam um código que não saiu.
async function resumo() {
  const { rows: porStatus } = await pool.query(`SELECT status, COUNT(*)::int AS n FROM email_outbox GROUP BY status`);
  const { rows: problemas } = await pool.query(
    `SELECT id, tipo, classe, destinatario, status, tentativas, ultimo_erro, proxima_tentativa_em, criado_em, atualizado_em
       FROM email_outbox
      WHERE status IN ('tentando_de_novo', 'abandonado') AND NOT (tipo = ANY($1::text[]))
      ORDER BY atualizado_em DESC LIMIT 50`,
    [TIPOS_EM_MASSA],
  );
  const contagem = Object.fromEntries(porStatus.map((r) => [r.status, r.n]));
  return {
    contagem,
    problemas: problemas.map(({ destinatario, ...r }) => ({ ...r, destinatario: mascararEmail(destinatario) })),
  };
}

let timers = [];
function iniciar() {
  const rodar = () => processarPendentes().catch((err) => console.error('outbox de e-mail:', sanitizar(err)));
  rodar();
  timers = [
    setInterval(rodar, INTERVALO_MS),
    setInterval(() => expurgar().catch((err) => console.error('expurgo da outbox:', sanitizar(err))), 60 * 60 * 1000),
  ];
  for (const t of timers) t.unref();
}

module.exports = {
  MAX_TENTATIVAS,
  ESPERAS_S,
  LEASE_MIN,
  RETENCAO,
  MODELOS,
  config,
  remetenteInterno,
  mascararEmail,
  sanitizar,
  enfileirar,
  enfileirarSemFalhar,
  descartarPendentes,
  pegarProxima,
  enviarUma,
  processarPendentes,
  aguardarRodadas,
  despachar,
  expurgar,
  resumo,
  iniciar,
};
