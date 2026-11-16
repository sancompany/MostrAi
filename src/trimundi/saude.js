const { consultar } = require('./db/conexao');
const config = require('./config');
const participantes = require('./participantes');

// Saúde da TICK (C3 do plano de lançamento): uma conferência SÓ DE LEITURA
// do que pode parar sem fazer barulho — fila de avisos de pagamento, fila de
// e-mail, expiração de pedidos, pedido pago sem ingresso, reembolso sem
// resposta e os avisos "Precisa de você" que o Admin já mostra. Não muda
// nada, não devolve dado pessoal (só contagens e códigos curtos de pedido),
// e reaproveita a regra dos avisos de `participantes.avisos` em vez de
// repeti-la.
//
// Nível de cada sinal:
//   critico — dinheiro entrou e o ingresso não sai, ou uma rotina parou;
//   atencao — alguém precisa olhar, mas nada está parado.
// Rodado à mão ou por agendador: `npm run trimundi:saude` sai com 1 só
// quando há sinal crítico (atenção não derruba o job — um aviso aberto pode
// esperar dias pela decisão do dono).

// As rotinas do processo rodam a cada 30 s (filas) e 5 min (expiração):
// passado este atraso sem andar, a rotina parou.
const ATRASO_FILA_MIN = 10;
const ATRASO_EXPIRACAO_MIN = 15;
const PAGO_SEM_INGRESSO_MIN = 10;
const REEMBOLSO_SEM_RESPOSTA_DIAS = 2;
const EMAIL_FALHOU_DIAS = 30;

const MAX_CODIGOS = 10;

async function contar(sql, params = []) {
  const { rows } = await consultar(sql, params);
  return { quantidade: Number(rows[0]?.quantidade || 0), codigos: rows[0]?.codigos || [] };
}

// Código curto do pedido, como o Admin mostra (8 primeiros, maiúsculos).
const CODIGOS = `(array_agg(upper(left(p.id::text, 8)) ORDER BY p.criado_em))[1:${MAX_CODIGOS}] AS codigos`;

async function verificar() {
  const sinais = [];
  const sinal = (chave, nivel, quantidade, texto, acao, codigos) => {
    if (quantidade > 0)
      sinais.push({ chave, nivel, quantidade, texto, acao, ...(codigos?.length ? { pedidos: codigos } : {}) });
  };

  // ---------------------------------------------------------- configuração
  const checkout = config.checkout().configurado;
  const email = config.email().configurado;
  if (!checkout && !config.pagamentoSimulado())
    sinal(
      'checkout_ausente',
      'critico',
      1,
      'San Checkout não configurado: não há como vender.',
      'RUNBOOK §11.1 (TRIMUNDI_CHECKOUT_*)',
    );
  if (!email)
    sinal(
      'email_ausente',
      'critico',
      1,
      'E-mail não configurado: ingressos e confirmações ficam guardados sem sair.',
      'RUNBOOK §11.1 (SMTP_* e remetente)',
    );

  // ------------------------------------------------- fila de pagamento
  const [filaPag, morto, pagoSemIngresso, vencidos, reembolso] = await Promise.all([
    contar(
      `SELECT count(*)::int AS quantidade FROM pagamento_eventos
        WHERE processamento IN ('recebido', 'tentando_de_novo', 'processando')
          AND proxima_tentativa_em < now() - make_interval(mins => $1)`,
      [ATRASO_FILA_MIN],
    ),
    contar("SELECT count(*)::int AS quantidade FROM pagamento_eventos WHERE processamento = 'morto'"),
    contar(
      `SELECT count(*)::int AS quantidade, ${CODIGOS} FROM pedidos p
        WHERE p.status = 'pago' AND p.pago_em < now() - make_interval(mins => $1)
          AND NOT EXISTS (SELECT 1 FROM ingressos i WHERE i.pedido_id = p.id)`,
      [PAGO_SEM_INGRESSO_MIN],
    ),
    contar(
      `SELECT count(*)::int AS quantidade FROM pedidos
        WHERE status = 'aguardando_pagamento' AND reserva_expira_em < now() - make_interval(mins => $1)`,
      [ATRASO_EXPIRACAO_MIN],
    ),
    contar(
      `SELECT count(*)::int AS quantidade, ${CODIGOS} FROM reembolsos r JOIN pedidos p ON p.id = r.pedido_id
        WHERE r.status = 'solicitado' AND r.criado_em < now() - make_interval(days => $1)`,
      [REEMBOLSO_SEM_RESPOSTA_DIAS],
    ),
  ]);
  sinal(
    'fila_pagamento_parada',
    'critico',
    filaPag.quantidade,
    `Avisos de pagamento esperando há mais de ${ATRASO_FILA_MIN} min: a fila parou e pagamentos não estão sendo aplicados.`,
    'Logs do serviço (linha "trimundi: fila de pagamento"); RUNBOOK §11.3',
  );
  sinal(
    'pago_sem_ingresso',
    'critico',
    pagoSemIngresso.quantidade,
    `Pedido pago há mais de ${PAGO_SEM_INGRESSO_MIN} min sem nenhum ingresso emitido.`,
    'Admin → Eventos → Participantes → abrir o pedido; não emitir à mão sem conferir o pagamento no Checkout',
    pagoSemIngresso.codigos,
  );
  sinal(
    'expiracao_parada',
    'atencao',
    vencidos.quantidade,
    `Pedidos com a reserva vencida há mais de ${ATRASO_EXPIRACAO_MIN} min ainda aguardando pagamento: a expiração não rodou e as vagas seguem presas.`,
    'Logs do serviço (linha "trimundi: expiração de pedidos")',
  );
  sinal(
    'pagamento_morto',
    'atencao',
    morto.quantidade,
    'Avisos de pagamento que falharam 6 vezes (inclui os já marcados como resolvidos no Admin).',
    'Admin → Eventos → Participantes → "Precisa de você"',
  );
  sinal(
    'reembolso_sem_resposta',
    'atencao',
    reembolso.quantidade,
    `Reembolsos pedidos há mais de ${REEMBOLSO_SEM_RESPOSTA_DIAS} dias sem confirmação do Checkout.`,
    'npm run trimundi:conciliar; depois conferir no painel do Checkout',
    reembolso.codigos,
  );

  // ------------------------------------------------------- fila de e-mail
  const [emailParado, emailFalhou, emailGuardado] = await Promise.all([
    contar(
      `SELECT count(*)::int AS quantidade FROM emails
        WHERE status = 'na_fila' AND proxima_tentativa_em < now() - make_interval(mins => $1)`,
      [ATRASO_FILA_MIN],
    ),
    contar(
      `SELECT count(*)::int AS quantidade FROM emails
        WHERE status = 'falhou' AND criado_em > now() - make_interval(days => $1)`,
      [EMAIL_FALHOU_DIAS],
    ),
    contar("SELECT count(*)::int AS quantidade FROM emails WHERE status = 'aguardando_provedor'"),
  ]);
  sinal(
    'fila_email_parada',
    'critico',
    emailParado.quantidade,
    `E-mails esperando há mais de ${ATRASO_FILA_MIN} min: a fila de e-mail parou.`,
    'Logs do serviço (linha "trimundi: fila de e-mail")',
  );
  sinal(
    'email_guardado',
    email ? 'atencao' : 'critico',
    emailGuardado.quantidade,
    'E-mails guardados sem provedor (aguardando_provedor): saem sozinhos quando o e-mail for configurado.',
    'RUNBOOK §11.1',
  );
  sinal(
    'email_falhou',
    'atencao',
    emailFalhou.quantidade,
    `E-mails que falharam 6 vezes nos últimos ${EMAIL_FALHOU_DIAS} dias.`,
    'Logs do serviço (linha "trimundi: e-mail #… falhou"); o comprador pode pedir o link de novo',
  );

  // ----------------------------------------- avisos abertos, por edição
  // A mesma lista do "Precisa de você" (sem os resolvidos): pago sem vaga,
  // valor divergente, pagamento duplicado, reembolso recusado, chargeback.
  // Só as edições com alguma das fontes de aviso (as mesmas de
  // `participantes.avisos`): sem esse filtro seriam 5 consultas por edição,
  // e o pool da TICK tem uma conexão só.
  const { rows: edicoes } = await consultar(
    `SELECT p.edicao_id AS id FROM pagamento_eventos pe JOIN pedidos p ON p.id = pe.pedido_id
      WHERE pe.processamento = 'morto' OR pe.resultado IN ('valor_divergente', 'pagamento_duplicado', 'parcial_sem_pedido')
     UNION SELECT edicao_id FROM pedidos WHERE status = 'pago_sem_vaga'
     UNION SELECT p.edicao_id FROM reembolsos r JOIN pedidos p ON p.id = r.pedido_id
      WHERE r.status = 'falhou' OR (r.status = 'solicitado' AND r.ultimo_erro IS NOT NULL)
     UNION SELECT edicao_id FROM ingressos WHERE status = 'bloqueado'
     ORDER BY 1`,
  );
  const porTipo = {};
  for (const e of edicoes) {
    for (const a of await participantes.avisos(e.id)) {
      porTipo[a.tipo] = porTipo[a.tipo] || { quantidade: 0, codigos: [] };
      porTipo[a.tipo].quantidade += 1;
      if (a.pedido_codigo && porTipo[a.tipo].codigos.length < MAX_CODIGOS)
        porTipo[a.tipo].codigos.push(a.pedido_codigo);
    }
  }
  for (const [tipo, x] of Object.entries(porTipo)) {
    sinal(
      `aviso_${tipo}`,
      'atencao',
      x.quantidade,
      participantes.TEXTO_AVISO[tipo] || tipo,
      'Admin → Eventos → Participantes → "Precisa de você"',
      x.codigos,
    );
  }

  const nivel = sinais.some((s) => s.nivel === 'critico')
    ? 'critico'
    : sinais.some((s) => s.nivel === 'atencao')
      ? 'atencao'
      : 'ok';
  const ordem = { critico: 0, atencao: 1 };
  sinais.sort((a, b) => ordem[a.nivel] - ordem[b.nivel]);
  return { verificado_em: new Date().toISOString(), nivel, sinais };
}

module.exports = { verificar, ATRASO_FILA_MIN, ATRASO_EXPIRACAO_MIN, PAGO_SEM_INGRESSO_MIN };

if (require.main === module) {
  require('dotenv').config();
  const conexao = require('./db/conexao');
  const ROTULO = { critico: 'CRÍTICO', atencao: 'atenção', ok: 'ok' };
  verificar()
    .then(async (r) => {
      console.log(`trimundi: saúde — ${ROTULO[r.nivel]} (${r.verificado_em})`);
      for (const s of r.sinais) {
        console.log(
          `  [${ROTULO[s.nivel]}] ${s.quantidade} · ${s.texto}${s.pedidos ? ` Pedidos: ${s.pedidos.join(', ')}` : ''}`,
        );
        console.log(`      → ${s.acao}`);
      }
      await conexao.encerrar();
      if (r.nivel === 'critico') process.exit(1);
    })
    .catch(async (err) => {
      console.error('trimundi: saúde — a conferência falhou:', err.message);
      await conexao.encerrar().catch(() => {});
      process.exit(1);
    });
}
