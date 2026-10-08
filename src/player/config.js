const pool = require('../db/pool');
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

// O que ESTE código entregou (migration 118): GET /config grava a versão que
// acabou de servir com o `operacao` do dia inteiro.
async function registrarEntrega(telaId, versao, db = pool) {
  await db.query('UPDATE dispositivos SET config_versao_entregue = $2 WHERE id = $1', [telaId, versao]);
}

// Heartbeat: a TV já aplicou a versão desejada, mas não foi este código que a
// entregou (config de antes do Player sempre ativo, ou servida pelo contêiner
// antigo durante um deploy) → sobe a versão para ela buscar de novo. Só com a
// versão aplicada: enquanto a busca está pendente, não sobe à toa. Devolve a
// versão desejada nova, ou null quando nada mudou.
async function reenviarSeNaoEntregue(telaId, db = pool) {
  const { rows } = await db.query(
    `UPDATE dispositivos SET config_versao_desejada = config_versao_desejada + 1, config_alterada_em = now()
      WHERE id = $1 AND config_versao_aplicada = config_versao_desejada
        AND config_versao_entregue IS DISTINCT FROM config_versao_desejada
      RETURNING config_versao_desejada`,
    [telaId],
  );
  return rows[0]?.config_versao_desejada ?? null;
}

module.exports = { montarConfig, margensDaTela, registrarEntrega, reenviarSeNaoEntregue, TETO_MARGEM };
