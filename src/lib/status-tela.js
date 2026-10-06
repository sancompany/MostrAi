const { operacaoDoPonto, deveriaOperar } = require('./operacao-tela');

// ESTADO DA TELA — a régua ÚNICA do backend (Player V2, 23/09/2026; refeita
// na estação Rede Front V3, 06/10/2026). Três perguntas que NÃO se misturam:
//
//   administrativo  ativa · em_reparo · inativa — o cadastro, do Admin; nunca
//                   muda por heartbeat.
//   conectividade   comunicando · sem_comunicacao · sem_player — a Mostraí
//                   fala com a tela agora? (heartbeat dentro da tolerância).
//                   SEM COMUNICAÇÃO NÃO É PROBLEMA: a TV pode estar desligada,
//                   sem internet, com o Player fechado ou o comércio fechado —
//                   o backend não sabe qual, e não chama de "erro" o que não sabe.
//   operacao        exibindo · fora_do_horario · sem_alocacao · erro ·
//                   desconhecida — o que a tela deveria estar fazendo / diz
//                   que está fazendo. Rede MÓVEL não tem horário próprio: sem
//                   compromisso em curso a tela está SEM ALOCAÇÃO — nenhuma
//                   operação é esperada (nunca "24 h"); com compromisso, vale o
//                   horário dele.
//
// Em cima disso, dois sinais:
//   problema   EVIDÊNCIA de erro, e só com a tela comunicando: estado/erro do
//              Player (PLAYBACK_ERROR, DOWNLOAD_ERROR, AUTH_ERROR, CONFIG_ERROR,
//              NO_PLAYLIST ou erro relatado), fila de comprovantes crítica,
//              configuração travada há mais de 15 min. Heartbeat ausente nunca.
//   atencao    vale olhar, mas não é erro: sem comunicação DURANTE o horário
//              em que deveria operar, fila de comprovantes alta, instalação
//              atrasada.
// e um `resumo` (uma etiqueta, a mesma em card, filtro, contador e ficha):
//   em_reparo · inativa · aguardando_instalacao · com_problema ·
//   sem_comunicacao · sem_alocacao · fora_do_horario · operando
//
// Saúde é DERIVADA, nunca gravada, e só este arquivo classifica — o Admin, a
// Visão geral, "Meus pontos" do dono e o painel do anunciante leem daqui. O
// Player reporta fato, a classificação é do backend (docs/player-mvp-contract.md
// §9). A instalação conta como primeiro sinal
// (src/dispositivos/repository.js#trocarCodigoPorCredencial).

// Heartbeat a cada 15 s e "sem comunicação" depois de 2 min (8 batidas):
// régua única em src/lib/heartbeat.js, a mesma do tempo operacional
// (src/player/operacao.js).
const { TOLERANCIA_SEM_SINAL_MS } = require('./heartbeat');
// Alteração de config chega na próxima batida (15 s) + GET /config. Até 2 min
// é "sincronizando"; problema só se passar de 15 min com a tela comunicando.
const CONFIG_PENDENTE_APOS_MS = 2 * 60 * 1000;
const CONFIG_ALERTA_APOS_MS = 15 * 60 * 1000;
const PRAZO_INSTALACAO_MS = 7 * 24 * 3600 * 1000;
// Contrato §9.3.
const FILA_ATENCAO = 2000;
const FILA_ALERTA = 10000;
const FILA_ANTIGA_MS = 48 * 3600 * 1000;

const ESTADOS_DE_ERRO = new Set(['PLAYBACK_ERROR', 'DOWNLOAD_ERROR', 'AUTH_ERROR', 'CONFIG_ERROR', 'NO_PLAYLIST']);
// O motivo do problema em português (o código do Player fica no detalhe).
const MOTIVO_DO_ERRO = {
  PLAYBACK_ERROR: 'Falha de reprodução',
  DOWNLOAD_ERROR: 'Falha ao baixar mídia',
  AUTH_ERROR: 'Falha de autenticação do Player',
  CONFIG_ERROR: 'Falha ao aplicar a configuração',
  NO_PLAYLIST: 'Sem playlist',
};

const ms = (v) => (v ? new Date(v).getTime() : null);
const ADMINISTRATIVO = { ativo: 'ativa', reparo: 'em_reparo', inativo: 'inativa' };

// Tela de REDE MÓVEL sem compromisso em curso. A linha vem do SELECT_TELA
// (src/dispositivos/repository.js: `ponto_tipo`, `movel_alocado`) ou de quem
// monta a ficha da rede (src/pontos/movel.js) — o único lugar que decide.
const semAlocacao = (tela) => tela.ponto_tipo === 'movel' && !tela.movel_alocado;

const temErroDoPlayer = (tela) =>
  Boolean(tela.ultimo_erro_codigo || tela.ultimo_erro || ESTADOS_DE_ERRO.has(tela.player_estado));

// O código do erro só vale quando é um dos conhecidos; o Player pode mandar
// um código próprio (PLAYBACK_FALHOU) junto do estado PLAYBACK_ERROR — aí o
// estado diz o motivo (docs/player-mvp-contract.md §9).
function motivoDoErro(tela) {
  const codigo = MOTIVO_DO_ERRO[tela.ultimo_erro_codigo] ? tela.ultimo_erro_codigo : tela.player_estado;
  return MOTIVO_DO_ERRO[codigo] || 'Erro relatado pelo Player';
}

// O estado canônico (ver o topo). `horario`: o horário em vigor na tela — o
// do ponto fixo, ou o do compromisso da tela móvel (`null` no fixo = ponto
// antigo sem horário = dia inteiro, compatibilidade histórica; na tela móvel
// alocada = "operar continuamente durante o período", escolha explícita do
// compromisso). Tela móvel sem compromisso ignora o horário: não opera.
function estadoDaTela(tela, horario, agora = new Date()) {
  const administrativo = ADMINISTRATIVO[tela.status] || tela.status;
  const ultimo = ms(tela.ultima_vez_online);
  const recente = ultimo != null && agora.getTime() - ultimo <= TOLERANCIA_SEM_SINAL_MS;
  const conectividade = !tela.chave_hash ? 'sem_player' : recente ? 'comunicando' : 'sem_comunicacao';
  const movelSemAlocacao = semAlocacao(tela);
  const noHorario = !movelSemAlocacao && deveriaOperar(operacaoDoPonto(horario, agora), agora);
  const ativa = administrativo === 'ativa';
  // Operação ESPERADA agora: ativa, com Player, alocada (se móvel) e no horário.
  const esperadaAgora = ativa && conectividade !== 'sem_player' && noHorario;

  let operacao = 'desconhecida';
  if (movelSemAlocacao) operacao = 'sem_alocacao';
  else if (conectividade === 'comunicando') {
    if (temErroDoPlayer(tela)) operacao = 'erro';
    else if (tela.player_estado === 'OUT_OF_SCHEDULE' || !noHorario) operacao = 'fora_do_horario';
    else operacao = 'exibindo';
  } else if (!noHorario) operacao = 'fora_do_horario';

  const alertas = ativa ? alertasDaTela(tela, { conectividade, esperadaAgora, operacao }, agora) : [];
  const problema = alertas.find((a) => a.nivel === 'alerta') || null;
  const atencao = alertas.find((a) => a.nivel === 'atencao') || null;

  let resumo;
  if (administrativo === 'em_reparo' || administrativo === 'inativa') resumo = administrativo;
  else if (conectividade === 'sem_player') resumo = 'aguardando_instalacao';
  else if (problema) resumo = 'com_problema';
  else if (conectividade === 'sem_comunicacao') resumo = 'sem_comunicacao';
  else if (operacao === 'sem_alocacao') resumo = 'sem_alocacao';
  else if (operacao === 'fora_do_horario') resumo = 'fora_do_horario';
  else resumo = 'operando';

  return {
    administrativo,
    conectividade,
    operacao,
    esperadaAgora,
    resumo,
    problema,
    atencao,
    alertas,
    ultimoSinal: tela.chave_hash ? tela.ultima_vez_online || null : null,
  };
}

// A etiqueta única (o `resumo` acima) — o campo `saude` das respostas.
function saudeDaTela(tela, horario, agora = new Date()) {
  return estadoDaTela(tela, horario, agora).resumo;
}

// Para o DONO do ponto e o anunciante: o que importa para ele agora. Fora do
// horário a TV desligada não é aviso nenhum; sem comunicação DURANTE o horário
// é atenção (ele pode conferir a internet/a TV); problema é problema.
function situacaoPublica(estado) {
  if (['em_reparo', 'inativa', 'aguardando_instalacao', 'com_problema'].includes(estado.resumo)) return estado.resumo;
  if (estado.operacao === 'sem_alocacao') return 'sem_alocacao';
  if (estado.conectividade === 'sem_comunicacao') return estado.esperadaAgora ? 'sem_comunicacao' : 'fora_do_horario';
  return estado.resumo;
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

// Os alertas da tela ATIVA. `alerta` = problema (evidência de erro, só com a
// tela comunicando — dado de uma tela calada pode ser velho); `atencao` = vale
// olhar. Sem comunicação nunca é `alerta`.
function alertasDaTela(tela, { conectividade, esperadaAgora, operacao }, agora = new Date()) {
  const alertas = [];
  if (conectividade === 'sem_player') {
    if (agora.getTime() - ms(tela.created_at) > PRAZO_INSTALACAO_MS) {
      alertas.push({ codigo: 'INSTALACAO_ATRASADA', nivel: 'atencao', motivo: 'Instalação atrasada' });
    }
    return alertas;
  }
  if (conectividade === 'comunicando') {
    if (temErroDoPlayer(tela)) alertas.push({ codigo: 'ERRO_PLAYER', nivel: 'alerta', motivo: motivoDoErro(tela) });
    const fila = situacaoFila(tela, agora);
    if (fila === 'critica') {
      alertas.push({ codigo: 'FILA_CRITICA', nivel: 'alerta', motivo: 'Comprovantes acumulados no Player' });
    } else if (fila === 'atencao') {
      alertas.push({ codigo: 'FILA_ALTA', nivel: 'atencao', motivo: 'Fila de comprovantes alta' });
    }
    if (
      operacao !== 'erro' &&
      situacaoConfig(tela, agora) === 'pendente' &&
      tela.config_alterada_em &&
      agora.getTime() - ms(tela.config_alterada_em) > CONFIG_ALERTA_APOS_MS
    ) {
      alertas.push({ codigo: 'CONFIG_PENDENTE', nivel: 'alerta', motivo: 'Configuração não aplicada' });
    }
  } else if (esperadaAgora) {
    alertas.push({
      codigo: 'SEM_COMUNICACAO_NO_HORARIO',
      nivel: 'atencao',
      motivo: 'Sem comunicação durante o horário de operação',
      desde: tela.ultima_vez_online || null,
    });
  }
  // Problema primeiro (o `find` de estadoDaTela pega o mais grave).
  return alertas.sort((a, b) => (a.nivel === b.nivel ? 0 : a.nivel === 'alerta' ? -1 : 1));
}

module.exports = {
  TOLERANCIA_SEM_SINAL_MS,
  CONFIG_PENDENTE_APOS_MS,
  FILA_ATENCAO,
  FILA_ALERTA,
  ESTADOS_DE_ERRO,
  estadoDaTela,
  saudeDaTela,
  situacaoPublica,
  situacaoConfig,
  situacaoFila,
  alertasDaTela,
};
