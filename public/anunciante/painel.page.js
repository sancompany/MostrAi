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
    // O Plano Básico do ponto (migration 103, ADR-025) também libera — e,
    // desde 01/10/2026, ser dono de um ponto já aprovado na rede também: o
    // ACESSO ao painel é decidido no servidor (`acesso_painel`,
    // src/anunciantes/acesso-painel.js), separado do direito de veicular.
    // Sem nenhum dos três, o painel pede o plano.
    if (!temAcessoCompleto()) {
      montarBloqueioPlano();
      return;
    }
    removerBloqueioPlano();
    // Hospedagem de Ponto Móvel e saldo de hospedagem (public/hospedagem-conta.js).
    window.montarHospedagem?.();
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
    // Ponto aprovado, tela instalada, Básico ativado: muda o acesso e o
    // estado do Básico (ADR-034).
    'point.updated': recarregarConta,
  });
}

// Mesmo padrão de public/modos.js (window.montarModo): esconde o container
// de verdade e insere um card no lugar dele, um nível abaixo do bloqueio de
// papel — aqui o papel "anunciante" já está liberado, só falta plano.
// Idempotente e reversível: carregar() roda de novo pelo SSE e depois de um
// resgate de créditos. Sem remover o anterior, cada rodada empilhava outro
// card de bloqueio; sem desfazer, a conta que ganhava plano continuava
// bloqueada até dar F5.
// Acesso ao painel completo — decidido no servidor: plano, Básico ativo ou
// dono de ponto da rede. NÃO é direito de veicular (criativo e escolha de
// pontos continuam pedindo plano ou Básico, no servidor). Resposta antiga
// sem o campo (aba aberta durante o deploy): a régua de antes.
function temAcessoCompleto() {
  if (ANUNCIANTE.acesso_painel) return !!ANUNCIANTE.acesso_painel.completo;
  return !!ANUNCIANTE.plano_id || !!ANUNCIANTE.beneficios_basico?.length;
}
// Dono de ponto da rede que ainda não tem plano nem Básico ativo.
const donoAguardandoBasico = () =>
  !ANUNCIANTE.plano_id && !ANUNCIANTE.beneficios_basico?.length && !!ANUNCIANTE.acesso_painel?.basico?.aguardando;

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

// Etapas do dono de ponto que não dependem dele: o que acontece e quando.
const AVISO_DA_ETAPA = {
  instalacao: 'A equipe Mostraí combina a instalação da tela com você.',
  sinal: 'Assim que a tela se conectar, o ponto fica ativo.',
  basico: 'Ativa sozinho quando a tela estiver instalada.',
};
function acaoDaEtapa(etapa) {
  if (AVISO_DA_ETAPA[etapa.id]) return `<span class="form-hint u-m-0">${AVISO_DA_ETAPA[etapa.id]}</span>`;
  // Criativo antes do Básico ativo: o servidor ainda não aceita — não
  // oferece o botão.
  if (etapa.id === 'criativo' && etapa.disponivel === false) {
    return '<span class="form-hint u-m-0">Disponível quando o Plano Básico do seu ponto ativar.</span>';
  }
  return ACAO_DA_ETAPA[etapa.id] || '';
}

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
    if (caixa && !temAcessoCompleto() && !ANUNCIANTE.suspenso) {
      caixa.innerHTML = htmlOnboardingSemPlano(passos);
      return;
    }
    const faixa = document.getElementById('primeirosPassos');
    if (!faixa) return;
    if (!temAcessoCompleto() || passos.concluido) {
      faixa.hidden = true;
      faixa.innerHTML = '';
      return;
    }
    const proxima = passos.etapas.find((e) => e.id === passos.proxima);
    // Dono de ponto (fluxo `ponto`, 01/10/2026): o caminho é o do ponto
    // entrando na rede, não o da compra de plano.
    const titulo = passos.fluxo === 'ponto' ? 'Seu ponto está entrando na rede' : 'Primeiros passos';
    faixa.innerHTML = `
      <div class="onboarding-faixa-topo">
        <div>
          <p class="section-eyebrow">${titulo} · ${passos.numeroDaProxima} de ${passos.total}</p>
          <h2>${esc(proxima.titulo)}</h2>
        </div>
        <div class="onboarding-acao">${acaoDaEtapa(proxima)}</div>
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
  // Dono de ponto da rede (01/10/2026): cada ponto ainda sem o Básico
  // aparece com o próprio estado — "aguardando", nunca "Ativo" antes da hora.
  // Só onde o card já aparece (Básico ativo, ou dono sem plano nenhum): com
  // plano comercial e nenhum Básico ativo, o card segue escondido.
  const pendentes = basicos.length || donoAguardandoBasico() ? ANUNCIANTE.acesso_painel?.basico?.pendentes || [] : [];
  if (!basicos.length && !pendentes.length) {
    secao.hidden = true;
    return;
  }
  const regra = ANUNCIANTE.acesso_painel?.basico || {};
  const itemPendente = (b) => `<div class="basico-item" data-basico-aguardando="${b.pontoId}">
        <p class="plano-nome"><b>${regra.horasPorMes} h/mês</b> <span class="badge badge-pendente">${
          b.aguardando === 'instalacao' ? 'Aguardando instalação da tela' : 'Aguardando ativação'
        }</span></p>
        <ul class="basico-direitos">
          <li>1 ponto — ${esc(b.pontoNome || 'seu estabelecimento')}</li>
          <li>Anúncio de até ${regra.duracaoMaximaSegundos} s</li>
        </ul>
      </div>`;
  if (!basicos.length) {
    document.getElementById('basicoResumo').innerHTML = `
      ${pendentes.map(itemPendente).join('')}
      <p class="plano-nota">Benefício de quem é ponto, sem custo: começa quando a tela do seu ponto estiver instalada. Plano comercial é opcional, pra anunciar em mais pontos da rede.</p>`;
    secao.hidden = false;
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
    ${pendentes.map(itemPendente).join('')}
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
    const aguardando = donoAguardandoBasico() && ANUNCIANTE.acesso_painel.basico.aguardando;
    window.publicarResumo?.('plano', {
      chips: [
        soBasico
          ? { rotulo: 'Plano', valor: 'Básico · benefício de ponto', alvo: 'modBasico' }
          : aguardando
            ? {
                rotulo: 'Plano',
                valor: aguardando === 'instalacao' ? 'Básico aguardando instalação' : 'Básico aguardando ativação',
                alvo: 'modBasico',
              }
            : ANUNCIANTE.acesso_painel?.hospedagem?.saldoSegundos > 0
              ? { rotulo: 'Plano', valor: 'Horas de hospedagem', alvo: 'modHospedagem' }
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
  evento: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  movel: '<rect x="7" y="5" width="14" height="10" rx="1.5"/><path d="M10 19h8M14 15v4M2 8h3M2 12h3"/>',
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

// MOSTRAÍ MÓVEL (migration 115): a opção virtual — UMA posição do plano que
// acompanha as telas móveis ativas da rede. Sempre aparece, mesmo com 0
// unidades em operação, e nunca é desabilitada por isso: a escolha é
// preferência, o "em operação" é a realidade da hora (e com 0 a campanha
// segue pela rede, sem segurar horas). O mesmo molde e a mesma seleção no pé
// do card de ponto (input, `.cheio`, `data-busca`) — conta no limite como
// qualquer escolha. Sem endereço, sem equipamento, sem agenda.
function htmlMostraiMovel(m) {
  const M = window.MOSTRAI_MOVEL;
  const id = 'ponto-escolha-mostrai-movel';
  const n = Number(m?.unidadesEmOperacao) || 0;
  const status =
    n === 0
      ? `<span class="ponto-movel-evento ponto-movel-sem-evento" id="${id}-status">${esc(M.emOperacao(0))} ${esc(M.semOperacao)}</span>`
      : `<span class="ponto-movel-evento" id="${id}-status"><span class="ponto-movel-evento-nome">${esc(M.emOperacao(n))}</span></span>`;
  return `<div class="ponto-card com-corpo ponto-escolha ponto-movel mostrai-movel" data-mostrai-movel data-busca="${esc(`${M.nome} ${M.subtitulo} movel evento`.toLowerCase())}">
      <label class="ponto-marcar">
        <span class="ponto-card-media ponto-movel-media"><span class="selo-movel" id="${id}-selo">${iconePonto('movel')}${esc(M.selo)}</span></span>
        <span class="ponto-card-corpo">
          <span class="ponto-card-topo">
            <span class="ponto-nome" id="${id}-nome">${esc(M.nome)}</span>
          </span>
          <span class="ponto-linha ponto-movel-tipo">${iconePonto('evento')}<span>${esc(M.subtitulo)}</span></span>
          <span class="ponto-movel-explica">${esc(M.texto)}</span>
          ${status}
        </span>
        <span class="ponto-escolha-acao">
          <input type="checkbox" value="${M.valor}" ${m?.escolhido ? 'checked' : ''} aria-labelledby="${id}-nome ${id}-selo" aria-describedby="${id}-status ${id}-acao">
          <span class="ponto-acao-texto" id="${id}-acao"><span class="acao-livre">Selecionar</span><span class="acao-marcado">Selecionado</span><span class="acao-limite">Limite do plano atingido</span><span class="acao-fechado">Indisponível para escolha</span></span>
        </span>
      </label>
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
  // Locais físicos no ar agora (as unidades móveis contam uma a uma); a
  // escolha da Mostraí Móvel com 0 unidades ativas não entra aqui, e isso
  // não é inconsistência: o contador mede ESCOLHAS, isto mede a realidade.
  const veiculando = dados.cobertura?.pontosNoAr ?? dados.cobertura?.veiculando;
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

  // A Mostraí Móvel vem SEMPRE — logo depois do próprio ponto (que continua
  // primeiro), antes dos demais. Com a rede sem nenhum ponto fixo ainda, ela
  // é a escolha que existe (e a frase abaixo diz o resto).
  const fotos = await vitrine;
  const card = (p) => htmlPontoEscolha(p, fotos.get(p.id));
  lista.innerHTML =
    dados.pontos
      .filter((p) => p.seuPonto)
      .map(card)
      .join('') +
    htmlMostraiMovel(dados.mostraiMovel) +
    (dados.pontos.length
      ? dados.pontos
          .filter((p) => !p.seuPonto)
          .map(card)
          .join('')
      : '<div class="empty-state dashboard-empty">Ainda não há outros pontos disponíveis para seleção. Eles aparecerão aqui conforme entrarem no ar.</div>');
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

  // Ids de ponto e a opção Mostraí Móvel (`window.MOSTRAI_MOVEL.valor`) — as
  // duas contam no limite do plano, uma posição cada.
  const valorDe = (i) => (i.value === window.MOSTRAI_MOVEL.valor ? i.value : Number(i.value));
  const marcados = () => [...lista.querySelectorAll('input:checked')].map(valorDe);
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

  // Um salvamento por vez (PR #90, finalização 28/09/2026): dois cliques
  // seguidos disparavam dois PUTs em paralelo, e a ordem em que o servidor os
  // aplicava decidia o resultado — o clique mais antigo podia vencer. Agora a
  // escolha mais recente espera a anterior terminar, e só ela vai (as do meio
  // são descartadas: o PUT manda a lista inteira). Se o servidor recusar, as
  // caixas voltam ao último estado que ele confirmou — a tela nunca fica
  // dizendo "marcado" pra uma escolha que não foi salva.
  let salvo = marcados();
  let salvando = null;
  let pendente = null;
  const voltarAoSalvo = () => {
    for (const i of lista.querySelectorAll('input')) i.checked = salvo.includes(valorDe(i));
    pintarResumoPontos(dados, marcados());
    travarNoLimite();
  };
  async function salvar(escolha) {
    msg.textContent = 'Salvando...';
    msg.className = 'form-msg';
    let erro;
    try {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/pontos`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ pontos: escolha }),
      });
      const corpo = await r.json().catch(() => ({}));
      if (!r.ok) erro = window.frase(corpo.erro || 'não deu pra salvar');
    } catch {
      erro = 'Sem conexão.';
    }
    if (erro) {
      pendente = null;
      voltarAoSalvo();
      msg.textContent = `${erro} Sua escolha voltou ao que estava salvo.`;
      msg.className = 'form-msg err';
      return;
    }
    salvo = escolha;
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
  }
  function agendarSalvar(escolha) {
    pendente = escolha;
    if (salvando) return;
    salvando = (async () => {
      while (pendente) {
        const alvo = pendente;
        pendente = null;
        await salvar(alvo);
      }
      salvando = null;
    })();
  }

  lista.onchange = (e) => {
    if (e.target.tagName !== 'INPUT') return;
    const escolha = marcados();
    pintarResumoPontos(dados, escolha);
    travarNoLimite();
    agendarSalvar(escolha);
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

// Confirmação em modal Mostraí (confirmar.js): o pedido roda dentro do
// modal, com loading, e o erro fica escrito ali; a página só muda depois
// que o servidor respondeu.
async function cancelarAssinatura() {
  const btn = document.getElementById('btnCancelarAssinatura');
  const msg = document.getElementById('msgCancelarAssinatura');
  const sim = await window.confirmarMostrai({
    titulo: 'Cancelar sua assinatura?',
    texto:
      'O período que você já pagou continua no ar até o fim. Depois disso não há nova cobrança nem anúncio no ar. Cancelar não devolve o que já foi pago.',
    botao: 'Cancelar assinatura',
    cancelar: 'Manter assinatura',
    perigo: true,
    aoConfirmar: async () => {
      const r = await fetch(`${API_BASE_URL}/anunciantes/me/cancelar-assinatura`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).erro || 'Não foi possível cancelar agora.');
    },
  });
  if (!sim) return;
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

// O link do comprovante carrega o período do gráfico (painel do usuário,
// 29/09/2026 — antes era um seletor à parte, 30/90/365 dias): `desde` é o
// primeiro dia que a tela está somando, e o CSV vai de 00:00 desse dia (em
// Matão) até agora — o mesmo recorte, o mesmo total. Antes do primeiro
// desenho (sem período ainda), os 30 dias de sempre.
//
// O href se monta no CLIQUE, nao no carregamento: este bloco roda antes de
// `carregarConta()` resolver, entao `ANUNCIANTE_ID` ainda e null e o link
// nascia apontando pra /anunciantes/null/exibicoes.csv.
function linkDoComprovante() {
  const recorte = inicioDoPeriodo ? `desde=${inicioDoPeriodo}` : 'dias=30';
  return `${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes.csv?${recorte}`;
}
(function comprovante() {
  const link = document.getElementById('btnComprovante');
  if (!link) return;
  link.addEventListener('click', (e) => {
    if (!ANUNCIANTE_ID) {
      e.preventDefault();
      return;
    }
    link.href = linkDoComprovante();
  });
})();

// Saldo de veiculação em horas e minutos ("4h 32min"), que é como o plano é
// vendido. Menos de um minuto vai em segundos, pra não virar "0min".
function tempoAEntregar(segundos) {
  const s = Math.max(0, Math.round(Number(segundos) || 0));
  if (s < 60) return `${s}s`;
  const minutos = Math.round(s / 60);
  const h = Math.floor(minutos / 60);
  const min = minutos % 60;
  if (!h) return `${min}min`;
  return min ? `${h}h ${min}min` : `${h}h`;
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
    `<span class="hero-status-item"><span class="dot" aria-hidden="true"></span>${noAr.length} de ${n} ${n === 1 ? 'ponto confirmado no ar' : 'pontos confirmados no ar'}</span>`,
  ];
  // Sem detalhe técnico para o anunciante: só quantos pontos estão fora do
  // ar (estado do cadastro ou erro do Player) e quantos estão sem
  // comunicação — que não é "desligado" (pode estar exibindo offline).
  const foraDoAr = porPonto.filter((p) => p.situacao === 'fora_do_ar').length;
  const semComunicacao = porPonto.filter((p) => p.situacao === 'sem_comunicacao').length;
  if (foraDoAr) {
    itens.push(
      `<span class="hero-status-item hero-status-alerta">⚠ ${foraDoAr} ${foraDoAr === 1 ? 'ponto fora do ar' : 'pontos fora do ar'}</span>`,
    );
  }
  if (semComunicacao) {
    itens.push(
      `<span class="hero-status-item">${semComunicacao} ${semComunicacao === 1 ? 'ponto sem comunicação com a Mostraí no momento' : 'pontos sem comunicação com a Mostraí no momento'}</span>`,
    );
  }
  el.innerHTML = itens.join('');
  el.hidden = false;
}

// Saldo de Veiculação (ADR-023) como o quarto indicador (painel do usuário,
// 29/09/2026, pedido do dono): sempre à vista. Desde 01/10/2026 (migration
// 111) o saldo nasce do CICLO CONTRATADO: comprou um Pro, são 84 h a entregar
// desde o primeiro minuto — com ou sem tela no ar —, e o número cai com cada
// exibição confirmada. "Em dia" só quando não falta nada do que foi
// contratado. O card mostra contratado, entregue e o que falta (com o que
// sobrou de ciclos anteriores), nunca o mecanismo. Falha de leitura nunca
// vira "Em dia": fica "-" com o motivo.
async function carregarBancoHoras() {
  const card = document.querySelector('#kpiGrid [data-kpi="banco"]');
  if (!card) return;
  const valor = card.querySelector('b');
  const legenda = card.querySelector('[data-kpi-banco-legenda]');
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/me/banco-horas`, { credentials: 'include' });
    if (!r.ok) throw new Error();
    const dados = await r.json();
    const segundos = Number(dados.segundos) || 0;
    const contratado = Number(dados.contratadoSegundos) || 0;
    const entregue = Number(dados.entregueSegundos) || 0;
    const anterior = Number(dados.saldoAnteriorSegundos) || 0;
    card.classList.toggle('kpi-a-entregar', segundos > 0);
    if (segundos > 0) {
      valor.textContent = tempoAEntregar(segundos);
      legenda.innerHTML =
        `<b>a entregar</b> · ${tempoAEntregar(contratado)} contratadas, ${tempoAEntregar(entregue)} entregues` +
        (anterior > 0 ? ` · inclui ${tempoAEntregar(anterior)} de ciclos anteriores` : '');
    } else {
      valor.textContent = 'Em dia';
      legenda.textContent = contratado > 0 ? 'Tudo o que foi contratado já foi entregue' : 'Nada pendente de entrega';
    }
  } catch {
    card.classList.remove('kpi-a-entregar');
    valor.textContent = '-';
    legenda.textContent = 'Não foi possível carregar o saldo agora.';
  }
  encaixarNumero(valor);
}

// Números dos cards do resumo (24/09/2026, bug reportado pelo dono: "11 /
// 32.400" cortado no card Exibições). Nada é cortado nem escondido: o número
// encolhe no máximo 15% pra caber numa linha; valor longo encolhe até 60%; e
// só um valor absurdo quebra no meio (último recurso, visível). A fração
// saiu (painel do usuário, 29/09/2026): as previstas descem pra legenda
// ("de 38.800 previstas no mês") e o número grande é só o das confirmadas.
//
// A fonte do número segue a largura do CARD, não a da janela (painel.css,
// `cqi`): com `vw`, alargar a janela com o painel já travado em 1280 px
// crescia a fonte sem o card mudar, e o observador abaixo — que só acorda
// quando o card muda de largura — deixava o número passar da borda até a
// próxima recarga (PENDENCIAS U2, reproduzido: "8 / 38.888" a 1280 px,
// 3 px pra fora a 1400 px). Card da mesma largura agora é fonte do mesmo
// tamanho, e o observador cobre todo o resto.
const numeroBR = (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

function encaixarNumero(el) {
  // Texto no lugar do número (cortesia) quebra linha normalmente — encolher
  // fonte é só pra número.
  if (el.classList.contains('kpi-texto')) {
    el.style.fontSize = '';
    el.classList.remove('kpi-extremo');
    return;
  }
  const cabe = () => el.scrollWidth <= el.clientWidth + 0.5;
  el.classList.remove('kpi-extremo');
  el.style.fontSize = '';
  const base = parseFloat(getComputedStyle(el).fontSize);
  const reduzir = (piso) => {
    for (let tamanho = base; !cabe() && tamanho - 1 >= piso; tamanho -= 1) el.style.fontSize = `${tamanho - 1}px`;
  };
  reduzir(base * 0.85);
  if (cabe()) return;
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

// "Custo por exibição" (24/09/2026, ADR-018): valor do plano no ciclo ÷
// exibições previstas no ciclo, do snapshot da contratação — não muda
// conforme o anúncio roda. Microvalor com 4 casas (fmtMicroBRL, "R$
// 0,0125"), nunca arredondado pra "R$ 0,01" nem "R$ 0,00". Não é CPM (custo
// por mil pessoas impactadas) — o Mostraí não mede audiência.
//
// Plano obtido por créditos (painel do usuário, 29/09/2026, pedido do dono):
// em vez de "Sem valor monetário", o custo de REFERÊNCIA — valor cheio de
// tabela do plano e ciclo equivalentes ÷ exibições previstas, a mesma divisão
// do plano pago (financeiro/ciclo-contratado.js#cicloDeReferencia). É só
// informação: nada é cobrado, lançado ou devido, e o card diz isso.
const LEGENDA_CUSTO = 'Valor do plano ÷ exibições previstas no ciclo';
function desenharCustoPrevisto(c) {
  const card = document.querySelector('#kpiGrid [data-kpi="custo"]');
  if (!card) return;
  const valor = card.querySelector('b');
  const legenda = card.querySelector('[data-kpi-custo-legenda]');
  valor.classList.remove('kpi-texto');
  card.removeAttribute('title');
  const conta = (x) =>
    `${fmt(x.valorCiclo)} ÷ ${Number(x.exibicoesPrevistasCiclo).toLocaleString('pt-BR')} exibições previstas no ciclo`;
  if (c?.tipo === 'pago' && c.custoPorExibicaoPrevista) {
    valor.textContent = window.fmtMicroBRL(c.custoPorExibicaoPrevista);
    // `aproximado`: plano pago sem snapshot do próprio ciclo (troca antiga,
    // versão nova do plano) — calculado pela mesma régua, dito como tal.
    legenda.textContent = c.aproximado ? `${LEGENDA_CUSTO} (estimado)` : LEGENDA_CUSTO;
    card.title = `${c.plano}: ${conta(c)}`;
  } else if (c?.tipo === 'beneficio' && c.custoPorExibicaoPrevista) {
    valor.textContent = window.fmtMicroBRL(c.custoPorExibicaoPrevista);
    legenda.textContent = `Referência do ${c.plano} · sem cobrança`;
    card.title = `${c.plano} (valor de referência, nada é cobrado): ${conta(c)}`;
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
    // Sem plano comercial em vigor (nunca teve, ou venceu — a régua é a do
    // servidor, `sem_plano`) e com o Básico do ponto: não há plano com preço
    // pra dividir — o card diz de onde vem a veiculação em vez de um "-" mudo.
    legenda.textContent =
      c?.tipo === 'sem_plano' && (ANUNCIANTE?.beneficios_basico?.length || donoAguardandoBasico())
        ? 'Plano Básico: incluído no benefício do ponto'
        : LEGENDA_CUSTO;
  }
}

async function carregarExibicoes() {
  try {
    const r = await fetch(`${API_BASE_URL}/anunciantes/${ANUNCIANTE_ID}/exibicoes`, { credentials: 'include' });
    // 500 não vira "0 exibições": cai no erro de baixo, que diz que não
    // carregou (antes o corpo de erro era lido como se fosse o painel).
    if (!r.ok) throw new Error();
    const dados = await r.json();
    desenharExibicoesMes(dados);
    desenharCustoPrevisto(dados.custoPrevisto);
    desenharHorasMes(dados.horasContratadasMes, dados.horasEntreguesMes, {
      plano: dados.horasPlanoMes,
      basico: dados.horasBasicoMes,
    });
    encaixarKpis();
    DADOS_PERFORMANCE = { porDiaPonto: dados.porDiaPonto || [], porPonto: dados.porPonto || [] };
    CORES_DOS_PONTOS = coresDosPontos(DADOS_PERFORMANCE.porDiaPonto);
    desenharPerformance();
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

// "Exibições" (painel do usuário, 29/09/2026, pedido do dono): o número
// grande é o das confirmadas no mês; as previstas descem pra legenda ("de
// 38.800 previstas no mês") e a média diária mora no mesmo card, pequena — o
// card "Média diária" saiu. Nunca NaN nem Infinity: o servidor divide por
// pelo menos 1 dia, e campo ausente aqui vira 0.
function desenharExibicoesMes(dados) {
  const card = document.querySelector('#kpiGrid [data-kpi="exibicoes"]');
  if (!card) return;
  const inteiro = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  card.querySelector('b').textContent = inteiro(dados.confirmadasMes).toLocaleString('pt-BR');
  card.querySelector('[data-kpi-exibicoes-legenda]').textContent =
    dados.exibicoesContratadasMes != null
      ? `de ${inteiro(dados.exibicoesContratadasMes).toLocaleString('pt-BR')} previstas no mês`
      : 'confirmadas no mês';
  card.querySelector('[data-kpi-media]').textContent = `Média diária: ${numeroBR(inteiro(dados.mediaDiariaMes))}`;
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

// ---------------------------------------------------------------------------
// Acompanhe sua veiculação (painel do usuário, 29/09/2026, pedido do dono)
// ---------------------------------------------------------------------------
// Um card só: barras empilhadas por ponto no período escolhido, a legenda, a
// tabela por ponto e o comprovante do mesmo recorte. Tudo sai de
// `porDiaPonto` (GET /anunciantes/:id/exibicoes: dia × ponto, exibições
// confirmadas, histórico inteiro): trocar o período reagrupa o que já chegou,
// sem outra requisição e sem recarregar a página. Dia é dia de calendário em
// Matão (o servidor já corta assim) e vira número de dias em UTC — nenhum
// fuso entra na conta.
const PERIODOS_GRAFICO = {
  '7d': { rotulo: 'últimos 7 dias', grao: 'dia', quantos: 7 },
  '30d': { rotulo: 'últimos 30 dias', grao: 'dia', quantos: 30 },
  '3m': { rotulo: 'últimos 3 meses', grao: 'semana', quantos: 13 },
  '1a': { rotulo: 'últimos 12 meses', grao: 'mes', quantos: 12 },
  max: { rotulo: 'desde o início da campanha', grao: 'mes', quantos: null },
};
let periodoGrafico = '30d';
let inicioDoPeriodo = null;
let DADOS_PERFORMANCE = null;
let CORES_DOS_PONTOS = new Map();
let GRAFICO_ATUAL = null;

const MS_DIA = 86_400_000;
const MESES_CURTOS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES_LONGOS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
function diaNumero(iso) {
  const [ano, mes, dia] = String(iso).slice(0, 10).split('-').map(Number);
  return Date.UTC(ano, mes - 1, dia) / MS_DIA;
}
const diaTexto = (n) => new Date(n * MS_DIA).toISOString().slice(0, 10);
const diaMes = (n) => `${diaTexto(n).slice(8, 10)}/${diaTexto(n).slice(5, 7)}`;
const diaMesAno = (n) => `${diaMes(n)}/${diaTexto(n).slice(0, 4)}`;
// Hoje em Matão, como dia de calendário — o mesmo corte do servidor.
function hojeEmMatao() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

// Os períodos do gráfico, do mais antigo ao de hoje: dia (7 e 30 dias),
// semana de segunda a domingo (3 meses) ou mês (1 ano e Máx.). Campanha que
// começou depois do início do período começa no primeiro dia com registro —
// três dias de campanha são três barras equilibradas, não 27 vazias e três
// espremidas no canto. Dia sem exibição DEPOIS disso continua no eixo (é
// informação: a tela ficou fora do ar).
function periodosDoGrafico(chave, hoje, primeiroDia) {
  const p = PERIODOS_GRAFICO[chave];
  const hojeN = diaNumero(hoje);
  const lista = [];
  if (p.grao === 'dia') {
    let inicio = hojeN - (p.quantos - 1);
    if (primeiroDia != null && primeiroDia > inicio) inicio = Math.min(primeiroDia, hojeN);
    for (let d = inicio; d <= hojeN; d += 1) lista.push({ de: d, ate: d });
    return lista;
  }
  if (p.grao === 'semana') {
    const segunda = (n) => n - ((new Date(n * MS_DIA).getUTCDay() + 6) % 7);
    let inicio = segunda(hojeN) - (p.quantos - 1) * 7;
    if (primeiroDia != null && segunda(primeiroDia) > inicio) inicio = Math.min(segunda(primeiroDia), segunda(hojeN));
    for (let s = inicio; s <= hojeN; s += 7) lista.push({ de: s, ate: Math.min(s + 6, hojeN) });
    return lista;
  }
  const [anoHoje, mesHoje] = hoje.split('-').map(Number);
  const agora = anoHoje * 12 + (mesHoje - 1);
  let inicio = p.quantos ? agora - (p.quantos - 1) : agora;
  if (primeiroDia != null) {
    const [ano, mes] = diaTexto(primeiroDia).split('-').map(Number);
    const primeiroMes = ano * 12 + (mes - 1);
    if (!p.quantos || primeiroMes > inicio) inicio = Math.min(primeiroMes, agora);
  }
  for (let m = inicio; m <= agora; m += 1) {
    const ano = Math.floor(m / 12);
    const de = Date.UTC(ano, m % 12, 1) / MS_DIA;
    const ate = Math.min(Date.UTC(ano, (m % 12) + 1, 1) / MS_DIA - 1, hojeN);
    lista.push({ de, ate, mes: m });
  }
  return lista;
}

function rotuloCurto(periodo, grao) {
  if (grao !== 'mes') return diaMes(periodo.de);
  return `${MESES_CURTOS[periodo.mes % 12]}/${String(Math.floor(periodo.mes / 12)).slice(2)}`;
}
function rotuloLongo(periodo, grao) {
  if (grao === 'dia') return diaMesAno(periodo.de);
  if (grao === 'semana')
    return periodo.de === periodo.ate
      ? `Semana de ${diaMesAno(periodo.de)}`
      : `Semana de ${diaMes(periodo.de)} a ${diaMesAno(periodo.ate)}`;
  const nome = MESES_LONGOS[periodo.mes % 12];
  return `${nome[0].toUpperCase()}${nome.slice(1)} de ${Math.floor(periodo.mes / 12)}`;
}

// Cor de cada ponto: a ordem em que ele entrou na campanha (o primeiro dia
// com registro, desempate pelo id) — o histórico inteiro, não o período.
// Trocar o filtro ou recarregar não muda a cor de ninguém, e ponto que entra
// depois pega a próxima cor sem empurrar as outras. Oito cores, e quem
// rodou no último ano escolhe primeiro: ponto que saiu da campanha há mais de
// um ano não segura uma cor que um ponto de agora precisa. Do nono em diante,
// "Outros pontos" (cinza).
const SERIES_COM_COR = 8;
function coresDosPontos(porDiaPonto) {
  const entrada = new Map();
  const saida = new Map();
  for (const linha of porDiaPonto) {
    const dia = diaNumero(linha.dia);
    const id = Number(linha.ponto_id);
    if (!entrada.has(id) || dia < entrada.get(id)) entrada.set(id, dia);
    if (!saida.has(id) || dia > saida.get(id)) saida.set(id, dia);
  }
  const umAnoAtras = diaNumero(hojeEmMatao()) - 364;
  const antigo = (id) => (saida.get(id) < umAnoAtras ? 1 : 0);
  const ordem = [...entrada.entries()].sort((a, b) => antigo(a[0]) - antigo(b[0]) || a[1] - b[1] || a[0] - b[0]);
  return new Map(ordem.map(([id], i) => [id, i < SERIES_COM_COR ? i + 1 : 0]));
}
const classeDaSerie = (n) => (n ? `serie-${n}` : 'serie-outros');

// Topo do eixo "bonito" (2, 4, 6, 8 ou 10 × potência de 10): a linha do
// meio cai sempre num número inteiro.
function topoDoEixo(maximo) {
  if (!(maximo > 0)) return 2;
  const potencia = 10 ** Math.floor(Math.log10(maximo));
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * potencia >= maximo && (m * potencia) % 2 === 0) return m * potencia;
  return 10 * potencia;
}

// Soma por período e por ponto. `noPeriodo`: todo ponto com registro no
// recorte — inclusive hora programada que não virou exibição (tela fora do
// ar): ele aparece na tabela com 0, que é exatamente o que o cliente precisa
// ver.
function agruparPorPeriodo(porDiaPonto, lista) {
  const indice = new Map();
  lista.forEach((p, i) => {
    for (let d = p.de; d <= p.ate; d += 1) indice.set(d, i);
  });
  const valores = lista.map(() => new Map());
  const noPeriodo = new Map();
  for (const linha of porDiaPonto) {
    const i = indice.get(diaNumero(linha.dia));
    if (i === undefined) continue;
    const id = Number(linha.ponto_id);
    const v = Number(linha.confirmadas) || 0;
    const ponto = noPeriodo.get(id) || { id, nome: linha.ponto_nome, total: 0 };
    ponto.total += v;
    noPeriodo.set(id, ponto);
    if (v > 0) valores[i].set(id, (valores[i].get(id) || 0) + v);
  }
  return { valores, noPeriodo };
}

function desenharPerformance() {
  const painel = document.getElementById('painelPerformance');
  if (!painel || !DADOS_PERFORMANCE) return;
  painel.hidden = false;
  const periodo = PERIODOS_GRAFICO[periodoGrafico];
  for (const botao of painel.querySelectorAll('[data-periodo]'))
    botao.setAttribute('aria-pressed', String(botao.dataset.periodo === periodoGrafico));
  const { porDiaPonto, porPonto } = DADOS_PERFORMANCE;
  const primeiroDia = porDiaPonto.reduce((min, l) => Math.min(min, diaNumero(l.dia)), Number.POSITIVE_INFINITY);
  const lista = periodosDoGrafico(periodoGrafico, hojeEmMatao(), Number.isFinite(primeiroDia) ? primeiroDia : null);
  inicioDoPeriodo = diaTexto(lista[0].de);
  const link = document.getElementById('btnComprovante');
  if (link) {
    if (ANUNCIANTE_ID) link.href = linkDoComprovante();
    link.title = `Comprovante de ${diaMesAno(lista[0].de)} até hoje — o mesmo período do gráfico`;
  }
  const { valores, noPeriodo } = agruparPorPeriodo(porDiaPonto, lista);
  const totais = valores.map((m) => [...m.values()].reduce((s, v) => s + v, 0));
  const total = totais.reduce((s, v) => s + v, 0);

  document.getElementById('performanceTotal').textContent = total
    ? `${total.toLocaleString('pt-BR')} ${total === 1 ? 'exibição confirmada' : 'exibições confirmadas'} · ${periodo.rotulo}`
    : `Nenhuma exibição confirmada · ${periodo.rotulo}`;

  const grafico = document.getElementById('graficoPerformance');
  const legenda = document.getElementById('legendaPerformance');
  esconderDica();
  if (!total) {
    GRAFICO_ATUAL = null;
    // Sem gráfico de mentira: sem exibição confirmada no período, a frase.
    grafico.innerHTML =
      '<p class="performance-vazio">Ainda não há exibições confirmadas neste período. Assim que sua campanha começar a rodar, os dados aparecerão aqui.</p>';
    legenda.hidden = true;
    legenda.innerHTML = '';
  } else {
    GRAFICO_ATUAL = { lista, valores, totais, noPeriodo, grao: periodo.grao };
    grafico.innerHTML = htmlGraficoPeriodo(GRAFICO_ATUAL, periodo);
    window.aplicarBarras(grafico);
    ajustarRotulos();
    const presentes = [...noPeriodo.values()]
      .filter((p) => p.total > 0)
      .sort((a, b) => (CORES_DOS_PONTOS.get(a.id) || 99) - (CORES_DOS_PONTOS.get(b.id) || 99));
    const comCor = presentes.filter((p) => CORES_DOS_PONTOS.get(p.id));
    const chips = comCor.map(
      (p) =>
        `<span class="chip"><span class="swatch ${classeDaSerie(CORES_DOS_PONTOS.get(p.id))}" aria-hidden="true"></span>${esc(p.nome)}</span>`,
    );
    if (comCor.length < presentes.length)
      chips.push('<span class="chip"><span class="swatch serie-outros" aria-hidden="true"></span>Outros pontos</span>');
    legenda.innerHTML = chips.join('');
    legenda.hidden = false;
  }
  desenharTabelaPontos(noPeriodo, porPonto);
}

// Pilha de baixo pra cima na ordem das cores (o mesmo ponto sempre no mesmo
// andar); "Outros pontos" num segmento só, no topo.
function segmentosDoPeriodo(valoresDoPeriodo) {
  const segmentos = [];
  let outros = 0;
  const ordenados = [...valoresDoPeriodo.entries()].sort(
    (a, b) => (CORES_DOS_PONTOS.get(a[0]) || 99) - (CORES_DOS_PONTOS.get(b[0]) || 99),
  );
  for (const [id, valor] of ordenados) {
    const serie = CORES_DOS_PONTOS.get(id);
    if (serie) segmentos.push({ classe: classeDaSerie(serie), valor });
    else outros += valor;
  }
  if (outros) segmentos.push({ classe: 'serie-outros', valor: outros });
  return segmentos;
}

function textoDoPeriodo(g, i) {
  const nomes = [...g.valores[i].entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, v]) => `${g.noPeriodo.get(id)?.nome || 'Ponto'}: ${v.toLocaleString('pt-BR')}`);
  const total = g.totais[i];
  return `${rotuloLongo(g.lista[i], g.grao)}: ${
    total
      ? `${total.toLocaleString('pt-BR')} ${total === 1 ? 'exibição' : 'exibições'}. ${nomes.join('; ')}.`
      : 'nenhuma exibição.'
  }`;
}

function htmlGraficoPeriodo(g, periodo) {
  const topo = topoDoEixo(Math.max(...g.totais));
  const colunas = g.lista.map((p, i) => {
    const total = g.totais[i];
    const pilha = segmentosDoPeriodo(g.valores[i])
      .map((s) => `<span class="barra-seg ${s.classe}" data-pct="${(s.valor / total) * 100}"></span>`)
      .join('');
    // Tabindex itinerante: um Tab entra no gráfico (no período mais recente)
    // e as setas andam entre os períodos.
    return `<button type="button" class="barra-col" data-i="${i}" tabindex="${i === g.lista.length - 1 ? 0 : -1}" aria-label="${esc(textoDoPeriodo(g, i))}">
      <span class="barra-trilho"><span class="barra-pilha${total ? '' : ' vazia'}" data-pct="${total ? Math.max(1.5, (total / topo) * 100) : 0}">${pilha}</span></span>
      <span class="barra-rotulo" aria-hidden="true">${rotuloCurto(p, g.grao)}</span>
    </button>`;
  });
  const grao = { dia: 'por dia', semana: 'por semana', mes: 'por mês' }[g.grao];
  return `<div class="grafico-area">
      <div class="grafico-grade" aria-hidden="true">
        <span data-valor="${topo.toLocaleString('pt-BR')}"></span>
        <span data-valor="${(topo / 2).toLocaleString('pt-BR')}"></span>
        <span data-valor="0"></span>
      </div>
      <div class="grafico-barras${g.lista.length <= 3 ? ' poucas' : ''}" role="group" aria-label="Exibições confirmadas ${grao}, ${esc(periodo.rotulo)}. Use as setas para navegar.">${colunas.join('')}</div>
      <div class="grafico-dica" id="dicaPerformance" aria-hidden="true" hidden></div>
    </div>`;
}

// Rótulo do eixo X só onde cabe (ancorado no período mais recente): 30
// dias numa tela de 360 px não viram 30 datas encavaladas.
function ajustarRotulos() {
  const barras = document.querySelector('#graficoPerformance .grafico-barras');
  if (!barras) return;
  const colunas = [...barras.children];
  const cabem = Math.max(1, Math.floor(barras.clientWidth / 46));
  const passo = Math.max(1, Math.ceil(colunas.length / cabem));
  colunas.forEach((c, i) => {
    c.classList.toggle('rotulo-oculto', (colunas.length - 1 - i) % passo !== 0);
  });
}

// Dica do período: data, exibições de cada ponto e o total. Abre no
// passar do mouse, no foco (teclado) e no toque — nunca só no hover — e fica
// sempre dentro do card (posição limitada às bordas da área do gráfico).
function mostrarDica(coluna) {
  const g = GRAFICO_ATUAL;
  const dica = document.getElementById('dicaPerformance');
  if (!g || !dica || !coluna) return;
  const i = Number(coluna.dataset.i);
  const linhas = [...g.valores[i].entries()]
    .sort((a, b) => (CORES_DOS_PONTOS.get(a[0]) || 99) - (CORES_DOS_PONTOS.get(b[0]) || 99))
    .map(
      ([id, v]) =>
        `<li><span class="swatch ${classeDaSerie(CORES_DOS_PONTOS.get(id))}"></span><span class="dica-nome">${esc(g.noPeriodo.get(id)?.nome || 'Ponto')}</span><b>${v.toLocaleString('pt-BR')}</b></li>`,
    )
    .join('');
  const total = g.totais[i];
  dica.innerHTML = `<p class="dica-titulo">${esc(rotuloLongo(g.lista[i], g.grao))}</p>${
    total
      ? `<ul>${linhas}</ul><p class="dica-total">Total <b>${total.toLocaleString('pt-BR')}</b></p>`
      : '<p class="dica-vazia">Nenhuma exibição confirmada</p>'
  }`;
  dica.hidden = false;
  const area = dica.parentElement.getBoundingClientRect();
  const col = coluna.getBoundingClientRect();
  const pilha = coluna.querySelector('.barra-pilha').getBoundingClientRect();
  const largura = dica.offsetWidth;
  const altura = dica.offsetHeight;
  const esquerda = Math.min(Math.max(0, col.left - area.left + col.width / 2 - largura / 2), area.width - largura);
  const topo = Math.max(0, pilha.top - area.top - altura - 8);
  dica.style.left = `${Math.max(0, esquerda)}px`;
  dica.style.top = `${topo}px`;
  for (const c of coluna.parentElement.children) c.classList.toggle('ativa', c === coluna);
}
function esconderDica() {
  const dica = document.getElementById('dicaPerformance');
  if (dica) dica.hidden = true;
  for (const c of document.querySelectorAll('#graficoPerformance .barra-col.ativa')) c.classList.remove('ativa');
}

// Filtros, dica e teclado: ouvintes registrados UMA vez, no card (delegação)
// — o gráfico é reescrito a cada período e a cada recarga, o card não.
(function performanceInterativa() {
  const painel = document.getElementById('painelPerformance');
  if (!painel) return;
  painel.addEventListener('click', (e) => {
    const filtro = e.target.closest('[data-periodo]');
    if (filtro) {
      if (filtro.dataset.periodo === periodoGrafico) return;
      periodoGrafico = filtro.dataset.periodo;
      desenharPerformance();
      return;
    }
    // Toque no celular: o Safari não dá foco a botão tocado — foca aqui, e
    // o foco abre a dica.
    const coluna = e.target.closest('.barra-col');
    if (coluna) {
      coluna.focus();
      mostrarDica(coluna);
    }
  });
  const barraEmFoco = () => document.activeElement?.classList?.contains('barra-col');
  painel.addEventListener('pointerover', (e) => {
    if (e.pointerType !== 'mouse') return;
    const coluna = e.target.closest('.barra-col');
    if (coluna) mostrarDica(coluna);
    else if (!e.target.closest('.grafico-dica') && !barraEmFoco()) esconderDica();
  });
  painel.addEventListener('pointerleave', () => {
    if (!barraEmFoco()) esconderDica();
  });
  painel.addEventListener('focusin', (e) => {
    if (e.target.classList.contains('barra-col')) mostrarDica(e.target);
  });
  painel.addEventListener('focusout', (e) => {
    if (!e.relatedTarget?.classList?.contains('barra-col')) esconderDica();
  });
  // Toque fora do gráfico fecha a dica: no Safari, tocar em algo que não
  // recebe foco não tira o foco do botão, e o `focusout` nunca vinha.
  document.addEventListener('pointerdown', (e) => {
    if (!e.target.closest?.('#graficoPerformance')) esconderDica();
  });
  painel.addEventListener('keydown', (e) => {
    const coluna = e.target.closest('.barra-col');
    if (!coluna) return;
    if (e.key === 'Escape') {
      esconderDica();
      return;
    }
    const colunas = [...coluna.parentElement.children];
    const atual = colunas.indexOf(coluna);
    const destino = { ArrowLeft: atual - 1, ArrowRight: atual + 1, Home: 0, End: colunas.length - 1 }[e.key];
    if (destino === undefined || !colunas[destino]) return;
    e.preventDefault();
    coluna.tabIndex = -1;
    colunas[destino].tabIndex = 0;
    colunas[destino].focus();
  });
  if (window.ResizeObserver) {
    let largura = 0;
    new ResizeObserver(([entrada]) => {
      const nova = Math.round(entrada.contentRect.width);
      if (nova === largura) return;
      largura = nova;
      esconderDica();
      ajustarRotulos();
    }).observe(document.getElementById('graficoPerformance'));
  }
})();

// Tabela por ponto do período (painel do usuário, 29/09/2026): PONTO,
// CIDADE, STATUS e EXIBIÇÕES — "Programadas" e "Entrega %" saíram da tela do
// cliente (o dado continua no servidor, no admin e no comprovante). No
// celular, cada linha vira um cartão compacto (painel.css).
function desenharTabelaPontos(noPeriodo, porPonto) {
  const el = document.getElementById('exibicoesDetalhe');
  const linhas = [...noPeriodo.values()].sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR'));
  if (!linhas.length) {
    el.innerHTML = '';
    return;
  }
  const doPonto = new Map((porPonto || []).map((p) => [Number(p.id), p]));
  // Papéis explícitos: no celular a tabela vira cartões (display trocado no
  // CSS), e sem eles o navegador deixa de anunciar linha e coluna.
  el.innerHTML = `<table class="mini-table tabela-periodo" role="table" aria-label="Exibições por ponto no período">
    <thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Ponto</th><th scope="col" role="columnheader">Cidade</th><th scope="col" role="columnheader">Status</th><th scope="col" role="columnheader" class="num">Exibições</th></tr></thead>
    <tbody role="rowgroup">${linhas
      .map((l) => {
        const p = doPonto.get(l.id) || {};
        return `<tr role="row">
          <th scope="row" role="rowheader" class="tabela-ponto"><span class="ponto-com-cor"><span class="swatch ${classeDaSerie(CORES_DOS_PONTOS.get(l.id))}" aria-hidden="true"></span><span>${esc(l.nome)}</span></span></th>
          <td role="cell" class="tabela-cidade">${esc(p.cidade || '-')}</td>
          <td role="cell" class="tabela-status">${statusOnline(p.situacao)}</td>
          <td role="cell" class="num tabela-exibicoes">${l.total.toLocaleString('pt-BR')}</td>
        </tr>`;
      })
      .join('')}</tbody>
  </table>`;
}

// "A propaganda tá passando mesmo, ou a TV tá desligada?" (19/09/2026,
// pedido do dono) — `situacao` vem do servidor, pela régua única de saúde da
// tela (Player V2): no ar, fora do horário do ponto, ou fora do ar.
function statusOnline(situacao) {
  if (situacao === 'no_ar') return '<span class="badge badge-ok status-ponto">No ar</span>';
  if (situacao === 'fora_do_horario') return '<span class="badge badge-neutro status-ponto">Fora do horário</span>';
  if (situacao === 'sem_comunicacao') {
    return '<span class="badge badge-neutro status-ponto" title="A tela pode estar exibindo normalmente sem internet; os números chegam quando ela se comunicar">Sem comunicação</span>';
  }
  // Ponto móvel entre uma alocação e outra (migration 114): não veicula.
  if (situacao === 'sem_alocacao') {
    return '<span class="badge badge-neutro status-ponto" title="O ponto móvel está entre uma alocação e outra e volta a veicular quando for alocado">Sem alocação</span>';
  }
  return '<span class="badge badge-err status-ponto">Fora do ar</span>';
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
// Pendências da conta no topo (endereço com Número suspeito etc.): depois de
// Meus pontos e do perfil, que são onde os botões "Corrigir" levam.
if (window.montarPendencias) window.montarPendencias();
// Meus criativos: fora do bloqueio de plano comercial (o módulo se esconde
// sozinho quando não há plano nenhum).
if (window.montarMeusCriativos) window.montarMeusCriativos({ obterConta: () => ANUNCIANTE });
// Financeiro: pagamentos do plano.
if (window.montarFinanceiro) window.montarFinanceiro();

// Promoção pra quem está logado: saiu daqui (reforço visual, 28/09/2026).
// Virou a faixa fina abaixo do cabeçalho, com X — public/barra-promocional.js.
