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
const { ativarBeneficiosAgendados, encerrarBeneficiosVencidos } = require('../src/financeiro/plano-administrativo');
const { concederCreditosMensais } = require('../src/creditos/ponto');
const { liquidarBancoConfirmado } = require('../src/bancohoras/apuracao');
const { anonimizarExcluidas } = require('../src/titular/repository');
const comecouEm = new Date();

conciliarAssinaturas()
  .then(async (r) => {
    console.log(
      `conciliação: ${r.verificadas} verificadas · ${r.aplicadas} ciclos aplicados · ` +
        `${r.jaProcessadas} já processadas pelo webhook · ${r.semCobranca} sem cobrança confirmada`,
    );
    for (const f of r.falhas) console.error(`  falhou ${f.assinaturaId}: ${f.erro}`);

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

    // Banco de horas: abate do saldo o que as TVs confirmaram nas horas já
    // fechadas — fechada = passou o prazo de 7 dias do proof-of-play offline
    // (src/bancohoras/apuracao.js). Diário pra que o banco programado e não
    // confirmado volte a ficar disponível assim que o prazo vence, sem
    // esperar o job mensal.
    try {
      const liq = await liquidarBancoConfirmado();
      console.log(
        `banco de horas: ${liq.linhas} hora(s) liquidada(s) em ${liq.contas} conta(s) · ${liq.exibicoesAbatidas} exibição(ões) abatida(s)`,
      );
    } catch (err) {
      console.error('liquidação do banco de horas falhou:', err.message);
    }

    // Crédito mensal do ponto (migration 082): +1 por ponto elegível por mês.
    // Idempotente pelo índice único (ponto, competência) — rodar todo dia só
    // concede quem ficou elegível no mês e ainda não recebeu.
    try {
      const cred = await concederCreditosMensais();
      console.log(
        `créditos de ponto: competência ${cred.competencia} · ${cred.elegiveis} ponto(s) elegível(is) · ${cred.concedidos} crédito(s) novo(s)`,
      );
    } catch (err) {
      console.error('crédito mensal dos pontos falhou:', err.message);
    }

    // Conta excluída há mais de 60 dias perde o dado pessoal (LGPD) — ver
    // src/titular/repository.js#anonimizarExcluidas.
    try {
      const ids = await anonimizarExcluidas();
      if (ids.length) console.log(`contas anonimizadas: ${ids.join(', ')}`);
    } catch (err) {
      console.error('anonimização de contas excluídas falhou:', err.message);
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
