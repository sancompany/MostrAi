#!/usr/bin/env node
// Runner da conciliação diária. A lógica mora em src/financeiro/conciliacao.js
// — a Lei 1 não deixa regra de negócio morar em scripts/.
//
// Rodar uma vez por dia (cron job no Northflank): `npm run conciliar`.
// Sai com código 1 se alguma assinatura falhou, pra que o agendador avise.
const { conciliarAssinaturas } = require('../src/financeiro/conciliacao');

conciliarAssinaturas()
  .then((r) => {
    console.log(`conciliação: ${r.verificadas} verificadas · ${r.aplicadas} ciclos aplicados · ` +
      `${r.jaProcessadas} já processadas pelo webhook · ${r.semCobranca} sem cobrança confirmada`);
    for (const f of r.falhas) console.error(`  falhou ${f.assinaturaId}: ${f.erro}`);
    process.exit(r.falhas.length ? 1 : 0);
  })
  .catch((err) => {
    console.error('conciliação abortou:', err.message);
    process.exit(1);
  });
