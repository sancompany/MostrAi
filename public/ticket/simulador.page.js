// Trimundi — tela do pagamento SIMULADO (só desenvolvimento,
// TRIMUNDI_PAGAMENTO_SIMULADO=1). Faz o papel da tela do San Checkout: o
// servidor gera o aviso assinado e ele passa pelo mesmo caminho do real.
(() => {
  const { el, moeda, api, enviando } = window.trimundi;
  const id = window.location.pathname.split('/')[4] || '';
  const t = new URLSearchParams(window.location.search).get('t') || '';
  const resumo = document.getElementById('resumo');
  const msg = document.getElementById('msg');
  const voltar = () => (window.location.href = `/ticket/pedido/${id}?t=${encodeURIComponent(t)}`);

  async function carregar() {
    try {
      const d = await api(`/ticket/api/pedidos/${encodeURIComponent(id)}`, { cabecalhos: { 'X-Pedido-Token': t } });
      resumo.replaceChildren(
        el('h2', { text: `${d.edicao.evento} — ${d.edicao.nome}` }),
        el('p', { text: `Pedido ${d.pedido.codigo} · ${d.pedido.status_rotulo}` }),
        el('p', { class: 'preco', text: moeda(d.pedido.total_centavos) }),
      );
      if (d.pedido.status !== 'aguardando_pagamento') {
        for (const b of document.querySelectorAll('.acoes button')) b.disabled = true;
        msg.textContent = 'Este pedido não está aguardando pagamento.';
      }
    } catch (err) {
      resumo.replaceChildren(el('p', { text: err.message }));
    }
  }

  async function simular(botao, acao) {
    msg.className = 'mensagem';
    try {
      const r = await enviando(botao, 'Enviando...', () =>
        api(`/ticket/api/dev/pagamento/${encodeURIComponent(id)}`, { metodo: 'POST', corpo: { t, acao } }),
      );
      if (r.status === 'pago' || r.recusado) return voltar();
      msg.textContent = `Situação do pedido: ${r.status}.`;
    } catch (err) {
      msg.className = 'mensagem erro';
      msg.textContent = err.message;
    }
  }

  document.getElementById('aprovar').addEventListener('click', (e) => simular(e.currentTarget, 'aprovar'));
  document.getElementById('recusar').addEventListener('click', (e) => simular(e.currentTarget, 'recusar'));
  carregar();
})();
