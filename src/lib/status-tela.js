const { operacaoDoPonto, deveriaOperar } = require('./operacao-tela');

// Estado da tela em EIXOS SEPARADOS (02/10/2026, Ponto Móvel): um não é
// sinônimo do outro.
//
//   administrativo  ativa / em_reparo / inativa — decidido pelo Admin
//                   (`dispositivos.status`); nunca muda por heartbeat.
//   instalacao      instalada / aguardando_instalacao — há Player com chave?
//   conectividade   conectada / sem_comunicacao — "consigo falar com a tela
//                   AGORA?". Só o heartbeat responde isso.
//   operacao        operando / fora_do_horario / erro / desconhecida — "a
//                   tela está executando o que deveria?".
//
// REGRA CRÍTICA: heartbeat vencido é `sem_comunicacao` e, sozinho, NÃO é
// desligada, fora do ar, erro nem parada. O Player opera offline por dias
// (programação em cache, comprovante e sessões operacionais guardados na TV);
// sem comunicação o servidor simplesmente não sabe a operação de agora:
// `desconhecida`. Quando a TV reconecta, as sessões operacionais
// (src/player/operacao.js) reconstroem o que ela fez offline.
//
// Só este arquivo classifica — admin, Visão geral, "Meus pontos" do dono e o
// "no ar" do anunciante leem daqui, cada um o que é do seu perfil. O Player
// reporta fato; a classificação é do backend (docs/player-mvp-contract.md §9).
//
// `saudeDaTela` é o resumo de uma palavra, na ordem:
//   em_reparo / inativa        estado administrativo
//   aguardando_instalacao      sem Player instalado (nunca instalado, ou revogado)
//   fora_do_horario            o horário do ponto diz fechado, ou o Player diz OUT_OF_SCHEDULE
//   erro_do_player             sinal recente com erro/estado de erro reportado PELO PLAYER
//   sem_comunicacao            deveria operar e não fala há mais que a tolerância
//   operando                   sinal recente, sem erro
// Um erro antigo não sobrevive à falta de comunicação: com o heartbeat
// vencido, o erro que ele trazia já não descreve o agora.

// docs/player-mvp-contract.md §9: heartbeat a cada 15 s; "sem comunicação"
// depois de 2 min (8 batidas perdidas) — tolera uma rede que oscila. É
// tolerância de CONECTIVIDADE, não de operação.
const TOLERANCIA_SEM_SINAL_MS = (Number(process.env.TELA_SEM_SINAL_MIN) || 2) * 60 * 1000;
// Alteração de config chega na próxima batida (15 s) + GET /config. Até 2 min
// é "sincronizando"; alerta só se passar de 15 min.
const CONFIG_PENDENTE_APOS_MS = 2 * 60 * 1000;
const CONFIG_ALERTA_APOS_MS = 15 * 60 * 1000;
const PRAZO_INSTALACAO_MS = 7 * 24 * 3600 * 1000;
// Contrato §9.3.
const FILA_ATENCAO = 2000;
const FILA_ALERTA = 10000;
const FILA_ANTIGA_MS = 48 * 3600 * 1000;

const ESTADOS_DE_ERRO = new Set(['PLAYBACK_ERROR', 'DOWNLOAD_ERROR', 'AUTH_ERROR', 'CONFIG_ERROR', 'NO_PLAYLIST']);
// O que vira alerta para o DONO do ponto: só erro reportado pelo Player.
// Sem comunicação não é alerta para ele — a tela pode estar exibindo offline.
const SITUACOES_DE_ALERTA = new Set(['erro_do_player']);
// O que o ADMIN acompanha na Visão geral: erro e falta de comunicação.
const SITUACOES_DE_ATENCAO_ADMIN = new Set(['erro_do_player', 'sem_comunicacao']);

const ms = (v) => (v ? new Date(v).getTime() : null);

const ADMINISTRATIVO = { ativo: 'ativa', reparo: 'em_reparo', inativo: 'inativa' };

function estadoDaTela(tela, horarioDoPonto, agora = new Date()) {
  const administrativo = ADMINISTRATIVO[tela.status] || 'ativa';
  const instalacao = tela.chave_hash ? 'instalada' : 'aguardando_instalacao';
  if (instalacao !== 'instalada') {
    return { administrativo, instalacao, conectividade: null, operacao: null };
  }

  const ultimo = ms(tela.ultima_vez_online);
  const conectividade =
    ultimo != null && agora.getTime() - ultimo <= TOLERANCIA_SEM_SINAL_MS ? 'conectada' : 'sem_comunicacao';
  if (administrativo !== 'ativa') return { administrativo, instalacao, conectividade, operacao: null };

  // "Fora do horário" é fato do horário do ponto — o servidor sabe sem a TV.
  const foraDoHorario =
    (conectividade === 'conectada' && tela.player_estado === 'OUT_OF_SCHEDULE') ||
    !deveriaOperar(operacaoDoPonto(horarioDoPonto, agora), agora);
  let operacao;
  if (foraDoHorario) operacao = 'fora_do_horario';
  else if (conectividade === 'sem_comunicacao') operacao = 'desconhecida';
  else if (tela.ultimo_erro_codigo || tela.ultimo_erro || ESTADOS_DE_ERRO.has(tela.player_estado)) operacao = 'erro';
  else operacao = 'operando';
  return { administrativo, instalacao, conectividade, operacao };
}

function saudeDaTela(tela, horarioDoPonto, agora = new Date()) {
  const e = estadoDaTela(tela, horarioDoPonto, agora);
  if (e.administrativo !== 'ativa') return e.administrativo;
  if (e.instalacao !== 'instalada') return 'aguardando_instalacao';
  if (e.operacao === 'fora_do_horario') return 'fora_do_horario';
  if (e.operacao === 'erro') return 'erro_do_player';
  if (e.conectividade === 'sem_comunicacao') return 'sem_comunicacao';
  return 'operando';
}

// O que o ANUNCIANTE pode saber de um ponto: só o estado comercial, nunca o
// técnico (heartbeat, comunicação, erro do Player). Um ponto está no ar
// enquanto tem tela ativa e instalada no horário operando — ou cuja operação
// de agora o servidor não conhece (`desconhecida`): perder a comunicação não
// tira o ponto do ar, porque a tela segue exibindo a programação em cache, e
// o comprovante chega quando ela reconectar. Fora do ar é só o que se SABE
// que não veicula: tela em reparo, desligada pelo Admin, sem instalação, ou
// um erro que o próprio Player relatou.
function situacaoComercialDoPonto(telas, agora = new Date()) {
  const estados = telas
    .map((t) => estadoDaTela(t, t.ponto_horario_semanal, agora))
    .filter((e) => e.administrativo === 'ativa' && e.instalacao === 'instalada');
  if (estados.some((e) => e.operacao === 'operando' || e.operacao === 'desconhecida')) return 'no_ar';
  if (estados.some((e) => e.operacao === 'fora_do_horario')) return 'fora_do_horario';
  return 'fora_do_ar';
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

// Alertas técnicos (só o ADMIN vê) do que é operacionalmente relevante —
// nunca de tela fora do horário, em reparo ou inativa (o próprio estado já
// diz o que é). Sem comunicação é ATENÇÃO, não alerta: pode ser só a
// internet do local, com a tela exibindo offline.
function alertasDaTela(tela, saude, agora = new Date()) {
  if (tela.status !== 'ativo' || saude === 'fora_do_horario') return [];
  const alertas = [];
  if (saude === 'sem_comunicacao') alertas.push({ codigo: 'SEM_COMUNICACAO', nivel: 'atencao' });
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
  return alertas;
}

module.exports = {
  TOLERANCIA_SEM_SINAL_MS,
  CONFIG_PENDENTE_APOS_MS,
  FILA_ATENCAO,
  FILA_ALERTA,
  ESTADOS_DE_ERRO,
  SITUACOES_DE_ALERTA,
  SITUACOES_DE_ATENCAO_ADMIN,
  estadoDaTela,
  saudeDaTela,
  situacaoComercialDoPonto,
  situacaoConfig,
  situacaoFila,
  alertasDaTela,
};
