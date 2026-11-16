const config = require('./config');

// Alertas da saúde (B13): transforma sinais críticos em e-mail, sem repetir
// a cada volta. Um problema novo avisa na hora; enquanto continua, um
// lembrete a cada LEMBRETE_HORAS; quando some, um "resolvido". O estado mora
// em `saude_alertas` (migration 020), decidido sob uma trava do banco — as
// duas instâncias do serviço e a tarefa agendada nunca avisam a mesma coisa
// duas vezes.
//
// O e-mail sai DEPOIS do COMMIT (o pool da TICK tem uma conexão só, e o SMTP
// pode demorar): se o envio falhar, `desfazer` devolve as linhas ao estado
// "não avisado" e a volta seguinte tenta de novo.
//
// Duas origens usam este módulo:
//   - vigia (dentro do serviço, a cada 5 min): os sinais críticos de saude.js;
//   - sentinela (tarefa agendada no Northflank): o site visto de fora.

const TRAVA = 872028; // a das migrations é 872027
const LEMBRETE_HORAS = 6;

function destinatario() {
  return (process.env.TRIMUNDI_ALERTA_EMAIL || require('./legal').contato() || '').trim();
}

// `ativos`: [{ chave: '<origem>:<sinal>', texto, acao? }] — o que está com
// problema AGORA nesta origem. Devolve o que avisar, ou null se outra volta
// já está decidindo (trava ocupada).
async function decidir(cliente, origem, ativos) {
  const { rows: trava } = await cliente.query('SELECT pg_try_advisory_xact_lock($1) AS ok', [TRAVA]);
  if (!trava[0].ok) return null;
  const { rows: abertos } = await cliente.query(
    `SELECT chave, texto, avisado_em, avisos, avisado_em < now() - make_interval(hours => $2) AS vencido
       FROM saude_alertas WHERE resolvido_em IS NULL AND chave LIKE $1 FOR UPDATE`,
    [`${origem}:%`, LEMBRETE_HORAS],
  );
  const aberto = new Map(abertos.map((a) => [a.chave, a]));
  const atual = new Set(ativos.map((a) => a.chave));
  const novos = [];
  const lembretes = [];
  for (const a of ativos) {
    const ab = aberto.get(a.chave);
    // Nunca avisado (o primeiro envio falhou) ainda é novo.
    if (!ab || ab.avisos === 0) novos.push(a);
    else if (ab.avisado_em === null || ab.vencido) lembretes.push(a);
  }
  const resolvidos = abertos.filter((a) => !atual.has(a.chave));
  for (const a of novos) {
    await cliente.query(
      `INSERT INTO saude_alertas (chave, texto, aberto_em, avisado_em, avisos) VALUES ($1, $2, now(), now(), 1)
       ON CONFLICT (chave) DO UPDATE
         SET texto = EXCLUDED.texto, avisado_em = now(), avisos = 1, resolvido_em = NULL,
             aberto_em = CASE WHEN saude_alertas.resolvido_em IS NULL THEN saude_alertas.aberto_em ELSE now() END`,
      [a.chave, String(a.texto).slice(0, 500)],
    );
  }
  for (const a of lembretes) {
    await cliente.query(
      'UPDATE saude_alertas SET texto = $2, avisado_em = now(), avisos = avisos + 1 WHERE chave = $1',
      [a.chave, String(a.texto).slice(0, 500)],
    );
  }
  for (const r of resolvidos) {
    await cliente.query('UPDATE saude_alertas SET resolvido_em = now() WHERE chave = $1', [r.chave]);
  }
  return { novos, lembretes, resolvidos };
}

// O envio falhou: volta tudo a "não avisado" para a próxima volta tentar.
async function desfazer(cliente, d) {
  // O aviso que não saiu não conta: novo volta a avisos = 0 (sai como novo).
  const avisar = [...d.novos, ...d.lembretes].map((a) => a.chave);
  if (avisar.length)
    await cliente.query(
      'UPDATE saude_alertas SET avisado_em = NULL, avisos = greatest(avisos - 1, 0) WHERE chave = ANY($1::text[])',
      [avisar],
    );
  const resolvidos = d.resolvidos.map((a) => a.chave);
  if (resolvidos.length)
    await cliente.query('UPDATE saude_alertas SET resolvido_em = NULL WHERE chave = ANY($1::text[])', [resolvidos]);
}

const temAlgo = (d) => Boolean(d && (d.novos.length || d.lembretes.length || d.resolvidos.length));

function mensagem(d) {
  const problemas = d.novos.length + d.lembretes.length;
  const assunto = problemas
    ? `[TICK] ALERTA: ${problemas} problema(s) crítico(s)`
    : `[TICK] Resolvido: ${d.resolvidos.length} problema(s)`;
  const linha = (a) => `- ${a.texto}${a.acao ? `\n  O que fazer: ${a.acao}` : ''}`;
  const partes = [];
  if (d.novos.length) partes.push(`NOVO:\n${d.novos.map(linha).join('\n')}`);
  if (d.lembretes.length)
    partes.push(`CONTINUA (lembrete a cada ${LEMBRETE_HORAS} h):\n${d.lembretes.map(linha).join('\n')}`);
  if (d.resolvidos.length) partes.push(`RESOLVIDO:\n${d.resolvidos.map((a) => `- ${a.texto}`).join('\n')}`);
  const site = config.urlDoSite();
  partes.push(
    [
      site ? `Painel: ${site}/admin/#trimundi/visao` : null,
      'Procedimento: RUNBOOK.md §11.5 (sinal → significado → primeira ação).',
      `Conferido em ${new Date().toISOString()}.`,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return { assunto, texto: partes.join('\n\n') };
}

async function enviar(d) {
  const para = destinatario();
  if (!para) throw new Error('sem destinatário para o alerta (TRIMUNDI_ALERTA_EMAIL ou e-mail de contato)');
  const { assunto, texto } = mensagem(d);
  await require('./email').enviarAgora({ para, assunto, texto });
  return { para, assunto };
}

// Decide sob a trava, faz COMMIT, envia; se o envio falhar, desfaz.
// `transacao(fn)` roda fn(cliente) entre BEGIN e COMMIT.
async function processar(transacao, origem, ativos) {
  const d = await transacao((c) => decidir(c, origem, ativos));
  if (!temAlgo(d)) return { enviado: false, ...(d || { pulado: true }) };
  try {
    const r = await enviar(d);
    return { enviado: true, ...d, assunto: r.assunto };
  } catch (err) {
    await transacao((c) => desfazer(c, d));
    throw err;
  }
}

// Vigia (dentro do serviço): os sinais críticos da saúde viram alerta.
async function vigiar() {
  const saude = require('./saude');
  const { emTransacao } = require('./db/conexao');
  const r = await saude.verificar();
  const ativos = r.sinais
    .filter((s) => s.nivel === 'critico')
    .map((s) => ({
      chave: `vigia:${s.chave}`,
      texto: `${s.quantidade} · ${s.texto}${s.pedidos ? ` Pedidos: ${s.pedidos.join(', ')}.` : ''}`,
      acao: s.acao,
    }));
  return processar(emTransacao, 'vigia', ativos);
}

module.exports = { decidir, desfazer, mensagem, enviar, processar, vigiar, destinatario, LEMBRETE_HORAS, TRAVA };
