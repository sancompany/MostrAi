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
const { reavaliarTodos } = require('../src/indicacoes/aplicar');
const { ativarBeneficiosAgendados, encerrarBeneficiosVencidos } = require('../src/financeiro/plano-administrativo');
const comecouEm = new Date();

conciliarAssinaturas()
  .then(async (r) => {
    console.log(
      `conciliação: ${r.verificadas} verificadas · ${r.aplicadas} ciclos aplicados · ` +
        `${r.jaProcessadas} já processadas pelo webhook · ${r.semCobranca} sem cobrança confirmada`,
    );
    for (const f of r.falhas) console.error(`  falhou ${f.assinaturaId}: ${f.erro}`);

    // Upgrade de tier por indicação (migration 062) que ficou pendente
    // porque o dono do ponto ainda pagava o próprio plano na hora em que
    // ganhou o crédito — aqui é onde ele entra sozinho, assim que esse plano
    // vencer. Falha aqui não é motivo pra marcar a conciliação de assinatura
    // (que já rodou e já teve seu próprio código de saída) como abortada.
    try {
      const ind = await reavaliarTodos();
      console.log(`indicações: ${ind.verificadas} contas com crédito · ${ind.aplicados} upgrade(s) aplicado(s)`);
    } catch (err) {
      console.error('reavaliação de upgrades por indicação falhou:', err.message);
    }

    // Ciclo de vida do benefício por créditos (migration 079): encerra o
    // benefício vencido ANTES de ativar o agendado — um benefício que acaba
    // de vencer libera exatamente a vaga que o `idx_planos_admin_um_ativo`
    // exige pra outro entrar no lugar. A ordem importa.
    try {
      const enc = await encerrarBeneficiosVencidos();
      console.log(`benefícios: ${enc.verificados} vencidos verificados · ${enc.encerrados} encerrado(s)`);
      const ativ = await ativarBeneficiosAgendados();
      console.log(`benefícios: ${ativ.verificados} agendados verificados · ${ativ.ativados} ativado(s)`);
    } catch (err) {
      console.error('ciclo de vida de benefícios por créditos falhou:', err.message);
    }

    process.exit(r.falhas.length ? 1 : 0);
  })
  .catch(async (err) => {
    // Abortar inteiro também é notícia: sem isto, o admin veria a última
    // execução bem-sucedida de ontem e concluiria que hoje correu tudo bem.
    console.error('conciliação abortou:', err.message);
    await registrarRelato(comecouEm, {}, err.message);
    process.exit(1);
  });
