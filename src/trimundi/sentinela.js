const { Client } = require('pg');
const config = require('./config');
const alertas = require('./alertas');

// Sentinela (B13): a TICK vista de FORA do serviço, pela tarefa agendada do
// Northflank (`npm run trimundi:sentinela`). O vigia (alertas.vigiar) roda
// dentro do serviço e não percebe quando o próprio serviço caiu; esta
// conferência percebe.
//
// Olha dois endereços públicos do site:
//   /health             — o processo está de pé;
//   /ticket/api/saude   — banco, filas e configuração da TICK (sem detalhe).
// Cada falha é conferida de novo depois de ESPERA_MS (um deploy em andamento
// não vira alerta). O que continua falhando vira e-mail pelo mesmo caminho do
// vigia: um aviso por problema, lembrete a cada 6 h, "resolvido" quando volta.
//
// Variáveis: SITE_URL, DATABASE_URL (só para lembrar o que já foi avisado;
// sem banco, avisa assim mesmo), SMTP_* e o remetente/destinatário do e-mail.
// Não usa TRIMUNDI_SEGREDO nem a chave do Checkout. Sai com 1 quando algo
// falha, para a tarefa aparecer vermelha no Northflank.

const TEMPO_MS = 15000;
const ESPERA_MS = 20000;

const ALVOS = [
  { chave: 'sentinela:site', caminho: '/health', nome: 'o site (/health)' },
  { chave: 'sentinela:tick', caminho: '/ticket/api/saude', nome: 'a saúde da TICK (/ticket/api/saude)' },
];

async function conferir(base, alvo) {
  try {
    const r = await fetch(`${base}${alvo.caminho}`, { signal: AbortSignal.timeout(TEMPO_MS), redirect: 'manual' });
    const corpo = await r.json().catch(() => null);
    if (r.status === 200 && corpo?.ok === true) return null;
    return `respondeu ${r.status}`;
  } catch (err) {
    return err.name === 'TimeoutError' ? `não respondeu em ${TEMPO_MS / 1000} s` : `não respondeu (${err.message})`;
  }
}

async function checarAlvos(base, { espera = ESPERA_MS } = {}) {
  const falhas = [];
  for (const alvo of ALVOS) {
    let motivo = await conferir(base, alvo);
    if (motivo && espera) {
      await new Promise((r) => setTimeout(r, espera));
      motivo = await conferir(base, alvo);
    }
    if (motivo)
      falhas.push({
        chave: alvo.chave,
        texto: `${alvo.nome} ${motivo}.`,
        acao:
          alvo.chave === 'sentinela:site'
            ? 'Northflank → serviço mostrai → Observe → logs; RUNBOOK §6 ("/health não responde")'
            : 'Admin → Eventos → Visão geral (bloco "Saúde do sistema"); RUNBOOK §11.5',
      });
  }
  return falhas;
}

// Transação num cliente próprio, no esquema da TICK (a tarefa não liga o
// módulo inteiro: não precisa do segredo-mestre).
function transacaoPropria(url) {
  return async (fn) => {
    const local = /localhost|127\.0\.0\.1/.test(url);
    const c = new Client({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });
    await c.connect();
    try {
      await c.query(`SET search_path TO ${config.ESQUEMA}`);
      const { rows } = await c.query("SELECT current_setting('search_path') AS sp");
      if (rows[0].sp !== config.ESQUEMA) throw new Error('conexão fora do esquema da TICK');
      await c.query('BEGIN');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await c.end().catch(() => {});
    }
  };
}

// A tarefa agendada não liga o módulo (sem TRIMUNDI_ATIVA nem o segredo):
// lê o banco direto — o mesmo da Mostraí, no esquema da TICK.
const urlDoBancoDaSentinela = () => process.env.TRIMUNDI_DATABASE_URL || process.env.DATABASE_URL || '';

async function rodar({ base = config.urlDoSite(), url = urlDoBancoDaSentinela(), espera } = {}) {
  if (!base) throw new Error('SITE_URL vazio: não sei qual site conferir');
  const falhas = await checarAlvos(base, { espera });
  let resultado;
  try {
    resultado = await alertas.processar(transacaoPropria(url), 'sentinela', falhas);
  } catch (err) {
    // Sem banco não dá para lembrar o que já foi avisado: avisa assim mesmo
    // (melhor e-mail repetido do que site fora sem ninguém saber).
    if (!falhas.length) throw err;
    console.error('trimundi: sentinela — sem o registro dos alertas, avisando direto:', err.message);
    const r = await alertas.enviar({ novos: falhas, lembretes: [], resolvidos: [] });
    resultado = { enviado: true, assunto: r.assunto, sem_registro: true };
  }
  return { falhas, resultado };
}

module.exports = { checarAlvos, rodar, ALVOS, urlDoBancoDaSentinela };

if (require.main === module) {
  require('dotenv').config();
  rodar()
    .then(({ falhas, resultado }) => {
      if (!falhas.length) console.log('trimundi: sentinela — tudo respondendo');
      for (const f of falhas) console.error(`trimundi: sentinela — FALHA: ${f.texto}`);
      if (resultado?.enviado)
        console.log(`trimundi: sentinela — alerta enviado (${resultado.assunto || resultado.enviado})`);
      process.exit(falhas.length ? 1 : 0);
    })
    .catch((err) => {
      console.error('trimundi: sentinela — a conferência falhou:', err.message);
      process.exit(1);
    });
}
