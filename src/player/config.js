const { operacaoDoPonto } = require('../lib/operacao-tela');

// Corpo de GET /player/:dispositivoId/config (docs/player-mvp-contract.md
// §6): margens da tela, bloco `operacao` e o PIN de saída global. Nada
// além disso — orientação, URL do servidor e intervalo do heartbeat são
// fixos no APK.
//
// PLAYER SEMPRE ATIVO (08/10/2026, decisão do dono): TV ligada + Player
// saudável = reprodução contínua. O APK apaga (cartão local, estado
// OUT_OF_SCHEDULE) fora do `operacao` que recebe — era o horário do ponto, ou
// o do compromisso da tela móvel, e o comércio aberto mais cedo, mais tarde
// ou fora do habitual ficava com a TV ligada sem anúncio. Agora `operacao` é
// SEMPRE o dia inteiro (o mesmo bloco de ponto sem horário, que o APK já
// entende): o Player nunca para por horário, agenda ou compromisso. O
// horário continua valendo no backend como informação operacional e
// comercial (obrigação por minutos abertos, "fora do horário" na ficha, a
// atenção de sem comunicação) — só deixou de ser liga/desliga da TV.
// Montado da MESMA linha lida do banco: versão e conteúdo nunca vêm de
// leituras diferentes (o Player grava a versão depois de aplicar o corpo).
function montarConfig(tela, pinSaida, agora = new Date()) {
  return {
    configVersion: tela.config_versao_desejada,
    margens: margensDaTela(tela),
    operacao: operacaoDoPonto(null, agora),
    pinSaida: pinSaida || null,
  };
}

// Área segura, em vmin, 0 a 10 por lado (RN-17; validado na escrita em
// src/dispositivos/routes.js). O teto aqui protege o Player de linha antiga
// gravada antes do limite.
const TETO_MARGEM = 10;
function margensDaTela(tela) {
  const lado = (v) => Math.min(Math.max(Number(v) || 0, 0), TETO_MARGEM);
  return {
    superior: lado(tela.margem_superior),
    direita: lado(tela.margem_direita),
    inferior: lado(tela.margem_inferior),
    esquerda: lado(tela.margem_esquerda),
  };
}

module.exports = { montarConfig, margensDaTela, TETO_MARGEM };
