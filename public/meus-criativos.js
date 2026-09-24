// Meus criativos — módulo do painel único (Fatia 3, 23/09/2026). O anúncio
// na rede e o anúncio na tela do próprio comércio são a MESMA peça e a mesma
// cota da conta; antes eram duas telas, "Meus criativos" no painel e "Meu
// anúncio na minha tela" na página do ponto.
//
// Situações (GET /anunciantes/me/criativos): Em análise · Aprovado (pronto,
// fora do rodízio agora) · No ar · Fora do ar · Recusado. Substituir uma peça
// aprovada manda a nova pra análise e a atual SEGUE no ar até ela ser
// aprovada.
//
// Uso: montarMeusCriativos({ obterConta }). Requer /config.js, /layout.js e
// /eventos.js. Idempotente: cada carga reescreve a lista; ouvintes por
// delegação, registrados uma vez.
(function () {
  let obterConta = () => null;
  let dados = null;
  let montado = false;
  let carregando = null;
  let enviando = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  const ehVideo = (url) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;

  function explicacao(c) {
    switch (c.situacao) {
      case 'em_analise':
        return c.substitui
          ? 'Substitui uma peça que está no ar — a atual continua rodando até esta ser aprovada.'
          : 'A gente confere antes de ir pro ar, normalmente no mesmo dia útil.';
      case 'no_ar':
        return c.substitutaEmAnalise
          ? 'Rodando nas telas. A substituta está em análise; esta continua no ar até ela ser aprovada.'
          : 'Rodando nas telas.';
      case 'aprovado':
        return dados.contaVeicula
          ? `Aprovada. Seu plano roda ${plural(dados.limiteNoAr, 'peça', 'peças')} ao mesmo tempo — esta entra quando outra sair.`
          : 'Aprovada. Entra no ar quando o seu plano estiver ativo.';
      case 'fora_do_ar':
        return 'Fora do ar. Continua na sua conta.';
      case 'recusado':
        return `${c.motivoRecusa || 'Fale com a gente pra entender o que ajustar.'} Exclua esta peça e envie a versão corrigida.`;
      default:
        return '';
    }
  }

  function htmlMidia(c) {
    if (!c.arquivoUrl) return '<div class="criativo-placeholder">processando...</div>';
    if (!ehVideo(c.arquivoUrl)) return `<img src="${esc(c.arquivoUrl)}" alt="">`;
    return `<video src="${esc(c.arquivoUrl)}" muted loop playsinline poster="${esc(c.thumbnailUrl || '')}"></video>
      <button type="button" class="criativo-play" data-acao="tocar" aria-label="Reproduzir"><svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M8 5v14l11-7z"/></svg></button>`;
  }

  function htmlCriativo(c) {
    const tipo = c.arquivoUrl && ehVideo(c.arquivoUrl) ? 'Vídeo' : 'Imagem';
    const duracao = c.duracaoSegundos ? `${Number(c.duracaoSegundos)}s` : 'Processando';
    const podeSubstituir = (c.situacao === 'no_ar' || c.situacao === 'aprovado') && !c.substitutaEmAnalise;
    const rotulo = window.ROTULOS.criativoSituacao[c.situacao] || c.situacao;
    return `<div class="criativo-card situacao-${c.situacao}" data-id="${c.id}">
      <div class="criativo-media">
        ${htmlMidia(c)}
        <button type="button" class="criativo-excluir" data-acao="excluir" aria-label="Excluir criativo">&times;</button>
        <span class="badge ${window.ROTULOS.criativoSituacaoClasse[c.situacao] || 'badge-pendente'}">${esc(rotulo)}</span>
      </div>
      <div class="criativo-meta"><strong>${tipo}</strong><span>${duracao}${c.feitoPelaMostrai ? ' · feito pela Mostraí' : ''}</span></div>
      <p class="criativo-explica">${esc(explicacao(c))}</p>
      ${podeSubstituir ? `<button type="button" class="btn ghost mini criativo-substituir" data-acao="substituir">Substituir</button>` : ''}
    </div>`;
  }

  // Onde a peça aprovada roda — depende do que a conta tem: plano (pontos
  // da rede) e/ou ponto no ar (a tela do próprio comércio).
  function ondeRoda() {
    const lugares = [];
    if (dados.rodaNaRede) lugares.push('nos pontos do seu plano');
    if (dados.rodaNoProprioPonto) lugares.push('na tela do seu comércio');
    return lugares.length ? `Peças aprovadas rodam ${lugares.join(' e ')}.` : '';
  }

  function desenharCabecalho() {
    const cheio = dados.emUso >= dados.limiteCadastro;
    $('contadorCriativos').textContent = `${dados.emUso} de ${dados.limiteCadastro}`;
    $('contadorCriativos').className = `badge ${cheio ? 'badge-pendente' : 'badge-neutro'}`;
    $('arquivoCriativo').disabled = cheio || enviando;
    $('rotuloEnviarCriativo').classList.toggle('desabilitado', cheio);
    $('rotuloEnviarCriativo').title = cheio ? 'Limite do plano atingido — exclua ou substitua uma peça' : '';
    const duracao = dados.duracaoMaxima
      ? `Vídeo ou imagem vertical de até ${dados.duracaoMaxima} segundos`
      : 'Vídeo ou imagem vertical';
    $('criativosSubtitulo').textContent = `${duracao} · até 95 MB · sem áudio. ${ondeRoda()}`.trim();
    $('ajudaArte').hidden = dados.criativos.length > 0;
    const conta = obterConta();
    if (window.linkWhatsApp && conta) {
      $('linkArteSimples').href = window.linkWhatsApp(
        `Olá! Sou ${conta.nome_empresa || 'anunciante'}, do Mostraí, e quero um anúncio pra minha conta.`,
      );
    }
  }

  // Resumo e alertas do topo do painel (painel-resumo.js).
  function publicar() {
    if (!window.publicarResumo) return;
    const noAr = dados.criativos.filter((c) => c.situacao === 'no_ar').length;
    const alertas = dados.criativos
      .filter((c) => c.situacao === 'recusado')
      .map(() => ({
        nivel: 'atencao',
        texto: 'Uma peça foi recusada — veja o motivo e envie a versão corrigida.',
        alvo: 'modCriativos',
      }));
    if (!dados.criativos.length) {
      alertas.push({
        nivel: 'atencao',
        texto: 'Falta o seu criativo: envie a peça pra entrar no ar.',
        alvo: 'modCriativos',
      });
    }
    window.publicarResumo('criativos', {
      chips: [{ rotulo: 'Criativos', valor: `${noAr} no ar`, alvo: 'modCriativos' }],
      alertas,
    });
  }

  function carregar() {
    if (!carregando) {
      carregando = desenhar().finally(() => {
        carregando = null;
      });
    }
    return carregando;
  }

  async function desenhar() {
    const secao = $('modCriativos');
    const lista = $('listaCriativos');
    if (!secao) return;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/criativos`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      dados = await r.json();
      // Sem plano (pago ou benefício) não há o que enviar: o
      // cartão "Escolha um plano" do painel já diz isso.
      if (!dados.temPlano) {
        secao.hidden = true;
        window.publicarResumo?.('criativos', {});
        return;
      }
      publicar();
      desenharCabecalho();
      lista.innerHTML = dados.criativos.length
        ? `<div class="criativos-lista">${dados.criativos.map(htmlCriativo).join('')}</div>`
        : '<p class="empty-state">Nenhum criativo enviado ainda.</p>';
    } catch (err) {
      console.error('falha ao carregar os criativos', err);
      lista.innerHTML =
        '<p class="form-msg err">Não foi possível carregar seus criativos agora. Tente atualizar a página.</p>';
    }
    secao.hidden = false;
  }

  function mensagem(texto, tipo) {
    const msg = $('uploadMsg');
    msg.textContent = texto;
    msg.className = `form-msg ${tipo || ''}`.trim();
  }

  async function enviar(arquivo, substitui) {
    const conta = obterConta();
    if (!arquivo || !conta || enviando) return;
    enviando = true;
    $('arquivoCriativo').disabled = true;
    mensagem('Enviando e processando, pode levar um minuto...');
    const form = new FormData();
    form.append('arquivo', arquivo);
    if (substitui) form.append('substitui', String(substitui));
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/${conta.id}/criativos`, {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || '');
      mensagem(
        substitui
          ? 'Substituta enviada. A peça atual continua no ar até a nova ser aprovada.'
          : 'Criativo enviado! Ele entra em análise antes de ir pro ar.',
        'ok',
      );
    } catch (err) {
      mensagem(err.message ? window.frase(err.message) : 'Não foi possível enviar agora. Tente de novo.', 'err');
    } finally {
      enviando = false;
      await carregar();
    }
  }

  async function excluir(id) {
    const c = dados?.criativos.find((x) => x.id === id);
    const aviso =
      c?.situacao === 'no_ar'
        ? 'Esta peça está no ar e sai das telas agora. Pra trocar sem ficar fora do ar, use "Substituir". Excluir mesmo assim?'
        : 'Excluir este criativo?';
    if (!window.confirm(aviso)) return;
    const r = await fetch(`${API_BASE_URL}/anunciantes/${obterConta().id}/criativos/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    mensagem(r.ok ? 'Criativo excluído.' : 'Não foi possível excluir agora. Tente de novo.', r.ok ? 'ok' : 'err');
    if (r.ok) carregar();
  }

  function tocar(card) {
    const video = card.querySelector('video');
    if (!video) return;
    video.play();
    card.classList.add('tocando');
    video.addEventListener('pause', () => card.classList.remove('tocando'), { once: true });
  }

  window.montarMeusCriativos = function montarMeusCriativos(opcoes = {}) {
    if (opcoes.obterConta) obterConta = opcoes.obterConta;
    carregar();
    if (montado) return;
    montado = true;
    $('listaCriativos')?.addEventListener('click', (ev) => {
      const card = ev.target.closest('.criativo-card');
      if (!card) return;
      const acao = ev.target.closest('[data-acao]')?.dataset.acao;
      if (acao === 'tocar') return tocar(card);
      if (acao === 'excluir') return excluir(Number(card.dataset.id));
      if (acao === 'substituir') {
        const input = $('arquivoSubstituto');
        input.dataset.substitui = card.dataset.id;
        input.click();
        return;
      }
      if (ev.target.closest('video')) {
        card.querySelector('video').pause();
        card.classList.remove('tocando');
      }
    });
    // Um controle só: escolher o arquivo já envia.
    $('arquivoCriativo')?.addEventListener('change', (ev) => {
      const arquivo = ev.target.files[0];
      ev.target.value = '';
      enviar(arquivo, null);
    });
    $('arquivoSubstituto')?.addEventListener('change', (ev) => {
      const arquivo = ev.target.files[0];
      const alvo = Number(ev.target.dataset.substitui);
      ev.target.value = '';
      enviar(arquivo, alvo);
    });
    if (window.ligarEventosDaConta) {
      window.ligarEventosDaConta({
        'creative.updated': carregar,
        // Plano mudou (assinatura, resgate de créditos): muda o que roda e o teto.
        'plan.updated': carregar,
        'payment.updated': carregar,
        'credits.updated': carregar,
      });
    }
  };
})();
