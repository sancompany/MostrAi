const fmt = fmtBRL; // config.js

let ANUNCIANTE = null;
let ANUNCIANTE_ID = null;

async function carregar() {
  // Primeira carga: reaproveita o /anunciantes/me que o layout.js já pediu
  // (carregarConta) — eram duas chamadas iguais a cada abertura do painel.
  // As recargas (SSE, resgate) pedem de novo: o plano pode ter mudado.
  const jaCarregada = !ANUNCIANTE && window.carregarConta ? await window.carregarConta() : null;
  if (jaCarregada) {
    ANUNCIANTE = jaCarregada;
  } else {
    const r = await fetch(`${API_BASE_URL}/anunciantes/me`, { credentials: 'include' });
    if (r.status === 401) {
      window.location.href = '/anunciante/login.html';
      return;
    }
    // Sem isso, um 500 caía no .json(), ANUNCIANTE_ID virava undefined e o
    // painel montava vazio e funcional — o cliente via "0 exibições" em vez
    // de "não deu pra carregar".
    if (!r.ok) throw new Error();
    ANUNCIANTE = await r.json();
  }
  ANUNCIANTE_ID = ANUNCIANTE.id;
  // Popup de perfil, avatar e sair vêm de /perfil.js — a mesma tela que o
  // painel do ponto usa, em vez de duas cópias que divergem.
  montarPerfil(ANUNCIANTE, (nova) => {
    ANUNCIANTE = nova;
    preencherStatusBanner();
  });
  // Hero, resumo e plano valem pra toda conta — inclusive a que ainda não
  // ativou o modo anúncios (dono de ponto que só cede a parede).
  preencherStatusBanner();

  // Painel único (modos.js): sem o papel "anunciante" o dashboard dá
  // lugar ao card de ativação. Com o papel, segue o fluxo normal.
  const estado = await montarModo('anunciante', document.getElementById('dashboardAnuncios'), async (estado) => {
    // Bônus de comodato (plano de anúncio grátis por tempo de ponto no ar):
    // antes só aparecia na página separada do ponto.
    const bonus = document.getElementById('bonusAnuncios');
    bonus.innerHTML = cardBonus(estado, 'ponto') + cardBonus(estado, 'anuncio');
    ligarResgateAnuncio(bonus, carregar);
    // Sem plano ainda, a tela inteira (KPIs, gráficos e o upload de
    // criativo) fica bloqueada — pedido do dono, 19/09/2026. Antes dava
    // pra subir 1 criativo mesmo sem plano "pra não travar o meio do
    // cadastro"; a decisão virou o contrário: trava, com aviso pra
    // escolher plano (o back também passou a recusar isso, defesa em
    // profundidade — ver POST /anunciantes/:id/criativos).
    //
    // "Plano" aqui é o EFETIVO — comercial OU comodato (23/09/2026,
    // separação dos dois campos, migration 077). Dono de ponto sem nenhum
    // plano pago continua liberado pelo comodato (Inicial/Básico), que
    // sempre deu direito a subir o autoanúncio — só nunca tinha campo
    // próprio antes.
    if (!ANUNCIANTE.plano_id && !ANUNCIANTE.comodato_plano_id) {
      montarBloqueioPlano();
      return;
    }
    removerBloqueioPlano();
    carregarExibicoes();
    carregarBancoHoras();
  });
  if (estado && !estado.modos.anunciante.liberado) {
    // Veio da vitrine querendo um plano: guarda pra depois de ativar.
    const planoUrl = new URLSearchParams(window.location.search).get('plano');
    if (planoUrl) history.replaceState(null, '', `/anunciante/painel.html?plano=${encodeURIComponent(planoUrl)}`);
  }
}

// Sem F5 (Fase 3, SSE — eventos.js): cada evento refaz só o que ele afeta.
// `payment.updated`/`plan.updated`/`account.updated` mudam o estado da CONTA
// (plano, expiração, suspensão) — o próprio `carregar()` já resolve isso do
// zero, incluindo o bloqueio de plano, sem reload. `credits.updated` e
// `notification.created` são assinados pelos próprios módulos (creditos.js,
// notificacoes.js).
if (window.ligarEventosDaConta) {
  window.ligarEventosDaConta({
    'payment.updated': carregar,
    'plan.updated': carregar,
    'account.updated': carregar,
    'application.updated': carregar,
  });
}

// Mesmo padrão de public/modos.js (window.montarModo): esconde o container
// de verdade e insere um card no lugar dele, um nível abaixo do bloqueio de
// papel — aqui o papel "anunciante" já está liberado, só falta plano.
// Idempotente e reversível: carregar() roda de novo pelo SSE e depois de um
// resgate de créditos. Sem remover o anterior, cada rodada empilhava outro
// card de bloqueio; sem desfazer, a conta que ganhava plano continuava
// bloqueada até dar F5.
function removerBloqueioPlano() {
  document.getElementById('bloqueioPlanoCaixa')?.remove();
  document.getElementById('dashboardAnuncios').hidden = false;
}

function montarBloqueioPlano() {
  removerBloqueioPlano();
  const container = document.getElementById('dashboardAnuncios');
  container.hidden = true;
  const caixa = document.createElement('div');
  caixa.id = 'bloqueioPlanoCaixa';
  caixa.className = 'wrap';
  caixa.innerHTML = ANUNCIANTE.suspenso
    ? `<div class="card wide modo-card u-ta-c" id="bloqueioPlano">
        <p class="eyebrow">Seu painel</p>
        <h3>Conta suspensa</h3>
        <p class="form-hint u-m-0">Veja a explicação ali em cima. Seus números voltam a aparecer aqui assim que a conta for reativada.</p>
      </div>`
    : `<div class="card wide modo-card u-ta-c" id="bloqueioPlano">
        <p class="eyebrow">Seu painel</p>
        <h3>Escolha um plano pra ver seus números</h3>
        <p class="form-hint u-m-0 u-mb-8">Ative um plano e comece a anunciar agora mesmo.</p>
        <a class="btn primary" href="/planos.html">Escolher plano</a>
      </div>`;
  container.parentNode.insertBefore(caixa, container);
}

// Hero da conta (Fatia 5): saudação e, pra conta suspensa, a explicação.
// O que a conta tem e o que precisa de atenção vem logo abaixo, do resumo
// (painel-resumo.js); plano e ações de assinatura moram no card "Plano
// comercial" — antes o hero repetia o plano e o botão de gerenciar.
function preencherStatusBanner() {
  const el = document.getElementById('statusBanner');
  // Só um estado tem explicação aqui: `suspenso` (campo próprio desde
  // 16/09/2026, separado de `status`). Quem pediu devolução cai exatamente
  // aqui, porque o arrependimento zera o plano e suspende a conta.
  const explicacao = ANUNCIANTE.suspenso
    ? 'Sua conta está suspensa, e o anúncio não está no ar. Se você pediu devolução, o pedido está em andamento; ' +
      'se foi falta de pagamento, a conta volta assim que a cobrança for confirmada. <a href="/contato.html">Fale com a gente</a>.'
    : null;
  el.innerHTML = `
    <div class="hero-main">
      <div class="hero-copy">
        <p class="hero-kicker">Sua conta na Mostraí</p>
        <h1>Olá, ${esc(ANUNCIANTE.nome_empresa)}</h1>
        <p>Anúncios, pontos, criativos e o dinheiro da conta, num lugar só.</p>
        ${explicacao ? `<span class="dash-explica">${explicacao}</span>` : ''}
      </div>
    </div>
    <div class="hero-status" id="heroStatus" hidden></div>
  `;
  desenharPlano();
  carregarPontos();
}

// "Plano comercial" (Fatia 5): o que a conta tem pra anunciar na rede —
// situação, validade e as ações (escolher, trocar, gerenciar). O comodato
// aparece junto quando existe, porque é ele que põe o anúncio do dono na
// tela do próprio comércio mesmo sem plano pago.
function situacaoDoPlano() {
  if (!ANUNCIANTE.plano_id) return ['sem_plano', 'badge-neutro', 'Sem plano'];
  if (ANUNCIANTE.suspenso) return ['suspensa', 'badge-err', 'Suspensa'];
  if (ANUNCIANTE.data_expiracao && new Date(ANUNCIANTE.data_expiracao) <= new Date())
    return ['vencida', 'badge-pendente', 'Vencida'];
  if (ANUNCIANTE.plano_cortesia) return ['cortesia', 'badge-neutro', 'Cortesia'];
  return ['ativa', 'badge-ok', 'Ativa'];
}

function desenharPlano() {
  const secao = document.getElementById('modPlano');
  if (!secao || !ANUNCIANTE) return;
  const [situacao, classe, rotulo] = situacaoDoPlano();
  const nome = ANUNCIANTE.plano_id ? ANUNCIANTE.plano?.nome || 'Seu plano' : 'Nenhum plano comercial';
  const validade =
    ANUNCIANTE.plano_id && ANUNCIANTE.data_expiracao
      ? `<p class="plano-validade">${situacao === 'vencida' ? 'Venceu em' : 'Até'} ${window.dataBR(ANUNCIANTE.data_expiracao)}${ANUNCIANTE.plano_cortesia ? ' · sem cobrança, não renova sozinho' : ''}</p>`
      : '';
  const comodato =
    ANUNCIANTE.comodato_plano_id && !ANUNCIANTE.plano_id
      ? '<p class="plano-comodato">Pelo comodato, o seu anúncio já roda na tela do seu comércio.</p>'
      : '';
  const acoes = [];
  if (ANUNCIANTE.plano_id) {
    acoes.push('<button type="button" class="btn ghost mini" data-acao="gerenciar-plano">Gerenciar plano</button>');
  } else if (!ANUNCIANTE.suspenso) {
    acoes.push('<a class="btn primary mini" href="/planos.html">Escolher plano</a>');
  }
  document.getElementById('planoResumo').innerHTML = `
    <p class="plano-nome"><b>${esc(nome)}</b> <span class="badge ${classe}">${rotulo}</span></p>
    ${validade}${comodato}
    ${acoes.length ? `<div class="plano-acoes">${acoes.join('')}</div>` : ''}`;
  secao.hidden = false;
  if (ANUNCIANTE.plano_id) preencherAssinatura();

  const alertas = [];
  if (situacao === 'vencida')
    alertas.push({
      nivel: 'atencao',
      texto: 'Seu plano venceu — escolha um plano pra voltar ao ar.',
      alvo: 'modPlano',
    });
  if (situacao === 'suspensa')
    alertas.push({ nivel: 'atencao', texto: 'Sua conta está suspensa: o anúncio não está no ar.', alvo: 'modPlano' });
  const diasRestantes = ANUNCIANTE.data_expiracao
    ? Math.ceil((new Date(ANUNCIANTE.data_expiracao) - Date.now()) / 86400000)
    : null;
  if (situacao === 'cortesia' && diasRestantes !== null && diasRestantes <= 7)
    alertas.push({
      nivel: 'info',
      texto: `Sua cortesia termina em ${diasRestantes} ${diasRestantes === 1 ? 'dia' : 'dias'} e não renova sozinha.`,
      alvo: 'modPlano',
    });
  window.publicarResumo?.('plano', {
    chips: [{ rotulo: 'Plano', valor: ANUNCIANTE.plano_id ? `${nome} · ${rotulo}` : 'Sem plano', alvo: 'modPlano' }],
    alertas,
  });
}

// Autoatendimento: cancelar e trocar de plano, sem passar pelo admin.
// Só aparece pra quem tem plano pago em dia (cortesia não tem o que
// cancelar, e conta suspensa já mostra a explicação própria acima).
// ---------------------------------------------------------------------------
// Onde seu anúncio aparece — escolha de pontos (17/09/2026)
// ---------------------------------------------------------------------------
// O plano dá acesso a N pontos. Marcar é opcional: quem não marca recebe uma
// fatia sorteada de forma estável, e isso é dito na tela em vez de ficar
// implícito — senão "não marquei nada" parece "não vou aparecer em lugar
// nenhum", que é o contrário do que acontece.
// RN-49 — o bônus de cobertura, em HORAS POR MÊS (pedido do dono, 17/09/2026).
//
// Segundos por hora é a unidade do motor, não a do cliente: ele comprou horas
// de tela por mês, é assim que o card vende, e trocar de unidade no meio do
// caminho obriga ele a multiplicar por 12 e por 30 pra saber se ganhou algo.
// Aqui só aparece a unidade que ele já conhece.
//
// Dois números e não um: quantas horas a rede de hoje daria SEM a regra, e
// quantas ela dá com ela. Sem o primeiro, "você ganhou N horas" não tem em
// relação a quê — e é justamente o que dá pra conferir.
function pintarCompensacao(c) {
  const el = document.getElementById('avisoCompensacao');
  if (!el) return;
  if (!c?.compensando) {
    el.hidden = true;
    return;
  }
  const ganho = c.horas_hoje - c.horas_sem_compensacao;
  const faltam = c.contratados - c.veiculando;
  const h = (n) => `${n} ${n === 1 ? 'hora' : 'horas'}`;
  el.innerHTML =
    `<b>A rede Mostraí está crescendo</b> ` +
    `Seu plano cobre ${c.contratados} pontos e ${c.veiculando} ${c.veiculando === 1 ? 'está' : 'estão'} veiculando hoje. ` +
    `O tempo ${faltam === 1 ? 'do ponto que falta' : `dos ${faltam} pontos que faltam`} volta pros que estão no ar: ` +
    `em vez das ${h(c.horas_sem_compensacao)} de tela por mês que a rede de hoje daria, você tem ` +
    `<b>${h(c.horas_hoje)} de tela por mês</b> — <b>${h(ganho)} a mais</b>, sem pagar nada além do plano. ` +
    `Conforme os pontos entrarem no ar, o tempo se espalha de volta e você chega nas ` +
    `${h(c.horas_contratadas)} por mês que contratou.`;
  el.hidden = false;
}

async function carregarPontos() {
  if (!ANUNCIANTE.plano_id || ANUNCIANTE.plano_cortesia) return;
  let dados;
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos-disponiveis`, { credentials: 'include' });
    if (!r.ok) return;
    dados = await r.json();
  } catch {
    return;
  }
  const limite = dados.limite;
  document.getElementById('painelPontos').hidden = false;
  pintarCompensacao(dados.cobertura);

  const lista = document.getElementById('listaPontos');
  if (!dados.pontos.length) {
    lista.innerHTML =
      '<div class="empty-state dashboard-empty">A rede ainda não tem pontos disponíveis para seleção. Sua cobertura aparecerá aqui conforme eles entrarem no ar.</div>';
    return;
  }
  // Uma linha por ponto, sem o cartão grande de antes (19/09/2026, pedido
  // do dono: "se existir muitos pontos cadastrados ele se perde") — nome,
  // cidade e status cabem numa linha só; o link do mapa reaproveita a MESMA
  // busca do Google Maps que a vitrine pública já usa em pontos.page.js.
  lista.innerHTML = dados.pontos
    .map((p) => {
      const instalando = p.status === 'a_instalar';
      // Ponto em instalação nunca está "cheio": ele não vendeu hora nenhuma
      // ainda. Bloquear ele por ocupação seria bloquear por um zero que
      // significa "ainda não existe", não "tem espaço de sobra".
      const cheio = !instalando && p.ocupacao >= 100;
      const enderecoCompleto = `${p.endereco ? `${p.endereco}, ` : ''}${p.cidade || ''}`;
      const mapaUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enderecoCompleto)}`;
      // <a> fica FORA do <label> de propósito: um link dentro de um label
      // ainda ativa o checkbox quando o clique borbulha até o label (é o
      // label que decide isso, não dá pra impedir com stopPropagation numa
      // camada acima). O <label> vira `display:contents` no CSS — some da
      // caixa, mas continua marcando/desmarcando o checkbox normalmente —
      // e os dois (label e link) viram irmãos dentro do mesmo grid da
      // linha, então o alinhamento continua igual.
      // Horário de funcionamento (22/09/2026, pedido do dono) vai no title
      // do nome — a linha já é enxuta de propósito (19/09/2026, "se existir
      // muitos pontos ele se perde"), sem espaço pra mais uma coluna visível.
      // `title` sozinho não é acessível (não existe pra quem navega por
      // teclado, e leitor de tela não anuncia de forma confiável) — o span
      // também ganha `tabindex`/`aria-label`, que resolve teclado e leitor
      // de tela nos dois; toque-e-segure no celular sem leitor de tela
      // continua sem revelar o texto (limite conhecido do `title`, aceito
      // pelo dono junto da compactação: "mais excluso"). `null` (ponto
      // antigo, sem horário informado ainda) não aparece — mostrar "não
      // informado" por hover de todo ponto seria mais ruído que ajuda.
      const tituloNome = p.horario ? `${p.nome} · ${p.horario}` : p.nome;
      return `<div class="ponto-escolha${cheio ? ' cheio' : ''}" data-busca="${esc(`${p.nome} ${p.cidade || ''}`.toLowerCase())}">
      <label class="ponto-marcar">
        <input type="checkbox" value="${p.id}" ${p.escolhido ? 'checked' : ''} ${cheio && !p.escolhido ? 'disabled' : ''}>
        <span class="ponto-nome" title="${esc(tituloNome)}" ${p.horario ? `tabindex="0" aria-label="${esc(tituloNome)}"` : ''}>${esc(p.nome)}</span>
        <span class="ponto-end" title="${esc(enderecoCompleto)}">${esc(p.cidade || '')}</span>
        <span class="ponto-ocupacao">${instalando ? window.ROTULOS.ponto.a_instalar : cheio ? 'Sem espaço agora' : `${p.ocupacao}% vendido`}</span>
      </label>
      <a class="ponto-mapa" href="${mapaUrl}" target="_blank" rel="noopener" title="Ver no mapa" aria-label="Ver ${esc(p.nome)} no mapa">📍</a>
    </div>`;
    })
    .join('');

  // Busca só aparece quando faz diferença — poucos pontos não precisam de
  // filtro, e um campo vazio de propósito é uma pergunta sem necessidade.
  const LIMIAR_BUSCA = 6;
  const busca = document.getElementById('buscaPontos');
  if (busca && dados.pontos.length > LIMIAR_BUSCA) {
    busca.hidden = false;
    // `oninput`/`onchange` (e não addEventListener): esta função roda de novo
    // a cada carga do painel (SSE, resgate), e cada addEventListener somava
    // mais um ouvinte — um clique no ponto virava N PUTs iguais.
    busca.oninput = () => {
      const termo = busca.value.trim().toLowerCase();
      lista.querySelectorAll('.ponto-escolha').forEach((el) => {
        el.hidden = termo.length > 0 && !el.dataset.busca.includes(termo);
      });
    };
  }

  const msg = document.getElementById('msgPontos');
  const contador = document.getElementById('contadorPontos');
  const marcados = () => [...lista.querySelectorAll('input:checked')].map((i) => Number(i.value));

  function pintarContador() {
    const n = marcados().length;
    const base = limite ? `${n} de ${limite} escolhidos` : `${n} escolhido${n === 1 ? '' : 's'}`;
    // "Escolhidos" e "em operação" são contagens diferentes (o cliente pode
    // escolher um ponto que ainda está em instalação, ou não escolher nada e
    // ainda assim aparecer nos que estão no ar) — juntar os dois números no
    // mesmo badge evita a leitura de que "1 de 7" já diz tudo sobre a
    // cobertura real de hoje.
    const veiculando = dados.cobertura?.veiculando;
    contador.textContent = veiculando != null ? `${base} · ${veiculando} em operação` : base;
    contador.className = !limite || n >= limite ? 'badge badge-ok' : 'badge badge-pendente';
    // Passar do limite não é erro de servidor: é uma caixa que não devia ter
    // deixado marcar. Desligar as outras é mais honesto que aceitar e recusar
    // depois do clique em salvar.
    if (limite) {
      lista.querySelectorAll('input:not(:checked)').forEach((i) => {
        if (!i.closest('.ponto-escolha').classList.contains('cheio')) i.disabled = n >= limite;
      });
    }
  }
  pintarContador();

  lista.onchange = async (e) => {
    if (e.target.tagName !== 'INPUT') return;
    pintarContador();
    msg.textContent = 'Salvando...';
    msg.className = 'form-msg';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pontos: marcados() }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = window.frase(corpo.erro || 'não deu pra salvar');
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = marcados().length ? 'Pronto. Salvo.' : 'Pronto. Sem marcação, a gente distribui seus pontos.';
      msg.className = 'form-msg ok';
    } catch {
      msg.textContent = 'Sem conexão. Tente de novo.';
      msg.className = 'form-msg err';
    }
  };
}

// Conteúdo do dialog #dlgPlano — chamada sempre que há plano_id, não só
// quando "ativo" (19/09/2026): quem está em cortesia ou com a cobertura
// vencida também pode querer abrir e ver o que está acontecendo. As duas
// ações (trocar/cancelar) só fazem sentido pra quem paga em dia — não tem o
// que cancelar numa cortesia, nem o que trocar numa cobertura já vencida
// (o botão de "Escolher plano" no banner já cobre esse caso).
function preencherAssinatura() {
  const el = document.getElementById('resumoAssinatura');
  const ativo =
    !ANUNCIANTE.plano_cortesia &&
    !ANUNCIANTE.suspenso &&
    ANUNCIANTE.data_expiracao &&
    new Date(ANUNCIANTE.data_expiracao) > new Date();
  const nomePlano = ANUNCIANTE.plano?.nome || 'seu plano';
  const ate = ANUNCIANTE.data_expiracao
    ? `${ativo ? 'Ativa' : ANUNCIANTE.plano_cortesia ? 'Cortesia' : 'Vencida'} até <b>${window.dataBR(ANUNCIANTE.data_expiracao)}</b>`
    : ativo
      ? 'Ativa'
      : 'Sem data de expiração';
  el.innerHTML = `
    <p class="u-m-0 u-mb-4">${esc(nomePlano)} · ${ate}.</p>
    ${
      ativo
        ? `<p class="form-hint u-m-0 u-mb-12">Cancelar não devolve o que já foi pago. O período atual continua no ar até essa data, e não renova depois.</p>
    <div class="field-row">
      <a class="btn ghost" href="/planos.html">Trocar de plano</a>
      <button class="btn ghost" id="btnCancelarAssinatura">Cancelar assinatura</button>
    </div>
    <p class="form-msg" id="msgCancelarAssinatura"></p>`
        : ANUNCIANTE.plano_cortesia
          ? '<p class="form-hint u-m-0">Plano de cortesia, sem cobrança — não há assinatura para cancelar ou trocar por aqui.</p>'
          : '<p class="form-hint u-m-0">Cobertura vencida. <a href="/planos.html">Escolha um plano</a> para voltar ao ar.</p>'
    }
  `;
  if (ativo) document.getElementById('btnCancelarAssinatura').addEventListener('click', cancelarAssinatura);
}

async function cancelarAssinatura() {
  if (
    !window.confirm(
      'Cancelar sua assinatura? O período que você já pagou continua no ar até o fim. Depois disso, não há nova cobrança nem novo anúncio no ar.',
    )
  )
    return;
  const btn = document.getElementById('btnCancelarAssinatura');
  const msg = document.getElementById('msgCancelarAssinatura');
  btn.disabled = true;
  const r = await fetch(`${API_BASE_URL}/anunciantes/me/cancelar-assinatura`, {
    method: 'POST',
    credentials: 'include',
  });
  if (!r.ok) {
    msg.textContent = (await r.json().catch(() => ({}))).erro || 'Não foi possível cancelar agora.';
    msg.className = 'form-msg err';
    btn.disabled = false;
    return;
  }
  msg.textContent = 'Assinatura cancelada. A cobertura continua até o fim do período já pago.';
  msg.className = 'form-msg ok';
  btn.remove();
}

// Fechar o dialog de plano — mesmo padrão de #dlgPerfil (perfil.js): botão
// de fechar, clique fora (no <dialog>, o próprio elemento é o backdrop) e
// Esc, que o <dialog> nativo já trata sozinho.
(function dialogPlano() {
  const dlg = document.getElementById('dlgPlano');
  if (!dlg) return;
  document.getElementById('modPlano')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-acao="gerenciar-plano"]')) dlg.showModal();
  });
  document.getElementById('btnFecharPlano').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) dlg.close();
  });
})();

// O link do comprovante carrega o período escolhido, como a referência de
// mercado faz: exportação respeita o mesmo recorte que está na tela.
//
// O href se monta no CLIQUE, nao no carregamento: este bloco roda antes de
// `carregarConta()` resolver, entao `ANUNCIANTE_ID` ainda e null e o link
// nascia apontando pra /anunciantes/null/exibicoes.csv. Quem clicasse sem
// antes mexer no seletor de periodo baixava um erro.
(function comprovante() {
  const sel = document.getElementById('periodoComprovante');
  const link = document.getElementById('btnComprovante');
  if (!sel || !link) return;
  const montar = () => `${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes.csv?dias=${sel.value}`;
  const atualizar = () => {
    if (ANUNCIANTE_ID) link.href = montar();
  };
  sel.addEventListener('change', atualizar);
  link.addEventListener('click', (e) => {
    if (!ANUNCIANTE_ID) {
      e.preventDefault();
      return;
    }
    link.href = montar();
  });
  atualizar();
})();

// Segundos em tempo legível, na maior unidade que ainda cabe: só segundos
// enquanto < 60, minutos enquanto < 60min, senão horas. Pedido do dono
// (18/09/2026) — "N exibições" sozinho não diz o tamanho da prioridade;
// tempo diz. Sempre com 1 casa nas unidades maiores, pra não sumir com o
// resto (ex.: 90s → "1,5min", não "2min" arredondado feito outra coisa).
function duracaoLegivel(segundos) {
  if (segundos < 60) return `${Math.round(segundos)}s`;
  const minutos = segundos / 60;
  if (minutos < 60) return `${(Math.round(minutos * 10) / 10).toLocaleString('pt-BR')}min`;
  return `${(Math.round((minutos / 60) * 10) / 10).toLocaleString('pt-BR')}h`;
}

// Tempo decorrido em prosa curta, pro aviso de ponto fora do ar — não reusa
// duracaoLegivel porque ali "3h" faz sentido pra uma duração de exibição, e
// aqui um silêncio de dois dias em horas ("48h") é mais difícil de ler que
// "2 dias".
function tempoDesde(dataISO) {
  const horas = (Date.now() - new Date(dataISO).getTime()) / 3_600_000;
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))} min`;
  if (horas < 48) return `${Math.round(horas)} h`;
  return `${Math.round(horas / 24)} dias`;
}

// Estado operacional no hero (21/09/2026, revisão de design): "campanha
// ativa" não pode significar só "tem plano" — a tela pode estar apagada há
// horas com o plano em dia, e é exatamente esse caso que o anunciante mais
// precisa ver primeiro, antes de qualquer KPI. A situação de cada ponto vem
// pronta do servidor (`situacao`, régua única do Player V2 em
// src/lib/status-tela.js), a mesma que a tabela "Exibições por ponto" usa.
// Ponto fora do horário não é alerta: a loja fechada não é TV desligada.
function pintarStatusOperacional(porPonto) {
  const el = document.getElementById('heroStatus');
  if (!el) return;
  if (!porPonto.length) {
    el.hidden = true;
    return;
  }
  const noAr = porPonto.filter((p) => p.situacao === 'no_ar');
  const n = porPonto.length;
  const itens = [
    `<span class="hero-status-item"><span class="dot" aria-hidden="true"></span>${noAr.length} de ${n} ${n === 1 ? 'ponto no ar' : 'pontos no ar'}</span>`,
  ];
  const foraDoAr = porPonto.filter((p) => p.situacao === 'fora_do_ar');
  if (foraDoAr.length) {
    const maisAntigo = foraDoAr
      .map((p) => p.ultima_vez_online)
      .filter(Boolean)
      .sort()[0];
    const desde = maisAntigo ? `sinal mais antigo há ${tempoDesde(maisAntigo)}` : 'nunca recebeu playlist';
    itens.push(`<span class="hero-status-item hero-status-alerta">⚠ ${desde}</span>`);
  }
  el.innerHTML = itens.join('');
  el.hidden = false;
}

// Dashboard de exibições — leitura agregada de GET /anunciantes/:id/exibicoes
// (transparência de entrega: programado vs. confirmado, custo por exibição).
// Banco de horas (G.3): card sempre visível (19/09/2026, pedido do dono —
// antes só aparecia com saldo > 0; agora a conta consegue conferir "quanto
// tem no banco" mesmo quando é zero, sem precisar adivinhar que o
// mecanismo existe). `catch` silencioso de propósito: é um aviso extra, não
// um número que o cliente precisa pra decidir algo, e um painel que já
// carregou tudo (exibições, criativos) não deveria mostrar erro por causa
// deste card.
//
// O tempo (`dados.segundos`) é ilustrativo — exibições × duração ATUAL da
// peça (RN-53), não um histórico exato — por isso o número exato de
// exibições fica do lado, entre parênteses: quem quiser conferir a conta
// tem o dado que a apuração realmente usa.
async function carregarBancoHoras() {
  const card = document.querySelector('#kpiGrid [data-kpi="banco"]');
  if (!card) return;
  try {
    const dados = await (await fetch(`${API_BASE_URL}/anunciantes/me/banco-horas`, { credentials: 'include' })).json();
    // Só aparece quando tem significado (23/09/2026, pedido do dono, revendo
    // o "card sempre visível" de 19/09): sem déficit, um card dizendo "0s ·
    // sem déficit acumulado" ocupa espaço do resumo sem informar nada. Com
    // déficit, é a informação de que a entrega atrasada será compensada.
    if (!dados.saldo) {
      card.hidden = true;
      return;
    }
    card.querySelector('b').textContent = duracaoLegivel(dados.segundos);
    card.querySelector('[data-kpi-banco-legenda]').textContent =
      `${dados.saldo} exibições · prioridade nos próximos dias`;
    card.hidden = false;
  } catch {
    /* aviso extra — sem ele, o painel continua completo */
    card.hidden = true;
  }
}

// Horas contratadas x entregues no mês corrente (19/09/2026, pedido do
// dono) — é a métrica que a conta realmente vende, então é o PRIMEIRO
// card do grid, não mais um card solto anexado no fim (HTML já reserva o
// lugar em painel.html, com data-kpi="horas"). Mesma barrinha de progresso
// do gráfico por ponto (.track/.fill), sem componente novo. Só aparece com
// plano (os dois vêm null sem plano, e nem deveria chegar até aqui: o
// bloqueio de plano já barra essa chamada).
function desenharHorasMes(contratadas, entregues) {
  const card = document.querySelector('#kpiGrid [data-kpi="horas"]');
  if (contratadas == null || !card) return;
  const restantes = Math.max(0, contratadas - entregues);
  const pct = contratadas > 0 ? Math.min(100, (entregues / contratadas) * 100) : 0;
  card.querySelector('b').textContent = `${entregues}h`;
  card.querySelector('[data-kpi-horas-legenda]').textContent =
    `de ${contratadas}h contratadas · ${restantes}h ainda por rodar`;
  const fill = card.querySelector('.fill');
  fill.dataset.pct = pct;
  // A barra já existe no HTML (data-pct="0") desde o carregamento — o
  // observador de config.js só aplica uma vez por elemento
  // (:not([data-pct-ok])), então mudar o número aqui não bastaria sozinho.
  fill.removeAttribute('data-pct-ok');
  window.aplicarBarras(card);
  card.hidden = false;
}

async function carregarExibicoes() {
  try {
    const dados = await (
      await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes`, { credentials: 'include' })
    ).json();
    const kpi = (nome) => document.querySelector(`#kpiGrid [data-kpi="${nome}"] b`);
    // Fração "concluídas/total" num número só (19/09/2026, pedido do dono)
    // — antes eram duas legendas de prosa; agora é a mesma resposta num
    // formato que se lê num olhar só.
    const concluidas = (dados.confirmadasMes ?? 0).toLocaleString('pt-BR');
    kpi('exibicoes').textContent =
      dados.exibicoesContratadasMes != null
        ? `${concluidas} / ${dados.exibicoesContratadasMes.toLocaleString('pt-BR')}`
        : concluidas;
    // Por MIL exibições, não por exibição só (21/09/2026, revisão de
    // design): a mesma fórmula (plano ÷ previstas) em duas casas decimais
    // colapsava pra R$ 0,01 em qualquer plano — número que não se move não
    // informa nada. Não é CPM: CPM é custo por mil PESSOAS impactadas, e o
    // Mostraí não mede audiência, só reprodução na tela.
    kpi('custo').textContent = dados.custoPorExibicao ? fmt(dados.custoPorExibicao * 1000) : '-';
    kpi('media').textContent = dados.mediaDiariaMes ?? '-';

    desenharPorDia(dados.porDia || [], dados.porDiaPonto || [], dados.porPonto || []);
    desenharPorPonto(dados.porPonto || []);
    desenharHorasMes(dados.horasContratadasMes, dados.horasEntreguesMes);
    pintarStatusOperacional(dados.porPonto || []);
    explicarZero(dados);
    const erro = document.getElementById('exibicoesErro');
    if (erro) erro.hidden = true;
  } catch {
    // Antes o catch era vazio: falha de API e conta nova produziam a mesma
    // tela de "—", e quem paga não conseguia distinguir "meu anúncio não
    // rodou" de "o painel quebrou".
    //
    // Elemento próprio em vez de anexar ao #statusBanner: com o SSE
    // reexecutando esta função, cada falha empilhava mais uma linha de erro.
    const erro = document.getElementById('exibicoesErro');
    if (erro) {
      erro.textContent = 'Não foi possível carregar seus números agora. Tente atualizar a página.';
      erro.hidden = false;
    }
  }
}

// Conta nova enxerga a mesma tela de uma conta que parou de rodar: tudo zero,
// tres traços e nenhum grafico. Sem uma linha dizendo em que etapa a conta
// esta, quem acabou de pagar conclui que comprou algo que nao funciona.
//
// Não trata mais "sem plano" aqui — desde o bloqueio de plano (19/09/2026),
// essa função só roda com plano garantido (ver montarBloqueioPlano/carregar).
function explicarZero(dados) {
  const el = document.getElementById('exibicoesVazio');
  if (!el) return;
  if (dados.totalProgramadas > 0 || dados.totalConfirmadas > 0) {
    el.hidden = true;
    return;
  }
  // "Falta o seu vídeo" saiu daqui (Fatia 5): é alerta do topo do painel,
  // publicado por Meus criativos — dito uma vez só.
  if (!((dados.criativosAprovados || 0) > 0)) {
    el.hidden = true;
    return;
  }
  el.innerHTML =
    '<b>Seu anúncio já está aprovado e entra no rodízio das telas.</b> A primeira contagem aparece aqui na próxima hora cheia. Cada exibição é confirmada pela própria tela, e é isso que você vê neste painel.';
  el.hidden = false;
}

// Quantos pontos entram com cor própria na barra empilhada — o resto vira
// "Outros pontos" (--serie-outros, cinza). 5 é o tanto de slot categórico
// que a paleta da skill dataviz valida pro par ADJACENTE (o que importa numa
// barra empilhada, onde um segmento só encosta no de cima e no de baixo).
const TOP_SERIES_DIA_PONTO = 5;

// Barras verticais dos últimos 14 dias, empilhadas por ponto (19/09/2026,
// pedido do dono: "no card exibições por dia, coloque também um exibições
// por ponto"). O endpoint devolve DESC (mais novo primeiro) e só os dias com
// registro — inverte e mostra como vem, sem preencher buraco de dia sem
// exibição. `porPonto` já chega ORDER BY confirmadas DESC (mesma rota) —
// reaproveita esse ranking pra decidir quem ganha cor própria, em vez de
// recalcular: os 5 primeiros pontos do período inteiro têm sempre a mesma
// cor em toda barra; o resto soma em "Outros pontos".
function desenharPorDia(porDia, porDiaPonto, porPonto) {
  document.getElementById('painelDia').hidden = false;
  if (!porDia.length) {
    document.getElementById('graficoDia').innerHTML =
      '<div class="empty-state dashboard-empty">As exibições confirmadas aparecerão aqui assim que a campanha começar a rodar.</div>';
    document.getElementById('legendaDia').textContent = 'Sem exibições confirmadas no período';
    return;
  }
  const dias = porDia.slice(0, 14).reverse();
  const max = Math.max(...dias.map((d) => Number(d.confirmadas))) || 1;

  const principais = (porPonto || []).slice(0, TOP_SERIES_DIA_PONTO);
  const serieDoPonto = new Map(principais.map((p, i) => [p.id, `serie-${i + 1}`]));

  const porDiaChave = new Map();
  for (const linha of porDiaPonto || []) {
    const chave = String(linha.dia).slice(0, 10);
    if (!porDiaChave.has(chave)) porDiaChave.set(chave, []);
    porDiaChave.get(chave).push(linha);
  }

  document.getElementById('graficoDia').innerHTML = dias
    .map((d) => {
      const v = Number(d.confirmadas);
      // `dia` vem do servidor como dia de calendário puro ('2026-09-16'), sem
      // hora e sem fuso. `new Date('2026-09-16')` lê isso como meia-noite UTC
      // e `getDate()` devolve 15 pra quem está no Brasil — a barra ficava com
      // o rótulo do dia anterior. Fatiar a string não passa por fuso nenhum,
      // que é o certo pra uma data que não tem fuso.
      const [ano, mes, diaDoMes] = String(d.dia).slice(0, 10).split('-');
      const segmentos = segmentosDoDia(porDiaChave.get(String(d.dia).slice(0, 10)) || [], serieDoPonto);
      const pilha = segmentos.length
        ? segmentos
            .map(
              (s) =>
                `<div class="bar-seg ${s.classe}" data-pct="${v ? (s.valor / v) * 100 : 0}" title="${esc(s.nome)}: ${s.valor} exibições"></div>`,
            )
            .join('')
        : `<div class="bar-seg serie-1" data-pct="100" title="${v} exibições"></div>`;
      return `<div class="bar-col" title="${diaDoMes}/${mes}/${ano}: ${v} exibições">
      <div class="bar-pilha" data-pct="${Math.max(2, (v / max) * 100)}">${pilha}</div>
      <span class="bar-label">${diaDoMes}/${mes}</span>
    </div>`;
    })
    .join('');

  desenharLegendaPontosDia(principais, serieDoPonto, (porPonto || []).length > TOP_SERIES_DIA_PONTO);

  // Total de exibições e delta 7 dias x 7 anteriores — antes eram um card
  // próprio no kpi-grid ("Exibições confirmadas"); saíram de lá (19/09/2026,
  // pedido do dono) porque a conta vende por HORAS, não por vez rodada, e um
  // plano pequeno (peça curta, poucas inserções por hora) sempre ia mostrar
  // um número baixo ali, sem culpa nenhuma da entrega. A contagem continua
  // visível, só que como legenda do próprio gráfico que ela descreve.
  const soma = (arr) => arr.reduce((t, d) => t + Number(d.confirmadas), 0);
  const atual = soma(porDia.slice(0, 7));
  const anterior = soma(porDia.slice(7, 14));
  const delta = anterior
    ? `, ${atual >= anterior ? '▲' : '▼'} ${Math.abs(Math.round(((atual - anterior) / anterior) * 100))}% vs. 7 dias antes`
    : '';
  document.getElementById('legendaDia').textContent =
    `últimos ${dias.length} dias com exibição · ${atual} confirmadas nos últimos 7 dias${delta}`;
}

// Agrupa as linhas de um dia (já filtradas por dia em desenharPorDia) na
// mesma ordem/cor fixa dos 5 principais + "Outros pontos" — um ponto fora do
// top 5 do período inteiro sempre cai em "Outros", mesmo que tenha sido o
// que mais exibiu NESSE dia específico, porque a cor tem que significar o
// mesmo ponto em toda barra do gráfico, não só naquele dia.
function segmentosDoDia(linhasDoDia, serieDoPonto) {
  const porSerie = new Map();
  let outros = 0;
  for (const linha of linhasDoDia) {
    const classe = serieDoPonto.get(linha.ponto_id);
    const valor = Number(linha.confirmadas);
    if (!classe) {
      outros += valor;
      continue;
    }
    const atual = porSerie.get(classe) || { nome: linha.ponto_nome, valor: 0 };
    atual.valor += valor;
    porSerie.set(classe, atual);
  }
  const segmentos = [...serieDoPonto.values()]
    .map((classe) => (porSerie.has(classe) ? { classe, ...porSerie.get(classe) } : null))
    .filter(Boolean);
  if (outros > 0) segmentos.push({ classe: 'serie-outros', nome: 'Outros pontos', valor: outros });
  return segmentos;
}

// Legenda de cores do gráfico empilhado — cor sozinha não é canal acessível
// (skill dataviz), por isso a identidade de cada ponto também vem por nome
// aqui, não só pela cor do segmento. Um ponto só (sem "Outros") não precisa
// de legenda: só existe uma cor, e o título do card já diz o que é.
function desenharLegendaPontosDia(principais, serieDoPonto, temOutros) {
  const el = document.getElementById('legendaPontosDia');
  if (!el) return;
  const chips = principais.map((p) => ({ classe: serieDoPonto.get(p.id), nome: p.nome }));
  if (temOutros) chips.push({ classe: 'serie-outros', nome: 'Outros pontos' });
  el.hidden = chips.length < 2;
  el.innerHTML = chips
    .map((c) => `<span class="chip"><span class="swatch ${c.classe}"></span>${esc(c.nome)}</span>`)
    .join('');
}

// Top 8: já vem ORDER BY confirmadas DESC do servidor — uma rede com muitos
// pontos virava uma lista de barra alta e ilegível. O resto continua na
// tabela detalhada logo abaixo, completa, sem corte nenhum.
const TOP_PONTOS_GRAFICO = 8;
function desenharPorPonto(porPonto) {
  document.getElementById('painelDetalhe').hidden = false;
  if (!porPonto.length) {
    document.getElementById('graficoPonto').innerHTML =
      '<div class="empty-state dashboard-empty">Nenhum ponto com exibições neste período.</div>';
    document.getElementById('exibicoesDetalhe').innerHTML = '';
    return;
  }
  // Com um ponto só, a distribuição é sempre 100% por definição — a barra
  // não informa nada além do que o título da seção já diz (21/09/2026,
  // revisão de design). A tabela abaixo, com entrega e status por ponto,
  // continua sempre visível: ela conta uma história diferente da barra.
  if (porPonto.length < 2) {
    document.getElementById('graficoPonto').innerHTML = '';
  } else {
    const max = Math.max(...porPonto.map((p) => Number(p.confirmadas))) || 1;
    const total = porPonto.reduce((soma, p) => soma + Number(p.confirmadas), 0) || 1;
    const principais = porPonto.slice(0, TOP_PONTOS_GRAFICO);
    const resto = porPonto.length - principais.length;
    document.getElementById('graficoPonto').innerHTML =
      principais
        .map((p) => {
          const v = Number(p.confirmadas);
          const pct = Math.round((v / total) * 100);
          return `
    <div class="row">
      <span class="nome" title="${esc(p.nome)}">${esc(p.nome)}</span>
      <span class="track"><span class="fill" data-pct="${(v / max) * 100}"></span></span>
      <span class="valor">${v} <span class="u-dim">(${pct}%)</span></span>
    </div>`;
        })
        .join('') +
      (resto > 0
        ? `<p class="form-hint u-m-0 u-mt-8">+${resto} outro${resto === 1 ? '' : 's'} ponto${resto === 1 ? '' : 's'} na tabela abaixo.</p>`
        : '');
  }
  document.getElementById('exibicoesDetalhe').innerHTML =
    `<div class="u-ox-auto"><table class="mini-table"><thead><tr><th>Ponto</th><th>Cidade</th><th>Programadas</th><th>Confirmadas</th><th>Entrega</th><th>Status</th></tr></thead><tbody>
    ${porPonto
      .map((p) => {
        const prog = Number(p.programadas) || 0;
        const conf = Number(p.confirmadas) || 0;
        return `<tr><td>${esc(p.nome)}</td><td>${esc(p.cidade)}</td><td>${prog}</td><td>${conf}</td><td>${prog ? Math.round((conf / prog) * 100) + '%' : '-'}</td><td>${statusOnline(p.situacao)}</td></tr>`;
      })
      .join('')}
  </tbody></table></div>`;
}

// "A propaganda tá passando mesmo, ou a TV tá desligada?" (19/09/2026,
// pedido do dono) — `situacao` vem do servidor, pela régua única de saúde da
// tela (Player V2): no ar, fora do horário do ponto, ou fora do ar.
function statusOnline(situacao) {
  if (situacao === 'no_ar') return '<span class="badge badge-ok">🟢 No ar</span>';
  if (situacao === 'fora_do_horario') return '<span class="badge badge-neutro">Fora do horário</span>';
  return '<span class="badge badge-err">🔴 Fora do ar</span>';
}

carregar().catch(() => {
  document.getElementById('statusBanner').textContent = 'Não foi possível carregar sua conta agora.';
});
// Uma vez só (fora de carregar(), que pode rodar de novo por SSE — Fase 5)
// — chamar de novo duplicaria os ouvintes de clique do sino.
if (window.montarCentralNotificacoes) window.montarCentralNotificacoes();
// Resgate muda o plano da conta: `carregar` refaz banner, bloqueio e KPIs.
if (window.montarCreditos) window.montarCreditos({ aoResgatar: carregar });
// Meus pontos: independente do modo anúncios e do plano (dono de ponto sem
// plano comercial também vê o próprio comércio).
if (window.montarMeusPontos) window.montarMeusPontos({ obterConta: () => ANUNCIANTE });
// Meus criativos: o comercial e o do comodato, fora do bloqueio de plano
// comercial (o módulo se esconde sozinho quando não há plano nenhum).
if (window.montarMeusCriativos) window.montarMeusCriativos({ obterConta: () => ANUNCIANTE });
// Financeiro: pagamentos do plano e recebimentos do comodato.
if (window.montarFinanceiro) window.montarFinanceiro();

// Promoção pra quem está logado (reconstrução de Ofertas/Promoções,
// 23/09/2026) — mesma fonte de sempre (GET /promocoes/vigentes), já
// filtrada no servidor por elegibilidade COMERCIAL (plano ativo agora, ou
// já assinou antes), não por ter sessão aberta. Sem checkbox próprio pra
// esta superfície: qualquer promoção vigente e elegível pra esta conta
// aparece aqui. Independente do resto do carregamento do painel: se essa
// chamada falhar, o painel inteiro continua funcionando igual, só sem o
// banner.
fetch(`${API_BASE_URL}/promocoes/vigentes`)
  .then((r) => r.json())
  .then((promocoes) => {
    const promo = (Array.isArray(promocoes) ? promocoes : [])[0];
    if (!promo) return;
    const el = document.getElementById('promocaoLogado');
    el.innerHTML = `
      <div class="promo-logado">
        <div>
          ${promo.selo ? `<span class="badge badge-pendente">${esc(promo.selo)}</span>` : ''}
          <b>${esc(promo.titulo_publico)}</b>
          ${promo.subtitulo ? `<p class="u-m-0 u-dim">${esc(promo.subtitulo)}</p>` : ''}
        </div>
        <a class="btn primary mini" href="/planos.html">Ver condição</a>
      </div>`;
    el.hidden = false;
  })
  .catch(() => {});
