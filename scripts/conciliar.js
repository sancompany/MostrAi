#!/usr/bin/env node
// Runner da conciliação diária. A lógica mora em src/financeiro/conciliacao.js
// — a Lei 1 não deixa regra de negócio morar em scripts/.
//
// Rodar uma vez por dia (cron job no Northflank): `npm run conciliar`.
// Sai com código 1 se alguma assinatura falhou, pra que o agendador avise.
// dotenv como o migrate.js ja fazia: rodado a mao ou por cron local, o script
// nao enxergava o .env e morria em "no PostgreSQL user name specified". Em
// producao as variaveis vem do ambiente e o dotenv nao acha arquivo nenhum —
// nao muda nada la.
require('dotenv').config();
const { conciliarAssinaturas, registrarRelato } = require('../src/financeiro/conciliacao');
const comecouEm = new Date();

conciliarAssinaturas()
  .then((r) => {
    console.log(`conciliação: ${r.verificadas} verificadas · ${r.aplicadas} ciclos aplicados · ` +
      `${r.jaProcessadas} já processadas pelo webhook · ${r.semCobranca} sem cobrança confirmada`);
    for (const f of r.falhas) console.error(`  falhou ${f.assinaturaId}: ${f.erro}`);
    process.exit(r.falhas.length ? 1 : 0);
  })
  .catch(async (err) => {
    // Abortar inteiro também é notícia: sem isto, o admin veria a última
    // execução bem-sucedida de ontem e concluiria que hoje correu tudo bem.
    console.error('conciliação abortou:', err.message);
    await registrarRelato(comecouEm, {}, err.message);
    process.exit(1);
  });
