const { estaAbertoAgora } = require('./horario-semanal');

// Régua ÚNICA de status operacional da tela (revisão final da Visão Geral,
// 23/09/2026) — antes disto a checagem "sem sinal" (heartbeat > 2h) estava
// duplicada em 4 lugares (src/admin/routes.js x2, public/anunciante/
// painel.page.js x2), nenhum deles olhando o horário de funcionamento: uma
// loja fechada às 18h virava "tela sem sinal" toda noite. Função pura, sem
// I/O — quem chama já buscou a tela e o horário_semanal do ponto dela.
const TOLERANCIA_OFFLINE_MS = 2 * 3600 * 1000; // mesmas 2h de sempre (HORAS_OFFLINE_ALERTA)

// Estados possíveis, na ordem em que são avaliados:
//   em_reparo / inativa             -> status manual da tela, nunca alerta
//   aguardando_primeiro_sinal       -> nunca completou um heartbeat
//   fora_do_horario                 -> não deveria estar online agora
//   sem_sinal                       -> deveria estar online, heartbeat expirou
//   erro_do_player                  -> o player relatou um erro na última chamada
//   operando                        -> tudo certo
function statusOperacionalTela(tela, horarioDoPonto, agora = new Date()) {
  if (tela.status === 'reparo') return 'em_reparo';
  if (tela.status === 'inativo') return 'inativa';
  if (!tela.ultima_vez_online) return 'aguardando_primeiro_sinal';

  const horarioEfetivo = tela.modo_horario === 'personalizado' ? tela.horario_semanal : horarioDoPonto;
  // 24h nunca considera "fora do horário"; sem horário cadastrado (`null` de
  // estaAbertoAgora) também é tratado como "deveria estar online" — não dá
  // pra suprimir alerta por um horário que ninguém preencheu.
  const deveriaEstarOnline = tela.modo_horario === '24h' || estaAbertoAgora(horarioEfetivo, agora) !== false;
  if (!deveriaEstarOnline) return 'fora_do_horario';

  const semSinalHa = agora.getTime() - new Date(tela.ultima_vez_online).getTime();
  if (semSinalHa > TOLERANCIA_OFFLINE_MS) return 'sem_sinal';
  if (tela.ultimo_erro) return 'erro_do_player';
  return 'operando';
}

// O que conta como "precisa de atenção agora" pro alerta da Visão Geral —
// nunca fora_do_horario/aguardando_primeiro_sinal/em_reparo/inativa, que são
// estados esperados ou já sinalizados por outro caminho (a própria situação
// manual da tela).
const SITUACOES_DE_ALERTA = new Set(['sem_sinal', 'erro_do_player']);

module.exports = { statusOperacionalTela, TOLERANCIA_OFFLINE_MS, SITUACOES_DE_ALERTA };
