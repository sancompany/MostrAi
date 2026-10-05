// Meus criativos — módulo do painel único (Fatia 3, 23/09/2026). O anúncio
// na rede e o anúncio na tela do próprio comércio são a MESMA peça e a mesma
// cota da conta; antes eram duas telas, "Meus criativos" no painel e "Meu
// anúncio na minha tela" na página do ponto.
//
// Situações (GET /anunciantes/me/criativos): Em análise · Aprovado (pronto,
// sem horário agora) · Programado · Aguardando primeira exibição · No ar
// (comprovante confirmado) · Entrada atrasada · Fora do ar · Recusado. Substituir uma peça
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
      case 'no_ar': {
        const ultima = c.entrada?.ultimaExibicaoEm
          ? ` Última exibição: ${window.prazoBR(c.entrada.ultimaExibicaoEm, { inicio: true })}.`
          : '';
        return c.substitutaEmAnalise
          ? `Rodando nas telas. A substituta está em análise; esta continua no ar até ela ser aprovada.${ultima}`
          : `Rodando nas telas — exibição confirmada pela TV.${ultima}`;
      }
      // Entre a aprovação e o primeiro comprovante: a janela vem do servidor.
      case 'programado':
        return `Aprovada e programada. Primeira exibição prevista: ${window.janelaBR(c.entrada?.primeiraJanelaPrevista)}.`;
      case 'aguardando_primeira_exibicao':
        return `Já está na programação da tela (${window.janelaBR(c.entrada?.primeiraJanelaPrevista)}). "No ar" aparece quando a TV confirmar a primeira exibição.`;
      case 'atrasado':
        return 'A primeira exibição está demorando mais que o previsto. A equipe Mostraí já foi avisada e está verificando a tela.';
      case 'aprovado': {
        const motivo = window.ENTRADA_NO_AR.motivo[c.entrada?.motivo];
        if (c.entrada?.motivo === 'fora_do_limite_de_pecas')
          return `Aprovada. Seu plano roda ${plural(dados.limiteNoAr, 'peça', 'peças')} ao mesmo tempo — esta entra quando outra sair.`;
        if (c.entrada?.motivo === 'acima_da_duracao_maxima')
          return `Aprovada, mas passa de ${dados.duracaoMaxima} s — o máximo que sua conta roda hoje. Envie uma versão mais curta.`;
        if (!dados.contaVeicula) return 'Aprovada. Entra no ar quando o seu plano estiver ativo.';
        return motivo ? `Aprovada, mas ainda sem horário: ${motivo}.` : 'Aprovada.';
      }
      case 'pausado':
        return 'Pausada por você. Não roda nas telas até você retomar — nada foi apagado.';
      case 'fora_do_ar':
        if (c.retiradaPor === 'substituicao') return 'Substituída pela peça nova. Continua na sua conta.';
        if (c.retiradaPor === 'admin') return 'Retirada do ar pela Mostraí. Fale com a gente pra entender.';
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
    // Peça aprovada em qualquer estágio da entrada no ar: dá pra substituir
    // e pausar — menos enquanto uma substituta está em análise (a troca é
    // que decide o destino dela). Pausada por você: só Retomar.
    const ativa = ['no_ar', 'aprovado', 'programado', 'aguardando_primeira_exibicao', 'atrasado'].includes(c.situacao);
    const podeMexer = ativa && !c.substitutaEmAnalise;
    const acoes = [
      podeMexer ? '<button type="button" class="btn ghost mini" data-acao="substituir">Substituir</button>' : '',
      podeMexer ? '<button type="button" class="btn ghost mini" data-acao="pausar">Pausar</button>' : '',
      c.situacao === 'pausado'
        ? '<button type="button" class="btn primary mini" data-acao="retomar">Retomar</button>'
        : '',
    ].filter(Boolean);
    const rotulo = window.ROTULOS.criativoSituacao[c.situacao] || c.situacao;
    return `<div class="criativo-card situacao-${c.situacao}" data-id="${c.id}">
      <div class="criativo-media">
        ${htmlMidia(c)}
        ${
          // Processando (sem arquivo ainda): não dá pra excluir — o servidor
          // recusa (409), porque apagar não cancela o FFmpeg em andamento.
          c.arquivoUrl
            ? '<button type="button" class="criativo-excluir" data-acao="excluir" aria-label="Excluir criativo">&times;</button>'
            : ''
        }
        <span class="badge ${window.ROTULOS.criativoSituacaoClasse[c.situacao] || 'badge-pendente'}">${esc(rotulo)}</span>
      </div>
      <div class="criativo-meta"><strong>${tipo}</strong><span>${duracao}${c.feitoPelaMostrai ? ' · feito pela Mostraí' : ''}</span></div>
      <p class="criativo-explica">${esc(explicacao(c))}</p>
      ${acoes.length ? `<div class="criativo-acoes">${acoes.join('')}</div>` : ''}
    </div>`;
  }

  // Onde a peça aprovada roda — depende do que a conta tem: plano (pontos
  // da rede) e/ou ponto no ar (a tela do próprio comércio).
  function ondeRoda() {
    const lugares = [];
    if (dados.soSaldoHospedagem) lugares.push('na rede, com suas horas de hospedagem');
    else if (dados.rodaNaRede) lugares.push('nos pontos do seu plano');
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

  // Uma leitura por vez: pedidos que chegam com uma leitura em andamento
  // (resync do SSE em rajada) ficam com ela. Só o fim do upload pede
  // `fresco` — aí ganha UMA leitura nova depois da que estava no ar, que
  // podia ter saído antes de o criativo ficar pronto.
  // Resolve true/false: a lista foi atualizada ou não.
  let proxima = null;
  function carregar({ fresco = false } = {}) {
    if (carregando) {
      if (!fresco) return carregando;
      if (!proxima) {
        proxima = carregando.then(() => {
          proxima = null;
          return carregar();
        });
      }
      return proxima;
    }
    carregando = desenhar().finally(() => {
      carregando = null;
    });
    return carregando;
  }

  async function desenhar() {
    const secao = $('modCriativos');
    const lista = $('listaCriativos');
    if (!secao) return true;
    let ok = true;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/criativos`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      dados = await r.json();
      // Sem plano (pago ou benefício) não há o que enviar: o
      // cartão "Escolha um plano" do painel já diz isso.
      if (!dados.temPlano && dados.aguardandoBeneficio) {
        // Dono de ponto da rede com o Básico ainda por nascer (01/10/2026):
        // o módulo aparece com o envio fechado e o motivo — o servidor só
        // aceita criativo com plano ou Básico ativo.
        window.publicarResumo?.('criativos', {});
        $('rotuloEnviarCriativo').hidden = true;
        $('contadorCriativos').hidden = true;
        $('ajudaArte').hidden = true;
        $('criativosSubtitulo').textContent = 'Vídeo ou imagem vertical · até 95 MB · sem áudio';
        lista.innerHTML = `<p class="empty-state" data-criativos-aguardando>${
          dados.aguardandoBeneficio === 'instalacao'
            ? 'Aguardando ativação do benefício: o envio de criativos abre quando a tela do seu ponto estiver instalada e o Plano Básico ativar.'
            : 'Aguardando ativação do benefício: o envio de criativos abre assim que o Plano Básico do seu ponto ativar.'
        }</p>`;
        secao.hidden = false;
        return true;
      }
      if (!dados.temPlano) {
        secao.hidden = true;
        window.publicarResumo?.('criativos', {});
        return true;
      }
      $('rotuloEnviarCriativo').hidden = false;
      $('contadorCriativos').hidden = false;
      publicar();
      desenharCabecalho();
      lista.innerHTML = dados.criativos.length
        ? `<div class="criativos-lista">${dados.criativos.map(htmlCriativo).join('')}</div>`
        : '<p class="empty-state">Nenhum criativo enviado ainda.</p>';
    } catch (err) {
      console.error('falha ao carregar os criativos', err);
      ok = false;
      lista.innerHTML =
        '<p class="form-msg err">Não foi possível carregar seus criativos agora. Tente atualizar a página.</p>';
    }
    secao.hidden = false;
    return ok;
  }

  function mensagem(texto, tipo) {
    const msg = $('uploadMsg');
    msg.textContent = texto;
    msg.className = `form-msg ${tipo || ''}`.trim();
  }

  // Botão ao lado da mensagem do envio: "Tentar de novo", "Verificar de
  // novo", "Atualizar lista" — ou nenhum.
  let acaoAtual = null;
  function acao(rotulo, fn) {
    acaoAtual = rotulo ? fn : null;
    $('uploadAcao').textContent = rotulo || '';
    $('uploadAcao').hidden = !rotulo;
  }

  // ---------------------------------------------------------------------------
  // Envio confiável (estação upload, 27/09/2026)
  // ---------------------------------------------------------------------------
  // O processamento do vídeo pode passar dos 100 s do proxy da Cloudflare, que
  // então devolve 524 — e o servidor termina o trabalho e cria o criativo
  // mesmo assim. A tela dizia "Não foi possível enviar" e o cliente enviava de
  // novo: dois criativos. Regras daqui:
  //   - cada arquivo escolhido ganha UMA chave (`Idempotency-Key`); repetir a
  //     tentativa manda a mesma chave, e o servidor devolve o que já existe;
  //   - "falhou" só quando o SERVIDOR disse por quê (4xx com `erro`, ou o 502
  //     do nosso armazenamento) — nada foi criado;
  //   - qualquer outro desfecho (rede caiu, 524/504 do proxy, 500 sem corpo)
  //     é RESULTADO INCERTO: o painel pergunta ao servidor o que aconteceu com
  //     aquela chave antes de dizer qualquer coisa;
  //   - upload concluído e lista que não atualizou são duas coisas: a lista
  //     falhar nunca vira "o envio falhou".
  // Estados na tela: ENVIANDO (com %), PROCESSANDO, ENVIADO/EM ANÁLISE,
  // ERRO REAL, RESULTADO INCERTO.
  const ESPERA_PROCESSAMENTO_MS = 8 * 60 * 1000; // maior processamento medido em produção: ~2 min
  const INTERVALO_CONFERENCIA_MS = 10000;

  function novaChave() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const textoEnviado = (t) =>
    t.substitui
      ? 'Substituta enviada. A peça atual continua no ar até a nova ser aprovada.'
      : 'Criativo enviado! Ele entra em análise antes de ir pro ar.';

  // XHR e não fetch: só ele diz quando o ARQUIVO terminou de subir — é o que
  // separa "enviando" de "processando" na tela. Nunca rejeita: status 0 é
  // "não houve resposta" (rede, conexão encerrada).
  function postar(t) {
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${API_BASE_URL}/anunciantes/${t.contaId}/criativos`);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Idempotency-Key', t.chave);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && e.loaded < e.total) {
          mensagem(`Enviando o arquivo... ${Math.floor((e.loaded / e.total) * 100)}%`);
        }
      });
      xhr.upload.addEventListener('load', () =>
        mensagem('Arquivo recebido. Processando o vídeo, pode levar um minuto...'),
      );
      xhr.addEventListener('load', () => {
        let corpo = null;
        try {
          corpo = JSON.parse(xhr.responseText);
        } catch {}
        resolve({ status: xhr.status, corpo });
      });
      for (const evento of ['error', 'abort', 'timeout']) {
        xhr.addEventListener(evento, () => resolve({ status: 0, corpo: null }));
      }
      const form = new FormData();
      form.append('arquivo', t.arquivo);
      if (t.substitui) form.append('substitui', String(t.substitui));
      xhr.send(form);
    });
  }

  function desfechoDoEnvio({ status, corpo }) {
    if (status === 200 || status === 201) return 'enviado';
    if (status === 202) return 'processando';
    if (status === 401) return 'sessao';
    // O servidor recusou e disse por quê: nada foi criado (a linha
    // temporária de um processamento que falhou já saiu antes da resposta).
    if (status >= 400 && status < 500 && corpo?.erro) return 'erro';
    if (status === 502 && corpo?.erro) return 'erro';
    return 'incerto';
  }

  async function consultarEnvio(chave) {
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/criativos/envios/${encodeURIComponent(chave)}`, {
        credentials: 'include',
      });
      if (r.status === 404) return 'nao_encontrado';
      if (r.status === 401) return 'sessao';
      if (!r.ok) return 'desconhecido';
      return (await r.json()).estado === 'pronto' ? 'pronto' : 'processando';
    } catch {
      return 'desconhecido';
    }
  }

  // Envio que terminou sem resposta clara: pergunta ao servidor. "Não
  // encontrado" só vale depois de duas respostas iguais com uns segundos de
  // intervalo (a primeira pode chegar antes de a linha nascer). Enquanto
  // processa, espera o SSE (`creative.updated`) ou confere a cada 10 s, até
  // 8 min — nunca uma espera sem fim.
  let aguardando = null;
  async function conferir(t) {
    aguardando = t;
    t.desde = t.desde || Date.now();
    let naoEncontrado = 0;
    let desconhecido = 0;
    while (aguardando === t) {
      const estado = await consultarEnvio(t.chave);
      if (aguardando !== t) return;
      if (estado === 'sessao') return window.sessaoExpirada();
      if (estado === 'pronto') return concluir(t);
      if (estado === 'processando') {
        naoEncontrado = 0;
        mensagem(
          'Recebemos o seu arquivo e ele ainda está sendo processado. O card atualiza sozinho, não precisa enviar de novo.',
        );
        acao(null);
        if (Date.now() - t.desde > ESPERA_PROCESSAMENTO_MS) {
          aguardando = null;
          mensagem('Seu arquivo chegou e ainda está sendo processado. Confira a lista daqui a pouco.');
          acao('Verificar de novo', () => conferir(t));
          return;
        }
      } else if (estado === 'nao_encontrado') {
        naoEncontrado += 1;
        if (naoEncontrado >= 2) {
          aguardando = null;
          // Verdade: não existe criativo com esta chave. Reenviar usa a
          // MESMA chave — se o primeiro aparecer depois, não duplica.
          mensagem('O envio não foi concluído. Nenhum criativo foi criado.', 'err');
          acao('Tentar de novo', () => enviarTentativa(t));
          return;
        }
      } else {
        desconhecido += 1;
        if (desconhecido >= 3) {
          aguardando = null;
          mensagem('Não conseguimos confirmar se o envio chegou. Verifique antes de enviar de novo.', 'err');
          acao('Verificar de novo', () => conferir(t));
          return;
        }
      }
      await esperar(estado === 'processando' ? INTERVALO_CONFERENCIA_MS : 3000, t);
    }
  }

  // Espera que o SSE pode encurtar: `creative.updated` acorda a conferência.
  let acordar = null;
  function esperar(ms, t) {
    return new Promise((resolve) => {
      const fim = () => {
        clearTimeout(timer);
        if (acordar === fim) acordar = null;
        resolve();
      };
      const timer = setTimeout(fim, ms);
      if (aguardando === t) acordar = fim;
    });
  }

  async function concluir(t) {
    if (aguardando === t) aguardando = null;
    mensagem(textoEnviado(t), 'ok');
    acao(null);
    const antes = performance.now();
    const listaOk = await carregar({ fresco: true });
    window.__tempoRefreshCriativosMs = Math.round(performance.now() - antes);
    if (!listaOk) {
      // O envio deu certo; só a lista não veio. Nunca "o envio falhou".
      mensagem(`${textoEnviado(t)} Não conseguimos atualizar a lista agora.`, 'ok');
      acao('Atualizar lista', async () => {
        if (await carregar({ fresco: true })) acao(null);
      });
    }
  }

  async function enviarTentativa(t) {
    if (enviando) return;
    enviando = true;
    aguardando = null;
    acao(null);
    $('arquivoCriativo').disabled = true;
    mensagem('Enviando o arquivo...');
    const resposta = await postar(t);
    enviando = false;
    if (dados) desenharCabecalho();
    else $('arquivoCriativo').disabled = false;
    const desfecho = desfechoDoEnvio(resposta);
    if (desfecho === 'sessao') return window.sessaoExpirada();
    if (desfecho === 'enviado') return concluir(t);
    if (desfecho === 'erro') {
      mensagem(window.frase(resposta.corpo.erro), 'err');
      return carregar();
    }
    if (desfecho === 'processando') carregar();
    else mensagem('A resposta não chegou. Conferindo se o seu arquivo foi recebido...');
    return conferir(t);
  }

  function enviar(arquivo, substitui) {
    const conta = obterConta();
    if (!arquivo || !conta || enviando) return;
    // Uma chave por arquivo escolhido: escolher de novo (mesmo o mesmo
    // arquivo) é um envio novo, de propósito.
    enviarTentativa({ arquivo, substitui, contaId: conta.id, chave: novaChave() });
  }

  // Confirmação em modal Mostraí (confirmar.js): o DELETE roda dentro do
  // modal, com loading; erro fica escrito ali e a lista só muda depois que
  // o servidor respondeu.
  async function excluir(id) {
    const c = dados?.criativos.find((x) => x.id === id);
    const noAr = c?.situacao === 'no_ar';
    const sim = await window.confirmarMostrai({
      titulo: noAr ? 'Excluir a peça que está no ar?' : 'Excluir este criativo?',
      texto: noAr
        ? 'Ela sai das telas agora e não volta. Pra trocar sem ficar fora do ar, use "Substituir".'
        : 'O arquivo é apagado da sua biblioteca. Não dá pra desfazer.',
      botao: noAr ? 'Excluir mesmo assim' : 'Excluir',
      perigo: true,
      aoConfirmar: async () => {
        const r = await fetch(`${API_BASE_URL}/anunciantes/${obterConta().id}/criativos/${id}`, {
          method: 'DELETE',
          credentials: 'include',
        });
        if (!r.ok) throw new Error('Não foi possível excluir agora. Tente de novo.');
      },
    });
    if (!sim) return;
    mensagem('Criativo excluído.', 'ok');
    carregar();
  }

  // Pausar tira a peça das telas (a partir da próxima hora) sem apagar
  // nada — mexe na veiculação, então confirma no modal Mostraí, com o POST
  // rodando dentro dele. Retomar é só voltar: um clique, e a resposta
  // escrita na tela (finalização, 28/09/2026).
  async function pausar(id) {
    const c = dados?.criativos.find((x) => x.id === id);
    const noAr = c?.situacao === 'no_ar';
    const sim = await window.confirmarMostrai({
      titulo: noAr ? 'Pausar a peça que está no ar?' : 'Pausar esta peça?',
      texto: noAr
        ? 'Ela sai das telas a partir da próxima hora e volta quando você retomar. Nada é apagado.'
        : 'Ela não entra nas telas até você retomar. Nada é apagado.',
      botao: 'Pausar',
      aoConfirmar: async () => {
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/criativos/${id}/pausar`, {
          method: 'POST',
          credentials: 'include',
        });
        if (!r.ok) {
          const corpo = await r.json().catch(() => ({}));
          throw new Error(window.frase(corpo.erro || 'Não foi possível pausar agora. Tente de novo.'));
        }
      },
    });
    if (!sim) return;
    mensagem('Peça pausada. Retome quando quiser.', 'ok');
    carregar();
  }

  async function retomar(id) {
    mensagem('Retomando...');
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/criativos/${id}/retomar`, {
        method: 'POST',
        credentials: 'include',
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(corpo.erro || 'Não foi possível retomar agora. Tente de novo.');
      mensagem('Peça de volta na programação.', 'ok');
    } catch (err) {
      mensagem(window.frase(err.message), 'err');
    }
    carregar();
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
      if (acao === 'pausar') return pausar(Number(card.dataset.id));
      if (acao === 'retomar') return retomar(Number(card.dataset.id));
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
    $('uploadAcao')?.addEventListener('click', () => acaoAtual?.());
    // A MESMA função nos quatro eventos: o resync do eventos.js deduplica por
    // função, e cada volta pra aba vira uma leitura só (e2e 15).
    const aoMudar = () => {
      // Criativo nasceu "processando", ficou pronto ou saiu: acorda a
      // conferência de um envio incerto, se houver.
      acordar?.();
      return carregar();
    };
    if (window.ligarEventosDaConta) {
      window.ligarEventosDaConta({
        'creative.updated': aoMudar,
        // Plano mudou (assinatura, resgate de créditos): muda o que roda e o teto.
        'plan.updated': aoMudar,
        'payment.updated': aoMudar,
        'credits.updated': aoMudar,
        // Ponto aprovado ou Básico ativado (ADR-034): o módulo passa de
        // escondido a "aguardando", e de "aguardando" ao envio aberto.
        'point.updated': aoMudar,
        'application.updated': aoMudar,
      });
    }
  };
})();
