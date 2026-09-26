const { operacaoDaTela, deveriaOperar } = require('./operacao-tela');

// Régua ÚNICA de saúde operacional da tela (Player V2, 23/09/2026). Estado
// administrativo (Ativa / Em reparo / Inativa, `dispositivos.status`) é do
// admin e nunca muda por heartbeat; saúde é DERIVADA, nunca gravada, e só
// este arquivo calcula — admin, Visão geral, "Meus pontos" do dono e o status
// do ponto leem daqui. Contrato V2 §10: o Player reporta fato, a
// classificação é do backend.
//
// Ordem de avaliação (docs/player-mvp-contract.md §9):
//   em_reparo / inativa        estado administrativo; nunca alerta
//   aguardando_instalacao      sem Player instalado (nunca instalado, ou revogado)
//   fora_do_horario            o Player diz OUT_OF_SCHEDULE, ou o horário diz fechado
//   sem_sinal                  deveria operar e o último sinal passou da tolerância
//   erro_do_player             sinal recente com erro/estado de erro
//   operando                   sinal recente, sem erro
//
// A instalação conta como primeiro sinal (src/dispositivos/repository.js
// #trocarCodigoPorCredencial): Player instalado que some vira "Sem sinal".
// "Sem sinal" vence um erro antigo: com o último heartbeat vencido, o erro
// que ele trazia já não descreve o agora.

// Contrato §10: "Tolerância sugerida para 'Sem sinal': 3 ciclos (15 min)".
const TOLERANCIA_SEM_SINAL_MS = (Number(process.env.TELA_SEM_SINAL_MIN) || 15) * 60 * 1000;
// Contrato §5 (armadilha de UX): com heartbeat de 5 min, toda alteração fica
// "pendente" por até 5 min, sempre. Só vira pendência depois de 2 ciclos.
const CONFIG_PENDENTE_APOS_MS = 10 * 60 * 1000;
const CONFIG_ALERTA_APOS_MS = 60 * 60 * 1000;
const PRAZO_INSTALACAO_MS = 7 * 24 * 3600 * 1000;
// Contrato §9.3.
const FILA_ATENCAO = 2000;
const FILA_ALERTA = 10000;
const FILA_ANTIGA_MS = 48 * 3600 * 1000;

const ESTADOS_DE_ERRO = new Set(['PLAYBACK_ERROR', 'DOWNLOAD_ERROR', 'AUTH_ERROR', 'CONFIG_ERROR', 'NO_PLAYLIST']);
const SITUACOES_DE_ALERTA = new Set(['sem_sinal', 'erro_do_player']);

const ms = (v) => (v ? new Date(v).getTime() : null);

function saudeDaTela(tela, horarioDoPonto, agora = new Date()) {
  if (tela.status === 'reparo') return 'em_reparo';
  if (tela.status === 'inativo') return 'inativa';
  if (!tela.chave_hash) return 'aguardando_instalacao';

  const ultimo = ms(tela.ultima_vez_online);
  const recente = ultimo != null && agora.getTime() - ultimo <= TOLERANCIA_SEM_SINAL_MS;
  if (recente && tela.player_estado === 'OUT_OF_SCHEDULE') return 'fora_do_horario';
  if (!deveriaOperar(operacaoDaTela(tela, horarioDoPonto, agora), agora)) return 'fora_do_horario';
  if (!recente) return 'sem_sinal';
  if (tela.ultimo_erro_codigo || tela.ultimo_erro || ESTADOS_DE_ERRO.has(tela.player_estado)) return 'erro_do_player';
  return 'operando';
}

// Sem Player instalado a config não é "pendente", é indisponível.
function situacaoConfig(tela, agora = new Date()) {
  if (!tela.chave_hash) return 'indisponivel';
  if (tela.config_versao_aplicada != null && tela.config_versao_aplicada === tela.config_versao_desejada) {
    return 'atualizada';
  }
  const desde = Math.max(ms(tela.config_alterada_em) || 0, ms(tela.provisionado_em) || 0);
  return agora.getTime() - desde < CONFIG_PENDENTE_APOS_MS ? 'sincronizando' : 'pendente';
}

// Comprovantes (proof-of-play) na fila do Player. Desconhecido nunca vira
// zero: antes do primeiro heartbeat com a fila o Player não informou nada.
function situacaoFila(tela, agora = new Date()) {
  if (tela.fila_pendentes == null) return 'desconhecida';
  const antigo = ms(tela.fila_mais_antigo_em);
  if (tela.fila_pendentes > FILA_ALERTA || (antigo != null && agora.getTime() - antigo > FILA_ANTIGA_MS)) {
    return 'critica';
  }
  if (tela.fila_pendentes > FILA_ATENCAO) return 'atencao';
  return 'em_dia';
}

// Alertas só do que é operacionalmente relevante — nunca de tela fora do
// horário, em reparo ou inativa (o próprio estado já diz o que é).
// `releaseObrigatoria`: a release obrigatória ativa mais nova (ou null).
function alertasDaTela(tela, saude, agora = new Date(), releaseObrigatoria = null) {
  if (tela.status !== 'ativo' || saude === 'fora_do_horario') return [];
  const alertas = [];
  if (saude === 'sem_sinal') alertas.push({ codigo: 'SEM_SINAL', nivel: 'alerta' });
  if (saude === 'erro_do_player') alertas.push({ codigo: 'ERRO_PLAYER', nivel: 'alerta' });
  if (saude === 'aguardando_instalacao' && agora.getTime() - ms(tela.created_at) > PRAZO_INSTALACAO_MS) {
    alertas.push({ codigo: 'INSTALACAO_ATRASADA', nivel: 'atencao' });
  }
  const fila = situacaoFila(tela, agora);
  if (fila === 'critica') alertas.push({ codigo: 'FILA_CRITICA', nivel: 'alerta' });
  else if (fila === 'atencao') alertas.push({ codigo: 'FILA_ALTA', nivel: 'atencao' });
  if (
    saude === 'operando' &&
    situacaoConfig(tela, agora) === 'pendente' &&
    agora.getTime() - ms(tela.config_alterada_em) > CONFIG_ALERTA_APOS_MS
  ) {
    alertas.push({ codigo: 'CONFIG_PENDENTE', nivel: 'atencao' });
  }
  if (
    releaseObrigatoria &&
    tela.player_build != null &&
    tela.player_build < releaseObrigatoria.build &&
    agora.getTime() - ms(releaseObrigatoria.assinatura_conferida_em) > 24 * 3600 * 1000
  ) {
    alertas.push({ codigo: 'UPDATE_OBRIGATORIO_ATRASADO', nivel: 'atencao' });
  }
  return alertas;
}

module.exports = {
  TOLERANCIA_SEM_SINAL_MS,
  CONFIG_PENDENTE_APOS_MS,
  FILA_ATENCAO,
  FILA_ALERTA,
  ESTADOS_DE_ERRO,
  SITUACOES_DE_ALERTA,
  saudeDaTela,
  situacaoConfig,
  situacaoFila,
  alertasDaTela,
};
