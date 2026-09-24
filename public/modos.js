// Modo anúncios do painel único: a conta sem o papel "anunciante" vê o card
// de ativação (este arquivo) no lugar da campanha. Ponto e vendedor tinham
// página e card próprios aqui; saíram com o painel único (Fatia 6,
// 23/09/2026) — o pedido de ponto mora em public/meus-pontos.js.
//
// Uso: montarModo('anunciante', containerDaCampanha, (estado) => ...).
// Requer /config.js e /layout.js.
(function () {
  const $ = (sel, raiz) => (raiz || document).querySelector(sel);

  async function estadoDosModos() {
    const r = await fetch(`${API_BASE_URL}/conta/modos`, { credentials: 'include' });
    if (r.status === 401) {
      window.location.href = '/anunciante/login.html';
      return null;
    }
    if (!r.ok) throw new Error('modos');
    return r.json();
  }

  async function enviar(caminho, corpo, metodo = 'POST') {
    const r = await fetch(`${API_BASE_URL}${caminho}`, {
      method: metodo,
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(corpo || {}),
    });
    const dados = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(dados.erro || 'Não foi possível concluir agora.');
    return dados;
  }

  // ---- cards de ativação, um por modo ----
  const CARDS = {
    anunciante(_estado) {
      return `
        <form class="card wide modo-card" id="formModo">
          <p class="eyebrow">Modo anúncios</p>
          <h3>Coloque a sua marca nas telas da cidade</h3>
          <p class="form-hint u-m-0 u-mb-6">Sua conta já existe, pra anunciar só falta o endereço da empresa (vai na nota fiscal). Depois é escolher um plano e subir o vídeo.</p>
          ${candidaturaCampoEndereco('m_')}
          ${candidaturaCampoSegmento('m_', 'Ramo de atividade')}
          <p class="form-hint">O ramo garante que você não divida a tela com um concorrente direto.</p>
          <button class="btn primary" type="submit">Ativar modo anúncios</button>
          <p class="form-msg" id="modoMsg" role="status"></p>
        </form>`;
    },
  };

  async function submeter(modo, form, _estado, container, aoLiberado) {
    const msg = $('#modoMsg', form);
    msg.textContent = 'Enviando...';
    msg.className = 'form-msg';
    try {
      await enviar('/conta/modos/anunciante', {
        ...candidaturaEnderecoDoForm(form),
        categoria_id: form.categoria_id.value || null,
        categoria_livre: form.querySelector('[data-categoria-livre]').hidden ? null : form.categoria_livre.value.trim(),
      });
      // Sem reload: busca o estado de novo (agora liberado) e deixa
      // montarModo trocar o card pela campanha de verdade, no lugar.
      await montarModo(modo, container, aoLiberado);
    } catch (err) {
      msg.textContent = err.message;
      msg.className = 'form-msg err';
    }
  }

  // Desenha o modo: liberado → chama `aoLiberado(estado)`; bloqueado → card.
  // `container` é o bloco do dashboard, escondido quando bloqueado.
  window.montarModo = async function montarModo(modo, container, aoLiberado) {
    let estado;
    try {
      estado = await estadoDosModos();
    } catch {
      return null;
    }
    if (!estado) return null;
    if (window.aplicarPapeisNoMenu) window.aplicarPapeisNoMenu({ papeis: estado.papeis });
    // Card de uma chamada anterior desta mesma função (reaproveitada depois
    // de ativar/pedir, sem reload — ver submeter()) nunca pode duplicar nem
    // ficar órfão na tela.
    const anterior = container.parentNode?.querySelector(`[data-modo-card="${modo}"]`);
    if (anterior) anterior.remove();
    if (estado.modos[modo].liberado) {
      container.hidden = false;
      if (aoLiberado) await aoLiberado(estado);
      return estado;
    }
    container.hidden = true;
    const caixa = document.createElement('div');
    caixa.className = 'wrap';
    caixa.dataset.modoCard = modo;
    caixa.innerHTML = CARDS[modo](estado);
    container.parentNode.insertBefore(caixa, container);
    const card = caixa.firstElementChild;
    const form = card.id === 'formModo' ? card : $('#formModo', card);
    if (form) {
      if (window.ligarCep) window.ligarCep(card);
      if (window.ligarCategorias) window.ligarCategorias(card);
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submeter(modo, form, estado, container, aoLiberado);
      });
    }
    return estado;
  };
})();
