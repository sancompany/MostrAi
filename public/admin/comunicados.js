// Comunicados por e-mail — Admin → Visão geral (29/09/2026).
//
// Card compacto na coluna de negócio + [+ Novo comunicado], que abre o
// modal em duas etapas: ESCREVER (público com a contagem de destinatários,
// assunto, título, mensagem, botão opcional) e REVISAR (a prévia é o e-mail
// de verdade, montado pelo servidor com o template institucional; envio de
// teste; e a confirmação Mostraí com o número de contas). O histórico abre
// num modal próprio, com o detalhe de cada envio e "Reenviar falhas".
//
// Nada aqui fala com o provedor de e-mail: o navegador só chama as rotas
// /admin/comunicados* (src/comunicados/routes.js), e nenhuma devolve
// endereço — a tela mostra números, e endereço só mascarado no diagnóstico.
//
// Arquivo próprio (não dentro de index.page.js) pra estação não disputar
// linhas com as outras que mexem na Visão geral. Carrega ANTES de
// index.page.js: `renderResumo` de lá chama `window.renderComunicadosResumo`,
// e as peças de lá (abrirModal, pegar, api...) são resolvidas na hora do uso.
(() => {
  const doAdmin =
    (nome) =>
    (...args) =>
      window[nome](...args);
  const abrirModal = doAdmin('abrirModal');
  const confirmarModal = doAdmin('confirmarModal');
  const pegar = doAdmin('pegar');
  const api = doAdmin('api');
  const toast = doAdmin('toast');
  const plural = doAdmin('plural');
  const frase = (t) => (window.frase ? window.frase(t) : t);

  const ROTA = '/admin/comunicados';
  const SITUACAO = {
    em_andamento: { texto: 'em andamento', selo: 'badge-info' },
    concluido: { texto: 'concluído', selo: 'badge-ok' },
    concluido_com_falhas: { texto: 'concluído com falhas', selo: 'badge-pendente' },
    falhou: { texto: 'falhou', selo: 'badge-err' },
  };

  // Data e hora de Matão, como o resto do admin mostra.
  const FORMATO = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const quando = (iso) => (iso ? FORMATO.format(new Date(iso)).replace(', ', ' às ') : '—');

  // Chave de idempotência (Idempotency-Key): uma por confirmação.
  function novaChave() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const b = window.crypto.getRandomValues(new Uint8Array(16));
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function lerErro(r, padrao) {
    const corpo = await r.json().catch(() => ({}));
    return { ...corpo, erro: frase(corpo.erro || padrao) };
  }

  function situacaoTexto(c) {
    if (c.situacao === 'em_andamento') return `em andamento · ${c.enviados} de ${c.previstos}`;
    if (c.situacao === 'concluido_com_falhas') return `concluído · ${plural(c.falharam, 'falha')}`;
    return SITUACAO[c.situacao]?.texto || c.situacao;
  }
  const selo = (c) =>
    `<span class="badge ${SITUACAO[c.situacao]?.selo || 'badge-neutro'}">${esc(situacaoTexto(c))}</span>`;

  // ---------------------------------------------------------------------------
  // Card da Visão geral
  // ---------------------------------------------------------------------------
  // A ação fica no pé do card, não no cabeçalho: "+ Novo comunicado" ao
  // lado do título quebrava a linha na coluna estreita da Visão geral.
  // Enquanto o último envio está andando, o card se atualiza sozinho (e
  // para quando a Visão geral sai da tela).
  const RECARGA_EM_ANDAMENTO_MS = 8000;
  async function renderResumo(el) {
    clearTimeout(el.comunicadosTimer);
    const dados = await pegar(ROTA);
    if (!el.isConnected) return;
    const ultimo = dados.comunicados[0];
    el.innerHTML = `<section class="panel comunicados-resumo" data-comunicados-resumo>
      <div class="secao-topo"><h3>Comunicados por e-mail</h3></div>
      <p class="comunicados-descricao">Envie avisos da Mostraí para as contas da plataforma.</p>
      ${
        ultimo
          ? `<p class="comunicados-ultimo" data-ultimo-comunicado><span>Último envio: ${esc(quando(ultimo.criadoEm))} · ${esc(plural(ultimo.previstos, 'destinatário'))}</span> ${selo(ultimo)}</p>`
          : '<p class="comunicados-ultimo u-dim" data-ultimo-comunicado>Nenhum comunicado enviado ainda.</p>'
      }
      <div class="comunicados-acoes">
        <button type="button" class="btn ghost mini" data-novo-comunicado>+ Novo comunicado</button>
        ${ultimo ? '<button type="button" class="comunicados-link" data-historico-comunicados>Ver histórico</button>' : ''}
      </div>
    </section>`;
    const recarregar = () => renderResumo(el).catch(() => {});
    el.querySelector('[data-novo-comunicado]').addEventListener('click', () => abrirNovo(dados, recarregar));
    el.querySelector('[data-historico-comunicados]')?.addEventListener('click', () => abrirHistorico(recarregar));
    if (ultimo?.situacao === 'em_andamento') {
      el.comunicadosTimer = setTimeout(() => {
        if (el.isConnected) recarregar();
      }, RECARGA_EM_ANDAMENTO_MS);
    }
  }

  // ---------------------------------------------------------------------------
  // Novo comunicado: escrever → revisar → confirmar
  // ---------------------------------------------------------------------------
  function campoPublico(p, marcado) {
    return `<label class="comunicado-opcao"><input type="radio" name="publico" value="${esc(p.id)}" ${marcado ? 'checked' : ''}><span><b>${esc(p.rotulo)}</b><small>${esc(p.descricao)}</small></span></label>`;
  }

  function textoForaDoEnvio(f) {
    const partes = [
      [f.suspensas, 'suspensa', 'suspensas'],
      [f.emailNaoConfirmado, 'com e-mail não confirmado', 'com e-mail não confirmado'],
      [f.naoQueremReceber, 'pediu pra não receber', 'pediram pra não receber'],
      [f.emailInvalido, 'com e-mail inválido', 'com e-mail inválido'],
    ]
      .filter(([n]) => n > 0)
      .map(([n, um, varios]) => `${n} ${n === 1 ? um : varios}`);
    return partes.length ? `Fora do envio: ${partes.join(' · ')}.` : '';
  }

  function abrirNovo(dados, aoEnviar) {
    const { publicos, limites, testePadrao } = dados;
    const { dlg, fechar } = abrirModal({
      titulo: 'Novo comunicado',
      largo: true,
      corpo: `
        <form id="formComunicado" class="modal-form comunicado-form" data-etapa="escrever" novalidate>
          <p class="comunicado-aviso">Para avisos da plataforma: atualização, mudança de funcionamento, manutenção, indisponibilidade, novidade do serviço. Oferta e promoção não saem por aqui.</p>
          <fieldset class="comunicado-publico">
            <legend>Público</legend>
            <div class="comunicado-publicos">${publicos.map((p, i) => campoPublico(p, i === 0)).join('')}</div>
            <p class="comunicado-destinatarios" data-destinatarios aria-live="polite">Destinatários: <b>…</b></p>
            <p class="campo-ajuda" data-fora></p>
          </fieldset>
          <div><label for="comAssunto">Assunto</label><input id="comAssunto" name="assunto" maxlength="${limites.assunto}" autocomplete="off" required></div>
          <div><label for="comTitulo">Título <span class="u-dim">(a primeira linha do e-mail)</span></label><input id="comTitulo" name="titulo" maxlength="${limites.titulo}" autocomplete="off" required></div>
          <div>
            <label for="comMensagem">Mensagem</label>
            <textarea id="comMensagem" name="mensagem" rows="8" maxlength="${limites.mensagem}" required></textarea>
            <p class="campo-ajuda comunicado-ajuda-mensagem"><span>Texto simples, sem formatação. Linha em branco separa parágrafos.</span><span data-contador>0/${limites.mensagem}</span></p>
          </div>
          <details class="comunicado-botao">
            <summary>Botão no e-mail <span class="u-dim">(opcional)</span></summary>
            <div class="campos">
              <div class="campo-grupo"><label for="comBotaoTexto">Texto do botão</label><input id="comBotaoTexto" name="botaoTexto" maxlength="${limites.botaoTexto}" placeholder="ex.: Abrir o painel" autocomplete="off"></div>
              <div class="campo-grupo"><label for="comBotaoUrl">Link do botão</label><input id="comBotaoUrl" name="botaoUrl" type="url" maxlength="${limites.botaoUrl}" placeholder="https://" autocomplete="off"></div>
            </div>
          </details>
          <p class="form-msg" data-msg role="status"></p>
        </form>
        <div class="comunicado-revisao" data-revisao hidden>
          <dl class="comunicado-ficha">
            <div><dt>Público</dt><dd data-rev-publico></dd></div>
            <div><dt>Destinatários</dt><dd data-rev-destinatarios></dd></div>
            <div class="comunicado-ficha-assunto"><dt>Assunto</dt><dd data-rev-assunto></dd></div>
          </dl>
          <div class="comunicado-previa-topo">
            <span class="campo-rotulo">Prévia — é exatamente o e-mail que sai</span>
            <div class="segmentado" role="radiogroup" aria-label="Formato da prévia">
              <label><input type="radio" name="formatoPrevia" value="html" checked><span>E-mail</span></label>
              <label><input type="radio" name="formatoPrevia" value="texto"><span>Texto puro</span></label>
            </div>
          </div>
          <div class="comunicado-previa" data-previa></div>
          <pre class="comunicado-previa-texto" data-previa-texto hidden></pre>
          <div class="comunicado-teste">
            <label for="comTestePara">Enviar teste para</label>
            <div class="comunicado-teste-linha">
              <input id="comTestePara" type="email" autocomplete="email" placeholder="${esc(testePadrao ? `caixa da equipe (${testePadrao})` : 'e-mail da equipe')}">
              <button type="button" class="btn ghost" data-enviar-teste>Enviar teste</button>
            </div>
            <p class="campo-ajuda">O teste sai marcado como [TESTE], só para este endereço, e não entra no histórico. Conta de cliente não recebe teste.</p>
            <p class="form-msg" data-msg-teste role="status"></p>
          </div>
          <p class="form-msg" data-msg-envio role="status"></p>
        </div>`,
      rodape: `<button type="button" class="btn ghost" data-fechar data-cancelar>Cancelar</button>
        <button type="button" class="btn ghost" data-voltar hidden>← Voltar e editar</button>
        <button type="button" class="btn primary" data-revisar>Revisar →</button>
        <button type="button" class="btn primary" data-enviar hidden>Enviar comunicado…</button>`,
    });

    const form = dlg.querySelector('#formComunicado');
    const revisao = dlg.querySelector('[data-revisao]');
    const b = (sel) => dlg.querySelector(sel);
    const estado = { contagem: null, seq: 0, previa: null, pendente: null, enviando: false };

    // Enquanto o envio está no ar, nada fecha o modal: ESC (cancel), clique
    // no fundo (o mousedown de abrirModal — barrado antes, na captura) e os
    // botões (desligados durante o envio).
    dlg.addEventListener('cancel', (e) => {
      if (estado.enviando) e.preventDefault();
    });
    dlg.addEventListener(
      'mousedown',
      (e) => {
        if (estado.enviando && e.target === dlg) e.stopImmediatePropagation();
      },
      true,
    );

    const aviso = (sel, texto, tipo = 'err') => {
      const el = dlg.querySelector(sel);
      el.textContent = texto || '';
      el.className = `form-msg${texto && tipo ? ` ${tipo}` : ''}`;
    };
    const publicoAtual = () => form.querySelector('input[name="publico"]:checked')?.value;
    const rotuloDo = (id) => publicos.find((p) => p.id === id)?.rotulo || id;
    const corpo = () => ({
      publico: publicoAtual(),
      assunto: form.assunto.value,
      titulo: form.titulo.value,
      mensagem: form.mensagem.value,
      botaoTexto: form.botaoTexto.value,
      botaoUrl: form.botaoUrl.value,
    });

    // "Destinatários: N contas" — o número do servidor (a mesma lista do
    // envio). Resposta atrasada de um público anterior não pinta nada.
    async function contar() {
      const seq = ++estado.seq;
      const publico = publicoAtual();
      b('[data-destinatarios]').innerHTML = 'Destinatários: <b>contando…</b>';
      b('[data-fora]').textContent = '';
      try {
        const r = await pegar(`${ROTA}/destinatarios?publico=${encodeURIComponent(publico)}`);
        if (seq !== estado.seq) return null;
        estado.contagem = r;
        b('[data-destinatarios]').innerHTML = r.destinatarios
          ? `Destinatários: <b>${esc(plural(r.destinatarios, 'conta'))}</b>`
          : '<b>Nenhuma conta deste público recebe comunicados agora.</b>';
        b('[data-destinatarios]').classList.toggle('vazio-publico', !r.destinatarios);
        b('[data-fora]').textContent = textoForaDoEnvio(r.foraDoEnvio);
        return r;
      } catch (err) {
        if (seq !== estado.seq) return null;
        estado.contagem = null;
        b('[data-destinatarios]').innerHTML =
          `<span class="comunicado-erro">${esc(frase(err?.message || 'Não deu pra contar os destinatários.'))}</span>`;
        return null;
      }
    }

    function marcarCampo(nome) {
      for (const el of form.querySelectorAll('[aria-invalid]')) el.removeAttribute('aria-invalid');
      const el = nome && form.elements[nome];
      if (!el) return;
      if (nome.startsWith('botao')) form.querySelector('.comunicado-botao').open = true;
      el.setAttribute('aria-invalid', 'true');
      el.focus();
    }

    function irPara(etapa) {
      const escrever = etapa === 'escrever';
      form.hidden = !escrever;
      revisao.hidden = escrever;
      b('[data-revisar]').hidden = !escrever;
      b('[data-voltar]').hidden = escrever;
      b('[data-enviar]').hidden = escrever;
      dlg.querySelector('.modal-topo h3').textContent = escrever ? 'Novo comunicado' : 'Revisar comunicado';
      dlg.querySelector('.modal-corpo').scrollTop = 0;
    }

    function pintarRevisao() {
      const c = estado.contagem;
      b('[data-rev-publico]').textContent = rotuloDo(publicoAtual());
      b('[data-rev-destinatarios]').innerHTML = c?.destinatarios
        ? `<b>${esc(plural(c.destinatarios, 'conta'))}</b>`
        : '<b class="comunicado-erro">nenhuma conta</b>';
      b('[data-rev-assunto]').textContent = estado.previa.assunto;
      pintarPrevia(b('[data-previa]'), estado.previa.html);
      b('[data-previa-texto]').textContent = estado.previa.texto;
      b('[data-enviar]').disabled = !c?.destinatarios;
      aviso(
        '[data-msg-envio]',
        c?.destinatarios ? '' : 'Nenhuma conta deste público recebe comunicados agora — volte e escolha outro público.',
      );
    }

    // Etapa 1 → 2: o servidor valida e monta a prévia (o mesmo `montar` do envio).
    async function revisar() {
      aviso('[data-msg]', '');
      const botao = b('[data-revisar]');
      botao.disabled = true;
      try {
        const r = await api(`${ROTA}/previa`, { method: 'POST', body: JSON.stringify(corpo()) });
        if (!r.ok) {
          const e = await lerErro(r, 'Não deu pra montar a prévia.');
          aviso('[data-msg]', e.erro);
          marcarCampo(e.campo);
          return;
        }
        marcarCampo(null);
        estado.previa = await r.json();
        if (!estado.contagem || estado.contagem.publico !== publicoAtual()) await contar();
        pintarRevisao();
        irPara('revisar');
      } finally {
        botao.disabled = false;
      }
    }

    async function enviarTeste() {
      const botao = b('[data-enviar-teste]');
      botao.disabled = true;
      aviso('[data-msg-teste]', 'Enviando o teste…', '');
      try {
        const r = await api(`${ROTA}/teste`, {
          method: 'POST',
          body: JSON.stringify({ ...corpo(), para: b('#comTestePara').value }),
        });
        if (!r.ok) return aviso('[data-msg-teste]', (await lerErro(r, 'O teste não saiu.')).erro);
        const d = await r.json();
        aviso('[data-msg-teste]', `Teste enviado para ${d.para}. Confira a caixa de entrada.`, 'ok');
      } finally {
        botao.disabled = false;
      }
    }

    // Etapa 2 → confirmação Mostraí → envio. A chave de idempotência vale
    // pra ESTE conteúdo + público + número: se a resposta se perder (queda
    // de rede, tempo esgotado), tentar de novo manda a mesma chave e o
    // servidor devolve o comunicado que já existe — nunca um segundo envio.
    async function enviar() {
      if (estado.enviando) return;
      aviso('[data-msg-envio]', '');
      const atual = await contar();
      if (!atual) return aviso('[data-msg-envio]', 'Não deu pra conferir os destinatários agora. Tente de novo.');
      pintarRevisao();
      if (!atual.destinatarios) return;
      const dadosEnvio = { ...corpo(), destinatariosConfirmados: atual.destinatarios };
      const impressao = JSON.stringify(dadosEnvio);
      if (estado.pendente?.impressao !== impressao) estado.pendente = { impressao, chave: novaChave() };

      const n = plural(atual.destinatarios, 'conta');
      const ok = await confirmarModal({
        titulo: 'Enviar comunicado?',
        texto: `<dl class="comunicado-ficha comunicado-ficha-confirmar">
            <div><dt>Público</dt><dd>${esc(rotuloDo(dadosEnvio.publico))}</dd></div>
            <div><dt>Destinatários</dt><dd><b>${esc(n)}</b></dd></div>
            <div class="comunicado-ficha-assunto"><dt>Assunto</dt><dd>${esc(estado.previa.assunto)}</dd></div>
          </dl>
          <p class="comunicado-confirmar-consequencia">Este envio será disparado para <b>${esc(n)}</b>. Cada conta recebe o seu e-mail, sozinha no destinatário.</p>`,
        botao: 'Enviar comunicado',
      });
      if (!ok) return;

      estado.enviando = true;
      const botoes = dlg.querySelectorAll('.modal-rodape button, .modal-x, [data-enviar-teste]');
      for (const bt of botoes) bt.disabled = true;
      aviso('[data-msg-envio]', 'Enviando…', '');
      let r;
      try {
        r = await api(ROTA, {
          method: 'POST',
          headers: { 'Idempotency-Key': estado.pendente.chave },
          body: JSON.stringify(dadosEnvio),
        });
      } catch {
        r = null;
      } finally {
        estado.enviando = false;
        for (const bt of botoes) bt.disabled = false;
        b('[data-enviar]').disabled = false;
      }
      if (!r || r.status >= 500) {
        // Não sabemos se entrou: a mesma chave fica guardada pra tentar de novo.
        return aviso(
          '[data-msg-envio]',
          'Não deu pra confirmar o envio (conexão ou servidor). Clique em "Enviar comunicado…" de novo: se ele já entrou, nada é enviado duas vezes.',
        );
      }
      if (!r.ok) {
        const e = await lerErro(r, 'O comunicado não foi enviado.');
        if (e.motivo === 'publico_mudou' || e.motivo === 'sem_destinatarios') await contar().then(pintarRevisao);
        return aviso('[data-msg-envio]', e.erro);
      }
      const d = await r.json();
      estado.pendente = null;
      fechar();
      toast(
        d.repetido
          ? 'Esse comunicado já tinha sido enviado — nada foi mandado de novo.'
          : `Comunicado na fila para ${plural(d.comunicado.previstos, 'conta')}.`,
      );
      aoEnviar();
    }

    for (const r of form.querySelectorAll('input[name="publico"]')) r.addEventListener('change', contar);
    form.mensagem.addEventListener('input', () => {
      b('[data-contador]').textContent = `${form.mensagem.value.length}/${limites.mensagem}`;
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      revisar();
    });
    b('[data-revisar]').addEventListener('click', revisar);
    b('[data-voltar]').addEventListener('click', () => irPara('escrever'));
    b('[data-enviar]').addEventListener('click', enviar);
    b('[data-enviar-teste]').addEventListener('click', enviarTeste);
    for (const r of revisao.querySelectorAll('input[name="formatoPrevia"]')) {
      r.addEventListener('change', () => {
        const texto = r.value === 'texto' && r.checked;
        b('[data-previa]').hidden = texto;
        b('[data-previa-texto]').hidden = !texto;
      });
    }
    contar();
    form.assunto.focus();
  }

  // A prévia é o HTML que o servidor montou, sem tirar nem pôr. A política
  // de segurança do admin (CSP sem 'unsafe-inline') não deixa aplicar o
  // atributo style de marcação — então os estilos do e-mail entram pelo
  // CSSOM (el.style.cssText), que a CSP permite, dentro de um shadow root
  // (o CSS do admin não vaza pro e-mail). Nada executa: script, iframe e
  // atributos on* nem chegam ao documento; links abrem em outra aba.
  function pintarPrevia(host, html) {
    const raiz = host.shadowRoot || host.attachShadow({ mode: 'open' });
    const doc = new DOMParser().parseFromString(String(html).replace(/\sstyle="/g, ' data-estilo="'), 'text/html');
    for (const el of doc.querySelectorAll('script, iframe, object, embed, link, meta, style, base, form')) el.remove();
    const moldura = document.createElement('div');
    moldura.setAttribute('data-estilo', doc.body.getAttribute('data-estilo') || '');
    for (const no of [...doc.body.childNodes]) moldura.appendChild(document.importNode(no, true));
    for (const el of [moldura, ...moldura.querySelectorAll('*')]) {
      for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
      const estilo = el.getAttribute('data-estilo');
      if (estilo !== null) {
        el.style.cssText = estilo;
        el.removeAttribute('data-estilo');
      }
    }
    for (const a of moldura.querySelectorAll('a[href]')) {
      if (!/^https?:/i.test(a.getAttribute('href'))) a.removeAttribute('href');
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    raiz.replaceChildren(moldura);
  }

  // ---------------------------------------------------------------------------
  // Histórico
  // ---------------------------------------------------------------------------
  function numeros(c) {
    const partes = [
      `<span><b>${c.previstos}</b> previstos</span>`,
      `<span><b>${c.enviados}</b> enviados</span>`,
      `<span class="${c.falharam ? 'comunicado-erro' : ''}"><b>${c.falharam}</b> ${c.falharam === 1 ? 'falhou' : 'falharam'}</span>`,
    ];
    if (c.naFila + c.tentandoDeNovo) {
      partes.push(
        `<span><b>${c.naFila + c.tentandoDeNovo}</b> na fila${c.tentandoDeNovo ? ` (${c.tentandoDeNovo} tentando de novo)` : ''}</span>`,
      );
    }
    if (c.descartados) partes.push(`<span><b>${c.descartados}</b> fora do público na hora</span>`);
    return `<p class="comunicado-numeros">${partes.join('')}</p>`;
  }

  function itemHistorico(c) {
    return `<li class="comunicado-item">
      <div class="comunicado-item-topo"><b class="comunicado-item-assunto">${esc(c.assunto)}</b>${selo(c)}</div>
      <p class="comunicado-item-meta">${esc(quando(c.criadoEm))} · ${esc(c.publicoRotulo)} · por ${esc(c.criadoPor)}${
        c.reenvios ? ` · falhas reenviadas ${c.reenvios}×` : ''
      }</p>
      ${numeros(c)}
      <button type="button" class="btn ghost mini" data-detalhe="${c.id}">Ver detalhes</button>
    </li>`;
  }

  function abrirHistorico(aoMudar) {
    const { dlg } = abrirModal({
      titulo: 'Histórico de comunicados',
      largo: true,
      corpo: '<div data-historico><p class="carregando">Carregando…</p></div>',
      rodape: '<button type="button" class="btn ghost" data-fechar>Fechar</button>',
    });
    const alvo = dlg.querySelector('[data-historico]');
    let timer = null;
    dlg.addEventListener('close', () => clearTimeout(timer));

    async function carregar() {
      clearTimeout(timer);
      let dados;
      try {
        dados = await pegar(ROTA);
      } catch (err) {
        alvo.innerHTML = `<p class="form-msg err">${esc(frase(err?.message || 'Não deu pra carregar o histórico.'))}</p>`;
        return;
      }
      if (!dlg.open) return;
      alvo.innerHTML = dados.comunicados.length
        ? `<ul class="comunicados-lista">${dados.comunicados.map(itemHistorico).join('')}</ul>`
        : '<p class="u-dim">Nenhum comunicado enviado ainda.</p>';
      for (const bt of alvo.querySelectorAll('[data-detalhe]')) {
        bt.addEventListener('click', () => abrirDetalhe(bt.dataset.detalhe, () => carregar().then(aoMudar)));
      }
      // Enquanto algum envio está andando, o histórico se atualiza sozinho.
      if (dados.comunicados.some((c) => c.situacao === 'em_andamento')) timer = setTimeout(carregar, 5000);
    }
    carregar();
  }

  const SITUACAO_DESTINATARIO = {
    falhou: 'falhou',
    tentando: 'tentando de novo',
    descartado: 'fora do público na hora',
  };

  function abrirDetalhe(id, aoMudar) {
    const { dlg, fechar } = abrirModal({
      titulo: 'Comunicado',
      largo: true,
      corpo: '<div data-detalhe-corpo><p class="carregando">Carregando…</p></div>',
      rodape: '<button type="button" class="btn ghost" data-fechar>Fechar</button>',
    });
    const alvo = dlg.querySelector('[data-detalhe-corpo]');

    async function carregar() {
      let d;
      try {
        d = await pegar(`${ROTA}/${encodeURIComponent(id)}`);
      } catch (err) {
        alvo.innerHTML = `<p class="form-msg err">${esc(frase(err?.message || 'Não deu pra abrir o comunicado.'))}</p>`;
        return;
      }
      if (!dlg.open) return;
      alvo.innerHTML = `
        <div class="comunicado-item-topo"><b class="comunicado-item-assunto">${esc(d.assunto)}</b>${selo(d)}</div>
        <p class="comunicado-item-meta">${esc(quando(d.criadoEm))} · ${esc(d.publicoRotulo)} · por ${esc(d.criadoPor)}</p>
        ${numeros(d)}
        <div class="comunicado-texto-enviado">
          <p class="campo-rotulo">O que foi enviado</p>
          <p class="comunicado-texto-titulo">${esc(d.titulo)}</p>
          <p class="comunicado-texto-mensagem">${esc(d.mensagem)}</p>
          ${d.botao ? `<p class="comunicado-texto-botao">Botão: <b>${esc(d.botao.texto)}</b> → <span>${esc(d.botao.url)}</span></p>` : ''}
        </div>
        ${
          d.problemas.length
            ? `<p class="campo-rotulo">Quem não recebeu (ainda)</p>
               <ul class="comunicado-problemas">${d.problemas
                 .map(
                   (p) => `<li><b>${esc(p.nomeEmpresa)}</b> <span class="u-dim">${esc(p.email)}</span>
                     <span class="comunicado-problema-situacao">${esc(SITUACAO_DESTINATARIO[p.situacao] || p.situacao)}${p.erro ? ` — ${esc(p.erro)}` : ''}</span></li>`,
                 )
                 .join('')}</ul>`
            : ''
        }
        ${
          d.paraReenviar
            ? `<div class="comunicado-reenviar"><button type="button" class="btn primary" data-reenviar>Reenviar para ${esc(plural(d.paraReenviar, 'conta que falhou', 'contas que falharam'))}</button>
               <p class="campo-ajuda">Só quem falhou volta pra fila. Quem já recebeu não recebe de novo.</p></div>`
            : ''
        }
        <p class="form-msg" data-msg role="status"></p>`;
      alvo.querySelector('[data-reenviar]')?.addEventListener('click', () => reenviar(d));
    }

    async function reenviar(d) {
      const n = plural(d.paraReenviar, 'conta', 'contas');
      const ok = await confirmarModal({
        titulo: 'Reenviar falhas?',
        texto: `<p>O comunicado <b>${esc(d.assunto)}</b> volta pra fila só para ${esc(n)} que ${d.paraReenviar === 1 ? 'falhou' : 'falharam'}.</p>
          <p class="u-dim">Quem já recebeu não recebe de novo.</p>`,
        botao: `Reenviar para ${n}`,
      });
      if (!ok) return;
      const botao = alvo.querySelector('[data-reenviar]');
      if (botao) botao.disabled = true;
      const r = await api(`${ROTA}/${encodeURIComponent(d.id)}/reenviar-falhas`, {
        method: 'POST',
        body: JSON.stringify({ paraReenviarConfirmados: d.paraReenviar }),
      });
      if (!r.ok) {
        const e = await lerErro(r, 'Não deu pra reenviar.');
        await carregar();
        const msg = alvo.querySelector('[data-msg]');
        if (msg) {
          msg.textContent = e.erro;
          msg.className = 'form-msg err';
        }
        return;
      }
      const res = await r.json();
      toast(
        res.reenfileirados
          ? `${plural(res.reenfileirados, 'conta voltou', 'contas voltaram')} pra fila.`
          : 'Nada pra reenviar.',
      );
      fechar();
      aoMudar();
    }
    carregar();
  }

  window.renderComunicadosResumo = renderResumo;
})();
