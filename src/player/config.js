const cofre = require('../lib/cofre');
const { operacaoDaTela } = require('../lib/operacao-tela');

// Corpo de GET /player/:dispositivoId/config (contrato V2 §5). Só campos que
// o Player aplica de fato:
// - `versaoMinimaBuild` (lido, sem efeito) e `cache.tetoMegabytes`
//   (reservado) ficam de fora — nada no admin os alimenta, e mandar valor
//   inventado seria ruído com cara de configuração.
// - Campo ausente = "não mexa" no Player. Por isso o PIN só vai quando
//   existe e decifra: sem ele, o aparelho mantém o que tem.
// Montado da MESMA linha lida do banco: versão e conteúdo nunca vêm de
// leituras diferentes (o Player grava a versão depois de aplicar o corpo).
function montarConfig(tela, agora = new Date()) {
  const config = {
    configVersion: tela.config_versao_desejada,
    margens: margensDaTela(tela, TETO_MARGEM_V2),
    rotacaoTela: tela.rotacao_tela,
    operacao: operacaoDaTela(tela, tela.ponto_horario_semanal, agora),
    update: {
      baixarAutomaticamente: tela.update_baixar_auto,
      horasEntreTentativas: tela.update_horas_entre_tentativas,
    },
  };
  const pin = cofre.abrir(tela.pin_manutencao_cifrado);
  if (pin && /^\d{4}$/.test(pin)) config.pinPainel = pin;
  return config;
}

// Termos visuais, em vmin (RN-17). Também vai no heartbeat, por
// compatibilidade com o V1 (contrato §4.3). O Player V2 aceita 0–10 por lado
// (contrato §5): para ele sai com teto; o player web V1 respeita até 20 e
// recebe o valor gravado (telas antigas podem ter mais de 10 — migration 081).
const TETO_MARGEM_V2 = 10;
function margensDaTela(tela, teto = Number.POSITIVE_INFINITY) {
  const lado = (v) => Math.min(Number(v) || 0, teto);
  return {
    superior: lado(tela.margem_superior),
    direita: lado(tela.margem_direita),
    inferior: lado(tela.margem_inferior),
    esquerda: lado(tela.margem_esquerda),
  };
}

module.exports = { montarConfig, margensDaTela, TETO_MARGEM_V2 };
