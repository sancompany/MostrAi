#!/usr/bin/env node
// Runner da apuração mensal do banco de horas. A lógica mora em
// src/bancohoras/apuracao.js — a Lei 1 não deixa regra de negócio morar
// em scripts/.
//
// Rodar uma vez por mês, no dia 1 (cron job no Northflank): `npm run
// apurar-banco-horas`. dotenv como o migrate.js e o conciliar.js já
// fazem: sem isso, rodado à mão ou por cron local, o script não vê o
// .env.
require('dotenv').config();
const { apurarMesAnterior, aplicarValvula } = require('../src/bancohoras/apuracao');

apurarMesAnterior()
  .then(async (r) => {
    console.log(
      `banco de horas: mês ${r.mesApurado.toISOString().slice(0, 10)} · ` +
        `${r.anunciantesComDeficit} anunciantes com déficit · ${r.novasLinhas} linhas novas`,
    );
    const v = await aplicarValvula();
    console.log(`válvula: ${v.linhasMovidas} linha(s) passaram de ${v.meses} meses sem drenar — na fila do admin`);
    process.exit(0);
  })
  .catch((err) => {
    console.error('apuração do banco de horas abortou:', err.message);
    process.exit(1);
  });
