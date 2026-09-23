// Player por TELA (dispositivo), não por ponto — migration 019. A chave do
// aparelho identifica esta tela; o PIN (definido no admin) abre o painel
// da tela aqui mesmo, sem usuário/senha na TV (CONSTRAINTS.md).
const params = new URLSearchParams(window.location.search);
// Só dígitos: o id vai em URL e no HTML do painel — ?tela=<img onerror=…>
// não pode virar script na TV (nem num admin que abrir o link).
const dispositivoId = String(params.get('tela') || params.get('dispositivo') || params.get('ponto') || '').replace(
  /\D/g,
  '',
);
const CHAVE_CACHE = `mostrai-playlist-${dispositivoId}`;
const CHAVE_APARELHO = `mostrai-aparelho-${dispositivoId}`;
const NOME_CACHE_ARQUIVOS = `mostrai-midia-${dispositivoId}`;
if (params.get('orientacao') === 'paisagem') document.body.classList.add('paisagem');

// Margens pra moldura física, por lado (migration 069) — persistidas por
// tela no admin, entregues a cada heartbeat (5 em 5 min, já rodava; não é
// endpoint novo). `?margem=N` na URL continua funcionando como valor único
// legado (mesmos 4 lados iguais) pra quem já tinha isso na TV — o primeiro
// heartbeat que responder sobrescreve com os valores reais assim que
// chegar. Guardado em localStorage pra já aparecer certo no boot seguinte,
// antes do primeiro heartbeat responder.
const CHAVE_MARGENS = `mostrai-margens-${dispositivoId}`;
const LADOS_MARGEM = ['superior', 'direita', 'inferior', 'esquerda'];
function aplicarMargens(margens) {
  if (!margens) return;
  LADOS_MARGEM.forEach((lado) => {
    const v = Number(margens[lado]);
    document.documentElement.style.setProperty(
      `--m-${lado}`,
      `${Number.isFinite(v) && v >= 0 ? Math.min(v, 20) : 0}vmin`,
    );
  });
}
const margemLegado = Number(params.get('margem'));
if (Number.isFinite(margemLegado) && margemLegado > 0) {
  aplicarMargens({ superior: margemLegado, direita: margemLegado, inferior: margemLegado, esquerda: margemLegado });
}
try {
  const salvas = JSON.parse(localStorage.getItem(CHAVE_MARGENS) || 'null');
  if (salvas) aplicarMargens(salvas);
} catch {}

// Chave do aparelho: vem uma vez na URL (?chave=...) e fica guardada, pra
// que a TV continue funcionando depois de um reinício sem a query string.
let chaveAparelho = params.get('chave') || '';
try {
  if (chaveAparelho) localStorage.setItem(CHAVE_APARELHO, chaveAparelho);
  else chaveAparelho = localStorage.getItem(CHAVE_APARELHO) || '';
} catch {}
const cabecalhos = { 'X-Aparelho-Id': chaveAparelho };
const videoEl = document.getElementById('player');
const msgEl = document.getElementById('msg');

let playlist = [];
let indice = 0;
let painelAberto = false;

// Diagnóstico temporário da TV física. Fora de ?debug=1 todas as funções
// abaixo viram no-op e nenhum elemento, log ou acesso a sessionStorage é
// criado. Nunca registra a chave do aparelho, headers, cookies ou a URL
// completa (query strings podem carregar credenciais em integrações futuras).
const DEBUG_ATIVO = params.get('debug') === '1';
const DEBUG_PREFIXO = '[MostrAi Player Debug]';
const DEBUG_STORAGE = `mostrai-player-debug-${dispositivoId}`;
const DEBUG_LIMITE = 40;
let debugPainel = null;
let debugAtual = null;
let debugErros = 0;
let debugUltimoPlayed = '—';
let debugUltimoHeartbeat = '—';
let debugUltimaPlaylist = '—';
let debugLinhas = [];

function urlDebug(valor) {
  if (!valor) return '—';
  if (String(valor).startsWith('blob:')) return 'blob local';
  try {
    const url = new URL(valor, window.location.origin);
    const partes = url.pathname.split('/').filter(Boolean);
    return `${url.host}/${partes.slice(-2).join('/')}`;
  } catch {
    return String(valor).split('?')[0].slice(-80);
  }
}

function horaDebug() {
  return new Date().toLocaleTimeString('pt-BR', { hour12: false });
}

function salvarDebug() {
  try {
    sessionStorage.setItem(DEBUG_STORAGE, JSON.stringify(debugLinhas));
  } catch {}
}

function renderizarDebug(status, evento) {
  if (!debugPainel) return;
  const atual = debugAtual || {};
  debugPainel.querySelector('[data-debug="status"]').textContent = status || 'aguardando';
  debugPainel.querySelector('[data-debug="peca"]').textContent =
    atual.indice === undefined
      ? '—'
      : `#${atual.indice} · anunciante ${atual.anuncianteId ?? 'institucional'} · criativo ${atual.criativoId ?? 'n/d'}`;
  debugPainel.querySelector('[data-debug="duracao"]').textContent = atual.duracao ? `${atual.duracao}s` : '—';
  debugPainel.querySelector('[data-debug="janela"]').textContent = atual.janela || '—';
  debugPainel.querySelector('[data-debug="url"]').textContent = atual.url || '—';
  debugPainel.querySelector('[data-debug="evento"]').textContent = evento || '—';
  debugPainel.querySelector('[data-debug="played"]').textContent = debugUltimoPlayed;
  debugPainel.querySelector('[data-debug="heartbeat"]').textContent = debugUltimoHeartbeat;
  debugPainel.querySelector('[data-debug="playlist"]').textContent = debugUltimaPlaylist;
  debugPainel.querySelector('[data-debug="erros"]').textContent = String(debugErros);
  debugPainel.querySelector('[data-debug="log"]').textContent = debugLinhas.slice(-12).join('\n');
}

function eventoDebug(evento, detalhes = {}, status = evento) {
  if (!DEBUG_ATIVO) return;
  const registro = { timestamp: new Date().toISOString(), evento, ...detalhes };
  const resumo = Object.entries(detalhes)
    .map(([chave, valor]) => `${chave}=${String(valor)}`)
    .join(' ');
  debugLinhas.push(`${horaDebug()} ${evento}${resumo ? ` · ${resumo}` : ''}`);
  debugLinhas = debugLinhas.slice(-DEBUG_LIMITE);
  salvarDebug();
  console.log(DEBUG_PREFIXO, registro);
  renderizarDebug(status, evento);
}

function iniciarDebug() {
  if (!DEBUG_ATIVO) return;
  try {
    const anteriores = JSON.parse(sessionStorage.getItem(DEBUG_STORAGE));
    if (Array.isArray(anteriores)) debugLinhas = anteriores.slice(-DEBUG_LIMITE);
  } catch {}

  debugPainel = document.createElement('aside');
  debugPainel.id = 'playerDebug';
  debugPainel.setAttribute('aria-live', 'polite');
  debugPainel.innerHTML = `
    <button type="button" id="playerDebugAlternar" aria-expanded="true">Ocultar diagnóstico</button>
    <div class="player-debug-corpo">
      <strong>Mostraí Player Debug</strong>
      <dl>
        <dt>Status</dt><dd data-debug="status">aguardando</dd>
        <dt>Peça</dt><dd data-debug="peca">—</dd>
        <dt>Duração</dt><dd data-debug="duracao">—</dd>
        <dt>Janela</dt><dd data-debug="janela">—</dd>
        <dt>URL</dt><dd data-debug="url">—</dd>
        <dt>Evento</dt><dd data-debug="evento">—</dd>
        <dt>Último /played</dt><dd data-debug="played">—</dd>
        <dt>Heartbeat</dt><dd data-debug="heartbeat">—</dd>
        <dt>Playlist</dt><dd data-debug="playlist">—</dd>
        <dt>Erros</dt><dd data-debug="erros">0</dd>
      </dl>
      <pre data-debug="log"></pre>
    </div>`;
  document.body.appendChild(debugPainel);
  debugPainel.querySelector('#playerDebugAlternar').addEventListener('click', (e) => {
    const oculto = debugPainel.classList.toggle('recolhido');
    e.currentTarget.textContent = oculto ? 'Mostrar diagnóstico' : 'Ocultar diagnóstico';
    e.currentTarget.setAttribute('aria-expanded', String(!oculto));
  });
  eventoDebug('debug_ativado', { tela: dispositivoId || 'ausente' });
}

iniciarDebug();

function log(t) {
  msgEl.textContent = t;
}

function carregarCache() {
  try {
    return JSON.parse(localStorage.getItem(CHAVE_CACHE)) || [];
  } catch {
    return [];
  }
}
function salvarCache(lista) {
  try {
    localStorage.setItem(CHAVE_CACHE, JSON.stringify(lista));
  } catch {}
}

// ---------------------------------------------------------------------
// Cache de arquivos (Cache API): cada vídeo é baixado UMA vez por tela e
// tocado do disco daí em diante. Sem isso, cada exibição puxava o vídeo
// inteiro do Storage — com 10 telas a 72 exibições/dia isso estourava a
// saída de dados do plano gratuito (docs/erros/2026-09-saida-de-video-sem-cache.md).
// ---------------------------------------------------------------------
const temCache = 'caches' in window;
const urlsEmUso = new Set();

async function garantirNoCache(url) {
  if (!temCache || !url) return;
  try {
    const cache = await caches.open(NOME_CACHE_ARQUIVOS);
    if (await cache.match(url)) return;
    const r = await fetch(url, { mode: 'cors' });
    if (r.ok) await cache.put(url, r);
  } catch {
    /* toca direto da rede */
  }
}

async function limparCacheAntigo() {
  if (!temCache) return;
  try {
    const cache = await caches.open(NOME_CACHE_ARQUIVOS);
    for (const req of await cache.keys()) if (!urlsEmUso.has(req.url)) await cache.delete(req);
  } catch {}
}

// Object URL do cache quando existir; senão a URL de rede. Só o vídeo em
// exibição fica em memória: o anterior é liberado quando o próximo começa
// (TV stick tem pouca RAM — guardar 20 vídeos em blob derrubava o navegador).
let objectUrlAtual = null;
async function fonteDe(url) {
  if (!temCache) return url;
  try {
    const cache = await caches.open(NOME_CACHE_ARQUIVOS);
    const resp = await cache.match(url);
    if (!resp) return url;
    return URL.createObjectURL(await resp.blob());
  } catch {
    return url;
  }
}
// Troca o src e só então libera o blob anterior.
function trocarFonte(fonte) {
  videoEl.src = fonte;
  if (objectUrlAtual) URL.revokeObjectURL(objectUrlAtual);
  objectUrlAtual = fonte.startsWith('blob:') ? fonte : null;
}

async function prepararArquivos(lista) {
  urlsEmUso.clear();
  lista.forEach((i) => i.url && urlsEmUso.add(i.url));
  for (const url of urlsEmUso) await garantirNoCache(url);
  limparCacheAntigo();
}

// TELA SEM REDE MOSTRA SÓ A MOSTRAÍ (decisão do dono, 17/09/2026 — item 25).
//
// O cache existe pra atravessar queda curta: roteador reiniciando, oscilação
// de minutos. Passado esse ponto, insistir no cache é pior do que parar, por
// dois motivos que não aparecem olhando a TV: (1) nenhuma exibição consegue
// ser confirmada, então o anunciante roda de graça e o comprovante dele fica
// menor do que a entrega real; (2) a lista em cache envelhece — conta vencida,
// peça reprovada, plano trocado — e a tela passa a exibir anúncio que o
// cliente já não paga.
//
// Uma hora é o limite: cobre queda de energia e troca de roteador, e é curto
// o bastante pra não passar uma tarde inteira exibindo o que não conta.
const TOLERANCIA_OFFLINE_MS = 60 * 60 * 1000;
let ultimoContatoOk = Date.now();

// Erro operacional pra classificar a tela no admin (migration 074,
// src/lib/status-tela.js#erro_do_player) — diferente de "sem sinal"
// (heartbeat que nem chegou): aqui o player SEGUE respondendo heartbeat,
// só que algo real deu errado na última tentativa de playlist. Vai junto
// no próximo heartbeat (`heartbeat()`, mais abaixo); heartbeat não espera
// pela playlist pra não acoplar os dois ciclos. Some sozinho quando a
// playlist volta a vir limpa — não existe erro "preso" no player.
let ultimoErroOperacional = null;

function marcarOffline() {
  const faz = Date.now() - ultimoContatoOk;
  const offline = faz > TOLERANCIA_OFFLINE_MS;
  document.body.classList.toggle('offline', offline);
  if (offline) {
    // `sem-playlist` é o que faz o cartão institucional aparecer. A playlist
    // em memória não é apagada: quando a rede volta, a tela retoma sem
    // esperar o próximo ciclo de 15 minutos.
    document.body.classList.add('sem-playlist');
  }
  return offline;
}

async function atualizarPlaylist() {
  eventoDebug('playlist_poll_enviado', {}, 'atualizando playlist');
  try {
    const r = await fetch(`${API_BASE_URL}/playlist/${dispositivoId}`, { headers: cabecalhos });
    eventoDebug('playlist_http', { status: r.status });
    if (r.status === 401) {
      debugErros += 1;
      debugUltimaPlaylist = `${horaDebug()} · HTTP 401`;
      renderizarDebug('playlist recusada', 'playlist_http');
      ultimoErroOperacional = 'chave do aparelho inválida';
      log('chave do aparelho inválida, gere de novo no painel admin');
      return;
    }
    // 403 é a tela (ou o ponto) marcada fora do ar no cadastro. Não é queda de
    // rede: insistir com o cache seria exibir anúncio de uma tela que a
    // operação já tirou do ar. Melhor parar e dizer o motivo na própria TV.
    if (r.status === 403) {
      const corpo = await r.json().catch(() => ({}));
      debugErros += 1;
      debugUltimaPlaylist = `${horaDebug()} · HTTP 403`;
      renderizarDebug('tela fora do ar', 'playlist_http');
      playlist = [];
      salvarCache([]);
      document.body.classList.add('sem-playlist');
      ultimoErroOperacional = corpo.erro || 'tela fora do ar no cadastro';
      log(corpo.erro || 'esta tela está fora do ar no cadastro');
      return;
    }
    if (!r.ok) {
      debugErros += 1;
      debugUltimaPlaylist = `${horaDebug()} · HTTP ${r.status}`;
      renderizarDebug('falha de playlist', 'playlist_http');
      ultimoErroOperacional = `playlist respondeu HTTP ${r.status}`;
      log(
        marcarOffline()
          ? 'servidor fora há mais de uma hora — só a peça da Mostraí'
          : 'servidor indisponível, tocando playlist em cache',
      );
      return;
    }
    const nova = await r.json();
    debugUltimaPlaylist = `${horaDebug()} · HTTP ${r.status} · ${nova.length} itens`;
    eventoDebug('playlist_recebida', { itens: nova.length, status: r.status }, 'playlist pronta');
    ultimoContatoOk = Date.now();
    ultimoErroOperacional = null;
    document.body.classList.remove('offline');
    playlist = nova;
    salvarCache(nova);
    document.body.classList.toggle('sem-playlist', !nova.length);
    log(nova.length ? `playlist ok (${nova.length} itens)` : 'sem anúncios programados agora');
    prepararArquivos(nova);
  } catch (err) {
    debugErros += 1;
    debugUltimaPlaylist = `${horaDebug()} · falha de rede`;
    eventoDebug('playlist_falhou', { erro: err?.name || 'erro' }, 'playlist indisponível');
    ultimoErroOperacional = `falha de rede ao buscar playlist (${err?.name || 'erro'})`;
    log(marcarOffline() ? 'sem rede há mais de uma hora — só a peça da Mostraí' : 'offline, tocando playlist em cache');
  }
}

async function tocarProximo() {
  if (painelAberto) {
    eventoDebug('avanco_adiado', { motivo: 'painel aberto' }, 'painel aberto');
    setTimeout(tocarProximo, 2000);
    return;
  }
  // Offline por tempo demais: a tela fica só na peça da Mostraí, mesmo com
  // playlist em memória. Segue checando, e volta sozinha quando a rede voltar.
  if (!playlist.length || marcarOffline()) {
    eventoDebug('avanco_adiado', { motivo: playlist.length ? 'offline' : 'playlist vazia' }, 'institucional');
    document.body.classList.add('sem-playlist');
    setTimeout(tocarProximo, 5000);
    return;
  }
  document.body.classList.remove('sem-playlist');
  const indiceAtual = indice;
  const item = playlist[indiceAtual];
  indice = (indice + 1) % playlist.length;
  const inicioJanela = new Date();
  inicioJanela.setMinutes(0, 0, 0);
  debugAtual = {
    indice: indiceAtual,
    anuncianteId: item?.anuncianteId ?? null,
    criativoId: item?.criativoId ?? null,
    url: urlDebug(item?.url),
    duracao: Number(item?.duracaoSegundos) || null,
    janela: item?.janelaHora || `${inicioJanela.toISOString()} (inferida local)`,
  };
  eventoDebug(
    'peca_selecionada',
    {
      indice: indiceAtual,
      anunciante: debugAtual.anuncianteId ?? 'institucional',
      criativo: debugAtual.criativoId ?? 'n/d',
      url: debugAtual.url,
      duracao: debugAtual.duracao ?? 'n/d',
      janela: debugAtual.janela,
    },
    'preparando peça',
  );

  // Inventário vago (src/lib/pacing.js): a hora que não foi vendida é
  // preenchida com a peça institucional, a MESMA que aparece quando não há
  // playlist nenhuma. Antes um item sem url era pulado em 1 segundo, e era
  // isso que fazia a lista dar voltas na hora — o player tocava os anúncios
  // pagos em laço e o cliente recebia dezenas de vezes o que comprou 3.
  // Agora o espaço vago ocupa o tempo dele, e a frequência vendida é a
  // frequência entregue.
  if (item?.institucional) {
    // Só mexe no DOM na TRANSIÇÃO pra institucional, não a cada item — a
    // playlist pode ter dezenas de itens institucionais seguidos (hora sem
    // nenhum anunciante), e repetir os mesmos add/remove/pause sem necessidade
    // é o que fazia a tela "piscar" de 10 em 10s sem nada mudar de verdade.
    if (!document.body.classList.contains('institucional')) {
      document.body.classList.add('institucional');
      videoEl.classList.remove('ativo');
      videoEl.pause();
    }
    eventoDebug('institucional_iniciada', { duracao: Math.max(2, Number(item.duracaoSegundos) || 10) });
    setTimeout(
      () => {
        eventoDebug('avanco_proxima', { motivo: 'institucional concluída' }, 'avançando');
        tocarProximo();
      },
      Math.max(2, Number(item.duracaoSegundos) || 10) * 1000,
    );
    return;
  }
  document.body.classList.remove('institucional');

  if (!item?.url) {
    debugErros += 1;
    eventoDebug('peca_sem_url', {}, 'peça inválida');
    setTimeout(() => {
      eventoDebug('avanco_proxima', { motivo: 'sem URL', atrasoMs: 1000 }, 'avançando');
      tocarProximo();
    }, 1000);
    return;
  }
  eventoDebug('preparacao_iniciada', { url: urlDebug(item.url) }, 'carregando mídia');
  const fonte = await fonteDe(item.url);
  eventoDebug('fonte_resolvida', { origem: fonte.startsWith('blob:') ? 'cache' : 'rede' });
  trocarFonte(fonte);
  videoEl.classList.add('ativo');
  eventoDebug('play_chamado', {}, 'solicitando reprodução');
  videoEl.play().then(
    () => eventoDebug('play_resolvido', {}, 'play aceito'),
    (err) => {
      debugErros += 1;
      eventoDebug('play_rejeitado', { erro: err?.name || 'erro' }, 'play rejeitado');
    },
  );
  // Autoanúncio do dono (anuncianteId null) não é cobrado nem contado.
  if (item.anuncianteId) {
    eventoDebug('played_enviado', { anunciante: item.anuncianteId }, 'enviando /played');
    fetch(`${API_BASE_URL}/player/${dispositivoId}/played`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cabecalhos },
      body: JSON.stringify({ anuncianteId: item.anuncianteId }),
    })
      .then(async (r) => {
        if (!DEBUG_ATIVO) return;
        const corpo = await r
          .clone()
          .json()
          .catch(() => null);
        const resumo = corpo?.motivo || corpo?.janela || corpo?.erro || (corpo?.ok ? 'ok' : 'sem corpo');
        debugUltimoPlayed = `${horaDebug()} · HTTP ${r.status} · ${resumo}`;
        if (!r.ok) debugErros += 1;
        eventoDebug(
          'played_resposta',
          { status: r.status, resultado: resumo },
          r.ok ? '/played aceito' : '/played recusado',
        );
      })
      .catch((err) => {
        if (!DEBUG_ATIVO) return;
        debugErros += 1;
        debugUltimoPlayed = `${horaDebug()} · falha de rede`;
        eventoDebug('played_falhou', { erro: err?.name || 'erro' }, '/played falhou');
      }); // continua fire-and-forget — diagnóstico não trava a exibição
  }
}

for (const nome of ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting']) {
  videoEl.addEventListener(nome, () =>
    eventoDebug(nome, {
      tempo: videoEl.currentTime.toFixed(2),
      duracao: Number.isFinite(videoEl.duration) ? videoEl.duration : 'n/d',
    }),
  );
}
videoEl.addEventListener('ended', () => {
  eventoDebug('ended', { tempo: videoEl.currentTime.toFixed(2) }, 'reprodução concluída');
  eventoDebug('avanco_proxima', { motivo: 'ended' }, 'avançando');
  tocarProximo();
});
// URL 404, codec não suportado ou arquivo corrompido nunca disparam
// 'ended' — sem isso a tela ficava parada pra sempre.
videoEl.addEventListener('error', () => {
  debugErros += 1;
  eventoDebug('error', { codigo: videoEl.error?.code || 'n/d' }, 'erro de mídia');
  log('item falhou, pulando');
  eventoDebug('avanco_proxima', { motivo: 'error', atrasoMs: 500 }, 'avançando após erro');
  setTimeout(tocarProximo, 500);
});
videoEl.addEventListener('stalled', () => {
  eventoDebug('stalled', { pausado: videoEl.paused, tempo: videoEl.currentTime.toFixed(2) }, 'mídia travada');
  setTimeout(() => {
    if (videoEl.paused && !painelAberto) {
      eventoDebug('avanco_proxima', { motivo: 'stalled pausado', atrasoMs: 10000 }, 'avançando após stall');
      tocarProximo();
    } else {
      eventoDebug('stalled_timeout_sem_avanco', { pausado: videoEl.paused });
    }
  }, 10000);
});

function heartbeat() {
  eventoDebug('heartbeat_enviado', {}, 'enviando heartbeat');
  fetch(`${API_BASE_URL}/player/${dispositivoId}/heartbeat`, {
    method: 'POST',
    headers: { ...cabecalhos, 'Content-Type': 'application/json' },
    // `erro` (migration 074) pega carona no heartbeat de sempre — sem
    // endpoint novo, mesma ideia das margens da safe area logo abaixo.
    // Ausente/null limpa o que o backend tinha guardado (src/dispositivos/
    // repository.js#marcarOnline): não existe erro "preso".
    body: JSON.stringify({ erro: ultimoErroOperacional || null }),
  })
    .then(async (r) => {
      const corpo = await r
        .clone()
        .json()
        .catch(() => null);
      if (corpo?.margens) {
        aplicarMargens(corpo.margens);
        try {
          localStorage.setItem(CHAVE_MARGENS, JSON.stringify(corpo.margens));
        } catch {}
      }
      if (!DEBUG_ATIVO) return;
      const resultado = corpo?.erro || (corpo?.ok ? 'ok' : 'sem corpo');
      debugUltimoHeartbeat = `${horaDebug()} · HTTP ${r.status} · ${resultado}`;
      if (!r.ok) debugErros += 1;
      eventoDebug('heartbeat_resposta', { status: r.status, resultado }, r.ok ? 'heartbeat ok' : 'heartbeat recusado');
    })
    .catch((err) => {
      if (!DEBUG_ATIVO) return;
      debugErros += 1;
      debugUltimoHeartbeat = `${horaDebug()} · falha de rede`;
      eventoDebug('heartbeat_falhou', { erro: err?.name || 'erro' }, 'heartbeat falhou');
    });
}

// ---------------------------------------------------------------------
// Painel da tela: PIN → o que rodou nesta tela nos últimos 30 dias.
// Abre com 5 toques no canto superior direito (em 3 s) ou tecla P.
// ---------------------------------------------------------------------
let toques = [];
document.getElementById('alvoPainel').addEventListener('click', () => {
  const agora = Date.now();
  toques = toques.filter((t) => agora - t < 3000).concat(agora);
  if (toques.length >= 5) {
    toques = [];
    abrirPainel();
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'p' || e.key === 'P') && !painelAberto) abrirPainel();
});

function abrirPainel() {
  painelAberto = true;
  videoEl.pause();
  const el = document.createElement('div');
  el.className = 'painel-tela';
  el.innerHTML = `
    <button type="button" class="fechar" id="fecharPainel">Voltar pro player</button>
    <h2>Painel da tela</h2>
    <p class="sub">Tela #${dispositivoId} · digite o PIN pra ver o que rodou aqui</p>
    <form class="pin-form" id="formPin">
      <input id="pin" inputmode="numeric" maxlength="6" autocomplete="off" autofocus placeholder="••••">
      <button type="submit">Abrir</button>
    </form>
    <p class="erro" id="erroPin"></p>
    <div id="conteudoPainel"></div>`;
  document.body.appendChild(el);
  const fechar = () => {
    el.remove();
    painelAberto = false;
    tocarProximo();
  };
  el.querySelector('#fecharPainel').addEventListener('click', fechar);
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') {
      fechar();
      document.removeEventListener('keydown', esc);
    }
  });
  el.querySelector('#formPin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const erro = el.querySelector('#erroPin');
    erro.textContent = '';
    try {
      const r = await fetch(`${API_BASE_URL}/player/${dispositivoId}/painel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cabecalhos },
        body: JSON.stringify({ pin: el.querySelector('#pin').value }),
      });
      const d = await r.json();
      if (!r.ok) {
        erro.textContent = d.erro || 'não deu pra abrir';
        return;
      }
      el.querySelector('#formPin').hidden = true;
      const total = d.porAnunciante.reduce((s, a) => s + a.confirmadas, 0);
      const hoje = d.porDia[0] ? d.porDia[0].confirmadas : 0;
      el.querySelector('#conteudoPainel').innerHTML = `
        <div class="grade">
          <div class="caixa"><small>Exibições em 30 dias</small><b>${total.toLocaleString('pt-BR')}</b></div>
          <div class="caixa"><small>Hoje</small><b>${hoje.toLocaleString('pt-BR')}</b></div>
          <div class="caixa"><small>Anunciantes</small><b>${d.porAnunciante.length}</b></div>
          <div class="caixa"><small>Itens na playlist agora</small><b>${playlist.length}</b></div>
        </div>
        ${
          d.porAnunciante.length
            ? `<table><thead><tr><th>Anunciante</th><th>Programadas</th><th>Confirmadas</th></tr></thead><tbody>
          ${d.porAnunciante.map((a) => `<tr><td>${esc(a.nome_empresa)}</td><td>${Number(a.programadas) || 0}</td><td>${Number(a.confirmadas) || 0}</td></tr>`).join('')}
        </tbody></table>`
            : '<p class="sub">Nada rodou nessa tela ainda.</p>'
        }
        <p class="sub u-mt-16">Chave do aparelho: ${esc(chaveAparelho ? chaveAparelho.slice(0, 6) + '…' : '(sem chave)')} · API: ${esc(API_BASE_URL)}</p>`;
    } catch {
      erro.textContent = 'sem conexão com o servidor';
    }
  });
}

log(`api: ${API_BASE_URL}`);
if (!dispositivoId) {
  log('faltou ?tela=ID na URL');
} else if (!chaveAparelho) {
  log('faltou a chave do aparelho, abra o link completo gerado no painel admin');
} else {
  playlist = carregarCache();
  atualizarPlaylist().then(tocarProximo);
  setInterval(atualizarPlaylist, 15 * 60 * 1000);

  // Buscar de 15 em 15 minutos não basta desde que a hora passou a ser orçada
  // em segundos (src/lib/pacing.js): a lista agora É a hora, então virar a
  // hora sem buscar de novo faz a TV tocar até 15 minutos da hora ANTERIOR
  // enquanto o servidor já conta na hora nova — e programadas × confirmadas
  // deixam de fechar. Aqui a TV acorda na virada da hora.
  //
  // Os segundos de atraso são de propósito e vêm da chave do aparelho, não do
  // relógio: sem isso toda tela da rede bateria no servidor no mesmo segundo,
  // todas as horas. Mesma tela, mesmo atraso, sempre.
  const atrasoDaVirada = (chaveAparelho.charCodeAt(0) || 0) % 30;
  function agendarViradaDaHora() {
    const agora = new Date();
    const proxima = new Date(agora);
    proxima.setHours(agora.getHours() + 1, 0, atrasoDaVirada, 0);
    setTimeout(() => {
      atualizarPlaylist();
      agendarViradaDaHora();
    }, proxima - agora);
  }
  agendarViradaDaHora();
  heartbeat();
  setInterval(heartbeat, 5 * 60 * 1000);
  document.documentElement.requestFullscreen?.().catch(() => {});
  // Recarrega a página uma vez por dia (de madrugada) pra pegar versão nova
  // do player sem ninguém ir até a TV.
  setInterval(
    () => {
      const h = new Date().getHours();
      if (h === 4) window.location.reload();
    },
    60 * 60 * 1000,
  );
}
