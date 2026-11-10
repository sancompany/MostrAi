// Termos de Uso e Política de Privacidade da Trimundi (pedido do dono,
// 10/11/2026). A versão sobe a cada mudança relevante do texto: quem aceitou
// a anterior aceita de novo antes da próxima compra (as versões antigas
// ficam no histórico do git). O contato é o canal do titular.

const VERSAO = '1.0';
const VIGENCIA = '10/11/2026';

function contato() {
  return (
    process.env.TRIMUNDI_EMAIL_CONTATO ||
    process.env.MOSTRAI_EMAIL_CONTATO ||
    process.env.MOSTRAI_EMAIL_FROM ||
    ''
  ).trim();
}

module.exports = { VERSAO, VIGENCIA, contato };
