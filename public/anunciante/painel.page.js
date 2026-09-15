const fmt = fmtBRL; // config.js

let ANUNCIANTE = null;
let ANUNCIANTE_ID = null;

// As duas portas de quem não tem arte. Não há o que construir aqui além do
// caminho certo pra fora: a peça é feita fora do site, e a gravação é
// serviço de terceiro com preço caso a caso — as duas coisas se resolvem
// conversando. A mensagem já vai com o nome da empresa pra conversa não
// começar com "oi".
function montarPortasDeArte() {
  if (!window.linkWhatsApp) return;
  const nome = (ANUNCIANTE?.nome_empresa) || 'anunciante';
  const simples = document.getElementById('linkArteSimples');
  const gravacao = document.getElementById('linkGravacao');
  if (simples) {
    simples.href = window.linkWhatsApp(
      `Olá! Sou ${nome}, do Mostraí, e quero pedir o anúncio simples que vem no meu plano.`
    );
  }
  if (gravacao) {
    gravacao.href = window.linkWhatsApp(
      `Olá! Sou ${nome}, do Mostraí, e quero orçar a gravação de um vídeo para o meu anúncio.`
    );
  }
}

async function carregar() {
  const r = await fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include' });
  if (r.status === 401) {
    window.location.href = '/anunciante/login.html';
    return;
  }
  // Sem isso, um 500 caía no .json(), ANUNCIANTE_ID virava undefined e o
  // painel montava vazio e funcional — o cliente via "0 exibições" em vez
  // de "não deu pra carregar".
  if (!r.ok) throw new Error();
  ANUNCIANTE = await r.json();
  ANUNCIANTE_ID = ANUNCIANTE.id;
  // Popup de perfil, avatar e sair vêm de /perfil.js — a mesma tela que o
  // painel do ponto usa, em vez de duas cópias que divergem.
  montarPerfil(ANUNCIANTE, (nova) => { ANUNCIANTE = nova; preencherStatusBanner(); });
  montarPortasDeArte();

  // Painel único (modos.js): sem o papel "anunciante" o dashboard dá
  // lugar ao card de ativação. Com o papel, segue o fluxo normal.
  const estado = await montarModo('anunciante', document.getElementById('dashboardAnuncios'), async (estado) => {
    preencherStatusBanner();
    document.getElementById('bonusAnuncios').innerHTML = cardBonus(estado, 'ponto');
    const planoUrl = new URLSearchParams(window.location.search).get('plano');
    if (planoUrl && !ANUNCIANTE.plano_id) confirmarPlano(planoUrl);
    carregarExibicoes();
    carregarCriativos();
    carregarKpiPontos();
  });
  if (estado && !estado.modos.anunciante.liberado) {
    document.getElementById('statusBanner').innerHTML = `<span><strong>${esc(ANUNCIANTE.nome_empresa)}</strong> · modo anúncios ainda não ativado</span>`;
    // Veio da vitrine querendo um plano: guarda pra depois de ativar.
    const planoUrl = new URLSearchParams(window.location.search).get('plano');
    if (planoUrl) history.replaceState(null, '', `/anunciante/painel.html?plano=${encodeURIComponent(planoUrl)}`);
  }
}

function preencherStatusBanner() {
  const el = document.getElementById('statusBanner');
  const statusTxt = ROTULOS.anunciante[ANUNCIANTE.status] || ANUNCIANTE.status;
  let planoTxt = 'Sem plano ainda';
  if (ANUNCIANTE.plano_id) {
    planoTxt = `Plano ativo${ANUNCIANTE.data_expiracao ? ' até ' + new Date(ANUNCIANTE.data_expiracao).toLocaleDateString('pt-BR') : ''}`;
  }
  const travado = ANUNCIANTE.valor_mensal_travado != null ? ` · preço travado em ${fmtBRL(ANUNCIANTE.valor_mensal_travado)}/mês` : '';
  el.innerHTML = `
    <span><strong>${esc(ANUNCIANTE.nome_empresa)}</strong> · ${statusTxt} · ${planoTxt}${travado}</span>
    ${!ANUNCIANTE.plano_id ? '<a class="btn primary" href="/planos.html">Escolher plano</a>' : ''}
  `;
}

// Ponto usa a mesma conta de anunciante (ver migration 016) — o card só
// mostra a contagem e manda pro dashboard próprio do ponto; sem ponto
// ainda, manda pro cadastro. Nada disso mora mais no menu do topo.
async function carregarKpiPontos() {
  const el = document.getElementById('kpiPontos');
  // v2.1: sem o papel "ponto", o atalho leva ao modo "Meu ponto" (card
  // de ativação); com o papel, mostra a contagem.
  if (!(ANUNCIANTE.papeis || []).includes('ponto')) {
    el.innerHTML = `<span class="kpi-label">Meus pontos</span><b>0</b><a class="link-secundario" href="/anunciante/ponto.html">Quero uma tela no meu comércio</a>`;
    return;
  }
  try {
    const pontos = await (await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/pontos`, { credentials: 'include' })).json();
    el.innerHTML = `<span class="kpi-label">Meus pontos</span><b>${pontos.length}</b><a class="link-secundario" href="/anunciante/ponto.html">Ver meu ponto →</a>`;
  } catch {
    el.innerHTML = '<span class="kpi-label">Meus pontos</span><b>—</b>';
  }
}

// Confirmação antes de gerar cobrança. Antes, chegar no painel com
// ?plano=X já criava a cobrança e jogava o anunciante no checkout sem ele
// nunca ver quanto ia pagar — e um F5 nessa URL gerava outra cobrança.
async function confirmarPlano(planoId) {
  const box = document.getElementById('statusBanner');
  let plano = null;
  try {
    plano = (await (await fetch(`${API_BASE_URL}/planos`)).json()).find((p) => p.id === planoId);
  } catch { /* mostra o resumo sem valor */ }
  if (!plano) {
    box.insertAdjacentHTML('beforeend', '<p class="form-msg err">Não encontramos esse plano. Escolha de novo em Planos.</p>');
    return;
  }
  const total = Math.round(Number(plano.valor_mensal) * plano.compromisso_meses * 100) / 100;
  const ciclo = plano.compromisso_meses === 1 ? 'por mês' : `a cada ${plano.compromisso_meses} meses`;
  const extras = [
    plano.preco_travado ? `Preço travado por ${plano.compromisso_meses} meses.` : '',
  ].filter(Boolean).join(' ');
  box.insertAdjacentHTML('beforeend', `
    <div class="panel u-mt-14">
      <h3 class="u-m-0 u-mb-6">Confirmar assinatura</h3>
      <p class="u-m-0 u-mb-4"><b>${esc(plano.nome)}</b> — ${plano.frequencia_dia}x por dia em cada tela</p>
      <p class="u-m-0 ${extras ? 'u-mb-4' : 'u-mb-12'}">Você vai pagar <b>${fmtBRL(total)}</b> ${ciclo} (${fmtBRL(plano.valor_mensal)}/mês).</p>
      ${extras ? `<p class="form-hint u-m-0 u-mb-12">${extras}</p>` : ''}
      <button class="btn primary" id="btnConfirmarPlano">Ir para o pagamento</button>
      <a class="btn ghost" href="/planos.html">Escolher outro</a>
    </div>`);
  document.getElementById('btnConfirmarPlano').addEventListener('click', (e) => {
    e.target.disabled = true;
    // Tira o ?plano= da URL pra que um F5 não caia aqui de novo.
    history.replaceState(null, '', '/anunciante/painel.html');
    assinar(ANUNCIANTE.id, planoId);
  });
}

// Assinatura de plano — a escolha em si acontece em /planos.html (mesma
// página pública, linkando pra cá com ?plano=X quando já logado); aqui só
// sobra gerar a cobrança e mandar pro checkout.
async function assinar(anuncianteId, planoId) {
  const box = document.getElementById('statusBanner');
  box.insertAdjacentHTML('beforeend', '<p class="soon">Gerando cobrança...</p>');
  const r = await fetch(`${API_BASE_URL}/anunciantes/${anuncianteId}/assinar`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ planoId }),
  });
  if (!r.ok) {
    const erro = (await r.json().catch(() => ({}))).erro;
    box.insertAdjacentHTML('beforeend', `<p class="form-msg err">${esc(erro || 'Não foi possível gerar a cobrança.')} <a href="/planos.html">Escolher outro plano</a></p>`);
    return;
  }
  const { checkoutUrl } = await r.json();
  // Se o San Checkout não estiver configurado (.env sem
  // SAN_CHECKOUT_BASE_URL/CONTRATANTE_ID), checkoutUrl vira um caminho
  // relativo tipo "/index.html?..." e o navegador cairia na home sem
  // avisar nada — melhor mostrar o erro do que redirecionar pra lugar
  // nenhum.
  if (!/^https?:\/\//.test(checkoutUrl)) {
    box.insertAdjacentHTML('beforeend', '<p class="form-msg err">Checkout não configurado neste ambiente (SAN_CHECKOUT_BASE_URL vazio no .env) — fale com o suporte técnico.</p>');
    return;
  }
  window.location.href = checkoutUrl;
}

// O link do comprovante carrega o período escolhido, como a referência de
// mercado faz: exportação respeita o mesmo recorte que está na tela.
//
// O href se monta no CLIQUE, nao no carregamento: este bloco roda antes de
// `carregarConta()` resolver, entao `ANUNCIANTE_ID` ainda e null e o link
// nascia apontando pra /anunciantes/null/exibicoes.csv. Quem clicasse sem
// antes mexer no seletor de periodo baixava um erro.
(function comprovante() {
  const sel = document.getElementById('periodoComprovante');
  const link = document.getElementById('btnComprovante');
  if (!sel || !link) return;
  const montar = () => `${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes.csv?dias=${sel.value}`;
  const atualizar = () => { if (ANUNCIANTE_ID) link.href = montar(); };
  sel.addEventListener('change', atualizar);
  link.addEventListener('click', (e) => {
    if (!ANUNCIANTE_ID) { e.preventDefault(); return; }
    link.href = montar();
  });
  atualizar();
})();

// Dashboard de exibições — leitura agregada de GET /anunciantes/:id/exibicoes
// (transparência de entrega: programado vs. confirmado, custo por exibição).
async function carregarExibicoes() {
  try {
    const dados = await (await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes`, { credentials: 'include' })).json();
    const [kConfirmadas, kEntrega, kCusto] = document.querySelectorAll('#kpiGrid .kpi-card:nth-child(-n+3) b');
    const entrega = dados.totalProgramadas > 0 ? Math.round((dados.totalConfirmadas / dados.totalProgramadas) * 100) : 0;
    kConfirmadas.textContent = dados.totalConfirmadas;
    kEntrega.textContent = dados.totalProgramadas ? `${entrega}%` : '—';
    kCusto.textContent = dados.custoPorExibicao ? fmt(dados.custoPorExibicao) : '—';

    desenharPorDia(dados.porDia || []);
    desenharPorPonto(dados.porPonto || []);
    desenharCobrancas(dados.cobrancas || []);
  } catch {
    // Antes o catch era vazio: falha de API e conta nova produziam a mesma
    // tela de "—", e quem paga não conseguia distinguir "meu anúncio não
    // rodou" de "o painel quebrou".
    document.getElementById('statusBanner').insertAdjacentHTML('beforeend',
      '<p class="form-msg err">Não foi possível carregar seus números agora. Tente atualizar a página.</p>');
  }
}

// Barras verticais dos últimos 14 dias. O endpoint devolve DESC (mais novo
// primeiro) e só os dias com registro — inverte e mostra como vem, sem
// preencher buraco de dia sem exibição.
function desenharPorDia(porDia) {
  if (!porDia.length) return;
  const dias = porDia.slice(0, 14).reverse();
  const max = Math.max(...dias.map((d) => Number(d.confirmadas))) || 1;
  document.getElementById('painelDia').hidden = false;
  document.getElementById('graficoDia').innerHTML = dias.map((d) => {
    const v = Number(d.confirmadas);
    const dia = new Date(d.dia);
    return `<div class="bar-col" title="${dia.toLocaleDateString('pt-BR')}: ${v} exibições">
      <div class="bar" data-pct="${Math.max(2, (v / max) * 100)}"></div>
      <span class="bar-label">${String(dia.getDate()).padStart(2, '0')}/${String(dia.getMonth() + 1).padStart(2, '0')}</span>
    </div>`;
  }).join('');
  document.getElementById('legendaDia').textContent = `últimos ${dias.length} dias com exibição`;

  // Delta 7 dias x 7 anteriores — no card de confirmadas.
  const soma = (arr) => arr.reduce((t, d) => t + Number(d.confirmadas), 0);
  const atual = soma(porDia.slice(0, 7));
  const anterior = soma(porDia.slice(7, 14));
  const el = document.querySelector('#kpiGrid [data-delta]');
  if (!anterior) return;
  const pct = Math.round(((atual - anterior) / anterior) * 100);
  el.textContent = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}% vs. 7 dias antes`;
  el.className = `delta ${pct >= 0 ? 'up' : 'down'}`;
}

function desenharPorPonto(porPonto) {
  if (!porPonto.length) return;
  const max = Math.max(...porPonto.map((p) => Number(p.confirmadas))) || 1;
  document.getElementById('painelDetalhe').hidden = false;
  document.getElementById('graficoPonto').innerHTML = porPonto.map((p) => `
    <div class="row">
      <span class="nome" title="${esc(p.nome)}">${esc(p.nome)}</span>
      <span class="track"><span class="fill" data-pct="${(Number(p.confirmadas) / max) * 100}"></span></span>
      <span class="valor">${p.confirmadas}</span>
    </div>`).join('');
  document.getElementById('exibicoesDetalhe').innerHTML = `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Ponto</th><th>Cidade</th><th>Programadas</th><th>Confirmadas</th><th>Entrega</th></tr></thead><tbody>
    ${porPonto.map((p) => {
      const prog = Number(p.programadas) || 0;
      const conf = Number(p.confirmadas) || 0;
      return `<tr><td>${esc(p.nome)}</td><td>${esc(p.cidade)}</td><td>${prog}</td><td>${conf}</td><td>${prog ? Math.round((conf / prog) * 100) + '%' : '—'}</td></tr>`;
    }).join('')}
  </tbody></table></div>`;
}

// Cobranças já vêm no mesmo endpoint e não eram mostradas em lugar nenhum.
function desenharCobrancas(cobrancas) {
  if (!cobrancas.length) return;
  document.getElementById('painelCobrancas').hidden = false;
  document.getElementById('listaCobrancas').innerHTML = `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Data</th><th>Valor</th><th>Nota fiscal</th></tr></thead><tbody>
    ${cobrancas.map((c) => `<tr>
      <td>${new Date(c.criado_em).toLocaleDateString('pt-BR')}</td>
      <td>${fmt(c.valor)}</td>
      <td>${c.nota_fiscal_url ? `<a href="${esc(c.nota_fiscal_url)}" target="_blank" rel="noopener">Baixar</a>` : esc(c.nota_fiscal_status || '—')}</td>
    </tr>`).join('')}
  </tbody></table></div>`;
}

function ehVideo(url) { return /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || ''); }

async function carregarCriativos() {
  const el = document.getElementById('listaCriativos');
  try {
    const criativos = await (await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/criativos`, { credentials: 'include' })).json();
    const ativos = criativos.filter((c) => c.status !== 'reprovado').length;
    document.querySelectorAll('#kpiGrid .kpi-card')[3].querySelector('b').textContent = ativos;
    el.innerHTML = criativos.length ? `<div class="criativos-lista">
      ${criativos.map((c) => {
        const video = c.arquivo_normalizado_url && ehVideo(c.arquivo_normalizado_url);
        return `<div class="criativo-card" data-id="${c.id}">
          ${c.arquivo_normalizado_url
            ? (video
              ? `<video src="${esc(c.arquivo_normalizado_url)}" muted loop playsinline poster="${esc(c.thumbnail_url || '')}"></video>
                 <button type="button" class="criativo-play" aria-label="Reproduzir"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></button>`
              : `<img src="${esc(c.arquivo_normalizado_url)}" alt="">`)
            : '<div class="criativo-placeholder">processando...</div>'}
          <button type="button" class="criativo-excluir" aria-label="Excluir criativo">&times;</button>
          <span class="badge ${ROTULOS.criativoClasse[c.status]}">${ROTULOS.criativo[c.status]}</span>
        </div>`;
      }).join('')}
    </div>` : '<p class="empty-state">Nenhum criativo enviado ainda.</p>';
  } catch (err) {
    // O `catch` mudo daqui escondeu por semanas um ReferenceError
    // (`CRIATIVO_ROTULOS`, mapa que foi renomeado e ficou uma chamada pra
    // trás): todo anunciante COM criativo via "não foi possível carregar" e
    // ninguém sabia por quê, porque a mensagem culpava a rede e a rede estava
    // boa. Erro de programação tem que aparecer no console.
    console.error('falha ao montar a lista de criativos', err);
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar seus criativos agora.</p>';
  }
}

// Play/excluir por delegação — a lista é re-renderizada a cada carregamento,
// então não dá pra prender listener em cada card.
document.getElementById('listaCriativos').addEventListener('click', async (e) => {
  const card = e.target.closest('.criativo-card');
  if (!card) return;

  if (e.target.closest('.criativo-play')) {
    const video = card.querySelector('video');
    video.play();
    card.classList.add('tocando');
    video.addEventListener('pause', () => card.classList.remove('tocando'), { once: true });
    return;
  }
  if (e.target.closest('video')) {
    const video = card.querySelector('video');
    video.pause();
    card.classList.remove('tocando');
    return;
  }
  if (e.target.closest('.criativo-excluir')) {
    if (!confirm('Excluir este criativo? Pra trocar por outro, é só enviar um novo depois.')) return;
    const r = await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/criativos/${card.dataset.id}`, {
      method: 'DELETE', credentials: 'include',
    });
    const msg = document.getElementById('uploadMsg');
    if (r.ok) {
      msg.textContent = 'Criativo excluído.';
      msg.className = 'form-msg ok';
      carregarCriativos();
    } else {
      msg.textContent = 'Não foi possível excluir agora. Tente de novo.';
      msg.className = 'form-msg err';
    }
  }
});

// Um controle só: escolher o arquivo já envia — sem botão "Enviar" à parte.
document.getElementById('arquivoCriativo').addEventListener('change', async (e) => {
  const input = e.target;
  const msg = document.getElementById('uploadMsg');
  if (!input.files[0]) return;

  msg.textContent = 'Enviando e processando o vídeo — pode levar um minuto...';
  msg.className = 'form-msg';
  // Sem travar o input, escolher outro arquivo durante o envio disparava
  // um segundo POST concorrente e duas listas fora de ordem.
  input.disabled = true;
  const form = new FormData();
  form.append('arquivo', input.files[0]);

  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/criativos`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || '');
    msg.textContent = 'Criativo enviado! Ele entra em análise antes de ir pro ar.';
    msg.className = 'form-msg ok';
    input.value = '';
    carregarCriativos();
  } catch (err) {
    msg.textContent = err.message || 'Não foi possível enviar o criativo agora. Tente de novo.';
    msg.className = 'form-msg err';
  } finally {
    input.disabled = false;
  }
});

carregar().catch(() => {
  document.getElementById('statusBanner').textContent = 'Não foi possível carregar sua conta agora.';
});
