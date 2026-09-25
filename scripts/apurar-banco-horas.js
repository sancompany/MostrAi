#!/usr/bin/env node
// Runner do job ApuracaoBancoHoras. A lógica mora em
// src/bancohoras/apuracao.js — a Lei 1 não deixa regra de negócio morar em
// scripts/. Especificação do job no Northflank (cron, variáveis, primeira
// execução): docs/job-apuracao-banco-horas.md.
//
//   npm run apurar-banco-horas                 # liquida + apura o mês anterior (Matão)
//   npm run apurar-banco-horas -- --dry-run    # só calcula e mostra; não grava nada
//   npm run apurar-banco-horas -- --mes=2026-08
//
// Saída: 0 = ok · 1 = falhou (nada pela metade: cada conta liquida numa
// transação, e apurar de novo o mesmo mês não duplica) · 2 = argumento
// inválido · 3 = outra execução em andamento (trava do Postgres).
//
// O log nunca imprime DATABASE_URL nem dado pessoal: só ids de conta e
// números. dotenv como o migrate.js e o conciliar.js: rodado à mão, o script
// vê o .env; em produção as variáveis vêm do ambiente.
require('dotenv').config();
const pool = require('../src/db/pool');
const { apurarMes, liquidarBancoConfirmado, registrarExecucao } = require('../src/bancohoras/apuracao');

// Chave da trava: fixa e só deste job (pg_try_advisory_lock é por sessão).
const TRAVA = 90_2026_09;

function lerArgumentos(argv) {
  const opcoes = { simular: false, mes: null };
  for (const arg of argv) {
    if (arg === '--dry-run') opcoes.simular = true;
    else if (arg.startsWith('--mes=')) opcoes.mes = arg.slice('--mes='.length);
    else return { erro: `argumento desconhecido: ${arg}` };
  }
  if (opcoes.mes !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(opcoes.mes)) {
    return { erro: `--mes precisa ser AAAA-MM (recebido: ${opcoes.mes})` };
  }
  return opcoes;
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2));
  if (opcoes.erro) {
    console.error(opcoes.erro);
    return 2;
  }
  const comecouEm = new Date();
  const sessao = await pool.connect();
  try {
    const {
      rows: [{ ok }],
    } = await sessao.query('SELECT pg_try_advisory_lock($1) AS ok', [TRAVA]);
    if (!ok) {
      console.error('banco de horas: outra execução está em andamento — nada feito');
      return 3;
    }
    const modo = opcoes.simular ? ' (simulação: nada gravado)' : '';
    let liquidacao = {};
    let apuracao = {};
    try {
      // Apuração primeiro: um --mes ainda aberto é recusado antes de qualquer
      // escrita. As duas etapas são independentes e idempotentes — rodar de
      // novo depois de uma falha no meio termina o que faltou.
      apuracao = await apurarMes({ mes: opcoes.mes, simular: opcoes.simular });
      console.log(
        `banco de horas${modo}: mês ${apuracao.mesApurado.slice(0, 7)} · ` +
          `${apuracao.anunciantesComDeficit} conta(s) com déficit · ${apuracao.exibicoesDevidas} exibição(ões) devida(s) · ` +
          `${apuracao.novasLinhas} linha(s) nova(s)`,
      );
      liquidacao = await liquidarBancoConfirmado({ simular: opcoes.simular });
      console.log(
        `banco de horas${modo}: ${liquidacao.linhas} hora(s) liquidada(s) em ${liquidacao.contas} conta(s) · ` +
          `${liquidacao.exibicoesAbatidas} exibição(ões) confirmada(s) abatida(s) do saldo`,
      );
      if (!opcoes.simular) await registrarExecucao(comecouEm, { apuracao, liquidacao });
      return 0;
    } catch (err) {
      if (err.argumentoInvalido) {
        console.error(`banco de horas: ${err.message}`);
        return 2;
      }
      console.error('banco de horas: execução abortou:', err.message);
      if (!opcoes.simular) await registrarExecucao(comecouEm, { apuracao, liquidacao, abortou: err.message });
      return 1;
    } finally {
      await sessao.query('SELECT pg_advisory_unlock($1)', [TRAVA]);
    }
  } finally {
    sessao.release();
  }
}

principal()
  .catch((err) => {
    console.error('banco de horas: falha antes de começar:', err.message);
    return 1;
  })
  .then(async (codigo) => {
    await pool.end().catch(() => {});
    process.exit(codigo);
  });
