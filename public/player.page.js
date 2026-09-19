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

// Margem pra moldura física: mesma lógica de persistência da chave — vem uma
// vez na URL (?margem=3, em vmin) e fica guardada pro próximo boot da TV.
const CHAVE_MARGEM = `mostrai-margem-${dispositivoId}`;
let margem = params.get('margem');
try {
  if (margem !== null) localStorage.setItem(CHAVE_MARGEM, margem);
  else margem = localStorage.getItem(CHAVE_MARGEM);
} catch {}
margem = Number(margem);
if (Number.isFinite(margem) && margem > 0) {
  document.documentElement.style.setProperty('--margem', `${Math.min(margem, 20)}vmin`);
}

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
  try {
    const r = await fetch(`${API_BASE_URL}/playlist/${dispositivoId}`, { headers: cabecalhos });
    if (r.status === 401) {
      log('chave do aparelho inválida, gere de novo no painel admin');
      return;
    }
    // 403 é a tela (ou o ponto) marcada fora do ar no cadastro. Não é queda de
    // rede: insistir com o cache seria exibir anúncio de uma tela que a
    // operação já tirou do ar. Melhor parar e dizer o motivo na própria TV.
    if (r.status === 403) {
      const corpo = await r.json().catch(() => ({}));
      playlist = [];
      salvarCache([]);
      document.body.classList.add('sem-playlist');
      log(corpo.erro || 'esta tela está fora do ar no cadastro');
      return;
    }
    if (!r.ok) {
      log(
        marcarOffline()
          ? 'servidor fora há mais de uma hora — só a peça da Mostraí'
          : 'servidor indisponível, tocando playlist em cache',
      );
      return;
    }
    const nova = await r.json();
    ultimoContatoOk = Date.now();
    document.body.classList.remove('offline');
    playlist = nova;
    salvarCache(nova);
    document.body.classList.toggle('sem-playlist', !nova.length);
    log(nova.length ? `playlist ok (${nova.length} itens)` : 'sem anúncios programados agora');
    prepararArquivos(nova);
  } catch {
    log(marcarOffline() ? 'sem rede há mais de uma hora — só a peça da Mostraí' : 'offline, tocando playlist em cache');
  }
}

async function tocarProximo() {
  if (painelAberto) {
    setTimeout(tocarProximo, 2000);
    return;
  }
  // Offline por tempo demais: a tela fica só na peça da Mostraí, mesmo com
  // playlist em memória. Segue checando, e volta sozinha quando a rede voltar.
  if (!playlist.length || marcarOffline()) {
    document.body.classList.add('sem-playlist');
    setTimeout(tocarProximo, 5000);
    return;
  }
  document.body.classList.remove('sem-playlist');
  const item = playlist[indice];
  indice = (indice + 1) % playlist.length;

  // Inventário vago (src/lib/pacing.js): a hora que não foi vendida é
  // preenchida com a peça institucional, a MESMA que aparece quando não há
  // playlist nenhuma. Antes um item sem url era pulado em 1 segundo, e era
  // isso que fazia a lista dar voltas na hora — o player tocava os anúncios
  // pagos em laço e o cliente recebia dezenas de vezes o que comprou 3.
  // Agora o espaço vago ocupa o tempo dele, e a frequência vendida é a
  // frequência entregue.
  if (item?.institucional) {
    document.body.classList.add('institucional');
    videoEl.classList.remove('ativo');
    videoEl.pause();
    setTimeout(tocarProximo, Math.max(2, Number(item.duracaoSegundos) || 10) * 1000);
    return;
  }
  document.body.classList.remove('institucional');

  if (!item?.url) {
    setTimeout(tocarProximo, 1000);
    return;
  }
  trocarFonte(await fonteDe(item.url));
  videoEl.classList.add('ativo');
  videoEl.play().catch(() => {});
  // Autoanúncio do dono (anuncianteId null) não é cobrado nem contado.
  if (item.anuncianteId) {
    fetch(`${API_BASE_URL}/player/${dispositivoId}/played`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cabecalhos },
      body: JSON.stringify({ anuncianteId: item.anuncianteId }),
    }).catch(() => {}); // fire-and-forget — não trava a exibição
  }
}

videoEl.addEventListener('ended', tocarProximo);
// URL 404, codec não suportado ou arquivo corrompido nunca disparam
// 'ended' — sem isso a tela ficava parada pra sempre.
videoEl.addEventListener('error', () => {
  log('item falhou, pulando');
  setTimeout(tocarProximo, 500);
});
videoEl.addEventListener('stalled', () =>
  setTimeout(() => {
    if (videoEl.paused && !painelAberto) tocarProximo();
  }, 10000),
);

function heartbeat() {
  fetch(`${API_BASE_URL}/player/${dispositivoId}/heartbeat`, { method: 'POST', headers: cabecalhos }).catch(() => {});
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
