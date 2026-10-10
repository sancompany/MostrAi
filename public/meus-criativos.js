// Meus criativos — módulo do painel único (Fatia 3, 23/09/2026). O anúncio
// na rede e o anúncio na tela do próprio comércio são a MESMA peça e a mesma
// cota da conta; antes eram duas telas, "Meus criativos" no painel e "Meu
// anúncio na minha tela" na página do ponto.
//
// Situações (GET /anunciantes/me/criativos): Em análise · Aprovado (pronto,
// sem horário agora) · Programado · Aguardando primeira exibição · No ar
// (comprovante confirmado) · Entrada atrasada · Fora do ar · Recusado ·
// Correção necessária. Substituir uma peça aprovada manda a nova pra análise
// e a atual SEGUE no ar até ela ser aprovada.
//
// "Quem este anúncio divulga?" (migration 121): o negócio principal da conta
// vem marcado; outro negócio ou marca do mesmo responsável/grupo só aparece
// se a pessoa pedir. Plano, horas e limite de peças continuam da conta.
//
// Envio sob demanda (10/10/2026): fechado, o card é só a biblioteca — o
// contador e um botão. "Enviar criativo" abre o novo criativo dentro do card
// (arquivo, negócio, "Enviar para análise"); no limite do plano o botão vira
// "Substituir criativo": escolher a peça, depois o arquivo, com o negócio da
// peça travado. Nada sobe antes do "Enviar para análise", então cancelar não
// deixa peça nem negócio pela metade (o negócio novo só nasce no servidor,
// junto com a peça).
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
  // Negócios ou marcas da conta (GET /anunciantes/me/negocios).
  // `desenhadoCom` evita redesenhar a escolha (e apagar o que a pessoa está
  // digitando) a cada atualização da lista.
  let negocios = [];
  let desenhadoCom = null;
  // Modo do card: null (a biblioteca), 'novo' ou 'substituir'. `alvo` é a
  // peça a trocar; `escolhido`, o arquivo e a chave do envio dele.
  // `abertura` conta as aberturas: o fim de um envio só fecha o modo que o
  // enviou. `alvosDesenhados` evita redesenhar a lista da troca (e perder a
  // marcação) a cada atualização.
  let modo = null;
  let alvo = null;
  let escolhido = null;
  let abertura = 0;
  let alvosDesenhados = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);
  const ehVideo = (url) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');
  const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
  // Peça aprovada em qualquer estágio da entrada no ar.
  const ATIVAS = ['no_ar', 'aprovado', 'programado', 'aguardando_primeira_exibicao', 'atrasado'];
  // Dá pra substituir: aprovada e sem substituta em análise — as duas
  // recusas do servidor (400 "só dá pra substituir uma peça aprovada", 409
  // "essa peça já tem uma substituta em análise").
  const substituivel = (c) => ATIVAS.includes(c.situacao) && !c.substitutaEmAnalise;
  const tipoDe = (c) => (c.arquivoUrl && ehVideo(c.arquivoUrl) ? 'Vídeo' : 'Imagem');
  const duracaoDe = (c) => (c.duracaoSegundos ? `${Number(c.duracaoSegundos)}s` : 'Processando');

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
      case 'correcao_necessaria':
        return `${c.motivoCorrecao || 'A Mostraí pediu uma correção.'} Revise e envie de novo para análise.`;
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
    const tipo = tipoDe(c);
    const duracao = duracaoDe(c);
    // Peça aprovada em qualquer estágio da entrada no ar: dá pra substituir
    // e pausar — menos enquanto uma substituta está em análise (a troca é
    // que decide o destino dela). Pausada por você: só Retomar.
    const podeMexer = substituivel(c);
    const acoes = [
      podeMexer ? '<button type="button" class="btn ghost mini" data-acao="substituir">Substituir</button>' : '',
      podeMexer ? '<button type="button" class="btn ghost mini" data-acao="pausar">Pausar</button>' : '',
      c.situacao === 'pausado'
        ? '<button type="button" class="btn primary mini" data-acao="retomar">Retomar</button>'
        : '',
      c.situacao === 'correcao_necessaria'
        ? '<button type="button" class="btn primary mini" data-acao="reenviar">Revisar e reenviar</button>'
        : '',
    ].filter(Boolean);
    // Quem a peça divulga: só aparece pra quem anuncia mais de um negócio —
    // quem tem um só não vê nada a mais.
    const divulga =
      c.negocio && (negocios.length > 1 || !c.negocio.principal)
        ? `<p class="criativo-divulga">Divulga: <strong>${esc(c.negocio.nome)}</strong> · ${esc(rotuloCategoria(c.negocio))}</p>`
        : '';
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
      ${divulga}
      <p class="criativo-explica">${esc(explicacao(c))}</p>
      ${acoes.length ? `<div class="criativo-acoes">${acoes.join('')}</div>` : ''}
    </div>`;
  }

  // ---------------------------------------------------------------------------
  // Quem este anúncio divulga? (migration 121)
  // ---------------------------------------------------------------------------
  const rotuloCategoria = (n) => n.categoria?.nome || n.categoriaLivre || 'categoria a confirmar';

  async function carregarNegocios() {
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/negocios`, { credentials: 'include' });
      if (!r.ok) throw new Error();
      negocios = (await r.json()).negocios || [];
    } catch {
      // Sem a lista, o envio vai sem negócio e o servidor usa o principal —
      // o mesmo que a tela marcaria.
      negocios = [];
    }
  }

  // A escolha: os negócios da conta (o principal primeiro) e, como opção do
  // mesmo grupo de rádios, "outro negócio ou marca" — que abre nome,
  // categoria e a declaração de que é do mesmo responsável ou grupo. Um
  // rádio só (e não um botão que desmarca tudo): sempre há uma escolha
  // marcada à vista. `prefixo` separa o envio do modal de correção.
  function htmlEscolhaNegocio(prefixo, selecionado) {
    const marcado = selecionado ?? negocios[0]?.id;
    const opcoes = negocios
      .map(
        (
          n,
        ) => `<label class="negocio-opcao"><input type="radio" name="${prefixo}_negocio" value="${n.id}"${n.id === marcado ? ' checked' : ''}>
          <span><strong>${esc(n.nome)}</strong><small>${esc(rotuloCategoria(n))}</small></span></label>`,
      )
      .join('');
    return `<div class="negocio-opcoes">${opcoes}
        <label class="negocio-outro-opcao"><input type="radio" name="${prefixo}_negocio" value="" data-negocio-outro aria-controls="${prefixo}_novo">
          <span><strong>+ Anunciar outro negócio ou marca</strong><small>Do mesmo responsável ou grupo</small></span></label>
      </div>
      <div class="negocio-novo" id="${prefixo}_novo" role="group" aria-labelledby="${prefixo}_novo_titulo" data-negocio-novo hidden>
        <p class="negocio-novo-titulo" id="${prefixo}_novo_titulo">Novo negócio ou marca</p>
        <div class="campo"><label for="${prefixo}_nome">Nome</label><input id="${prefixo}_nome" maxlength="80" autocomplete="off" data-negocio-nome></div>
        <div class="campo"><label for="${prefixo}_categoria_id">Categoria</label><select id="${prefixo}_categoria_id" name="categoria_id" data-categorias></select></div>
        <div class="campo" data-categoria-livre hidden><label for="${prefixo}_categoria_livre">Qual?</label><input id="${prefixo}_categoria_livre" name="categoria_livre"></div>
        <label class="negocio-declaracao"><input type="checkbox" data-negocio-grupo> Este negócio ou marca pertence ao mesmo responsável ou grupo desta conta.</label>
      </div>`;
  }

  // Os campos do negócio novo aparecem só com "outro negócio ou marca"
  // marcado. O seletor de categoria é o do cadastro (formulario.js).
  // Uma vez por raiz: a do envio é redesenhada sem ser trocada.
  function ligarEscolha(raiz) {
    if (!raiz.dataset.escolhaLigada) {
      raiz.dataset.escolhaLigada = '1';
      raiz.addEventListener('change', (ev) => {
        if (ev.target.type !== 'radio') return;
        raiz.querySelector('[data-negocio-novo]').hidden = !raiz.querySelector('[data-negocio-outro]').checked;
      });
    }
    window.ligarCategorias?.(raiz);
  }

  // O que vai no envio: `{ campos }` (o negócio marcado ou o novo) ou
  // `{ erro, campo }` — o negócio novo só sai inteiro; `campo` é onde
  // está o que falta. Quem decide é o rádio marcado.
  function lerEscolhaNegocio(raiz) {
    const novo = raiz?.querySelector('[data-negocio-novo]');
    if (novo && raiz.querySelector('[data-negocio-outro]')?.checked) {
      const campoNome = novo.querySelector('[data-negocio-nome]');
      const nome = campoNome.value.trim();
      const select = novo.querySelector('select[name="categoria_id"]');
      const categoriaId = select.value;
      const caixaLivre = novo.querySelector('[data-categoria-livre]');
      const livre =
        caixaLivre && !caixaLivre.hidden ? novo.querySelector('input[name="categoria_livre"]').value.trim() : '';
      if (nome.length < 2) return { erro: 'Escreva o nome do negócio ou marca.', campo: campoNome };
      if (!categoriaId && livre.length < 2) {
        const busca = caixaLivre && !caixaLivre.hidden ? caixaLivre.querySelector('input') : null;
        return {
          erro: 'Escolha a categoria do negócio ou marca.',
          campo: busca || novo.querySelector(`#${select.id}_busca`) || select,
        };
      }
      const grupo = novo.querySelector('[data-negocio-grupo]');
      if (!grupo.checked) {
        return {
          erro: 'Confirme que o negócio ou marca pertence ao mesmo responsável ou grupo desta conta.',
          campo: grupo,
        };
      }
      return {
        campos: {
          negocio_nome: nome,
          ...(categoriaId ? { negocio_categoria_id: categoriaId } : { negocio_categoria_livre: livre }),
          negocio_mesmo_grupo: '1',
        },
      };
    }
    const marcado = raiz?.querySelector('input[type=radio]:checked:not([data-negocio-outro])');
    return { campos: marcado ? { negocio_id: marcado.value } : {} };
  }

  // `forcar` (ao abrir o novo criativo): começa do zero, com o principal
  // marcado. Sem ele, só redesenha se a lista de negócios mudou e ninguém
  // está preenchendo um negócio novo — e mantém a marcação.
  function desenharEscolhaDoEnvio(forcar = false) {
    const raiz = $('negocioEscolha');
    if (!raiz) return;
    const assinatura = JSON.stringify(negocios.map((n) => [n.id, n.nome, rotuloCategoria(n)]));
    const preenchendo = raiz.querySelector('[data-negocio-novo]:not([hidden])');
    if (!forcar && (assinatura === desenhadoCom || preenchendo)) return;
    const atual = forcar ? null : Number(raiz.querySelector('input[type=radio]:checked')?.value);
    const marcado = negocios.some((n) => n.id === atual) ? atual : negocios[0]?.id;
    raiz.innerHTML = htmlEscolhaNegocio('envio', marcado);
    ligarEscolha(raiz);
    desenhadoCom = assinatura;
  }

  // ---------------------------------------------------------------------------
  // Envio sob demanda: biblioteca ⇄ novo criativo ⇄ substituir
  // ---------------------------------------------------------------------------
  // O que fica fora do bloco de envio: os botões do cabeçalho, o aviso de
  // limite, a ajuda de arte e a biblioteca. Com o modo aberto, o envio fica
  // sozinho no card. No limite do plano não há "Enviar" desabilitado: o
  // botão é "Substituir".
  function desenharControles() {
    const liberado = !!dados?.temPlano;
    const cheio = liberado && dados.emUso >= dados.limiteCadastro;
    $('botaoEnviarCriativo').hidden = !liberado || cheio || !!modo;
    $('botaoSubstituirCriativo').hidden = !liberado || !cheio || !!modo;
    $('avisoLimite').hidden = !cheio;
    $('ajudaArte').hidden = !liberado || !!modo || dados.criativos.length > 0;
    $('listaCriativos').hidden = !!modo;
    $('envioCriativo').hidden = !modo;
  }

  const tamanho = (bytes) =>
    bytes < 1048576
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1048576).toFixed(1).replace('.', ',')} MB`;

  function htmlAlvo(c, marcado) {
    const capa = c.thumbnailUrl || (c.arquivoUrl && !ehVideo(c.arquivoUrl) ? c.arquivoUrl : '');
    const rotulo = window.ROTULOS.criativoSituacao[c.situacao] || c.situacao;
    return `<label class="alvo-opcao"><input type="radio" name="alvo_substituicao" value="${c.id}"${c.id === marcado ? ' checked' : ''}>
      ${capa ? `<img class="alvo-capa" src="${esc(capa)}" alt="">` : '<span class="alvo-capa" aria-hidden="true"></span>'}
      <span class="alvo-texto"><strong>${esc(c.negocio?.nome || 'Criativo da conta')}</strong>
        <small>${c.negocio ? `${esc(rotuloCategoria(c.negocio))} · ` : ''}${tipoDe(c)} · ${duracaoDe(c)}</small>
        <span class="badge ${window.ROTULOS.criativoSituacaoClasse[c.situacao] || 'badge-neutro'}">${esc(rotulo)}</span></span></label>`;
  }

  // As peças que dá pra trocar, a marcação preservada; com uma só, ela já
  // vem marcada.
  function desenharAlvos(elegiveis) {
    const raiz = $('alvosSubstituicao');
    const assinatura = JSON.stringify(elegiveis.map((c) => [c.id, c.situacao, c.negocio?.id, c.thumbnailUrl]));
    if (assinatura === alvosDesenhados) return;
    const atual = Number(raiz.querySelector('input:checked')?.value);
    const marcado = elegiveis.some((c) => c.id === atual) ? atual : elegiveis.length === 1 ? elegiveis[0].id : null;
    raiz.innerHTML = elegiveis.map((c) => htmlAlvo(c, marcado)).join('');
    // Capa que não carrega vira o bloco escuro, nunca o ícone de imagem quebrada.
    for (const img of raiz.querySelectorAll('img.alvo-capa')) {
      img.addEventListener(
        'error',
        () => img.replaceWith(Object.assign(document.createElement('span'), { className: 'alvo-capa' })),
        {
          once: true,
        },
      );
    }
    alvosDesenhados = assinatura;
  }

  // O miolo do bloco, conforme o modo, a peça escolhida e o arquivo. Os dois
  // tetos do servidor chegam antes do arquivo: o de cadastro (peças
  // guardadas, as fora do ar inclusive) e o "nada pra trocar" — a pessoa não
  // sobe 95 MB pra ouvir um não.
  function desenharEnvio() {
    desenharControles();
    if (!modo || !dados) {
      posicionarMensagem(false);
      return;
    }
    const trocando = modo === 'substituir';
    // Durante o envio a lista muda por causa dele mesmo (a substituta nasce
    // "em análise" e a peça trocada deixa de ser elegível; a linha nova
    // conta no teto): o bloco fica como estava até a resposta.
    const peca = trocando ? dados.criativos.find((c) => c.id === alvo && (enviando || substituivel(c))) : null;
    const elegiveis = trocando ? dados.criativos.filter(substituivel) : [];
    let aviso = '';
    if (!enviando && dados.guardados >= dados.tetoGuardados) {
      aviso = `Sua conta já guarda ${dados.tetoGuardados} criativos, contando os que estão fora do ar — o máximo por conta. Exclua um da biblioteca para enviar outro.`;
    } else if (!enviando && trocando && !peca && !elegiveis.length) {
      aviso =
        'Nenhuma peça pode ser substituída agora: só uma peça aprovada pode ser trocada, e cada uma aceita uma substituta por vez. Espere a análise terminar ou exclua uma peça da biblioteca.';
    }
    $('tituloEnvio').textContent = trocando ? 'Substituir criativo' : 'Novo criativo';
    $('envioSub').textContent = trocando
      ? 'A peça nova passa pela análise; a atual segue como está até ela ser aprovada.'
      : 'Configure a peça antes de enviá-la para análise.';
    $('envioAviso').textContent = aviso;
    $('envioAviso').hidden = !aviso;
    const escolhendoPeca = !aviso && trocando && !peca;
    $('etapaAlvo').hidden = !escolhendoPeca;
    if (escolhendoPeca) desenharAlvos(elegiveis);
    const pronto = !aviso && (!trocando || !!peca);
    $('envioTravado').hidden = !(pronto && trocando);
    if (pronto && trocando) {
      const negocio = peca.negocio
        ? `<strong>${esc(peca.negocio.nome)}</strong> · ${esc(rotuloCategoria(peca.negocio))}`
        : '<strong>esta conta</strong>';
      $('envioTravado').innerHTML =
        `Substituindo criativo de: ${negocio}<span>A peça nova divulga o mesmo negócio ou marca.</span>`;
    }
    $('etapaArquivo').hidden = !pronto;
    $('negocioEnvio').hidden = !pronto || trocando;
    $('envioRodape').hidden = !pronto;
    posicionarMensagem(pronto);
    $('rotuloEtapaArquivo').textContent = trocando ? 'Novo arquivo' : 'Arquivo';
    $('escolherArquivo').textContent = trocando ? 'Selecionar novo arquivo' : 'Selecionar arquivo';
    // O arquivo escolhido aparece na mesma área de soltar: prévia, nome,
    // tamanho e o estado (escolhido, enviando, processando, recusado).
    $('dropzoneVazia').hidden = !!escolhido;
    $('arquivoCard').hidden = !escolhido;
    $('dropzone').classList.toggle('com-arquivo', !!escolhido);
    if (escolhido) {
      $('arquivoEscolhido').textContent = escolhido.arquivo.name;
      $('arquivoTamanho').textContent = tamanho(escolhido.arquivo.size);
      $('arquivoEstado').textContent = escolhido.estado.texto;
      $('arquivoEstado').className = `arquivo-estado ${escolhido.estado.tipo}`;
    }
    // Durante o envio: tudo travado (o <fieldset disabled> trava os campos
    // sem mexer no estado de cada um) e sem "Cancelar" — o arquivo já está
    // subindo; o resultado aparece na mensagem.
    $('envioCampos').disabled = enviando;
    $('cancelarEnvio').hidden = enviando;
    $('envioCriativo').setAttribute('aria-busy', String(enviando));
    $('enviarParaAnalise').textContent = enviando ? 'Enviando...' : 'Enviar para análise';
    desenharRodape();
  }

  // O que falta pra enviar — nada (null) ou a frase, e onde está: o arquivo
  // e, no novo criativo, o negócio novo inteiro (a mesma leitura do envio).
  function faltaParaEnviar() {
    if (!escolhido) return { erro: 'Selecione o arquivo da peça para enviar.', campo: $('escolherArquivo') };
    if (modo === 'novo') {
      const escolha = lerEscolhaNegocio($('negocioEscolha'));
      if (escolha.erro) return escolha;
    }
    return null;
  }

  // Rodapé do bloco: à esquerda a mensagem do envio ou, sem ela, o que
  // falta; à direita "Enviar para análise", inativo (aria-disabled: segue
  // focável e diz o porquê) enquanto falta algo.
  function desenharRodape() {
    if (!modo) return;
    const falta = enviando ? null : faltaParaEnviar();
    const botao = $('enviarParaAnalise');
    botao.setAttribute('aria-disabled', String(!!falta));
    const dica = $('envioDica');
    dica.textContent = falta?.erro || '';
    if (!falta) dica.classList.remove('alerta');
    dica.hidden = !falta || !!$('uploadMsg').textContent;
  }

  // A mensagem do envio (#uploadMsg, a região lida pelo leitor de tela) fica
  // ao lado de "Enviar para análise" enquanto o bloco está pronto pra enviar;
  // fora disso, logo abaixo do bloco — onde a biblioteca a mostra depois do
  // envio. Um elemento só, movido: nunca duas mensagens.
  function posicionarMensagem(noRodape) {
    const msg = $('uploadMsg');
    if (noRodape) {
      if (msg.parentNode !== $('envioRodapeTexto')) $('envioRodapeTexto').prepend(msg);
    } else if (msg.previousElementSibling !== $('envioCriativo')) {
      $('envioCriativo').after(msg);
    }
  }

  // O estado do arquivo na área de soltar (só a tela; a mensagem do envio,
  // lida pelo leitor de tela, continua em #uploadMsg).
  function marcarArquivo(texto, tipo = '') {
    if (!escolhido) return;
    escolhido.estado = { texto, tipo };
    $('arquivoEstado').textContent = texto;
    $('arquivoEstado').className = `arquivo-estado ${tipo}`;
  }

  // Prévia local do arquivo escolhido: vídeo por blob: (media-src da CSP),
  // imagem por data: (img-src não aceita blob:). Imagem grande fica sem
  // prévia — o nome e o tamanho bastam.
  let previaUrl = null;
  function soltarPrevia() {
    if (previaUrl) URL.revokeObjectURL(previaUrl);
    previaUrl = null;
    $('arquivoPrevia').replaceChildren();
  }
  function mostrarPrevia(arquivo) {
    soltarPrevia();
    const caixa = $('arquivoPrevia');
    // Sem prévia (formato que o navegador não abre, imagem grande), o
    // marcador: o ▶ só pra vídeo.
    caixa.classList.toggle('e-video', /^video\//.test(arquivo.type));
    if (/^video\//.test(arquivo.type)) {
      previaUrl = URL.createObjectURL(arquivo);
      const video = document.createElement('video');
      Object.assign(video, { muted: true, playsInline: true, preload: 'metadata', src: `${previaUrl}#t=0.1` });
      video.addEventListener('error', () => video.remove(), { once: true });
      caixa.append(video);
    } else if (/^image\//.test(arquivo.type) && arquivo.size <= 15 * 1048576) {
      const leitor = new FileReader();
      leitor.addEventListener('load', () => {
        if (escolhido?.arquivo !== arquivo) return;
        const img = new Image();
        img.alt = '';
        img.src = leitor.result;
        caixa.append(img);
      });
      leitor.readAsDataURL(arquivo);
    }
  }

  // Escolher (pelo seletor ou soltando na área) só guarda: nada sobe antes
  // do "Enviar para análise". Uma chave por arquivo escolhido — escolher de
  // novo (mesmo o mesmo arquivo) é um envio novo, de propósito.
  function guardarArquivo(arquivo) {
    if (!arquivo || !modo || enviando) return;
    escolhido = { arquivo, chave: novaChave(), estado: { texto: 'Selecionado', tipo: '' } };
    limparMensagem();
    mostrarPrevia(arquivo);
    desenharEnvio();
  }

  // Mensagem do envio anterior que ainda acompanha um arquivo (conferindo
  // um resultado incerto) não é apagada por abrir, escolher ou cancelar.
  function limparMensagem() {
    if (aguardando || enviando) return;
    mensagem('');
    acao(null);
  }

  // Primeiro controle visível do bloco: o arquivo, a peça marcada (ou a
  // primeira) da troca ou, sem nada a fazer (aviso), o "Cancelar".
  function focarEnvio() {
    const controles = [
      $('alvosSubstituicao').querySelector('input:checked'),
      ...$('envioCampos').querySelectorAll('input[type=radio], button'),
    ];
    const primeiro = controles.find((el) => el && el.offsetParent !== null);
    (primeiro || $('cancelarEnvio')).focus();
  }

  function abrirEnvio(qual, peca = null) {
    if (!dados?.temPlano || enviando) return;
    modo = qual;
    alvo = peca;
    escolhido = null;
    soltarPrevia();
    abertura += 1;
    alvosDesenhados = null;
    $('alvosSubstituicao').innerHTML = '';
    limparMensagem();
    if (qual === 'novo') desenharEscolhaDoEnvio(true);
    desenharEnvio();
    focarEnvio();
  }

  // Volta à biblioteca. O negócio novo digitado pela metade é descartado
  // junto (ele só existe no servidor quando a peça sobe). `foco`: pra onde
  // vai o teclado — o botão que abriu (cancelar) ou o título do card (fim
  // do envio, quando o botão pode ter mudado de "Enviar" pra "Substituir").
  function fecharEnvio(foco = 'botao') {
    if (!modo) return;
    modo = null;
    alvo = null;
    escolhido = null;
    soltarPrevia();
    $('arquivoCriativo').value = '';
    $('negocioEscolha').innerHTML = '';
    desenhadoCom = null;
    desenharEnvio();
    if (foco === 'botao') {
      const botao = [$('botaoEnviarCriativo'), $('botaoSubstituirCriativo')].find((b) => !b.hidden);
      botao?.focus();
    } else if (foco === 'titulo') {
      $('tituloCriativos').focus();
    }
  }

  function continuarSubstituicao() {
    const marcada = $('alvosSubstituicao').querySelector('input:checked');
    if (!marcada) {
      mensagem('Escolha qual criativo você quer substituir.', 'err');
      return;
    }
    limparMensagem();
    alvo = Number(marcada.value);
    desenharEnvio();
    $('escolherArquivo').focus();
  }

  // "Revisar e reenviar": a mesma peça volta pra análise com o negócio
  // confirmado (o mesmo, outro da conta ou um novo). Negócio que a Mostraí
  // ainda não conferiu pode ter a categoria corrigida aqui mesmo.
  async function reenviar(id) {
    const c = dados?.criativos.find((x) => x.id === id);
    if (!c) return;
    const atual = c.negocio;
    const corrigirCategoria =
      atual && !atual.validado
        ? `<div class="campo" data-corrigir-categoria><label for="corrigir${id}_cat_categoria_id">Categoria certa de ${esc(atual.nome)} (se a atual estiver errada)</label><select id="corrigir${id}_cat_categoria_id" name="categoria_id" data-categorias></select></div>`
        : '';
    const sim = await window.confirmarMostrai({
      titulo: 'Revisar e reenviar',
      texto: c.motivoCorrecao
        ? `A Mostraí pediu: ${c.motivoCorrecao}`
        : 'Revise quem o anúncio divulga e envie de novo.',
      conteudo: `<form class="negocio-envio" data-negocio-raiz novalidate><fieldset><legend>Quem este anúncio divulga?</legend>${htmlEscolhaNegocio(`corrigir${id}`, atual?.id)}</fieldset></form>
        ${corrigirCategoria ? `<form class="negocio-envio" novalidate>${corrigirCategoria}</form>` : ''}`,
      botao: 'Enviar para análise de novo',
      aoAbrir: (dlg) => {
        ligarEscolha(dlg.querySelector('[data-negocio-raiz]'));
        const extra = dlg.querySelector('[data-corrigir-categoria]');
        if (extra) window.ligarCategorias?.(extra.closest('form'));
      },
      aoConfirmar: async (dlg) => {
        const escolha = lerEscolhaNegocio(dlg.querySelector('[data-negocio-raiz]'));
        if (escolha.erro) return { erro: escolha.erro };
        const novaCategoria = dlg.querySelector('[data-corrigir-categoria] select')?.value;
        const mesmoNegocio = Number(escolha.campos.negocio_id) === atual?.id;
        if (novaCategoria && mesmoNegocio && Number(novaCategoria) !== atual.categoria?.id) {
          const r = await fetch(`${API_BASE_URL}/anunciantes/me/negocios/${atual.id}`, {
            method: 'PATCH',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ categoria_id: Number(novaCategoria) }),
          });
          if (!r.ok)
            return { erro: (await r.json().catch(() => ({}))).erro || 'Não foi possível corrigir a categoria.' };
        }
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/criativos/${id}/reenviar`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(escolha.campos),
        });
        if (!r.ok) return { erro: (await r.json().catch(() => ({}))).erro || 'Não foi possível reenviar agora.' };
      },
    });
    if (!sim) return;
    mensagem('Peça reenviada. Ela volta para a análise da Mostraí.', 'ok');
    desenhadoCom = null;
    carregar();
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

  // "0 de 1 criativo utilizado", "2 de 3 criativos utilizados": o número é
  // o mesmo de sempre (peças que ocupam vaga do plano, `emUso`), a palavra
  // concorda com o limite.
  function desenharCabecalho() {
    const limite = dados.limiteCadastro;
    $('contadorCriativos').textContent =
      `${dados.emUso} de ${limite} ${limite === 1 ? 'criativo utilizado' : 'criativos utilizados'}`;
    // As regras do arquivo, curtas, dentro da área de soltar; onde a peça
    // aprovada roda, embaixo dela, em segundo plano.
    $('criativosSubtitulo').textContent = [
      'Vertical',
      dados.duracaoMaxima ? `até ${dados.duracaoMaxima} s` : null,
      'até 95 MB',
      'sem áudio',
    ]
      .filter(Boolean)
      .join(' · ');
    $('criativosOndeRoda').textContent = ondeRoda();
    $('criativosOndeRoda').hidden = !ondeRoda();
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
      .filter((c) => c.situacao === 'recusado' || c.situacao === 'correcao_necessaria')
      .map((c) => ({
        nivel: 'atencao',
        texto:
          c.situacao === 'recusado'
            ? 'Uma peça foi recusada — veja o motivo e envie a versão corrigida.'
            : 'Uma peça precisa de correção — veja o que ajustar e reenvie.',
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
      const [r] = await Promise.all([
        fetch(`${API_BASE_URL}/anunciantes/me/criativos`, { credentials: 'include' }),
        carregarNegocios(),
      ]);
      if (!r.ok) throw new Error();
      dados = await r.json();
      // Sem plano (pago ou benefício) não há o que enviar: o
      // cartão "Escolha um plano" do painel já diz isso.
      if (!dados.temPlano && dados.aguardandoBeneficio) {
        // Dono de ponto da rede com o Básico ainda por nascer (01/10/2026):
        // o módulo aparece com o envio fechado e o motivo — o servidor só
        // aceita criativo com plano ou Básico ativo.
        window.publicarResumo?.('criativos', {});
        fecharEnvio(null);
        $('contadorCriativos').hidden = true;
        $('criativosSubtitulo').textContent = 'Vertical · até 95 MB · sem áudio';
        desenharControles();
        lista.innerHTML = `<p class="empty-state" data-criativos-aguardando>${
          dados.aguardandoBeneficio === 'instalacao'
            ? 'Aguardando ativação do benefício: o envio de criativos abre quando a tela do seu ponto estiver instalada e o Plano Básico ativar.'
            : 'Aguardando ativação do benefício: o envio de criativos abre assim que o Plano Básico do seu ponto ativar.'
        }</p>`;
        secao.hidden = false;
        return true;
      }
      if (!dados.temPlano) {
        fecharEnvio(null);
        secao.hidden = true;
        window.publicarResumo?.('criativos', {});
        return true;
      }
      $('contadorCriativos').hidden = false;
      publicar();
      desenharCabecalho();
      if (modo === 'novo') desenharEscolhaDoEnvio();
      desenharEnvio();
      lista.innerHTML = dados.criativos.length
        ? `<div class="criativos-lista">${dados.criativos.map(htmlCriativo).join('')}</div>`
        : '<div class="criativos-vazio"><p class="criativos-vazio-titulo">Nenhum criativo enviado ainda.</p><p>Use “+ Enviar criativo” para mandar a primeira peça para análise. Ela aparece aqui com a situação de cada etapa.</p></div>';
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
    // No rodapé do bloco, a mensagem toma o lugar do "o que falta".
    if (modo) desenharRodape();
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
      // O arquivo na área de soltar acompanha o envio (só se ainda é ele
      // que está ali — um "Tentar de novo" de outro envio não mexe nele).
      const doArquivo = (texto, tipo) => escolhido?.arquivo === t.arquivo && marcarArquivo(texto, tipo);
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && e.loaded < e.total) {
          const pct = Math.floor((e.loaded / e.total) * 100);
          mensagem(`Enviando o arquivo... ${pct}%`);
          doArquivo(`Enviando… ${pct}%`, 'andamento');
        }
      });
      xhr.upload.addEventListener('load', () => {
        mensagem('Arquivo recebido. Processando o vídeo, pode levar um minuto...');
        doArquivo('Processando…', 'andamento');
      });
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
      // O negócio antes do arquivo: chega junto, e o servidor o usa só se a
      // peça não é substituta (a substituta divulga o mesmo da que troca).
      for (const [campo, valor] of Object.entries(t.negocio || {})) form.append(campo, valor);
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
    mensagem('Enviando o arquivo...');
    if (escolhido?.arquivo === t.arquivo) marcarArquivo('Enviando…', 'andamento');
    desenharEnvio();
    const resposta = await postar(t);
    enviando = false;
    const desfecho = desfechoDoEnvio(resposta);
    // O arquivo chegou (ou pode ter chegado): o modo que enviou fecha e o
    // card volta à biblioteca — a mensagem e o [Tentar de novo] ficam nela.
    // Recusa com motivo mantém o modo aberto, pra trocar o arquivo ou o
    // negócio e mandar de novo.
    if (desfecho !== 'erro' && desfecho !== 'sessao' && modo && t.abertura === abertura) fecharEnvio('titulo');
    else desenharEnvio();
    if (desfecho === 'sessao') return window.sessaoExpirada();
    if (desfecho === 'enviado') return concluir(t);
    if (desfecho === 'erro') {
      if (escolhido?.arquivo === t.arquivo) marcarArquivo('Recusado', 'erro');
      mensagem(window.frase(resposta.corpo.erro), 'err');
      if (modo) $('enviarParaAnalise').focus();
      return carregar();
    }
    if (desfecho === 'processando') carregar();
    else mensagem('A resposta não chegou. Conferindo se o seu arquivo foi recebido...');
    return conferir(t);
  }

  // "Enviar para análise": o arquivo escolhido e, no novo criativo, o
  // negócio (na substituição o servidor usa o da peça trocada e ignora
  // qualquer outro). O negócio novo só sai inteiro.
  function enviarDoModo() {
    const conta = obterConta();
    if (!conta || enviando || !modo) return;
    // Botão inativo (falta algo): o rodapé já diz o quê — destaca a frase e
    // leva o foco ao campo, sem enviar.
    const falta = faltaParaEnviar();
    if (falta) {
      limparMensagem();
      $('envioDica').classList.add('alerta');
      desenharRodape();
      falta.campo?.focus();
      return;
    }
    const negocio = modo === 'novo' ? lerEscolhaNegocio($('negocioEscolha')).campos : {};
    enviarTentativa({
      arquivo: escolhido.arquivo,
      chave: escolhido.chave,
      substitui: modo === 'substituir' ? alvo : null,
      contaId: conta.id,
      negocio,
      abertura,
    });
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
      if (acao === 'reenviar') return reenviar(Number(card.dataset.id));
      // "Substituir" no card: a troca já com a peça escolhida.
      if (acao === 'substituir') return abrirEnvio('substituir', Number(card.dataset.id));
      if (ev.target.closest('video')) {
        card.querySelector('video').pause();
        card.classList.remove('tocando');
      }
    });
    $('botaoEnviarCriativo')?.addEventListener('click', () => abrirEnvio('novo'));
    $('botaoSubstituirCriativo')?.addEventListener('click', () => abrirEnvio('substituir'));
    $('cancelarEnvio')?.addEventListener('click', () => {
      if (enviando) return;
      limparMensagem();
      fecharEnvio();
    });
    $('continuarSubstituicao')?.addEventListener('click', continuarSubstituicao);
    // Área de soltar: os botões são o caminho do teclado; clicar em qualquer
    // outro ponto da área abre o mesmo seletor; soltar um arquivo nela é o
    // mesmo que escolhê-lo.
    const abrirSeletor = () => !enviando && $('arquivoCriativo').click();
    $('escolherArquivo')?.addEventListener('click', abrirSeletor);
    $('trocarArquivo')?.addEventListener('click', abrirSeletor);
    const zona = $('dropzone');
    zona?.addEventListener('click', (ev) => {
      if (!ev.target.closest('button')) abrirSeletor();
    });
    zona?.addEventListener('dragover', (ev) => {
      if (!modo || enviando) return;
      ev.preventDefault();
      zona.classList.add('arrastando');
    });
    zona?.addEventListener('dragleave', (ev) => {
      if (!zona.contains(ev.relatedTarget)) zona.classList.remove('arrastando');
    });
    zona?.addEventListener('drop', (ev) => {
      ev.preventDefault();
      zona.classList.remove('arrastando');
      guardarArquivo(ev.dataTransfer?.files?.[0]);
    });
    // Arquivo solto fora da área, mas dentro do bloco: o navegador não troca
    // a página pelo arquivo (e o que foi preenchido não se perde).
    for (const evento of ['dragover', 'drop']) {
      $('envioCriativo')?.addEventListener(evento, (ev) => ev.preventDefault());
    }
    $('arquivoCriativo')?.addEventListener('change', (ev) => {
      const arquivo = ev.target.files[0];
      ev.target.value = '';
      guardarArquivo(arquivo);
    });
    // Preencher o negócio novo atualiza o "o que falta" e o botão de envio.
    for (const evento of ['input', 'change']) {
      $('negocioEscolha')?.addEventListener(evento, () => desenharRodape());
    }
    $('enviarParaAnalise')?.addEventListener('click', enviarDoModo);
    // Enter num campo do negócio novo nunca recarrega a página.
    $('negocioEnvio')?.addEventListener('submit', (ev) => ev.preventDefault());
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
