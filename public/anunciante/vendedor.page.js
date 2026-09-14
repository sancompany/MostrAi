let CONTA = null;

async function carregar() {
  CONTA = await carregarConta();
  if (!CONTA) { window.location.href = '/anunciante/login.html'; return; }
  montarPerfil(CONTA, (nova) => { CONTA = nova; });
  // Painel único (modos.js): sem o papel "vendedor", card de ativação.
  const estado = await montarModo('vendedor', document.getElementById('dashboardVendas'), carregarVendas);
  if (estado && !estado.modos.vendedor.liberado) {
    document.getElementById('statusBanner').innerHTML = `<span><strong>${esc(CONTA.nome_empresa)}</strong> · modo vendas ainda não ativado</span>`;
    document.getElementById('comissoes').innerHTML = '';
  }
}

document.getElementById('formPix').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = document.getElementById('msgPix');
  const r = await fetch(`${API_BASE_URL}/vendedor/me`, { method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chave_pix: e.target.chave_pix.value.trim() }) });
  if (!r.ok) { msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não deu pra salvar.'; msg.className = 'form-msg err'; return; }
  window.location.reload();
});

async function carregarVendas() {
  const r = await fetch(`${API_BASE_URL}/vendedor/painel`, { credentials: 'include' });
  if (!r.ok) throw new Error();
  const d = await r.json();
  const v = d.vendedor;

  document.getElementById('statusBanner').innerHTML = `<span><strong>${esc(CONTA.nome_empresa)}</strong> · vendedor</span><span class="badge ${v.status === 'aprovado' ? 'badge-ok' : 'badge-pendente'}">${esc(ROTULOS.vendedor[v.status] || v.status)}</span>`;

  const indicados = new Set(d.comissoes.map((c) => c.anunciante_id)).size;
  document.getElementById('kpis').innerHTML = `
    <div class="kpi-card"><span class="kpi-label">A receber</span><b>${fmtBRL(d.totalAReceber)}</b><span>ainda não pago</span></div>
    <div class="kpi-card"><span class="kpi-label">Já recebido</span><b>${fmtBRL(d.totalPago)}</b><span>pago no seu Pix</span></div>
    <div class="kpi-card"><span class="kpi-label">Total comissionado</span><b>${fmtBRL(d.totalComissionado)}</b><span>desde o início</span></div>
    <div class="kpi-card"><span class="kpi-label">Clientes que pagaram</span><b>${indicados}</b><span>indicados com cobrança confirmada</span></div>`;

  const link = `${window.location.origin}/anunciante/cadastro.html?ref=${encodeURIComponent(v.codigo_cupom)}`;
  document.getElementById('cupom').textContent = v.codigo_cupom;
  document.getElementById('linkCupom').textContent = link;
  document.getElementById('pct').textContent = `${Number(v.comissao_percentual)}%`;
  document.getElementById('pix').textContent = v.chave_pix || '(falta cadastrar)';
  document.getElementById('avisoPix').hidden = !!v.chave_pix;
  document.getElementById('btnWhats').href = `https://wa.me/?text=${encodeURIComponent(`Coloca a sua marca nas telas da Mostraí em Matão. Cadastra por aqui com o meu cupom ${v.codigo_cupom}: ${link}`)}`;
  document.getElementById('cupomCard').hidden = false;

  const lista = document.getElementById('comissoes');
  if (!d.comissoes.length) {
    lista.innerHTML = '<p class="empty-state">Nenhuma comissão ainda. Cada assinatura paga por um indicado seu aparece aqui.</p>';
    return;
  }
  lista.innerHTML = `<table class="mini-table"><thead><tr><th>Data</th><th>Anunciante</th><th>Cobrança</th><th>Sua comissão</th><th>Situação</th></tr></thead><tbody>
    ${d.comissoes.map((c) => `<tr>
      <td>${new Date(c.criado_em).toLocaleDateString('pt-BR')}</td>
      <td>${esc(c.nome_empresa)}</td>
      <td>${fmtBRL(c.valor_confirmado)}</td>
      <td><b>${fmtBRL(c.comissao_valor)}</b></td>
      <td>${c.pago_em ? `<span class="badge badge-ok">Pago em ${new Date(c.pago_em).toLocaleDateString('pt-BR')}</span>` : '<span class="badge badge-pendente">A receber</span>'}</td>
    </tr>`).join('')}
  </tbody></table>`;
}

function copiar(texto, btn) {
  navigator.clipboard.writeText(texto).then(() => {
    const antes = btn.textContent; btn.textContent = 'Copiado!';
    setTimeout(() => { btn.textContent = antes; }, 1500);
  }).catch(() => {});
}
document.getElementById('btnCopiarCupom').addEventListener('click', (e) => copiar(document.getElementById('cupom').textContent, e.currentTarget));
document.getElementById('btnCopiarLink').addEventListener('click', (e) => copiar(document.getElementById('linkCupom').textContent, e.currentTarget));

carregar().catch(() => {
  document.getElementById('statusBanner').textContent = 'Não foi possível carregar seu painel agora.';
  document.getElementById('comissoes').innerHTML = '';
});
