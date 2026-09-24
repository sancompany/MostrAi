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
    margens: margensDaTela(tela),
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
// compatibilidade com o V1 (contrato §4.3).
function margensDaTela(tela) {
  return {
    superior: Number(tela.margem_superior) || 0,
    direita: Number(tela.margem_direita) || 0,
    inferior: Number(tela.margem_inferior) || 0,
    esquerda: Number(tela.margem_esquerda) || 0,
  };
}

module.exports = { montarConfig, margensDaTela };
