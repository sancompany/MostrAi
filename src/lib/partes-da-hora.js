// As partes de uma hora de uma conta numa tela (linha de exibicoes_contador),
// em SQL — um lugar só. A hora pode ter sido programada em três camadas:
//   normal      — plano, compensação, déficit, Básico (vezes_programadas
//                 menos as outras duas);
//   banco       — devolução do atraso do saldo pago (vezes_banco, migration 090);
//   hospedagem  — horas gratuitas do saldo de hospedagem (vezes_hospedagem,
//                 migration 113).
// A confirmação (Proof-of-Play) não diz de qual camada veio; é atribuída por
// POSIÇÃO: primeiro a normal, depois o banco, por último a hospedagem. Assim
// a gratuita é a última a ser considerada entregue e nunca come a entrega
// paga — e uma hora sem banco nem hospedagem dá exatamente o que dava antes.
// `e`: o prefixo da tabela na consulta ('e.' ou '').
const normais = (e) => `(${e}vezes_programadas - ${e}vezes_banco - ${e}vezes_hospedagem)`;

const confirmadasNormaisSql = (e = '') => `LEAST(${e}vezes_confirmadas, ${normais(e)})`;
const confirmadasBancoSql = (e = '') => `LEAST(GREATEST(${e}vezes_confirmadas - ${normais(e)}, 0), ${e}vezes_banco)`;
const confirmadasHospedagemSql = (e = '') =>
  `LEAST(GREATEST(${e}vezes_confirmadas - (${e}vezes_programadas - ${e}vezes_hospedagem), 0), ${e}vezes_hospedagem)`;
// O que conta para o saldo PAGO (obrigação do ciclo): tudo menos a hospedagem.
const confirmadasPagasSql = (e = '') => `LEAST(${e}vezes_confirmadas, ${e}vezes_programadas - ${e}vezes_hospedagem)`;

module.exports = {
  normaisSql: normais,
  confirmadasNormaisSql,
  confirmadasBancoSql,
  confirmadasHospedagemSql,
  confirmadasPagasSql,
};
