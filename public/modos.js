// Painel único, três modos: Anúncios, Meu ponto, Vendas. Cada página é um
// modo; a conta só tem liberado o que tem papel. Modo bloqueado mostra o card
// de ativação (este arquivo) em vez do dashboard.
//
// Uso: montarModo('anunciante'|'ponto'|'vendedor', containerDoDashboard,
// (estado) => desenharDashboard(estado)). Requer /config.js e /layout.js.
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

  // Endereço, segmento, horário semanal, foto com preview e preview de card:
  // todos vêm do módulo canônico compartilhado (public/candidatura-ponto.js,
  // rodada de Ofertas/Promoções, 22/09/2026) — mesmos campos, mesma
  // validação, usados aqui e em painel.page.js/ponto.page.js.

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
    ponto(estado) {
      const pedido = estado.modos.ponto.pedido;
      const bonus = estado.bonus?.ponto;
      if (pedido) {
        return `
          <div class="card wide modo-card u-ta-c">
            <p class="eyebrow">Modo meu ponto</p>
            <h3>Pedido enviado em ${new Date(pedido.criado_em).toLocaleDateString('pt-BR')}</h3>
            <p class="form-hint">${pedido.origem === 'bonus_plano' ? 'É o bônus do seu plano. ' : ''}A gente chama no WhatsApp pra combinar a visita e a instalação. Assim que liberar, esse modo abre aqui.</p>
          </div>`;
      }
      const ganhou = bonus?.disponivel;
      return `
        <div class="candidatura-layout">
          <form class="card wide modo-card" id="formModo" data-bonus="${ganhou ? '1' : ''}">
            <p class="eyebrow">Modo meu ponto</p>
            <h3>${ganhou ? 'Você ganhou uma tela no seu comércio!' : 'Quero uma tela no meu comércio'}</h3>
            <p class="form-hint u-m-0 u-mb-6">${
              ganhou
                ? `Seu plano completou ${bonus.apos_meses} meses e dá direito a uma tela instalada, sem custo. Conta onde ela vai ficar.`
                : 'A tela, a instalação e o conteúdo são por nossa conta. Você escolhe ajuda de custo ou mais espaço pro seu próprio anúncio. Conta um pouco sobre o seu comércio e a gente chama pra combinar.'
            }</p>
            <p class="form-sep-titulo u-mt-0">Estabelecimento</p>
            <div><label for="m_nome_comercio">Nome do estabelecimento</label><input id="m_nome_comercio" name="nome_comercio" required></div>
            ${candidaturaCampoFoto('m_')}
            ${candidaturaCampoEndereco('m_')}
            ${candidaturaCampoSegmento('m_', 'Segmento')}
            <div><label for="m_fluxo">Média de pessoas que passam por mês</label><input id="m_fluxo" name="fluxo_estimado_mensal" type="number" min="1" inputmode="numeric" required></div>
            ${candidaturaCampoHorario()}
            <p class="form-sep-titulo u-mt-8">Como você quer ser recompensado</p>
            <div class="escolha-grid" id="modoEscolhaPlano"></div>
            <p class="form-sep-titulo u-mt-8">Informações adicionais</p>
            <div><label for="m_mensagem">Algo mais? (opcional)</label><textarea id="m_mensagem" name="mensagem" rows="2" placeholder="Estacionamento, ponto de referência, horário de pico..."></textarea></div>
            <button class="btn primary" type="submit">${ganhou ? 'Pedir minha tela' : 'Enviar pedido'}</button>
            <p class="form-msg" id="modoMsg" role="status"></p>
          </form>
          ${candidaturaCampoPreview()}
        </div>`;
    },
    // Sem pedido self-service (18/09/2026, a pedido do dono) — quem quer
    // vender fala direto com a gente por um canal oficial, e quem entra,
    // entra por convite que o dono gera à mão depois da conversa. Não é
    // formulário: é aviso só, o mesmo tom do card da home.
    vendedor(estado) {
      // Pedido de antes de 18/09/2026 (self-service já aposentado, mas a
      // linha antiga pode continuar em aberto) — mesmo tratamento do card
      // de ponto: nunca deixar sem resposta quem já pediu.
      const pedido = estado.modos.vendedor.pedido;
      if (pedido) {
        return `
          <div class="card wide modo-card u-ta-c">
            <p class="eyebrow">Modo vendas</p>
            <h3>Pedido enviado em ${new Date(pedido.criado_em).toLocaleDateString('pt-BR')}</h3>
            <p class="form-hint">A gente chama no WhatsApp pra explicar o produto e a comissão. Assim que liberar, seu cupom aparece aqui.</p>
          </div>`;
      }
      return `
        <div class="card wide modo-card u-ta-c">
          <p class="eyebrow">Modo vendas</p>
          <h3>Quer ser vendedor parceiro?</h3>
          <p class="form-hint u-m-0">Fale direto com a gente pra combinar a indicação e a comissão. É a gente que libera esse modo na sua conta depois da conversa.</p>
          <a class="btn primary u-mt-8" href="/contato.html">Falar com a gente</a>
        </div>`;
    },
  };

  async function carregarOpcoesComodato(caixa) {
    if (!caixa) return;
    try {
      const planos = await (await fetch(`${API_BASE_URL}/planos-ponto`)).json();
      caixa.innerHTML = planos
        .map(
          (p, i) => `
        <label class="escolha">
          <input type="radio" name="plano_ponto_id" value="${esc(p.id)}" ${i === 0 ? 'checked' : ''}>
          <span class="box">
            <b>${esc(p.nome)}${Number(p.ajuda_custo_mensal) > 0 ? `, ${fmtBRL(p.ajuda_custo_mensal)}/mês` : ''}</b>
            <small>${esc(p.chamada || '')}</small>
            <ul>${(p.beneficios || []).map((b) => `<li>${esc(b)}</li>`).join('')}
              ${p.plano_bonus_id ? `<li>Depois de ${p.plano_bonus_apos_meses} meses como ponto, ganhe ${p.plano_bonus_meses} ${p.plano_bonus_meses > 1 ? 'meses' : 'mês'} de anúncio grátis</li>` : ''}</ul>
          </span>
        </label>`,
        )
        .join('');
    } catch {
      caixa.innerHTML = '<p class="form-hint">Não deu pra carregar as opções, a gente combina no WhatsApp.</p>';
    }
  }

  async function submeter(modo, form, _estado) {
    const msg = $('#modoMsg', form);
    msg.textContent = 'Enviando...';
    msg.className = 'form-msg';
    try {
      if (modo === 'anunciante') {
        await enviar('/conta/modos/anunciante', {
          ...candidaturaEnderecoDoForm(form),
          categoria_id: form.categoria_id.value || null,
          categoria_livre: form.querySelector('[data-categoria-livre]').hidden
            ? null
            : form.categoria_livre.value.trim(),
        });
        msg.textContent = 'Modo anúncios ativado!';
        msg.className = 'form-msg ok';
        window.location.reload();
        return;
      }
      // Só ponto pede por aqui — vendedor não tem form (card `vendedor` acima
      // é só aviso), então este submeter() nunca é chamado com outro modo.
      const escolhido = form.querySelector('input[name="plano_ponto_id"]:checked');
      const corpo = {
        nome_comercio: form.nome_comercio.value.trim(),
        ...candidaturaEnderecoDoForm(form),
        segmento: candidaturaSegmentoDoForm(form),
        fluxo_estimado_mensal: form.fluxo_estimado_mensal.value || null,
        plano_ponto_id: escolhido ? escolhido.value : null,
        mensagem: form.mensagem.value.trim() || null,
        horario_semanal: candidaturaHorarioDoForm(form),
      };
      const resposta = await enviar('/conta/modos/ponto/pedir', corpo);
      // Foto é opcional e sobe DEPOIS (furo A do redesenho da Rede,
      // 22/09/2026) — a candidatura já existe e vale sem foto nenhuma; sem
      // arquivo escolhido, nem tenta. Se o upload falhar, o pedido já foi
      // enviado mesmo assim (não trava o fluxo principal por causa da
      // foto) — só avisa.
      const arquivo = candidaturaFotoSelecionada(form, 'm_');
      if (arquivo) {
        const fd = new FormData();
        fd.append('arquivo', arquivo);
        const rFoto = await fetch(`${API_BASE_URL}/conta/modos/ponto/candidaturas/${resposta.id}/foto`, {
          method: 'POST',
          credentials: 'include',
          body: fd,
        });
        if (!rFoto.ok) console.error('falha ao enviar foto da candidatura', await rFoto.text().catch(() => ''));
      }
      msg.textContent = 'Pedido enviado, a gente chama no WhatsApp.';
      msg.className = 'form-msg ok';
      setTimeout(() => window.location.reload(), 900);
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
    if (estado.modos[modo].liberado) {
      if (aoLiberado) await aoLiberado(estado);
      return estado;
    }
    container.hidden = true;
    const caixa = document.createElement('div');
    caixa.className = 'wrap';
    caixa.innerHTML = CARDS[modo](estado);
    container.parentNode.insertBefore(caixa, container);
    const card = caixa.firstElementChild;
    const form = card.id === 'formModo' ? card : $('#formModo', card);
    if (form) {
      if (window.ligarCep) window.ligarCep(card);
      if (window.ligarCategorias) window.ligarCategorias(card);
      if (modo === 'ponto') {
        candidaturaLigarHorario(form);
        candidaturaLigarFoto(form, 'm_');
        const previewRaiz = $('.candidatura-preview', card);
        if (previewRaiz) candidaturaLigarPreviewCard(form, previewRaiz, 'm_');
      }
      carregarOpcoesComodato($('#modoEscolhaPlano', card));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        submeter(modo, form, estado);
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
          e você já é. Quer uma tela em outro endereço seu? <a href="/anunciante/ponto.html">Cadastre o endereço</a> ou
          <a href="/contato.html">fale com a gente</a>.</div>`;
      }
      if (b.resgatado_em)
        return `<div class="aviso-fundador"><b>Bônus do plano resgatado</b> em ${new Date(b.resgatado_em).toLocaleDateString('pt-BR')}. Sua tela está sendo combinada. Acompanhe em "Meu ponto".</div>`;
      const falta = Math.max(0, b.apos_meses - b.meses_cobertos);
      return b.disponivel
        ? `<div class="aviso-fundador"><b>Você ganhou uma tela no seu comércio!</b> Seu plano completou ${b.apos_meses} meses. <a href="/anunciante/ponto.html">Pedir minha tela →</a></div>`
        : `<div class="aviso-fundador"><b>Bônus do plano:</b> ao completar ${b.apos_meses} meses você ganha uma tela no seu comércio, ${b.meses_cobertos} de ${b.apos_meses} ${b.apos_meses > 1 ? 'meses' : 'mês'} (faltam ${falta}).</div>`;
    }
    if (qual === 'anuncio') {
      if (b.resgatado_em)
        return `<div class="aviso-fundador"><b>Bônus resgatado</b> em ${new Date(b.resgatado_em).toLocaleDateString('pt-BR')}: ${b.meses_gratis} ${b.meses_gratis > 1 ? 'meses' : 'mês'} do plano ${esc(b.plano_nome)}. Veja em "Anúncios".</div>`;
      const falta = Math.max(0, b.apos_meses - b.meses_ativo);
      return b.disponivel
        ? `<div class="aviso-fundador"><b>Você ganhou ${b.meses_gratis} ${b.meses_gratis > 1 ? 'meses' : 'mês'} do plano ${esc(b.plano_nome)}!</b> Seu ponto completou ${b.apos_meses} meses no ar. <button type="button" class="btn primary u-ml-8" id="btnResgatarAnuncio">Ativar meu anúncio grátis</button><span id="msgResgate" class="form-hint"></span></div>`
        : `<div class="aviso-fundador"><b>Bônus da opção ${esc(b.opcao)}:</b> com ${b.apos_meses} meses de ponto no ar você ganha ${b.meses_gratis} ${b.meses_gratis > 1 ? 'meses' : 'mês'} do plano ${esc(b.plano_nome)}, ${b.meses_ativo} de ${b.apos_meses} (faltam ${falta}).</div>`;
    }
    return '';
  };

  window.ligarResgateAnuncio = function ligarResgateAnuncio(raiz) {
    const btn = $('#btnResgatarAnuncio', raiz);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await enviar('/conta/bonus/anuncio/resgatar', {});
        $('#msgResgate', raiz).textContent = 'Ativado! Abrindo seus anúncios...';
        window.location.href = '/anunciante/painel.html';
      } catch (err) {
        btn.disabled = false;
        $('#msgResgate', raiz).textContent = err.message;
      }
    });
  };
})();
