// Meus pontos — módulo do painel único (Fatia 2, 23/09/2026). Substitui três
// lugares que mostravam o mesmo comércio: "Meu ponto" (cards de endereço),
// "Minhas telas" (telas soltas) e "Meus endereços" (pedidos em análise). Agora
// é UM card por estabelecimento, com o ciclo inteiro:
//   Em análise → Aguardando instalação → Ativo (ou Em manutenção / Inativo)
// e as telas dentro do ponto a que pertencem.
//
// Uso: montarMeusPontos({ obterConta }) — `obterConta()` devolve a conta já
// carregada pelo painel (nome, endereço), usada no card compacto de quem
// ainda não tem ponto nenhum. Requer /config.js, /layout.js, /eventos.js,
// /formulario.js e /candidatura-ponto.js antes.
//
// Idempotente: toda carga reescreve #pontosLista inteiro, os ouvintes ficam
// no container do módulo (delegação) e são registrados uma vez só.
(function () {
  const ETAPAS = [
    ['em_analise', 'Em análise'],
    ['aguardando_instalacao', 'Aguardando instalação'],
    ['ativo', 'Ativo'],
  ];
  const EXPLICACAO = {
    em_analise: (e) =>
      `Pedido enviado em ${window.dataBR(e.desde)}. A gente confere e chama no WhatsApp pra combinar a visita.`,
    aguardando_instalacao: () => 'Pedido aprovado. A instalação da tela está sendo combinada com você.',
    ativo: () => '',
    em_manutencao: () => 'A tela deste ponto está em manutenção. A equipe Mostraí está cuidando disso.',
    inativo: () => 'As telas deste ponto estão desligadas. Se isso não era esperado, fale com a gente.',
  };

  let obterConta = () => null;
  let dados = null;
  let montado = false;
  let carregando = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);

  function tempoDesde(iso) {
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    if (min < 3) return 'agora';
    if (min < 60) return `há ${min} min`;
    if (min < 48 * 60) return `há ${Math.round(min / 60)} h`;
    return `há ${Math.round(min / 1440)} dias`;
  }

  function htmlFoto(url, nome) {
    if (url) return `<img src="${esc(url)}" alt="" loading="lazy" data-foto>`;
    return `<div class="ponto-foto-placeholder" role="img" aria-label="${esc(nome ? `${nome}, sem foto` : 'Sem foto')}">${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</div>`;
  }

  // As três etapas do caminho normal. Manutenção e inativo são desvios do
  // "Ativo" (o ponto já foi instalado), então marcam a terceira etapa com o
  // nome do desvio em vez de inventar uma quarta.
  function htmlEtapas(estado) {
    const atual = estado === 'em_manutencao' || estado === 'inativo' ? 2 : ETAPAS.findIndex(([e]) => e === estado);
    return `<ol class="estab-etapas" aria-label="Andamento">${ETAPAS.map(([, rotulo], i) => {
      const classe = i < atual ? 'feita' : i === atual ? 'atual' : '';
      const texto = i === 2 && atual === 2 && estado !== 'ativo' ? window.ROTULOS.estabelecimento[estado] : rotulo;
      return `<li class="${classe}"${i === atual ? ' aria-current="step"' : ''}>${esc(texto)}</li>`;
    }).join('')}</ol>`;
  }

  function htmlTela(t) {
    const sinal = t.ultimoSinal ? ` · último sinal ${tempoDesde(t.ultimoSinal)}` : '';
    const curto = t.nivel === 'atencao' ? 'Precisa de atenção' : t.situacaoTexto;
    return `<li class="tela-linha nivel-${t.nivel}">
      <span class="tela-dot" aria-hidden="true"></span>
      <div class="tela-id">
        <b>${esc(t.nome)}</b>
        <span>${esc(curto)}${sinal}</span>
        ${t.nivel === 'atencao' ? `<span class="tela-alerta">${esc(t.situacaoTexto)}</span>` : ''}
      </div>
      <span class="tela-num"><b>${t.exibicoes30d.toLocaleString('pt-BR')}</b> exibições em 30 dias</span>
      <button type="button" class="btn ghost mini" data-acao="ver-tela" data-id="${t.id}">Ver o que rodou</button>
    </li>`;
  }

  function htmlTelas(e) {
    if (e.tipo !== 'ponto') return '';
    if (!e.telas.length) {
      return e.estado === 'aguardando_instalacao'
        ? ''
        : '<p class="estab-vazio">Nenhuma tela cadastrada neste ponto.</p>';
    }
    return `<div class="estab-telas">
      <p class="estab-subtitulo">${e.telas.length === 1 ? 'Tela' : `Telas (${e.telas.length})`}</p>
      <ul>${e.telas.map(htmlTela).join('')}</ul>
    </div>`;
  }

  function htmlRodape(e) {
    if (e.tipo !== 'ponto') return '';
    const partes = [];
    if (e.modalidade) partes.push(`Comodato: <b>${esc(e.modalidade)}</b>`);
    if (e.ajudaCustoMensal > 0) partes.push(`ajuda de custo <b>${fmtBRL(e.ajudaCustoMensal)}/mês</b>`);
    if (e.cotaAutoanuncioPorHora > 0)
      partes.push(`seu anúncio <b>${e.cotaAutoanuncioPorHora}x por hora</b>, somando as telas`);
    return partes.length ? `<p class="estab-pe">${partes.join(' · ')}</p>` : '';
  }

  function htmlEstabelecimento(e) {
    const local = [e.endereco, e.bairro].filter(Boolean).map(esc).join(', ');
    const cidade = `${esc(e.cidade || '')}${e.uf ? `/${esc(e.uf)}` : ''}`;
    const explica = EXPLICACAO[e.estado]?.(e) || '';
    return `<article class="estab-card estado-${e.estado}" data-estab="${e.tipo}-${e.id}">
      <div class="estab-topo">
        <div class="estab-foto">${htmlFoto(e.fotoUrl, e.nome)}</div>
        <div class="estab-id">
          <h3>${esc(e.nome || '')}</h3>
          <p class="estab-end">${[local, cidade].filter(Boolean).join(' · ')}</p>
          ${e.categoria ? `<p class="estab-meta">${esc(e.categoria)}</p>` : ''}
        </div>
        <span class="badge ${window.ROTULOS.estabelecimentoClasse[e.estado] || 'badge-pendente'}">${esc(window.ROTULOS.estabelecimento[e.estado] || e.estado)}</span>
      </div>
      ${htmlEtapas(e.estado)}
      ${explica ? `<p class="estab-explica">${esc(explica)}</p>` : ''}
      ${htmlTelas(e)}
      ${htmlRodape(e)}
    </article>`;
  }

  // Resumo do cabeçalho: o que o dono quer saber num olhar só.
  function htmlResumo(lista) {
    const pontos = lista.filter((e) => e.tipo === 'ponto');
    const telas = pontos.flatMap((e) => e.telas);
    const funcionando = telas.filter((t) => t.situacao === 'operando').length;
    const analise = lista.length - pontos.length;
    const partes = [`${pontos.length} ${pontos.length === 1 ? 'ponto' : 'pontos'}`];
    if (telas.length)
      partes.push(`${funcionando} de ${telas.length} ${telas.length === 1 ? 'tela funcionando' : 'telas funcionando'}`);
    if (analise) partes.push(`${analise} em análise`);
    return partes.join(' · ');
  }

  // ---------- Quem ainda não tem estabelecimento nenhum ----------
  // Card compacto (19/09/2026, pedido do dono): nome, endereço e ramo já
  // estão na conta, então pede só o que é do ponto. Sem endereço na conta
  // (conta criada por convite de ponto, por exemplo), cai no formulário
  // completo — não dá pra reaproveitar o que não existe.
  function contaTemEndereco() {
    const c = obterConta();
    return !!(c?.endereco && c.cidade && c.uf && c.cep);
  }

  function htmlOportunidade() {
    return `<div class="ponto-opportunity">
      <div class="ponto-opportunity-summary">
        <div class="ponto-opportunity-copy">
          <span class="ponto-opportunity-icon" aria-hidden="true">⌂</span>
          <div><p class="section-eyebrow">Faça parte da rede</p><h3>Você também possui um comércio?</h3><p class="form-hint">Transforme-o em um ponto Mostraí e ganhe uma tela.</p></div>
        </div>
        <button class="btn primary" type="button" data-acao="abrir-oportunidade" aria-expanded="false">Quero ser um ponto</button>
      </div>
    </div>`;
  }

  function montarFormCompacto(raiz) {
    raiz.innerHTML = `<div class="candidatura-layout">
      <form id="formCardPonto" class="form-blocos">
        <p class="form-hint u-m-0">A tela, a instalação e o conteúdo são por nossa conta. Conte um pouco sobre o movimento do comércio e a gente chama no WhatsApp para combinar.</p>
        ${candidaturaBloco('cp_', 'estabelecimento', 'Estabelecimento', candidaturaCampoFoto('cp_'))}
        ${candidaturaBloco(
          'cp_',
          'movimento',
          'Movimento',
          `<div><label for="cp_fluxo">Média de pessoas que passam por mês</label>
            <input id="cp_fluxo" name="fluxo_estimado_mensal" type="number" min="1" inputmode="numeric" required></div>`,
        )}
        ${candidaturaBloco('cp_', 'horario', 'Horário de funcionamento', candidaturaCampoHorario())}
        ${candidaturaBloco(
          'cp_',
          'observacoes',
          'Observações',
          `<div><label for="cp_mensagem">Algo mais? (opcional)</label>
            <textarea id="cp_mensagem" name="mensagem" rows="2" placeholder="Estacionamento, ponto de referência, horário de pico..."></textarea></div>`,
        )}
        <div class="form-acoes"><button class="btn primary" type="submit">Enviar meu interesse</button>
          <button class="btn ghost" type="button" data-acao="fechar-form">Cancelar</button></div>
        <p class="form-msg" id="cardPontoMsg" role="status"></p>
      </form>
      ${candidaturaCampoPreview()}
    </div>`;
    const form = $('formCardPonto');
    const conta = obterConta();
    candidaturaLigarHorario(form);
    candidaturaLigarFoto(form, 'cp_');
    const preview = raiz.querySelector('.candidatura-preview');
    if (preview) {
      candidaturaLigarPreviewCard(form, preview, 'cp_', {
        nome: conta.nome_empresa,
        cidade: conta.cidade,
        uf: conta.uf,
      });
    }
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const c = obterConta();
      enviarPedido(form, 'cp_', $('cardPontoMsg'), {
        nome_comercio: c.nome_empresa,
        endereco: c.endereco,
        cidade: c.cidade,
        uf: c.uf,
        cep: c.cep,
        fluxo_estimado_mensal: Number(form.fluxo_estimado_mensal.value),
        mensagem: form.mensagem.value.trim() || null,
        horario_semanal: candidaturaHorarioDoForm(form),
      });
    });
  }

  // ---------- Outro estabelecimento (formulário completo) ----------
  // Outro lugar, então pede tudo de novo — não reaproveita o endereço da
  // conta. Mesmo formulário canônico (public/candidatura-ponto.js).
  function montarFormCompleto(raiz) {
    raiz.innerHTML = `<div class="candidatura-layout">
      <form id="formNovoPonto" class="form-blocos">
        <div>
          <h3 class="u-m-0">Novo estabelecimento</h3>
          <p class="form-hint u-m-0 u-mt-6">Entra como pedido: a gente confere, combina a visita e libera a tela.</p>
        </div>
        ${candidaturaBloco(
          'np_',
          'estabelecimento',
          'Estabelecimento',
          `<div><label for="np_nome_comercio">Nome do estabelecimento</label><input id="np_nome_comercio" name="nome" required></div>
          ${candidaturaCampoFoto('np_')}`,
        )}
        ${candidaturaBloco('np_', 'endereco', 'Endereço', candidaturaCampoEndereco('np_'))}
        ${candidaturaBloco(
          'np_',
          'segmento',
          'Segmento e movimento',
          `${candidaturaCampoSegmento('np_', 'Segmento')}
          <div><label for="np_fluxo">Média de pessoas que passam por mês</label><input id="np_fluxo" name="fluxo_estimado_mensal" type="number" min="1" inputmode="numeric" required></div>`,
        )}
        ${candidaturaBloco('np_', 'horario', 'Horário de funcionamento', candidaturaCampoHorario())}
        ${candidaturaBloco(
          'np_',
          'observacoes',
          'Observações',
          '<div><label for="np_mensagem">Algo mais? (opcional)</label><textarea id="np_mensagem" name="mensagem" rows="2" placeholder="Estacionamento, ponto de referência, horário de pico..."></textarea></div>',
        )}
        <div class="form-acoes">
          <button class="btn primary" type="submit">Enviar pedido</button>
          <button class="btn ghost" type="button" data-acao="fechar-form">Cancelar</button>
        </div>
        <p class="form-msg" id="msgNovoPonto" role="status"></p>
      </form>
      ${candidaturaCampoPreview()}
    </div>`;
    const form = $('formNovoPonto');
    // Montado depois do DOMContentLoaded (a lista chega por fetch), então o
    // ouvinte global de public/formulario.js não alcança este form: liga CEP
    // e segmento aqui, uma vez por montagem (o form é novo a cada abertura).
    if (window.ligarCep) window.ligarCep(form);
    if (window.ligarCategorias) window.ligarCategorias(form);
    candidaturaLigarHorario(form);
    candidaturaLigarFoto(form, 'np_');
    const preview = raiz.querySelector('.candidatura-preview');
    if (preview) candidaturaLigarPreviewCard(form, preview, 'np_');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      enviarPedido(form, 'np_', $('msgNovoPonto'), {
        nome_comercio: form.nome.value.trim(),
        ...candidaturaEnderecoDoForm(form),
        segmento: candidaturaSegmentoDoForm(form),
        fluxo_estimado_mensal: form.fluxo_estimado_mensal.value || null,
        mensagem: form.mensagem.value.trim() || null,
        horario_semanal: candidaturaHorarioDoForm(form),
      });
    });
  }

  // As duas portas criam a MESMA candidatura; a diferença é só quem pode
  // chamar: conta que já é ponto usa /anunciantes/me/pontos, a que ainda
  // não é, /conta/modos/ponto/pedir.
  async function enviarPedido(form, prefixo, msg, corpo) {
    const botao = form.querySelector('button[type="submit"]');
    botao.disabled = true;
    msg.textContent = 'Enviando...';
    msg.className = 'form-msg';
    try {
      const rota = dados?.ehPonto ? '/anunciantes/me/pontos' : '/conta/modos/ponto/pedir';
      const r = await fetch(`${API_BASE_URL}${rota}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(corpo),
      });
      const resposta = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(resposta.erro || 'Não foi possível enviar agora.');
      // Foto opcional, sobe DEPOIS: o pedido já vale sem ela, e uma falha
      // aqui não desfaz o que foi enviado.
      const arquivo = candidaturaFotoSelecionada(form, prefixo);
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
      fecharForm();
      // A confirmação que fica: o card "Em análise" que aparece na lista.
      const aviso = $('msgMeusPontos');
      aviso.textContent = 'Pedido enviado. A gente chama no WhatsApp pra combinar.';
      aviso.className = 'form-msg ok';
      aviso.hidden = false;
      await carregar();
    } catch (err) {
      msg.textContent = window.frase ? window.frase(err.message) : err.message;
      msg.className = 'form-msg err';
      botao.disabled = false;
    }
  }

  function abrirForm(completo) {
    const raiz = $('pontosNovo');
    if (completo) montarFormCompleto(raiz);
    else montarFormCompacto(raiz);
    raiz.hidden = false;
    $('btnNovoPonto').hidden = true;
    raiz.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function fecharForm() {
    const raiz = $('pontosNovo');
    raiz.hidden = true;
    raiz.innerHTML = '';
    $('btnNovoPonto').hidden = !dados?.estabelecimentos.length;
  }

  // ---------- O que rodou numa tela ----------
  async function abrirTela(id) {
    const tela = dados?.estabelecimentos
      .flatMap((e) => e.telas.map((t) => ({ ...t, ponto: e.nome })))
      .find((t) => t.id === id);
    if (!tela) return;
    $('modalTelaTitulo').textContent = `${tela.nome} · ${tela.ponto}`;
    const corpo = $('modalTelaCorpo');
    corpo.textContent = 'Carregando...';
    $('modalTela').showModal();
    try {
      const conta = obterConta();
      const r = await fetch(`${API_BASE_URL}/anunciantes/${conta.id}/dispositivos/${id}/painel`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error();
      const d = await r.json();
      const total = d.porAnunciante.reduce((s, a) => s + a.confirmadas, 0);
      const max = Math.max(...d.porDia.map((y) => y.confirmadas), 1);
      corpo.innerHTML = `
        <p class="form-hint">${esc(tela.situacaoTexto)}</p>
        <p class="form-hint">Últimos 30 dias · ${total.toLocaleString('pt-BR')} exibições confirmadas pela própria tela.</p>
        ${
          d.porAnunciante.length
            ? `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Anunciante</th><th>Programadas</th><th>Confirmadas</th></tr></thead><tbody>
          ${d.porAnunciante.map((a) => `<tr><td>${esc(a.nome_empresa)}</td><td>${a.programadas}</td><td>${a.confirmadas}</td></tr>`).join('')}
        </tbody></table></div>`
            : '<p class="empty-state">Nada rodou nessa tela ainda.</p>'
        }
        ${
          d.porDia.length
            ? `<p class="form-sep-titulo u-mt-14">Por dia</p><div class="bar-chart-h">
          ${d.porDia
            .slice(0, 14)
            .reverse()
            .map((x) => {
              const [, mes, dia] = String(x.dia).slice(0, 10).split('-');
              return `<div class="row"><span class="nome">${dia}/${mes}</span><span class="track"><span class="fill" data-pct="${Math.round((x.confirmadas / max) * 100)}"></span></span><span class="valor">${x.confirmadas}</span></div>`;
            })
            .join('')}
        </div>`
            : ''
        }
        <p class="form-sep-titulo u-mt-14">PIN desta tela</p>
        <p class="form-hint u-m-0">É o número que abre este mesmo painel na própria TV: 5 toques no canto superior direito da tela e o PIN.
          Serve pra você conferir o que rodou sem sair do balcão. Quem define é você.</p>
        <form class="field-row u-ai-c u-mt-8" id="formPin">
          <input class="u-col" id="pinTela" inputmode="numeric" pattern="\\d{4,6}" maxlength="6" placeholder="4 a 6 dígitos" aria-label="PIN da tela" required>
          <button class="btn primary" type="submit">Salvar PIN</button>
        </form>
        <p class="form-msg" id="msgPin" role="status">${tela.temPin ? 'Esta tela já tem um PIN. Salvar de novo troca o número.' : 'Esta tela ainda não tem PIN.'}</p>`;
      if (window.aplicarBarras) window.aplicarBarras(corpo);
      $('formPin').addEventListener('submit', (ev) => salvarPin(ev, id));
    } catch {
      corpo.innerHTML = '<p class="form-msg err">Não deu pra carregar o painel dessa tela.</p>';
    }
  }

  async function salvarPin(ev, id) {
    ev.preventDefault();
    const msg = $('msgPin');
    const r = await fetch(`${API_BASE_URL}/anunciantes/${obterConta().id}/dispositivos/${id}/pin`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: $('pinTela').value.trim() }),
    });
    const resposta = await r.json().catch(() => ({}));
    msg.textContent = r.ok
      ? 'PIN salvo. Use ele na própria TV: 5 toques no canto superior direito.'
      : window.frase(resposta.erro || 'não foi possível salvar o PIN agora');
    msg.className = r.ok ? 'form-msg ok' : 'form-msg err';
    if (r.ok) {
      $('pinTela').value = '';
      const t = dados?.estabelecimentos.flatMap((e) => e.telas).find((x) => x.id === id);
      if (t) t.temPin = true;
    }
  }

  // Resumo e alertas do topo do painel (painel-resumo.js): tela que precisa
  // de atenção é o alerta mais urgente de um dono de ponto.
  function publicar(estabs) {
    if (!window.publicarResumo) return;
    const pontos = estabs.filter((e) => e.tipo === 'ponto');
    const ativos = pontos.filter((e) => e.estado === 'ativo').length;
    const alertas = [];
    for (const e of pontos) {
      for (const t of e.telas.filter((x) => x.nivel === 'atencao')) {
        alertas.push({ nivel: 'atencao', texto: `${t.nome} (${e.nome}): ${t.situacaoTexto}`, alvo: 'modPontos' });
      }
    }
    for (const e of estabs.filter((x) => x.estado === 'em_analise')) {
      alertas.push({ nivel: 'info', texto: `Pedido de ${e.nome} em análise.`, alvo: 'modPontos' });
    }
    window.publicarResumo('pontos', {
      chips: pontos.length
        ? [
            {
              rotulo: 'Pontos',
              valor: `${ativos} de ${pontos.length} ${pontos.length === 1 ? 'ativo' : 'ativos'}`,
              alvo: 'modPontos',
            },
          ]
        : [],
      alertas,
    });
  }

  // ---------- Carga ----------
  // Uma carga por vez: SSE de tela e de ponto chegam juntos (a mesma mudança
  // emite os dois), e sem isto viravam duas requisições iguais em paralelo.
  function carregar() {
    if (!carregando) {
      carregando = desenhar().finally(() => {
        carregando = null;
      });
    }
    return carregando;
  }

  async function desenhar() {
    const secao = $('modPontos');
    const lista = $('pontosLista');
    if (!secao || !lista) return;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/meus-pontos`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      dados = await r.json();
      const estabs = dados.estabelecimentos;
      $('pontosResumo').textContent = estabs.length ? htmlResumo(estabs) : '';
      // Formulário aberto no meio de uma recarga (SSE) não pode sumir com o
      // que a pessoa já digitou: o botão só volta quando o form fecha.
      const formAberto = !$('pontosNovo').hidden;
      $('btnNovoPonto').hidden = !estabs.length || formAberto;
      lista.innerHTML = estabs.length ? estabs.map(htmlEstabelecimento).join('') : formAberto ? '' : htmlOportunidade();
      lista.querySelectorAll('img[data-foto]').forEach(candidaturaAjustarFoto);
      publicar(estabs);
    } catch {
      dados = null;
      $('pontosResumo').textContent = '';
      lista.innerHTML =
        '<p class="form-msg err">Não foi possível carregar seus pontos agora. Tente atualizar a página.</p>';
    }
    const primeiraVez = secao.hidden;
    secao.hidden = false;
    // Quem chega por /anunciante/painel.html#modPontos (convite, antiga
    // página do ponto) abria no topo: quando o navegador resolveu o #, a
    // seção ainda estava escondida esperando esta carga.
    if (primeiraVez && window.location.hash === '#modPontos') secao.scrollIntoView({ block: 'start' });
  }

  window.montarMeusPontos = function montarMeusPontos(opcoes = {}) {
    if (opcoes.obterConta) obterConta = opcoes.obterConta;
    carregar();
    if (montado) return;
    montado = true;
    $('modPontos')?.addEventListener('click', (ev) => {
      const alvo = ev.target.closest('[data-acao]');
      if (!alvo) return;
      const acao = alvo.dataset.acao;
      if (acao === 'ver-tela') abrirTela(Number(alvo.dataset.id));
      if (acao === 'abrir-oportunidade') {
        $('pontosLista').innerHTML = '';
        abrirForm(!contaTemEndereco());
      }
      if (acao === 'fechar-form') {
        fecharForm();
        carregar();
      }
    });
    $('btnNovoPonto')?.addEventListener('click', () => {
      $('msgMeusPontos').hidden = true;
      abrirForm(true);
    });
    $('fecharModalTela')?.addEventListener('click', () => $('modalTela').close());
    $('modalTela')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) ev.currentTarget.close();
    });
    if (window.ligarEventosDaConta) {
      window.ligarEventosDaConta({
        'application.updated': carregar,
        'point.updated': carregar,
        'screen.updated': carregar,
      });
    }
  };
})();
