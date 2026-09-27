// Carga de dados do admin: uma leitura, um desfecho (estação Admin sem F5,
// 27/09/2026). Arquivo pequeno e sem DOM de propósito — é o que os testes
// exercem em Node (tests/admin-carga.test.js) — e o admin usa pelo
// `window.CargaAdmin`.
//
// O que ele resolve (causas reais achadas na investigação):
//   1. SESSÃO DO CLOUDFLARE ACCESS VENCIDA. Todo /admin/* passa pelo Access;
//      sem o cookie dele, a API responde 302 pro login em
//      cloudflareaccess.com. O fetch seguia o redirect, esbarrava no CORS e
//      virava "sem conexão" — o botão Atualizar repetia a mesma falha pra
//      sempre, e só o F5 (uma navegação) passava pelo login. Agora o GET não
//      segue redirect (`redirect: 'manual'`): o 302 vira `opaqueredirect` e o
//      erro diz o que é ("sessão de acesso expirou"), com o caminho certo.
//   2. REQUISIÇÃO SEM PRAZO. Uma leitura pendurada deixava "Carregando..."
//      pra sempre. Agora todo GET tem prazo (PRAZO_MS) e vira erro
//      recuperável.
//   3. RESPOSTA VELHA POR CIMA DA TELA NOVA. Trocar de rota ou clicar
//      Atualizar de novo não cancelava a leitura anterior: a que voltasse
//      por último desenhava — às vezes a da rota que a pessoa já tinha
//      deixado. Agora cada navegação é uma GERAÇÃO com o próprio
//      AbortController: a nova cancela a anterior, e quem desenha confere
//      se ainda é a geração vigente.
(() => {
  const PRAZO_MS = 20000;
  const ESPERA_RETRY_MS = 700;

  // Erro de leitura com o que a tela precisa pra decidir o desfecho.
  //   status 0   → rede (sem resposta)
  //   status 401 → sessão (do admin ou do Access — `acesso: true`)
  //   `cancelada` → a navegação mudou; ninguém mostra nada
  //   `tempoEsgotado` → passou do prazo
  class ErroApi extends Error {
    constructor(status, corpo, extras = {}) {
      super(corpo?.erro || `erro ${status}`);
      this.status = status;
      Object.assign(this, extras);
    }
  }

  // Combina o sinal da navegação com o prazo. `AbortSignal.any` quando existe
  // (Chrome 116+, Safari 17.4+, Node 20+); senão, um controller que repassa.
  function sinalCombinado(sinalNavegacao, prazoMs) {
    const prazo = AbortSignal.timeout(prazoMs);
    if (!sinalNavegacao) return prazo;
    if (typeof AbortSignal.any === 'function') return AbortSignal.any([sinalNavegacao, prazo]);
    const c = new AbortController();
    const repassar = (s) => () => c.abort(s.reason);
    if (sinalNavegacao.aborted) c.abort(sinalNavegacao.reason);
    sinalNavegacao.addEventListener('abort', repassar(sinalNavegacao), { once: true });
    prazo.addEventListener('abort', repassar(prazo), { once: true });
    return c.signal;
  }

  // GET com JSON. `fetchFn` injetável (teste). Nova tentativa UMA vez, só pro
  // que reenviar pode resolver: rede caiu, 5xx, 429. Nunca pra 401/403/404,
  // cancelamento ou prazo esgotado (esperar de novo 20 s não é conserto).
  async function pegarJson(url, { fetchFn = fetch, sinal = null, prazoMs = PRAZO_MS, tentativas = 1 } = {}) {
    let resposta;
    try {
      resposta = await fetchFn(url, {
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        redirect: 'manual',
        signal: sinalCombinado(sinal, prazoMs),
      });
    } catch (err) {
      if (sinal?.aborted) throw new ErroApi(0, { erro: 'leitura cancelada' }, { cancelada: true });
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new ErroApi(0, { erro: 'o servidor demorou demais pra responder' }, { tempoEsgotado: true });
      }
      if (tentativas > 0) {
        await new Promise((r) => setTimeout(r, ESPERA_RETRY_MS));
        return pegarJson(url, { fetchFn, sinal, prazoMs, tentativas: tentativas - 1 });
      }
      throw new ErroApi(0, { erro: 'sem conexão com o servidor' });
    }
    if (resposta.type === 'opaqueredirect' || (resposta.status >= 300 && resposta.status < 400)) {
      throw new ErroApi(401, { erro: 'sua sessão de acesso ao admin expirou' }, { acesso: true });
    }
    if (!resposta.ok) {
      const corpo = await resposta.json().catch(() => ({}));
      if (tentativas > 0 && (resposta.status >= 500 || resposta.status === 429)) {
        await new Promise((r) => setTimeout(r, ESPERA_RETRY_MS));
        return pegarJson(url, { fetchFn, sinal, prazoMs, tentativas: tentativas - 1 });
      }
      throw new ErroApi(resposta.status, corpo);
    }
    return resposta.json();
  }

  // Gerações de navegação: `nova()` cancela as leituras da anterior e
  // devolve o número desta; `vigente(g)` diz se `g` ainda é a tela da vez.
  function criarNavegacao() {
    let geracao = 0;
    let controle = new AbortController();
    return {
      nova() {
        controle.abort();
        controle = new AbortController();
        geracao += 1;
        return geracao;
      },
      vigente: (g) => g === geracao,
      get sinal() {
        return controle.signal;
      },
      get geracao() {
        return geracao;
      },
    };
  }

  // O desfecho de uma falha, pra tela: que texto mostrar e o que oferecer.
  //   acao 'entrar'   → a sessão caiu: entrar de novo (nunca "tentar de novo")
  //   acao 'nenhuma'  → sem permissão: repetir não muda nada
  //   acao 'tentar'   → erro recuperável: [Tentar novamente]
  //   null            → leitura cancelada: não mostra nada
  function desfecho(err) {
    if (err?.cancelada) return null;
    if (err?.status === 401) {
      return {
        acao: 'entrar',
        acesso: !!err.acesso,
        texto: err.acesso
          ? 'Sua sessão de acesso ao admin expirou. Entre de novo pra continuar.'
          : 'Sua sessão do admin expirou. Entre de novo pra continuar.',
      };
    }
    if (err?.status === 403) return { acao: 'nenhuma', texto: 'Você não tem permissão pra ver esta seção.' };
    let detalhe = 'Tente de novo em alguns segundos.';
    if (err?.tempoEsgotado) detalhe = 'O servidor demorou demais pra responder.';
    else if (err?.status === 0) detalhe = 'Sem conexão com o servidor.';
    else if (err?.status >= 500) detalhe = 'O servidor encontrou um erro.';
    return { acao: 'tentar', texto: `Não foi possível carregar esta seção. ${detalhe}` };
  }

  const api = { PRAZO_MS, ErroApi, pegarJson, criarNavegacao, desfecho, sinalCombinado };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.CargaAdmin = api;
})();
