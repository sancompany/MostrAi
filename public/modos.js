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

  // Card de bônus de plano (anúncios → tela; ponto → anúncio grátis), pra
  // mostrar dentro dos dashboards liberados.
  window.cardBonus = function cardBonus(estado, qual) {
    const b = estado.bonus?.[qual];
    if (!b) return '';
    if (qual === 'ponto') {
      // Antes: `return ''` — quem ja e ponto simplesmente nao via o bonus que
      // o plano dele vende, e ninguem dizia por que. Sumir com a informacao e
      // pior do que dizer que ela nao se aplica: o cliente pagou por um plano
      // que anuncia "ganhe uma tela" e nao entende se ja ganhou, se perdeu ou
      // se o site esqueceu.
      if (b.ja_e_ponto) {
        return `<div class="aviso-fundador"><b>Bônus do plano:</b> ele dá uma tela no comércio de quem ainda não é ponto da rede,
          e você já é. Quer uma tela em outro endereço seu? <a href="/anunciante/painel.html#modPontos">Cadastre o endereço</a> ou
          <a href="/contato.html">fale com a gente</a>.</div>`;
      }
      if (b.resgatado_em)
        return `<div class="aviso-fundador"><b>Bônus do plano resgatado</b> em ${new Date(b.resgatado_em).toLocaleDateString('pt-BR')}. Sua tela está sendo combinada. Acompanhe em "Meus pontos".</div>`;
      const falta = Math.max(0, b.apos_meses - b.meses_cobertos);
      return b.disponivel
        ? `<div class="aviso-fundador"><b>Você ganhou uma tela no seu comércio!</b> Seu plano completou ${b.apos_meses} meses. <a href="/anunciante/painel.html#modPontos">Pedir minha tela →</a></div>`
        : `<div class="aviso-fundador"><b>Bônus do plano:</b> ao completar ${b.apos_meses} meses você ganha uma tela no seu comércio, ${b.meses_cobertos} de ${b.apos_meses} ${b.apos_meses > 1 ? 'meses' : 'mês'} (faltam ${falta}).</div>`;
    }
    if (qual === 'anuncio') {
      if (b.resgatado_em)
        return `<div class="aviso-fundador"><b>Bônus resgatado</b> em ${new Date(b.resgatado_em).toLocaleDateString('pt-BR')}: ${b.meses_gratis} ${b.meses_gratis > 1 ? 'meses' : 'mês'} do plano ${esc(b.plano_nome)}. Veja no seu painel.</div>`;
      const falta = Math.max(0, b.apos_meses - b.meses_ativo);
      return b.disponivel
        ? `<div class="aviso-fundador"><b>Você ganhou ${b.meses_gratis} ${b.meses_gratis > 1 ? 'meses' : 'mês'} do plano ${esc(b.plano_nome)}!</b> Seu ponto completou ${b.apos_meses} meses no ar. <button type="button" class="btn primary u-ml-8" id="btnResgatarAnuncio">Ativar meu anúncio grátis</button><span id="msgResgateBonus" class="form-hint"></span></div>`
        : `<div class="aviso-fundador"><b>Bônus da opção ${esc(b.opcao)}:</b> com ${b.apos_meses} meses de ponto no ar você ganha ${b.meses_gratis} ${b.meses_gratis > 1 ? 'meses' : 'mês'} do plano ${esc(b.plano_nome)}, ${b.meses_ativo} de ${b.apos_meses} (faltam ${falta}).</div>`;
    }
    return '';
  };

  // `aoResgatar` recarrega o que depende do plano, no lugar — sem ele (página
  // que não é o painel), vai pro painel. `#msgResgateBonus` e não
  // `#msgResgate`: esse id já é do diálogo de resgate de créditos no painel,
  // e com os dois na mesma página a mensagem caía no lugar errado.
  window.ligarResgateAnuncio = function ligarResgateAnuncio(raiz, aoResgatar) {
    const btn = $('#btnResgatarAnuncio', raiz);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await enviar('/conta/bonus/anuncio/resgatar', {});
        $('#msgResgateBonus', raiz).textContent = 'Ativado!';
        if (aoResgatar) aoResgatar();
        else window.location.href = '/anunciante/painel.html';
      } catch (err) {
        btn.disabled = false;
        $('#msgResgateBonus', raiz).textContent = err.message;
      }
    });
  };
})();
