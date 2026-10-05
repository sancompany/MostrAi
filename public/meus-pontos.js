// Meus pontos — módulo do painel único (Fatia 2, 23/09/2026). Substitui três
// lugares que mostravam o mesmo comércio: "Meu ponto" (cards de endereço),
// "Minhas telas" (telas soltas) e "Meus endereços" (pedidos em análise). Agora
// é UM card por estabelecimento, com o ciclo inteiro:
//   Em análise → Aguardando instalação → Aguardando primeiro sinal → Ativo (ou Em reparo / Inativo)
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
    ['aguardando_primeiro_sinal', 'Aguardando primeiro sinal'],
    ['ativo', 'Ativo'],
  ];
  const EXPLICACAO = {
    em_analise: (e) =>
      `Pedido enviado em ${window.dataBR(e.desde)}. A gente confere e chama no WhatsApp pra combinar a visita.`,
    aguardando_instalacao: () => 'Pedido aprovado. A instalação da tela está sendo combinada com você.',
    aguardando_primeiro_sinal: () =>
      'A tela foi preparada e ainda não se conectou. Assim que ligar, o ponto fica ativo.',
    ativo: () => '',
    em_manutencao: () => 'A tela deste ponto está em reparo. A equipe Mostraí está cuidando disso.',
    inativo: () => 'As telas deste ponto estão inativas no cadastro. Se isso não era esperado, fale com a gente.',
  };

  let obterConta = () => null;
  let dados = null;
  let montado = false;
  let carregando = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => window.esc(s);

  // Ícones das linhas do card — o mesmo desenho de "Onde seu anúncio
  // aparece" (painel.page.js). Decorativos: o texto ao lado diz a mesma coisa.
  const ICONES = {
    endereco:
      '<path d="M12 21.5s7.25-7.35 7.25-12.25a7.25 7.25 0 1 0-14.5 0c0 4.9 7.25 12.25 7.25 12.25Z"/><circle cx="12" cy="9.25" r="2.75"/>',
    segmento:
      '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  };
  const icone = (nome) =>
    `<svg class="estab-icone" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONES[nome]}</svg>`;

  function htmlFoto(url, nome) {
    if (url) return `<img src="${esc(url)}" alt="" loading="lazy" data-foto>`;
    return `<div class="ponto-foto-placeholder" role="img" aria-label="${esc(nome ? `${nome}, sem foto` : 'Sem foto')}">${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</div>`;
  }

  // As quatro etapas do caminho normal. Reparo e inativo são desvios do
  // "Ativo" (o ponto já foi instalado), então marcam a última etapa com o
  // nome do desvio em vez de inventar uma quinta.
  function htmlEtapas(estado) {
    const ultima = ETAPAS.length - 1;
    const atual = estado === 'em_manutencao' || estado === 'inativo' ? ultima : ETAPAS.findIndex(([e]) => e === estado);
    return `<ol class="estab-etapas" aria-label="Andamento">${ETAPAS.map(([, rotulo], i) => {
      const classe = i < atual ? 'feita' : i === atual ? 'atual' : '';
      const texto =
        i === ultima && atual === ultima && estado !== 'ativo' ? window.ROTULOS.estabelecimento[estado] : rotulo;
      return `<li class="${classe}"${i === atual ? ' aria-current="step"' : ''}>${esc(texto)}</li>`;
    }).join('')}</ol>`;
  }

  // Visão simplificada: só a situação (toda tela segue o horário do
  // estabelecimento). Nada técnico — o que é de operador fica no admin.
  function htmlTela(t) {
    const curto = t.nivel === 'atencao' ? 'Precisa de atenção' : t.situacaoTexto;
    return `<li class="tela-linha nivel-${t.nivel}">
      <span class="tela-dot" aria-hidden="true"></span>
      <div class="tela-id">
        <b>${esc(t.nome)}</b>
        <span>${esc(curto)}</span>
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
    const funcionando = e.telas.filter((t) => t.situacao === 'operando').length;
    return `<div class="estab-bloco estab-telas">
      <p class="estab-subtitulo">${e.telas.length === 1 ? 'Tela' : `Telas (${e.telas.length})`}<span>${funcionando} de ${e.telas.length} funcionando</span></p>
      <ul>${e.telas.map(htmlTela).join('')}</ul>
    </div>`;
  }

  // Os dois benefícios do ponto, cada um no seu bloco (painel do usuário,
  // 29/09/2026 — antes eram duas linhas de rodapé): o Plano Básico (migration
  // 103, horas de tela no próprio ponto) e o crédito mensal (ADR-016: +1
  // crédito por mês enquanto o ponto participa da rede — não é plano nem
  // dinheiro, é o crédito de "Créditos e benefícios").
  function htmlBeneficios(e) {
    if (e.tipo !== 'ponto' || !e.beneficio) return '';
    const b = e.beneficio;
    let situacao;
    if (b.creditoDoMesConcedido)
      situacao = `Crédito de ${esc(b.competenciaAtual.split('/')[0])} já concedido · próximo em ${esc(b.proximaCompetencia)}`;
    else if (b.elegivel) situacao = `Próximo crédito: ${esc(b.proximaCompetencia)}`;
    else situacao = 'Começa quando a tela estiver instalada e ativa';
    const basico = b.basico
      ? `<div class="estab-bloco estab-beneficio estab-basico">
          <p class="estab-bloco-titulo">Plano Básico</p>
          <p class="estab-bloco-valor"><b>${b.basico.horasPorMes} h/mês</b> neste ponto</p>
          <p class="estab-bloco-nota">Anúncio de até ${b.basico.duracaoMaximaSegundos} s · incluído enquanto o ponto estiver ativo</p>
        </div>`
      : '';
    return `<div class="estab-beneficios">
      ${basico}
      <div class="estab-bloco estab-beneficio estab-credito">
        <p class="estab-bloco-titulo">Benefício do ponto</p>
        <p class="estab-bloco-valor"><b>+1 crédito</b> por mês</p>
        <p class="estab-bloco-nota">${situacao}</p>
      </div>
    </div>`;
  }

  // Um estabelecimento da rede (refinado no painel do usuário, 29/09/2026,
  // pedido do dono): a fachada em cima, com o estado sobre a foto; o nome em
  // destaque; endereço e segmento em segundo plano; o andamento; e as telas,
  // o Plano Básico e o crédito em blocos próprios. Só a apresentação mudou —
  // os dados, as ações e os avisos são os de antes.
  function htmlEstabelecimento(e) {
    const cidade = `${e.cidade || ''}${e.uf ? `/${e.uf}` : ''}`;
    const local = [window.linhaEndereco(e), cidade].filter(Boolean).join(' · ');
    const explica = EXPLICACAO[e.estado]?.(e) || '';
    return `<article class="estab-card estado-${e.estado}" data-estab="${e.tipo}-${e.id}">
      <div class="estab-capa">
        ${htmlFoto(e.fotoUrl, e.nome)}
        <span class="badge estab-estado ${window.ROTULOS.estabelecimentoClasse[e.estado] || 'badge-pendente'}">${esc(window.ROTULOS.estabelecimento[e.estado] || e.estado)}</span>
      </div>
      <div class="estab-corpo">
        <div class="estab-id">
          <h3>${esc(e.nome || '')}</h3>
          ${local ? `<p class="estab-end">${icone('endereco')}<span>${esc(local)}</span></p>` : ''}
          <button type="button" class="btn ghost mini estab-editar-endereco" data-acao="editar-endereco" data-tipo="${e.tipo}" data-id="${e.id}">Editar endereço</button>
          ${e.categoria ? `<p class="estab-meta">${icone('segmento')}<span>${esc(e.categoria)}</span></p>` : ''}
        </div>
        ${htmlEtapas(e.estado)}
        ${explica ? `<p class="estab-explica">${esc(explica)}</p>` : ''}
        ${htmlTelas(e)}
        ${htmlBeneficios(e)}
      </div>
    </article>`;
  }

  // Resumo do cabeçalho: o que o dono quer saber num olhar só.
  function htmlResumo(lista) {
    const pontos = lista.filter((e) => e.tipo === 'ponto');
    const telas = pontos.flatMap((e) => e.telas);
    const funcionando = telas.filter((t) => t.situacao === 'operando').length;
    const analise = lista.filter((e) => e.tipo === 'candidatura').length;
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
  // Endereço em partes (D5, 24/09/2026): conta com logradouro precisa de
  // número e bairro pra reaproveitar; conta antiga, só com a linha
  // `endereco`, segue valendo como antes.
  function contaTemEndereco() {
    const c = obterConta();
    if (!c?.cidade || !c.uf || !c.cep) return false;
    // Número gravado antes da regra única (estação de endereços) que não
    // passa nela ("12, fundos"): o formulário compacto não tem onde
    // corrigir, então cai no completo, com o endereço digitado de novo.
    const regra = window.enderecoRegras;
    if (c.numero && regra && (c.numero.length > regra.LIMITES.numero || !regra.NUMERO_VALIDO.test(c.numero))) {
      return false;
    }
    return c.logradouro ? !!(c.numero && c.bairro) : !!c.endereco;
  }

  function htmlOportunidade() {
    // Vertical sempre (estação da conta, 26/09/2026): texto em cima,
    // descrição, botão embaixo. Lado a lado, na coluna lateral de ~340 px,
    // o título quebrava uma palavra por linha e o botão espremia.
    return `<div class="ponto-opportunity">
      <div class="ponto-opportunity-summary">
        <p class="section-eyebrow">Faça parte da rede</p>
        <h3>Você também possui um comércio?</h3>
        <p class="form-hint">Transforme-o em um ponto Mostraí e participe da rede.</p>
        <button class="btn primary" type="button" data-acao="abrir-oportunidade" aria-expanded="false">Quero ser um ponto</button>
      </div>
    </div>`;
  }

  // Ação SECUNDÁRIA, discreta (V1.1): hospedar um Ponto Móvel da Mostraí.
  // Só aparece para quem já anuncia (direito ativo de veiculação — decidido
  // no servidor, `podeHospedarMovel`). "Quero ser um ponto" continua sendo a
  // ação principal do card.
  function htmlHospedarMovel() {
    return `<p class="ponto-movel-convite form-hint">Já anuncia na Mostraí?
      <a class="btn ghost mini" href="/hospedar.html">Hospedar um Ponto Móvel</a></p>`;
  }

  // Enquanto o pedido está aberto (lá no topo do painel), o lugar do convite
  // em Meus pontos vira um atalho pra ele — antes o card ficava vazio.
  function htmlPedidoAberto() {
    return `<div class="ponto-opportunity">
      <div class="ponto-opportunity-summary">
        <p class="form-hint u-m-0">Seu pedido para ser ponto está aberto.</p>
        <button class="btn ghost" type="button" data-acao="ir-para-form">Ir para o pedido</button>
      </div>
    </div>`;
  }

  // ---------- Os dois formulários de ponto ----------
  // Estação dos formulários de ponto (28/09/2026): abrem em #pontosNovo, uma
  // área do grid do painel na largura da página — não mais dentro da coluna
  // lateral de Meus pontos, onde o formulário ficava com ~340 px, campos
  // espremidos e o preview lá embaixo. Formulário ~65% e prévia ~35% (fixa
  // na rolagem) no desktop; uma coluna no celular. As duas formas continuam
  // sendo dois pedidos diferentes ("Enviar meu interesse" no comércio da
  // conta, "Enviar pedido" num estabelecimento novo), com a mesma estrutura.
  const DEPOIS_DO_ENVIO = `
    <p class="candidatura-contexto-titulo">Depois do envio</p>
    <ol class="candidatura-passos">
      <li><b>Em análise</b> A gente confere o pedido e chama no WhatsApp.</li>
      <li><b>Instalação</b> A visita é combinada com você. A tela é por nossa conta.</li>
      <li><b>Ativo</b> A tela liga e o comércio passa a fazer parte da rede.</li>
    </ol>`;

  function htmlFormPonto({ titulo, descricao, formId, corpo }) {
    return `<article class="panel form-ponto">
      <header class="form-ponto-cabeca">
        <p class="section-eyebrow">Seus comércios na rede</p>
        <h2 id="tituloFormPonto" tabindex="-1">${titulo}</h2>
        <p class="form-ponto-descricao">${descricao}</p>
      </header>
      <div class="candidatura-layout">
        <form id="${formId}" class="form-blocos form-ponto-form">${corpo}</form>
        ${candidaturaCampoPreview(DEPOIS_DO_ENVIO)}
      </div>
    </article>`;
  }

  // O comércio da conta, que é o que vai no pedido (nome e endereço saem da
  // conta, não de campos): antes o formulário compacto não dizia qual
  // endereço estava sendo oferecido.
  function htmlComercioDaConta(c) {
    return `<div class="comercio-da-conta">
      <p class="comercio-da-conta-nome">${esc(c.nome_empresa || '')}</p>
      <p class="comercio-da-conta-endereco">${esc(window.linhaEndereco(c, { comCidade: true }))}</p>
      <p class="form-hint">Nome e endereço são os da sua conta.</p>
    </div>`;
  }

  // O segmento que o servidor vai gravar na candidatura da conta
  // (`criarCandidaturaPonto`, src/conta/modos.js): o texto livre, ou o nome
  // da categoria ativa. Só pra prévia; sem ele, a prévia não mostra segmento.
  // O catálogo vem uma vez por página, não a cada abertura do formulário.
  let categorias = null;
  async function segmentoDaConta(c) {
    if (c?.categoria_livre) return c.categoria_livre;
    if (!c?.categoria_id) return '';
    categorias ||= fetch(`${API_BASE_URL}/categorias`)
      .then((r) => r.json())
      .then((lista) => (Array.isArray(lista) ? lista : []))
      .catch(() => {
        categorias = null;
        return [];
      });
    return (await categorias).find((x) => x.id === c.categoria_id)?.nome || '';
  }

  function montarFormCompacto(raiz) {
    const conta = obterConta();
    raiz.innerHTML = htmlFormPonto({
      titulo: 'Tornar-se ponto',
      descricao:
        'A tela, a instalação e o conteúdo são por nossa conta. Conte um pouco sobre o movimento do comércio e a gente chama no WhatsApp para combinar.',
      formId: 'formCardPonto',
      corpo: `
        ${candidaturaBloco('cp_', 'estabelecimento', 'Estabelecimento', `${htmlComercioDaConta(conta)}${candidaturaCampoFoto('cp_')}`)}
        ${candidaturaBloco('cp_', 'movimento', 'Movimento', candidaturaCampoMovimento('cp_'))}
        ${candidaturaBloco('cp_', 'horario', 'Horário de funcionamento', candidaturaCampoHorario('cp_'))}
        ${candidaturaBloco('cp_', 'observacoes', 'Observações', candidaturaCampoObservacoes('cp_'))}
        ${candidaturaAcoes('Enviar meu interesse', 'cardPontoMsg')}`,
    });
    const form = $('formCardPonto');
    candidaturaLigarValidacao(form);
    candidaturaLigarNumeros(form);
    candidaturaLigarHorario(form);
    candidaturaLigarFoto(form, 'cp_');
    const fixos = { nome: conta.nome_empresa, cidade: conta.cidade, uf: conta.uf };
    const atualizarPrevia = candidaturaLigarPreviewCard(form, raiz.querySelector('.candidatura-preview'), 'cp_', fixos);
    segmentoDaConta(conta).then((segmento) => {
      fixos.segmento = segmento;
      if (form.isConnected) atualizarPrevia();
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      enviarPedido(form, 'cp_', $('cardPontoMsg'), () => {
        const c = obterConta();
        return {
          nome_comercio: c.nome_empresa,
          ...(c.logradouro
            ? { logradouro: c.logradouro, numero: c.numero, complemento: c.complemento, bairro: c.bairro }
            : { endereco: c.endereco }),
          cidade: c.cidade,
          uf: c.uf,
          cep: c.cep,
          fluxo_estimado_mensal: Number(form.fluxo_estimado_mensal.value),
          mensagem: form.mensagem.value.trim() || null,
          horario_semanal: candidaturaHorarioDoForm(form),
        };
      });
    });
  }

  // ---------- Outro estabelecimento (formulário completo) ----------
  // Outro lugar, então pede tudo de novo — não reaproveita o endereço da
  // conta. Mesmo formulário canônico (public/candidatura-ponto.js).
  function montarFormCompleto(raiz) {
    raiz.innerHTML = htmlFormPonto({
      titulo: 'Novo estabelecimento',
      descricao: 'Entra como pedido: a gente confere, combina a visita e libera a tela.',
      formId: 'formNovoPonto',
      corpo: `
        ${candidaturaBloco(
          'np_',
          'estabelecimento',
          'Estabelecimento',
          `<div class="campo campo-nome"><label for="np_nome_comercio">Nome do estabelecimento</label><input id="np_nome_comercio" name="nome" autocomplete="organization" required></div>
          ${candidaturaCampoFoto('np_')}`,
        )}
        ${candidaturaBloco('np_', 'endereco', 'Endereço', candidaturaCampoEndereco('np_'))}
        ${candidaturaBloco(
          'np_',
          'segmento',
          'Segmento e movimento',
          `${candidaturaCampoSegmento('np_', 'Segmento')}${candidaturaCampoMovimento('np_')}`,
        )}
        ${candidaturaBloco('np_', 'horario', 'Horário de funcionamento', candidaturaCampoHorario('np_'))}
        ${candidaturaBloco('np_', 'observacoes', 'Observações', candidaturaCampoObservacoes('np_'))}
        ${candidaturaAcoes('Enviar pedido', 'msgNovoPonto')}`,
    });
    const form = $('formNovoPonto');
    // Montado depois do DOMContentLoaded (a lista chega por fetch), então o
    // ouvinte global de public/formulario.js não alcança este form: liga CEP
    // e segmento aqui, uma vez por montagem (o form é novo a cada abertura).
    candidaturaLigarValidacao(form);
    if (window.ligarCep) window.ligarCep(form);
    if (window.ligarCategorias) window.ligarCategorias(form);
    candidaturaLigarNumeros(form);
    candidaturaLigarHorario(form);
    candidaturaLigarFoto(form, 'np_');
    candidaturaLigarPreviewCard(form, raiz.querySelector('.candidatura-preview'), 'np_');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      enviarPedido(form, 'np_', $('msgNovoPonto'), () => ({
        nome_comercio: form.nome.value.trim(),
        ...candidaturaEnderecoDoForm(form),
        segmento: candidaturaSegmentoDoForm(form),
        fluxo_estimado_mensal: form.fluxo_estimado_mensal.value || null,
        mensagem: form.mensagem.value.trim() || null,
        horario_semanal: candidaturaHorarioDoForm(form),
      }));
    });
  }

  // As duas portas criam a MESMA candidatura; a diferença é só quem pode
  // chamar: conta que já é ponto usa /anunciantes/me/pontos, a que ainda
  // não é, /conta/modos/ponto/pedir.
  // Um envio por vez (`enviando`): o botão desliga na hora, mas o Enter num
  // campo também submete. Os dados só saem da tela depois do "ok" do
  // servidor; em erro, fica tudo como a pessoa deixou.
  let enviando = false;
  async function enviarPedido(form, prefixo, msg, montarCorpo) {
    if (enviando) return;
    const problema = candidaturaValidar(form);
    if (problema) {
      msg.textContent = 'Confira os campos marcados.';
      msg.className = 'form-msg err';
      candidaturaFocarProblema(problema);
      return;
    }
    enviando = true;
    const botao = form.querySelector('button[type="submit"]');
    const cancelar = form.querySelector('[data-acao="fechar-form"]');
    botao.disabled = true;
    cancelar.disabled = true;
    botao.setAttribute('aria-busy', 'true');
    botao.textContent = 'Enviando...';
    msg.textContent = '';
    msg.className = 'form-msg';
    let criado = false;
    try {
      const rota = dados?.ehPonto ? '/anunciantes/me/pontos' : '/conta/modos/ponto/pedir';
      const r = await fetch(`${API_BASE_URL}${rota}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(montarCorpo()),
      });
      const resposta = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(resposta.erro || 'Não foi possível enviar agora.');
      criado = true;
      // Foto opcional, sobe DEPOIS: o pedido já vale sem ela, e uma falha
      // aqui não desfaz o que foi enviado — mas agora a pessoa fica sabendo
      // (antes ia só pro console; e uma queda de rede aqui dizia "não foi
      // possível enviar" sobre um pedido que já tinha sido criado).
      let fotoFicou = false;
      const arquivo = candidaturaFotoSelecionada(form, prefixo);
      if (arquivo) {
        botao.textContent = 'Enviando a foto...';
        try {
          const fd = new FormData();
          fd.append('arquivo', arquivo);
          const rFoto = await fetch(`${API_BASE_URL}/conta/modos/ponto/candidaturas/${resposta.id}/foto`, {
            method: 'POST',
            credentials: 'include',
            body: fd,
          });
          if (!rFoto.ok) throw new Error(await rFoto.text().catch(() => ''));
        } catch (err) {
          console.error('falha ao enviar foto da candidatura', err.message);
          fotoFicou = true;
        }
      }
      fecharForm({ voltarParaLista: true });
      // A confirmação que fica: o card "Em análise" que aparece na lista.
      const aviso = $('msgMeusPontos');
      aviso.textContent = fotoFicou
        ? 'Pedido enviado, mas a foto não foi junto. Você pode mandar a foto pelo WhatsApp quando a gente chamar.'
        : 'Pedido enviado. A gente chama no WhatsApp pra combinar.';
      aviso.className = fotoFicou ? 'form-msg aviso' : 'form-msg ok';
      aviso.hidden = false;
      await carregar();
    } catch (err) {
      if (criado) return;
      msg.textContent = window.frase ? window.frase(err.message) : err.message;
      msg.className = 'form-msg err';
      botao.disabled = false;
      cancelar.disabled = false;
      botao.removeAttribute('aria-busy');
      botao.textContent = botao.dataset.texto;
    } finally {
      enviando = false;
    }
  }

  function rolarAte(el) {
    const suave = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: suave ? 'smooth' : 'auto', block: 'start' });
  }

  function abrirForm(completo) {
    const raiz = $('pontosNovo');
    if (completo) montarFormCompleto(raiz);
    else montarFormCompacto(raiz);
    raiz.hidden = false;
    raiz.closest('.painel-grid')?.classList.add('com-form-ponto');
    $('btnNovoPonto').hidden = true;
    rolarAte(raiz);
    // Quem usa leitor de tela é levado junto pro formulário que abriu.
    $('tituloFormPonto').focus({ preventScroll: true });
  }

  // `voltarParaLista`: depois de Cancelar ou de enviar, a pessoa volta pra
  // Meus pontos (onde o pedido aparece), e não fica olhando pro buraco que
  // o formulário deixou.
  function fecharForm({ voltarParaLista = false } = {}) {
    const raiz = $('pontosNovo');
    raiz.hidden = true;
    raiz.innerHTML = '';
    raiz.closest('.painel-grid')?.classList.remove('com-form-ponto');
    $('btnNovoPonto').hidden = !dados?.estabelecimentos.length;
    if (voltarParaLista) {
      rolarAte($('modPontos'));
      $('tituloMeusPontos')?.focus({ preventScroll: true });
    }
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
        }`;
      if (window.aplicarBarras) window.aplicarBarras(corpo);
    } catch {
      corpo.innerHTML = '<p class="form-msg err">Não deu pra carregar o painel dessa tela.</p>';
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
              // Em operação = tela instalada e funcionando; aguardando
              // instalação não conta (01/10/2026: "ativo" confundia).
              valor: `${ativos} de ${pontos.length} em operação`,
              alvo: 'modPontos',
            },
          ]
        : [],
      alertas,
    });
  }

  // ---------- Editar endereço (estação de endereços, 01/10/2026) ----------
  // O endereço FÍSICO do ponto (ou do pedido em análise), com o mesmo
  // componente do cadastro do ponto (public/endereco.js) e o mapa. Não é o
  // endereço da conta: aquele muda no perfil, e um nunca mexe no outro.
  // Ponto com tela instalada aceita a troca; a equipe confere depois — a
  // tela continua funcionando. Quem decide tudo isso é o servidor.
  const JA_INSTALADO = ['aguardando_primeiro_sinal', 'ativo', 'em_manutencao', 'inativo'];
  let editando = false;
  function editarEndereco(tipo, id) {
    const e = dados?.estabelecimentos.find((x) => x.tipo === tipo && Number(x.id) === Number(id));
    if (!e) return;
    // Registro de antes das partes (só a linha `endereco`): a linha vai pro
    // logradouro e o número fica em branco — nada é adivinhado.
    const valores = e.logradouro ? e : { ...e, logradouro: e.endereco || '', numero: '' };
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg-endereco';
    dlg.setAttribute('aria-labelledby', 'tituloEditarEndereco');
    dlg.innerHTML = `
      <div class="dlg-head"><h3 id="tituloEditarEndereco">Endereço de ${esc(e.nome || 'seu ponto')}</h3>
        <button type="button" class="dlg-close" data-fechar aria-label="Fechar">&times;</button></div>
      <div class="form-ponto">
        <form class="form-ponto-form" novalidate>
          ${JA_INSTALADO.includes(e.estado) ? '<p class="dlg-endereco-nota">Este ponto já tem tela instalada. A mudança vai para conferência da equipe Mostraí — a tela continua funcionando.</p>' : ''}
          ${window.camposEndereco('ee_', { valores })}
          <div data-mapa hidden></div>
          <p class="form-msg" data-msg role="status"></p>
          <div class="dlg-acoes">
            <button type="button" class="btn ghost" data-fechar>Cancelar</button>
            <button type="submit" class="btn primary">Salvar endereço</button>
          </div>
        </form>
      </div>`;
    document.body.appendChild(dlg);
    const form = dlg.querySelector('form');
    const msg = dlg.querySelector('[data-msg]');
    window.ligarCep(form);
    window.ligarMapaDoEndereco(form, dlg.querySelector('[data-mapa]'));
    const fechar = () => dlg.open && dlg.close();
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelectorAll('[data-fechar]').forEach((b) => b.addEventListener('click', fechar));
    dlg.addEventListener('mousedown', (ev) => {
      if (ev.target === dlg) fechar();
    });
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (editando) return;
      const invalido = [...form.querySelectorAll('input[required]')].find((c) => !c.value.trim());
      if (invalido) {
        msg.textContent = 'Preencha os campos do endereço (só o complemento é opcional).';
        msg.className = 'form-msg err';
        invalido.focus();
        return;
      }
      editando = true;
      const botao = form.querySelector('button[type="submit"]');
      botao.disabled = true;
      botao.textContent = 'Salvando...';
      msg.textContent = '';
      msg.className = 'form-msg';
      try {
        const rota = tipo === 'ponto' ? 'pontos' : 'candidaturas';
        const r = await fetch(`${API_BASE_URL}/anunciantes/me/${rota}/${Number(id)}/endereco`, {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(window.enderecoDoForm(form)),
        });
        const resposta = await r.json().catch(() => ({}));
        if (!r.ok) {
          msg.textContent = resposta.erro || 'Não foi possível salvar o endereço agora.';
          msg.className = 'form-msg err';
          if (resposta.campo) form.querySelector(`[name="${resposta.campo}"]`)?.focus();
          return;
        }
        fechar();
        carregar();
        window.recarregarPendencias?.();
      } catch {
        msg.textContent = 'Sem conexão com o servidor. Tente de novo.';
        msg.className = 'form-msg err';
      } finally {
        editando = false;
        botao.disabled = false;
        botao.textContent = 'Salvar endereço';
      }
    });
    dlg.showModal();
    form.querySelector('[name="cep"]').focus();
  }
  // "Corrigir endereço" da pendência do painel (public/pendencias.js).
  window.editarEnderecoDoEstabelecimento = async (tipo, id) => {
    if (!dados) await carregar();
    editarEndereco(tipo, id);
  };

  // ---------- Carga ----------
  // Uma carga por vez: SSE de tela e de ponto chegam juntos (a mesma mudança
  // emite os dois), e sem isto viravam duas requisições iguais em paralelo.
  // Mas aviso que chega DURANTE uma carga não pode se perder: ela pode ter
  // lido o banco antes da mudança que ele anuncia (ex.: a tela já com sinal e
  // o ponto ainda não atualizado). Então vale uma — e só uma — carga a mais
  // no fim.
  let carregarDeNovo = false;
  function carregar() {
    if (carregando) {
      carregarDeNovo = true;
      return carregando;
    }
    carregando = desenhar().finally(() => {
      carregando = null;
      if (carregarDeNovo) {
        carregarDeNovo = false;
        carregar();
      }
    });
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
      lista.innerHTML =
        (estabs.length
          ? estabs.map(htmlEstabelecimento).join('')
          : formAberto
            ? htmlPedidoAberto()
            : htmlOportunidade()) + (dados.podeHospedarMovel ? htmlHospedarMovel() : '');
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
      if (acao === 'editar-endereco') editarEndereco(alvo.dataset.tipo, alvo.dataset.id);
      if (acao === 'abrir-oportunidade') {
        $('pontosLista').innerHTML = htmlPedidoAberto();
        abrirForm(!contaTemEndereco());
      }
      if (acao === 'ir-para-form') {
        rolarAte($('pontosNovo'));
        $('tituloFormPonto')?.focus({ preventScroll: true });
      }
    });
    // O formulário mora fora de #modPontos (área própria do grid): Cancelar
    // é ouvido nele.
    $('pontosNovo')?.addEventListener('click', (ev) => {
      if (!ev.target.closest('[data-acao="fechar-form"]') || enviando) return;
      fecharForm({ voltarParaLista: true });
      carregar();
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
        // Crédito mensal do ponto (ADR-016): o rodapé "crédito de setembro já
        // concedido" muda junto com o saldo.
        'credits.updated': carregar,
      });
    }
    // Tela que para de falar não gera evento nenhum (não há quem avise):
    // sem isto, a página aberta seguiria "Funcionando" enquanto o admin já
    // mostra "Sem sinal". Mesma cadência do admin; pula aba escondida e o
    // modal da tela aberto (a recarga não mexe no formulário de ponto novo).
    setInterval(() => {
      if (!document.hidden && !$('modalTela')?.open) carregar();
    }, 60 * 1000);
  };
})();
