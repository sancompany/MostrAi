// Painel único, três modos: Anúncios, Meu ponto, Vendas. Cada página é um
// modo; a conta só tem liberado o que tem papel. Modo bloqueado mostra o card
// de ativação (este arquivo) em vez do dashboard.
//
// Uso: montarModo('anunciante'|'ponto'|'vendedor', containerDoDashboard,
// (estado) => desenharDashboard(estado)). Requer /config.js e /layout.js.
(function () {
  const $ = (sel, raiz) => (raiz || document).querySelector(sel);
  const DICA_FOTO_PADRAO = 'Opcional — sem foto, usamos um ícone padrão até você mandar uma.';

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

  const CAMPOS_ENDERECO = (prefixo) => `
    <div class="field-row">
      <div class="u-col"><label for="${prefixo}cep">CEP</label><input id="${prefixo}cep" name="cep" data-cep inputmode="numeric" placeholder="00000-000" required></div>
      <div class="u-col-2"><label for="${prefixo}endereco">Rua e bairro</label><input id="${prefixo}endereco" name="endereco" required></div>
      <div class="u-col"><label for="${prefixo}numero">Número</label><input id="${prefixo}numero" name="numero" required></div>
    </div>
    <p class="form-hint" data-cep-msg>Digite o CEP e o resto vem preenchido.</p>
    <div class="field-row">
      <div class="u-col-2"><label for="${prefixo}cidade">Cidade</label><input id="${prefixo}cidade" name="cidade" value="Matão" required></div>
      <div class="u-col"><label for="${prefixo}uf">UF</label><input id="${prefixo}uf" name="uf" maxlength="2" value="SP" required></div>
    </div>`;

  const CAMPO_SEGMENTO = (prefixo, rotulo) => `
    <div><label for="${prefixo}categoria_id">${rotulo}</label><select id="${prefixo}categoria_id" name="categoria_id" data-categorias required></select></div>
    <div data-categoria-livre hidden><label for="${prefixo}categoria_livre">Qual?</label><input id="${prefixo}categoria_livre" name="categoria_livre"></div>`;

  // Foto da fachada com preview real (22/09/2026, pedido do dono — antes só
  // mostrava o nome do arquivo). Opcional sempre: sem foto, o card da
  // candidatura cai no placeholder oficial, igual sempre foi.
  const CAMPO_FOTO_FACHADA = (prefixo) => `
    <div class="campo-foto">
      <div class="campo-foto-preview" id="${prefixo}fotoPreview" hidden><img alt="Pré-visualização da foto da fachada"></div>
      <div class="campo-foto-linha">
        <label class="btn ghost mini" for="${prefixo}foto" id="${prefixo}fotoLabel">Escolher foto da fachada</label>
        <button type="button" class="btn ghost mini u-txt-erro" id="${prefixo}fotoRemover" hidden>Remover foto</button>
        <input type="file" accept="image/*" id="${prefixo}foto" hidden>
      </div>
      <span class="u-fs-72 u-dim" id="${prefixo}fotoNome">${DICA_FOTO_PADRAO}</span>
    </div>`;

  // FileReader (data:), não URL.createObjectURL — a CSP do site só libera
  // `img-src 'self' data:` (src/server.js), sem `blob:`. Achado testando: a
  // troca de foto e o texto do botão funcionavam, mas a imagem em si nunca
  // aparecia, bloqueada pelo navegador em silêncio.
  function ligarFotoFachada(form, prefixo) {
    const input = $(`#${prefixo}foto`, form);
    if (!input) return;
    const preview = $(`#${prefixo}fotoPreview`, form);
    const label = $(`#${prefixo}fotoLabel`, form);
    const remover = $(`#${prefixo}fotoRemover`, form);
    const hint = $(`#${prefixo}fotoNome`, form);
    const limpar = () => {
      preview.hidden = true;
      preview.querySelector('img').src = '';
      label.textContent = 'Escolher foto da fachada';
      remover.hidden = true;
      hint.textContent = DICA_FOTO_PADRAO;
    };
    input.addEventListener('change', () => {
      const arquivo = input.files[0];
      if (!arquivo) return limpar();
      const leitor = new FileReader();
      leitor.onload = () => {
        // Achado do review: se o usuário clicou "Remover foto" ou trocou de
        // arquivo antes da leitura terminar, `input.files[0]` já não é mais
        // este `arquivo` — descarta a leitura velha em vez de sobrescrever
        // a prévia com uma foto removida/superada.
        if (input.files[0] !== arquivo) return;
        preview.querySelector('img').src = leitor.result;
        preview.hidden = false;
      };
      leitor.readAsDataURL(arquivo);
      label.textContent = 'Trocar foto';
      remover.hidden = false;
      hint.textContent = arquivo.name;
    });
    remover.addEventListener('click', () => {
      input.value = '';
      limpar();
    });
  }

  // Horário de funcionamento do ponto, dia a dia + feriados (rodada final
  // da Rede, 22/09/2026 — substitui os 3 grupos de antes). O schema sempre
  // guardou por dia (src/lib/horario-semanal.js); só o formulário mudou.
  const DIAS_HORARIO = [
    { id: 'seg', rotulo: 'Segunda', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
    { id: 'ter', rotulo: 'Terça', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
    { id: 'qua', rotulo: 'Quarta', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
    { id: 'qui', rotulo: 'Quinta', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
    { id: 'sex', rotulo: 'Sexta', fechadoPadrao: false, abre: '09:00', fecha: '18:00' },
    { id: 'sab', rotulo: 'Sábado', fechadoPadrao: false, abre: '09:00', fecha: '15:00' },
    { id: 'dom', rotulo: 'Domingo', fechadoPadrao: true, abre: '09:00', fecha: '13:00' },
    { id: 'feriados', rotulo: 'Feriados', fechadoPadrao: true, abre: '09:00', fecha: '13:00' },
  ];

  const CAMPO_HORARIO_SEMANAL = () => `
    <p class="form-sep-titulo u-mt-8">Horário de funcionamento</p>
    <div class="horario-semanal">
      ${DIAS_HORARIO.map(
        (d) => `
        <div class="horario-dia" data-horario-dia="${d.id}">
          <span class="horario-dia-nome">${d.rotulo}</span>
          <div class="horario-dia-campos" ${d.fechadoPadrao ? 'hidden' : ''}>
            <input class="mini" type="time" data-horario-abre value="${d.abre}" aria-label="${d.rotulo}, abre">
            <span class="u-dim">–</span>
            <input class="mini" type="time" data-horario-fecha value="${d.fecha}" aria-label="${d.rotulo}, fecha">
          </div>
          <label class="check-row horario-dia-fechado"><input type="checkbox" data-horario-fechado ${d.fechadoPadrao ? 'checked' : ''}><span>Fechado</span></label>
        </div>`,
      ).join('')}
    </div>`;

  function ligarHorarioSemanal(form) {
    form.querySelectorAll('[data-horario-dia]').forEach((linha) => {
      const chk = linha.querySelector('[data-horario-fechado]');
      const campos = linha.querySelector('.horario-dia-campos');
      chk.addEventListener('change', () => {
        campos.hidden = chk.checked;
      });
    });
  }

  function lerHorarioSemanalDoForm(form) {
    const horario = {};
    form.querySelectorAll('[data-horario-dia]').forEach((linha) => {
      const dia = linha.dataset.horarioDia;
      const fechado = linha.querySelector('[data-horario-fechado]').checked;
      horario[dia] = fechado
        ? null
        : {
            abre: linha.querySelector('[data-horario-abre]').value,
            fecha: linha.querySelector('[data-horario-fecha]').value,
          };
    });
    return horario;
  }

  function segmentoDe(form) {
    const sel = form.categoria_id;
    const opcao = sel?.options[sel.selectedIndex];
    const livre = form.querySelector('[data-categoria-livre]');
    return livre && !livre.hidden ? form.categoria_livre.value.trim() : opcao ? opcao.dataset.nome || '' : '';
  }

  function enderecoDe(form) {
    return {
      endereco: `${form.endereco.value.trim()}, ${form.numero.value.trim()}`,
      cidade: form.cidade.value.trim(),
      uf: form.uf.value.trim().toUpperCase(),
      cep: form.cep.value.trim(),
    };
  }

  // ---- cards de ativação, um por modo ----
  const CARDS = {
    anunciante(_estado) {
      return `
        <form class="card wide modo-card" id="formModo">
          <p class="eyebrow">Modo anúncios</p>
          <h3>Coloque a sua marca nas telas da cidade</h3>
          <p class="form-hint u-m-0 u-mb-6">Sua conta já existe, pra anunciar só falta o endereço da empresa (vai na nota fiscal). Depois é escolher um plano e subir o vídeo.</p>
          ${CAMPOS_ENDERECO('m_')}
          ${CAMPO_SEGMENTO('m_', 'Ramo de atividade')}
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
          ${CAMPO_FOTO_FACHADA('m_')}
          ${CAMPOS_ENDERECO('m_')}
          ${CAMPO_SEGMENTO('m_', 'Segmento')}
          <div><label for="m_fluxo">Média de pessoas que passam por mês (opcional)</label><input id="m_fluxo" name="fluxo_estimado_mensal" type="number" min="0" inputmode="numeric"></div>
          ${CAMPO_HORARIO_SEMANAL()}
          <p class="form-sep-titulo u-mt-8">Como você quer ser recompensado</p>
          <div class="escolha-grid" id="modoEscolhaPlano"></div>
          <p class="form-sep-titulo u-mt-8">Informações adicionais</p>
          <div><label for="m_mensagem">Algo mais? (opcional)</label><textarea id="m_mensagem" name="mensagem" rows="2" placeholder="Estacionamento, ponto de referência, horário de pico..."></textarea></div>
          <button class="btn primary" type="submit">${ganhou ? 'Pedir minha tela' : 'Enviar pedido'}</button>
          <p class="form-msg" id="modoMsg" role="status"></p>
        </form>`;
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
          ...enderecoDe(form),
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
        ...enderecoDe(form),
        segmento: segmentoDe(form),
        fluxo_estimado_mensal: form.fluxo_estimado_mensal.value || null,
        plano_ponto_id: escolhido ? escolhido.value : null,
        mensagem: form.mensagem.value.trim() || null,
        horario_semanal: lerHorarioSemanalDoForm(form),
      };
      const resposta = await enviar('/conta/modos/ponto/pedir', corpo);
      // Foto é opcional e sobe DEPOIS (furo A do redesenho da Rede,
      // 22/09/2026) — a candidatura já existe e vale sem foto nenhuma; sem
      // arquivo escolhido, nem tenta. Se o upload falhar, o pedido já foi
      // enviado mesmo assim (não trava o fluxo principal por causa da
      // foto) — só avisa.
      const arquivo = $('#m_foto', form)?.files[0];
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
        ligarHorarioSemanal(form);
        ligarFotoFachada(form, 'm_');
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
