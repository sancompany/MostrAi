const fmt = fmtBRL; // config.js

let ANUNCIANTE = null;
let ANUNCIANTE_ID = null;

// Cada chamada de carregar() ganha um número; só a mais recente pode
// desenhar ou decidir alguma coisa. O SSE, a volta pra aba e o resgate
// chamam carregar() sem coordenação — uma resposta velha que chegasse por
// último desfazia o estado bom da mais nova.
let geracaoConta = 0;

async function carregar() {
  const minha = ++geracaoConta;
  // Primeira carga: reaproveita o /anunciantes/me que o layout.js já pediu
  // (carregarConta) — eram duas chamadas iguais a cada abertura do painel.
  // As recargas (SSE, resgate) pedem de novo: o plano pode ter mudado.
  let conta;
  try {
    conta = await window.carregarConta({ recarregar: !!ANUNCIANTE });
  } catch (err) {
    if (minha !== geracaoConta) return;
    // Só o 401 é sessão acabada. 500, rede, prazo: a pessoa continua
    // logada — na abertura vira erro com [Tentar novamente] (quem chamou
    // mostra); numa recarga em segundo plano a tela fica como está e a
    // próxima recarga tenta de novo. Nunca "0 exibições" no lugar do erro.
    if (err.sessaoExpirada) return window.sessaoExpirada();
    if (ANUNCIANTE) return;
    throw err;
  }
  if (minha !== geracaoConta) return;
  ANUNCIANTE = conta;
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
  const estado = await montarModo('anunciante', document.getElementById('dashboardAnuncios'), async () => {
    // Sem plano ainda, a tela inteira (KPIs, gráficos e o upload de
    // criativo) fica bloqueada — pedido do dono, 19/09/2026. Antes dava
    // pra subir 1 criativo mesmo sem plano "pra não travar o meio do
    // cadastro"; a decisão virou o contrário: trava, com aviso pra
    // escolher plano (o back também passou a recusar isso, defesa em
    // profundidade — ver POST /anunciantes/:id/criativos).
    //
    // O Plano Básico do ponto (migration 103, ADR-025) também libera: quem
    // hospeda um ponto ativo anuncia no próprio estabelecimento sem plano
    // contratado. Sem nenhum dos dois, o painel pede o plano.
    if (!temDireitoDeAnunciar()) {
      montarBloqueioPlano();
      return;
    }
    removerBloqueioPlano();
    carregarPrimeirosPassos();
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
// Recarga em segundo plano: se falhar (500, rede), a tela fica como está e a
// próxima recarga tenta de novo — sem rejeição solta no console e sem login.
const recarregarConta = () => carregar().catch(() => {});
if (window.ligarEventosDaConta) {
  window.ligarEventosDaConta({
    'payment.updated': recarregarConta,
    'plan.updated': recarregarConta,
    'account.updated': recarregarConta,
    'application.updated': recarregarConta,
  });
}

// Mesmo padrão de public/modos.js (window.montarModo): esconde o container
// de verdade e insere um card no lugar dele, um nível abaixo do bloqueio de
// papel — aqui o papel "anunciante" já está liberado, só falta plano.
// Idempotente e reversível: carregar() roda de novo pelo SSE e depois de um
// resgate de créditos. Sem remover o anterior, cada rodada empilhava outro
// card de bloqueio; sem desfazer, a conta que ganhava plano continuava
// bloqueada até dar F5.
// Direito de veicular: plano comercial OU o Básico de um ponto ativo.
function temDireitoDeAnunciar() {
  return !!ANUNCIANTE.plano_id || !!ANUNCIANTE.beneficios_basico?.length;
}

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
  if (ANUNCIANTE.suspenso) {
    caixa.innerHTML = `<div class="card wide modo-card u-ta-c" id="bloqueioPlano">
        <p class="eyebrow">Seu painel</p>
        <h3>Conta suspensa</h3>
        <p class="form-hint u-m-0">Veja a explicação ali em cima. Seus números voltam a aparecer aqui assim que a conta for reativada.</p>
      </div>`;
  } else {
    // Conta sem plano (estação da conta, 26/09/2026): UM bloco com a ação
    // principal — nada de "Sem plano" repetido no card de plano, no bloco e
    // no CTA. O motivo pra contratar é começar a anunciar, não desbloquear
    // números. Desenha já com o padrão de conta nova e se refaz quando os
    // primeiros passos chegam do servidor (idempotente: mesmo lugar).
    caixa.innerHTML = htmlOnboardingSemPlano(null);
    carregarPrimeirosPassos();
  }
  container.parentNode.insertBefore(caixa, container);
}

// ---------------------------------------------------------------------------
// Primeiros passos (estação da conta, 26/09/2026)
// ---------------------------------------------------------------------------
// As quatro etapas vêm do servidor (GET /anunciantes/me/primeiros-passos),
// lidas do estado real da conta — nunca marcadas aqui. Sem plano, viram o
// bloco principal do painel; com plano e etapas faltando, uma faixa compacta
// no topo da campanha; tudo feito, somem e o painel fica só com os dados.
const ETAPAS_PADRAO = [
  { id: 'plano', titulo: 'Escolha seu plano', feito: false, disponivel: true },
  { id: 'criativo', titulo: 'Envie seu criativo', feito: false, disponivel: false },
  { id: 'pontos', titulo: 'Escolha os pontos', feito: false, disponivel: false, opcional: true },
  { id: 'exibicoes', titulo: 'Acompanhe suas exibições', feito: false, disponivel: false },
];

function htmlEtapas(etapas, proxima) {
  return `<ol class="onboarding-etapas">${etapas
    .map((e, i) => {
      const estado = e.feito ? 'feito' : e.id === proxima ? 'proximo' : e.opcional ? 'opcional' : 'pendente';
      // O estado vai por escrito, não só pela cor (acessibilidade).
      const rotulo = { feito: 'Concluído', proximo: 'Próximo passo', opcional: 'Opcional', pendente: 'Depois' }[estado];
      // A etapa opcional nunca vira "Próximo passo" (não segura o fluxo), e
      // por isso o atalho de `ACAO_DA_ETAPA.pontos` nunca aparecia: o link
      // mora na própria etapa, enquanto ela estiver disponível.
      const atalho = estado === 'opcional' && e.disponivel && e.id === 'pontos' ? ACAO_DA_ETAPA.pontos : '';
      return `<li class="etapa-${estado}"${estado === 'proximo' ? ' aria-current="step"' : ''}>
        <span class="etapa-num" aria-hidden="true">${e.feito ? '✓' : i + 1}</span>
        <span class="etapa-texto"><b>${esc(e.titulo)}</b><span>${rotulo}${e.detalhe ? ` · ${esc(e.detalhe)}` : ''}</span>${atalho}</span>
      </li>`;
    })
    .join('')}</ol>`;
}

function htmlOnboardingSemPlano(passos) {
  const etapas = passos?.etapas || ETAPAS_PADRAO;
  const voltando = !!passos?.jaTevePlano;
  return `<section class="card wide onboarding" id="bloqueioPlano" aria-labelledby="tituloOnboarding">
      <p class="section-eyebrow">1 de ${etapas.length} — Escolha seu plano</p>
      <h2 id="tituloOnboarding">${voltando ? 'Volte a anunciar na rede' : 'Comece sua primeira campanha'}</h2>
      <p class="onboarding-texto">${
        voltando
          ? 'Escolha um plano para colocar sua marca de novo nas telas da rede.'
          : 'Escolha um plano para definir sua cobertura, duração do anúncio e colocar sua marca na rede.'
      }</p>
      <a class="btn primary onboarding-cta" href="/planos.html">Escolher meu plano</a>
      ${htmlEtapas(etapas, 'plano')}
    </section>`;
}

// Próximo passo com plano: onde clicar pra fazer.
const ACAO_DA_ETAPA = {
  criativo: '<a class="btn primary mini" href="#modCriativos">Enviar criativo</a>',
  pontos: '<a class="btn ghost mini" href="#painelPontos">Escolher pontos</a>',
  exibicoes: '<span class="form-hint u-m-0">Quando o criativo for aprovado, as exibições aparecem aqui.</span>',
};

let carregandoPassos = null;
async function carregarPrimeirosPassos() {
  if (carregandoPassos) return carregandoPassos;
  carregandoPassos = (async () => {
    let passos;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/primeiros-passos`, { credentials: 'include' });
      if (!r.ok) return;
      passos = await r.json();
    } catch {
      return;
    }
    const caixa = document.getElementById('bloqueioPlanoCaixa');
    if (caixa && !temDireitoDeAnunciar() && !ANUNCIANTE.suspenso) {
      caixa.innerHTML = htmlOnboardingSemPlano(passos);
      return;
    }
    const faixa = document.getElementById('primeirosPassos');
    if (!faixa) return;
    if (!temDireitoDeAnunciar() || passos.concluido) {
      faixa.hidden = true;
      faixa.innerHTML = '';
      return;
    }
    const proxima = passos.etapas.find((e) => e.id === passos.proxima);
    faixa.innerHTML = `
      <div class="onboarding-faixa-topo">
        <div>
          <p class="section-eyebrow">Primeiros passos · ${passos.numeroDaProxima} de ${passos.total}</p>
          <h2>${esc(proxima.titulo)}</h2>
        </div>
        <div class="onboarding-acao">${ACAO_DA_ETAPA[proxima.id] || ''}</div>
      </div>
      ${htmlEtapas(passos.etapas, passos.proxima)}`;
    faixa.hidden = false;
  })().finally(() => {
    carregandoPassos = null;
  });
  return carregandoPassos;
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
        <p>Anúncios, pontos, criativos e benefícios da sua conta, num só lugar.</p>
        ${explicacao ? `<span class="dash-explica">${explicacao}</span>` : ''}
      </div>
    </div>
    <div class="hero-status" id="heroStatus" hidden></div>
  `;
  desenharBasico();
  desenharPlano();
  carregarPontos();
}

// "Benefício de ponto · Plano Básico" (migration 103): um card por conta,
// uma linha por ponto que dá o benefício. Nunca junta com o plano
// contratado — "Básico + Pro" não é um plano, são duas origens.
function desenharBasico() {
  const secao = document.getElementById('modBasico');
  if (!secao || !ANUNCIANTE) return;
  const basicos = ANUNCIANTE.beneficios_basico || [];
  if (!basicos.length) {
    secao.hidden = true;
    return;
  }
  const d = ANUNCIANTE.direitos || {};
  const soma =
    ANUNCIANTE.plano_id && d.pontosPlano
      ? `<p class="plano-nota">Somado ao plano contratado: <b>${d.pontos} pontos</b> e <b>${d.horasPorMes} h/mês</b> no total (${d.horasBasico} h do Básico + ${d.horasPlano} h do plano).</p>`
      : '';
  document.getElementById('basicoResumo').innerHTML = `
    ${basicos
      .map(
        (b) => `<div class="basico-item" data-basico-ponto="${b.pontoId}">
        <p class="plano-nome"><b>${b.horasPorMes} h/mês</b> <span class="badge badge-ok">Ativo</span></p>
        <ul class="basico-direitos">
          <li>1 ponto — ${esc(b.pontoNome || 'seu estabelecimento')}</li>
          <li>Anúncio de até ${b.duracaoMaximaSegundos} s</li>
        </ul>
      </div>`,
      )
      .join('')}
    <p class="plano-nota">Incluído sem custo enquanto seu ponto estiver ativo. Além dele, cada ponto ativo gera +1 crédito por mês.</p>
    ${soma}`;
  secao.hidden = false;
}

// "Plano comercial" (Fatia 5): o que a conta tem pra anunciar na rede —
// situação, validade e as ações (escolher, trocar, gerenciar).
function situacaoDoPlano() {
  if (!ANUNCIANTE.plano_id) return ['sem_plano', 'badge-neutro', 'Sem plano'];
  if (ANUNCIANTE.suspenso) return ['suspensa', 'badge-err', 'Suspensa'];
  // Vigência decidida pelo servidor (`plano_vigente`, RN-32-B: último dia
  // inclusivo em Matão) — o relógio do navegador vencia o plano na véspera.
  if (ANUNCIANTE.plano_vigente === false) return ['vencida', 'badge-pendente', 'Vencida'];
  // A origem do direito é o rótulo (ADR-018): Assinatura paga, Benefício
  // por créditos ou Cortesia administrativa legada — a mesma régua da ficha
  // do admin (plano-administrativo.js#origemDoDireito).
  if (ANUNCIANTE.plano_cortesia)
    return ['cortesia', 'badge-neutro', ANUNCIANTE.plano_origem_texto || 'Cortesia administrativa legada'];
  return ['ativa', 'badge-ok', 'Assinatura paga'];
}

function desenharPlano() {
  const secao = document.getElementById('modPlano');
  if (!secao || !ANUNCIANTE) return;
  const [situacao, classe, rotulo] = situacaoDoPlano();
  // Sem plano, o card some: a ação principal ("Escolher meu plano") mora no
  // bloco de primeiros passos, uma vez só — e o chip do topo diz "Sem plano"
  // em tamanho pequeno (estação da conta, 26/09/2026).
  if (situacao === 'sem_plano') {
    secao.hidden = true;
    // Só o Básico do ponto: o chip diz a origem (benefício), não "Sem plano".
    const soBasico = ANUNCIANTE.beneficios_basico?.length;
    window.publicarResumo?.('plano', {
      chips: [
        soBasico
          ? { rotulo: 'Plano', valor: 'Básico · benefício de ponto', alvo: 'modBasico' }
          : { rotulo: 'Plano', valor: 'Sem plano', alvo: 'bloqueioPlano' },
      ],
      alertas: [],
    });
    return;
  }
  // Benefício por créditos é temporário, nunca assinatura: diz até quando
  // vale e que nada é cobrado no fim (RN-58).
  const porCreditos = ANUNCIANTE.plano_origem === 'beneficio_creditos';
  // Plano · Ciclo — "Prime · Semestral", a mesma linguagem do plano pago e
  // do benefício por créditos (ADR-018).
  const ciclo = window.ROTULOS.ciclo[ANUNCIANTE.plano?.compromisso_meses];
  const nome = `${ANUNCIANTE.plano?.nome || 'Seu plano'}${ciclo ? ` · ${ciclo}` : ''}`;
  const validade =
    ANUNCIANTE.plano_id && ANUNCIANTE.data_expiracao
      ? situacao === 'vencida'
        ? `<p class="plano-validade">Venceu em ${window.dataBR(ANUNCIANTE.data_expiracao)}</p>`
        : ANUNCIANTE.plano_cortesia
          ? `<p class="plano-validade">Válido até ${window.dataBR(ANUNCIANTE.data_expiracao)}</p>
             <p class="plano-nota">${porCreditos ? 'Benefício temporário: termina nessa data e nada é cobrado automaticamente.' : 'Sem cobrança e não renova sozinho.'}</p>`
          : `<p class="plano-validade">Até ${window.dataBR(ANUNCIANTE.data_expiracao)}</p>`
      : '';
  const acoes = ['<button type="button" class="btn ghost mini" data-acao="gerenciar-plano">Gerenciar plano</button>'];
  document.getElementById('planoResumo').innerHTML = `
    <p class="plano-nome"><b>${esc(nome)}</b> <span class="badge ${classe}">${rotulo}</span></p>
    ${validade}
    ${acoes.length ? `<div class="plano-acoes">${acoes.join('')}</div>` : ''}`;
  secao.hidden = false;
  preencherAssinatura();

  const alertas = [];
  if (situacao === 'vencida')
    alertas.push({
      nivel: 'atencao',
      texto: 'Seu plano venceu — escolha um plano pra voltar ao ar.',
      alvo: 'modPlano',
    });
  if (situacao === 'suspensa')
    alertas.push({ nivel: 'atencao', texto: 'Sua conta está suspensa: o anúncio não está no ar.', alvo: 'modPlano' });
  const diasRestantes = ANUNCIANTE.dias_ate_vencer ?? null;
  if (situacao === 'cortesia' && diasRestantes !== null && diasRestantes <= 7) {
    const quando = diasRestantes === 0 ? 'hoje' : `em ${diasRestantes} ${diasRestantes === 1 ? 'dia' : 'dias'}`;
    alertas.push({
      nivel: 'info',
      texto: porCreditos
        ? `Seu benefício por créditos termina ${quando}. Nenhuma cobrança será feita.`
        : `Sua cortesia termina ${quando} e não renova sozinha.`,
      alvo: 'modPlano',
    });
  }
  window.publicarResumo?.('plano', {
    chips: [{ rotulo: 'Plano', valor: `${nome} · ${rotulo}`, alvo: 'modPlano' }],
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

// Texto da regra, uma vez só (é o que o dono pediu escrito na tela).
const TEXTO_MODO_AUTOMATICO =
  'Se você não escolher pontos, a Mostraí distribui sua campanha automaticamente entre os pontos disponíveis dentro da cobertura do seu plano.';
const TEXTO_SEU_PONTO =
  'Este estabelecimento pertence à sua conta. Você pode incluí-lo na cobertura da campanha ou anunciar somente em outros pontos da rede.';

// Ícones das linhas do card (traço herda a cor do texto — `.ponto-icone` no
// CSS). Decorativos: o texto ao lado diz a mesma coisa.
const ICONES_PONTO = {
  endereco:
    '<path d="M12 21.5s7.25-7.35 7.25-12.25a7.25 7.25 0 1 0-14.5 0c0 4.9 7.25 12.25 7.25 12.25Z"/><circle cx="12" cy="9.25" r="2.75"/>',
  segmento:
    '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.4"/>',
  horario: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  ocupacao: '<path d="M4 20h16M7 16v-4M12 16V7M17 16v-6"/>',
  casa: '<path d="M3.5 11 12 4l8.5 7M6 9.5V20h12V9.5"/>',
};
const iconePonto = (nome) =>
  `<svg class="ponto-icone" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICONES_PONTO[nome]}</svg>`;

// Foto da fachada, segmento e bairro de cada ponto: a vitrine pública de
// "Onde estamos" (GET /pontos — mesmos status que a lista da escolha,
// STATUS_NA_REDE; confirmar-plano já lê a mesma rota). É enfeite, não regra:
// se ela falhar — ou demorar mais que o prazo, que a lista espera por ela —,
// o card cai no placeholder oficial, sem segmento, e a escolha continua
// funcionando igual. Por isso nunca rejeita.
const PRAZO_VITRINE_MS = 3000;
async function buscarVitrineDosPontos() {
  const abortar = new AbortController();
  const prazo = setTimeout(() => abortar.abort(), PRAZO_VITRINE_MS);
  try {
    const r = await fetch(`${API_BASE_URL}/pontos`, { signal: abortar.signal });
    const lista = r.ok ? await r.json() : [];
    return new Map((Array.isArray(lista) ? lista : []).map((v) => [v.id, v]));
  } catch {
    return new Map();
  } finally {
    clearTimeout(prazo);
  }
}

// Um card por ponto (estação dos cards do cliente, 28/09/2026): o MESMO
// molde de Rede > Pontos do admin e da prévia da candidatura
// (`.ponto-card.com-corpo`, style.css) — foto da fachada ou o placeholder
// oficial, nome com o estado ao lado, endereço, segmento, horário e ocupação
// — e a seleção no pé do card, dita em texto e não só na cor. O próprio
// ponto (a conta é dona do comércio) vem na MESMA lista, com o selo "Seu
// ponto" na foto e o texto que explica a escolha — nunca marcado por isso:
// se marcado, conta no limite do plano como qualquer outro.
//
// Só a apresentação é deste card. O input, o `.cheio`, o `data-ponto-id` e o
// `data-busca` são os de antes: travar no limite, salvar e contar continuam
// em desenharPontos. As frases do pé ("Selecionado", "Limite do plano
// atingido") são escolhidas pelo CSS a partir do estado do input — nenhum
// caminho de código precisa lembrar de repintá-las.
function htmlPontoEscolha(p, vitrine = {}) {
  const instalando = p.status === 'a_instalar' || p.status === 'aguardando_primeiro_sinal';
  // Ponto em instalação nunca está "cheio": ele não vendeu hora nenhuma
  // ainda. Bloquear ele por ocupação seria bloquear por um zero que
  // significa "ainda não existe", não "tem espaço de sobra".
  const cheio = !instalando && p.ocupacao >= 100;
  // G.7: cruzou 80% e parou de aceitar escolha NOVA (quem já tinha fica).
  const fechado = !p.escolhido && (cheio || p.bloqueado);
  const enderecoCompleto = `${p.endereco ? `${p.endereco}, ` : ''}${p.cidade || ''}`;
  const mapaUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(enderecoCompleto)}`;
  const ocupacao = instalando
    ? 'Ainda sem hora vendida'
    : cheio
      ? 'Sem espaço agora'
      : p.bloqueado && !p.escolhido
        ? `${p.ocupacao}% vendido · não aceita novas escolhas`
        : `${p.ocupacao}% vendido`;
  const estado = window.ROTULOS.ponto[p.status] || p.status;
  const classeEstado = window.ROTULOS.pontoClasse[p.status] || 'badge-neutro';
  // Endereço com a regra do resto do sistema (window.linhaEndereco — D5):
  // "Rua, número - bairro, cidade". O bairro vem da vitrine, quando há.
  const local = window.linhaEndereco(
    { endereco: p.endereco, bairro: vitrine.bairro, cidade: p.cidade },
    { comCidade: true },
  );
  const foto = vitrine.foto_instalacao_url
    ? `<img src="${esc(vitrine.foto_instalacao_url)}" alt="" loading="lazy" data-foto>`
    : `<span class="ponto-foto-placeholder" aria-hidden="true">${CANDIDATURA_FOTO_PLACEHOLDER_SVG}</span>`;
  const linha = (classe, icone, texto, id = '') =>
    `<span class="ponto-linha ${classe}"${id ? ` id="${id}"` : ''}>${iconePonto(icone)}<span>${esc(texto)}</span></span>`;
  // O nome acessível do checkbox é o nome do ponto (e o selo), não o card
  // inteiro; estado, ocupação e a frase do pé entram como descrição.
  const id = `ponto-escolha-${p.id}`;
  // <a> fica FORA do <label> de propósito: um link dentro de um label ainda
  // ativa o checkbox quando o clique borbulha até ele. O <label> é
  // `display:contents` no CSS — os filhos viram itens da grade do card, e o
  // link do mapa fica por cima da foto, no canto.
  return `<div class="ponto-card com-corpo ponto-escolha${fechado ? ' cheio' : ''}${p.seuPonto ? ' seu-ponto' : ''}" data-ponto-id="${p.id}" data-busca="${esc(`${p.nome} ${p.cidade || ''}`.toLowerCase())}">
      <label class="ponto-marcar">
        <span class="ponto-card-media">${foto}${p.seuPonto ? `<span class="selo-seu-ponto" id="${id}-selo">${iconePonto('casa')}Seu ponto</span>` : ''}</span>
        <span class="ponto-card-corpo">
          <span class="ponto-card-topo">
            <span class="ponto-nome" id="${id}-nome" title="${esc(p.nome)}">${esc(p.nome)}</span>
            <span class="ponto-estado badge ${classeEstado}" id="${id}-estado">${esc(estado)}</span>
          </span>
          ${local ? linha('ponto-end', 'endereco', local) : ''}
          ${vitrine.categoria_nome ? linha('ponto-segmento', 'segmento', vitrine.categoria_nome) : ''}
          ${linha('ponto-horario', 'horario', p.horario || 'Horário não informado')}
          ${linha('ponto-ocupacao', 'ocupacao', ocupacao, `${id}-ocupacao`)}
          ${
            p.seuPonto
              ? `<span class="ponto-proprio"><span class="ponto-proprio-rotulo">Veicular no próprio ponto</span><span class="ponto-proprio-texto">${TEXTO_SEU_PONTO}</span></span>`
              : ''
          }
        </span>
        <span class="ponto-escolha-acao">
          <input type="checkbox" value="${p.id}" ${p.escolhido ? 'checked' : ''} ${fechado ? 'disabled' : ''} aria-labelledby="${id}-nome${p.seuPonto ? ` ${id}-selo` : ''}" aria-describedby="${id}-estado ${id}-ocupacao ${id}-acao">
          <span class="ponto-acao-texto" id="${id}-acao"><span class="acao-livre">Selecionar ponto</span><span class="acao-marcado">Selecionado</span><span class="acao-limite">Limite do plano atingido</span><span class="acao-fechado">Indisponível para escolha</span></span>
        </span>
      </label>
      <a class="ponto-mapa" href="${mapaUrl}" target="_blank" rel="noopener" title="Ver no mapa" aria-label="Ver ${esc(p.nome)} no mapa">${iconePonto('endereco')}Ver no mapa</a>
    </div>`;
}

// Estado da seleção (contador e modo), repintado depois de cada salvamento
// com a resposta NOVA do servidor — "quantos pontos veiculam hoje" muda com a
// escolha, e o número velho na tela seria mentira.
function pintarResumoPontos(dados, marcados) {
  const n = marcados.length;
  const limite = dados.limite;
  const contador = document.getElementById('contadorPontos');
  contador.textContent = limite
    ? `${n} de ${limite} ${limite === 1 ? 'ponto selecionado' : 'pontos selecionados'}`
    : `${n} ${n === 1 ? 'ponto selecionado' : 'pontos selecionados'}`;
  contador.className = n > 0 ? 'badge badge-ok' : 'badge badge-neutro';
  const modo = document.getElementById('modoPontos');
  const veiculando = dados.cobertura?.veiculando;
  const hoje =
    veiculando != null
      ? ` Hoje sua campanha ${veiculando === 1 ? 'roda em 1 ponto no ar' : `roda em ${veiculando} pontos no ar`}.`
      : '';
  modo.textContent = n === 0 ? `Distribuição automática ativa.${hoje}` : `Você escolheu os pontos da campanha.${hoje}`;
}

let carregandoPontos = null;
async function carregarPontos() {
  if (!ANUNCIANTE.plano_id) {
    document.getElementById('painelPontos').hidden = true;
    return;
  }
  if (carregandoPontos) return carregandoPontos;
  carregandoPontos = desenharPontos().finally(() => {
    carregandoPontos = null;
  });
  return carregandoPontos;
}

async function buscarPontosDisponiveis() {
  const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos-disponiveis`, { credentials: 'include' });
  const corpo = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(corpo.erro || 'não deu pra carregar os pontos');
  return corpo;
}

async function desenharPontos() {
  const painel = document.getElementById('painelPontos');
  const lista = document.getElementById('listaPontos');
  const msg = document.getElementById('msgPontos');
  painel.hidden = false;
  document.getElementById('explicaAutomatico').textContent = TEXTO_MODO_AUTOMATICO;
  // Em paralelo com a lista; nunca rejeita (ver buscarVitrineDosPontos).
  const vitrine = buscarVitrineDosPontos();
  let dados;
  try {
    dados = await buscarPontosDisponiveis();
  } catch (erro) {
    // Falha nunca some em silêncio (antes o painel inteiro ficava escondido
    // e a pessoa não sabia que a escolha existia): diz o que houve e oferece
    // tentar de novo, sem recarregar a página.
    lista.innerHTML = `<div class="empty-state dashboard-empty" role="alert">
        Não deu pra carregar os pontos agora (${esc(window.frase(erro.message))}).
        <button type="button" class="btn ghost mini" id="btnTentarPontos">Tentar de novo</button>
      </div>`;
    document.getElementById('contadorPontos').textContent = '';
    document.getElementById('modoPontos').textContent = '';
    document.getElementById('btnTentarPontos').onclick = () => carregarPontos();
    return;
  }
  pintarCompensacao(dados.cobertura);

  if (!dados.pontos.length) {
    lista.innerHTML =
      '<div class="empty-state dashboard-empty">A rede ainda não tem pontos disponíveis para seleção. Sua cobertura aparecerá aqui conforme eles entrarem no ar.</div>';
    pintarResumoPontos(dados, []);
    return;
  }
  const fotos = await vitrine;
  lista.innerHTML = dados.pontos.map((p) => htmlPontoEscolha(p, fotos.get(p.id))).join('');
  // Logo quadrado ou foto em pé entra inteira, como no admin e em Meus pontos.
  lista.querySelectorAll('img[data-foto]').forEach(candidaturaAjustarFoto);

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

  const marcados = () => [...lista.querySelectorAll('input:checked')].map((i) => Number(i.value));
  // Passar do limite não é erro de servidor: é uma caixa que não devia ter
  // deixado marcar. Desligar as outras é mais honesto que aceitar e recusar
  // depois do clique em salvar. O próprio ponto conta igual.
  function travarNoLimite() {
    const n = marcados().length;
    if (!dados.limite) return;
    lista.querySelectorAll('input:not(:checked)').forEach((i) => {
      if (!i.closest('.ponto-escolha').classList.contains('cheio')) i.disabled = n >= dados.limite;
    });
  }
  pintarResumoPontos(dados, marcados());
  travarNoLimite();

  lista.onchange = async (e) => {
    if (e.target.tagName !== 'INPUT') return;
    const escolha = marcados();
    pintarResumoPontos(dados, escolha);
    travarNoLimite();
    msg.textContent = 'Salvando...';
    msg.className = 'form-msg';
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pontos: escolha }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) {
        msg.textContent = window.frase(corpo.erro || 'não deu pra salvar');
        msg.className = 'form-msg err';
        return;
      }
      msg.textContent = escolha.length ? 'Pronto. Salvo.' : 'Pronto. Sem escolha, a Mostraí distribui sua campanha.';
      msg.className = 'form-msg ok';
      // Cobertura e compensação dependem da escolha: relê do servidor (só o
      // resumo — a lista fica, pra não roubar o foco de quem está marcando).
      try {
        dados = { ...dados, ...(await buscarPontosDisponiveis()) };
        pintarCompensacao(dados.cobertura);
        pintarResumoPontos(dados, marcados());
      } catch {
        // O salvamento já deu certo; o resumo fica com o número da tela.
      }
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
  // `plano_vigente` vem decidido do servidor (RN-32-B) — sem relógio local.
  const ativo = !ANUNCIANTE.plano_cortesia && !ANUNCIANTE.suspenso && ANUNCIANTE.plano_vigente === true;
  const cicloPlano = window.ROTULOS.ciclo[ANUNCIANTE.plano?.compromisso_meses];
  const nomePlano = ANUNCIANTE.plano?.nome
    ? `${ANUNCIANTE.plano.nome}${cicloPlano ? ` · ${cicloPlano}` : ''}`
    : 'seu plano';
  const ate = ANUNCIANTE.data_expiracao
    ? `${ativo ? 'Ativa' : ANUNCIANTE.plano_cortesia ? esc(ANUNCIANTE.plano_origem_texto || 'Cortesia') : 'Vencida'} até <b>${window.dataBR(ANUNCIANTE.data_expiracao)}</b>`
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
        : ANUNCIANTE.plano_origem === 'beneficio_creditos'
          ? `<p class="form-hint u-m-0 u-mb-8">Benefício por créditos: temporário, sem cobrança automática. Quando terminar, nada é cobrado.</p>
             <p class="form-hint u-m-0">Pode trocar quando quiser — antes de confirmar você vê o que acontece com o benefício atual (os créditos usados não voltam): <a href="/planos.html">por um plano pago</a> ou <a href="#modCreditos" data-fechar-plano>por outro benefício</a>.</p>`
          : ANUNCIANTE.plano_cortesia
            ? '<p class="form-hint u-m-0">Benefício sem cobrança. Quer assinar um plano pago? <a href="/planos.html">Ver planos</a> — antes de pagar você vê como ele fica junto com o benefício.</p>'
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
    if (e.target === dlg || e.target.closest('[data-fechar-plano]')) dlg.close();
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
// Saldo de Veiculação (27/09/2026): o TEMPO (`dados.segundos`) é a conta de
// verdade — o que se vende é tempo de tela, e cada hora apurada guarda a
// duração que usou. As exibições são o equivalente com a peça de hoje
// (`exibicoesEquivalentes`, `duracaoReferencia`): mudam se a peça mudar, o
// tempo não.
async function carregarBancoHoras() {
  const card = document.querySelector('#kpiGrid [data-kpi="banco"]');
  if (!card) return;
  try {
    const dados = await (await fetch(`${API_BASE_URL}/anunciantes/me/banco-horas`, { credentials: 'include' })).json();
    // Só aparece quando tem significado (23/09/2026, pedido do dono, revendo
    // o "card sempre visível" de 19/09): sem déficit, um card dizendo "0s ·
    // sem déficit acumulado" ocupa espaço do resumo sem informar nada. Com
    // déficit, é a informação de que a entrega atrasada será compensada.
    if (!dados.segundos) {
      card.hidden = true;
      return;
    }
    card.querySelector('b').textContent = `${duracaoLegivel(dados.segundos)} pendentes`;
    card.querySelector('[data-kpi-banco-legenda]').textContent =
      `${numeroBR(dados.exibicoesEquivalentes)} exibições equivalentes (peça de ${dados.duracaoReferencia}s) · entram no tempo livre das telas`;
    card.hidden = false;
    encaixarNumero(card.querySelector('b'));
  } catch {
    /* aviso extra — sem ele, o painel continua completo */
    card.hidden = true;
  }
}

// Números dos cards do resumo (24/09/2026, bug reportado pelo dono: "11 /
// 32.400" cortado no card Exibições). Causa, medida: com o painel em duas
// colunas (≥1100px) cada card tem 177px, o número tinha 32px, não podia
// quebrar (`white-space: nowrap`) e o card cortava o excesso (`overflow:
// hidden` — que ainda deixava a coluna do grid encolher abaixo do número).
// Agora nada é cortado nem escondido: o número encolhe no máximo 15% pra
// caber numa linha; a fração que ainda não cabe vira "11" em cima e "de
// 32.400" embaixo; valor longo encolhe até 60%; e só um valor absurdo quebra
// no meio (último recurso, visível). Mede de novo quando a largura muda.
const numeroBR = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

function montarFracao(el, feitas, total) {
  el.classList.add('kpi-fracao');
  el.innerHTML =
    `<span class="kpi-fracao-feitas">${esc(feitas)}</span>` +
    `<span class="kpi-fracao-total"><span class="kpi-fracao-sep">/ </span><span class="kpi-fracao-de">de </span>${esc(total)}</span>`;
}

function encaixarNumero(el) {
  // Texto no lugar do número (custo sem dinheiro envolvido) quebra linha
  // normalmente — encolher fonte é só pra número.
  if (el.classList.contains('kpi-texto')) {
    el.style.fontSize = '';
    el.classList.remove('kpi-quebrado', 'kpi-extremo');
    return;
  }
  const cabe = () => el.scrollWidth <= el.clientWidth + 0.5;
  el.classList.remove('kpi-quebrado', 'kpi-extremo');
  el.style.fontSize = '';
  const base = parseFloat(getComputedStyle(el).fontSize);
  const reduzir = (piso) => {
    for (let tamanho = base; !cabe() && tamanho - 1 >= piso; tamanho -= 1) el.style.fontSize = `${tamanho - 1}px`;
  };
  reduzir(base * 0.85);
  if (cabe()) return;
  if (el.classList.contains('kpi-fracao')) {
    el.style.fontSize = '';
    el.classList.add('kpi-quebrado');
    if (cabe()) return;
  }
  reduzir(base * 0.6);
  if (!cabe()) el.classList.add('kpi-extremo');
}

function encaixarKpis() {
  document.querySelectorAll('#kpiGrid .kpi-card:not([hidden]) > b').forEach(encaixarNumero);
}

// Cada card é observado, não a grade: a largura de um card muda sem a grade
// mudar (o card de Horas nasce escondido e, quando aparece, empurra os outros
// pra colunas mais estreitas). Só largura: a altura muda quando o número
// desce de linha, e reagir a ela faria o observador chamar a si mesmo.
if (window.ResizeObserver) {
  const larguraAnterior = new WeakMap();
  const observador = new ResizeObserver((entradas) => {
    for (const { target, contentRect } of entradas) {
      const largura = Math.round(contentRect.width);
      if (largura === larguraAnterior.get(target)) continue;
      larguraAnterior.set(target, largura);
      const numero = target.querySelector(':scope > b');
      if (numero && largura > 0) encaixarNumero(numero);
    }
  });
  document.querySelectorAll('#kpiGrid .kpi-card').forEach((card) => observador.observe(card));
}
if (document.fonts?.ready) document.fonts.ready.then(encaixarKpis);

// Horas contratadas x entregues no mês corrente (19/09/2026, pedido do
// dono) — é a métrica que a conta realmente vende, então é o PRIMEIRO
// card do grid, não mais um card solto anexado no fim (HTML já reserva o
// lugar em painel.html, com data-kpi="horas"). Mesma barrinha de progresso
// do gráfico por ponto (.track/.fill), sem componente novo. Só aparece com
// plano (os dois vêm null sem plano, e nem deveria chegar até aqui: o
// bloqueio de plano já barra essa chamada).
// `origens` (migration 103): { plano, basico } — as horas de cada origem,
// ditas separadas na legenda quando a conta tem as duas.
function desenharHorasMes(contratadas, entregues, origens = {}) {
  const card = document.querySelector('#kpiGrid [data-kpi="horas"]');
  if (contratadas == null || !card) return;
  const restantes = Math.max(0, contratadas - entregues);
  const pct = contratadas > 0 ? Math.min(100, (entregues / contratadas) * 100) : 0;
  // Formato brasileiro e sem resto de ponto flutuante: 180 − 178,9 saía
  // "1.0999999999999943h ainda por rodar".
  card.querySelector('b').textContent = `${numeroBR(entregues)}h`;
  card.querySelector('[data-kpi-horas-legenda]').textContent = `de ${numeroBR(contratadas)}h ${
    origens.plano && origens.basico
      ? `no mês (${numeroBR(origens.plano)}h do plano + ${numeroBR(origens.basico)}h do Básico)`
      : origens.basico
        ? 'do Plano Básico'
        : 'contratadas'
  } · ${numeroBR(restantes)}h ainda por rodar`;
  const fill = card.querySelector('.fill');
  fill.dataset.pct = pct;
  // A barra já existe no HTML (data-pct="0") desde o carregamento — o
  // observador de config.js só aplica uma vez por elemento
  // (:not([data-pct-ok])), então mudar o número aqui não bastaria sozinho.
  fill.removeAttribute('data-pct-ok');
  window.aplicarBarras(card);
  card.hidden = false;
  encaixarNumero(card.querySelector('b'));
}

// "Custo por exibição prevista" (24/09/2026, ADR-018): valor contratado no
// ciclo ÷ exibições previstas no ciclo, do snapshot da contratação — não
// muda conforme o anúncio roda. Microvalor com 4 casas (fmtMicroBRL), nunca
// "R$ 0,00". Benefício por créditos e cortesia legada não têm dinheiro
// envolvido: o card diz isso em vez de inventar um custo. Não é CPM (custo
// por mil pessoas impactadas) — o Mostraí não mede audiência.
const LEGENDA_CUSTO = 'Valor contratado ÷ exibições previstas no ciclo';
function desenharCustoPrevisto(c) {
  const card = document.querySelector('#kpiGrid [data-kpi="custo"]');
  if (!card) return;
  const valor = card.querySelector('b');
  const legenda = card.querySelector('[data-kpi-custo-legenda]');
  valor.classList.remove('kpi-texto');
  card.removeAttribute('title');
  if (c?.tipo === 'pago' && c.custoPorExibicaoPrevista) {
    valor.textContent = window.fmtMicroBRL(c.custoPorExibicaoPrevista);
    legenda.textContent = LEGENDA_CUSTO;
    card.title = `${c.plano}: ${fmt(c.valorCiclo)} ÷ ${Number(c.exibicoesPrevistasCiclo).toLocaleString('pt-BR')} exibições previstas no ciclo`;
  } else if (c?.tipo === 'beneficio') {
    valor.textContent = 'Benefício por créditos';
    valor.classList.add('kpi-texto');
    legenda.textContent = 'Sem valor monetário neste ciclo.';
  } else if (c?.tipo === 'cortesia') {
    valor.textContent = 'Cortesia';
    valor.classList.add('kpi-texto');
    legenda.textContent = 'Sem cobrança neste ciclo.';
  } else {
    valor.textContent = '-';
    legenda.textContent = LEGENDA_CUSTO;
  }
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
    if (dados.exibicoesContratadasMes != null) {
      montarFracao(kpi('exibicoes'), concluidas, dados.exibicoesContratadasMes.toLocaleString('pt-BR'));
    } else {
      kpi('exibicoes').classList.remove('kpi-fracao');
      kpi('exibicoes').textContent = concluidas;
    }
    desenharCustoPrevisto(dados.custoPrevisto);
    kpi('media').textContent = dados.mediaDiariaMes != null ? numeroBR(dados.mediaDiariaMes) : '-';
    encaixarKpis();

    desenharPorDia(dados.porDia || [], dados.porDiaPonto || [], dados.porPonto || []);
    desenharPorPonto(dados.porPonto || []);
    desenharHorasMes(dados.horasContratadasMes, dados.horasEntreguesMes, {
      plano: dados.horasPlanoMes,
      basico: dados.horasBasicoMes,
    });
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

// Abertura que falhou (500, rede, prazo): erro recuperável no lugar do hero,
// com [Tentar novamente] que refaz só a leitura da conta — sem F5 e sem
// login (a sessão continua; quem decide "sessão acabou" é só o 401).
function abrirPainel() {
  carregar().catch(() => {
    const el = document.getElementById('statusBanner');
    el.innerHTML = `<p class="form-msg err u-m-0" id="erroConta">Não foi possível carregar sua conta agora.</p>
      <button type="button" class="btn ghost mini" id="btnTentarConta">Tentar novamente</button>`;
    document.getElementById('btnTentarConta').addEventListener('click', () => {
      el.textContent = 'Carregando...';
      abrirPainel();
    });
  });
}
abrirPainel();
// Uma vez só (fora de carregar(), que pode rodar de novo por SSE — Fase 5)
// — chamar de novo duplicaria os ouvintes de clique do sino.
if (window.montarCentralNotificacoes) window.montarCentralNotificacoes();
// Resgate muda o plano da conta: `carregar` refaz banner, bloqueio e KPIs.
if (window.montarCreditos) window.montarCreditos({ aoResgatar: carregar });
// Meus pontos: independente do modo anúncios e do plano (dono de ponto sem
// plano comercial também vê o próprio comércio).
if (window.montarMeusPontos) window.montarMeusPontos({ obterConta: () => ANUNCIANTE });
// Meus criativos: fora do bloqueio de plano comercial (o módulo se esconde
// sozinho quando não há plano nenhum).
if (window.montarMeusCriativos) window.montarMeusCriativos({ obterConta: () => ANUNCIANTE });
// Financeiro: pagamentos do plano.
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
    // Mesma linha de condição da Home e de Planos: em que ciclos a promoção
    // baixa o preço de verdade (D1, 24/09/2026 — config.js).
    const condicao = window.condicaoDaPromocao(promo);
    if (condicao === null) return;
    const el = document.getElementById('promocaoLogado');
    el.innerHTML = `
      <div class="promo-logado">
        <div>
          ${promo.selo ? `<span class="badge badge-pendente">${esc(promo.selo)}</span>` : ''}
          <b>${esc(promo.titulo_publico)}</b>
          ${promo.subtitulo ? `<p class="u-m-0 u-dim">${esc(promo.subtitulo)}</p>` : ''}
          ${condicao ? `<p class="u-m-0 u-dim">${esc(condicao)}</p>` : ''}
        </div>
        <a class="btn primary mini" href="/planos.html">Ver condição</a>
      </div>`;
    el.hidden = false;
  })
  .catch(() => {});
