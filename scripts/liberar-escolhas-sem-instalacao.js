#!/usr/bin/env node
// Correção D2 da ADR-047 (14/10/2026): libera a escolha que um anunciante
// gravou num ponto que NUNCA foi instalado e avisa a conta pela central de
// atualizações. A lógica mora em src/pontos/repository.js
// (liberarEscolhasSemInstalacao) — a Lei 1 não deixa regra de negócio morar
// em scripts/. Roda à mão, uma vez, depois do deploy (backup antes: apagar a
// escolha não se desfaz).
//
//   npm run liberar-escolhas-sem-instalacao              # só lista; nada gravado
//   npm run liberar-escolhas-sem-instalacao -- --aplicar # apaga e notifica
//
// Saída: JSON só com ids e contagens (nunca nome, e-mail ou documento) ·
// código 0 = ok · 1 = falhou (nada pela metade: uma transação só) ·
// 2 = argumento inválido. Rodar de novo encontra 0. dotenv como os outros
// scripts: à mão vê o .env; em produção as variáveis vêm do ambiente.
require('dotenv').config();
const pool = require('../src/db/pool');
const { liberarEscolhasSemInstalacao } = require('../src/pontos/repository');

// O aviso em tempo real sai pelo pool (pg_notify) sem esperar resposta: antes
// de fechar o pool, espera a fila dele esvaziar, senão o NOTIFY fica para
// trás e o painel aberto não fica sabendo. Teto de 2 s — é só um aviso.
async function esperarAvisosSairem() {
  for (let i = 0; i < 100 && (pool.waitingCount > 0 || pool.idleCount < pool.totalCount); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function principal() {
  const args = process.argv.slice(2);
  const desconhecido = args.find((a) => a !== '--aplicar');
  if (desconhecido) {
    console.error(`argumento desconhecido: ${desconhecido} (use --aplicar para gravar)`);
    return 2;
  }
  const resultado = await liberarEscolhasSemInstalacao({ aplicar: args.includes('--aplicar') });
  console.log(JSON.stringify(resultado));
  await esperarAvisosSairem();
  return 0;
}

principal()
  .catch((err) => {
    console.error('liberar escolhas: execução abortou (nada gravado):', err.message);
    return 1;
  })
  .then(async (codigo) => {
    await pool.end().catch((err) => console.error('liberar escolhas: falha ao fechar o pool:', err.message));
    process.exit(codigo);
  });
