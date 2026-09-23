// Cliente SSE compartilhado da conta logada (Fase 3 da reconstrução do
// painel, 23/09/2026) — GET /conta/eventos. Script global de verdade, sem
// bundler, mesma convenção de config.js/layout.js: incluído uma vez, todo
// módulo de página registra o que quer escutar.
//
// Uso: window.ligarEventosDaConta({ 'credits.updated': refrescarCreditos,
// 'notification.created': refrescarNotificacoes }) — cada evento dispara só
// os handlers registrados pra ELE, nunca um refresh geral da página. O
// payload do evento é sempre leve (tipo/entidade/id) — o handler é quem
// decide o que refazer, normalmente um GET do módulo afetado.
//
// Reconexão: EventSource já reconecta sozinho no navegador (é o motivo de
// SSE em vez de WebSocket aqui — ver src/lib/sse.js). O que o navegador NÃO
// faz sozinho é avisar que perdeu eventos enquanto a conexão caiu, a aba
// ficou em segundo plano, ou a rede oscilou — por isso, além da reconexão,
// este módulo resincroniza (dispara todo handler registrado, de novo) em 3
// gatilhos: a conexão REABRE depois de ter caído, a aba volta ao primeiro
// plano (`visibilitychange`), e a rede volta (`window.online`). Cada
// handler já é, por natureza, um refetch idempotente — repetir nunca
// corrompe nada, só garante que ninguém fica "atrasado" sem saber.
(function () {
  // Conjunto fechado (mesma lista do backend, src/lib/sse.js e quem chama
  // emitirParaConta): criativo, candidatura, ponto, tela, plano, créditos,
  // pagamento, financeiro, conta, notificação.
  const EVENTOS = [
    'creative.updated',
    'application.updated',
    'point.updated',
    'screen.updated',
    'plan.updated',
    'credits.updated',
    'payment.updated',
    'finance.updated',
    'account.updated',
    'notification.created',
  ];

  const handlers = {}; // evento -> Set<fn>
  let fonte = null;
  let abriuAntes = false;

  function disparar(evento) {
    (handlers[evento] || new Set()).forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error(`eventos: handler de ${evento} falhou`, err);
      }
    });
  }

  // Deduplica por função, não por evento. Uma página que recarrega tudo com
  // uma função só costuma assiná-la em vários eventos (o painel assina
  // payment/plan/account/application com o mesmo `carregar`). Sem deduplicar,
  // um resync chamava essa função uma vez POR EVENTO — quatro buscas idênticas
  // em paralelo e quatro renders concorrentes a cada volta pra aba.
  function resincronizarTudo() {
    const unicas = new Set();
    Object.values(handlers).forEach((assinantes) => assinantes.forEach((fn) => unicas.add(fn)));
    unicas.forEach((fn) => {
      try {
        fn();
      } catch (err) {
        console.error('eventos: resync de handler falhou', err);
      }
    });
  }

  function abrir() {
    if (fonte) return;
    fonte = new EventSource(`${API_BASE_URL}/conta/eventos`, { withCredentials: true });
    EVENTOS.forEach((evento) => fonte.addEventListener(evento, () => disparar(evento)));
    fonte.addEventListener('open', () => {
      // A primeira abertura não é reconexão — os handlers já rodaram no
      // carregamento normal da página, disparar de novo seria retrabalho.
      if (abriuAntes) resincronizarTudo();
      abriuAntes = true;
    });
    // Sem handler de 'error': EventSource já entra em modo de reconexão
    // sozinho (retry automático do navegador); o resync de verdade acontece
    // no 'open' seguinte, quando a conexão volta.
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resincronizarTudo();
  });
  window.addEventListener('online', resincronizarTudo);

  window.ligarEventosDaConta = function ligarEventosDaConta(mapa) {
    Object.entries(mapa).forEach(([evento, fn]) => {
      if (!EVENTOS.includes(evento)) {
        console.error(`eventos: "${evento}" não é um evento válido`);
        return;
      }
      if (!handlers[evento]) handlers[evento] = new Set();
      handlers[evento].add(fn);
    });
    abrir();
  };
})();
