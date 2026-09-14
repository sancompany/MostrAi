let CONTA = null;
let TELAS = [];

async function carregar() {
  CONTA = await carregarConta();
  if (!CONTA) { window.location.href = '/anunciante/login.html'; return; }
  montarPerfil(CONTA, (nova) => { CONTA = nova; });
  // Painel único (modos.js): sem o papel "ponto", card de ativação.
  const estado = await montarModo('ponto', document.getElementById('dashboardPonto'), async (estado) => {
    document.getElementById('statusBanner').innerHTML = `<span><strong>${esc(CONTA.nome_empresa)}</strong> · meu ponto</span>`;
    document.getElementById('bonusPonto').innerHTML = cardBonus(estado, 'anuncio');
    ligarResgateAnuncio(document.getElementById('bonusPonto'));
    await Promise.all([carregarTelas(), carregarPontos(), carregarExtrato()]);
  });
  if (estado && !estado.modos.ponto.liberado) {
    document.getElementById('statusBanner').innerHTML = `<span><strong>${esc(CONTA.nome_empresa)}</strong> · modo meu ponto ainda não ativado</span>`;
  }
}

function tempoDesde(iso) {
  if (!iso) return 'nunca ligou';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 3) return 'online agora';
  if (min < 60) return `há ${min} min`;
  if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
  return `há ${Math.round(min / 1440)} dias`;
}
const online = (iso) => iso && (Date.now() - new Date(iso)) < 3 * 60000;

async function carregarTelas() {
  const el = document.getElementById('telasLista');
  try {
    TELAS = await (await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/dispositivos`, { credentials: 'include' })).json();
    const ativas = TELAS.filter((t) => t.status === 'ativo').length;
    const exib = TELAS.reduce((s, t) => s + (t.exibicoes_30d || 0), 0);
    const anunciantes = Math.max(0, ...TELAS.map((t) => t.anunciantes_30d || 0));
    document.getElementById('kpis').innerHTML = `
      <div class="kpi-card"><span class="kpi-label">Telas</span><b>${TELAS.length}</b><span>${ativas} no ar</span></div>
      <div class="kpi-card"><span class="kpi-label">Exibições em 30 dias</span><b>${exib.toLocaleString('pt-BR')}</b><span>somando todas as telas</span></div>
      <div class="kpi-card"><span class="kpi-label">Anunciantes na sua tela</span><b>${anunciantes}</b><span>nos últimos 30 dias</span></div>`;
    if (!TELAS.length) {
      el.innerHTML = '<p class="empty-state">Nenhuma tela instalada ainda — assim que a gente instalar, ela aparece aqui.</p>';
      return;
    }
    el.innerHTML = TELAS.map((t) => `
      <div class="tela-card">
        <div class="tela-topo">
          <b>${esc(t.apelido)}</b>
          <span class="online ${online(t.ultima_vez_online) ? 'on' : ''}">${tempoDesde(t.ultima_vez_online)}</span>
        </div>
        <div class="tela-meta">${esc(t.ponto_nome)}<br>${esc(t.endereco)}</div>
        ${t.ponto_status !== 'ativo'
          ? `<span class="badge ${ROTULOS.pontoClasse[t.ponto_status] || 'badge-pendente'}">${esc(ROTULOS.ponto[t.ponto_status] || t.ponto_status)}</span>`
          : `<span class="badge ${ROTULOS.pontoClasse[t.status] || 'badge-pendente'}">${esc(ROTULOS.ponto[t.status] || t.status)}</span>`}
        <div class="tela-meta"><b>${(t.exibicoes_30d || 0).toLocaleString('pt-BR')}</b> exibições · <b>${t.anunciantes_30d || 0}</b> anunciantes (30 dias)</div>
        <div class="tela-acoes"><button type="button" class="btn ghost" data-painel="${t.id}">Ver o que rodou</button></div>
      </div>`).join('');
    el.querySelectorAll('[data-painel]').forEach((b) => b.addEventListener('click', () => abrirPainel(Number(b.dataset.painel))));
  } catch {
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar suas telas agora.</p>';
  }
}

async function abrirPainel(id) {
  const tela = TELAS.find((t) => t.id === id);
  document.getElementById('modalTelaTitulo').textContent = `${tela.apelido} — ${tela.ponto_nome}`;
  const corpo = document.getElementById('modalTelaCorpo');
  corpo.textContent = 'Carregando...';
  document.getElementById('modalTela').showModal();
  try {
    const d = await (await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/dispositivos/${id}/painel`, { credentials: 'include' })).json();
    const total = d.porAnunciante.reduce((s, a) => s + a.confirmadas, 0);
    const max = Math.max(...d.porDia.map((y) => y.confirmadas), 1);
    corpo.innerHTML = `
      <p class="form-hint">Últimos 30 dias · ${total.toLocaleString('pt-BR')} exibições confirmadas pela própria tela.</p>
      ${d.porAnunciante.length ? `<table class="mini-table"><thead><tr><th>Anunciante</th><th>Programadas</th><th>Confirmadas</th></tr></thead><tbody>
        ${d.porAnunciante.map((a) => `<tr><td>${esc(a.nome_empresa)}</td><td>${a.programadas}</td><td>${a.confirmadas}</td></tr>`).join('')}
      </tbody></table>` : '<p class="empty-state">Nada rodou nessa tela ainda.</p>'}
      ${d.porDia.length ? `<p class="form-sep-titulo u-mt-14">Por dia</p><div class="bar-chart-h">
        ${d.porDia.slice(0, 14).reverse().map((x) => `<div class="row"><span class="nome">${new Date(x.dia).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })}</span><span class="track"><span class="fill" data-pct="${Math.round(x.confirmadas / max * 100)}"></span></span><span class="valor">${x.confirmadas}</span></div>`).join('')}
      </div>` : ''}`;
  } catch {
    corpo.innerHTML = '<p class="form-msg err">Não deu pra carregar o painel dessa tela.</p>';
  }
}
document.getElementById('fecharModalTela').addEventListener('click', () => document.getElementById('modalTela').close());
document.getElementById('modalTela').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });

async function carregarPontos() {
  const el = document.getElementById('pontosLista');
  try {
    const pontos = await (await fetch(`${API_BASE_URL}/anunciantes/${CONTA.id}/pontos`, { credentials: 'include' })).json();
    if (!pontos.length) {
      el.innerHTML = '<p class="empty-state">Nenhum endereço cadastrado ainda.</p>';
      return;
    }
    el.innerHTML = pontos.map((p) => `
      <div class="ponto-endereco-card">
        <span class="badge ${ROTULOS.pontoClasse[p.status] || 'badge-pendente'}">${esc(ROTULOS.ponto[p.status] || p.status)}</span>
        <strong>${esc(p.nome || '')}</strong>
        <span>${esc(p.endereco)}</span>
        <span class="u-dim u-fs-88">${esc(p.cidade || '')}${p.uf ? '/' + esc(p.uf) : ''}</span>
        ${Number(p.valor_pago_mensal) > 0 ? `<span class="u-fs-85">Ajuda de custo: <b>${fmtBRL(p.valor_pago_mensal)}/mês</b></span>` : ''}
        ${p.cota_autoanuncio_slots_hora ? `<span class="u-fs-85 u-dim">Cota do seu anúncio: ${p.cota_autoanuncio_slots_hora}x por hora, dividida entre as telas</span>` : ''}
      </div>`).join('');
  } catch {
    el.innerHTML = '<p class="form-msg err">Não foi possível carregar seus endereços agora.</p>';
  }
}

const formEnd = document.getElementById('formEndereco');
document.getElementById('btnNovoEndereco').addEventListener('click', () => { formEnd.hidden = false; formEnd.scrollIntoView({ behavior: 'smooth' }); });
document.getElementById('btnCancelarEndereco').addEventListener('click', () => { formEnd.hidden = true; });
formEnd.addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msgEndereco');
  msg.textContent = 'Enviando...'; msg.className = 'form-msg';
  const opcao = formEnd.categoria_id.options[formEnd.categoria_id.selectedIndex];
  const usouLivre = !formEnd.querySelector('[data-categoria-livre]').hidden;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        nome: formEnd.nome.value.trim(),
        endereco: `${formEnd.endereco.value.trim()}, ${formEnd.numero.value.trim()}`,
        cidade: formEnd.cidade.value.trim(), uf: formEnd.uf.value.trim().toUpperCase(), cep: formEnd.cep.value.trim(),
        segmento: usouLivre ? formEnd.categoria_livre.value.trim() : (opcao ? opcao.dataset.nome : ''),
      }),
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro || 'falha');
    msg.textContent = 'Pedido enviado — a gente chama no WhatsApp pra combinar.'; msg.className = 'form-msg ok';
    formEnd.reset(); formEnd.hidden = true;
    carregarPontos();
  } catch (err) {
    msg.textContent = err.message === 'falha' ? 'Não foi possível enviar agora.' : err.message; msg.className = 'form-msg err';
  }
});

carregar().catch(() => {
  document.getElementById('statusBanner').textContent = 'Não foi possível carregar sua conta agora.';
});
